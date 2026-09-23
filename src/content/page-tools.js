/**
 * Page Tools - isolated-world toolkit injected via scripting.executeScript({ files }).
 *
 * The background worker drives long-running operations (scroll-and-stitch,
 * social post reply loading) step by step. Each step is a short call into this
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
  const TOOLKIT_VERSION = 9;

  if (window.__forensicPageTools && window.__forensicPageTools.version === TOOLKIT_VERSION) return;

  // Guard against React re-creating an expander node on every render.
  const MAX_CLICKS_PER_LABEL = 30;
  // An inner scroll container must show at least this much of itself to be used.
  const MIN_SCROLL_REGION_PX = 120;

  const state = {
    scroller: null,
    originalScroll: null,
    hiddenFixed: [],
    clicked: new WeakSet(),
    clickedLabels: new Map(),
    targets: new Map(),
    nextTargetId: 1,
    // Scroll container fixed for the duration of a screenshot (see scroller()).
    screenshotScroller: null,
    // Compiled platform config (configurePlatform); null on generic pages.
    platform: null
  };

  // ---------------------------------------------------------------------------
  // Scrolling
  // ---------------------------------------------------------------------------

  function documentScroller() {
    return document.scrollingElement || document.documentElement;
  }

  /**
   * The element that actually scrolls the page content. On social post pages this
   * is the nearest scrollable ancestor of the visible posts: signed-in Threads keeps
   * the feed mounted (hidden) and can make the document tall while the opened post
   * scrolls in its own layer, and Instagram scrolls comments in an inner column.
   * Otherwise the document, falling back to the largest
   * scrollable element for apps that lock the document (modal scroll-lock,
   * app-shell layouts).
   */
  function findScroller() {
    const doc = documentScroller();
    const anchor = visiblePostAnchor();
    if (anchor) {
      const target = wheelScrollTarget(anchor);
      // A container scrolled out of (or not yet into) view cannot be scrolled; the
      // document is then scrolled until it shows (see scroller()).
      if (target !== doc && visibleHeight(target) >= MIN_SCROLL_REGION_PX) return target;
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

  /**
   * First visible post (containers mode) or comment permalink (anchors mode) on
   * screen; null on generic pages. In anchors mode a visible permalink outside the
   * viewport also counts: a comment column can show the caption while every comment
   * link sits below its visible area (or below the fold), and the column is still
   * the container that scrolls the comments.
   */
  function visiblePostAnchor() {
    const p = state.platform;
    if (!p) return null;
    const anchors = p.harvest === 'anchors';
    const nodes = anchors
      ? [...document.querySelectorAll('a[href]')].filter(a => isPermalinkPath(pathOf(a)))
      : document.querySelectorAll(p.postSelector);
    let offscreen = null;
    for (const node of nodes) {
      if (!isVisible(node)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.bottom > 0 && rect.top < window.innerHeight) return node;
      if (anchors && !offscreen) offscreen = node;
    }
    return offscreen;
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
   * after the first detection). Between beginScreenshot and endScreenshot it stays
   * fixed: the stitcher's geometry is planned for one container, and re-detection
   * mid-capture (e.g. Instagram's comment column scrolling into view) would mix two.
   */
  function scroller() {
    const locked = state.screenshotScroller;
    if (locked && locked.isConnected) return locked;
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

  /** CSS pixels of an element's height that are inside the viewport. */
  function visibleHeight(el) {
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
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

  /** Document-space Y of an element inside a scroll container (default: the active scroller). */
  function absoluteY(node, el = scroller()) {
    const top = node.getBoundingClientRect().top;
    if (el === documentScroller()) return top + el.scrollTop;
    return top - el.getBoundingClientRect().top + el.scrollTop;
  }

  // ---------------------------------------------------------------------------
  // Screenshot support
  // ---------------------------------------------------------------------------

  /**
   * Fix the scroll container for the screenshot. Frames can only show what is on
   * screen, so a container shorter than the viewport but cut off by its edge (e.g. a
   * comment column partly below the fold) would lose rows: the document is stitched
   * then. Containers as tall as the viewport (Threads' post layer) are kept.
   */
  function beginScreenshot() {
    let el = findScroller();
    const doc = documentScroller();
    const height = el.getBoundingClientRect().height;
    const cutOff = el !== doc && height < window.innerHeight && visibleHeight(el) < height - 1;
    if (cutOff && doc.scrollHeight > doc.clientHeight + 2) el = doc;
    state.scroller = el;
    state.screenshotScroller = el;
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
   * An overlay that contains the scroll container, any post or a link to the target
   * post is never hidden, so a post shown as a modal stays in the evidence.
   * @returns {{hidden: number}} overlays newly hidden by this call
   */
  function hideModalOverlays() {
    const el = scroller();
    const protectedContent = node => isProtected(node, el);
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
    state.screenshotScroller = null;
    return { ...restored, originalScroll: original };
  }

  // ---------------------------------------------------------------------------
  // Social platforms (Threads, Instagram, X): configured by configurePlatform
  // ---------------------------------------------------------------------------

  // Path segments that are site sections, never account names.
  const NON_AUTHOR_PATHS = new Set(['p', 'reel', 'reels', 'explore', 'accounts', 'stories', 'direct']);
  const MAX_CLIMB = 15;

  /**
   * Compile the platform's DOM config (plain JSON: patterns arrive as strings because
   * executeScript cannot pass RegExp objects) and remember the captured post's code.
   */
  function configurePlatform(config, targetCode) {
    state.platform = {
      harvest: config.harvest,
      postSelector: config.postSelector || null,
      permalinkRe: new RegExp(config.permalink.pattern),
      authorGroup: config.permalink.authorGroup ?? null,
      codeGroup: config.permalink.codeGroup,
      postGroup: config.permalink.postGroup ?? null,
      authorLinkRe: config.authorLink ? new RegExp(config.authorLink) : null,
      expanderRes: config.expanders.map(p => new RegExp(p, 'i')),
      hiddenExpanderRes: config.hiddenExpanders.map(p => new RegExp(p, 'i')),
      relatedRes: config.relatedHeadings.map(p => new RegExp(p, 'i')),
      embeddedJson: config.embeddedJson,
      rootRendered: config.rootRendered,
      targetCode: String(targetCode)
    };
    state.scroller = null; // re-detect with the platform's post anchor
    return true;
  }

  function platform() {
    if (!state.platform) throw new Error('Platform not configured');
    return state.platform;
  }

  function isVisible(node) {
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(node);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function pathOf(link) {
    try {
      return new URL(link.getAttribute('href'), location.origin).pathname;
    } catch {
      return null;
    }
  }

  function isPermalinkPath(path) {
    return Boolean(path && state.platform && state.platform.permalinkRe.test(path));
  }

  /**
   * Content the capture needs: the scroll container, a post (containers mode) or a
   * link to the captured post. Dialogs holding any of these are never dismissed.
   */
  function isProtected(node, el = scroller()) {
    if (node.contains(el)) return true;
    const p = state.platform;
    if (!p) return false;
    if (p.harvest === 'containers' && node.querySelector(p.postSelector)) return true;
    for (const link of node.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href') || '';
      if (href.includes(`/${p.targetCode}/`) || href.endsWith(`/${p.targetCode}`)) return true;
    }
    return false;
  }

  /**
   * The heading where the post's own content ends ("Related threads", "Discover
   * more", ...). Only a heading inside the scroll container counts: a heading below
   * an inner comments column does not bound that column.
   */
  function findRelatedHeading() {
    const p = state.platform;
    if (!p || p.relatedRes.length === 0) return null;
    const el = scroller();
    const inDocument = el === documentScroller();
    for (const node of document.querySelectorAll('span, h1, h2, h3, div[role="heading"]')) {
      if (node.childElementCount > 0) continue;
      const text = node.textContent.trim();
      if (!text || text.length > 80 || !p.relatedRes.some(re => re.test(text))) continue;
      if (!inDocument && !el.contains(node)) continue;
      // Stale copies can linger in hidden layers of the single-page app.
      if (isVisible(node)) return node;
    }
    return null;
  }

  /** true = before the related heading, false = after it, null = unknown (heading not rendered). */
  function threadSectionOf(node, heading) {
    if (!heading) return null;
    return Boolean(heading.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING);
  }

  /** Containers mode: the post's own permalink (the time link first, then any link). */
  function postPermalink(container) {
    const p = state.platform;
    const time = container.querySelector('time[datetime]');
    const candidates = [];
    const timeLink = time && time.closest('a[href]');
    if (timeLink) candidates.push(timeLink);
    candidates.push(...container.querySelectorAll('a[href]'));
    for (const link of candidates) {
      const path = pathOf(link);
      const match = path && p.permalinkRe.exec(path);
      if (match) {
        return {
          url: location.origin + path,
          author: p.authorGroup ? decodeURIComponent(match[p.authorGroup]) : null,
          code: match[p.codeGroup],
          time
        };
      }
    }
    return null;
  }

  /** Number of distinct permalinks under a node, counting at most `limit + 1`. */
  function countPermalinks(node, limit) {
    const seen = new Set();
    for (const link of node.querySelectorAll('a[href]')) {
      const path = pathOf(link);
      if (!isPermalinkPath(path)) continue;
      seen.add(path.replace(/\/$/, ''));
      if (seen.size > limit) break;
    }
    return seen.size;
  }

  /** Anchors mode: a comment's block is its outermost ancestor holding only its own permalink. */
  function anchorBlock(anchor) {
    let node = anchor;
    for (let i = 0; i < MAX_CLIMB && node.parentElement && node.parentElement !== document.body; i++) {
      if (countPermalinks(node.parentElement, 1) > 1) break;
      node = node.parentElement;
    }
    return node;
  }

  /** Anchors mode: the post's own block climbs from its time element up to the comments. */
  function rootBlock(time) {
    let node = time;
    for (let i = 0; i < MAX_CLIMB && node.parentElement && node.parentElement !== document.body; i++) {
      if (countPermalinks(node.parentElement, 0) > 0) break;
      node = node.parentElement;
    }
    return node;
  }

  /** Anchors mode: the first same-site profile link in a block. */
  function authorOf(container) {
    const p = state.platform;
    if (!p.authorLinkRe) return null;
    for (const link of container.querySelectorAll('a[href]')) {
      let url;
      try {
        url = new URL(link.getAttribute('href'), location.origin);
      } catch {
        continue;
      }
      if (url.origin !== location.origin) continue;
      const match = p.authorLinkRe.exec(url.pathname);
      if (match && !NON_AUTHOR_PATHS.has(match[1].toLowerCase())) return decodeURIComponent(match[1]);
    }
    return null;
  }

  /** Anchors mode: the post's own visible time element (not a comment's). */
  function rootTimeElement() {
    for (const time of document.querySelectorAll('time[datetime]')) {
      const link = time.closest('a[href]');
      if (link && isPermalinkPath(pathOf(link))) continue;
      if (isVisible(time)) return time;
    }
    return null;
  }

  function domRecord(container, { code, author, url, time, inThreadSection, nestedInCode }) {
    const rect = container.getBoundingClientRect();
    return {
      code,
      author,
      permalink: url,
      datetime: time ? time.getAttribute('datetime') : null,
      datetimeTitle: time ? time.getAttribute('title') : null,
      datetimeLabel: time ? time.textContent.trim() : null,
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
      // Measured in the post's own scroll container, so records harvested while the
      // active scroller changes (document -> comment column) share one coordinate space.
      documentY: Math.round(absoluteY(container, wheelScrollTarget(container))),
      height: Math.round(rect.height),
      inThreadSection,
      nestedInCode,
      html: container.outerHTML
    };
  }

  /**
   * Harvest currently rendered posts. Social sites virtualize their lists
   * (off-screen posts are removed from the DOM), so this runs repeatedly while
   * scrolling. Full records are returned only for codes not in `knownCodes`;
   * `sections` reports thread-section membership for every rendered post.
   */
  function harvestPosts(knownCodes) {
    const p = platform();
    const known = new Set(knownCodes || []);
    const heading = findRelatedHeading();
    const posts = [];
    const sections = {};

    if (p.harvest === 'containers') {
      for (const container of document.querySelectorAll(p.postSelector)) {
        // Signed-in Threads keeps the feed mounted but hidden behind a post opened
        // in-app; its posts are not what the viewer sees and must not be harvested.
        if (!isVisible(container)) continue;
        const link = postPermalink(container);
        if (!link) continue;

        const parent = container.parentElement && container.parentElement.closest(p.postSelector);
        const parentLink = parent ? postPermalink(parent) : null;
        const inThreadSection = threadSectionOf(container, heading);
        sections[link.code] = inThreadSection;
        if (known.has(link.code)) continue;
        known.add(link.code);
        posts.push(domRecord(container, {
          code: link.code,
          author: link.author,
          url: link.url,
          time: link.time,
          inThreadSection,
          nestedInCode: parentLink ? parentLink.code : null
        }));
      }
    } else {
      const seen = new Set();
      for (const anchor of document.querySelectorAll('a[href]')) {
        const path = pathOf(anchor);
        const match = path && p.permalinkRe.exec(path);
        if (!match || match[p.postGroup] !== p.targetCode) continue;
        const code = match[p.codeGroup];
        if (seen.has(code) || !isVisible(anchor)) continue;
        seen.add(code);
        const container = anchorBlock(anchor);
        const inThreadSection = threadSectionOf(container, heading);
        sections[code] = inThreadSection;
        if (known.has(code)) continue;
        known.add(code);
        posts.push(domRecord(container, {
          code,
          author: authorOf(container),
          url: location.origin + path,
          time: anchor.querySelector('time[datetime]'),
          inThreadSection,
          nestedInCode: null
        }));
      }

      const time = rootTimeElement();
      if (time) {
        const container = rootBlock(time);
        const inThreadSection = threadSectionOf(container, heading);
        sections[p.targetCode] = inThreadSection;
        if (!known.has(p.targetCode)) {
          posts.push(domRecord(container, {
            code: p.targetCode,
            author: authorOf(container),
            url: location.origin + location.pathname,
            time,
            inThreadSection,
            nestedInCode: null
          }));
        }
      }
    }

    return { posts, sections, relatedHeadingRendered: Boolean(heading), url: location.href };
  }

  /** Visible label of a button: its text, else its aria-label (icon-only buttons). */
  function buttonLabel(node) {
    return (node.textContent.trim() || node.getAttribute('aria-label') || '').trim();
  }

  /**
   * "Show more replies" style buttons currently inside the viewport, with their
   * viewport rectangles. Nothing is clicked here: the background worker clicks them
   * with trusted input (a scripted .click() arrives with isTrusted === false, which
   * sites can detect). Nodes are remembered by id for markClicked.
   * Buttons that reveal replies the platform hides (spam, offensive) are included
   * only when `revealHidden` is true; otherwise they are just counted.
   * @returns {{targets: Array, hiddenNotRevealed: number}}
   */
  function expanderTargets(revealHidden) {
    const p = platform();
    const heading = findRelatedHeading();
    const region = scrollRegion(scroller());
    const targets = [];
    let hiddenNotRevealed = 0;
    state.targets = new Map();
    for (const node of document.querySelectorAll('[role="button"], button')) {
      if (state.clicked.has(node)) continue;
      if (node.closest('a[href]') || node.getAttribute('aria-disabled') === 'true' || node.disabled) continue;
      const label = buttonLabel(node);
      if (!label || label.length > 60) continue;
      if ((state.clickedLabels.get(label) || 0) >= MAX_CLICKS_PER_LABEL) continue;
      const hidden = p.hiddenExpanderRes.some(re => re.test(label));
      if (!hidden && !p.expanderRes.some(re => re.test(label))) continue;
      if (threadSectionOf(node, heading) === false) continue;
      if (!isVisible(node)) continue;
      if (hidden && revealHidden !== true) {
        hiddenNotRevealed++;
        continue;
      }
      const rect = node.getBoundingClientRect();
      // Fully inside the scroll region, so the pointer lands on the button itself.
      if (rect.top < region.top || rect.bottom > region.top + region.height) continue;
      const id = state.nextTargetId++;
      state.targets.set(id, node);
      const target = { id, label, rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } };
      if (hidden) target.hidden = true;
      targets.push(target);
    }
    return { targets, hiddenNotRevealed };
  }

  /**
   * Safety check before a trusted click: is the element under (x, y) the expander
   * itself (or inside it), with no link in between? A trusted click acts as the
   * signed-in account, so anything else under the pointer must never be pressed.
   */
  function verifyTarget(id, x, y) {
    const node = state.targets.get(id);
    if (!node || !node.isConnected) return false;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === node || node.contains(hit))) return false;
    const link = hit.closest('a[href]');
    return !link || node.contains(link);
  }

  function markClicked(id) {
    const node = state.targets.get(id);
    if (!node) return false;
    const label = buttonLabel(node);
    state.clicked.add(node);
    state.clickedLabels.set(label, (state.clickedLabels.get(label) || 0) + 1);
    return true;
  }

  function pageLoading() {
    for (const node of document.querySelectorAll('[role="progressbar"], [aria-label^="Loading"], [aria-busy="true"]')) {
      if (isVisible(node)) return true;
    }
    return false;
  }

  function renderedPostCount(p) {
    if (p.harvest === 'containers') return document.querySelectorAll(p.postSelector).length;
    const codes = new Set();
    for (const anchor of document.querySelectorAll('a[href]')) {
      const path = pathOf(anchor);
      const match = path && p.permalinkRe.exec(path);
      if (match) codes.add(match[p.codeGroup]);
    }
    return codes.size;
  }

  function loadState() {
    const p = platform();
    const heading = findRelatedHeading();
    const el = scroller();
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      region: scrollRegion(el),
      scroller: describeNode(el),
      contentHeight: heading ? Math.round(absoluteY(heading)) : null,
      loading: pageLoading(),
      renderedPosts: renderedPostCount(p),
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

  /** Visible dialogs that block the page (a dialog showing the post itself does not). */
  function blockingDialogs() {
    platform();
    return [...document.querySelectorAll('[role="dialog"]')].filter(d => isVisible(d) && !isProtected(d)).length;
  }

  /** Whether the post with this code is rendered (the feed renders other posts too). */
  function postRendered(code) {
    const p = platform();
    if (p.rootRendered === 'location') {
      if (!`${location.pathname}/`.includes(`/${code}/`)) return false;
      return [...document.querySelectorAll('main time[datetime], [role="dialog"] time[datetime]')].some(isVisible);
    }
    for (const container of document.querySelectorAll(p.postSelector)) {
      if (!isVisible(container)) continue;
      const link = postPermalink(container);
      if (link && link.code === code) return true;
    }
    return false;
  }

  /**
   * Where the post's own content ends: the top of the related section (e.g.
   * "Related threads"), which is followed by an endless recommendation feed.
   * @returns {{contentHeight: number|null, scrollHeight: number}}
   */
  function contentHeight() {
    platform();
    const heading = findRelatedHeading();
    const el = scroller();
    return {
      contentHeight: heading ? Math.round(absoluteY(heading)) : null,
      scrollHeight: el.scrollHeight
    };
  }

  /** Server-embedded JSON payloads (e.g. Relay preloaded queries) that carry post data. */
  function embeddedJson() {
    const config = platform().embeddedJson;
    if (!config) return [];
    return [...document.querySelectorAll(config.selector)]
      .map((script, index) => ({ index, text: script.textContent }))
      .filter(entry => entry.text.includes(config.marker));
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
    configurePlatform,
    harvestPosts,
    expanderTargets,
    markClicked,
    verifyTarget,
    measureTopInset,
    scrollPointer,
    loadState,
    contentHeight,
    blockingDialogs,
    postRendered,
    embeddedJson
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
