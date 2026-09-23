/**
 * Cryptographic Utilities for Exhibit
 *
 * Provides SHA-256 hashing functionality using the Web Crypto API
 * for ensuring data integrity in forensic captures.
 */

/**
 * Generate SHA-256 hash from various data types
 * @param {string|Blob|ArrayBuffer|Uint8Array} data - Data to hash
 * @returns {Promise<string>} Hexadecimal hash string
 */
export async function generateSHA256(data) {
  try {
    let buffer;

    // Convert data to Uint8Array based on type
    if (typeof data === 'string') {
      const encoder = new TextEncoder();
      buffer = encoder.encode(data);
    } else if (data instanceof Blob) {
      const arrayBuffer = await data.arrayBuffer();
      buffer = new Uint8Array(arrayBuffer);
    } else if (data instanceof ArrayBuffer) {
      buffer = new Uint8Array(data);
    } else if (data instanceof Uint8Array) {
      buffer = data;
    } else {
      throw new Error(`Unsupported data type: ${typeof data}`);
    }

    // Generate SHA-256 hash
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);

    // Convert hash to hexadecimal string
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('');

    return hashHex;
  } catch (error) {
    console.error('Error generating SHA-256 hash:', error);
    throw new Error(`Failed to generate SHA-256 hash: ${error.message}`);
  }
}

/**
 * Generate SHA-256 hash from a data URL
 * @param {string} dataUrl - Data URL (e.g., from canvas.toDataURL())
 * @returns {Promise<string>} Hexadecimal hash string
 */
export async function generateSHA256FromDataURL(dataUrl) {
  try {
    // Extract base64 data from data URL
    const base64Data = dataUrl.split(',')[1];
    if (!base64Data) {
      throw new Error('Invalid data URL format');
    }

    // Convert base64 to binary
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    return await generateSHA256(bytes);
  } catch (error) {
    console.error('Error generating SHA-256 from data URL:', error);
    throw new Error(`Failed to generate SHA-256 from data URL: ${error.message}`);
  }
}

/**
 * Verify data against a known hash
 * @param {string|Blob|ArrayBuffer|Uint8Array} data - Data to verify
 * @param {string} expectedHash - Expected SHA-256 hash (hex string)
 * @returns {Promise<boolean>} True if hash matches
 */
export async function verifySHA256(data, expectedHash) {
  try {
    const actualHash = await generateSHA256(data);
    return actualHash.toLowerCase() === expectedHash.toLowerCase();
  } catch (error) {
    console.error('Error verifying SHA-256 hash:', error);
    return false;
  }
}

/**
 * Generate multiple hashes for a set of files
 * @param {Object[]} files - Array of {data, filename} objects
 * @returns {Promise<Object[]>} Array of {filename, hash, size} objects
 */
export async function generateMultipleHashes(files) {
  try {
    const hashPromises = files.map(async (file) => {
      const hash = await generateSHA256(file.data);

      // Calculate size
      let size = 0;
      if (typeof file.data === 'string') {
        size = new Blob([file.data]).size;
      } else if (file.data instanceof Blob) {
        size = file.data.size;
      } else if (file.data instanceof ArrayBuffer) {
        size = file.data.byteLength;
      } else if (file.data instanceof Uint8Array) {
        size = file.data.byteLength;
      }

      return {
        filename: file.filename,
        hash: hash,
        size: size
      };
    });

    return await Promise.all(hashPromises);
  } catch (error) {
    console.error('Error generating multiple hashes:', error);
    throw new Error(`Failed to generate multiple hashes: ${error.message}`);
  }
}

/**
 * Format hash output in sha256sum compatible format
 * @param {string} hash - SHA-256 hash
 * @param {string} filename - Associated filename
 * @returns {string} Formatted hash line (e.g., "abc123... *filename.txt")
 */
export function formatHashForFile(hash, filename) {
  return `${hash} *${filename}`;
}

/**
 * Generate a complete hash manifest file content
 * @param {Object[]} fileHashes - Array of {filename, hash} objects
 * @returns {string} Complete hash file content
 */
export function generateHashManifest(fileHashes) {
  const header = '# SHA-256 Hashes - Exhibit\n';
  const timestamp = `# Generated: ${new Date().toISOString()}\n`;
  const separator = '# ========================================\n\n';

  const hashes = fileHashes
    .map(file => formatHashForFile(file.hash, file.filename))
    .join('\n');

  return header + timestamp + separator + hashes;
}
