/**
 * Instagram platform adapter (posts and Reels with comments). Pure module.
 *
 * The media object and its first comment page arrive in the server-embedded
 * payload (`xig_polaris_media.if_not_gated_logged_out` and the sibling
 * `comments_connection`); later comment pages and child comments arrive in
 * /api/graphql or /api/v1/ responses. Comments are detected by their fields,
 * not their path, and carry their own `parent_comment_id`.
 *
 * Comment codes are the numeric comment ids (`pk`), which is also what the
 * comment permalinks `/p/{code}/c/{commentId}/` use in the DOM.
 */

import { summarizeMetaFormRequest } from '../engine.js';
import { extractMedia } from '../meta-media.js';

const HOST_RE = /^(?:www\.|m\.)?instagram\.com$/i;
const POST_PATH_RE = /^\/(?:([A-Za-z0-9._]{1,30})\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)\/?(?:c\/\d+\/?)?$/;
const RESERVED_SEGMENTS = new Set(['p', 'reel', 'reels', 'tv', 'explore', 'stories', 'accounts', 'direct']);
const MENTION_RE = /(^|[^\w.])@([A-Za-z0-9._]{1,30})/g;
const MEDIA_TYPES = { 1: 'image', 2: 'video', 8: 'carousel' };

function toStringOrNull(value) {
  return value === undefined || value === null ? null : String(value);
}

function hasUser(node) {
  return Boolean(node.user && typeof node.user === 'object' && typeof node.user.username === 'string');
}

function isMedia(node) {
  return typeof node.code === 'string' && hasUser(node) && 'taken_at' in node;
}

function isComment(node) {
  return typeof node.text === 'string' &&
    'created_at' in node &&
    hasUser(node) &&
    (node.pk != null || node.id != null) &&
    !('code' in node) &&
    !('taken_at' in node);
}

function isApiPost(node) {
  return Boolean(node && typeof node === 'object' && (isMedia(node) || isComment(node)));
}

function mentionsIn(text) {
  if (typeof text !== 'string') return [];
  const names = [];
  for (const match of text.matchAll(MENTION_RE)) {
    if (!names.includes(match[2])) names.push(match[2]);
  }
  return names;
}

function unixToIso(value) {
  return typeof value === 'number' ? new Date(value * 1000).toISOString() : null;
}

function author(user) {
  return {
    username: user.username,
    fullName: user.full_name ?? null,
    userId: toStringOrNull(user.pk ?? user.id),
    isVerified: user.is_verified ?? null,
    profilePicUrl: user.profile_pic_url ?? null
  };
}

function normalizeMedia(node, rootCode) {
  const text = node.caption ? node.caption.text ?? null : null;
  const tagged = node.usertags && Array.isArray(node.usertags.in) ? node.usertags.in : [];
  return {
    code: node.code,
    pk: toStringOrNull(node.pk),
    id: toStringOrNull(node.id),
    url: `https://www.instagram.com/${node.product_type === 'clips' ? 'reel' : 'p'}/${node.code}/`,
    author: author(node.user),
    text,
    captionEdited: node.caption_is_edited ?? null,
    createdAt: unixToIso(node.taken_at),
    takenAtUnix: typeof node.taken_at === 'number' ? node.taken_at : null,
    isReply: false,
    replyToUsername: null,
    parentCode: null,
    parentId: null,
    parentIsRoot: false,
    counts: {
      likes: node.like_count ?? null,
      replies: node.comment_count ?? null,
      views: node.view_count ?? node.play_count ?? null
    },
    mediaType: MEDIA_TYPES[node.media_type] ?? toStringOrNull(node.media_type),
    media: extractMedia(node),
    mentions: mentionsIn(text),
    links: [],
    linkPreview: null,
    quotedPost: null,
    repostedPost: null,
    unavailable: false,
    related: node.code !== rootCode,
    extra: {
      productType: node.product_type ?? null,
      location: node.location ? { name: node.location.name ?? null, pk: toStringOrNull(node.location.pk) } : null,
      taggedUsers: tagged.map(t => t && t.user && t.user.username).filter(Boolean)
    }
  };
}

function normalizeComment(node, rootCode, parentPostCode) {
  const code = String(node.pk ?? node.id);
  return {
    code,
    pk: toStringOrNull(node.pk),
    id: toStringOrNull(node.id),
    url: `https://www.instagram.com/p/${rootCode}/c/${code}/`,
    author: author(node.user),
    text: node.text,
    captionEdited: null,
    createdAt: unixToIso(node.created_at),
    takenAtUnix: typeof node.created_at === 'number' ? node.created_at : null,
    isReply: true,
    replyToUsername: null,
    parentCode: null,
    parentId: node.parent_comment_id ? String(node.parent_comment_id) : null,
    parentIsRoot: !node.parent_comment_id,
    counts: {
      likes: node.comment_like_count ?? null,
      replies: node.child_comment_count ?? null
    },
    mediaType: null,
    media: [],
    mentions: mentionsIn(node.text),
    links: [],
    linkPreview: null,
    quotedPost: null,
    repostedPost: null,
    unavailable: Boolean(node.is_covered),
    related: Boolean(parentPostCode && parentPostCode !== rootCode),
    extra: { restrictedStatus: node.restricted_status ?? null }
  };
}

function normalizeApiPost(node, { rootCode, parentPostCode }) {
  return isMedia(node) ? normalizeMedia(node, rootCode) : normalizeComment(node, rootCode, parentPostCode);
}

export default {
  id: 'instagram',
  label: 'Instagram',
  words: { reply: 'comment', replies: 'comments', heading: 'Post and comments' },

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
    if (match[1] && RESERVED_SEGMENTS.has(match[1].toLowerCase())) return null;
    const username = match[1] || null;
    const code = match[3];
    return {
      platform: 'instagram',
      username,
      code,
      kind: match[2] === 'reel' || match[2] === 'reels' ? 'reel' : 'post',
      canonicalUrl: `https://www.instagram.com/p/${code}/`,
      displayLabel: username ? `@${username} · ${code}` : code
    };
  },

  isPlatformUrl(url) {
    try {
      return HOST_RE.test(new URL(url).hostname);
    } catch {
      return false;
    }
  },

  sessionCookie: { url: 'https://www.instagram.com/', name: 'sessionid' },

  api: {
    urlRe: /^https:\/\/www\.instagram\.com\/(?:api\/graphql|graphql\/query|api\/v1\/)/,
    summarizeRequest(request) {
      if (request.postData) return summarizeMetaFormRequest(request.postData);
      try {
        return { friendlyName: new URL(request.url).pathname, docId: null, variables: null };
      } catch {
        return null;
      }
    },
    // Unnamed operations count as content fetches (the cautious side).
    isContentFetch: (query, url) => !query || !query.friendlyName ||
      /Comment|Media|PostPage|Pagination|Clips|Reel/i.test(query.friendlyName) ||
      /\/comments\//.test(url),
    recordingNote: 'Request tokens (fb_dtsg, lsd, jazoest) are intentionally not recorded'
  },

  refusalReason(url) {
    try {
      const path = new URL(url).pathname;
      if (path.startsWith('/accounts/login')) return 'login-required';
      if (path.startsWith('/challenge')) return 'challenge';
    } catch {
      // not a URL
    }
    return null;
  },

  dom: {
    harvest: 'anchors',
    permalink: { pattern: '^/(?:[^/]+/)?(?:p|reel)/([A-Za-z0-9_-]+)/c/(\\d+)/?$', postGroup: 1, codeGroup: 2 },
    authorLink: '^/([A-Za-z0-9._]{1,30})/?$',
    expanders: [
      '^(show|view|see|load|read)\\s+(\\d[\\d,.]*[km]?\\s+)?(more|all|hidden|additional|other|previous|earlier|remaining)?\\s*(repl(y|ies)|comments?|answers?)\\b',
      '^(more|hidden|other)\\s+repl(y|ies)$'
    ],
    hiddenExpanders: [],
    relatedHeadings: ['^more posts from\\b'],
    embeddedJson: { selector: 'script[type="application/json"][data-sjs]', marker: '"taken_at"' },
    rootRendered: 'location'
  },

  parser: {
    isApiPost,
    wrappedPost: null,
    normalizeApiPost,
    replyContainer: null,
    // Carousel items carry code, user and taken_at like posts; extractMedia reads
    // them from the parent instead.
    skipKeys: ['user', 'caption', 'carousel_media'],
    shareKeys: [],
    relatedKeyPattern: null,
    idAliases: id => [id],
    isRelated: null,
    domFallbackCreatedAt: null
  },

  dataset: {
    reportedRepliesScope: 'all',
    unavailableRepliesText: 'Instagram reports that some comments are unavailable to the capturing account.'
  },

  report: {
    countLabels: post => post.role === 'root'
      ? [['likes', 'Likes'], ['replies', 'Comments'], ['views', 'Views']]
      : [['likes', 'Likes'], ['replies', 'Replies']],
    homeHost: 'www.instagram.com'
  },

  mediaSourceDescription: 'Fetched from the Instagram CDN URL in the API data at capture time (credentials omitted)',

  constraints: [
    'Comments are loaded in pages and may be virtualized; the DOM file holds the comments observed while scrolling.',
    'Content visibility depends on the logged-in account (blocked, restricted and hidden comments are not served).'
  ]
};
