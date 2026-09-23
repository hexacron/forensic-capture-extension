/**
 * Threads (Meta) data parsing - pure functions, no browser APIs.
 *
 * Two independent sources describe a thread:
 * - API data: post objects from server-embedded Relay payloads
 *   (script[data-sjs]) and /api/graphql responses. Authoritative text,
 *   timestamps, counts, media URLs and reply linkage.
 * - DOM observations: what was actually rendered (text as displayed, visual
 *   order, per-post HTML), harvested while scrolling the virtualized list.
 *
 * buildThreadDataset() merges both by post shortcode.
 */

const THREADS_HOST_RE = /^(?:www\.)?threads\.(?:com|net)$/i;
const POST_PATH_RE = /^\/@([^/]+)\/post\/([A-Za-z0-9_-]+)\/?$/;
const RELATED_KEY_RE = /related/i;
const MEDIA_TYPES = { 1: 'image', 2: 'video', 8: 'carousel', 19: 'text' };

/**
 * @returns {{username: string, code: string, canonicalUrl: string} | null}
 */
export function parseThreadsPostUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!THREADS_HOST_RE.test(parsed.hostname)) return null;
  const match = POST_PATH_RE.exec(parsed.pathname);
  if (!match) return null;
  const username = decodeURIComponent(match[1]);
  return {
    username,
    code: match[2],
    canonicalUrl: `https://www.threads.com/@${username}/post/${match[2]}`
  };
}

export function isThreadsUrl(url) {
  try {
    return THREADS_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Parse a response body that may carry an anti-JSON-hijacking prefix and/or
 * multiple newline-delimited JSON documents (incremental GraphQL delivery).
 */
export function parseJsonDocuments(text) {
  if (typeof text !== 'string') return [];
  const body = text.replace(/^\s*for\s*\(\s*;\s*;\s*\)\s*;/, '').trim();
  if (!body) return [];
  try {
    return [JSON.parse(body)];
  } catch {
    const docs = [];
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        docs.push(JSON.parse(trimmed));
      } catch {
        // Non-JSON line; the raw body is preserved separately as evidence.
      }
    }
    return docs;
  }
}

/**
 * Keep only non-sensitive fields of a GraphQL request body (drops CSRF and
 * session tokens such as fb_dtsg, lsd, jazoest).
 */
export function summarizeGraphqlRequest(postData) {
  if (typeof postData !== 'string' || !postData) return null;
  const params = new URLSearchParams(postData);
  let variables = params.get('variables');
  if (variables) {
    try {
      variables = JSON.parse(variables);
    } catch {
      // keep raw string
    }
  }
  return {
    friendlyName: params.get('fb_api_req_friendly_name'),
    docId: params.get('doc_id'),
    variables: variables ?? null
  };
}

function isApiPost(node) {
  return Boolean(
    node &&
    typeof node === 'object' &&
    typeof node.code === 'string' &&
    node.user &&
    typeof node.user.username === 'string' &&
    'taken_at' in node
  );
}

function wrappedPost(item) {
  if (!item || typeof item !== 'object') return null;
  if (isApiPost(item.post)) return item.post;
  if (isApiPost(item.node)) return item.node;
  return null;
}

function toStringOrNull(value) {
  return value === undefined || value === null ? null : String(value);
}

function pickImage(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  return [...candidates]
    .filter(c => c && c.url)
    .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0] || null;
}

function extractMedia(post) {
  const items = Array.isArray(post.carousel_media) && post.carousel_media.length
    ? post.carousel_media
    : [post];
  const media = [];
  for (const item of items) {
    if (!item) continue;
    const image = pickImage(item.image_versions2 && item.image_versions2.candidates);
    const video = Array.isArray(item.video_versions) ? item.video_versions.find(v => v && v.url) : null;
    if (video) {
      media.push({
        kind: 'video',
        url: video.url,
        width: item.original_width ?? null,
        height: item.original_height ?? null,
        posterUrl: image ? image.url : null
      });
    } else if (image) {
      media.push({
        kind: 'image',
        url: image.url,
        width: image.width ?? null,
        height: image.height ?? null,
        accessibilityCaption: item.accessibility_caption ?? null
      });
    }
  }
  return media;
}

function summarizeSharedPost(post) {
  if (!isApiPost(post)) return null;
  return {
    code: post.code,
    url: `https://www.threads.com/@${post.user.username}/post/${post.code}`,
    author: post.user.username,
    text: post.caption ? post.caption.text ?? null : null,
    createdAt: typeof post.taken_at === 'number' ? new Date(post.taken_at * 1000).toISOString() : null
  };
}

export function normalizeApiPost(post) {
  const info = post.text_post_app_info || {};
  const fragments = (info.text_fragments && info.text_fragments.fragments) || [];
  const share = info.share_info || {};
  const preview = info.link_preview_attachment;
  return {
    code: post.code,
    pk: toStringOrNull(post.pk),
    id: toStringOrNull(post.id),
    url: `https://www.threads.com/@${post.user.username}/post/${post.code}`,
    author: {
      username: post.user.username,
      fullName: post.user.full_name ?? null,
      userId: toStringOrNull(post.user.pk ?? post.user.id),
      isVerified: post.user.is_verified ?? null,
      profilePicUrl: post.user.profile_pic_url ?? null
    },
    text: post.caption ? post.caption.text ?? null : null,
    captionEdited: post.caption_is_edited ?? null,
    createdAt: typeof post.taken_at === 'number' ? new Date(post.taken_at * 1000).toISOString() : null,
    takenAtUnix: typeof post.taken_at === 'number' ? post.taken_at : null,
    isReply: info.is_reply ?? null,
    replyToUsername: info.reply_to_author ? info.reply_to_author.username ?? null : null,
    counts: {
      likes: post.like_count ?? null,
      replies: info.direct_reply_count ?? null,
      reposts: info.repost_count ?? null,
      quotes: info.quote_count ?? null,
      reshares: info.reshare_count ?? null
    },
    likeAndViewCountsDisabled: post.like_and_view_counts_disabled ?? null,
    mediaType: MEDIA_TYPES[post.media_type] ?? toStringOrNull(post.media_type),
    media: extractMedia(post),
    mentions: fragments
      .map(f => f && f.mention_fragment && f.mention_fragment.mentioned_user && f.mention_fragment.mentioned_user.username)
      .filter(Boolean),
    links: fragments
      .filter(f => f && f.link_fragment && f.link_fragment.uri)
      .map(f => ({ url: f.link_fragment.uri, displayText: f.link_fragment.display_text ?? f.plaintext ?? null })),
    linkPreview: preview
      ? { url: preview.url ?? null, displayUrl: preview.display_url ?? null, title: preview.title ?? null }
      : null,
    quotedPost: summarizeSharedPost(share.quoted_post),
    repostedPost: summarizeSharedPost(share.reposted_post),
    unavailable: info.is_post_unavailable ?? null
  };
}

function isEmpty(value) {
  return value === null || value === undefined || (Array.isArray(value) && value.length === 0);
}

/** Container for API extraction results; pass the same store to every collectApiPosts call. */
export function createApiStore() {
  return {
    posts: new Map(), // code -> normalized record
    replyInfo: new Map() // post id -> { hasUnavailableReplies }
  };
}

function registerPost(store, raw, ctx, source) {
  const record = normalizeApiPost(raw);
  const parent = ctx.parent;
  record.parentCode = parent && parent.code && parent.code !== record.code ? parent.code : null;
  record.parentId = parent && parent.id ? parent.id : null;
  record.related = ctx.related;

  const existing = store.posts.get(record.code);
  if (!existing) {
    store.posts.set(record.code, { ...record, sources: [source] });
    return;
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === 'related' || key === 'counts' || key === 'author') continue;
    if (isEmpty(existing[key]) && !isEmpty(value)) existing[key] = value;
  }
  for (const [key, value] of Object.entries(record.counts)) {
    if (existing.counts[key] === null && value !== null) existing.counts[key] = value;
  }
  for (const [key, value] of Object.entries(record.author)) {
    if (existing.author[key] === null && value !== null) existing.author[key] = value;
  }
  existing.related = existing.related && record.related;
  if (!existing.sources.includes(source)) existing.sources.push(source);
}

/**
 * Walk any JSON payload and collect Threads post objects into `store`
 * (see createApiStore). Structure-agnostic so API wrapper changes do not
 * break extraction.
 *
 * Linkage: an array whose every element wraps a post (`thread_items[].post`,
 * `posts.edges[].node`) is a reply chain; its first post replies to the
 * nearest enclosing post, each later post replies to the previous one.
 * The enclosing post can be a full post object or a reply container
 * `{ id, text_post_app_info: { direct_replies, ... } }` that only carries the
 * post id (resolved to a shortcode in buildThreadDataset).
 * Subtrees under keys containing "related" are flagged as not part of the
 * thread. Posts embedded in `share_info` (quotes/reposts) are summarized on
 * their parent instead of registered.
 */
export function collectApiPosts(json, source, store) {
  const visit = (node, ctx, depth) => {
    if (node === null || typeof node !== 'object' || depth > 250) return;

    if (Array.isArray(node)) {
      const chain = node.length > 0 ? node.map(wrappedPost) : [];
      const isChain = chain.length > 0 && chain.every(Boolean);
      let previous = ctx.parent;
      node.forEach((item, index) => {
        if (isChain) {
          visit(item, { ...ctx, parent: previous }, depth + 1);
          previous = { code: chain[index].code };
        } else {
          visit(item, ctx, depth + 1);
        }
      });
      return;
    }

    let childCtx = ctx;
    if (isApiPost(node)) {
      if (!ctx.inShareInfo) registerPost(store, node, ctx, source);
      childCtx = { ...ctx, parent: { code: node.code } };
    } else if (node.text_post_app_info && typeof node.text_post_app_info === 'object' && (node.id || node.pk)) {
      const id = String(node.id ?? node.pk);
      childCtx = { ...ctx, parent: { id } };
      if ('has_unavailable_replies' in node.text_post_app_info) {
        store.replyInfo.set(id, { hasUnavailableReplies: node.text_post_app_info.has_unavailable_replies });
      }
    }

    for (const key of Object.keys(node)) {
      const value = node[key];
      if (value === null || typeof value !== 'object' || key === 'user') continue;
      let next = childCtx;
      if (RELATED_KEY_RE.test(key)) next = { ...next, related: true };
      if (key === 'share_info') next = { ...next, inShareInfo: true };
      visit(value, next, depth + 1);
    }
  };

  visit(json, { parent: null, related: false, inShareInfo: false }, 0);
  return store;
}

/** Resolve id-only parent references to shortcodes. */
function resolveParents(posts) {
  const byId = new Map();
  for (const post of posts.values()) {
    if (post.id) byId.set(post.id, post.code);
    if (post.pk) byId.set(post.pk, post.code);
  }
  for (const post of posts.values()) {
    if (post.parentCode || !post.parentId) continue;
    const code = byId.get(post.parentId) || byId.get(post.parentId.split('_')[0]);
    if (code && code !== post.code) post.parentCode = code;
  }
}

function lookupReplyInfo(replyInfo, post) {
  if (!post) return null;
  return replyInfo.get(post.id) || replyInfo.get(post.pk) || null;
}

function renderedView(dom) {
  if (!dom) return null;
  return {
    text: dom.renderedText,
    datetimeAttribute: dom.datetime,
    datetimeTitle: dom.datetimeTitle,
    datetimeLabel: dom.datetimeLabel,
    images: dom.images,
    videos: dom.videos,
    outboundLinks: dom.outboundLinks,
    documentY: dom.documentY,
    firstObservedAt: dom.firstObservedAt
  };
}

function mergePost(role, code, api, dom) {
  const sources = [
    ...(api ? api.sources.map(s => `api:${s}`) : []),
    ...(dom ? ['dom'] : [])
  ];
  if (api) {
    const { related, sources: _ignored, ...fields } = api;
    return { role, ...fields, rendered: renderedView(dom), localMedia: [], sources };
  }
  return {
    role,
    code,
    url: dom.permalink,
    author: { username: dom.author, fullName: null, userId: null, isVerified: null, profilePicUrl: null },
    text: null,
    createdAt: dom.datetime,
    takenAtUnix: null,
    isReply: null,
    replyToUsername: null,
    parentCode: null,
    parentId: null,
    counts: null,
    media: [],
    rendered: renderedView(dom),
    localMedia: [],
    sources
  };
}

function orderKey(post) {
  const y = post.rendered ? post.rendered.documentY : null;
  return [y === null || y === undefined ? 1 : 0, y ?? 0, post.takenAtUnix ?? Number.MAX_SAFE_INTEGER];
}

function compareOrder(a, b) {
  const ka = orderKey(a);
  const kb = orderKey(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return 0;
}

/**
 * Merge API and DOM observations into the thread dataset.
 * @param {Object} input
 * @param {string} input.rootCode - Shortcode of the captured post
 * @param {Object} input.api - Store from createApiStore/collectApiPosts
 * @param {Map} input.domPosts - code -> DOM harvest record
 */
export function buildThreadDataset({ rootCode, api: apiStore, domPosts }) {
  const apiPosts = apiStore.posts;
  resolveParents(apiPosts);
  const rootApi = apiPosts.get(rootCode);
  const rootDom = domPosts.get(rootCode);
  const rootY = rootDom ? rootDom.documentY : null;

  const ancestors = new Set();
  for (let code = rootApi && rootApi.parentCode; code && !ancestors.has(code); ) {
    ancestors.add(code);
    const parent = apiPosts.get(code);
    code = parent ? parent.parentCode : null;
  }

  const thread = [];
  const related = [];
  const codes = new Set([...apiPosts.keys(), ...domPosts.keys()]);

  for (const code of codes) {
    const api = apiPosts.get(code);
    const dom = domPosts.get(code);
    if (!api && dom.nestedInCode) continue; // quote card rendered inside another post

    const aboveRoot = dom && rootY !== null && dom.documentY < rootY && dom.inThreadSection !== false;
    let role;
    if (code === rootCode) role = 'root';
    else if (ancestors.has(code) || (aboveRoot && !(api && api.related))) role = 'ancestor';
    else if (api) role = !api.related && api.isReply === true ? 'reply' : 'related';
    else role = dom.inThreadSection === false ? 'related' : 'reply';

    const post = mergePost(role, code, api, dom);
    (role === 'related' ? related : thread).push(post);
  }

  const rank = { ancestor: 0, root: 1, reply: 2 };
  thread.sort((a, b) => rank[a.role] - rank[b.role] || compareOrder(a, b));
  related.sort(compareOrder);

  const root = thread.find(p => p.role === 'root') || null;
  const replies = thread.filter(p => p.role === 'reply');
  const byParent = new Map();
  for (const reply of replies) {
    if (!reply.parentCode) continue;
    byParent.set(reply.parentCode, (byParent.get(reply.parentCode) || 0) + 1);
  }

  const repliesWithUncapturedChildren = thread
    .filter(p => p.role === 'reply' && p.counts && p.counts.replies > (byParent.get(p.code) || 0))
    .map(p => ({
      code: p.code,
      url: p.url,
      reportedReplies: p.counts.replies,
      capturedReplies: byParent.get(p.code) || 0
    }));

  const warnings = [];
  if (!root) warnings.push('Root post was not found in API data or rendered page.');
  if (root && !root.sources.some(s => s.startsWith('api:'))) {
    warnings.push('Root post has no API data; text/counts are available only as rendered text.');
  }
  const reportedDirect = root && root.counts ? root.counts.replies : null;
  const capturedDirect = byParent.get(rootCode) || 0;
  // Paginated reply batches do not always carry the parent post, but they do name the
  // account being replied to; count those separately instead of dropping the link.
  const rootAuthor = root && root.author ? root.author.username : null;
  const inferredDirect = rootAuthor
    ? replies.filter(p => !p.parentCode && p.replyToUsername === rootAuthor).length
    : 0;
  if (reportedDirect !== null && capturedDirect + inferredDirect < reportedDirect) {
    warnings.push(
      `Root post reports ${reportedDirect} direct replies; ${capturedDirect} captured with confirmed parent linkage` +
      (inferredDirect ? ` and ${inferredDirect} more addressed to @${rootAuthor}` : '') +
      ` (${replies.length} replies captured in total). The difference can be replies hidden, restricted or deleted, ` +
      'filtered by Threads, not loaded, or replies whose parent could not be determined from API data.'
    );
  }
  if (repliesWithUncapturedChildren.length) {
    warnings.push(
      `${repliesWithUncapturedChildren.length} post(s) report nested replies that are not shown on this page; ` +
      'open each listed permalink to capture them.'
    );
  }
  const rootReplyInfo = lookupReplyInfo(apiStore.replyInfo, rootApi);
  const hasUnavailableReplies = rootReplyInfo ? Boolean(rootReplyInfo.hasUnavailableReplies) : null;
  if (hasUnavailableReplies) {
    warnings.push('Threads reports that some replies to this post are unavailable to the capturing account.');
  }

  return {
    rootCode,
    root,
    posts: thread,
    relatedPosts: related,
    statistics: {
      threadPosts: thread.length,
      ancestors: thread.filter(p => p.role === 'ancestor').length,
      replies: replies.length,
      rootReportedDirectReplies: reportedDirect,
      rootHasUnavailableReplies: hasUnavailableReplies,
      directRepliesWithConfirmedParent: capturedDirect,
      directRepliesInferredFromReplyTo: inferredDirect,
      postsWithApiData: thread.filter(p => p.sources.some(s => s.startsWith('api:'))).length,
      postsRenderedOnly: thread.filter(p => !p.sources.some(s => s.startsWith('api:'))).length,
      postsApiOnly: thread.filter(p => !p.sources.includes('dom')).length,
      relatedPostsExcluded: related.length
    },
    repliesWithUncapturedChildren,
    warnings
  };
}
