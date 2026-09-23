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
 * @param {boolean} [options.hideModals] - Hide modal dialogs and their dimming layer before every frame (sites that re-open login prompts on scroll)
 * @param {Function} [options.beforeFrame] - Awaited before every frame (e.g. closing a re-opened dialog that scroll-locks the page)
 * @param {Function} [options.onFrame] - Awaited after each frame (e.g. harvesting virtualized content)
 * @param {Function} [options.onProgress] - Called with (framesCaptured, estimatedFrames)
 * @param {Function} [options.isCancelled] - Returns true to abort
 * @returns {Promise<Object>} { segments: [{bytes, width, height}], backend, frames, ... }
 */
export async function captureFullPageScreenshot(tab, logger, options = {}) {
  const { cdp = null, maxCssHeight = null, hideModals = false, beforeFrame = null, onFrame = null, onProgress = null, isCancelled = () => false } = options;
  const tabId = tab.id;

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
  let modalOverlaysHidden = 0;

  try {
    await callPageTool(tabId, 'scrollToY', 0);
    await delay(SETTLE_DELAY_MS);

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
      const pos = await callPageTool(tabId, 'position');
      const image = await capturer.capture();
      await stitcher.addFrame(image, pos.scrollTop, pos.region, ceiling);
      frames++;

      if (onProgress) onProgress(frames, Math.max(frames, estimatedFrames));
      if (onFrame) await onFrame(frames);

      if (fixedHidden === null) {
        fixedHidden = await callPageTool(tabId, 'hideFixedElements');
      }

      if (stitcher.coveredCss >= ceiling - 1) break;

      const nextTop = Math.min(pos.scrollTop + pos.region.height, Math.max(0, ceiling - pos.region.height));
      if (nextTop <= pos.scrollTop) break;
      const next = await callPageTool(tabId, 'scrollToY', nextTop);
      if (next.scrollTop <= pos.scrollTop) {
        logger.logWarning('Page stopped scrolling before reaching the end', {
          scrollTop: next.scrollTop,
          scrollHeight: next.scrollHeight
        });
        truncated = true;
        break;
      }
      await delay(SETTLE_DELAY_MS);
    }
  } finally {
    try {
      await callPageTool(tabId, 'endScreenshot');
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
    fixedElementsHidden: fixedHidden ? fixedHidden.hidden : 0,
    modalOverlaysHidden
  };

  logger.logInfo('Full-page screenshot complete', {
    backend: result.backend,
    frames,
    segments: segments.map(s => ({ width: s.width, height: s.height })),
    cssHeight: result.cssHeight,
    imageScale: result.imageScale,
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

  /** @param {number} limitCss - do not place page content below this CSS offset */
  async addFrame(blob, scrollTop, region, limitCss) {
    const bitmap = await createImageBitmap(blob);
    try {
      if (this.scale === null) {
        this.scale = bitmap.width / this.viewportCssWidth;
        this.width = Math.round(this.regionCss.width * this.scale);
        this.segmentHeight = Math.min(MAX_SEGMENT_HEIGHT, Math.floor(MAX_SEGMENT_PIXELS / this.width));
      }
      const scale = this.scale;

      const startCss = Math.max(this.coveredCss, scrollTop);
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
