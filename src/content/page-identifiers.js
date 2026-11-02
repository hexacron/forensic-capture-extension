/**
 * Page metadata and platform identifiers for generic captures.
 *
 * Classic content script (injected into the extension's isolated world, no imports); it only
 * reads the DOM and the page URL and exposes window.__exhibitPageIdentifiers. Both functions
 * take the document and URL as arguments so tests can run them against saved pages.
 *
 * Every identifier records where it came from (`sources`): 'url' is read from the address
 * alone, 'dom' / 'embedded-json' / 'json-ld' from the page content. Values the page does not
 * show are left out, never filled with a placeholder.
 *
 * Covers Facebook, TikTok, Reddit, LinkedIn and VK. Threads, Instagram and X have their own
 * adapters (src/social/platforms/*) that capture far more than identifiers.
 */
(function() {
  'use strict';

  const VERSION = 1;

  /** True for the domain itself or any subdomain ('netflix.com' is not 'x.com'). */
  function hostIs(hostname, domain) {
    return hostname === domain || hostname.endsWith('.' + domain);
  }

  function attr(el, name) {
    const value = el ? el.getAttribute(name) : null;
    return value && value.trim() ? value.trim() : null;
  }

  function metaContent(doc, selector) {
    return attr(doc.querySelector(selector), 'content');
  }

  function parseUrl(url) {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  }

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  /** Standard document metadata. Absent values are null so the shape is stable. */
  function extractPageMetadata(doc) {
    return {
      description: metaContent(doc, 'meta[name="description"]'),
      keywords: metaContent(doc, 'meta[name="keywords"]'),
      canonicalUrl: attr(doc.querySelector('link[rel="canonical"]'), 'href'),
      language: attr(doc.documentElement, 'lang'),
      openGraph: {
        title: metaContent(doc, 'meta[property="og:title"]'),
        description: metaContent(doc, 'meta[property="og:description"]'),
        image: metaContent(doc, 'meta[property="og:image"]'),
        url: metaContent(doc, 'meta[property="og:url"]'),
        type: metaContent(doc, 'meta[property="og:type"]'),
        siteName: metaContent(doc, 'meta[property="og:site_name"]')
      }
    };
  }

  /** Collects fields with their provenance. */
  function collector(platform) {
    const result = { platform, fields: {}, sources: {}, notes: [] };
    result.set = (name, value, source) => {
      if (value === null || value === undefined || value === '') return;
      result.fields[name] = String(value);
      result.sources[name] = source;
    };
    return result;
  }

  function finish(result) {
    delete result.set;
    return Object.keys(result.fields).length > 0 || result.notes.length > 0 ? result : null;
  }

  // ---------------------------------------------------------------------------
  // Facebook: URL only. Facebook's page data may carry the viewing account's own id next to
  // post data, and its markup could not be verified without a signed-in session.
  // ---------------------------------------------------------------------------

  const FB_NUMERIC_ID = /^\d{5,}$/;
  const FB_PFBID = /^pfbid[A-Za-z0-9]+$/;

  function setFacebookPostRef(out, value, source) {
    if (!value) return;
    if (FB_NUMERIC_ID.test(value)) out.set('postId', value, source);
    else if (FB_PFBID.test(value)) out.set('postToken', value, source);
  }

  function facebook(url) {
    const out = collector('facebook');
    const parts = url.pathname.split('/').filter(Boolean);
    const q = url.searchParams;
    const [first, second, third] = parts;

    if (first === 'profile.php') {
      out.set('contentType', 'profile', 'url');
      out.set('profileId', q.get('id'), 'url');
      return finish(out);
    }
    if (first === 'permalink.php' || first === 'story.php') {
      out.set('contentType', 'post', 'url');
      setFacebookPostRef(out, q.get('story_fbid'), 'url');
      out.set('ownerId', q.get('id'), 'url');
      return finish(out);
    }
    if (first === 'photo' || first === 'photo.php') {
      out.set('contentType', 'photo', 'url');
      out.set('photoId', q.get('fbid'), 'url');
      return finish(out);
    }
    if (first === 'watch') {
      out.set('contentType', 'video', 'url');
      out.set('videoId', q.get('v'), 'url');
      return finish(out);
    }
    if (first === 'reel' && second) {
      out.set('contentType', 'reel', 'url');
      out.set('videoId', second, 'url');
      return finish(out);
    }
    if (first === 'share' && second && third) {
      // Opaque share link (/share/p/TOKEN/): not a post id, kept as the token it is.
      out.set('contentType', { p: 'post', v: 'video', r: 'reel' }[second] || 'share', 'url');
      out.set('shareToken', third, 'url');
      return finish(out);
    }
    if (first === 'groups' && second) {
      out.set('groupId', second, 'url');
      if ((third === 'posts' || third === 'permalink') && parts[3]) {
        out.set('contentType', 'post', 'url');
        setFacebookPostRef(out, parts[3], 'url');
      }
      return finish(out);
    }
    if (first && ['posts', 'videos'].includes(second) && third) {
      out.set('contentType', second === 'posts' ? 'post' : 'video', 'url');
      out.set('ownerHandle', first, 'url');
      if (second === 'posts') setFacebookPostRef(out, third, 'url');
      else out.set('videoId', third, 'url');
      return finish(out);
    }
    if (first && second === 'photos' && parts.length >= 4) {
      out.set('contentType', 'photo', 'url');
      out.set('ownerHandle', first, 'url');
      out.set('photoId', parts[parts.length - 1], 'url');
      return finish(out);
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // TikTok: URL, plus the page's own embedded data when it describes that same video.
  // ---------------------------------------------------------------------------

  function tiktok(url, doc) {
    const out = collector('tiktok');
    const match = url.pathname.match(/^\/@([^/]+)\/(video|photo)\/(\d+)/);
    if (!match) return null;
    const urlVideoId = match[3];
    out.set('videoId', urlVideoId, 'url');
    out.set('authorUsername', safeDecode(match[1]), 'url');

    const script = doc.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
    if (!script) return finish(out);
    let item;
    try {
      item = JSON.parse(script.textContent)?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
    } catch {
      out.notes.push('Embedded page data could not be parsed.');
      return finish(out);
    }
    if (!item) return finish(out);
    if (String(item.id) !== urlVideoId) {
      // TikTok navigates inside one document; the embedded data belongs to the first video loaded.
      out.notes.push(`Embedded page data describes video ${item.id}, not the video in the address; it was not used.`);
      return finish(out);
    }
    out.set('authorUsername', item.author?.uniqueId, 'embedded-json');
    out.set('authorId', item.author?.id, 'embedded-json');
    out.set('description', item.desc, 'embedded-json');
    out.set('downloadUrl', item.video?.downloadAddr, 'embedded-json');
    return finish(out);
  }

  // ---------------------------------------------------------------------------
  // Reddit: URL, plus the <shreddit-post> element for that post. A feed or listing page
  // holds many posts, so an element is used only when its id matches the address.
  // ---------------------------------------------------------------------------

  function reddit(url, doc) {
    const out = collector('reddit');
    const match = url.pathname.match(/^(?:\/(?:r|user|u)\/([^/]+))?\/comments\/([a-z0-9]+)/i);
    if (!match) return null;
    const postId = match[2];
    out.set('postId', postId, 'url');
    out.set('postFullname', `t3_${postId}`, 'url');
    if (/^\/r\//i.test(url.pathname)) out.set('subreddit', match[1], 'url');

    const post = [...doc.querySelectorAll('shreddit-post')].find(el => attr(el, 'id') === `t3_${postId}`);
    if (post) {
      out.set('subreddit', attr(post, 'subreddit-name'), 'dom');
      out.set('subredditId', attr(post, 'subreddit-id'), 'dom');
      out.set('author', attr(post, 'author'), 'dom');
      out.set('authorId', attr(post, 'author-id'), 'dom');
    }
    return finish(out);
  }

  // ---------------------------------------------------------------------------
  // LinkedIn: URN from the address (both URL forms); author and date from the page's
  // JSON-LD, which signed-out post pages carry.
  // ---------------------------------------------------------------------------

  function linkedinPostRef(url) {
    const path = safeDecode(url.pathname);
    let match = path.match(/urn:li:(activity|share|ugcPost):(\d+)/);
    if (match) return { type: match[1], id: match[2], handle: null };
    // /posts/<author-vanity>_<words>-activity-<id>-<code>
    match = path.match(/^\/posts\/([^/]*?)-(activity|share|ugcPost)-(\d+)(?:-[^/]*)?\/?$/);
    if (match) {
      const handle = match[1].includes('_') ? match[1].split('_')[0] : null;
      return { type: match[2], id: match[3], handle };
    }
    return null;
  }

  function jsonLdObjects(doc) {
    const objects = [];
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent);
        objects.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      } catch {
        // Not valid JSON: ignore this block.
      }
    }
    return objects;
  }

  function linkedin(url, doc) {
    const out = collector('linkedin');
    const ref = linkedinPostRef(url);
    if (!ref) return null;
    out.set('postUrn', `urn:li:${ref.type}:${ref.id}`, 'url');
    out.set('postId', ref.id, 'url');
    out.set('authorHandle', ref.handle, 'url');

    const post = jsonLdObjects(doc).find(o => {
      const id = typeof o?.['@id'] === 'string' ? o['@id'] : '';
      const link = typeof o?.url === 'string' ? o.url : '';
      return id.includes(ref.id) || link.includes(ref.id);
    });
    if (post) {
      // `creator` is the account that posted; `sharedContent.author` is whoever wrote a reshared original.
      const author = post.author || post.creator;
      out.set('authorName', author?.name, 'json-ld');
      out.set('authorUrl', author?.url, 'json-ld');
      out.set('datePublished', post.datePublished, 'json-ld');
    }
    return finish(out);
  }

  // ---------------------------------------------------------------------------
  // VK: wall post id from the address (vk.com redirects to vk.ru; both are handled).
  // ---------------------------------------------------------------------------

  function vk(url) {
    const out = collector('vk');
    const match = (url.searchParams.get('w') || '').match(/^wall(-?\d+)_(\d+)/) ||
      url.pathname.match(/^\/wall(-?\d+)_(\d+)/);
    if (!match) return null;
    out.set('postId', `${match[1]}_${match[2]}`, 'url');
    out.set('ownerId', match[1], 'url');
    out.set('ownerType', match[1].startsWith('-') ? 'community' : 'user', 'url');
    out.set('localPostId', match[2], 'url');
    return finish(out);
  }

  const SITES = [
    { domains: ['facebook.com', 'fb.com'], extract: facebook },
    { domains: ['tiktok.com'], extract: tiktok },
    { domains: ['reddit.com'], extract: reddit },
    { domains: ['linkedin.com'], extract: linkedin },
    { domains: ['vk.com', 'vk.ru'], extract: vk }
  ];

  /**
   * Identifiers for the page at `urlString`, or null when the site is not covered or the
   * address is not a post/video/profile the extractor understands.
   * @returns {{platform: string, fields: Object, sources: Object, notes: string[]}|null}
   */
  function extractPageIdentifiers(doc, urlString) {
    const url = parseUrl(urlString);
    if (!url) return null;
    const site = SITES.find(s => s.domains.some(d => hostIs(url.hostname, d)));
    if (!site) return null;
    try {
      return site.extract(url, doc);
    } catch (error) {
      return { platform: site.extract.name, fields: {}, sources: {}, notes: [`Extraction failed: ${error.message}`] };
    }
  }

  window.__exhibitPageIdentifiers = { version: VERSION, extractPageMetadata, extractPageIdentifiers };
})();
