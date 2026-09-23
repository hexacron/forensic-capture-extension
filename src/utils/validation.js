/**
 * Data Validation Utilities for Forensic Data Capture
 *
 * Provides validation functions for ensuring data integrity and correctness
 * before forensic capture and packaging.
 */

/**
 * Validate URL format
 * @param {string} url - URL to validate
 * @returns {boolean} True if valid URL
 */
export function isValidURL(url) {
  if (typeof url !== 'string' || url.trim() === '') {
    return false;
  }

  try {
    const urlObj = new URL(url);
    return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
  } catch (error) {
    return false;
  }
}

/**
 * Validate SHA-256 hash format
 * @param {string} hash - Hash string to validate
 * @returns {boolean} True if valid SHA-256 hash (64 hex characters)
 */
export function isValidSHA256(hash) {
  if (typeof hash !== 'string') {
    return false;
  }

  // SHA-256 hash should be exactly 64 hexadecimal characters
  const sha256Pattern = /^[a-f0-9]{64}$/i;
  return sha256Pattern.test(hash);
}

/**
 * Validate ISO 8601 timestamp
 * @param {string} timestamp - Timestamp to validate
 * @returns {boolean} True if valid ISO 8601 timestamp
 */
export function isValidTimestamp(timestamp) {
  if (typeof timestamp !== 'string') {
    return false;
  }

  const date = new Date(timestamp);
  return !isNaN(date.getTime()) && date.toISOString() === timestamp;
}

/**
 * Validate filename-safe timestamp
 * @param {string} timestamp - Filename timestamp to validate
 * @returns {boolean} True if valid filename timestamp format
 */
export function isValidFilenameTimestamp(timestamp) {
  if (typeof timestamp !== 'string') {
    return false;
  }

  // Format: YYYYMMDDTHHmmssZ or YYYYMMDDTHHmmssSSS Z
  const pattern = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})?Z$/;
  return pattern.test(timestamp);
}

/**
 * Validate UUID v4 format
 * @param {string} uuid - UUID to validate
 * @returns {boolean} True if valid UUID v4
 */
export function isValidUUID(uuid) {
  if (typeof uuid !== 'string') {
    return false;
  }

  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidPattern.test(uuid);
}

/**
 * Validate capture manifest structure
 * @param {Object} manifest - Manifest object to validate
 * @returns {Object} Validation result {valid: boolean, errors: string[]}
 */
export function validateManifest(manifest) {
  const errors = [];

  // Check required top-level properties
  if (!manifest.forensicMetadata) {
    errors.push('Missing required property: forensicMetadata');
  }

  if (!manifest.targetPage) {
    errors.push('Missing required property: targetPage');
  }

  if (!manifest.capturedFiles || !Array.isArray(manifest.capturedFiles)) {
    errors.push('Missing or invalid property: capturedFiles (must be array)');
  }

  // Validate forensicMetadata
  if (manifest.forensicMetadata) {
    if (!manifest.forensicMetadata.captureId) {
      errors.push('Missing forensicMetadata.captureId');
    } else if (!isValidUUID(manifest.forensicMetadata.captureId)) {
      errors.push('Invalid forensicMetadata.captureId (must be UUID v4)');
    }

    if (!manifest.forensicMetadata.timestamp) {
      errors.push('Missing forensicMetadata.timestamp');
    } else if (!isValidTimestamp(manifest.forensicMetadata.timestamp)) {
      errors.push('Invalid forensicMetadata.timestamp (must be ISO 8601)');
    }

    if (!manifest.forensicMetadata.version) {
      errors.push('Missing forensicMetadata.version');
    }
  }

  // Validate targetPage
  if (manifest.targetPage) {
    if (!manifest.targetPage.url) {
      errors.push('Missing targetPage.url');
    } else if (!isValidURL(manifest.targetPage.url)) {
      errors.push('Invalid targetPage.url');
    }

    if (!manifest.targetPage.captureTimestamp) {
      errors.push('Missing targetPage.captureTimestamp');
    } else if (!isValidTimestamp(manifest.targetPage.captureTimestamp)) {
      errors.push('Invalid targetPage.captureTimestamp');
    }
  }

  // Validate capturedFiles
  if (Array.isArray(manifest.capturedFiles)) {
    manifest.capturedFiles.forEach((file, index) => {
      if (!file.filename) {
        errors.push(`capturedFiles[${index}]: Missing filename`);
      }

      if (!file.type) {
        errors.push(`capturedFiles[${index}]: Missing type`);
      }

      if (!file.sha256) {
        errors.push(`capturedFiles[${index}]: Missing sha256`);
      } else if (!isValidSHA256(file.sha256)) {
        errors.push(`capturedFiles[${index}]: Invalid sha256 format`);
      }

      if (file.size === undefined || file.size === null) {
        errors.push(`capturedFiles[${index}]: Missing size`);
      } else if (typeof file.size !== 'number' || file.size < 0) {
        errors.push(`capturedFiles[${index}]: Invalid size (must be non-negative number)`);
      }
    });
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validate captured data before packaging
 * @param {Object} captureData - Capture data object
 * @returns {Object} Validation result {valid: boolean, errors: string[]}
 */
export function validateCaptureData(captureData) {
  const errors = [];

  // Check required properties
  if (!captureData.captureId) {
    errors.push('Missing captureId');
  }

  if (!captureData.timestamp) {
    errors.push('Missing timestamp');
  }

  if (!captureData.url) {
    errors.push('Missing url');
  } else if (!isValidURL(captureData.url)) {
    errors.push('Invalid url');
  }

  // Validate individual capture components
  if (captureData.screenshot && typeof captureData.screenshot !== 'string') {
    errors.push('Invalid screenshot (must be data URL string)');
  }

  if (captureData.dom && typeof captureData.dom !== 'object') {
    errors.push('Invalid DOM data (must be object)');
  }

  if (captureData.storage && typeof captureData.storage !== 'object') {
    errors.push('Invalid storage data (must be object)');
  }

  if (captureData.cookies && !Array.isArray(captureData.cookies)) {
    errors.push('Invalid cookies data (must be array)');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validate browser storage data
 * @param {Object} storageData - Storage data object
 * @returns {Object} Validation result {valid: boolean, errors: string[]}
 */
export function validateStorageData(storageData) {
  const errors = [];

  if (!storageData || typeof storageData !== 'object') {
    errors.push('Storage data must be an object');
    return { valid: false, errors };
  }

  // Validate localStorage
  if (storageData.localStorage !== undefined && typeof storageData.localStorage !== 'object') {
    errors.push('localStorage must be an object');
  }

  // Validate sessionStorage
  if (storageData.sessionStorage !== undefined && typeof storageData.sessionStorage !== 'object') {
    errors.push('sessionStorage must be an object');
  }

  // Validate IndexedDB
  if (storageData.indexedDB !== undefined && !Array.isArray(storageData.indexedDB)) {
    errors.push('indexedDB must be an array');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validate DOM capture data
 * @param {Object} domData - DOM data object
 * @returns {Object} Validation result {valid: boolean, errors: string[]}
 */
export function validateDOMData(domData) {
  const errors = [];

  if (!domData || typeof domData !== 'object') {
    errors.push('DOM data must be an object');
    return { valid: false, errors };
  }

  if (!domData.html || typeof domData.html !== 'string') {
    errors.push('Missing or invalid DOM html property');
  }

  if (!domData.url || typeof domData.url !== 'string') {
    errors.push('Missing or invalid DOM url property');
  }

  if (!domData.timestamp || typeof domData.timestamp !== 'string') {
    errors.push('Missing or invalid DOM timestamp property');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Sanitize filename to be filesystem-safe
 * @param {string} filename - Filename to sanitize
 * @returns {string} Sanitized filename
 */
export function sanitizeFilename(filename) {
  if (typeof filename !== 'string') {
    throw new Error('Filename must be a string');
  }

  // Remove or replace characters that are invalid in filenames
  // Keep alphanumeric, hyphens, underscores, dots
  return filename
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')  // Replace invalid chars with underscore
    .replace(/\s+/g, '-')                     // Replace spaces with hyphens
    .replace(/\.+/g, '.')                     // Collapse multiple dots
    .replace(/^\./, '')                       // Remove leading dot
    .substring(0, 255);                       // Limit to 255 characters
}

/**
 * Validate file size is within acceptable limits
 * @param {number} size - File size in bytes
 * @param {number} maxSize - Maximum allowed size in bytes (default 100MB)
 * @returns {boolean} True if size is acceptable
 */
export function isValidFileSize(size, maxSize = 100 * 1024 * 1024) {
  return typeof size === 'number' && size >= 0 && size <= maxSize;
}

/**
 * Validate data URL format
 * @param {string} dataUrl - Data URL to validate
 * @returns {boolean} True if valid data URL
 */
export function isValidDataURL(dataUrl) {
  if (typeof dataUrl !== 'string') {
    return false;
  }

  // Data URL pattern: data:[<mediatype>][;base64],<data>
  const dataURLPattern = /^data:([a-z]+\/[a-z0-9\-\+\.]+)(;base64)?,(.*)$/i;
  return dataURLPattern.test(dataUrl);
}

/**
 * Validate cookie object structure
 * @param {Object} cookie - Cookie object to validate
 * @returns {boolean} True if valid cookie structure
 */
export function isValidCookie(cookie) {
  if (!cookie || typeof cookie !== 'object') {
    return false;
  }

  // Required properties
  if (!cookie.name || typeof cookie.name !== 'string') {
    return false;
  }

  if (!cookie.value || typeof cookie.value !== 'string') {
    return false;
  }

  if (!cookie.domain || typeof cookie.domain !== 'string') {
    return false;
  }

  return true;
}

/**
 * Validate complete forensic package before download
 * @param {Object} forensicPackage - Complete forensic package
 * @returns {Object} Validation result {valid: boolean, errors: string[], warnings: string[]}
 */
export function validateForensicPackage(forensicPackage) {
  const errors = [];
  const warnings = [];

  // Validate manifest
  if (!forensicPackage.manifest) {
    errors.push('Missing manifest');
  } else {
    const manifestValidation = validateManifest(forensicPackage.manifest);
    errors.push(...manifestValidation.errors);
  }

  // Validate files
  if (!forensicPackage.files || !Array.isArray(forensicPackage.files)) {
    errors.push('Missing or invalid files array');
  } else {
    forensicPackage.files.forEach((file, index) => {
      if (!file.filename) {
        errors.push(`File[${index}]: Missing filename`);
      }

      if (!file.data) {
        errors.push(`File[${index}]: Missing data`);
      }

      if (!file.hash) {
        errors.push(`File[${index}]: Missing hash`);
      } else if (!isValidSHA256(file.hash)) {
        errors.push(`File[${index}]: Invalid hash format`);
      }
    });
  }

  // Check for potential issues (warnings)
  if (forensicPackage.manifest && forensicPackage.manifest.auditTrail) {
    if (forensicPackage.manifest.auditTrail.captureErrors &&
        forensicPackage.manifest.auditTrail.captureErrors.length > 0) {
      warnings.push('Capture completed with errors');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}
