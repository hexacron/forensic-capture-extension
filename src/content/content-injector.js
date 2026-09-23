/**
 * Content Script Injector - Standalone version for programmatic injection
 * No ES6 imports - inline everything needed
 */

(function() {
  'use strict';

  console.log('[Content Injector] Initializing...');

  // Flag to track if injected script is loaded
  let injectedScriptLoaded = false;
  let storageResolvers = new Map();
  let storageRequestId = 0;

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

  /**
   * Inject page-context script
   */
  async function injectPageScript() {
    return new Promise((resolve, reject) => {
      try {
        console.log('[Content Injector] Injecting page-context script');
        const script = document.createElement('script');
        script.src = browser.runtime.getURL('src/injected/injected.js');

        script.onload = () => {
          console.log('[Content Injector] Page script loaded');
          injectedScriptLoaded = true;
          script.remove();
          setTimeout(() => resolve(), 100);
        };

        script.onerror = (error) => {
          console.error('[Content Injector] Page script load error:', error);
          reject(new Error('Failed to inject page script'));
        };

        (document.head || document.documentElement).appendChild(script);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Request storage data from page context
   */
  function requestStorageFromPage() {
    return new Promise((resolve, reject) => {
      const requestId = storageRequestId++;
      const timeout = setTimeout(() => {
        storageResolvers.delete(requestId);
        reject(new Error('Storage capture timeout'));
      }, 5000);

      storageResolvers.set(requestId, { resolve, reject, timeout });

      window.postMessage({
        type: 'FORENSIC_CAPTURE_STORAGE_REQUEST',
        requestId: requestId
      }, '*');
    });
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
          if (!injectedScriptLoaded) {
            await injectPageScript();
          }
          const storageData = await requestStorageFromPage();
          return { success: true, data: storageData };
        } catch (error) {
          console.error('[Content Injector] Storage capture error:', error);
          return {
            success: false,
            error: error.message,
            data: {
              localStorage: {},
              sessionStorage: {},
              indexedDB: []
            }
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

  /**
   * Listen for messages from injected page script
   */
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    if (event.data && event.data.type === 'FORENSIC_CAPTURE_STORAGE_RESPONSE') {
      const requestId = event.data.requestId;
      const resolver = storageResolvers.get(requestId);

      if (resolver) {
        clearTimeout(resolver.timeout);
        storageResolvers.delete(requestId);

        if (event.data.success) {
          resolver.resolve(event.data.data);
        } else {
          resolver.reject(new Error(event.data.error || 'Storage capture failed'));
        }
      }
    }
  });

  console.log('[Content Injector] Initialized and ready');
})();
