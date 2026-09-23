/**
 * Content Script Injector - Standalone version for programmatic injection
 * No ES6 imports - inline everything needed
 *
 * Runs only in the extension's isolated world. Storage is read from here: content
 * scripts share the page origin's localStorage, sessionStorage and IndexedDB, so
 * nothing is ever inserted into or broadcast on the page itself (no page-context
 * <script>, no window.postMessage traffic that site scripts could observe).
 */

(function() {
  'use strict';

  console.log('[Content Injector] Initializing...');

  /**
   * Capture DOM structure
   */
  function captureDOMStructure() {
    try {
      const domData = {
        html: document.documentElement.outerHTML,
        doctype: document.doctype ? `<!DOCTYPE ${document.doctype.name}>` : '<!DOCTYPE html>',
        url: window.location.href,
        title: document.title,
        timestamp: new Date().toISOString(),
        metadata: {
          characterSet: document.characterSet || document.charset || 'UTF-8',
          contentType: document.contentType || 'text/html',
          documentURI: document.documentURI,
          baseURI: document.baseURI,
          referrer: document.referrer || '',
          lastModified: document.lastModified || '',
          readyState: document.readyState,
          compatMode: document.compatMode,
          domain: document.domain || ''
        }
      };
      return domData;
    } catch (error) {
      console.error('[Content Injector] DOM capture error:', error);
      throw error;
    }
  }

  function readWebStorage(storage) {
    const data = {};
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null) data[key] = storage.getItem(key);
    }
    return data;
  }

  function readObjectStore(db, storeName) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const request = transaction.objectStore(storeName).getAll();
      request.onsuccess = () => {
        resolve((request.result || []).map((record, index) => {
          try {
            JSON.stringify(record);
            return record;
          } catch {
            return { _index: index, _serializationError: 'Could not serialize record', _type: typeof record };
          }
        }));
      };
      request.onerror = () => reject(new Error(request.error ? request.error.message : 'Unknown error'));
    });
  }

  function readDatabase(info) {
    return new Promise((resolve) => {
      // Opening without a version never upgrades or creates schema.
      const request = indexedDB.open(info.name);
      request.onsuccess = async () => {
        const db = request.result;
        const objectStores = Array.from(db.objectStoreNames);
        const data = {};
        for (const storeName of objectStores) {
          try {
            data[storeName] = await readObjectStore(db, storeName);
          } catch (error) {
            data[storeName] = { error: error.message };
          }
        }
        db.close();
        resolve({ name: info.name, version: info.version, objectStores, data });
      };
      request.onerror = () => resolve({ name: info.name, error: request.error ? request.error.message : 'Unknown error' });
      request.onblocked = () => resolve({ name: info.name, error: 'Database open blocked' });
    });
  }

  /**
   * Capture localStorage, sessionStorage and IndexedDB of the page origin.
   */
  async function captureStorage() {
    const storage = { localStorage: {}, sessionStorage: {}, indexedDB: [], captureTimestamp: new Date().toISOString() };
    try {
      storage.localStorage = readWebStorage(window.localStorage);
    } catch (error) {
      storage.localStorage = { error: `localStorage access denied: ${error.message}` };
    }
    try {
      storage.sessionStorage = readWebStorage(window.sessionStorage);
    } catch (error) {
      storage.sessionStorage = { error: `sessionStorage access denied: ${error.message}` };
    }
    try {
      if (!window.indexedDB || !indexedDB.databases) {
        storage.indexedDB = [{ error: 'IndexedDB enumeration not available' }];
      } else {
        const databases = await indexedDB.databases();
        storage.indexedDB = await Promise.all(databases.filter(db => db.name).map(readDatabase));
      }
    } catch (error) {
      storage.indexedDB = [{ error: `IndexedDB enumeration failed: ${error.message}` }];
    }
    return storage;
  }

  /**
   * Handle message from background
   */
  async function handleMessage(message) {
    console.log('[Content Injector] Handling message:', message.type);

    switch (message.type) {
      case 'PING':
        return { success: true, loaded: true };

      case 'CAPTURE_DOM':
        try {
          const domData = captureDOMStructure();
          return { success: true, data: domData };
        } catch (error) {
          return { success: false, error: error.message };
        }

      case 'CAPTURE_STORAGE':
        try {
          return { success: true, data: await captureStorage() };
        } catch (error) {
          console.error('[Content Injector] Storage capture error:', error);
          return {
            success: false,
            error: error.message,
            data: { localStorage: {}, sessionStorage: {}, indexedDB: [] }
          };
        }

      default:
        return { success: false, error: 'Unknown message type' };
    }
  }

  /**
   * Listen for messages from background worker
   */
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message)
      .then(response => sendResponse(response))
      .catch(error => {
        console.error('[Content Injector] Message handling error:', error);
        sendResponse({ success: false, error: error.message });
      });

    return true; // Async response
  });

  console.log('[Content Injector] Initialized and ready');
})();
