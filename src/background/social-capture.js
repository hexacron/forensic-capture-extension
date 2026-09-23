/**
 * Social post capture session (Threads, Instagram, X): one session drives any
 * platform adapter from src/social/platforms/.
 *
 * Lifecycle (driven by CaptureManager):
 *   prepare()        attach CDP + network recorder, optional reload, dismiss dialogs
 *   loadAllReplies() scroll/expand until the reply list stops growing
 *   harvestVisible() called for every screenshot frame (virtualized list)
 *   finalize()       parse embedded + network API data, merge with DOM, fetch media
 *   dispose()        detach CDP (always)
 */

import '../../lib/browser-polyfill.min.js';
import { CdpSession } from './cdp-session.js';
import { ensurePageTools, callPageTool } from './page-tools-client.js';
import { Action, Actor } from '../utils/logger.js';
import { base64ToBytes } from '../utils/encoding-utils.js';
import { HumanInput, PACING_PROFILES, randomBetween } from './human-input.js';
import {
  createApiStore,
  collectApiPosts,
  parseJsonDocuments,
  buildThreadDataset
} from '../social/engine.js';

export const DEFAULT_SOCIAL_OPTIONS = {
  loadAllReplies: true,
  reloadBeforeCapture: true,
  downloadMedia: true,
  carefulPacing: true,
  revealHiddenReplies: true
};

const LOAD_STABLE_ROUNDS = 3;
const LOAD_MAX_SPINNER_WAITS = 5;
const LOAD_MAX_ROUNDS = 1500;
const NETWORK_IDLE_TIMEOUT_MS = 8000;
const RELOAD_TIMEOUT_MS = 45000;
const MAX_ESCAPE_PRESSES = 6;
// Scroll steps that did not move the page before reply loading gives up (or, when no
// account is signed in, falls back to programmatic scrolling).
const MAX_STUCK_SCROLLS = 3;
const OFF_TARGET_GRACE_MS = 3000;
// Posts carry ~12-60KB of markup each; cap what we retain as evidence so a huge
// thread cannot exhaust worker memory or produce an undownloadable JSON file.
const POST_HTML_BUDGET_BYTES = 24 * 1024 * 1024;
const POSTS_APPEAR_TIMEOUT_MS = 20000;
const MEDIA_MAX_BYTES = 150 * 1024 * 1024;
const MEDIA_CONCURRENCY = 4;

const MEDIA_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm'
};

export class SocialCaptureSession {
  /**
   * @param {Object} params
   * @param {Object} params.tab - The user's tab showing the post
   * @param {Object} params.platform - Platform adapter (src/social/platforms/*)
   * @param {{code: string, canonicalUrl: string}} params.target - platform.parsePostUrl() result
   * @param {Object} params.logger
   * @param {Object} params.options - DEFAULT_SOCIAL_OPTIONS overrides
   * @param {Function} params.isCancelled
   * @param {Function} params.progress - (percent, detail)
   */
  constructor({ tab, platform, target, logger, options, isCancelled, progress }) {
    this.sourceTab = tab;
    // The tab being captured. Becomes a separate tab when the post is loaded fresh;
    // callers must read `tab` after prepare().
    this.tab = tab;
    this.tabId = tab.id;
    this.createdTabId = null;
    this.platform = platform;
    this.target = target;
    this.logger = logger;
    this.options = { ...DEFAULT_SOCIAL_OPTIONS, ...options };
    this.isCancelled = isCancelled;
    this.progress = progress;
    this.cdp = null;
    this.cdpError = null;
    // Careful pacing (default) slows the capture to a human browsing rate; either way
    // all scrolling, clicking and key presses use trusted input when CDP is available.
    this.pacing = this.options.carefulPacing ? PACING_PROFILES.careful : PACING_PROFILES.fast;
    this.human = null;
    this.contentFetchTimes = [];
    this.rateWaits = 0;
    this.programmaticScrolls = 0;
    this.scrollDiagnostics = {
      scroller: null,
      pointerHits: [],
      noWheelTarget: 0,
      wheelMoved: 0,
      wheelDidNotMove: 0,
      keyboardMoved: 0,
      keyboardDidNotMove: 0
    };
    this.domPosts = new Map();
    this.apiRequests = new Map();
    this.contentFetchesInFlight = new Set();
    this.backgroundApiRequests = 0;
    this.apiResponses = [];
    this.dialogsDismissed = 0;
    this.escapePresses = 0;
    this.escapeFutile = false;
    this.dialogWarningLogged = false;
    this.signedIn = true;
    this.pendingBodies = [];
    this.finalUrl = tab.url;
    this.reloaded = false;
    this.freshLoadRejected = null;
    this.sessionWarnings = [];
    this.loadSummary = null;
    this.screenshotLimit = null;
    this.htmlBudgetUsed = 0;
    this.htmlBudgetExhausted = false;
  }

  // ---------------------------------------------------------------------------
  // Preparation
  // ---------------------------------------------------------------------------

  async prepare() {
    this.signedIn = await this.detectSignedIn();
    this.logger.logInfo(`${this.platform.label} session`, { signedIn: this.signedIn });
    const loadedFresh = this.options.reloadBeforeCapture && await this.openPostInNewTab();
    if (!loadedFresh) {
      // Capture the post as displayed in the user's tab.
      await this.attachCdp();
      await this.ensureTools();
      if (!(await this.waitForTargetPost())) {
        throw new Error(`Post ${this.target.code} is not shown in this tab. Open the post itself and try again.`);
      }
    }
    await this.dismissDialogs();

    this.tab = await browser.tabs.get(this.tabId);
    this.finalUrl = this.tab.url;
    const current = this.platform.parsePostUrl(this.tab.url);
    if (!current || current.code !== this.target.code) {
      throw new Error(`Tab is no longer on the target post (now at ${this.tab.url}); login may be required`);
    }
    await this.harvestVisible();
  }

  async attachCdp() {
    try {
      this.cdp = await CdpSession.attach(this.tabId);
      this.cdp.on('Network.requestWillBeSent', params => this.onRequest(params));
      this.cdp.on('Network.responseReceived', params => this.onResponse(params));
      this.cdp.on('Network.loadingFinished', params => this.onLoadingFinished(params));
      this.cdp.on('Network.loadingFailed', ({ requestId }) => {
        this.apiRequests.delete(requestId);
        this.contentFetchesInFlight.delete(requestId);
      });
      await this.cdp.send('Network.enable', {
        maxTotalBufferSize: 200 * 1024 * 1024,
        maxResourceBufferSize: 50 * 1024 * 1024
      });
      this.human = new HumanInput(this.cdp, this.pacing);
      this.logger.logChain(Action.CDP_ATTACHED, Actor.AUTOMATED, { tabId: this.tabId, purpose: 'network capture, trusted input and screenshots' });
    } catch (error) {
      this.cdpError = error.message;
      if (this.cdp) await this.cdp.detach();
      this.cdp = null;
      this.human = null;
      this.logger.logWarning('DevTools protocol unavailable; continuing without network capture or trusted input', { error: error.message });
    }
  }

  /** Inject the page toolkit (if missing or stale) and configure it for this platform. */
  async ensureTools() {
    await ensurePageTools(this.tabId);
    await callPageTool(this.tabId, 'configurePlatform', this.platform.dom, this.target.code);
  }

  onRequest({ requestId, request, wallTime }) {
    const api = this.platform.api;
    if (!api.urlRe.test(request.url)) return;
    const query = api.summarizeRequest(request);
    if (api.isContentFetch(query, request.url)) {
      this.contentFetchTimes.push(Date.now());
      this.contentFetchesInFlight.add(requestId);
    } else {
      this.backgroundApiRequests++;
    }
    this.apiRequests.set(requestId, {
      url: request.url,
      method: request.method,
      requestedAt: wallTime ? new Date(wallTime * 1000).toISOString() : new Date().toISOString(),
      query
    });
  }

  onResponse({ requestId, response }) {
    const entry = this.apiRequests.get(requestId);
    if (!entry) return;
    entry.status = response.status;
    entry.mimeType = response.mimeType;
    entry.remoteAddress = response.remoteIPAddress ? `${response.remoteIPAddress}:${response.remotePort}` : null;
  }

  onLoadingFinished({ requestId, encodedDataLength }) {
    const entry = this.apiRequests.get(requestId);
    if (!entry || !this.cdp) return;
    this.apiRequests.delete(requestId);
    this.contentFetchesInFlight.delete(requestId);
    const pending = this.cdp.send('Network.getResponseBody', { requestId })
      .then(({ body, base64Encoded }) => {
        const text = base64Encoded ? new TextDecoder().decode(base64ToBytes(body)) : body;
        this.apiResponses.push({ ...entry, receivedAt: new Date().toISOString(), encodedDataLength, body: text });
      })
      .catch(error => {
        this.apiResponses.push({ ...entry, receivedAt: new Date().toISOString(), bodyError: error.message });
      });
    this.pendingBodies.push(pending);
  }

  /**
   * Load the post fresh in a new tab next to the user's tab, with the network
   * recorder attached before the first request, so every API response is recorded.
   *
   * A new tab is required: navigating the user's own tab replaces its history entry,
   * so if the platform then refuses the direct load (Threads redirects to the feed or
   * `/?error=invalid_post`, which happens for some signed-in sessions) the post as
   * displayed would be lost and could not be restored.
   *
   * @returns {Promise<boolean>} true when the new tab shows the post and becomes the
   *   capture tab; false when the platform refused it (the new tab is discarded and the
   *   user's tab, untouched, is captured instead)
   */
  async openPostInNewTab() {
    this.progress(7, 'Opening the post in a new tab for a clean capture...');
    const source = this.sourceTab;
    const created = await browser.tabs.create({
      url: 'about:blank',
      windowId: source.windowId,
      index: source.index + 1,
      active: true
    });
    this.createdTabId = created.id;
    this.tab = created;
    this.tabId = created.id;

    await this.attachCdp();
    const url = this.target.canonicalUrl;
    const complete = waitForTabComplete(created.id, RELOAD_TIMEOUT_MS);
    await browser.tabs.update(created.id, { url });
    await complete;
    // A page the toolkit cannot enter (the browser's error page, e.g. the platform
    // answered with an error status) does not show the post either.
    let shown = false;
    let loadError = null;
    try {
      await this.ensureTools();
      shown = await this.waitForTargetPost();
    } catch (error) {
      loadError = error.message;
    }

    if (shown) {
      this.reloaded = true;
      this.logger.logChain(Action.PAGE_RELOADED, Actor.AUTOMATED, {
        url,
        method: 'fresh load in a new tab',
        captureTabId: created.id,
        sourceTabId: source.id,
        sourceUrl: source.url
      });
      return true;
    }

    const landedOn = (await browser.tabs.get(created.id)).url;
    const label = this.platform.label;
    this.freshLoadRejected = { requested: url, landedOn, reason: this.platform.refusalReason(landedOn), error: loadError };
    this.logger.logWarning(`${label} did not show the post when loaded fresh; capturing it as displayed instead`, this.freshLoadRejected);

    // The rejected page is not evidence of the post: drop its recorded traffic.
    await this.discardCreatedTab();
    await Promise.allSettled(this.pendingBodies);
    this.pendingBodies = [];
    this.apiRequests.clear();
    this.contentFetchesInFlight.clear();
    this.apiResponses = [];

    this.tab = source;
    this.tabId = source.id;
    await browser.tabs.update(source.id, { active: true });
    this.sessionWarnings.push(describeRejectedLoad(label, this.target.code, this.freshLoadRejected));
    this.logger.logChain(Action.PAGE_INTERACTION, Actor.AUTOMATED, {
      interaction: `fresh load refused by ${label}; capturing the post as displayed in the original tab`,
      ...this.freshLoadRejected
    });
    return false;
  }

  /** Detach from and close the tab this session opened (the user's tab is never closed). */
  async discardCreatedTab() {
    if (!this.createdTabId) return;
    if (this.cdp && this.cdp.target.tabId === this.createdTabId) {
      await this.cdp.detach();
      this.logger.logChain(Action.CDP_DETACHED, Actor.AUTOMATED, { tabId: this.createdTabId });
      this.cdp = null;
      this.human = null;
    }
    await browser.tabs.remove(this.createdTabId).catch(() => {});
    this.createdTabId = null;
  }

  /**
   * Wait until the target post itself is rendered. Counting any rendered post is not
   * enough: the feed renders posts too.
   * @returns {Promise<boolean>} false when the tab settles on a different page or times out
   */
  async waitForTargetPost() {
    const deadline = Date.now() + POSTS_APPEAR_TIMEOUT_MS;
    let offTargetSince = null;
    for (;;) {
      const tab = await browser.tabs.get(this.tabId);
      const current = this.platform.parsePostUrl(tab.url || '');
      if (current && current.code === this.target.code) {
        offTargetSince = null;
        if (await callPageTool(this.tabId, 'postRendered', this.target.code)) return true;
      } else if (tab.status === 'complete') {
        // Client-side redirects happen shortly after load; allow a short grace period.
        offTargetSince = offTargetSince ?? Date.now();
        if (Date.now() - offTargetSince > OFF_TARGET_GRACE_MS) return false;
      }
      if (Date.now() > deadline) return false;
      await delay(500);
    }
  }

  /**
   * Close login prompts/modals that lock scrolling, with a trusted Escape key press.
   * Escape is pressed at most once per call and never again once it has failed to
   * close a dialog: repeated key presses at an unresponsive dialog are bot-like.
   */
  async dismissDialogs() {
    const open = await callPageTool(this.tabId, 'blockingDialogs');
    if (open === 0) return;
    if (!this.human || this.escapeFutile || this.escapePresses >= MAX_ESCAPE_PRESSES) {
      if (!this.dialogWarningLogged) {
        this.dialogWarningLogged = true;
        this.logger.logWarning('A dialog is open over the post and is not being dismissed', {
          dialogs: open,
          reason: !this.human ? 'no trusted input' : 'Escape does not close it'
        });
      }
      return;
    }
    await this.human.pressKey('Escape', 'Escape', 27);
    this.escapePresses++;
    this.logger.logChain(Action.PAGE_INTERACTION, Actor.AUTOMATED, { interaction: 'Escape key to dismiss dialog', dialogs: open });
    await this.human.pause([600, 1100]);
    const stillOpen = await callPageTool(this.tabId, 'blockingDialogs');
    if (stillOpen < open) this.dialogsDismissed++;
    else this.escapeFutile = true;
  }

  /** Whether the tab has a login session for the platform (decides which fallbacks are acceptable). */
  async detectSignedIn() {
    try {
      const cookie = await browser.cookies.get(this.platform.sessionCookie);
      return Boolean(cookie && cookie.value);
    } catch {
      return true; // unknown: assume an account is at stake
    }
  }

  // ---------------------------------------------------------------------------
  // Reply loading and harvesting
  // ---------------------------------------------------------------------------

  /**
   * Record the posts currently rendered. Social sites virtualise their lists, so this runs
   * after every scroll step; only codes we have not seen return full records.
   * Per-post HTML is kept within a byte budget so a huge thread cannot blow up the
   * worker or produce an undownloadable evidence file.
   */
  async harvestVisible() {
    const result = await callPageTool(this.tabId, 'harvestPosts', [...this.domPosts.keys()]);
    const observedAt = new Date().toISOString();
    for (const post of result.posts) {
      const html = post.html || '';
      let record = { ...post, firstObservedAt: observedAt };
      if (this.htmlBudgetUsed + html.length > POST_HTML_BUDGET_BYTES) {
        record = { ...record, html: null, htmlOmitted: 'per-post HTML budget exhausted' };
        if (!this.htmlBudgetExhausted) {
          this.htmlBudgetExhausted = true;
          this.logger.logWarning('Per-post HTML budget exhausted; later posts store rendered text only', {
            budgetBytes: POST_HTML_BUDGET_BYTES,
            postsWithHtml: this.domPosts.size
          });
        }
      } else {
        this.htmlBudgetUsed += html.length;
      }
      this.domPosts.set(post.code, record);
    }
    for (const [code, inThreadSection] of Object.entries(result.sections)) {
      const known = this.domPosts.get(code);
      if (known && known.inThreadSection === null && inThreadSection !== null) known.inThreadSection = inThreadSection;
    }
    return result.posts.length;
  }

  /**
   * CSS height of the post's own content; the related feed below it ("Related
   * threads", "Discover more") loads forever and is not part of the evidence.
   * @returns {Promise<number|null>}
   */
  async screenshotHeightLimit() {
    // An open login prompt scroll-locks the page and makes every offset read 0.
    await this.dismissDialogs();
    const { contentHeight, scrollHeight } = await callPageTool(this.tabId, 'contentHeight');
    this.screenshotLimit = { contentHeight, scrollHeight };
    if (contentHeight === null || contentHeight <= 0) {
      this.logger.logInfo('No end-of-thread marker in the scrolled area; screenshot covers the full scroll height', { contentHeight, scrollHeight });
      return null;
    }
    this.logger.logInfo('Screenshot limited to thread content', { contentHeight, scrollHeight });
    return contentHeight;
  }

  /**
   * Load every reply by reading down the thread the way a person would: scroll a
   * part of the viewport with the mouse wheel, pause, press any "show more replies"
   * button that comes into view, and wait at the end of the thread for the next
   * batch. Reply fetches are capped per minute. Growth is only judged once the end
   * of the thread content is in view.
   */
  async loadAllReplies() {
    if (!this.options.loadAllReplies) {
      this.loadSummary = { enabled: false };
      return;
    }
    const startedAt = Date.now();
    const maxDurationMs = this.pacing.maxLoadMinutes * 60 * 1000;
    const words = this.platform.words;
    const clickedLabels = [];
    let clicksSkipped = 0;
    let clicksAborted = 0;
    let hiddenClicked = 0;
    let maxHiddenNotRevealed = 0;
    let stuckScrolls = 0;
    let rounds = 0;
    let stableRounds = 0;
    let spinnerWaits = 0;
    let lastHeight = 0;
    let stopReason = 'no-new-content';

    for (;;) {
      if (this.isCancelled()) throw new Error('Capture cancelled by user');
      if (Date.now() - startedAt > maxDurationMs) {
        stopReason = 'time-limit';
        break;
      }
      if (rounds >= LOAD_MAX_ROUNDS) {
        stopReason = 'round-limit';
        break;
      }

      await this.dismissDialogs();
      await this.respectRequestRate();

      const { targets, hiddenNotRevealed } = await callPageTool(this.tabId, 'expanderTargets', this.options.revealHiddenReplies === true);
      maxHiddenNotRevealed = Math.max(maxHiddenNotRevealed, hiddenNotRevealed);
      for (const target of targets) {
        if (!this.human) {
          // No trusted input: never press it with a scripted click; count it once.
          await callPageTool(this.tabId, 'markClicked', target.id);
          clicksSkipped++;
          continue;
        }
        // A trusted click acts as the signed-in account: hover first, then press only
        // if the expander itself is under the pointer (the page may have moved).
        const point = this.human.pointIn(target.rect);
        await this.human.moveTo(point.x, point.y);
        if (!(await callPageTool(this.tabId, 'verifyTarget', target.id, point.x, point.y))) {
          clicksAborted++;
          this.logger.logWarning('Click aborted: the expander was not under the pointer', { button: target.label });
          continue;
        }
        await this.human.press(point.x, point.y);
        await callPageTool(this.tabId, 'markClicked', target.id);
        clickedLabels.push(target.label);
        if (target.hidden) hiddenClicked++;
        this.logger.logChain(Action.PAGE_INTERACTION, Actor.AUTOMATED, { interaction: 'click (trusted input, target verified under pointer)', button: target.label });
        await this.human.pause(this.pacing.clickPause);
      }

      const before = await callPageTool(this.tabId, 'loadState');
      const end = before.contentHeight ?? before.scrollHeight;
      if (before.scrollTop + before.region.height < end - 4) {
        const moved = await this.scrollStep(before, end);
        stuckScrolls = moved ? 0 : stuckScrolls + 1;
        if (stuckScrolls >= MAX_STUCK_SCROLLS) {
          // Something (usually a dialog) blocks scrolling. With an account at stake do
          // not keep sending input at a page that does not react.
          stopReason = 'page-not-scrolling';
          break;
        }
      } else {
        await this.waitForNetworkIdle();
      }
      rounds++;
      await this.readingPause();

      const newPosts = await this.harvestVisible();
      const state = await callPageTool(this.tabId, 'loadState');
      // Measure the post's own content, not the endless related feed below it.
      const height = state.contentHeight ?? state.scrollHeight;
      const atEnd = state.scrollTop + state.region.height >= height - 4;
      const grew = height > lastHeight + 1 || newPosts > 0 || targets.length > 0;
      lastHeight = Math.max(lastHeight, height);
      if (!atEnd || grew) {
        stableRounds = 0;
        spinnerWaits = 0;
      } else if (state.loading && spinnerWaits < LOAD_MAX_SPINNER_WAITS) {
        // Threads keeps a permanent loader at the end of the list, so a visible
        // spinner only buys a bounded number of extra rounds.
        spinnerWaits++;
      } else {
        stableRounds++;
      }

      const percent = Math.min(40, 15 + Math.round(rounds / 4));
      this.progress(percent, `Loading ${words.replies}: ${this.domPosts.size} posts seen (round ${rounds})`);
      if (stableRounds >= LOAD_STABLE_ROUNDS) break;
    }

    if (clicksSkipped) {
      this.logger.logWarning(`"Show more ${words.replies}" buttons were not pressed: trusted input needs the DevTools protocol`, { buttons: clicksSkipped });
    }
    this.loadSummary = {
      enabled: true,
      pacing: this.pacing.name,
      input: this.human ? 'trusted (DevTools protocol Input domain)' : 'programmatic scrolling only (no clicks)',
      rounds,
      stopReason,
      durationMs: Date.now() - startedAt,
      expandButtonsClicked: clickedLabels.length,
      expandButtonLabels: [...new Set(clickedLabels)],
      expandButtonsSkipped: clicksSkipped,
      hiddenReplyButtonsPressed: hiddenClicked,
      hiddenReplyButtonsNotPressed: maxHiddenNotRevealed,
      clicksAbortedByHitTest: clicksAborted,
      programmaticScrollsSignedOut: this.programmaticScrolls,
      scrolling: { ...this.scrollDiagnostics },
      spinnerWaits,
      rateLimitWaits: this.rateWaits,
      postsSeen: this.domPosts.size
    };
    const Reply = capitalize(words.reply);
    if (stopReason === 'page-not-scrolling') {
      this.sessionWarnings.push(`${Reply} loading stopped because the page stopped scrolling (a dialog may have been blocking it); ${words.replies} below that point may be missing.`);
    } else if (stopReason === 'time-limit') {
      this.sessionWarnings.push(`${Reply} loading stopped at the ${this.pacing.maxLoadMinutes}-minute limit of ${this.pacing.name} pacing; ${words.replies} below that point may be missing.`);
    } else if (stopReason === 'round-limit') {
      this.sessionWarnings.push(`${Reply} loading stopped after ${LOAD_MAX_ROUNDS} scroll rounds; ${words.replies} below that point may be missing.`);
    }
    if (maxHiddenNotRevealed > 0) {
      this.sessionWarnings.push(`${this.platform.label} showed buttons for hidden ${words.replies} that were not pressed ("Show hidden replies" is off); those ${words.replies} are not in the capture.`);
    }
    if (stopReason !== 'no-new-content') {
      this.logger.logWarning(`${Reply} loading stopped before the thread stopped growing`, this.loadSummary);
    }
    this.logger.logInfo(`${Reply} loading finished`, this.loadSummary);
  }

  /**
   * Scroll part of a viewport down, never past the end of the thread content, using
   * genuine input only: a wheel at a point where the wheel really scrolls the capture's
   * container, then (if the page did not move) a real PageDown key press.
   * @returns {Promise<boolean>} whether the page moved
   */
  async scrollStep(state, end) {
    const region = state.region;
    const remaining = end - (state.scrollTop + region.height) + 8;
    const delta = Math.max(40, Math.min(remaining, region.height * randomBetween(this.pacing.scrollFraction)));
    const moved = async () => {
      await delay(350); // wheel scrolling may animate
      const now = await callPageTool(this.tabId, 'loadState');
      return Math.abs(now.scrollTop - state.scrollTop) > 1;
    };
    this.scrollDiagnostics.scroller = state.scroller;
    if (this.human) {
      const point = await this.wheelPoint(region);
      if (point) {
        await this.human.wheel(delta, point.x, point.y);
        if (await moved()) {
          this.scrollDiagnostics.wheelMoved++;
          return true;
        }
        this.scrollDiagnostics.wheelDidNotMove++;
      }
      if (!state.focusIsEditable) {
        await this.human.pressKey('PageDown', 'PageDown', 34);
        if (await moved()) {
          this.scrollDiagnostics.keyboardMoved++;
          return true;
        }
        this.scrollDiagnostics.keyboardDidNotMove++;
      }
      if (this.signedIn) return false;
      // No account at stake (signed out): a scroll-locking prompt must not stop the capture.
      this.programmaticScrolls++;
    }
    await callPageTool(this.tabId, 'scrollToY', state.scrollTop + delta);
    return moved();
  }

  /**
   * A pointer position where a wheel event scrolls the capture's container (hit-tested
   * in the page), nudged a little so repeated scrolls do not use one pixel.
   * @returns {Promise<{x: number, y: number}|null>}
   */
  async wheelPoint(region) {
    const point = await callPageTool(this.tabId, 'scrollPointer');
    if (this.scrollDiagnostics.pointerHits.length < 5 && !this.scrollDiagnostics.pointerHits.includes(point.hit)) {
      this.scrollDiagnostics.pointerHits.push(point.hit);
    }
    if (point.x === null) {
      this.scrollDiagnostics.noWheelTarget++;
      return null;
    }
    const jitter = () => Math.round(randomBetween([-12, 12]));
    return {
      x: Math.min(region.left + region.width - 2, Math.max(region.left + 2, point.x + jitter())),
      y: Math.min(region.top + region.height - 2, Math.max(region.top + 2, point.y + jitter()))
    };
  }

  async readingPause() {
    if (this.human) await this.human.readingPause();
    else await delay(randomBetween(this.pacing.roundPause));
  }

  /** Wait until no reply/content fetch is in flight (bounded), so the next step follows the page. */
  async waitForNetworkIdle() {
    const deadline = Date.now() + NETWORK_IDLE_TIMEOUT_MS;
    while (this.contentFetchesInFlight.size > 0 && Date.now() < deadline) await delay(250);
  }

  /** Keep reply/comment fetches under the pacing profile's per-minute cap. */
  async respectRequestRate() {
    const windowMs = 60 * 1000;
    const limit = this.pacing.maxContentFetchesPerMinute;
    for (;;) {
      const now = Date.now();
      this.contentFetchTimes = this.contentFetchTimes.filter(t => now - t < windowMs);
      if (this.contentFetchTimes.length < limit) return;
      const wait = this.contentFetchTimes[0] + windowMs - now + randomBetween([500, 2500]);
      this.rateWaits++;
      this.progress(null, `Pacing: waiting ${Math.ceil(wait / 1000)}s to stay under ${limit} ${this.platform.words.reply} fetches per minute`);
      await delay(wait);
      if (this.isCancelled()) throw new Error('Capture cancelled by user');
    }
  }

  // ---------------------------------------------------------------------------
  // Screenshot hooks (trusted wheel scrolling, jittered settle)
  // ---------------------------------------------------------------------------

  async screenshotScrollTo(targetTop, position) {
    const delta = targetTop - position.scrollTop;
    if (Math.abs(delta) <= 1) return;
    const point = await this.wheelPoint(position.region);
    if (!point) return; // nothing under the pointer would scroll; advanceTo reports it
    await this.human.wheel(delta, point.x, point.y);
  }

  async screenshotSettle() {
    if (this.human) await this.human.pause(this.pacing.frameSettle);
    else await delay(randomBetween(this.pacing.frameSettle));
  }

  // ---------------------------------------------------------------------------
  // Finalization
  // ---------------------------------------------------------------------------

  /**
   * @returns {Promise<{dataset: Object, rawEmbedded: Array, rawNetwork: Array, domPosts: Array, mediaFiles: Array, summary: Object}>}
   */
  async finalize() {
    const label = this.platform.label;
    this.progress(80, `Extracting ${label} post data...`);
    const embedded = await callPageTool(this.tabId, 'embeddedJson');
    await Promise.allSettled(this.pendingBodies);

    const parser = this.platform.parser;
    const api = createApiStore({ rootCode: this.target.code });
    for (const script of embedded) {
      for (const doc of parseJsonDocuments(script.text)) collectApiPosts(doc, 'embedded', api, parser);
    }
    for (const response of this.apiResponses) {
      for (const doc of parseJsonDocuments(response.body)) collectApiPosts(doc, 'network', api, parser);
    }

    const dataset = buildThreadDataset({ rootCode: this.target.code, api, domPosts: this.domPosts, platform: this.platform });
    // Session-level completeness notes (e.g. a refused fresh load) lead the list so they
    // appear in thread.json, the report and the manifest constraints.
    dataset.warnings.unshift(...this.sessionWarnings);
    this.logger.logInfo(`${label} dataset built`, dataset.statistics);
    for (const warning of dataset.warnings) this.logger.logWarning(warning);

    const mediaFiles = this.options.downloadMedia ? await this.downloadMedia(dataset) : [];

    const domPosts = [...this.domPosts.values()].sort((a, b) => a.documentY - b.documentY);

    return {
      platform: { id: this.platform.id, label },
      dataset,
      rawEmbedded: embedded,
      rawNetwork: this.apiResponses,
      domPosts,
      mediaFiles,
      summary: this.summary(dataset, mediaFiles)
    };
  }

  async downloadMedia(dataset) {
    const jobs = [];
    for (const post of dataset.posts) {
      post.media.forEach((media, index) => jobs.push({ post, media, index }));
    }
    if (jobs.length === 0) return [];

    const files = [];
    const total = jobs.length;
    let done = 0;
    const worker = async () => {
      while (jobs.length) {
        if (this.isCancelled()) throw new Error('Capture cancelled by user');
        const { post, media, index } = jobs.shift();
        try {
          const file = await fetchMediaFile(post.code, index, media);
          files.push(file);
          post.localMedia.push({ index, path: file.path });
        } catch (error) {
          post.mediaErrors = { ...(post.mediaErrors || {}), [index]: error.message };
          this.logger.logWarning('Media download failed', { post: post.code, index, url: media.url, error: error.message });
        }
        done++;
        this.progress(84, `Downloading media ${done}/${total}...`);
      }
    };
    await Promise.all(Array.from({ length: MEDIA_CONCURRENCY }, worker));
    files.sort((a, b) => a.path.localeCompare(b.path));
    for (const post of dataset.posts) post.localMedia.sort((a, b) => a.index - b.index);
    this.logger.logChain(Action.MEDIA_DOWNLOADED, Actor.AUTOMATED, { files: files.length, failed: dataset.posts.reduce((n, p) => n + Object.keys(p.mediaErrors || {}).length, 0) });
    return files;
  }

  summary(dataset, mediaFiles) {
    return {
      platform: this.platform.id,
      target: this.target,
      finalUrl: this.finalUrl,
      options: this.options,
      loadedFreshInNewTab: this.reloaded,
      freshLoadRejected: this.freshLoadRejected,
      capturedTab: this.reloaded ? 'new tab (post loaded fresh)' : 'original tab (post as displayed)',
      sourceUrl: this.sourceTab.url,
      devtoolsProtocol: this.cdp ? 'attached' : `unavailable${this.cdpError ? `: ${this.cdpError}` : ''}`,
      dialogsDismissed: this.dialogsDismissed,
      automationFootprint: {
        pacing: this.pacing.name,
        input: this.human ? 'trusted browser input (wheel, pointer, keys) via DevTools protocol' : 'programmatic scrolling; no clicks',
        inputEvents: this.human ? { ...this.human.stats, escapePresses: this.escapePresses } : null,
        signedIn: this.signedIn,
        replyFetchRateCapPerMinute: this.pacing.maxContentFetchesPerMinute,
        backgroundApiRequestsNotRateLimited: this.backgroundApiRequests,
        rateLimitWaits: this.rateWaits,
        programmaticScrolls: this.programmaticScrolls,
        pageModified: this.signedIn ? false : 'signed out only: login prompt overlays hidden during screenshots',
        scriptsInjectedIntoPage: 'none (extension isolated world only)'
      },
      replyLoading: this.loadSummary,
      screenshotHeightLimit: this.screenshotLimit || null,
      apiResponsesCaptured: this.apiResponses.length,
      mediaFilesDownloaded: mediaFiles.length,
      statistics: dataset.statistics,
      warnings: dataset.warnings
    };
  }

  async dispose() {
    if (this.cdp) {
      await this.cdp.detach();
      this.logger.logChain(Action.CDP_DETACHED, Actor.AUTOMATED, { tabId: this.cdp.target.tabId });
      this.cdp = null;
    }
    if (this.createdTabId) {
      // Close the capture tab and hand the user back the tab they started from.
      await this.discardCreatedTab();
      await browser.tabs.update(this.sourceTab.id, { active: true }).catch(() => {});
    }
  }
}

/** Completeness note for a fresh load that the platform refused. */
function describeRejectedLoad(label, code, { landedOn, reason, error }) {
  let what;
  if (reason) what = `${label} refused to open post ${code} from its link and redirected to ${landedOn} (error=${reason})`;
  else if (error) what = `Loading post ${code} from its link showed an error page instead of the post (${error})`;
  else what = `Loading post ${code} from its link did not show the post (${label} opened ${landedOn})`;
  return `${what}. The post was captured as displayed in the original tab instead; ` +
    'API responses that loaded it before the capture started are not recorded, ' +
    'so posts rendered before capture have rendered text only.';
}

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

async function fetchMediaFile(code, index, media) {
  const response = await fetch(media.url, { credentials: 'omit', cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (declared > MEDIA_MAX_BYTES) throw new Error(`exceeds ${MEDIA_MAX_BYTES} byte limit (${declared})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MEDIA_MAX_BYTES) throw new Error(`exceeds ${MEDIA_MAX_BYTES} byte limit (${bytes.length})`);
  const mimeType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const extension = MEDIA_EXTENSIONS[mimeType] || (media.kind === 'video' ? 'mp4' : 'jpg');
  return {
    path: `media/${code}-${String(index + 1).padStart(2, '0')}.${extension}`,
    type: 'media',
    mimeType: mimeType || (media.kind === 'video' ? 'video/mp4' : 'image/jpeg'),
    bytes,
    sourceUrl: media.url
  };
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let sawLoading = false;
    const timer = setTimeout(() => {
      browser.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timed out waiting for the page to reload'));
    }, timeoutMs);
    const listener = (updatedId, change) => {
      if (updatedId !== tabId) return;
      if (change.status === 'loading') sawLoading = true;
      if (change.status === 'complete' && sawLoading) {
        clearTimeout(timer);
        browser.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    browser.tabs.onUpdated.addListener(listener);
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
