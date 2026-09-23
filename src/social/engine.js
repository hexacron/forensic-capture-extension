/**
 * Social post parsing engine - pure functions, no browser APIs.
 *
 * Two independent sources describe a post and its replies:
 * - API data: post objects from server-embedded payloads and recorded API
 *   responses. Authoritative text, timestamps, counts, media URLs and linkage.
 * - DOM observations: what was actually rendered (text as displayed, visual
 *   order, per-post HTML), harvested while scrolling virtualized lists.
 *
 * The engine is platform-neutral: every platform supplies `platform.parser`
 * hooks (post detection, normalization, linkage rules) and the walker applies
 * them structurally, so wrapper changes in the API do not break extraction.
 * buildThreadDataset() merges both sources by post code.
 */

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
 * Keep only non-sensitive fields of a Meta GraphQL form body (drops CSRF and
 * session tokens such as fb_dtsg, lsd, jazoest).
 */
export function summarizeMetaFormRequest(postData) {
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

function isEmpty(value) {
  return value === null || value === undefined || (Array.isArray(value) && value.length === 0);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Container for API extraction results; pass the same store to every collectApiPosts call. */
export function createApiStore({ rootCode } = {}) {
  return {
    rootCode: rootCode ?? null,
    posts: new Map(), // code -> normalized record
    replyInfo: new Map() // post id -> { hasUnavailableReplies }
  };
}

function registerPost(store, record, ctx, source) {
  if (record.parentCode == null && record.parentId == null) {
    const parent = ctx.parent;
    record.parentCode = parent && parent.code && parent.code !== record.code ? parent.code : null;
    record.parentId = parent && parent.id ? parent.id : null;
  }
  const related = ctx.related || record.related === true;
  record.related = related;

  const existing = store.posts.get(record.code);
  if (!existing) {
    store.posts.set(record.code, { ...record, sources: [source] });
    return;
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === 'related') continue;
    if (isPlainObject(value) && isPlainObject(existing[key])) {
      for (const [inner, innerValue] of Object.entries(value)) {
        if (existing[key][inner] == null && innerValue != null) existing[key][inner] = innerValue;
      }
    } else if (isEmpty(existing[key]) && !isEmpty(value)) {
      existing[key] = value;
    }
  }
  // One sighting outside a related subtree makes the post part of the thread.
  existing.related = existing.related && related;
  if (!existing.sources.includes(source)) existing.sources.push(source);
}

/**
 * Walk any JSON payload and collect post objects into `store` (see createApiStore),
 * using the platform's parser hooks.
 *
 * Linkage: when the platform defines `wrappedPost`, an array whose every element
 * wraps a post is a reply chain; its first post replies to the nearest enclosing
 * post, each later post replies to the previous one. The enclosing post can be a
 * full post object or a reply container (`parser.replyContainer`) that only
 * carries the post id (resolved to a code in buildThreadDataset).
 * Subtrees under keys matching `parser.relatedKeyPattern` are flagged as not part
 * of the thread. Posts under `parser.shareKeys` (quotes/reposts) are summarized on
 * their parent instead of registered; keys in `parser.skipKeys` are not walked.
 */
export function collectApiPosts(json, source, store, parser) {
  const visit = (node, ctx, depth) => {
    if (node === null || typeof node !== 'object' || depth > 250) return;

    if (Array.isArray(node)) {
      const chain = parser.wrappedPost && node.length > 0 ? node.map(parser.wrappedPost) : [];
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
    if (parser.isApiPost(node)) {
      const record = parser.normalizeApiPost(node, { rootCode: store.rootCode, parentPostCode: ctx.parentPostCode });
      if (ctx.inShareInfo) {
        childCtx = { ...ctx, parent: { code: record.code } };
      } else {
        registerPost(store, record, ctx, source);
        childCtx = { ...ctx, parent: { code: record.code }, parentPostCode: record.code };
      }
    } else {
      const container = parser.replyContainer ? parser.replyContainer(node) : null;
      if (container) {
        childCtx = { ...ctx, parent: { id: container.id } };
        if ('hasUnavailableReplies' in container) {
          store.replyInfo.set(container.id, { hasUnavailableReplies: container.hasUnavailableReplies });
        }
      }
    }

    for (const key of Object.keys(node)) {
      const value = node[key];
      if (value === null || typeof value !== 'object' || parser.skipKeys.includes(key)) continue;
      let next = childCtx;
      if (parser.relatedKeyPattern && parser.relatedKeyPattern.test(key)) next = { ...next, related: true };
      if (parser.shareKeys.includes(key)) next = { ...next, inShareInfo: true };
      visit(value, next, depth + 1);
    }
  };

  visit(json, { parent: null, parentPostCode: null, related: false, inShareInfo: false }, 0);
  return store;
}

/** Resolve id-only parent references (and top-level replies) to post codes. */
function resolveParents(store, parser) {
  const byId = new Map();
  for (const post of store.posts.values()) {
    for (const value of [post.id, post.pk]) {
      if (value === null || value === undefined) continue;
      for (const alias of parser.idAliases(String(value))) byId.set(alias, post.code);
    }
  }
  for (const post of store.posts.values()) {
    if (post.parentCode) continue;
    if (post.parentIsRoot === true) {
      if (store.rootCode && store.rootCode !== post.code) post.parentCode = store.rootCode;
      continue;
    }
    if (!post.parentId) continue;
    for (const alias of parser.idAliases(String(post.parentId))) {
      const code = byId.get(alias);
      if (code && code !== post.code) {
        post.parentCode = code;
        break;
      }
    }
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

function domCreatedAt(code, dom, parser) {
  if (dom.datetime) return { createdAt: dom.datetime, createdAtSource: 'rendered time element' };
  const fallback = parser.domFallbackCreatedAt ? parser.domFallbackCreatedAt(code) : null;
  return fallback || { createdAt: null, createdAtSource: null };
}

function mergePost(role, code, api, dom, platform) {
  const sources = [
    ...(api ? api.sources.map(s => `api:${s}`) : []),
    ...(dom ? ['dom'] : [])
  ];
  if (api) {
    const { related, sources: _ignored, ...fields } = api;
    return {
      role,
      platform: platform.id,
      ...fields,
      createdAtSource: fields.createdAt ? 'api' : null,
      rendered: renderedView(dom),
      localMedia: [],
      sources
    };
  }
  return {
    role,
    platform: platform.id,
    code,
    url: dom.permalink,
    author: { username: dom.author, fullName: null, userId: null, isVerified: null, profilePicUrl: null },
    text: null,
    ...domCreatedAt(code, dom, platform.parser),
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
 * @param {string} input.rootCode - Code of the captured post
 * @param {Object} input.api - Store from createApiStore/collectApiPosts
 * @param {Map} input.domPosts - code -> DOM harvest record
 * @param {Object} input.platform - Platform adapter (src/social/platforms/*)
 */
export function buildThreadDataset({ rootCode, api: apiStore, domPosts, platform }) {
  const { label, words } = platform;
  const parser = platform.parser;
  const apiPosts = apiStore.posts;
  resolveParents(apiStore, parser);
  const rootApi = apiPosts.get(rootCode);
  const rootDom = domPosts.get(rootCode);
  const rootY = rootDom ? rootDom.documentY : null;

  const ancestors = new Set();
  for (let code = rootApi && rootApi.parentCode; code && !ancestors.has(code); ) {
    ancestors.add(code);
    const parent = apiPosts.get(code);
    code = parent ? parent.parentCode : null;
  }
  // A post whose API parent chain reaches the root is a reply, wherever it was rendered.
  const descendsFromRoot = code => {
    const seen = new Set();
    for (let post = apiPosts.get(code); post && post.parentCode && !seen.has(post.code); post = apiPosts.get(post.parentCode)) {
      if (post.parentCode === rootCode) return true;
      seen.add(post.code);
    }
    return false;
  };

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
    else if (ancestors.has(code) || (aboveRoot && !(api && (api.related || descendsFromRoot(code))))) role = 'ancestor';
    else if (api) role = !api.related && api.isReply === true ? 'reply' : 'related';
    else role = dom.inThreadSection === false ? 'related' : 'reply';
    if (api && role !== 'root' && role !== 'ancestor' && parser.isRelated && parser.isRelated(api, rootApi)) {
      role = 'related';
    }

    const post = mergePost(role, code, api, dom, platform);
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

  const scope = platform.dataset.reportedRepliesScope;
  const warnings = [];
  if (!root) warnings.push('Root post was not found in API data or rendered page.');
  if (root && !root.sources.some(s => s.startsWith('api:'))) {
    warnings.push('Root post has no API data; text/counts are available only as rendered text.');
  }
  const reported = root && root.counts ? root.counts.replies ?? null : null;
  const capturedDirect = byParent.get(rootCode) || 0;
  // Paginated reply batches do not always carry the parent post, but they do name the
  // account being replied to; count those separately instead of dropping the link.
  const rootAuthor = root && root.author ? root.author.username : null;
  const inferredDirect = rootAuthor
    ? replies.filter(p => !p.parentCode && p.replyToUsername === rootAuthor).length
    : 0;
  if (scope === 'all') {
    if (reported !== null && replies.length < reported) {
      warnings.push(
        `Post reports ${reported} ${words.replies} (including replies to ${words.replies}); ${replies.length} captured. ` +
        `The difference can be ${words.replies} hidden, restricted or deleted, filtered by ${label}, not loaded, ` +
        'or replies that were not expanded.'
      );
    }
  } else if (reported !== null && capturedDirect + inferredDirect < reported) {
    warnings.push(
      `Root post reports ${reported} direct ${words.replies}; ${capturedDirect} captured with confirmed parent linkage` +
      (inferredDirect ? ` and ${inferredDirect} more addressed to @${rootAuthor}` : '') +
      ` (${replies.length} ${words.replies} captured in total). The difference can be ${words.replies} hidden, restricted or deleted, ` +
      `filtered by ${label}, not loaded, or ${words.replies} whose parent could not be determined from API data.`
    );
  }
  if (repliesWithUncapturedChildren.length) {
    warnings.push(
      `${repliesWithUncapturedChildren.length} post(s) report nested ${words.replies} that are not shown on this page; ` +
      'open each listed permalink to capture them.'
    );
  }
  const rootReplyInfo = lookupReplyInfo(apiStore.replyInfo, rootApi);
  const hasUnavailableReplies = rootReplyInfo ? Boolean(rootReplyInfo.hasUnavailableReplies) : null;
  if (hasUnavailableReplies) warnings.push(platform.dataset.unavailableRepliesText);

  return {
    platform: platform.id,
    rootCode,
    root,
    posts: thread,
    relatedPosts: related,
    statistics: {
      threadPosts: thread.length,
      ancestors: thread.filter(p => p.role === 'ancestor').length,
      replies: replies.length,
      rootReportedReplies: reported,
      rootReportedRepliesScope: scope,
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
