/**
 * Download Manager for Exhibit
 *
 * Handles downloading captured forensic data files to the user's system.
 * Manages data URL conversion and sequential download execution.
 */

// Import browser API polyfill
import '../../lib/browser-polyfill.min.js';
import { bytesToBase64 } from '../utils/encoding-utils.js';

/**
 * Download Manager Class
 */
export class DownloadManager {
  constructor() {
    this.downloadQueue = [];
    this.downloadedFiles = [];
  }

  /**
   * Download multiple files sequentially
   * @param {Array} files - Array of {filename, bytes, mimeType, folderName} objects
   * @returns {Promise<Array>} Array of download results
   */
  async downloadFiles(files) {
    console.log('[DownloadManager] Starting download of', files.length, 'files');

    const results = [];

    for (const file of files) {
      try {
        const result = await this.downloadFile(file);
        results.push(result);

        // Small delay between downloads to avoid overwhelming the system
        await this.delay(100);
      } catch (error) {
        console.error('[DownloadManager] Failed to download file:', file.filename, error);
        results.push({
          filename: file.filename,
          success: false,
          error: error.message
        });
      }
    }

    console.log('[DownloadManager] Download complete:', results.length, 'files');
    return results;
  }

  /**
   * Download a single file
   * @param {Object} file - {filename, bytes: Uint8Array, mimeType, folderName}
   * @returns {Promise<Object>} Download result
   */
  async downloadFile(file) {
    // Add folder prefix if provided
    const fullPath = file.folderName
      ? `${file.folderName}/${file.filename}`
      : file.filename;

    console.log('[DownloadManager] Downloading:', fullPath);

    try {
      // Service workers cannot create blob: URLs; the exact bytes travel as a data URL.
      const dataUrl = `data:${file.mimeType};base64,${bytesToBase64(file.bytes)}`;

      // Initiate download
      const downloadId = await browser.downloads.download({
        url: dataUrl,
        filename: fullPath,
        saveAs: false, // Auto-save to default downloads folder
        conflictAction: 'uniquify' // Auto-rename if file exists
      });

      console.log('[DownloadManager] Download initiated:', fullPath, 'ID:', downloadId);

      // Wait for download to complete
      await this.waitForDownload(downloadId);

      return {
        filename: fullPath,
        success: true,
        downloadId: downloadId
      };
    } catch (error) {
      console.error('[DownloadManager] Download error:', error);
      throw new Error(`Failed to download ${fullPath}: ${error.message}`);
    }
  }

  /**
   * Wait for a download to complete
   * @param {number} downloadId - Download ID
   * @returns {Promise<void>}
   */
  async waitForDownload(downloadId) {
    return new Promise((resolve, reject) => {
      // Writing a data URL is near-instant; a long wait means the user is in Chrome's
      // "ask where to save" dialog (cancelling it reports 'interrupted' below).
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Download timeout'));
      }, 15 * 60 * 1000);

      const onChanged = (delta) => {
        if (delta.id === downloadId) {
          if (delta.state && delta.state.current === 'complete') {
            cleanup();
            resolve();
          } else if (delta.state && delta.state.current === 'interrupted') {
            cleanup();
            reject(new Error('Download interrupted'));
          } else if (delta.error) {
            cleanup();
            reject(new Error(delta.error.current));
          }
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        browser.downloads.onChanged.removeListener(onChanged);
      };

      browser.downloads.onChanged.addListener(onChanged);

      // Check if download already completed
      browser.downloads.search({ id: downloadId }).then(downloads => {
        if (downloads.length > 0) {
          const download = downloads[0];
          if (download.state === 'complete') {
            cleanup();
            resolve();
          } else if (download.state === 'interrupted') {
            cleanup();
            reject(new Error('Download interrupted'));
          } else if (download.error) {
            cleanup();
            reject(new Error(download.error));
          }
        }
      });
    });
  }

  /**
   * Delay helper function
   * @param {number} ms - Milliseconds to delay
   * @returns {Promise<void>}
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Cancel all pending downloads
   */
  async cancelPendingDownloads() {
    console.log('[DownloadManager] Cancelling pending downloads');

    for (const downloadId of this.downloadQueue) {
      try {
        await browser.downloads.cancel(downloadId);
      } catch (error) {
        console.error('[DownloadManager] Failed to cancel download:', downloadId, error);
      }
    }

    this.downloadQueue = [];
  }

  /**
   * Get download statistics
   * @returns {Object} Statistics
   */
  getStatistics() {
    return {
      totalDownloads: this.downloadedFiles.length,
      successfulDownloads: this.downloadedFiles.filter(f => f.success).length,
      failedDownloads: this.downloadedFiles.filter(f => !f.success).length
    };
  }
}

/**
 * Helper function to convert Blob to data URL
 * @param {Blob} blob - Blob to convert
 * @returns {Promise<string>} Data URL
 */
export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Helper function to estimate download size
 * @param {string} dataUrl - Data URL
 * @returns {number} Estimated size in bytes
 */
export function estimateDownloadSize(dataUrl) {
  if (typeof dataUrl !== 'string') {
    return 0;
  }

  const base64Data = dataUrl.split(',')[1] || '';
  return Math.floor(base64Data.length * 0.75);
}
