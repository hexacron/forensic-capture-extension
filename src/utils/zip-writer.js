/**
 * Minimal ZIP writer (PKWARE APPNOTE 6.3) for packaging a capture into one download.
 * Service-worker safe: no dependencies; compression uses CompressionStream
 * ('deflate-raw') when available and falls back to storing.
 *
 * Entry bytes are never altered - extraction yields exactly the bytes that were
 * hashed, so hashes.txt inside the archive verifies the extracted files.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Formats that are already compressed gain nothing from deflate.
const STORE_EXTENSIONS = /\.(png|jpe?g|gif|webp|heic|mp4|mov|webm|zip|gz)$/i;
const MAX_ZIP32 = 0xffffffff;

async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null; // 'deflate-raw' unsupported: store instead
  }
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()
  };
}

/**
 * @param {Array<{path: string, bytes: Uint8Array}>} entries - paths use '/' separators
 * @param {Date} [modified] - timestamp stored for every entry (UTC)
 * @returns {Promise<Uint8Array>} the complete archive
 */
export async function createZip(entries, modified = new Date()) {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(modified);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const raw = entry.bytes;
    const crc = crc32(raw);
    let method = 0;
    let data = raw;
    if (!STORE_EXTENSIONS.test(entry.path) && raw.length > 0) {
      const deflated = await deflateRaw(raw);
      if (deflated && deflated.length < raw.length) {
        method = 8;
        data = deflated;
      }
    }
    if (raw.length > MAX_ZIP32 || offset > MAX_ZIP32) {
      throw new Error(`Capture too large for a ZIP archive without ZIP64 (${entry.path})`);
    }

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header signature
    local.setUint16(4, 20, true); // version needed (2.0)
    local.setUint16(6, 0x0800, true); // flags: UTF-8 file names
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true); // extra field length
    locals.push(new Uint8Array(local.buffer), name, data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true); // central directory signature
    central.setUint16(4, 20, true); // version made by
    central.setUint16(6, 20, true); // version needed
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, method, true);
    central.setUint16(12, time, true);
    central.setUint16(14, date, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, raw.length, true);
    central.setUint16(28, name.length, true);
    central.setUint16(30, 0, true); // extra length
    central.setUint16(32, 0, true); // comment length
    central.setUint16(34, 0, true); // disk number
    central.setUint16(36, 0, true); // internal attributes
    central.setUint32(38, 0, true); // external attributes
    central.setUint32(42, offset, true); // local header offset
    centrals.push(new Uint8Array(central.buffer), name);

    offset += 30 + name.length + data.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); // end of central directory signature
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let position = 0;
  for (const part of parts) {
    out.set(part, position);
    position += part.length;
  }
  return out;
}
