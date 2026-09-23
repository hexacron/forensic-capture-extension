/**
 * X (x.com / twitter.com) platform adapter: posts with replies. Pure module.
 *
 * Signed in, replies arrive in TweetDetail GraphQL responses
 * (`GET /i/api/graphql/{queryId}/TweetDetail?variables=…`); each tweet is an object
 * with `rest_id` and `legacy` (text, timestamps, counts, reply linkage). Signed out,
 * X serves a server-rendered page with the post and a few top replies only, with
 * no API traffic and no <time> elements; those posts are dated from their ids
 * (snowflakes carry their creation time).
 */

const HOST_RE = /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/i;
const WEB_STATUS_RE = /^\/i\/(?:web\/)?status\/(\d+)\/?$/;
const USER_STATUS_RE = /^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d+)(?:\/(?:photo|video)\/\d+|\/analytics|\/quotes|\/retweets|\/likes)?\/?$/;
const CONTENT_OPERATIONS_RE = /^(TweetDetail|TweetResultByRestId|ConversationTimeline)$/;
// Ids from late 2010 on are snowflakes: milliseconds since the Twitter epoch in the top bits.
const SNOWFLAKE_MIN = 100000000000000n;
const TWITTER_EPOCH_MS = 1288834974657;

function isApiPost(node) {
  return Boolean(
    node &&
    typeof node === 'object' &&
    typeof node.rest_id === 'string' &&
    node.legacy &&
    typeof node.legacy.full_text === 'string' &&
    typeof node.legacy.created_at === 'string'
  );
}

/** Tweets can be wrapped as `{ __typename: 'TweetWithVisibilityResults', tweet: {…} }`. */
function unwrap(result) {
  if (!result || typeof result !== 'object') return null;
  if (isApiPost(result)) return result;
  if (isApiPost(result.tweet)) return result.tweet;
  return null;
}

function userOf(tweet) {
  const u = (tweet.core && tweet.core.user_results && tweet.core.user_results.result) || {};
  return {
    username: u.core?.screen_name ?? u.legacy?.screen_name ?? null,
    fullName: u.core?.name ?? u.legacy?.name ?? null,
    userId: u.rest_id ?? null,
    isVerified: u.is_blue_verified ?? u.legacy?.verified ?? null,
    profilePicUrl: u.avatar?.image_url ?? u.legacy?.profile_image_url_https ?? null
  };
}

function textOf(tweet) {
  return tweet.note_tweet?.note_tweet_results?.result?.text ?? tweet.legacy.full_text;
}

function isoDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function summarize(result) {
  const tweet = unwrap(result);
  if (!tweet) return null;
  const username = userOf(tweet).username;
  const date = isoDate(tweet.legacy.created_at);
  return {
    code: tweet.rest_id,
    url: `https://x.com/${username ?? 'i'}/status/${tweet.rest_id}`,
    author: username,
    text: textOf(tweet),
    createdAt: date ? date.toISOString() : null
  };
}

function mediaOf(legacy) {
  const items = (legacy.extended_entities && legacy.extended_entities.media) || [];
  const media = [];
  for (const item of items) {
    if (!item) continue;
    if (item.type === 'photo') {
      media.push({
        kind: 'image',
        url: `${item.media_url_https}?name=orig`,
        width: item.original_info?.width ?? null,
        height: item.original_info?.height ?? null,
        accessibilityCaption: item.ext_alt_text ?? null
      });
    } else if (item.type === 'video' || item.type === 'animated_gif') {
      const best = (item.video_info?.variants || [])
        .filter(v => v && v.content_type === 'video/mp4' && v.url)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      if (!best) continue;
      media.push({
        kind: 'video',
        url: best.url,
        width: item.original_info?.width ?? null,
        height: item.original_info?.height ?? null,
        posterUrl: item.media_url_https ?? null
      });
    }
  }
  return media;
}

function normalizeApiPost(tweet) {
  const legacy = tweet.legacy;
  const author = userOf(tweet);
  const date = isoDate(legacy.created_at);
  const media = mediaOf(legacy);
  const entities = legacy.entities || {};
  return {
    code: tweet.rest_id,
    pk: null,
    id: tweet.rest_id,
    url: `https://x.com/${author.username ?? 'i'}/status/${tweet.rest_id}`,
    author,
    text: textOf(tweet),
    captionEdited: null,
    createdAt: date ? date.toISOString() : null,
    takenAtUnix: date ? Math.floor(date.getTime() / 1000) : null,
    isReply: Boolean(legacy.in_reply_to_status_id_str),
    replyToUsername: legacy.in_reply_to_screen_name ?? null,
    parentCode: legacy.in_reply_to_status_id_str ?? null,
    parentId: null,
    parentIsRoot: false,
    counts: {
      likes: legacy.favorite_count ?? null,
      replies: legacy.reply_count ?? null,
      reposts: legacy.retweet_count ?? null,
      quotes: legacy.quote_count ?? null,
      bookmarks: legacy.bookmark_count ?? null,
      views: tweet.views?.count != null ? Number(tweet.views.count) : null
    },
    mediaType: media.length > 1 ? 'carousel' : media.length === 1 ? media[0].kind : 'text',
    media,
    mentions: (entities.user_mentions || []).map(m => m && m.screen_name).filter(Boolean),
    links: (entities.urls || []).filter(u => u && u.expanded_url).map(u => ({ url: u.expanded_url, displayText: u.display_url ?? null })),
    linkPreview: null,
    quotedPost: summarize(tweet.quoted_status_result?.result),
    repostedPost: summarize(legacy.retweeted_status_result?.result),
    unavailable: false,
    related: false,
    extra: { conversationId: legacy.conversation_id_str ?? null }
  };
}

export default {
  id: 'x',
  label: 'X',
  words: { reply: 'reply', replies: 'replies', heading: 'Thread' },

  parsePostUrl(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!HOST_RE.test(parsed.hostname)) return null;
    let username = null;
    let id;
    const web = WEB_STATUS_RE.exec(parsed.pathname);
    if (web) {
      id = web[1];
    } else {
      const match = USER_STATUS_RE.exec(parsed.pathname);
      if (!match || match[1].toLowerCase() === 'i') return null;
      username = match[1];
      id = match[2];
    }
    return {
      platform: 'x',
      username,
      code: id,
      canonicalUrl: username ? `https://x.com/${username}/status/${id}` : `https://x.com/i/status/${id}`,
      displayLabel: username ? `@${username} · ${id}` : id
    };
  },

  isPlatformUrl(url) {
    try {
      return HOST_RE.test(new URL(url).hostname);
    } catch {
      return false;
    }
  },

  sessionCookie: { url: 'https://x.com/', name: 'auth_token' },

  api: {
    urlRe: /^https:\/\/(?:x|twitter)\.com\/i\/api\/graphql\/[^/]+\/[A-Za-z0-9_]+/,
    /** Operation name, query id and variables only: never headers, features or fieldToggles. */
    summarizeRequest(request) {
      let parsed;
      try {
        parsed = new URL(request.url);
      } catch {
        return null;
      }
      const segments = parsed.pathname.split('/').filter(Boolean);
      const raw = parsed.searchParams.get('variables');
      let variables = null;
      if (raw !== null) {
        try {
          variables = JSON.parse(raw);
        } catch {
          variables = raw;
        }
      }
      return {
        friendlyName: segments[segments.length - 1] ?? null,
        docId: segments[segments.length - 2] ?? null,
        variables
      };
    },
    // Unnamed operations count as content fetches (the cautious side).
    isContentFetch: query => !query || !query.friendlyName || CONTENT_OPERATIONS_RE.test(query.friendlyName),
    recordingNote: 'Request headers (authorization, x-csrf-token) and cookies are never recorded; only the operation name and variables'
  },

  refusalReason(url) {
    try {
      const path = new URL(url).pathname;
      if (path.startsWith('/i/flow/login') || path.startsWith('/login')) return 'login-required';
    } catch {
      // not a URL
    }
    return null;
  },

  dom: {
    harvest: 'containers',
    postSelector: 'article',
    permalink: { pattern: '^/([A-Za-z0-9_]{1,15})/status/(\\d+)/?$', authorGroup: 1, codeGroup: 2 },
    expanders: ['^show (more )?replies$'],
    hiddenExpanders: ['^show probable spam$', '^show additional replies\\b'],
    relatedHeadings: ['^discover more$'],
    embeddedJson: null,
    rootRendered: 'permalink'
  },

  parser: {
    isApiPost,
    wrappedPost: null,
    normalizeApiPost,
    replyContainer: null,
    skipKeys: ['core'],
    shareKeys: ['quoted_status_result', 'retweeted_status_result'],
    relatedKeyPattern: null,
    idAliases: id => [id],
    /** Tweets from another conversation (recommendations, "Discover more") are not replies. */
    isRelated: (record, root) => Boolean(
      root && root.extra?.conversationId && record.extra?.conversationId &&
      record.extra.conversationId !== root.extra.conversationId
    ),
    domFallbackCreatedAt(code) {
      if (!/^\d+$/.test(code) || BigInt(code) < SNOWFLAKE_MIN) return null;
      return {
        createdAt: new Date(Number(BigInt(code) >> 22n) + TWITTER_EPOCH_MS).toISOString(),
        createdAtSource: 'derived from the post id (X snowflake)'
      };
    }
  },

  dataset: {
    reportedRepliesScope: 'direct',
    unavailableRepliesText: 'X reports that some replies are unavailable to the capturing account.'
  },

  report: {
    countLabels: () => [
      ['likes', 'Likes'], ['replies', 'Replies'], ['reposts', 'Reposts'],
      ['quotes', 'Quotes'], ['bookmarks', 'Bookmarks'], ['views', 'Views']
    ],
    homeHost: 'x.com'
  },

  mediaSourceDescription: 'Fetched from the X media CDN URL in the API data at capture time (credentials omitted)',

  constraints: [
    'Replies are ranked and paginated by X; hidden-reply sections are opened only when "Show hidden replies" is on (see replyLoading.hiddenReplyButtonsPressed).',
    'Signed out, X serves the post and a few top replies only; full replies require a signed-in session.'
  ]
};
