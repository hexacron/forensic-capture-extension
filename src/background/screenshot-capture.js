/**
 * Screenshot Capture Module - Full Page Scroll and Stitch
 *
 * Scrolls the page's actual scroll container viewport by viewport and stitches
 * the frames into PNG segments. Scroll-and-stitch (instead of one oversized
 * capture) is required for virtualized feeds such as Threads, which only
 * render posts near the current scroll position.
 *
 * Correctness rules:
 * - Frames are placed by the scroll offset read back from the page, so the
 *   clamped final frame is never duplicated.
 * - Image scale is derived from the captured bitmap, so HiDPI/Retina and page
 *   zoom produce native-resolution output.
 * - Fixed/sticky overlays are visible in the first frame only.
 * - Output is split into segments to stay within canvas limits; one segment
 *   is held in memory at a time.
 */

import '../../lib/browser-polyfill.min.js';
import { ensurePageTools, callPageTool } from './page-tools-client.js';
import { base64ToBytes } from '../utils/encoding-utils.js';

const SETTLE_DELAY_MS = 500;
// chrome.tabs.captureVisibleTab is limited to 2 calls/second per extension.
const VISIBLE_TAB_MIN_INTERVAL_MS = 600;
const MAX_FRAMES = 600;
const MAX_SEGMENT_HEIGHT = 16384;
const MAX_SEGMENT_PIXELS = 32 * 1024 * 1024;
const FRAME_TIMEOUT_MS = 20000;
const TAB_ACTIVE_WAIT_MS = 30000;

/**
 * Capture a full-page screenshot.
 * @param {Object} tab - Tab object (id, windowId)
 * @param {Object} logger - Forensic logger
 * @param {Object} [options]
 * @param {import('./cdp-session.js').CdpSession} [options.cdp] - Use CDP Page.captureScreenshot (no rate limit)
 * @param {number} [options.maxCssHeight] - Hard ceiling in CSS pixels (infinite feeds); defaults to the page height measured before the first frame
 * @param {'hide'|'crop'} [options.overlays] - 'hide' restyles fixed/sticky overlays after the first frame;
 *   'crop' leaves the page untouched and cuts the sticky header band out of later frames
 * @param {boolean} [options.hideModals] - Hide modal dialogs and their dimming layer before every frame (sites that re-open login prompts on scroll)
 * @param {Function} [options.scrollTo] - async (targetTop, position) => void; replaces programmatic scrolling (e.g. trusted wheel input)
 * @param {Function} [options.settle] - async () => void; wait after each scroll (default 500 ms)
 * @param {boolean} [options.restoreScroll] - scroll back to the original position afterwards (default true)
 * @param {boolean} [options.exactFallback] - allow programmatic positioning when custom scrolling cannot move the page (default true)
 * @param {Function} [options.beforeFrame] - Awaited before every frame (e.g. closing a re-opened dialog that scroll-locks the page)
 * @param {Function} [options.onFrame] - Awaited after each frame (e.g. harvesting virtualized content)
 * @param {Function} [options.onProgress] - Called with (framesCaptured, estimatedFrames)
 * @param {Function} [options.isCancelled] - Returns true to abort
 * @returns {Promise<Object>} { segments: [{bytes, width, height}], backend, frames, ... }
 */
export async function captureFullPageScreenshot(tab, logger, options = {}) {
  const {
    cdp = null,
    maxCssHeight = null,
    overlays = 'hide',
    hideModals = false,
    scrollTo = null,
    settle = () => delay(SETTLE_DELAY_MS),
    restoreScroll = true,
    exactFallback = true,
    beforeFrame = null,
    onFrame = null,
    onProgress = null,
    isCancelled = () => false
  } = options;
  const tabId = tab.id;
  const scrollPage = scrollTo || (target => callPageTool(tabId, 'scrollToY', target));

  await ensurePageTools(tabId);
  const plan = await callPageTool(tabId, 'beginScreenshot');
  // Infinite feeds (Threads' "Related threads") grow while being scrolled, so the
  // captured height is fixed up front instead of tracking the live page height.
  const ceiling = Math.max(
    plan.region.height,
    maxCssHeight > 0 ? Math.min(maxCssHeight, plan.scrollHeight) : plan.scrollHeight
  );
  logger.logInfo('Full-page screenshot plan', {
    scroller: plan.scrollerIsDocument ? 'document' : plan.scrollerTag,
    scrollHeight: plan.scrollHeight,
    captureHeight: ceiling,
    heightLimitRequested: maxCssHeight,
    overlays,
    scrolling: scrollTo ? 'custom (trusted input)' : 'programmatic',
    region: plan.region,
    viewport: plan.viewport,
    devicePixelRatio: plan.devicePixelRatio,
    originalScroll: plan.originalScroll
  });

  const capturer = cdp ? new CdpCapturer(cdp) : new VisibleTabCapturer(tab.windowId);
  const stitcher = new Stitcher(plan.viewport.width, plan.region);
  const estimatedFrames = Math.max(1, Math.ceil(ceiling / plan.region.height));
  let frames = 0;
  let truncated = false;
  let fixedHidden = null;
  let topInset = 0; // 'crop': sticky header band excluded from frames after the first
  let modalOverlaysHidden = 0;
  let scrollCorrections = 0;

  /**
   * Scroll so the next frame's visible band starts at `want`. Undershoot is harmless
   * (frames overlap). Overshoot would leave a gap and no movement would stall the
   * capture, so both are retried, then fixed with exact positioning.
   */
  const advanceTo = async (want) => {
    const before = await callPageTool(tabId, 'position');
    const wantedMove = Math.abs(want - before.scrollTop) > 1;
    await scrollPage(want, before);
    await settle();
    for (let attempt = 0; attempt < 2; attempt++) {
      const pos = await callPageTool(tabId, 'position');
      const overshoot = pos.scrollTop > want + 1;
      const stuck = wantedMove && Math.abs(pos.scrollTop - before.scrollTop) <= 1;
      if (!overshoot && !stuck) return pos;
      scrollCorrections++;
      await scrollPage(want, pos);
      await settle();
    }
    const pos = await callPageTool(tabId, 'position');
    const stuck = wantedMove && Math.abs(pos.scrollTop - before.scrollTop) <= 1;
    const overshoot = pos.scrollTop > want + 1;
    if (!overshoot && !stuck) return pos;
    // A page that ignores wheel input (e.g. a scroll-locking dialog) is left alone when an
    // account is at stake; the caller then ends the screenshot as truncated.
    if (stuck && !overshoot && !exactFallback) return pos;
    // Last resort: exact positioning, so the stitched image never has a gap.
    scrollCorrections++;
    await callPageTool(tabId, 'scrollToY', want);
    await settle();
    return callPageTool(tabId, 'position');
  };

  try {
    let pos = await advanceTo(0);

    for (;;) {
      if (isCancelled()) throw new Error('Capture cancelled by user');
      if (frames >= MAX_FRAMES) {
        truncated = true;
        logger.logWarning('Screenshot frame limit reached; page truncated', { maxFrames: MAX_FRAMES });
        break;
      }

      await waitForActiveTab(tabId, logger);
      if (beforeFrame) await beforeFrame();
      if (hideModals) {
        const { hidden } = await callPageTool(tabId, 'hideModalOverlays');
        if (hidden) modalOverlaysHidden += hidden;
      }
      pos = await callPageTool(tabId, 'position');
      const image = await capturer.capture();
      await stitcher.addFrame(image, pos.scrollTop, pos.region, ceiling, frames === 0 ? 0 : topInset);
      frames++;

      if (onProgress) onProgress(frames, Math.max(frames, estimatedFrames));
      if (onFrame) await onFrame(frames);

      if (frames === 1) {
        if (overlays === 'crop') {
          ({ topInset } = await callPageTool(tabId, 'measureTopInset'));
          topInset = Math.min(topInset, Math.floor(pos.region.height / 3));
        } else {
          fixedHidden = await callPageTool(tabId, 'hideFixedElements');
        }
      }

      if (stitcher.coveredCss >= ceiling - 1) break;

      const want = Math.min(stitcher.coveredCss - topInset, Math.max(0, ceiling - pos.region.height));
      if (want <= pos.scrollTop) break;
      const next = await advanceTo(want);
      if (next.scrollTop <= pos.scrollTop) {
        logger.logWarning('Page stopped scrolling before reaching the end', {
          scrollTop: next.scrollTop,
          scrollHeight: next.scrollHeight
        });
        truncated = true;
        break;
      }
    }
  } finally {
    try {
      await callPageTool(tabId, 'endScreenshot', restoreScroll);
    } catch (error) {
      logger.logWarning('Failed to restore page state after screenshot', { error: error.message });
    }
  }

  const segments = await stitcher.finish();
  const result = {
    segments,
    backend: capturer.name,
    frames,
    truncated: truncated || stitcher.coveredCss < ceiling - 1,
    captureHeightLimit: ceiling,
    pageHeightAtStart: plan.scrollHeight,
    devicePixelRatio: plan.devicePixelRatio,
    imageScale: stitcher.scale,
    cssWidth: plan.region.width,
    cssHeight: stitcher.coveredCss,
    overlayHandling: overlays === 'crop' ? `sticky header band of ${topInset}px cropped from frames after the first (page not modified)` : 'fixed/sticky elements hidden after the first frame',
    fixedElementsHidden: fixedHidden ? fixedHidden.hidden : 0,
    modalOverlaysHidden,
    scrollCorrections
  };

  logger.logInfo('Full-page screenshot complete', {
    backend: result.backend,
    frames,
    segments: segments.map(s => ({ width: s.width, height: s.height })),
    cssHeight: result.cssHeight,
    imageScale: result.imageScale,
    overlayHandling: result.overlayHandling,
    scrollCorrections,
    truncated
  });

  return result;
}

/**
 * Single-viewport capture (used when full-page capture fails).
 */
export async function captureViewportScreenshot(tab) {
  const blob = await new VisibleTabCapturer(tab.windowId).capture();
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  bitmap.close();
  return {
    segments: [{ bytes: new Uint8Array(await blob.arrayBuffer()), width, height }],
    backend: 'chrome.tabs.captureVisibleTab (viewport only)',
    frames: 1,
    truncated: true
  };
}

// A window that the OS has minimised or fully covered stops compositing, and then
// neither capture backend can produce a frame - they block indefinitely. Both
// capturers therefore time out with an actionable message.
const OCCLUDED_WINDOW_HINT =
  'Screenshot timed out. Keep the browser window visible on screen (not minimised or ' +
  'fully covered by other windows) and the captured tab active while the capture runs.';

class VisibleTabCapturer {
  constructor(windowId) {
    this.windowId = windowId;
    this.lastCaptureAt = 0;
    this.name = 'browser.tabs.captureVisibleTab';
  }

  async capture() {
    const wait = this.lastCaptureAt + VISIBLE_TAB_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await delay(wait);
    this.lastCaptureAt = Date.now();
    const dataUrl = await withTimeout(
      browser.tabs.captureVisibleTab(this.windowId, { format: 'png' }),
      FRAME_TIMEOUT_MS,
      OCCLUDED_WINDOW_HINT
    );
    return (await fetch(dataUrl)).blob();
  }
}

class CdpCapturer {
  constructor(cdp) {
    this.cdp = cdp;
    this.name = 'CDP Page.captureScreenshot';
  }

  async capture() {
    const { data } = await withTimeout(
      this.cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }),
      FRAME_TIMEOUT_MS,
      OCCLUDED_WINDOW_HINT
    );
    return new Blob([base64ToBytes(data)], { type: 'image/png' });
  }
}

/**
 * Incremental stitcher. Coordinates: page CSS pixels are converted to image
 * pixels with `scale` (bitmap width / viewport CSS width).
 */
class Stitcher {
  constructor(viewportCssWidth, region) {
    this.viewportCssWidth = viewportCssWidth;
    this.regionCss = region;
    this.scale = null;
    this.width = null;
    this.segmentHeight = null;
    this.current = null;
    this.segments = [];
    this.coveredCss = 0;
  }

  /**
   * @param {number} limitCss - do not place page content below this CSS offset
   * @param {number} [topInsetCss] - ignore this many CSS px at the top of the region
   *   (a sticky header already captured in the first frame)
   */
  async addFrame(blob, scrollTop, region, limitCss, topInsetCss = 0) {
    const bitmap = await createImageBitmap(blob);
    try {
      if (this.scale === null) {
        this.scale = bitmap.width / this.viewportCssWidth;
        this.width = Math.round(this.regionCss.width * this.scale);
        this.segmentHeight = Math.min(MAX_SEGMENT_HEIGHT, Math.floor(MAX_SEGMENT_PIXELS / this.width));
      }
      const scale = this.scale;

      const startCss = Math.max(this.coveredCss, scrollTop + topInsetCss);
      const endCss = Math.min(scrollTop + region.height, limitCss);
      if (endCss <= startCss) return;

      const srcX = Math.round(region.left * scale);
      let srcY = Math.round((region.top + startCss - scrollTop) * scale);
      let y = Math.round(startCss * scale);
      const yEnd = Math.round(endCss * scale);

      while (y < yEnd && srcY < bitmap.height) {
        const segment = await this.segmentFor(y);
        const segmentTop = segment.index * this.segmentHeight;
        const h = Math.min(yEnd, segmentTop + this.segmentHeight, y + bitmap.height - srcY) - y;
        segment.ctx.drawImage(bitmap, srcX, srcY, this.width, h, 0, y - segmentTop, this.width, h);
        segment.filled = Math.max(segment.filled, y - segmentTop + h);
        srcY += h;
        y += h;
      }
      this.coveredCss = endCss;
    } finally {
      bitmap.close();
    }
  }

  async segmentFor(y) {
    const index = Math.floor(y / this.segmentHeight);
    if (this.current && this.current.index === index) return this.current;
    if (this.current) await this.flush();
    const canvas = new OffscreenCanvas(this.width, this.segmentHeight);
    this.current = { index, canvas, ctx: canvas.getContext('2d'), filled: 0 };
    return this.current;
  }

  async flush() {
    const { canvas, filled } = this.current;
    let output = canvas;
    if (filled < canvas.height) {
      output = new OffscreenCanvas(this.width, filled);
      output.getContext('2d').drawImage(canvas, 0, 0);
    }
    const blob = await output.convertToBlob({ type: 'image/png' });
    this.segments.push({
      bytes: new Uint8Array(await blob.arrayBuffer()),
      width: this.width,
      height: filled
    });
    this.current = null;
  }

  async finish() {
    if (this.current) await this.flush();
    if (this.segments.length === 0) throw new Error('No screenshot frames were captured');
    return this.segments;
  }
}

async function waitForActiveTab(tabId, logger) {
  const deadline = Date.now() + TAB_ACTIVE_WAIT_MS;
  let warned = false;
  for (;;) {
    const tab = await browser.tabs.get(tabId);
    if (tab.active) return;
    if (!warned) {
      logger.logWarning('Capture paused: target tab is not the active tab in its window');
      warned = true;
    }
    if (Date.now() > deadline) {
      throw new Error('Target tab must stay active and visible during the screenshot');
    }
    await delay(500);
  }
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
