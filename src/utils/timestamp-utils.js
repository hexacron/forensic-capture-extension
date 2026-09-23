/**
 * Timestamp Utilities for Forensic Data Capture
 *
 * Provides ISO 8601 timestamp formatting for forensic captures.
 * All timestamps are in UTC to ensure consistency across time zones.
 */

/**
 * Get current timestamp in ISO 8601 format (UTC)
 * @returns {string} ISO 8601 timestamp (e.g., "2025-12-18T14:30:45.123Z")
 */
export function getCurrentTimestamp() {
  return new Date().toISOString();
}

/**
 * Get filename-safe timestamp in ISO 8601 format (UTC)
 * Removes colons and milliseconds for filesystem compatibility
 * @returns {string} Filename-safe timestamp (e.g., "20251218T143045Z")
 */
export function getFilenameTimestamp() {
  const now = new Date();

  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const hours = String(now.getUTCHours()).padStart(2, '0');
  const minutes = String(now.getUTCMinutes()).padStart(2, '0');
  const seconds = String(now.getUTCSeconds()).padStart(2, '0');

  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}

/**
 * Get filename-safe timestamp with milliseconds
 * @returns {string} Filename-safe timestamp with milliseconds (e.g., "20251218T143045123Z")
 */
export function getFilenameTimestampWithMilliseconds() {
  const now = new Date();

  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const hours = String(now.getUTCHours()).padStart(2, '0');
  const minutes = String(now.getUTCMinutes()).padStart(2, '0');
  const seconds = String(now.getUTCSeconds()).padStart(2, '0');
  const milliseconds = String(now.getUTCMilliseconds()).padStart(3, '0');

  return `${year}${month}${day}T${hours}${minutes}${seconds}${milliseconds}Z`;
}

/**
 * Convert a Date object to ISO 8601 format (UTC)
 * @param {Date} date - Date object to convert
 * @returns {string} ISO 8601 timestamp
 */
export function formatTimestamp(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    throw new Error('Invalid date object');
  }
  return date.toISOString();
}

/**
 * Convert a timestamp to filename-safe format
 * @param {Date|string} timestamp - Date object or ISO 8601 string
 * @returns {string} Filename-safe timestamp
 */
export function toFilenameFormat(timestamp) {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);

  if (isNaN(date.getTime())) {
    throw new Error('Invalid timestamp');
  }

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');

  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}

/**
 * Parse a filename-safe timestamp back to ISO 8601
 * @param {string} filenameTimestamp - Filename-safe timestamp (e.g., "20251218T143045Z")
 * @returns {string} ISO 8601 timestamp
 */
export function parseFilenameTimestamp(filenameTimestamp) {
  // Match pattern: YYYYMMDDTHHmmssZ or YYYYMMDDTHHmmssSSS Z
  const pattern = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})?Z$/;
  const match = filenameTimestamp.match(pattern);

  if (!match) {
    throw new Error('Invalid filename timestamp format');
  }

  const [, year, month, day, hours, minutes, seconds, milliseconds = '000'] = match;

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}Z`;
}

/**
 * Get Unix timestamp (milliseconds since epoch)
 * @returns {number} Unix timestamp
 */
export function getUnixTimestamp() {
  return Date.now();
}

/**
 * Format Unix timestamp to ISO 8601
 * @param {number} unixTimestamp - Unix timestamp in milliseconds
 * @returns {string} ISO 8601 timestamp
 */
export function formatUnixTimestamp(unixTimestamp) {
  return new Date(unixTimestamp).toISOString();
}

/**
 * Generate a capture filename with timestamp
 * @param {string} type - File type (e.g., "screenshot", "dom", "storage")
 * @param {string} extension - File extension (e.g., "png", "html", "json")
 * @param {string} [baseTimestamp] - Optional base timestamp to use for all files in a capture
 * @returns {string} Complete filename (e.g., "20251218T143045Z-screenshot.png")
 */
export function generateCaptureFilename(type, extension, baseTimestamp = null) {
  const timestamp = baseTimestamp || getFilenameTimestamp();
  return `${timestamp}-${type}.${extension}`;
}

/**
 * Validate ISO 8601 timestamp format
 * @param {string} timestamp - Timestamp to validate
 * @returns {boolean} True if valid ISO 8601 format
 */
export function isValidISO8601(timestamp) {
  if (typeof timestamp !== 'string') {
    return false;
  }

  const date = new Date(timestamp);
  return !isNaN(date.getTime()) && date.toISOString() === timestamp;
}

/**
 * Get human-readable timestamp for display
 * @param {string} isoTimestamp - ISO 8601 timestamp
 * @returns {string} Human-readable timestamp (e.g., "Dec 18, 2025, 2:30:45 PM UTC")
 */
export function getHumanReadableTimestamp(isoTimestamp) {
  const date = new Date(isoTimestamp);

  if (isNaN(date.getTime())) {
    return 'Invalid timestamp';
  }

  return date.toLocaleString('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short'
  });
}

/**
 * Get timezone-agnostic timestamp for forensic logging
 * Always returns UTC to avoid timezone confusion
 * @returns {Object} Timestamp object with multiple formats
 */
export function getForensicTimestamp() {
  const now = new Date();

  return {
    iso8601: now.toISOString(),
    filenameSafe: getFilenameTimestamp(),
    unix: now.getTime(),
    timezone: 'UTC',
    formatted: getHumanReadableTimestamp(now.toISOString())
  };
}
