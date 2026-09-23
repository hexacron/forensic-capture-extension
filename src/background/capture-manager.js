/**
 * Capture Manager for Forensic Data Capture Extension
 *
 * Orchestrates the entire forensic capture process including:
 * - Threads post preparation (reply loading) when the tab is a Threads post
 * - Full-page screenshot capture
 * - DOM structure capture
 * - Browser storage capture (cookies, localStorage, sessionStorage, IndexedDB)
 * - Hash generation
 * - Forensic manifest creation
 * - File downloads
 *
 * Every output file is built once as bytes, hashed from those exact bytes, and
 * downloaded from those exact bytes, so hashes.txt verifies the saved files.
 */

// Import browser API polyfill
import '../../lib/browser-polyfill.min.js';

import { createForensicLogger, Action, Actor } from '../utils/logger.js';
import { getFilenameTimestamp, getCurrentTimestamp } from '../utils/timestamp-utils.js';
import { generateSHA256 } from '../utils/crypto-utils.js';
import { generateForensicManifest } from './forensic-metadata.js';
import { DownloadManager } from './download-manager.js';
import { sendProgressUpdate } from './background.js';
import { captureFullPageScreenshot, captureViewportScreenshot } from './screenshot-capture.js';
import { ThreadsCaptureSession } from './threads-capture.js';
import { parseThreadsPostUrl } from '../threads/threads-parser.js';
import { renderThreadReport } from '../threads/threads-report.js';
import { createZip } from '../utils/zip-writer.js';

const textEncoder = new TextEncoder();

/**
 * Capture Manager Class
 */
export class CaptureManager {
  constructor() {
    this.currentStep = null;
    this.progress = 0;
    this.cancelled = false;
    this.downloadManager = new DownloadManager();
  }

  /**
   * Get current capture step
   */
  getCurrentStep() {
    return this.currentStep;
  }

  /**
   * Get current progress (0-100)
   */
  getProgress() {
    return this.progress;
  }

  /**
   * Cancel ongoing capture
   */
  cancelCapture() {
    this.cancelled = true;
    console.log('[CaptureManager] Capture cancelled by user');
  }

  throwIfCancelled() {
    if (this.cancelled) throw new Error('Capture cancelled by user');
  }

  /**
   * Start forensic capture for a tab
   * @param {Object} tab - Browser tab object
   * @param {Object} [options] - { threadsMode: boolean, threads: ThreadsCaptureSession options }
   * @returns {Promise<Object>} Capture result
   */
  async startCapture(tab, options = {}) {
    console.log('[CaptureManager] Starting capture for:', tab.url);

    const captureId = crypto.randomUUID();
    const timestamp = getFilenameTimestamp();
    const threadsTarget = options.threadsMode === false ? null : parseThreadsPostUrl(tab.url);

    const logger = createForensicLogger(captureId);
    logger.logChain(Action.CAPTURE_INITIATED, Actor.USER, {
      url: tab.url,
      title: tab.title,
      tabId: tab.id,
      mode: threadsTarget ? 'threads-post' : 'generic',
      options
    });
    logger.incrementAttempts();

    this.cancelled = false;
    let threads = null;

    try {
      this.updateProgress('init', 3, 'Initializing capture...');
      logger.logInfo('Initializing capture', { tabId: tab.id, url: tab.url });

      const captureData = {
        captureId,
        timestamp: getCurrentTimestamp(),
        filenameTimestamp: timestamp,
        url: tab.url,
        title: tab.title,
        tabId: tab.id
      };

      // The tab the evidence is taken from. A Threads session may load the post fresh
      // in its own tab, leaving the user's tab untouched.
      let captureTab = tab;
      if (threadsTarget) {
        threads = new ThreadsCaptureSession({
          tab,
          target: threadsTarget,
          logger,
          options: options.threads,
          isCancelled: () => this.cancelled,
          progress: (percent, detail) => this.updateProgress('threads', percent, detail)
        });
        this.updateProgress('threads', 5, 'Preparing Threads capture...');
        await threads.prepare();
        captureTab = threads.tab;
        captureData.captureTabId = captureTab.id;
        await threads.loadAllReplies();
        logger.logChain(Action.THREADS_REPLIES_LOADED, Actor.AUTOMATED, threads.loadSummary);
        this.throwIfCancelled();
      }

      this.updateProgress('screenshot', 45, 'Capturing full-page screenshot...');
      const screenshot = await this.captureScreenshot(captureTab, logger, threads);
      captureData.screenshotSegments = screenshot.segments;
      captureData.screenshotInfo = {
        backend: screenshot.backend,
        frames: screenshot.frames,
        truncated: screenshot.truncated,
        devicePixelRatio: screenshot.devicePixelRatio ?? null,
        imageScale: screenshot.imageScale ?? null,
        cssWidth: screenshot.cssWidth ?? null,
        cssHeight: screenshot.cssHeight ?? null,
        fixedElementsHidden: screenshot.fixedElementsHidden ?? 0,
        modalOverlaysHidden: screenshot.modalOverlaysHidden ?? 0,
        overlayHandling: screenshot.overlayHandling ?? null,
        scrollCorrections: screenshot.scrollCorrections ?? 0,
        segments: screenshot.segments.map(s => ({ width: s.width, height: s.height }))
      };
      logger.logChain(Action.SCREENSHOT_COMPLETED, Actor.AUTOMATED, { segments: screenshot.segments.length });
      this.throwIfCancelled();

      this.updateProgress('dom', 72, 'Capturing DOM structure...');
      captureData.dom = await this.captureDOMStructure(captureTab.id, logger);
      logger.logChain(Action.DOM_CAPTURED, Actor.AUTOMATED);
      this.throwIfCancelled();

      this.updateProgress('cookies', 74, 'Capturing cookies...');
      captureData.cookies = await this.captureCookies(captureTab.url, logger);
      logger.logChain(Action.COOKIES_CAPTURED, Actor.AUTOMATED);
      this.throwIfCancelled();

      this.updateProgress('storage', 76, 'Capturing browser storage...');
      captureData.storage = await this.captureStorage(captureTab.id, logger);
      logger.logChain(Action.STORAGE_CAPTURED, Actor.AUTOMATED);
      this.throwIfCancelled();

      if (threads) {
        captureData.threads = await threads.finalize();
        logger.logChain(Action.THREADS_DATA_EXTRACTED, Actor.AUTOMATED, captureData.threads.dataset.statistics);
        this.throwIfCancelled();
      }

      this.updateProgress('hashing', 88, 'Generating integrity hashes...');
      const files = this.buildEvidenceFiles(captureData);
      await hashFiles(files);

      if (captureData.threads) {
        const report = await this.buildThreadReport(captureData, files);
        await hashFiles([report]);
        files.push(report);
      }
      logger.logChain(Action.HASHES_GENERATED, Actor.AUTOMATED, { files: files.length });

      this.updateProgress('manifest', 92, 'Creating forensic manifest...');
      const manifestFile = await this.createManifest(captureData, files, logger);
      logger.logChain(Action.MANIFEST_CREATED, Actor.AUTOMATED);

      this.updateProgress('download', 95, 'Packaging and saving evidence...');
      const folderName = `forensic-capture-${timestamp}`;
      const saved = await this.savePackage(folderName, timestamp, [...files, manifestFile], captureData.timestamp, logger);
      logger.logChain(Action.DOWNLOAD_COMPLETED, Actor.AUTOMATED, { package: saved.filename, sha256: saved.sha256 });

      this.updateProgress('complete', 100, 'Capture complete');
      logger.markCompleted();
      console.log('[CaptureManager] Capture completed successfully');

      const allFiles = [...files, manifestFile];
      return {
        success: true,
        captureId,
        timestamp: captureData.timestamp,
        url: tab.url,
        folder: folderName,
        packageFile: saved.filename,
        packageSha256: saved.sha256,
        packageSize: saved.size,
        filesCount: allFiles.length + 1, // + hashes file
        totalSize: allFiles.reduce((sum, f) => sum + f.size, 0),
        screenshotSegments: captureData.screenshotSegments.length,
        threads: captureData.threads
          ? { ...captureData.threads.dataset.statistics, warnings: captureData.threads.dataset.warnings.length }
          : null
      };
    } catch (error) {
      console.error('[CaptureManager] Capture failed:', error);
      logger.logError('Capture failed', error);
      logger.markFailed(error.message);
      throw error;
    } finally {
      if (threads) await threads.dispose();
    }
  }

  /**
   * Update progress and send to popup
   */
  updateProgress(step, progress, details) {
    this.currentStep = step;
    this.progress = progress;
    sendProgressUpdate(step, progress, details);
  }

  /**
   * Capture full-page screenshot, falling back to the visible viewport.
   */
  async captureScreenshot(tab, logger, threads) {
    logger.logChain(Action.SCREENSHOT_STARTED, Actor.AUTOMATED);

    try {
      return await captureFullPageScreenshot(tab, logger, {
        cdp: threads ? threads.cdp : null,
        maxCssHeight: threads ? await threads.screenshotHeightLimit() : null,
        // Threads: leave the page unmodified (crop the sticky header band instead of
        // restyling it), scroll with trusted wheel input and human-paced settling.
        overlays: threads ? 'crop' : 'hide',
        restoreScroll: !threads,
        // Signed out there is no account at stake: hide login prompts and allow exact
        // programmatic positioning when wheel scrolling cannot move the page.
        hideModals: Boolean(threads) && !threads.signedIn,
        exactFallback: !(threads && threads.signedIn),
        scrollTo: threads && threads.human ? (target, position) => threads.screenshotScrollTo(target, position) : null,
        settle: threads ? () => threads.screenshotSettle() : undefined,
        beforeFrame: threads ? () => threads.dismissDialogs() : null,
        onFrame: threads ? () => threads.harvestVisible() : null,
        isCancelled: () => this.cancelled,
        onProgress: (frames, estimated) => {
          const percent = 45 + Math.min(25, Math.round((frames / estimated) * 25));
          this.updateProgress('screenshot', percent, `Captured section ${frames}/${estimated}`);
        }
      });
    } catch (error) {
      if (this.cancelled) throw error;
      logger.logError('Full-page screenshot failed', error);
      logger.logWarning('Attempting fallback to viewport capture');
      try {
        return await captureViewportScreenshot(tab);
      } catch (fallbackError) {
        throw new Error(`Screenshot capture failed: ${error.message}; fallback: ${fallbackError.message}`);
      }
    }
  }

  /**
   * Ensure content script is injected
   */
  async ensureContentScriptInjected(tabId) {
    try {
      // Try to ping the content script
      await browser.tabs.sendMessage(tabId, { type: 'PING' });
      return true; // Content script already loaded
    } catch (error) {
      // Content script not loaded, inject it
      console.log('[CaptureManager] Content script not loaded, injecting...');

      try {
        // Inject polyfill first
        await browser.scripting.executeScript({
          target: { tabId: tabId },
          files: ['lib/browser-polyfill.min.js']
        });

        // Inject standalone content script
        await browser.scripting.executeScript({
          target: { tabId: tabId },
          files: ['src/content/content-injector.js']
        });

        // Wait for initialization
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Verify injection worked
        try {
          await browser.tabs.sendMessage(tabId, { type: 'PING' });
          console.log('[CaptureManager] Content script injected successfully');
          return true;
        } catch (pingError) {
          throw new Error('Content script injected but not responding');
        }
      } catch (injectError) {
        console.error('[CaptureManager] Failed to inject content script:', injectError);
        throw new Error(`Failed to inject content script: ${injectError.message}`);
      }
    }
  }

  /**
   * Capture DOM structure from content script
   */
  async captureDOMStructure(tabId, logger) {
    try {
      // Ensure content script is loaded
      await this.ensureContentScriptInjected(tabId);

      // Send message to content script to capture DOM
      const response = await browser.tabs.sendMessage(tabId, {
        type: 'CAPTURE_DOM'
      });

      if (response && response.success) {
        logger.logInfo('DOM structure captured', {
          htmlSize: response.data.html ? response.data.html.length : 0,
          title: response.data.title
        });

        return response.data;
      } else {
        throw new Error(response.error || 'Failed to capture DOM');
      }
    } catch (error) {
      logger.logError('Failed to capture DOM structure', error);
      throw new Error(`DOM capture failed: ${error.message}`);
    }
  }

  /**
   * Capture cookies for the current URL
   */
  async captureCookies(url, logger) {
    try {
      const cookies = await browser.cookies.getAll({ url });

      logger.logInfo('Cookies captured', {
        count: cookies.length
      });

      // Format cookies for forensic storage
      return cookies.map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expirationDate: cookie.expirationDate,
        hostOnly: cookie.hostOnly,
        session: cookie.session
      }));
    } catch (error) {
      logger.logError('Failed to capture cookies', error);
      // Don't throw - cookies might be blocked, but continue capture
      logger.logWarning('Continuing without cookies');
      return [];
    }
  }

  /**
   * Capture browser storage (localStorage, sessionStorage, IndexedDB)
   */
  async captureStorage(tabId, logger) {
    logger.logChain(Action.STORAGE_ACCESSED, Actor.AUTOMATED);

    try {
      // Ensure content script is loaded
      await this.ensureContentScriptInjected(tabId);

      // Send message to content script to capture storage
      const response = await browser.tabs.sendMessage(tabId, {
        type: 'CAPTURE_STORAGE'
      });

      if (response && response.success) {
        logger.logInfo('Browser storage captured', {
          localStorageKeys: response.data.localStorage ? Object.keys(response.data.localStorage).length : 0,
          sessionStorageKeys: response.data.sessionStorage ? Object.keys(response.data.sessionStorage).length : 0,
          indexedDBCount: response.data.indexedDB ? response.data.indexedDB.length : 0
        });

        return response.data;
      } else {
        throw new Error(response.error || 'Failed to capture storage');
      }
    } catch (error) {
      logger.logError('Failed to capture browser storage', error);
      // Don't throw - storage might be restricted, but continue capture
      logger.logWarning('Continuing without complete storage data');
      return {
        localStorage: {},
        sessionStorage: {},
        indexedDB: [],
        error: error.message
      };
    }
  }

  /**
   * Build every evidence file except the report, manifest and hash list.
   * @returns {Array<{path, type, mimeType, bytes, sourceUrl?}>}
   */
  buildEvidenceFiles(captureData) {
    const ts = captureData.filenameTimestamp;
    const files = [];

    const segments = captureData.screenshotSegments;
    segments.forEach((segment, index) => {
      const suffix = segments.length === 1 ? '' : `-part${String(index + 1).padStart(2, '0')}`;
      files.push({ path: `${ts}-screenshot${suffix}.png`, type: 'screenshot', mimeType: 'image/png', bytes: segment.bytes });
    });

    files.push(jsonFile(`${ts}-dom.json`, 'dom', captureData.dom));
    files.push(jsonFile(`${ts}-storage.json`, 'storage', captureData.storage));
    files.push(jsonFile(`${ts}-cookies.json`, 'cookies', captureData.cookies));

    const threads = captureData.threads;
    if (threads) {
      const { dataset, summary } = threads;
      files.push(jsonFile(`${ts}-thread.json`, 'threads-data', {
        captureId: captureData.captureId,
        capturedAt: captureData.timestamp,
        target: summary.target,
        finalUrl: summary.finalUrl,
        statistics: dataset.statistics,
        warnings: dataset.warnings,
        repliesWithUncapturedChildren: dataset.repliesWithUncapturedChildren,
        posts: dataset.posts,
        relatedPosts: dataset.relatedPosts
      }));
      files.push(jsonFile(`raw/${ts}-threads-api-responses.json`, 'threads-api-responses', {
        devtoolsProtocol: summary.devtoolsProtocol,
        note: 'Request tokens (fb_dtsg, lsd, jazoest) are intentionally not recorded',
        responses: threads.rawNetwork
      }));
      files.push(jsonFile(`raw/${ts}-threads-embedded-data.json`, 'threads-embedded-data', threads.rawEmbedded));
      files.push(jsonFile(`raw/${ts}-threads-dom-posts.json`, 'threads-dom-posts', threads.domPosts));
      files.push(...threads.mediaFiles);
    }

    return files;
  }

  async buildThreadReport(captureData, files) {
    const settings = (await browser.storage.local.get('settings')).settings || {};
    const html = renderThreadReport({
      dataset: captureData.threads.dataset,
      capture: {
        captureId: captureData.captureId,
        timestamp: captureData.timestamp,
        url: captureData.url,
        finalUrl: captureData.threads.summary.finalUrl,
        extensionVersion: browser.runtime.getManifest().version,
        investigator: settings.investigatorName || 'Not specified',
        caseNumber: settings.defaultCaseNumber || 'Not specified',
        method: `${captureData.screenshotInfo.backend} screenshots; reply loading ${
          captureData.threads.summary.replyLoading && captureData.threads.summary.replyLoading.enabled ? 'enabled' : 'disabled'
        }; DevTools protocol ${captureData.threads.summary.devtoolsProtocol}`
      },
      files,
      screenshots: files.filter(f => f.type === 'screenshot').map(f => f.path)
    });
    return {
      path: `${captureData.filenameTimestamp}-thread-report.html`,
      type: 'threads-report',
      mimeType: 'text/html',
      bytes: textEncoder.encode(html)
    };
  }

  /**
   * Create the forensic manifest file (hashed; its hash goes to hashes.txt).
   */
  async createManifest(captureData, files, logger) {
    try {
      const manifest = await generateForensicManifest({ ...captureData, files }, logger);
      const file = jsonFile(`${captureData.filenameTimestamp}-manifest.json`, 'manifest', manifest);
      await hashFiles([file]);

      logger.logInfo('Forensic manifest created', {
        captureId: manifest.forensicMetadata.captureId,
        filesCount: manifest.capturedFiles.length
      });

      return file;
    } catch (error) {
      logger.logError('Failed to create manifest', error);
      throw new Error(`Manifest creation failed: ${error.message}`);
    }
  }

  /**
   * Save the capture as one ZIP (one download, so one save prompt): the capture
   * folder with every evidence file plus hashes.txt. The archive's own SHA-256 is
   * returned for the popup and capture history; it cannot be stored inside itself.
   */
  async savePackage(folderName, timestamp, files, capturedAt, logger) {
    const hashList = {
      path: `${timestamp}-hashes.txt`,
      bytes: textEncoder.encode(files.map(f => `${f.sha256}  ${f.path}`).join('\n') + '\n')
    };
    const archive = await createZip(
      [...files, hashList].map(f => ({ path: `${folderName}/${f.path}`, bytes: f.bytes })),
      new Date(capturedAt)
    );
    const sha256 = await generateSHA256(archive);
    const filename = `${folderName}.zip`;
    logger.logChain(Action.DOWNLOAD_INITIATED, Actor.AUTOMATED, { package: filename, files: files.length + 1, size: archive.length, sha256 });

    const [result] = await this.downloadManager.downloadFiles([
      { filename, bytes: archive, mimeType: 'application/zip' }
    ]);
    if (!result || !result.success) {
      const error = result ? result.error : 'no download result';
      logger.logChain(Action.DOWNLOAD_FAILED, Actor.AUTOMATED, { package: filename, error });
      throw new Error(`Saving ${filename} failed: ${error}`);
    }

    logger.logInfo('Evidence package saved', { package: filename, files: files.length + 1, size: archive.length, sha256 });
    return { filename, sha256, size: archive.length };
  }
}

function jsonFile(path, type, data) {
  return {
    path,
    type,
    mimeType: 'application/json',
    bytes: textEncoder.encode(JSON.stringify(data, null, 2))
  };
}

async function hashFiles(files) {
  for (const file of files) {
    file.sha256 = await generateSHA256(file.bytes);
    file.size = file.bytes.length;
  }
}
