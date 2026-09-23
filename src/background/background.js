/**
 * Background Service Worker for Exhibit
 *
 * Main entry point for background operations. Coordinates capture requests
 * from popup UI and manages the forensic data collection process.
 */

// Import browser API polyfill for cross-browser compatibility
import '../../lib/browser-polyfill.min.js';

import { CaptureManager, isUserStop } from './capture-manager.js';

// Global capture manager instance
let captureManager = null;

// Current capture state
let currentCapture = null;

/**
 * Initialize background service worker
 */
function init() {
  console.log('[Background] Exhibit initialized');

  // Create capture manager instance
  captureManager = new CaptureManager();

  // Set up message listeners
  browser.runtime.onMessage.addListener(handleMessage);

  // Listen for extension installation/update
  browser.runtime.onInstalled.addListener(handleInstalled);

  console.log('[Background] Service worker ready');
}

/**
 * Handle extension installation or update
 */
function handleInstalled(details) {
  console.log('[Background] Extension installed/updated:', details.reason);

  if (details.reason === 'install') {
    // First time installation
    console.log('[Background] First time installation');

    // Initialize storage with default settings
    browser.storage.local.set({
      captureHistory: [],
      settings: {
        version: '1.0.0',
        investigatorName: '',
        defaultCaseNumber: ''
      }
    });
  } else if (details.reason === 'update') {
    // Extension updated
    console.log('[Background] Extension updated to version', browser.runtime.getManifest().version);
  }
}

/**
 * Handle messages from popup or content scripts
 */
async function handleMessage(message, sender, sendResponse) {
  console.log('[Background] Received message:', message.type);

  try {
    switch (message.type) {
      case 'CAPTURE_REQUEST':
        return await handleCaptureRequest(message);

      case 'GET_CAPTURE_STATUS':
        return handleGetCaptureStatus();

      case 'CANCEL_CAPTURE':
        return handleCancelCapture();

      case 'GET_SETTINGS':
        return await handleGetSettings();

      case 'UPDATE_SETTINGS':
        return await handleUpdateSettings(message.settings);

      default:
        console.warn('[Background] Unknown message type:', message.type);
        return { success: false, error: 'Unknown message type' };
    }
  } catch (error) {
    console.error('[Background] Error handling message:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Handle capture request from popup
 */
async function handleCaptureRequest(message) {
  console.log('[Background] Starting capture for tab:', message.tabId);

  try {
    // Check if a capture is already in progress
    if (currentCapture && currentCapture.inProgress) {
      return {
        success: false,
        error: 'A capture is already in progress'
      };
    }

    // Validate tab ID
    if (!message.tabId) {
      return {
        success: false,
        error: 'Invalid tab ID'
      };
    }

    // Get tab information
    const tab = await browser.tabs.get(message.tabId);

    if (!tab || !tab.url) {
      return {
        success: false,
        error: 'Unable to access tab information'
      };
    }

    // Check if URL is capturable (not chrome:// or about:// pages)
    if (tab.url.startsWith('chrome://') ||
        tab.url.startsWith('about:') ||
        tab.url.startsWith('chrome-extension://')) {
      return {
        success: false,
        error: 'Cannot capture browser internal pages'
      };
    }

    // Initialize capture state
    currentCapture = {
      inProgress: true,
      tabId: message.tabId,
      url: tab.url,
      title: tab.title || 'Untitled',
      startTime: Date.now()
    };

    // Start capture process (don't await - let it run asynchronously)
    captureManager.startCapture(tab, message.options || {})
      .then(result => {
        console.log('[Background] Capture completed successfully');
        currentCapture.inProgress = false;
        currentCapture.result = result;

        // Notify popup of completion
        browser.runtime.sendMessage({
          type: 'CAPTURE_COMPLETE',
          result: result
        }).catch(err => {
          // Popup might be closed, that's okay
          console.log('[Background] Could not notify popup (may be closed)');
        });
      })
      .catch(error => {
        // A user stop is already logged once by the capture manager; it is not a fault.
        const userStop = isUserStop(error);
        if (!userStop) console.error('[Background] Capture failed:', error);
        currentCapture.inProgress = false;
        currentCapture.error = error.message;

        // Notify popup of error
        browser.runtime.sendMessage({
          type: 'CAPTURE_ERROR',
          error: {
            message: error.message,
            details: userStop ? null : error.stack
          }
        }).catch(err => {
          console.log('[Background] Could not notify popup (may be closed)');
        });
      });

    return {
      success: true,
      message: 'Capture started'
    };

  } catch (error) {
    console.error('[Background] Error starting capture:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Handle get capture status request
 */
function handleGetCaptureStatus() {
  if (!currentCapture) {
    return {
      isCapturing: false
    };
  }

  return {
    isCapturing: currentCapture.inProgress,
    currentStep: captureManager ? captureManager.getCurrentStep() : null,
    progress: captureManager ? captureManager.getProgress() : 0,
    tabId: currentCapture.tabId,
    url: currentCapture.url
  };
}

/**
 * Handle cancel capture request
 */
function handleCancelCapture() {
  if (!currentCapture || !currentCapture.inProgress) {
    return {
      success: false,
      error: 'No capture in progress'
    };
  }

  try {
    if (captureManager) {
      captureManager.cancelCapture();
    }

    currentCapture.inProgress = false;
    currentCapture.cancelled = true;

    return {
      success: true,
      message: 'Capture cancelled'
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Handle get settings request
 */
async function handleGetSettings() {
  try {
    const result = await browser.storage.local.get('settings');
    return {
      success: true,
      settings: result.settings || {
        version: '1.0.0',
        investigatorName: '',
        defaultCaseNumber: ''
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Handle update settings request
 */
async function handleUpdateSettings(settings) {
  try {
    await browser.storage.local.set({ settings });
    return {
      success: true,
      message: 'Settings updated'
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Send progress update to popup
 */
export function sendProgressUpdate(step, progress, details) {
  browser.runtime.sendMessage({
    type: 'CAPTURE_PROGRESS',
    step: step,
    progress: progress,
    details: details
  }).catch(err => {
    // Popup might be closed, that's okay
    console.log('[Background] Could not send progress update (popup may be closed)');
  });
}

// Initialize when service worker starts
init();
