// Catches references to identifiers that were never declared or imported. These only
// throw at runtime when the code path executes (e.g. RELOAD_TIMEOUT_MS during a Threads
// reload), so nothing else in the test suite would notice them.
const browserGlobals = Object.fromEntries([
  'browser', 'chrome', 'window', 'document', 'navigator', 'location', 'getComputedStyle',
  'OffscreenCanvas', 'createImageBitmap', 'crypto', 'atob', 'btoa', 'fetch', 'setTimeout',
  'clearTimeout', 'console', 'Blob', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'Node', 'FileReader', 'indexedDB', 'localStorage', 'sessionStorage', 'unescape', 'self',
  'globalThis', 'Response'
].map(name => [name, 'readonly']));

export default [
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: browserGlobals
    },
    rules: {
      'no-undef': 'error'
    }
  }
];
