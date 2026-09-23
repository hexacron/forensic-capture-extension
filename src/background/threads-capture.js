/**
 * Threads post capture session.
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
import {
  createApiStore,
  collectApiPosts,
  parseJsonDocuments,
  summarizeGraphqlRequest,
  buildThreadDataset,
  parseThreadsPostUrl
} from '../threads/threads-parser.js';

export const DEFAULT_THREADS_OPTIONS = {
  loadAllReplies: true,
  reloadBeforeCapture: true,
  downloadMedia: true
};

const LOAD_ROUND_WAIT_MS = 1500;
const LOAD_STABLE_ROUNDS = 3;
const LOAD_MAX_SPINNER_WAITS = 5;
const LOAD_MAX_DURATION_MS = 10 * 60 * 1000;
const LOAD_MAX_ROUNDS = 400;
const RELOAD_TIMEOUT_MS = 45000;
const OFF_TARGET_GRACE_MS = 3000;
// Threads posts carry ~12-60KB of markup each; cap what we retain as evidence so a huge
// thread cannot exhaust worker memory or produce an undownloadable JSON file.
const POST_HTML_BUDGET_BYTES = 24 * 1024 * 1024;
const POSTS_APPEAR_TIMEOUT_MS = 20000;
const MEDIA_MAX_BYTES = 150 * 1024 * 1024;
const MEDIA_CONCURRENCY = 4;
const GRAPHQL_URL_RE = /^https:\/\/(?:www\.)?threads\.(?:com|net)\/(?:api\/graphql|graphql\/query)/;

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

export class ThreadsCaptureSession {
  /**
   * @param {Object} params
   * @param {Object} params.tab - The user's tab showing the post
   * @param {{username: string, code: string, canonicalUrl: string}} params.target
   * @param {Object} params.logger
   * @param {Object} params.options - DEFAULT_THREADS_OPTIONS overrides
   * @param {Function} params.isCancelled
   * @param {Function} params.progress - (percent, detail)
   */
  constructor({ tab, target, logger, options, isCancelled, progress }) {
    this.sourceTab = tab;
    // The tab being captured. Becomes a separate tab when the post is loaded fresh;
    // callers must read `tab` after prepare().
    this.tab = tab;
    this.tabId = tab.id;
    this.createdTabId = null;
    this.target = target;
    this.logger = logger;
    this.options = { ...DEFAULT_THREADS_OPTIONS, ...options };
    this.isCancelled = isCancelled;
    this.progress = progress;
    this.cdp = null;
    this.cdpError = null;
    this.domPosts = new Map();
    this.graphqlRequests = new Map();
    this.graphqlResponses = [];
    this.pendingBodies = [];
    this.finalUrl = tab.url;
    this.reloaded = false;
    this.freshLoadRejected = null;
    this.sessionWarnings = [];
    this.dialogsDismissed = 0;
    this.loadSummary = null;
    this.screenshotLimit = null;
    this.htmlBudgetUsed = 0;
    this.htmlBudgetExhausted = false;
  }

  // ---------------------------------------------------------------------------
  // Preparation
  // ---------------------------------------------------------------------------

  async prepare() {
    const loadedFresh = this.options.reloadBeforeCapture && await this.openPostInNewTab();
    if (!loadedFresh) {
      // Capture the post as displayed in the user's tab.
      await this.attachCdp();
      await ensurePageTools(this.tabId);
      if (!(await this.waitForTargetPost())) {
        throw new Error(`Post ${this.target.code} is not shown in this tab. Open the post itself and try again.`);
      }
    }
    await this.dismissDialogs();

    this.tab = await browser.tabs.get(this.tabId);
    this.finalUrl = this.tab.url;
    const current = parseThreadsPostUrl(this.tab.url);
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
      await this.cdp.send('Network.enable', {
        maxTotalBufferSize: 200 * 1024 * 1024,
        maxResourceBufferSize: 50 * 1024 * 1024
      });
      this.logger.logChain(Action.CDP_ATTACHED, Actor.AUTOMATED, { tabId: this.tabId, purpose: 'network capture and screenshots' });
    } catch (error) {
      this.cdpError = error.message;
      if (this.cdp) await this.cdp.detach();
      this.cdp = null;
      this.logger.logWarning('DevTools protocol unavailable; continuing without network capture', { error: error.message });
    }
  }

  onRequest({ requestId, request, wallTime }) {
    if (!GRAPHQL_URL_RE.test(request.url)) return;
    this.graphqlRequests.set(requestId, {
      url: request.url,
      method: request.method,
      requestedAt: wallTime ? new Date(wallTime * 1000).toISOString() : new Date().toISOString(),
      query: summarizeGraphqlRequest(request.postData)
    });
  }

  onResponse({ requestId, response }) {
    const entry = this.graphqlRequests.get(requestId);
    if (!entry) return;
    entry.status = response.status;
    entry.mimeType = response.mimeType;
    entry.remoteAddress = response.remoteIPAddress ? `${response.remoteIPAddress}:${response.remotePort}` : null;
  }

  onLoadingFinished({ requestId, encodedDataLength }) {
    const entry = this.graphqlRequests.get(requestId);
    if (!entry || !this.cdp) return;
    this.graphqlRequests.delete(requestId);
    const pending = this.cdp.send('Network.getResponseBody', { requestId })
      .then(({ body, base64Encoded }) => {
        const text = base64Encoded ? new TextDecoder().decode(base64ToBytes(body)) : body;
        this.graphqlResponses.push({ ...entry, receivedAt: new Date().toISOString(), encodedDataLength, body: text });
      })
      .catch(error => {
        this.graphqlResponses.push({ ...entry, receivedAt: new Date().toISOString(), bodyError: error.message });
      });
    this.pendingBodies.push(pending);
  }

  /**
   * Load the post fresh in a new tab next to the user's tab, with the network
   * recorder attached before the first request, so every API response is recorded.
   *
   * A new tab is required: navigating the user's own tab replaces its history entry,
   * so if Threads then refuses the direct load (redirect to the feed or
   * `/?error=invalid_post`, which happens for some signed-in sessions) the post as
   * displayed would be lost and could not be restored.
   *
   * @returns {Promise<boolean>} true when the new tab shows the post and becomes the
   *   capture tab; false when Threads refused it (the new tab is discarded and the
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
    await ensurePageTools(created.id);

    if (await this.waitForTargetPost()) {
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
    this.freshLoadRejected = { requested: url, landedOn, reason: redirectErrorOf(landedOn) };
    this.logger.logWarning('Threads did not show the post when loaded fresh; capturing it as displayed instead', this.freshLoadRejected);

    // The rejected page is not evidence of the post: drop its recorded traffic.
    await this.discardCreatedTab();
    await Promise.allSettled(this.pendingBodies);
    this.pendingBodies = [];
    this.graphqlRequests.clear();
    this.graphqlResponses = [];

    this.tab = source;
    this.tabId = source.id;
    await browser.tabs.update(source.id, { active: true });
    this.sessionWarnings.push(describeRejectedLoad(this.target.code, landedOn));
    this.logger.logChain(Action.PAGE_INTERACTION, Actor.AUTOMATED, {
      interaction: 'fresh load refused by Threads; capturing the post as displayed in the original tab',
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
      const current = parseThreadsPostUrl(tab.url || '');
      if (current && current.code === this.target.code) {
        offTargetSince = null;
        if (await callPageTool(this.tabId, 'threadsPostRendered', this.target.code)) return true;
      } else if (tab.status === 'complete') {
        // Client-side redirects happen shortly after load; allow a short grace period.
        offTargetSince = offTargetSince ?? Date.now();
        if (Date.now() - offTargetSince > OFF_TARGET_GRACE_MS) return false;
      }
      if (Date.now() > deadline) return false;
      await delay(500);
    }
  }

  /** Close login prompts/modals that lock scrolling (requires CDP for trusted key events). */
  async dismissDialogs() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const open = await callPageTool(this.tabId, 'threadsVisibleDialogs');
      if (open === 0) return;
      if (!this.cdp) {
        this.logger.logWarning('A dialog is open over the post and could not be dismissed automatically', { dialogs: open });
        return;
      }
      for (const type of ['keyDown', 'keyUp']) {
        await this.cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      }
      this.dialogsDismissed++;
      this.logger.logChain(Action.PAGE_INTERACTION, Actor.AUTOMATED, { interaction: 'Escape key to dismiss dialog', dialogs: open });
      await delay(700);
    }
  }

  // ---------------------------------------------------------------------------
  // Reply loading and harvesting
  // ---------------------------------------------------------------------------

  /**
   * Record the posts currently rendered. Threads virtualises its list, so this runs
   * after every scroll step; only codes we have not seen return full records.
   * Per-post HTML is kept within a byte budget so a huge thread cannot blow up the
   * worker or produce an undownloadable evidence file.
   */
  async harvestVisible() {
    const result = await callPageTool(this.tabId, 'threadsHarvest', [...this.domPosts.keys()]);
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
   * CSS height of the thread's own content; the "Related threads" feed below it
   * loads forever and is not part of the evidence.
   * @returns {Promise<number|null>}
   */
  async screenshotHeightLimit() {
    // An open login prompt scroll-locks the page and makes every offset read 0.
    await this.dismissDialogs();
    const { contentHeight, scrollHeight } = await callPageTool(this.tabId, 'threadsContentHeight');
    this.screenshotLimit = { contentHeight, scrollHeight };
    if (contentHeight === null || contentHeight <= 0) {
      this.logger.logWarning('Related-threads marker not found; screenshot height limited to the current page height', { contentHeight, scrollHeight });
      return null;
    }
    this.logger.logInfo('Screenshot limited to thread content', { contentHeight, scrollHeight });
    return contentHeight;
  }

  async loadAllReplies() {
    if (!this.options.loadAllReplies) {
      this.loadSummary = { enabled: false };
      return;
    }
    const startedAt = Date.now();
    const clickedLabels = [];
    let rounds = 0;
    let stableRounds = 0;
    let spinnerWaits = 0;
    let lastHeight = 0;
    let stopReason = 'no-new-content';

    for (;;) {
      if (this.isCancelled()) throw new Error('Capture cancelled by user');
      if (Date.now() - startedAt > LOAD_MAX_DURATION_MS) {
        stopReason = 'time-limit';
        break;
      }
      if (rounds >= LOAD_MAX_ROUNDS) {
        stopReason = 'round-limit';
        break;
      }

      await this.dismissDialogs();
      const step = await callPageTool(this.tabId, 'threadsLoadStep');
      rounds++;
      if (step.clicked.length) {
        clickedLabels.push(...step.clicked);
        this.logger.logChain(Action.PAGE_INTERACTION, Actor.AUTOMATED, { interaction: 'expand replies', buttons: step.clicked });
      }
      await delay(LOAD_ROUND_WAIT_MS);

      const newPosts = await this.harvestVisible();
      const state = await callPageTool(this.tabId, 'threadsLoadState');
      // Measure the thread's own content, not the endless "Related threads" feed.
      const height = state.contentHeight ?? state.scrollHeight;
      const grew = height > lastHeight + 1 || newPosts > 0 || step.clicked.length > 0;
      if (grew) {
        stableRounds = 0;
        spinnerWaits = 0;
      } else if (state.loading && spinnerWaits < LOAD_MAX_SPINNER_WAITS) {
        // A visible spinner may mean a pending fetch - but Threads leaves a
        // permanent loader at the end of the list, so only wait a bounded number
        // of extra rounds for it.
        spinnerWaits++;
      } else {
        stableRounds++;
      }
      lastHeight = Math.max(lastHeight, height);

      const percent = Math.min(40, 15 + rounds);
      this.progress(percent, `Loading replies: ${this.domPosts.size} posts seen (round ${rounds})`);
      if (stableRounds >= LOAD_STABLE_ROUNDS) break;
    }

    this.loadSummary = {
      enabled: true,
      rounds,
      stopReason,
      durationMs: Date.now() - startedAt,
      expandButtonsClicked: clickedLabels.length,
      expandButtonLabels: [...new Set(clickedLabels)],
      spinnerWaits,
      postsSeen: this.domPosts.size
    };
    if (stopReason !== 'no-new-content') {
      this.logger.logWarning('Reply loading stopped before the thread stopped growing', this.loadSummary);
    }
    this.logger.logInfo('Reply loading finished', this.loadSummary);
  }

  // ---------------------------------------------------------------------------
  // Finalization
  // ---------------------------------------------------------------------------

  /**
   * @returns {Promise<{dataset: Object, rawEmbedded: Array, rawNetwork: Array, domPosts: Array, mediaFiles: Array, summary: Object}>}
   */
  async finalize() {
    this.progress(80, 'Extracting Threads post data...');
    const embedded = await callPageTool(this.tabId, 'threadsEmbeddedJson');
    await Promise.allSettled(this.pendingBodies);

    const api = createApiStore();
    for (const script of embedded) {
      for (const doc of parseJsonDocuments(script.text)) collectApiPosts(doc, 'embedded', api);
    }
    for (const response of this.graphqlResponses) {
      for (const doc of parseJsonDocuments(response.body)) collectApiPosts(doc, 'network', api);
    }

    const dataset = buildThreadDataset({ rootCode: this.target.code, api, domPosts: this.domPosts });
    // Session-level completeness notes (e.g. a refused fresh load) lead the list so they
    // appear in thread.json, the report and the manifest constraints.
    dataset.warnings.unshift(...this.sessionWarnings);
    this.logger.logInfo('Threads dataset built', dataset.statistics);
    for (const warning of dataset.warnings) this.logger.logWarning(warning);

    const mediaFiles = this.options.downloadMedia ? await this.downloadMedia(dataset) : [];

    const domPosts = [...this.domPosts.values()].sort((a, b) => a.documentY - b.documentY);

    return {
      dataset,
      rawEmbedded: embedded,
      rawNetwork: this.graphqlResponses,
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
      target: this.target,
      finalUrl: this.finalUrl,
      options: this.options,
      loadedFreshInNewTab: this.reloaded,
      freshLoadRejected: this.freshLoadRejected,
      capturedTab: this.reloaded ? 'new tab (post loaded fresh)' : 'original tab (post as displayed)',
      sourceUrl: this.sourceTab.url,
      devtoolsProtocol: this.cdp ? 'attached' : `unavailable${this.cdpError ? `: ${this.cdpError}` : ''}`,
      dialogsDismissed: this.dialogsDismissed,
      replyLoading: this.loadSummary,
      screenshotHeightLimit: this.screenshotLimit || null,
      graphqlResponsesCaptured: this.graphqlResponses.length,
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

/** Threads refuses a direct load by redirecting with `?error=<reason>`. */
function redirectErrorOf(url) {
  try {
    return new URL(url).searchParams.get('error');
  } catch {
    return null;
  }
}

/** Completeness note for a fresh load that Threads refused. */
function describeRejectedLoad(code, landedOn) {
  const reason = redirectErrorOf(landedOn);
  const what = reason
    ? `Threads refused to open post ${code} from its link and redirected to ${landedOn} (error=${reason})`
    : `Loading post ${code} from its link did not show the post (Threads opened ${landedOn})`;
  return `${what}. The post was captured as displayed in the original tab instead; ` +
    'API responses that loaded it before the capture started are not recorded, ' +
    'so posts rendered before capture have rendered text only.';
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
