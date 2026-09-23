/**
 * Background-side client for src/content/page-tools.js.
 */

import '../../lib/browser-polyfill.min.js';

const PAGE_TOOLS_FILE = 'src/content/page-tools.js';
// Must match TOOLKIT_VERSION in page-tools.js.
const PAGE_TOOLS_VERSION = 8;

/**
 * Inject the page toolkit into the tab's isolated world unless a copy of the
 * same version is already there (needed after navigation, reload, or an
 * extension update that left an older toolkit behind).
 */
export async function ensurePageTools(tabId) {
  const [probe] = await browser.scripting.executeScript({
    target: { tabId },
    func: () => (window.__forensicPageTools ? window.__forensicPageTools.version || 0 : null)
  });
  if (probe && probe.result === PAGE_TOOLS_VERSION) return;
  await browser.scripting.executeScript({ target: { tabId }, files: [PAGE_TOOLS_FILE] });
}

/**
 * Invoke a page tool and return its value; page-side exceptions are rethrown here.
 */
export async function callPageTool(tabId, name, ...args) {
  const [injection] = await browser.scripting.executeScript({
    target: { tabId },
    func: (toolName, toolArgs) => window.__forensicPageTools
      ? window.__forensicPageTools.call(toolName, toolArgs)
      : { ok: false, error: 'Page tools not injected' },
    args: [name, args]
  });
  const envelope = injection && injection.result;
  if (!envelope) throw new Error(`Page tool ${name} returned no result`);
  if (!envelope.ok) throw new Error(`Page tool ${name} failed: ${envelope.error}`);
  return envelope.value;
}
