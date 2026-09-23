/**
 * Chrome DevTools Protocol session bound to a single tab (chrome.debugger).
 *
 * Chromium-only. Callers must treat attach failure as "CDP unavailable"
 * (Firefox/Safari, DevTools already attached, policy restrictions) and fall
 * back to WebExtension APIs.
 */

const PROTOCOL_VERSION = '1.3';

// Commands whose effect is observable from page JavaScript (e.g. Runtime.enable makes
// console argument serialization run page getters, a well-known automation check).
// Captures of watchful sites must never switch these on, so they are refused here.
const PAGE_DETECTABLE_COMMANDS = new Set([
  'Runtime.enable',
  'Debugger.enable',
  'Console.enable',
  'Log.enable',
  'Profiler.enable'
]);

export class CdpSession {
  static isSupported() {
    return Boolean(globalThis.chrome && chrome.debugger && chrome.debugger.attach);
  }

  static async attach(tabId) {
    if (!CdpSession.isSupported()) {
      throw new Error('chrome.debugger API not available in this browser');
    }
    const session = new CdpSession(tabId);
    await chrome.debugger.attach(session.target, PROTOCOL_VERSION);
    chrome.debugger.onEvent.addListener(session.handleEvent);
    chrome.debugger.onDetach.addListener(session.handleDetach);
    return session;
  }

  constructor(tabId) {
    this.target = { tabId };
    this.listeners = new Map();
    this.attached = true;
    this.detachReason = null;
    this.handleEvent = (source, method, params) => {
      if (source.tabId !== this.target.tabId) return;
      const handlers = this.listeners.get(method);
      if (handlers) for (const handler of handlers) handler(params || {});
    };
    this.handleDetach = (source, reason) => {
      if (source.tabId !== this.target.tabId) return;
      this.attached = false;
      this.detachReason = reason;
      this.removeChromeListeners();
    };
  }

  send(method, params = {}) {
    if (PAGE_DETECTABLE_COMMANDS.has(method)) {
      return Promise.reject(new Error(`${method} is refused: its effect is detectable by the page`));
    }
    if (!this.attached) {
      return Promise.reject(new Error(`CDP session detached (${this.detachReason || 'unknown'})`));
    }
    return chrome.debugger.sendCommand(this.target, method, params);
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
  }

  removeChromeListeners() {
    chrome.debugger.onEvent.removeListener(this.handleEvent);
    chrome.debugger.onDetach.removeListener(this.handleDetach);
  }

  async detach() {
    if (!this.attached) return;
    this.attached = false;
    this.removeChromeListeners();
    try {
      await chrome.debugger.detach(this.target);
    } catch {
      // Already detached (tab closed or user cancelled the debugging infobar).
    }
  }
}
