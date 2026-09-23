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
  const TOOLKIT_VERSION = 8;

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
    clickedLabels: new Map(),
    targets: new Map(),
    nextTargetId: 1
  };

  // ---------------------------------------------------------------------------
  // Scrolling
  // ---------------------------------------------------------------------------

  function documentScroller() {
    return document.scrollingElement || document.documentElement;
  }

  /**
   * The element that actually scrolls the page content. On Threads this is the
   * nearest scrollable ancestor of the visible posts: signed in, the feed stays
   * mounted (hidden) and can make the document tall while the opened post scrolls
   * in its own layer. Otherwise the document, falling back to the largest
   * scrollable element for apps that lock the document (modal scroll-lock,
   * app-shell layouts).
   */
  function findScroller() {
    const doc = documentScroller();
    const anchor = visibleThreadsPost();
    if (anchor) {
      const target = wheelScrollTarget(anchor);
      if (target !== doc) return target;
    }
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

  /** First visible Threads post container on screen, if this is a Threads page. */
  function visibleThreadsPost() {
    for (const node of document.querySelectorAll(THREADS_POST_SELECTOR)) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
      if (isVisible(node)) return node;
    }
    return null;
  }

  /** The element a wheel event at this node would scroll (nearest scrollable ancestor). */
  function wheelScrollTarget(node) {
    for (let n = node; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (n.scrollHeight <= n.clientHeight + 2) continue;
      const overflowY = getComputedStyle(n).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return n;
    }
    return documentScroller();
  }

  /**
   * The current scroll container, re-detected when the remembered one no longer
   * scrolls (e.g. a modal switched the page into a scroll-locked layout and back),
   * or when it is the document (the thread may have rendered into its own layer
   * after the first detection).
   */
  function scroller() {
    const el = state.scroller;
    if (!el || el === documentScroller() || !el.isConnected || el.scrollHeight <= el.clientHeight + 2) {
      state.scroller = findScroller();
    }
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

  function endScreenshot(restoreScroll = true) {
    const restored = restoreFixedElements();
    const original = state.originalScroll;
    // A programmatic jump back is an automation signal; careful captures skip it.
    if (original && restoreScroll) {
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
      // Signed-in Threads keeps the feed mounted but hidden behind a post opened
      // in-app; its posts are not what the viewer sees and must not be harvested.
      if (!isVisible(container)) continue;
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

  /**
   * "Show more replies" style buttons currently inside the viewport, with their
   * viewport rectangles. Nothing is clicked here: the background worker clicks them
   * with trusted input (a scripted .click() arrives with isTrusted === false, which
   * sites can detect). Nodes are remembered by id for threadsMarkClicked.
   */
  function threadsExpanderTargets() {
    const heading = findRelatedHeading();
    const region = scrollRegion(scroller());
    const targets = [];
    state.targets = new Map();
    for (const node of document.querySelectorAll('[role="button"], button')) {
      if (state.clicked.has(node)) continue;
      if (node.closest('a[href]') || node.getAttribute('aria-disabled') === 'true' || node.disabled) continue;
      const label = node.textContent.trim();
      if (!label || label.length > 60) continue;
      if ((state.clickedLabels.get(label) || 0) >= MAX_CLICKS_PER_LABEL) continue;
      if (!THREADS_EXPANDER_RES.some(re => re.test(label))) continue;
      if (threadSectionOf(node, heading) === false) continue;
      if (!isVisible(node)) continue;
      const rect = node.getBoundingClientRect();
      // Fully inside the scroll region, so the pointer lands on the button itself.
      if (rect.top < region.top || rect.bottom > region.top + region.height) continue;
      const id = state.nextTargetId++;
      state.targets.set(id, node);
      targets.push({ id, label, rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } });
    }
    return targets;
  }

  /**
   * Safety check before a trusted click: is the element under (x, y) the expander
   * itself (or inside it), with no link in between? A trusted click acts as the
   * signed-in account, so anything else under the pointer must never be pressed.
   */
  function threadsVerifyTarget(id, x, y) {
    const node = state.targets.get(id);
    if (!node || !node.isConnected) return false;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === node || node.contains(hit))) return false;
    const link = hit.closest('a[href]');
    return !link || node.contains(link);
  }

  function threadsMarkClicked(id) {
    const node = state.targets.get(id);
    if (!node) return false;
    const label = node.textContent.trim();
    state.clicked.add(node);
    state.clickedLabels.set(label, (state.clickedLabels.get(label) || 0) + 1);
    return true;
  }

  function threadsLoading() {
    for (const node of document.querySelectorAll('[role="progressbar"], [aria-label^="Loading"], [aria-busy="true"]')) {
      if (isVisible(node)) return true;
    }
    return false;
  }

  function threadsLoadState() {
    const heading = findRelatedHeading();
    const el = scroller();
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      region: scrollRegion(el),
      scroller: describeNode(el),
      contentHeight: heading ? Math.round(absoluteY(heading)) : null,
      loading: threadsLoading(),
      renderedPosts: document.querySelectorAll(THREADS_POST_SELECTOR).length,
      focusIsEditable: Boolean(document.activeElement && document.activeElement.closest('input, textarea, select, [contenteditable="true"]'))
    };
  }

  /** Short description of a node for diagnostics (no page text). */
  function describeNode(node) {
    if (!node) return null;
    if (node === documentScroller()) return 'document';
    const role = node.getAttribute && node.getAttribute('role');
    const rect = node.getBoundingClientRect();
    return `${node.tagName.toLowerCase()}${role ? `[role=${role}]` : ''} ${Math.round(rect.width)}x${Math.round(rect.height)} ${getComputedStyle(node).position}`;
  }

  /**
   * A pointer position inside the scroll region where a wheel event actually scrolls
   * the capture's scroll container. An invisible layer or a nested scroller under the
   * pointer would otherwise swallow the wheel and the page would not move.
   * @returns {{x: number|null, y: number|null, hit: string|null}}
   */
  function scrollPointer() {
    const el = scroller();
    const region = scrollRegion(el);
    const xs = [0.5, 0.42, 0.58, 0.35, 0.65, 0.28, 0.72, 0.2, 0.8];
    const ys = [0.5, 0.4, 0.6, 0.3, 0.7, 0.22, 0.78];
    let firstHit = null;
    for (const fy of ys) {
      for (const fx of xs) {
        const x = Math.round(region.left + region.width * fx);
        const y = Math.round(region.top + region.height * fy);
        const hit = document.elementFromPoint(x, y);
        if (!hit) continue;
        if (firstHit === null) firstHit = describeNode(hit);
        if (hit.closest('video, iframe, input, textarea, select, [contenteditable="true"]')) continue;
        if (wheelScrollTarget(hit) === el) return { x, y, hit: describeNode(hit) };
      }
    }
    return { x: null, y: null, hit: firstHit };
  }

  /**
   * Height of the band at the top of the scroll region covered by fixed/sticky
   * headers. Read-only: lets the screenshot crop the header out of later frames
   * instead of restyling the site's elements (style changes are observable).
   */
  function measureTopInset() {
    const el = scroller();
    const region = scrollRegion(el);
    let inset = 0;
    for (const node of document.body.querySelectorAll('*')) {
      const pos = getComputedStyle(node).position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      if (node.contains(el)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || !isVisible(node)) continue;
      const pinnedToTop = rect.top <= region.top + 2 && rect.bottom > region.top;
      const header = rect.width >= region.width * 0.35 && rect.height <= region.height * 0.35;
      if (pinnedToTop && header) inset = Math.max(inset, rect.bottom - region.top);
    }
    return { topInset: Math.ceil(inset) };
  }

  function threadsVisibleDialogs() {
    return [...document.querySelectorAll('[role="dialog"]')].filter(isVisible).length;
  }

  /** Whether the post with this shortcode is rendered (the feed renders other posts too). */
  function threadsPostRendered(code) {
    for (const container of document.querySelectorAll(THREADS_POST_SELECTOR)) {
      if (!isVisible(container)) continue;
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
    threadsExpanderTargets,
    threadsMarkClicked,
    threadsVerifyTarget,
    measureTopInset,
    scrollPointer,
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
