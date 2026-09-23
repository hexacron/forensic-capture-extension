/**
 * Audit Trail Logger for Exhibit
 *
 * Provides comprehensive logging for chain of custody and forensic audit trails.
 * All logs are timestamped in UTC using ISO 8601 format.
 */

import { getCurrentTimestamp } from './timestamp-utils.js';

/**
 * Actor types for chain of custody
 */
export const Actor = {
  USER: 'extension-user',
  AUTOMATED: 'extension-automated',
  SYSTEM: 'browser-system'
};

/**
 * Action types for chain of custody
 */
export const Action = {
  CAPTURE_INITIATED: 'capture-initiated',
  CAPTURE_REQUESTED: 'capture-requested',
  DOM_CAPTURED: 'dom-captured',
  SCREENSHOT_STARTED: 'screenshot-started',
  SCREENSHOT_COMPLETED: 'screenshot-completed',
  STORAGE_ACCESSED: 'storage-accessed',
  STORAGE_CAPTURED: 'storage-captured',
  COOKIES_CAPTURED: 'cookies-captured',
  INDEXEDDB_ENUMERATED: 'indexeddb-enumerated',
  HASH_GENERATED: 'hash-generated',
  HASHES_GENERATED: 'hashes-generated',
  MANIFEST_CREATED: 'manifest-created',
  FILE_CREATED: 'file-created',
  DOWNLOAD_INITIATED: 'download-initiated',
  DOWNLOAD_COMPLETED: 'download-completed',
  DOWNLOAD_FAILED: 'download-failed',
  CAPTURE_COMPLETED: 'capture-completed',
  CAPTURE_FAILED: 'capture-failed',
  ERROR_OCCURRED: 'error-occurred',
  RETRY_ATTEMPTED: 'retry-attempted',
  CDP_ATTACHED: 'devtools-protocol-attached',
  CDP_DETACHED: 'devtools-protocol-detached',
  PAGE_RELOADED: 'page-reloaded',
  PAGE_INTERACTION: 'page-interaction',
  REPLIES_LOADED: 'replies-loaded',
  THREAD_DATA_EXTRACTED: 'thread-data-extracted',
  MEDIA_DOWNLOADED: 'media-downloaded'
};

/**
 * Create a chain of custody entry
 * @param {string} action - Action type from Action enum
 * @param {string} actor - Actor type from Actor enum
 * @param {Object} [metadata] - Additional metadata for the entry
 * @returns {Object} Chain of custody entry
 */
export function createChainEntry(action, actor, metadata = {}) {
  return {
    action,
    timestamp: getCurrentTimestamp(),
    actor,
    ...metadata
  };
}

/**
 * Create an audit trail entry
 * @param {string} level - Log level (info, warning, error)
 * @param {string} message - Log message
 * @param {Object} [details] - Additional details
 * @returns {Object} Audit trail entry
 */
export function createAuditEntry(level, message, details = {}) {
  return {
    timestamp: getCurrentTimestamp(),
    level,
    message,
    ...details
  };
}

/**
 * Chain of Custody Logger
 */
export class ChainOfCustodyLogger {
  constructor() {
    this.chain = [];
  }

  /**
   * Add an entry to the chain of custody
   * @param {string} action - Action type
   * @param {string} actor - Actor type
   * @param {Object} [metadata] - Additional metadata
   */
  log(action, actor, metadata = {}) {
    const entry = createChainEntry(action, actor, metadata);
    this.chain.push(entry);
    console.log('[Chain of Custody]', entry);
  }

  /**
   * Get the complete chain of custody
   * @returns {Array} Array of chain entries
   */
  getChain() {
    return [...this.chain];
  }

  /**
   * Get the most recent entry
   * @returns {Object|null} Most recent entry or null
   */
  getLastEntry() {
    return this.chain.length > 0 ? this.chain[this.chain.length - 1] : null;
  }

  /**
   * Clear the chain (use with caution in forensic contexts)
   */
  clear() {
    this.chain = [];
  }

  /**
   * Export chain as JSON
   * @returns {string} JSON string of chain
   */
  exportAsJSON() {
    return JSON.stringify(this.chain, null, 2);
  }
}

/**
 * Audit Trail Logger
 */
export class AuditLogger {
  constructor() {
    this.entries = [];
    this.errors = [];
    this.warnings = [];
  }

  /**
   * Log an info message
   * @param {string} message - Log message
   * @param {Object} [details] - Additional details
   */
  info(message, details = {}) {
    const entry = createAuditEntry('info', message, details);
    this.entries.push(entry);
    console.log('[Audit]', message, details);
  }

  /**
   * Log a warning message
   * @param {string} message - Warning message
   * @param {Object} [details] - Additional details
   */
  warning(message, details = {}) {
    const entry = createAuditEntry('warning', message, details);
    this.entries.push(entry);
    this.warnings.push(entry);
    console.warn('[Audit]', message, details);
  }

  /**
   * Log an error message
   * @param {string} message - Error message
   * @param {Error|Object} [error] - Error object or details
   */
  error(message, error = {}) {
    const details = error instanceof Error
      ? { error: error.message, stack: error.stack }
      : error;

    const entry = createAuditEntry('error', message, details);
    this.entries.push(entry);
    this.errors.push(entry);
    console.error('[Audit]', message, details);
  }

  /**
   * Get all audit entries
   * @returns {Array} Array of audit entries
   */
  getEntries() {
    return [...this.entries];
  }

  /**
   * Get all errors
   * @returns {Array} Array of error entries
   */
  getErrors() {
    return [...this.errors];
  }

  /**
   * Get all warnings
   * @returns {Array} Array of warning entries
   */
  getWarnings() {
    return [...this.warnings];
  }

  /**
   * Check if there are any errors
   * @returns {boolean} True if errors exist
   */
  hasErrors() {
    return this.errors.length > 0;
  }

  /**
   * Get audit summary
   * @returns {Object} Summary of audit trail
   */
  getSummary() {
    return {
      totalEntries: this.entries.length,
      errors: this.errors.length,
      warnings: this.warnings.length,
      info: this.entries.length - this.errors.length - this.warnings.length
    };
  }

  /**
   * Clear the audit trail
   */
  clear() {
    this.entries = [];
    this.errors = [];
    this.warnings = [];
  }

  /**
   * Export audit trail as JSON
   * @returns {string} JSON string of audit trail
   */
  exportAsJSON() {
    return JSON.stringify({
      summary: this.getSummary(),
      entries: this.entries
    }, null, 2);
  }
}

/**
 * Forensic Logger - Combined chain of custody and audit trail
 */
export class ForensicLogger {
  constructor(captureId) {
    this.captureId = captureId;
    this.chainOfCustody = new ChainOfCustodyLogger();
    this.auditTrail = new AuditLogger();
    this.captureAttempts = 0;
    this.retries = 0;
    this.startTime = Date.now();
    this.endTime = null;
  }

  /**
   * Log a chain of custody event
   * @param {string} action - Action type
   * @param {string} actor - Actor type
   * @param {Object} [metadata] - Additional metadata
   */
  logChain(action, actor, metadata = {}) {
    this.chainOfCustody.log(action, actor, {
      captureId: this.captureId,
      ...metadata
    });
  }

  /**
   * Log audit info
   * @param {string} message - Log message
   * @param {Object} [details] - Additional details
   */
  logInfo(message, details = {}) {
    this.auditTrail.info(message, {
      captureId: this.captureId,
      ...details
    });
  }

  /**
   * Log audit warning
   * @param {string} message - Warning message
   * @param {Object} [details] - Additional details
   */
  logWarning(message, details = {}) {
    this.auditTrail.warning(message, {
      captureId: this.captureId,
      ...details
    });
  }

  /**
   * Log audit error
   * @param {string} message - Error message
   * @param {Error|Object} [error] - Error object or details
   */
  logError(message, error = {}) {
    this.auditTrail.error(message, error);
    this.logChain(Action.ERROR_OCCURRED, Actor.AUTOMATED, {
      error: error instanceof Error ? error.message : JSON.stringify(error)
    });
  }

  /**
   * Increment capture attempts
   */
  incrementAttempts() {
    this.captureAttempts++;
  }

  /**
   * Increment retry count
   */
  incrementRetries() {
    this.retries++;
    this.logChain(Action.RETRY_ATTEMPTED, Actor.AUTOMATED, {
      retryCount: this.retries
    });
  }

  /**
   * Mark capture as completed
   */
  markCompleted() {
    this.endTime = Date.now();
    this.logChain(Action.CAPTURE_COMPLETED, Actor.AUTOMATED, {
      duration: this.endTime - this.startTime
    });
  }

  /**
   * Mark capture as failed
   * @param {string} reason - Failure reason
   */
  markFailed(reason) {
    this.endTime = Date.now();
    this.logChain(Action.CAPTURE_FAILED, Actor.AUTOMATED, {
      reason,
      duration: this.endTime - this.startTime
    });
  }

  /**
   * Get complete forensic report
   * @returns {Object} Forensic report with chain and audit trail
   */
  getReport() {
    return {
      captureId: this.captureId,
      chainOfCustody: this.chainOfCustody.getChain(),
      auditTrail: {
        captureAttempts: this.captureAttempts,
        captureErrors: this.auditTrail.getErrors(),
        captureWarnings: this.auditTrail.getWarnings(),
        retries: this.retries,
        completionStatus: this.endTime
          ? (this.auditTrail.hasErrors() ? 'completed-with-errors' : 'success')
          : 'in-progress',
        duration: this.endTime ? this.endTime - this.startTime : null
      }
    };
  }

  /**
   * Export complete forensic log as JSON
   * @returns {string} JSON string of forensic report
   */
  exportAsJSON() {
    return JSON.stringify(this.getReport(), null, 2);
  }
}

/**
 * Create a new forensic logger instance
 * @param {string} captureId - Unique capture ID
 * @returns {ForensicLogger} Forensic logger instance
 */
export function createForensicLogger(captureId) {
  return new ForensicLogger(captureId);
}
