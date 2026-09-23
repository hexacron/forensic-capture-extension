/**
 * Injected Page Script for Forensic Data Capture Extension
 *
 * This script runs in the actual page context (not extension context)
 * allowing it to access localStorage, sessionStorage, and IndexedDB.
 *
 * Communicates with content script via window.postMessage
 */

(function() {
  'use strict';

  console.log('[Injected] Forensic data capture page script loaded');

  /**
   * Listen for storage capture requests from content script
   */
  window.addEventListener('message', async (event) => {
    // Only accept messages from same window
    if (event.source !== window) {
      return;
    }

    // Handle storage capture request
    if (event.data && event.data.type === 'FORENSIC_CAPTURE_STORAGE_REQUEST') {
      const requestId = event.data.requestId;

      try {
        console.log('[Injected] Capturing storage data');

        const storageData = await captureAllStorage();

        // Send response back to content script
        window.postMessage({
          type: 'FORENSIC_CAPTURE_STORAGE_RESPONSE',
          requestId: requestId,
          success: true,
          data: storageData
        }, '*');

        console.log('[Injected] Storage data captured and sent');
      } catch (error) {
        console.error('[Injected] Storage capture failed:', error);

        // Send error response
        window.postMessage({
          type: 'FORENSIC_CAPTURE_STORAGE_RESPONSE',
          requestId: requestId,
          success: false,
          error: error.message
        }, '*');
      }
    }
  });

  /**
   * Capture all storage types
   * @returns {Promise<Object>} Storage data
   */
  async function captureAllStorage() {
    const storage = {
      localStorage: {},
      sessionStorage: {},
      indexedDB: [],
      captureTimestamp: new Date().toISOString()
    };

    // Capture localStorage
    try {
      storage.localStorage = captureLocalStorage();
    } catch (error) {
      console.error('[Injected] Failed to capture localStorage:', error);
      storage.localStorage = { error: error.message };
    }

    // Capture sessionStorage
    try {
      storage.sessionStorage = captureSessionStorage();
    } catch (error) {
      console.error('[Injected] Failed to capture sessionStorage:', error);
      storage.sessionStorage = { error: error.message };
    }

    // Capture IndexedDB
    try {
      storage.indexedDB = await captureIndexedDB();
    } catch (error) {
      console.error('[Injected] Failed to capture IndexedDB:', error);
      storage.indexedDB = [{ error: error.message }];
    }

    return storage;
  }

  /**
   * Capture localStorage contents
   * @returns {Object} localStorage data
   */
  function captureLocalStorage() {
    const data = {};

    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key !== null) {
          data[key] = localStorage.getItem(key);
        }
      }
    } catch (error) {
      throw new Error(`localStorage access denied: ${error.message}`);
    }

    return data;
  }

  /**
   * Capture sessionStorage contents
   * @returns {Object} sessionStorage data
   */
  function captureSessionStorage() {
    const data = {};

    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key !== null) {
          data[key] = sessionStorage.getItem(key);
        }
      }
    } catch (error) {
      throw new Error(`sessionStorage access denied: ${error.message}`);
    }

    return data;
  }

  /**
   * Capture IndexedDB databases and their contents
   * @returns {Promise<Array>} Array of database data
   */
  async function captureIndexedDB() {
    try {
      // Check if IndexedDB is available
      if (!window.indexedDB) {
        return [{ error: 'IndexedDB not available' }];
      }

      // Get list of databases
      const databases = await indexedDB.databases();

      if (!databases || databases.length === 0) {
        return [];
      }

      // Capture data from each database
      const dbDataPromises = databases.map(dbInfo => captureSingleDatabase(dbInfo));
      const dbData = await Promise.all(dbDataPromises);

      return dbData.filter(db => db !== null);
    } catch (error) {
      throw new Error(`IndexedDB enumeration failed: ${error.message}`);
    }
  }

  /**
   * Capture a single IndexedDB database
   * @param {Object} dbInfo - Database info from indexedDB.databases()
   * @returns {Promise<Object|null>} Database data
   */
  async function captureSingleDatabase(dbInfo) {
    return new Promise((resolve) => {
      const request = indexedDB.open(dbInfo.name);

      request.onsuccess = async (event) => {
        const db = event.target.result;

        try {
          const objectStoreNames = Array.from(db.objectStoreNames);
          const storesData = {};

          // Capture data from each object store
          for (const storeName of objectStoreNames) {
            try {
              const storeData = await captureObjectStore(db, storeName);
              storesData[storeName] = storeData;
            } catch (error) {
              console.error(`[Injected] Failed to capture object store ${storeName}:`, error);
              storesData[storeName] = { error: error.message };
            }
          }

          db.close();

          resolve({
            name: dbInfo.name,
            version: dbInfo.version,
            objectStores: objectStoreNames,
            data: storesData
          });
        } catch (error) {
          db.close();
          console.error('[Injected] Failed to capture database:', dbInfo.name, error);
          resolve({
            name: dbInfo.name,
            version: dbInfo.version,
            error: error.message
          });
        }
      };

      request.onerror = (event) => {
        console.error('[Injected] Failed to open database:', dbInfo.name, event.target.error);
        resolve({
          name: dbInfo.name,
          error: event.target.error ? event.target.error.message : 'Unknown error'
        });
      };

      request.onblocked = () => {
        console.warn('[Injected] Database open blocked:', dbInfo.name);
        resolve({
          name: dbInfo.name,
          error: 'Database open blocked'
        });
      };
    });
  }

  /**
   * Capture data from an object store
   * @param {IDBDatabase} db - Database instance
   * @param {string} storeName - Object store name
   * @returns {Promise<Array>} Store data
   */
  function captureObjectStore(db, storeName) {
    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction(storeName, 'readonly');
        const store = transaction.objectStore(storeName);
        const request = store.getAll();

        request.onsuccess = (event) => {
          const records = event.target.result || [];

          // Convert records to JSON-serializable format
          const serialized = records.map((record, index) => {
            try {
              // Try to serialize the record
              JSON.stringify(record);
              return record;
            } catch (error) {
              // If serialization fails, return a placeholder
              return {
                _index: index,
                _serializationError: 'Could not serialize record',
                _type: typeof record
              };
            }
          });

          resolve(serialized);
        };

        request.onerror = (event) => {
          reject(new Error(event.target.error ? event.target.error.message : 'Unknown error'));
        };

        transaction.onerror = (event) => {
          reject(new Error(event.target.error ? event.target.error.message : 'Transaction error'));
        };

      } catch (error) {
        reject(error);
      }
    });
  }

  console.log('[Injected] Forensic data capture page script initialized');
})();
