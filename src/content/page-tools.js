/**
 * Page Tools - isolated-world toolkit injected via scripting.executeScript({ files }).
 *
 * The background worker drives long-running operations (scroll-and-stitch,
 * Threads reply loading) step by step. Each step is a short call into this
 * toolkit through `window.__forensicPageTools.call(name, args)`, which always
 * resolves to an envelope `{ ok, value }` / `{ ok: false, error }` so failures
 * survive the executeScript boundary.
 *
 * Standalone script: no ES module imports (executeScript cannot load modules).
 * State persists between calls because every injection from this extension
 * shares the same isolated world for the frame.
 */
(() => {
  'use strict';

  // Bumped whenever the toolkit API changes, so a stale copy left in a long-lived
  // page is replaced instead of failing with "unknown page tool".
  const TOOLKIT_VERSION = 4;

  if (window.__forensicPageTools && window.__forensicPageTools.version === TOOLKIT_VERSION) return;

  const THREADS_POST_SELECTOR = '[data-pressable-container]';
  const THREADS_PERMALINK_RE = /^\/@([^/]+)\/post\/([A-Za-z0-9_-]+)\/?$/;
  // Buttons that reveal additional replies. Matched against trimmed button text.
  const THREADS_EXPANDER_RES = [
    /^(show|view|see|load|read)\s+(\d[\d,.]*[km]?\s+)?(more|all|hidden|additional|other|previous|earlier|remaining)?\s*(repl(y|ies)|comments?|answers?)\b/i,
    /^(more|hidden|other)\s+repl(y|ies)$/i
  ];
  const THREADS_RELATED_HEADINGS = new Set(['related threads']);
  // Guard against React re-creating an expander node on every render.
  const MAX_CLICKS_PER_LABEL = 30;

  const state = {
    scroller: null,
    originalScroll: null,
    hiddenFixed: [],
    clicked: new WeakSet(),
    clickedLabels: new Map()
  };

  // ---------------------------------------------------------------------------
  // Scrolling
  // ---------------------------------------------------------------------------

  function documentScroller() {
    return document.scrollingElement || document.documentElement;
  }

  /**
   * The element that actually scrolls the page content. Usually the document;
   * falls back to the largest scrollable element for apps that lock the
   * document (modal scroll-lock, app-shell layouts).
   */
  function findScroller() {
    const doc = documentScroller();
    if (doc.scrollHeight > doc.clientHeight + 2) return doc;

    let best = null;
    let bestArea = 0;
    for (const el of document.body.querySelectorAll('*')) {
      if (el.scrollHeight <= el.clientHeight + 2) continue;
      const overflowY = getComputedStyle(el).overflowY;
      if (overflowY !== 'auto' && overflowY !== 'scroll' && overflowY !== 'overlay') continue;
      const area = el.clientWidth * el.clientHeight;
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best || doc;
  }

  /**
   * The current scroll container, re-detected when the remembered one no longer
   * scrolls (e.g. a modal switched the page into a scroll-locked layout and back).
   */
  function scroller() {
    const el = state.scroller;
    if (!el || !el.isConnected || el.scrollHeight <= el.clientHeight + 2) state.scroller = findScroller();
    return state.scroller;
  }

  /** Visible scroll region in viewport CSS pixels (excludes scrollbars). */
  function scrollRegion(el) {
    if (el === documentScroller()) {
      return { left: 0, top: 0, width: el.clientWidth, height: el.clientHeight };
    }
    const rect = el.getBoundingClientRect();
    return {
      left: Math.max(0, rect.left + el.clientLeft),
      top: Math.max(0, rect.top + el.clientTop),
      width: el.clientWidth,
      height: el.clientHeight
    };
  }

  function position() {
    const el = scroller();
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      region: scrollRegion(el)
    };
  }

  function scrollToY(y) {
    const el = scroller();
    el.scrollTo({ top: y, left: 0, behavior: 'instant' });
    return position();
  }

  /** Document-space Y of an element inside the active scroller. */
  function absoluteY(node) {
    const el = scroller();
    const top = node.getBoundingClientRect().top;
    if (el === documentScroller()) return top + el.scrollTop;
    return top - el.getBoundingClientRect().top + el.scrollTop;
  }

  // ---------------------------------------------------------------------------
  // Screenshot support
  // ---------------------------------------------------------------------------

  function beginScreenshot() {
    state.scroller = findScroller();
    const el = state.scroller;
    state.originalScroll = { top: el.scrollTop, left: el.scrollLeft };
    return {
      scrollerIsDocument: el === documentScroller(),
      scrollerTag: el.tagName,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      devicePixelRatio: window.devicePixelRatio,
      originalScroll: state.originalScroll,
      ...position()
    };
  }

  /**
   * Hide fixed/sticky overlays (headers, nav rails, floating buttons) so they
   * are captured once in the first frame instead of repeating in every frame.
   * Full-viewport wrappers and ancestors of the scroller are layout, not
   * overlays, and stay visible.
   */
  function hideFixedElements() {
    const el = scroller();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let count = 0;
    for (const node of document.body.querySelectorAll('*')) {
      const pos = getComputedStyle(node).position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      if (node.contains(el)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.width >= vw * 0.9 && rect.height >= vh * 0.9) continue;
      state.hiddenFixed.push({
        node,
        value: node.style.getPropertyValue('visibility'),
        priority: node.style.getPropertyPriority('visibility')
      });
      node.style.setProperty('visibility', 'hidden', 'important');
      count++;
    }
    return { hidden: count };
  }

  /**
   * Hide open modal dialogs (login prompts, nags) together with their full-screen
   * dimming layer. Called before every frame because sites re-open them on scroll.
   * An overlay that contains the scroll container or any post is never hidden, so a
   * post shown as a modal stays in the evidence.
   * @returns {{hidden: number}} overlays newly hidden by this call
   */
  function hideModalOverlays() {
    const el = scroller();
    const protectedContent = node => node.contains(el) || node.querySelector(THREADS_POST_SELECTOR);
    let hidden = 0;
    for (const dialog of document.querySelectorAll('[aria-modal="true"], [role="dialog"], [role="alertdialog"]')) {
      if (!isVisible(dialog) || protectedContent(dialog)) continue;
      // Climb to the outermost wrapper (the dimming layer) that holds nothing we capture.
      let overlay = dialog;
      while (overlay.parentElement && overlay.parentElement !== document.body && !protectedContent(overlay.parentElement)) {
        overlay = overlay.parentElement;
      }
      if (overlay.style.getPropertyValue('visibility') === 'hidden') continue;
      state.hiddenFixed.push({
        node: overlay,
        value: overlay.style.getPropertyValue('visibility'),
        priority: overlay.style.getPropertyPriority('visibility')
      });
      overlay.style.setProperty('visibility', 'hidden', 'important');
      hidden++;
    }
    return { hidden };
  }

  function restoreFixedElements() {
    for (const { node, value, priority } of state.hiddenFixed) {
      if (value) node.style.setProperty('visibility', value, priority);
      else node.style.removeProperty('visibility');
    }
    const restored = state.hiddenFixed.length;
    state.hiddenFixed = [];
    return { restored };
  }

  function endScreenshot() {
    const restored = restoreFixedElements();
    const original = state.originalScroll;
    if (original) {
      scroller().scrollTo({ top: original.top, left: original.left, behavior: 'instant' });
    }
    state.originalScroll = null;
    return { ...restored, originalScroll: original };
  }

  // ---------------------------------------------------------------------------
  // Threads (threads.com / threads.net)
  // ---------------------------------------------------------------------------

  function isVisible(node) {
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(node);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function findRelatedHeading() {
    for (const node of document.querySelectorAll('span, h1, h2, h3, div[role="heading"]')) {
      if (node.childElementCount > 0) continue;
      if (!THREADS_RELATED_HEADINGS.has(node.textContent.trim().toLowerCase())) continue;
      // Stale copies can linger in hidden layers of the single-page app.
      if (isVisible(node)) return node;
    }
    return null;
  }

  /** true = before "Related threads", false = after it, null = unknown (heading not rendered). */
  function threadSectionOf(node, heading) {
    if (!heading) return null;
    return Boolean(heading.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING);
  }

  function permalinkOf(container) {
    const time = container.querySelector('time[datetime]');
    const candidates = [];
    const timeLink = time && time.closest('a[href]');
    if (timeLink) candidates.push(timeLink);
    candidates.push(...container.querySelectorAll('a[href*="/post/"]'));
    for (const link of candidates) {
      let path;
      try {
        path = new URL(link.getAttribute('href'), location.origin).pathname;
      } catch {
        continue;
      }
      const match = THREADS_PERMALINK_RE.exec(path);
      if (match) {
        return { url: location.origin + path, author: decodeURIComponent(match[1]), code: match[2], time };
      }
    }
    return null;
  }

  /**
   * Harvest currently rendered Threads posts. Threads virtualizes its lists
   * (off-screen posts are removed from the DOM), so this runs repeatedly while
   * scrolling. Full records are returned only for codes not in `knownCodes`;
   * `sections` reports thread-section membership for every rendered post.
   */
  function threadsHarvest(knownCodes) {
    const known = new Set(knownCodes || []);
    const heading = findRelatedHeading();
    const posts = [];
    const sections = {};

    for (const container of document.querySelectorAll(THREADS_POST_SELECTOR)) {
      const link = permalinkOf(container);
      if (!link) continue;

      const parent = container.parentElement && container.parentElement.closest(THREADS_POST_SELECTOR);
      const parentLink = parent ? permalinkOf(parent) : null;
      const inThreadSection = threadSectionOf(container, heading);
      sections[link.code] = inThreadSection;
      if (known.has(link.code)) continue;
      known.add(link.code);

      const rect = container.getBoundingClientRect();
      posts.push({
        code: link.code,
        author: link.author,
        permalink: link.url,
        datetime: link.time ? link.time.getAttribute('datetime') : null,
        datetimeTitle: link.time ? link.time.getAttribute('title') : null,
        datetimeLabel: link.time ? link.time.textContent.trim() : null,
        renderedText: container.innerText,
        images: [...container.querySelectorAll('img')].map(img => ({
          src: img.currentSrc || img.src,
          alt: img.getAttribute('alt') || ''
        })),
        videos: [...container.querySelectorAll('video')].map(video => ({
          src: video.currentSrc || video.src || null,
          poster: video.getAttribute('poster') || null
        })),
        outboundLinks: [...container.querySelectorAll('a[href]')]
          .map(a => a.href)
          .filter(href => !href.startsWith(location.origin)),
        documentY: Math.round(absoluteY(container)),
        height: Math.round(rect.height),
        inThreadSection,
        nestedInCode: parentLink ? parentLink.code : null,
        html: container.outerHTML
      });
    }

    return { posts, sections, relatedHeadingRendered: Boolean(heading), url: location.href };
  }

  function threadsExpandReplies() {
    const heading = findRelatedHeading();
    const clicked = [];
    for (const node of document.querySelectorAll('[role="button"], button')) {
      if (state.clicked.has(node)) continue;
      if ((state.clickedLabels.get(node.textContent.trim()) || 0) >= MAX_CLICKS_PER_LABEL) continue;
      if (node.closest('a[href]') || node.getAttribute('aria-disabled') === 'true' || node.disabled) continue;
      const label = node.textContent.trim();
      if (!label || label.length > 60) continue;
      if (!THREADS_EXPANDER_RES.some(re => re.test(label))) continue;
      if (threadSectionOf(node, heading) === false) continue;
      if (!isVisible(node)) continue;
      state.clicked.add(node);
      state.clickedLabels.set(label, (state.clickedLabels.get(label) || 0) + 1);
      node.click();
      clicked.push(label);
    }
    return clicked;
  }

  function threadsLoading() {
    for (const node of document.querySelectorAll('[role="progressbar"], [aria-label^="Loading"], [aria-busy="true"]')) {
      if (isVisible(node)) return true;
    }
    return false;
  }

  /**
   * One reply-loading round: reveal collapsed replies, then scroll to the end of
   * the thread's own content. Stopping at the "Related threads" marker keeps the
   * endless recommendation feed from being loaded.
   */
  function threadsLoadStep() {
    const clicked = threadsExpandReplies();
    const el = scroller();
    const heading = findRelatedHeading();
    const target = heading ? Math.round(absoluteY(heading)) : el.scrollHeight;
    el.scrollTo({ top: target, left: 0, behavior: 'instant' });
    return { clicked, scrollHeight: el.scrollHeight, scrolledTo: target };
  }

  function threadsLoadState() {
    const heading = findRelatedHeading();
    return {
      scrollHeight: scroller().scrollHeight,
      contentHeight: heading ? Math.round(absoluteY(heading)) : null,
      loading: threadsLoading(),
      renderedPosts: document.querySelectorAll(THREADS_POST_SELECTOR).length
    };
  }

  function threadsVisibleDialogs() {
    return [...document.querySelectorAll('[role="dialog"]')].filter(isVisible).length;
  }

  /** Whether the post with this shortcode is rendered (the feed renders other posts too). */
  function threadsPostRendered(code) {
    for (const container of document.querySelectorAll(THREADS_POST_SELECTOR)) {
      const link = permalinkOf(container);
      if (link && link.code === code) return true;
    }
    return false;
  }

  /**
   * Where the thread's own content ends: the top of the "Related threads"
   * section, which is followed by an endless recommendation feed.
   * @returns {{contentHeight: number|null, scrollHeight: number}}
   */
  function threadsContentHeight() {
    const heading = findRelatedHeading();
    const el = scroller();
    return {
      contentHeight: heading ? Math.round(absoluteY(heading)) : null,
      scrollHeight: el.scrollHeight
    };
  }

  /** Server-embedded JSON payloads (Relay preloaded queries) that carry post data. */
  function threadsEmbeddedJson() {
    return [...document.querySelectorAll('script[type="application/json"][data-sjs]')]
      .map((script, index) => ({ index, text: script.textContent }))
      .filter(entry => entry.text.includes('"taken_at"'));
  }

  // ---------------------------------------------------------------------------
  // Dispatcher
  // ---------------------------------------------------------------------------

  const tools = {
    position,
    scrollToY,
    beginScreenshot,
    hideFixedElements,
    hideModalOverlays,
    restoreFixedElements,
    endScreenshot,
    threadsHarvest,
    threadsLoadStep,
    threadsLoadState,
    threadsContentHeight,
    threadsVisibleDialogs,
    threadsPostRendered,
    threadsEmbeddedJson
  };

  window.__forensicPageTools = {
    version: TOOLKIT_VERSION,
    async call(name, args) {
      try {
        if (!Object.prototype.hasOwnProperty.call(tools, name)) {
          throw new Error(`Unknown page tool: ${name}`);
        }
        return { ok: true, value: await tools[name](...(args || [])) };
      } catch (error) {
        return { ok: false, error: error && error.message ? error.message : String(error) };
      }
    }
  };
})();
