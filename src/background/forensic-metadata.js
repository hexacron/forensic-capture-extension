/**
 * Forensic Metadata Generator for Forensic Data Capture Extension
 *
 * Generates comprehensive forensic manifests that include:
 * - Forensic metadata (capture ID, timestamps, browser info)
 * - Target page information
 * - Captured files with hashes
 * - Chain of custody
 * - Audit trail
 * - Integrity verification data
 */

// Import browser API polyfill
import '../../lib/browser-polyfill.min.js';

import { getCurrentTimestamp } from '../utils/timestamp-utils.js';

/**
 * Get browser information
 */
async function getBrowserInfo() {
  const userAgent = navigator.userAgent;

  // Parse browser name and version from user agent
  let browserName = 'Unknown';
  let browserVersion = 'Unknown';

  if (userAgent.includes('Chrome/') && !userAgent.includes('Edg/')) {
    browserName = 'Chrome';
    const match = userAgent.match(/Chrome\/([0-9.]+)/);
    if (match) browserVersion = match[1];
  } else if (userAgent.includes('Firefox/')) {
    browserName = 'Firefox';
    const match = userAgent.match(/Firefox\/([0-9.]+)/);
    if (match) browserVersion = match[1];
  } else if (userAgent.includes('Safari/') && !userAgent.includes('Chrome')) {
    browserName = 'Safari';
    const match = userAgent.match(/Version\/([0-9.]+)/);
    if (match) browserVersion = match[1];
  } else if (userAgent.includes('Edg/')) {
    browserName = 'Edge';
    const match = userAgent.match(/Edg\/([0-9.]+)/);
    if (match) browserVersion = match[1];
  }

  return {
    name: browserName,
    version: browserVersion,
    userAgent: userAgent,
    platform: navigator.platform,
    language: navigator.language
  };
}

/**
 * Get operating system information
 */
function getOperatingSystem() {
  const platform = navigator.platform;
  const userAgent = navigator.userAgent;

  if (platform.includes('Win')) {
    return 'Windows';
  } else if (platform.includes('Mac')) {
    return 'macOS';
  } else if (platform.includes('Linux')) {
    return 'Linux';
  } else if (platform.includes('iPhone') || platform.includes('iPad')) {
    return 'iOS';
  } else if (userAgent.includes('Android')) {
    return 'Android';
  }

  return platform || 'Unknown';
}

/**
 * Get extension version
 */
function getExtensionVersion() {
  return browser.runtime.getManifest().version;
}

/**
 * Get user settings (investigator name, case number)
 */
async function getUserSettings() {
  try {
    const result = await browser.storage.local.get('settings');
    return result.settings || {};
  } catch (error) {
    console.error('Failed to get user settings:', error);
    return {};
  }
}

/**
 * Generate forensic manifest
 * @param {Object} captureData - Complete capture data
 * @param {Object} logger - Forensic logger instance
 * @returns {Promise<Object>} Forensic manifest
 */
export async function generateForensicManifest(captureData, logger) {
  const browserInfo = await getBrowserInfo();
  const os = getOperatingSystem();
  const extensionVersion = getExtensionVersion();
  const userSettings = await getUserSettings();

  // Build forensic manifest
  const manifest = {
    // Forensic metadata section
    forensicMetadata: {
      captureId: captureData.captureId,
      version: extensionVersion,
      timestamp: captureData.timestamp,
      timestampFormat: 'ISO-8601-UTC',
      timezone: 'UTC',
      capturedBy: `Forensic Data Capture Extension v${extensionVersion}`,
      browser: {
        name: browserInfo.name,
        version: browserInfo.version,
        userAgent: browserInfo.userAgent,
        platform: browserInfo.platform,
        language: browserInfo.language
      },
      operatingSystem: os,
      investigator: userSettings.investigatorName || 'Not specified',
      caseNumber: userSettings.defaultCaseNumber || 'Not specified'
    },

    // Target page information
    targetPage: {
      url: captureData.url,
      title: captureData.title,
      captureTimestamp: captureData.timestamp,
      domMetadata: captureData.dom ? {
        characterSet: captureData.dom.metadata?.characterSet || 'UTF-8',
        contentType: captureData.dom.metadata?.contentType || 'text/html',
        referrer: captureData.dom.metadata?.referrer || '',
        lastModified: captureData.dom.metadata?.lastModified || ''
      } : null
    },

    // Captured files with hashes (the manifest itself is hashed in the hashes file)
    capturedFiles: captureData.files.map(f => ({
      filename: f.path,
      type: f.type,
      size: f.size,
      mimeType: f.mimeType,
      sha256: f.sha256,
      captureMethod: getCaptureMethod(f.type, captureData),
      ...(f.sourceUrl ? { sourceUrl: f.sourceUrl } : {})
    })),

    // Integrity verification
    integrityVerification: {
      hashAlgorithm: 'SHA-256',
      manifestHashLocation: `${captureData.filenameTimestamp}-hashes.txt`,
      verificationInstructions: 'From inside the capture folder run: shasum -a 256 -c *-hashes.txt (macOS) or sha256sum -c *-hashes.txt (Linux)'
    },

    // Chain of custody
    chainOfCustody: logger ? logger.chainOfCustody.getChain() : [],

    // Audit trail
    auditTrail: logger ? {
      captureAttempts: logger.captureAttempts,
      captureErrors: logger.auditTrail.getErrors(),
      captureWarnings: logger.auditTrail.getWarnings(),
      retries: logger.retries,
      completionStatus: logger.endTime
        ? (logger.auditTrail.hasErrors() ? 'completed-with-errors' : 'success')
        : 'in-progress',
      duration: logger.endTime ? logger.endTime - logger.startTime : null
    } : null,

    // Capture constraints and limitations
    captureConstraints: buildCaptureConstraints(captureData),

    // Screenshot details
    screenshot: captureData.screenshotInfo || null,

    // Threads-specific capture details
    threadsCapture: captureData.threads ? captureData.threads.summary : null,

    // Technical details
    technicalDetails: {
      extensionVersion: extensionVersion,
      manifestVersion: browser.runtime.getManifest().manifest_version,
      captureMethodology: 'WebExtensions API - Cross-browser compatible',
      screenshotMethod: captureData.screenshotInfo
        ? `${captureData.screenshotInfo.backend} (scroll-and-stitch)`
        : 'none',
      domCaptureMethod: 'document.documentElement.outerHTML',
      storageCaptureMethod: 'Page context injection with postMessage bridge',
      cookieCaptureMethod: 'browser.cookies.getAll()',
      hashingMethod: 'crypto.subtle.digest("SHA-256")'
    }
  };

  return manifest;
}

/**
 * Get capture method description for file type
 */
function getCaptureMethod(type, captureData) {
  const screenshotBackend = captureData.screenshotInfo ? captureData.screenshotInfo.backend : 'n/a';
  const methods = {
    'screenshot': `Scroll-and-stitch full-page capture via ${screenshotBackend}, PNG`,
    'dom': 'Content script access to document.documentElement.outerHTML at end of capture',
    'storage': 'Injected page-context script with postMessage bridge (localStorage, sessionStorage, IndexedDB)',
    'cookies': 'browser.cookies.getAll() with full cookie attributes',
    'threads-data': 'Normalized Threads posts merged from embedded Relay data, GraphQL responses and rendered DOM',
    'threads-report': 'Human-readable HTML rendering of the Threads data file',
    'threads-api-responses': 'Raw /api/graphql response bodies recorded via Chrome DevTools Protocol Network domain',
    'threads-embedded-data': 'Raw script[type="application/json"][data-sjs] payloads from the post page',
    'threads-dom-posts': 'Per-post outerHTML and rendered text harvested while scrolling the virtualized list',
    'media': 'Fetched from the Threads CDN URL in the API data at capture time (credentials omitted)'
  };

  return methods[type] || 'Unknown capture method';
}

/**
 * Build capture constraints and limitations
 */
function buildCaptureConstraints(captureData) {
  const constraints = [
    'Dynamic content may have changed during capture',
    'Capture represents a single point in time',
    'Some content may be loaded asynchronously after capture'
  ];

  // Add specific constraints based on what was captured
  if (captureData.screenshotInfo) {
    constraints.push('Full-page screenshot is stitched from sequential viewport captures; fixed/sticky overlays appear only in the first frame');
    if (captureData.screenshotInfo.modalOverlaysHidden) {
      constraints.push(`${captureData.screenshotInfo.modalOverlaysHidden} modal dialog overlay(s) (e.g. login prompts) were hidden before screenshot frames so they would not cover the content`);
    }
    if (captureData.screenshotInfo.truncated) {
      constraints.push('Screenshot is incomplete (viewport-only fallback or frame limit reached)');
    }
  }

  if (captureData.threads) {
    constraints.push('Threads renders a virtualized list: the DOM file reflects only posts rendered at the end of capture; per-post HTML is in the Threads DOM posts file');
    constraints.push('Threads content visible depends on the logged-in account (blocks, restrictions, hidden replies)');
    for (const warning of captureData.threads.summary.warnings) {
      constraints.push(`Threads: ${warning}`);
    }
  }

  if (captureData.storage && captureData.storage.error) {
    constraints.push(`Storage capture limitation: ${captureData.storage.error}`);
  }

  if (!captureData.cookies || captureData.cookies.length === 0) {
    constraints.push('No cookies were accessible or present for this site');
  }

  // Browser-specific constraints
  const browserInfo = navigator.userAgent;
  if (browserInfo.includes('Firefox')) {
    constraints.push('Firefox: IndexedDB may be blocked if cookies are disabled in browser settings');
  } else if (browserInfo.includes('Safari')) {
    constraints.push('Safari: Storage access may require user permission in privacy settings');
  }

  return constraints;
}

/**
 * Validate manifest structure
 */
export function validateManifest(manifest) {
  const errors = [];

  // Check required sections
  if (!manifest.forensicMetadata) {
    errors.push('Missing forensicMetadata section');
  }

  if (!manifest.targetPage) {
    errors.push('Missing targetPage section');
  }

  if (!manifest.capturedFiles || !Array.isArray(manifest.capturedFiles)) {
    errors.push('Missing or invalid capturedFiles section');
  }

  if (!manifest.integrityVerification) {
    errors.push('Missing integrityVerification section');
  }

  if (!manifest.chainOfCustody || !Array.isArray(manifest.chainOfCustody)) {
    errors.push('Missing or invalid chainOfCustody section');
  }

  // Validate forensic metadata
  if (manifest.forensicMetadata) {
    if (!manifest.forensicMetadata.captureId) {
      errors.push('Missing captureId in forensicMetadata');
    }

    if (!manifest.forensicMetadata.timestamp) {
      errors.push('Missing timestamp in forensicMetadata');
    }
  }

  // Validate captured files
  if (Array.isArray(manifest.capturedFiles)) {
    manifest.capturedFiles.forEach((file, index) => {
      if (!file.filename) {
        errors.push(`File ${index}: Missing filename`);
      }

      if (!file.sha256) {
        errors.push(`File ${index}: Missing SHA-256 hash`);
      }

      if (file.size === undefined || file.size === null) {
        errors.push(`File ${index}: Missing size`);
      }
    });
  }

  return {
    valid: errors.length === 0,
    errors: errors
  };
}
