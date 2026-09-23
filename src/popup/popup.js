/**
 * Popup UI Logic for Forensic Data Capture Extension
 *
 * Handles user interactions and communication with background service worker
 */

import { parseThreadsPostUrl, isThreadsUrl } from '../threads/threads-parser.js';

const THREADS_OPTION_INPUTS = {
  loadAllReplies: 'optLoadAllReplies',
  reloadBeforeCapture: 'optReloadBeforeCapture',
  downloadMedia: 'optDownloadMedia',
  carefulPacing: 'optCarefulPacing'
};

// DOM elements
let captureButton;
let statusSection;
let statusIcon;
let statusText;
let statusProgress;
let progressFill;
let progressText;
let statusDetails;
let resultSection;
let resultInfo;
let errorSection;
let errorText;
let errorDetails;
let historySection;
let historyList;
let threadsSection;
let threadsTarget;

// Capture state
let isCapturing = false;
let messageListener = null;
let threadsPost = null;

/**
 * Initialize popup
 */
function init() {
  // Get DOM elements
  captureButton = document.getElementById('captureButton');
  statusSection = document.getElementById('statusSection');
  statusIcon = document.getElementById('statusIcon');
  statusText = document.getElementById('statusText');
  statusProgress = document.getElementById('statusProgress');
  progressFill = document.getElementById('progressFill');
  progressText = document.getElementById('progressText');
  statusDetails = document.getElementById('statusDetails');
  resultSection = document.getElementById('resultSection');
  resultInfo = document.getElementById('resultInfo');
  errorSection = document.getElementById('errorSection');
  errorText = document.getElementById('errorText');
  errorDetails = document.getElementById('errorDetails');
  historyList = document.getElementById('historyList');
  threadsSection = document.getElementById('threadsSection');
  threadsTarget = document.getElementById('threadsTarget');

  // Set up event listeners
  captureButton.addEventListener('click', handleCaptureClick);

  // Load recent captures history
  loadRecentCaptures();

  // Check if there's an ongoing capture
  checkCaptureStatus();

  // Detect a Threads post in the active tab and restore its options
  detectThreadsPost();
}

/**
 * Show the Threads panel when the active tab is a Threads post permalink.
 */
async function detectThreadsPost() {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return;

    threadsPost = parseThreadsPostUrl(tab.url);
    if (!threadsPost) {
      if (isThreadsUrl(tab.url)) {
        updateStatusDetails('Threads detected, but this is not a post page. Open a single post (threads.com/@user/post/CODE) to capture it with its replies.');
        showSection(statusSection);
      }
      return;
    }

    threadsTarget.textContent = `@${threadsPost.username} · ${threadsPost.code}`;
    showSection(threadsSection);
    captureButton.querySelector('.btn-text').textContent = 'Capture Post + Replies';

    const stored = (await browser.storage.local.get('threadsOptions')).threadsOptions || {};
    for (const [key, id] of Object.entries(THREADS_OPTION_INPUTS)) {
      if (key in stored) document.getElementById(id).checked = Boolean(stored[key]);
    }
  } catch (error) {
    console.error('Failed to detect Threads post:', error);
  }
}

/**
 * Read the Threads options from the panel, or null when not a Threads post.
 */
function readThreadsOptions() {
  if (!threadsPost) return null;
  const options = {};
  for (const [key, id] of Object.entries(THREADS_OPTION_INPUTS)) {
    options[key] = document.getElementById(id).checked;
  }
  return options;
}

/**
 * Handle capture button click
 */
async function handleCaptureClick() {
  if (isCapturing) {
    return;
  }

  try {
    isCapturing = true;
    captureButton.disabled = true;
    captureButton.classList.add('disabled');

    // Hide previous results/errors
    hideSection(resultSection);
    hideSection(errorSection);

    // Show status section
    showSection(statusSection);
    updateStatus('⏳', 'Initiating capture...', 0);

    // Get current active tab
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      throw new Error('No active tab found');
    }

    // Persist Threads options and send the capture request
    const threadsOptions = readThreadsOptions();
    if (threadsOptions) await browser.storage.local.set({ threadsOptions });

    const response = await browser.runtime.sendMessage({
      type: 'CAPTURE_REQUEST',
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
      options: threadsOptions ? { threads: threadsOptions } : {}
    });

    if (response && response.success) {
      // Listen for progress updates
      listenForProgressUpdates();
    } else {
      throw new Error(response.error || 'Capture request failed');
    }
  } catch (error) {
    console.error('Capture error:', error);
    showError(error.message || 'Failed to initiate capture');
    resetCaptureButton();
  }
}

/**
 * Listen for progress updates from background worker
 */
function listenForProgressUpdates() {
  // Remove existing listener if present
  if (messageListener) {
    browser.runtime.onMessage.removeListener(messageListener);
  }

  // Store reference to listener for cleanup
  messageListener = handleBackgroundMessage;
  browser.runtime.onMessage.addListener(messageListener);
}

/**
 * Handle messages from background worker
 */
function handleBackgroundMessage(message, sender, sendResponse) {
  if (message.type === 'CAPTURE_PROGRESS') {
    updateProgress(message.step, message.progress, message.details);
  } else if (message.type === 'CAPTURE_COMPLETE') {
    handleCaptureComplete(message.result);
  } else if (message.type === 'CAPTURE_ERROR') {
    handleCaptureError(message.error);
  }
}

/**
 * Update capture progress
 */
function updateProgress(step, progress, details) {
  const steps = {
    'init': 'Initializing capture...',
    'threads': 'Preparing Threads post...',
    'screenshot': 'Capturing full-page screenshot...',
    'dom': 'Capturing DOM structure...',
    'storage': 'Capturing browser storage...',
    'cookies': 'Capturing cookies...',
    'hashing': 'Generating integrity hashes...',
    'manifest': 'Creating forensic manifest...',
    'download': 'Saving evidence files...'
  };

  const statusMessage = steps[step] || 'Processing...';
  updateStatus('⏳', statusMessage, progress);

  if (details) {
    updateStatusDetails(details);
  }
}

/**
 * Update status display
 */
function updateStatus(icon, text, progress) {
  statusIcon.textContent = icon;
  statusText.textContent = text;

  if (progress !== undefined && progress !== null) {
    showSection(statusProgress);
    progressFill.style.width = `${progress}%`;
    progressText.textContent = `${Math.round(progress)}%`;
  }
}

/**
 * Update status details
 */
function updateStatusDetails(details) {
  if (typeof details === 'string') {
    statusDetails.textContent = details;
  } else if (typeof details === 'object') {
    statusDetails.textContent = JSON.stringify(details, null, 2);
  }
}

/**
 * Clean up message listener
 */
function cleanupMessageListener() {
  if (messageListener) {
    browser.runtime.onMessage.removeListener(messageListener);
    messageListener = null;
  }
}

/**
 * Handle capture completion
 */
function handleCaptureComplete(result) {
  cleanupMessageListener();
  hideSection(statusSection);
  showSection(resultSection);

  const rows = [
    ['Saved as', result.packageFile || '—'],
    ['Package SHA-256', result.packageSha256 || '—'],
    ['Capture ID', result.captureId],
    ['Timestamp', new Date(result.timestamp).toLocaleString()],
    ['Files in package', String(result.filesCount || 0)],
    ['Total size', formatBytes(result.totalSize || 0)],
    ['Screenshot parts', String(result.screenshotSegments || 0)],
    ['Hash algorithm', 'SHA-256']
  ];

  if (result.threads) {
    const t = result.threads;
    rows.push(
      ['Thread posts', `${t.threadPosts} (${t.replies} replies, ${t.ancestors} ancestors)`],
      ['Root reports', `${t.rootReportedDirectReplies ?? '—'} direct replies`],
      ['Completeness notes', String(t.warnings)]
    );
  }

  resultInfo.replaceChildren(...rows.map(([label, value]) => {
    const row = document.createElement('div');
    row.className = 'result-item';
    const strong = document.createElement('strong');
    strong.textContent = `${label}: `;
    row.append(strong, document.createTextNode(value));
    return row;
  }));

  // Add to history
  addToHistory(result);

  // Reset button
  resetCaptureButton();
}

/**
 * Handle capture error
 */
function handleCaptureError(error) {
  cleanupMessageListener();
  showError(error.message || 'Unknown error occurred', error.details);
  resetCaptureButton();
}

/**
 * Show error message
 */
function showError(message, details) {
  hideSection(statusSection);
  hideSection(resultSection);
  showSection(errorSection);

  errorText.textContent = message;

  if (details) {
    errorDetails.textContent = typeof details === 'string'
      ? details
      : JSON.stringify(details, null, 2);
  } else {
    errorDetails.textContent = '';
  }
}

/**
 * Reset capture button
 */
function resetCaptureButton() {
  isCapturing = false;
  captureButton.disabled = false;
  captureButton.classList.remove('disabled');
}

/**
 * Show section
 */
function showSection(element) {
  element.classList.remove('hidden');
}

/**
 * Hide section
 */
function hideSection(element) {
  element.classList.add('hidden');
}

/**
 * Check if there's an ongoing capture
 */
async function checkCaptureStatus() {
  try {
    const response = await browser.runtime.sendMessage({
      type: 'GET_CAPTURE_STATUS'
    });

    if (response && response.isCapturing) {
      // Resume showing capture progress
      isCapturing = true;
      captureButton.disabled = true;
      showSection(statusSection);
      updateStatus('⏳', response.currentStep || 'Capturing...', response.progress || 0);
      listenForProgressUpdates();
    }
  } catch (error) {
    // Background worker might not be ready yet
    console.log('Could not check capture status:', error);
  }
}

/**
 * Load recent captures from storage
 */
async function loadRecentCaptures() {
  try {
    const result = await browser.storage.local.get('captureHistory');
    const history = result.captureHistory || [];

    if (history.length > 0) {
      showSection(historySection);
      displayHistory(history.slice(0, 5)); // Show last 5 captures
    }
  } catch (error) {
    console.error('Failed to load capture history:', error);
  }
}

/**
 * Display capture history
 */
function displayHistory(history) {
  // Captured URLs are page-controlled data: build nodes, never HTML strings.
  historyList.replaceChildren(...history.map(capture => {
    const item = document.createElement('div');
    item.className = 'history-item';

    const time = document.createElement('div');
    time.className = 'history-time';
    time.textContent = new Date(capture.timestamp).toLocaleString();

    const url = document.createElement('div');
    url.className = 'history-url';
    url.textContent = truncateURL(capture.url, 40);

    const files = document.createElement('div');
    files.className = 'history-files';
    files.textContent = `${capture.filesCount || 0} files`;

    item.append(time, url, files);
    return item;
  }));
}

/**
 * Add capture to history
 */
async function addToHistory(capture) {
  try {
    const result = await browser.storage.local.get('captureHistory');
    const history = result.captureHistory || [];

    // Add new capture to beginning
    history.unshift({
      captureId: capture.captureId,
      timestamp: capture.timestamp,
      url: capture.url || '',
      filesCount: capture.filesCount || 0,
      totalSize: capture.totalSize || 0,
      packageFile: capture.packageFile || null,
      packageSha256: capture.packageSha256 || null
    });

    // Keep only last 20 captures
    const trimmedHistory = history.slice(0, 20);

    await browser.storage.local.set({ captureHistory: trimmedHistory });

    // Refresh display
    loadRecentCaptures();
  } catch (error) {
    console.error('Failed to save capture to history:', error);
  }
}

/**
 * Format bytes to human-readable size
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Truncate URL for display
 */
function truncateURL(url, maxLength) {
  if (!url || url.length <= maxLength) {
    return url;
  }

  return url.substring(0, maxLength - 3) + '...';
}

// Initialize popup when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
