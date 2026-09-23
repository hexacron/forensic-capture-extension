/**
 * Threads (threads.com / threads.net) platform adapter. Pure module.
 *
 * Posts come from server-embedded Relay payloads (script[data-sjs]) and
 * /api/graphql responses. Replies arrive either as wrapped reply chains
 * (`thread_items[].post`) or under a reply container that only carries the
 * parent post id (`{ id, text_post_app_info: { direct_replies … } }`).
 */

import { summarizeMetaFormRequest } from '../engine.js';
import { extractMedia } from '../meta-media.js';

const HOST_RE = /^(?:www\.)?threads\.(?:com|net)$/i;
const POST_PATH_RE = /^\/@([^/]+)\/post\/([A-Za-z0-9_-]+)\/?$/;
const MEDIA_TYPES = { 1: 'image', 2: 'video', 8: 'carousel', 19: 'text' };

function toStringOrNull(value) {
  return value === undefined || value === null ? null : String(value);
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

function replyContainer(node) {
  const info = node.text_post_app_info;
  if (!info || typeof info !== 'object' || !(node.id || node.pk)) return null;
  const id = String(node.id ?? node.pk);
  return 'has_unavailable_replies' in info ? { id, hasUnavailableReplies: info.has_unavailable_replies } : { id };
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

function normalizeApiPost(post) {
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
    parentCode: null,
    parentId: null,
    parentIsRoot: false,
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
    unavailable: info.is_post_unavailable ?? null,
    related: false,
    extra: {}
  };
}

export default {
  id: 'threads',
  label: 'Threads',
  words: { reply: 'reply', replies: 'replies', heading: 'Thread' },

  /** @returns {{platform: 'threads', username: string, code: string, canonicalUrl: string, displayLabel: string} | null} */
  parsePostUrl(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!HOST_RE.test(parsed.hostname)) return null;
    const match = POST_PATH_RE.exec(parsed.pathname);
    if (!match) return null;
    const username = decodeURIComponent(match[1]);
    return {
      platform: 'threads',
      username,
      code: match[2],
      canonicalUrl: `https://www.threads.com/@${username}/post/${match[2]}`,
      displayLabel: `@${username} · ${match[2]}`
    };
  },

  isPlatformUrl(url) {
    try {
      return HOST_RE.test(new URL(url).hostname);
    } catch {
      return false;
    }
  },

  sessionCookie: { url: 'https://www.threads.com/', name: 'sessionid' },

  api: {
    urlRe: /^https:\/\/(?:www\.)?threads\.(?:com|net)\/(?:api\/graphql|graphql\/query)/,
    summarizeRequest: request => summarizeMetaFormRequest(request.postData),
    // Operations that load post/reply content (what scrolling triggers). Signed-in Threads
    // also polls on its own (like counts, notification badge, screen time) at about 12
    // requests/min; those are not caused by the capture and must not stall its pacing.
    // An operation that cannot be named counts as a content fetch (the cautious side).
    isContentFetch: query => !query || !query.friendlyName || /Repl(?:y|ies)|Pagination|PostPage|ThreadPage/i.test(query.friendlyName),
    recordingNote: 'Request tokens (fb_dtsg, lsd, jazoest) are intentionally not recorded'
  },

  /** Threads refuses a direct load by redirecting with `?error=<reason>`. */
  refusalReason(url) {
    try {
      return new URL(url).searchParams.get('error');
    } catch {
      return null;
    }
  },

  dom: {
    harvest: 'containers',
    postSelector: '[data-pressable-container]',
    permalink: { pattern: '^/@([^/]+)/post/([A-Za-z0-9_-]+)/?$', authorGroup: 1, codeGroup: 2 },
    expanders: [
      '^(show|view|see|load|read)\\s+(\\d[\\d,.]*[km]?\\s+)?(more|all|hidden|additional|other|previous|earlier|remaining)?\\s*(repl(y|ies)|comments?|answers?)\\b',
      '^(more|hidden|other)\\s+repl(y|ies)$'
    ],
    hiddenExpanders: [],
    relatedHeadings: ['^related threads$'],
    embeddedJson: { selector: 'script[type="application/json"][data-sjs]', marker: '"taken_at"' },
    rootRendered: 'permalink'
  },

  parser: {
    isApiPost,
    wrappedPost,
    normalizeApiPost,
    replyContainer,
    skipKeys: ['user'],
    shareKeys: ['share_info'],
    relatedKeyPattern: /related/i,
    idAliases: id => [id, id.split('_')[0]],
    isRelated: null,
    domFallbackCreatedAt: null
  },

  dataset: {
    reportedRepliesScope: 'direct',
    unavailableRepliesText: 'Threads reports that some replies to this post are unavailable to the capturing account.'
  },

  report: {
    countLabels: () => [['likes', 'Likes'], ['replies', 'Replies'], ['reposts', 'Reposts'], ['quotes', 'Quotes']],
    homeHost: 'www.threads.com'
  },

  mediaSourceDescription: 'Fetched from the Threads CDN URL in the API data at capture time (credentials omitted)',

  constraints: [
    'Threads renders a virtualized list: the DOM file reflects only posts rendered at the end of capture; per-post HTML is in the DOM posts file',
    'Threads content visible depends on the logged-in account (blocks, restrictions, hidden replies)'
  ]
};
