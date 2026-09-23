# Claude Development Notes - Exhibit

## Project Overview

**Project:** Exhibit (web evidence capture; formerly "Forensic Data Capture")
**Version:** 1.2.1
**Status:** Production Ready
**Development Start:** 2026-01-08
**Last Updated:** 2026-09-23

## What This Extension Does

Captures forensic evidence from web pages including:
- **Full-page scrolling screenshots** (scroll-and-stitch algorithm)
- **Complete DOM structure** with metadata
- **Browser storage** (localStorage, sessionStorage, IndexedDB)
- **HTTP cookies** with all attributes
- **SHA-256 hashes** for integrity verification
- **Chain of custody logging** for forensic compliance
- **Organized folder downloads** (timestamped folders)
- **Threads posts with all replies** (threads.com / threads.net): structured thread data,
  raw API evidence, media files and a readable HTML report

## Architecture

### Technology Stack
- **Manifest V3** (WebExtensions API)
- **Service Worker** background script
- **Content Scripts** with programmatic injection
- **Page Context Injection** for storage access
- **webextension-polyfill** for cross-browser support

### Key Components

```
src/
├── background/          # Service worker
│   ├── background.js           # Message router, capture state
│   ├── capture-manager.js      # Orchestration, evidence files, hashing, manifest
│   ├── screenshot-capture.js   # Scroll-and-stitch, segment stitcher, capture backends
│   ├── threads-capture.js      # Threads session: CDP network capture, reply loading, media
│   ├── cdp-session.js          # chrome.debugger wrapper (Chromium only)
│   ├── human-input.js          # Trusted wheel/pointer/key input + careful/fast pacing
│   ├── page-tools-client.js    # Injects/calls the page toolkit, version-checked
│   ├── forensic-metadata.js    # Manifest generation
│   └── download-manager.js     # File downloads (bytes -> data URL)
├── content/             # Injected into pages
│   ├── content-injector.js     # DOM + storage bridge (PING/CAPTURE_DOM/CAPTURE_STORAGE)
│   └── page-tools.js           # Scroll container, overlays, Threads harvest/expand
├── threads/             # Pure logic, no browser APIs (also imported by the popup)
│   ├── threads-parser.js       # URL parse, API walk, dataset merge, completeness checks
│   └── threads-report.js       # Static HTML evidence report
├── popup/               # User interface
│   ├── popup.html              # Includes the Threads options panel
│   ├── popup.js
│   └── popup.css
└── utils/               # Shared utilities
    ├── crypto-utils.js         # SHA-256 hashing
    ├── encoding-utils.js       # base64 <-> bytes (service-worker safe)
    ├── zip-writer.js           # Dependency-free ZIP (deflate-raw / store), one download per capture
    ├── timestamp-utils.js      # ISO 8601 timestamps
    ├── logger.js               # Chain of custody
    └── validation.js           # Data validation
```

## Development History

### Initial Build (v1.0.0)
- Planned implementation using plan mode
- Built core architecture with utilities, background worker, content scripts
- Implemented viewport screenshot capture
- Added DOM, storage, and cookies capture
- Created SHA-256 hashing and forensic manifest

### Bug Fixes (v1.0.1)
**Issue 1: "browser is not defined"**
- Root cause: Missing polyfill imports in ES6 modules
- Fixed by adding `import '../../lib/browser-polyfill.min.js';` to all background modules

**Issue 2: "Could not establish connection"**
- Root cause: Content scripts only load on NEW tabs, not existing tabs
- Fixed by implementing programmatic script injection with PING handler
- Created `content-injector.js` (standalone, no ES6 imports)
- Added `ensureContentScriptInjected()` method

### Feature Additions (v1.1.0)

**Feature 1: Folder Organization**
- All captures now download into `forensic-capture-{TIMESTAMP}/` folders
- Modified `download-manager.js` to support folder paths
- Updated `capture-manager.js` to generate folder names

**Feature 2: Full-Page Scrolling Screenshots**
- Implemented scroll-and-stitch algorithm
- Created `screenshot-capture.js` module
- Captures entire scrollable page (not just viewport)
- Automatic fallback to viewport capture if scroll fails

**Bug Fix: Image Constructor in Service Worker**
- Issue: `Image` constructor not available in service workers
- Fixed by using `createImageBitmap()` API instead
- Converted data URLs to blobs, then to image bitmaps

**Bug Fix: Chrome Rate Limit**
- Issue: `MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND` quota exceeded
- Fixed by adding 600ms delay between captures
- Total delay: 500ms (render) + 600ms (rate limit) = 1.1s per section

### Bug Fixes & Security (v1.1.1)

**Security: Content Security Policy**
- Issue: No CSP defined in manifest.json
- Fixed by adding strict CSP: `script-src 'self'; object-src 'self'`
- Prevents XSS attacks on extension pages
- Follows Manifest V3 security best practices

**Bug Fix: Download Timeout**
- Issue: Large files (>2MB) timing out on slow connections
- Fixed by increasing timeout from 30s to 60s in download-manager.js
- Improves reliability for full-page screenshots

**Bug Fix: Message Listener Memory Leak**
- Issue: Duplicate listeners accumulating in popup on repeated captures
- Fixed by tracking listener reference and removing before adding new
- Added cleanup on capture completion and error
- Prevents memory leaks and improves performance

**Code Quality: UI Cleanup**
- Removed non-functional settings link (no settings page yet)
- Updated popup version display: v1.0.0 → v1.1.1
- Added comment for future settings implementation

### Critical Bug Fix (v1.1.2)

**Bug Fix: Screenshot Cutting Off Top**
- Issue: Full-page screenshots missing top portion of pages
- Root cause: Capture started from current scroll position, not page top
- User report: "the scrolling screenshot cuts off the pages at the top when it captures"
- Fixed by scrolling to (0, 0) BEFORE starting capture loop
- Added 500ms settle delay after initial scroll to top
- Skip delay on first capture since already at top
- Restore original scroll position after capture completes
- File: `src/background/screenshot-capture.js` lines 46-89

**Technical Details:**
```javascript
// OLD (broken):
for (let i = 0; i < sections; i++) {
  scrollTo(0, i * viewportHeight);  // First iteration might be at scrollY=1000
  capture();
}

// NEW (fixed):
scrollTo(0, 0);  // Explicitly go to top first
await delay(500);
for (let i = 0; i < sections; i++) {
  if (i > 0) scrollTo(0, i * viewportHeight);
  capture();
}
scrollTo(originalX, originalY);  // Restore position
```

### Threads Capture + Screenshot Correctness (v1.2.0)

**Feature: Threads post + reply capture**
- New `src/threads/threads-parser.js` (pure): post-URL parsing, structure-agnostic walk over
  API JSON, dataset merge, role classification (root / ancestor / reply / related),
  completeness checks.
- New `src/background/threads-capture.js`: attaches `chrome.debugger`, records
  `/api/graphql` response bodies, optionally reloads the page so those responses are seen
  from the first byte, dismisses the login modal, loads all replies, downloads media.
- New `src/content/page-tools.js`: one versioned toolkit injected into the extension's isolated
  world; the worker drives it step by step (`beginScreenshot`, `position`, `threadsHarvest`,
  `threadsExpanderTargets`, `threadsLoadState`, `measureTopInset`, …). It reads the page and
  reports coordinates; it never clicks or restyles anything on Threads.
- New `src/background/human-input.js`: trusted wheel/pointer/key input via the DevTools
  protocol and the `careful`/`fast` pacing profiles.
- Data comes from three sources merged by shortcode: embedded Relay payloads, GraphQL
  responses, and per-post DOM harvested on every scroll step (Threads virtualises its list,
  so a single end-of-capture DOM snapshot misses most posts).
- Reply linkage: replies arrive under a container that only carries the parent post *id*
  (`{ id, text_post_app_info: { direct_replies … } }`), so parents are recorded as ids and
  resolved to shortcodes after all payloads are parsed.

**Bug Fix: HiDPI screenshots were quarter-cropped**
- `captureVisibleTab` returns device pixels; the stitcher used CSS pixels for the canvas and
  the source rect, so at DPR 2 only the top-left quarter of every frame was drawn.
- Scale is now derived from the captured bitmap (`bitmap.width / window.innerWidth`).

**Bug Fix: duplicated strip at the bottom of every page**
- Frames were placed at the *requested* offset; the browser clamps the last scroll, so the
  final frame repeated content. Frames are now placed at the offset read back from the page,
  and each frame only fills the region not already covered.

**Bug Fix: sticky/fixed elements repeated in every frame**
- Overlays are hidden after the first frame (`hideFixedElements`) and restored afterwards.
  Full-viewport wrappers and ancestors of the scroll container are left alone.

**Bug Fix: pages whose document does not scroll captured one viewport**
- The real scroll container is detected (largest scrollable element) and scrolled; frames are
  cropped to its client rect.

**Bug Fix: infinite-scroll pages never finished**
- Threads' "Related threads" feed grows forever while scrolling, so the first run spent
  600 frames on recommendations. The capture height is fixed before the first frame and, for
  Threads, limited to the "Related threads" marker; reply loading also stops there and
  measures growth on thread content only.

**Bug Fix: reply loading never terminated**
- Threads keeps a permanent "Loading…" spinner at the end of the list, and the loop treated
  a visible spinner as progress. The spinner now only buys a bounded number of extra rounds.

**Bug Fix: hashes.txt did not verify the manifest**
- The manifest hash was computed and then written into the manifest, changing the file after
  hashing. Every file is built once as bytes, hashed from those bytes and downloaded from
  those bytes; `hashes.txt` is plain `sha256sum` format (no comment lines, which make
  `shasum -c` warn).

**Bug Fix: failed downloads reported success**
- `DownloadManager.downloadFiles` collected per-file errors that nobody inspected. The
  capture now fails and logs `download-failed` to the chain of custody.

**Bug Fix: `content.js` threw on every page load**
- It was registered in `content_scripts` but used ES module `import`, which content scripts
  cannot do. Every page load logged a SyntaxError and the extension silently fell back to
  injecting `content-injector.js`. The declarative registration, `content.js` and
  `dom-capture.js` are gone.

**Robustness: capture can no longer hang forever**
- Minimised or fully covered windows stop compositing, and then *no* screenshot backend can
  produce a frame (verified: both `Page.captureScreenshot` and `captureVisibleTab` block
  indefinitely). Frames now time out with a message telling the user to keep the window
  visible.

**Security: popup no longer builds HTML from captured URLs**
- History rows and result rows are built with `textContent`.

### Rename to Exhibit + New Icon (v1.2.1)
- Product name "Forensic Data Capture" → **Exhibit** (manifest, popup, manifest `capturedBy`,
  HTML report "Tool" row, hashes.txt header). Evidence file names stay
  `forensic-capture-<ts>.zip` / `forensic-capture-<ts>/` (descriptive for recipients).
- Icon: red evidence tag, generated by `generate_icons.py` (Pillow, 16x supersampled, box
  downsampling). Per-size designs on each size's pixel grid; added `icon32.png` for the
  Retina toolbar. Pillow floors polygon vertices and fills both boundary pixels: polygons map
  onto `[0.5, size*k - 0.5]`, boxes end one pixel early, or edges bleed 1/16 alpha.

## Technical Implementation Details

### Full-Page Screenshot Algorithm (v1.2.0)

```text
1. Inject page-tools (version-checked) and call beginScreenshot():
   -> real scroll container, its client rect, viewport size, devicePixelRatio,
      scrollHeight, current scroll position (restored at the end)
2. ceiling = min(maxCssHeight ?? scrollHeight, scrollHeight)     // infinite feeds
3. Scroll to 0, settle 500ms
4. Loop:
   a. wait until the tab is the active tab in its window
   b. read the live scroll offset (never assume the requested one - it gets clamped)
   c. capture one frame (CDP Page.captureScreenshot, or captureVisibleTab paced at 600ms;
      20s timeout because occluded windows never produce a frame)
   d. stitcher places [max(covered, scrollTop) .. min(scrollTop+regionHeight, ceiling)]
      scale = bitmap.width / window.innerWidth, source rect cropped to the scroll region
   e. after the first frame: hideFixedElements()
   f. Threads only: harvest the posts rendered in this frame
   g. stop when covered >= ceiling, or the page refuses to scroll further
5. endScreenshot(): restore overlays and the original scroll position
6. Stitcher.finish(): PNG segments, max 16384px tall and 32Mpx each, one canvas in
   memory at a time; trailing canvas cropped to the filled height
```

Output: `{ segments: [{bytes, width, height}], backend, frames, truncated, imageScale,
captureHeightLimit, pageHeightAtStart, fixedElementsHidden }` - all recorded in the manifest.

### Content Script Injection Strategy

```javascript
// Try to ping existing content script
try {
  await browser.tabs.sendMessage(tabId, { type: 'PING' });
  // Already loaded
} catch {
  // Inject programmatically
  await browser.scripting.executeScript({
    target: { tabId },
    files: ['lib/browser-polyfill.min.js', 'src/content/content-injector.js']
  });
}
```

### Storage Access (isolated world only)

```
Background Worker → content-injector.js (isolated world, same origin storage)
                      → localStorage / sessionStorage / IndexedDB
                    ← runtime message response
```

Until v1.2.0 storage was read by `src/injected/injected.js`, inserted into the page as a
`<script>` and bridged with `window.postMessage`. Site scripts could see the script element,
its console lines and the whole storage payload, and `web_accessible_resources` let any site
probe for the extension. Both are gone: never run capture code in the page's main world.

### Threads Capture Pipeline

```text
prepare()
  attach chrome.debugger -> Network.enable, record /api/graphql request+response bodies
  optional reload (bypassCache) so the post's own queries are recorded
  wait for rendered posts, dismiss the login dialog (trusted Escape via CDP)
  verify the tab is still on the target post (otherwise: login wall)
loadAllReplies()
  round = expand "show more replies" buttons -> scroll to the end of thread content
  harvest rendered posts; growth measured on thread content height, new posts, clicks
  stop after 3 rounds without growth (spinner buys at most 5 extra rounds),
  or 400 rounds / 10 minutes
screenshot pass
  maxCssHeight = Y of the "Related threads" marker; harvest again on every frame
finalize()
  parse embedded script[data-sjs] payloads + recorded GraphQL bodies (deep walk),
  merge with DOM observations, classify roles, compare captured vs reported reply counts,
  fetch media (4 concurrent, 150MB cap, credentials omitted)
dispose()
  detach chrome.debugger (always, in a finally block)
```

Why three sources: Threads virtualises its reply list (off-screen posts are removed from the
DOM), the first reply batch only exists in the server-embedded payload, later batches only in
GraphQL responses, and the rendered text is the only proof of what a viewer actually saw.

## Files Generated Per Capture

Each capture is saved as one `forensic-capture-<ts>.zip` (single download; the ZIP's SHA-256 is
shown in the popup and kept in capture history). Extracted, it is a timestamped folder:

```
forensic-capture-20260922T143045Z/
├── 20260922T143045Z-manifest.json         # Forensic metadata + file hashes
├── 20260922T143045Z-screenshot.png        # Full-page screenshot (-partNN.png if very long)
├── 20260922T143045Z-dom.json              # HTML structure at end of capture
├── 20260922T143045Z-storage.json          # Browser storage
├── 20260922T143045Z-cookies.json          # HTTP cookies
└── 20260922T143045Z-hashes.txt            # SHA-256 hashes (sha256sum format)
```

Threads captures add:

```
├── 20260922T143045Z-thread.json           # Normalized post + replies
├── 20260922T143045Z-thread-report.html    # Readable report
├── raw/…-threads-api-responses.json       # Raw GraphQL bodies (no auth tokens)
├── raw/…-threads-embedded-data.json       # Raw embedded payloads
├── raw/…-threads-dom-posts.json           # Per-post outerHTML + rendered text
└── media/CODE-NN.jpg|mp4                  # Downloaded post media
```

## Known Issues & Limitations

### Platform Limitations
- **Occluded windows cannot be captured:** if the browser window is minimised or fully
  covered, the OS stops compositing it and *every* screenshot API blocks forever. The
  capture times out after 20s per frame with an explanatory error. Verified with both
  `Page.captureScreenshot` and `chrome.tabs.captureVisibleTab`.
- **Rate limit:** max 2 `captureVisibleTab()` calls per second; paced at 600ms. The CDP
  backend (Threads captures) has no such limit.
- **`chrome.debugger` is Chromium-only** and fails if DevTools is already attached to the
  tab; the session then degrades to DOM + embedded data and `captureVisibleTab`.

### Screenshot Limitations
- **Very long pages:** one frame per viewport, so a 20,000px page takes ~15-30s (CDP) or
  ~25-40s (`captureVisibleTab`)
- **Sticky headers/footers:** captured in the first frame only (hidden afterwards)
- **Lazy-loaded images:** 500ms settle per frame; slower loaders may still miss
- **Animated content / video:** each frame is a different moment in time
- **Infinite feeds:** captured height is fixed before the first frame, so content appended
  during capture is not included (recorded as `truncated` in the manifest)

### Threads Limitations
- Hidden, restricted, deleted and account-filtered replies cannot be captured; the
  discrepancy is reported instead of silently ignored
- Replies to replies live on their own permalink and are listed in
  `repliesWithUncapturedChildren`
- Parent linkage comes from API data; DOM-only posts have `parentCode: null`
- Video posts using MSE/blob URLs are only recorded when the API exposes a direct
  `video_versions` URL

### Browser Compatibility
- **Chrome:** fully supported (tested)
- **Firefox:** DOM/storage/cookies/screenshots work; no `chrome.debugger`, so Threads
  captures fall back to embedded data + DOM (not yet tested)
- **Safari:** same fallback as Firefox (not yet tested)

## Testing Checklist

Legend: **auto** = covered by `npm test`; **live** = observed in a real Chromium with the
extension loaded on a real threads.com post; **open** = not verified yet.

### Core Functionality
- [x] Extension loads without errors (live, Chrome for Testing 145)
- [x] Popup UI displays correctly (live, screenshot of the Threads panel)
- [x] Capture button triggers capture (live)
- [x] Progress updates show in popup (live: prepare -> reply loading -> screenshot)
- [x] Files download successfully (live: full Threads captures, 18-19 files, every entry in
      hashes.txt verified with `shasum -a 256 -c`)

### Folder Organization
- [x] Folder path and file names built per capture (auto)
- [x] Folder appears in the downloads directory with `raw/` and `media/` subfolders (live)

### Full-Page Screenshots
- [x] Frames are contiguous: no gaps, no duplicated strip at the bottom (auto)
- [x] Native resolution at devicePixelRatio 2, no quarter-crop (auto)
- [x] Long pages split into segments within canvas limits (auto: 18000px -> 13107 + 4893)
- [x] Inner scroll containers cropped to their client rect (auto)
- [x] Height ceiling honoured for infinite feeds (auto)
- [x] Scroll container detection, fixed-overlay hiding and scroll restore (live, on threads.com)
- [x] Capture fails with a clear error instead of hanging when the window is occluded (live:
      both `Page.captureScreenshot` and `captureVisibleTab` were observed blocking forever)
- [x] Visual inspection of a stitched PNG from a real capture (live: whole thread in one image,
      header once, no gaps/repeats, login prompt removed, cut at "Related threads")

### Threads Capture
- [x] Popup detects a post URL and shows the options panel (live)
- [x] Login modal dismissed before capture (live)
- [x] Reply loading terminates; permanent "Loading…" spinner does not loop (live)
- [x] "Related threads" feed excluded from data and screenshot height (live + auto)
- [x] Embedded and GraphQL payloads parsed; replies linked to the root post (auto + live data)
- [x] Related posts excluded, quoted posts summarised, media URLs picked (auto)
- [x] Reply-count discrepancy and unavailable replies reported (auto + live data)
- [ ] Logged-in thread with paginated replies and media download (open: needs an account)

### Data Integrity
- [x] SHA-256 over the exact bytes written to disk (auto)
- [x] `shasum -a 256 -c *-hashes.txt` verifies every file, manifest and report included (auto)
- [x] Manifest never contains its own hash; manifest entries match the files (auto)
- [x] Report is script-free and escapes post text, usernames and investigator fields (auto)
- [x] Chain of custody logging complete (live: capture, CDP attach, reload, key events,
      reply loading, extraction)
- [x] ISO 8601 timestamps in UTC (auto)

### Content Script Injection
- [x] Works on existing tabs (auto-injection) (live)
- [x] PING handler responds correctly (live)
- [x] Page toolkit re-injected when a stale version is present (live: caught a stale
      toolkit during development, which is why `TOOLKIT_VERSION` exists)
- [x] DOM/storage capture on a Threads page (live, full captures)

### Cross-Browser Testing
- [x] Chrome (live)
- [ ] Firefox (open)
- [ ] Safari (open)

## Performance Characteristics

### Capture Times
- **Short page** (<2000px): 3-5 seconds
- **Medium page** (2000-5000px): 8-12 seconds
- **Long page** (5000-10000px): 15-25 seconds
- **Very long page** (>10000px): 30+ seconds

### File Sizes
- **Screenshot:** 500KB - 3MB (depends on page length)
- **DOM:** 50KB - 500KB (depends on page complexity)
- **Storage:** 1KB - 100KB (depends on stored data)
- **Cookies:** 1KB - 10KB
- **Manifest:** 5KB - 20KB
- **Hashes:** <1KB

## Future Roadmap

### v1.3.0 (Planned)
- Settings page (investigator name, case number, capture options)
- Toggle between full-page and viewport capture
- Custom folder name prefix
- Configurable scroll delay
- Threads profile/feed capture (multiple posts in one run)
- Follow nested reply permalinks automatically

### v1.4.0 (Planned)
- ZIP packaging of evidence folders
- Network traffic capture (HAR export)
- Batch capture multiple tabs
- Screenshot quality settings
- Selective capture options

### v2.0.0 (Future)
- Video recording capability
- Encrypted evidence packages
- Cloud backup integration
- Custom forensic report formats
- Timeline view for multiple captures

## Key Learnings & Best Practices

### Service Worker Gotchas
1. **No DOM APIs:** Use `createImageBitmap()` instead of `Image()`
2. **No `blob:` URLs:** downloads must use data URLs built from bytes (`bytesToBase64`)
3. **No dynamic `import()`:** service workers reject it; everything is statically imported
4. **Rate Limits:** Respect `captureVisibleTab()` quota (2/sec max)
5. **Module Imports:** Must import polyfill in each ES6 module
6. **`chrome.runtime.sendMessage` from the worker does not reach the worker's own listener**

### Content Script Injection
1. **Auto-inject for existing tabs:** Use programmatic injection with PING check
2. **No ES6 imports in injected files:** `page-tools.js` and `content-injector.js` are plain
   IIFEs. A declarative content script using `import` fails on every page load.
3. **Polyfill first:** Always inject polyfill before content script
4. **Version the toolkit:** long-lived pages keep an old copy after an extension reload;
   `page-tools.js` carries `TOOLKIT_VERSION` and is re-injected when it differs

### Account Safety (low automation footprint)
1. **Never run code in the page's main world** and never expose `web_accessible_resources`;
   site scripts can see injected `<script>` tags, `postMessage` traffic, console lines, and
   can probe `chrome-extension://<id>/…` URLs.
2. **Never mutate the site's DOM on watchful sites** (MutationObserver sees style changes);
   Threads screenshots crop the sticky header band (`measureTopInset`) instead of hiding it.
3. **Only trusted input:** `element.click()` and `scrollTo()` are detectable (`isTrusted`
   false, scroll without wheel). Use `HumanInput` (CDP `Input.dispatchMouseEvent` /
   `dispatchKeyEvent`); without CDP, do not click at all.
4. **Never enable Runtime/Debugger/Console/Log/Profiler over CDP** — the stack-getter check
   detects Runtime. `CdpSession.send` refuses them. Test harnesses must not enable them either
   (use `Runtime.evaluate` without `Runtime.enable`).
5. **Verify with a detector, not by reasoning:** install listeners/observers in the page's main
   world and run a real capture; the pre-safety build tripped six signals.
6. **Back off, don't insist:** one Escape per dialog (never repeated once futile, max 6), and
   stop reply loading after 3 wheel steps that do not move the page. A first build pressed
   Escape 322 times at an unclosable login prompt - that is exactly what bot detection sees.
7. **Policy by session:** `detectSignedIn()` (Threads `sessionid` cookie). Signed out = no
   account at risk, so programmatic scroll fallback and modal hiding are allowed; signed in =
   never. Recorded in the manifest as `threadsCapture.automationFootprint`.
8. **Genuine clicks act as the account:** hit-test the element under the pointer
   (`threadsVerifyTarget`) before every press. Pressable post wrappers react to pointer events
   that only genuine clicks produce.
9. **Measure the container the input scrolls:** `findScroller()` anchors on the visible post
   (`visibleThreadsPost` → nearest scrollable ancestor), and `scrollPointer` hit-tests a
   wheel point whose scroll chain reaches that container. Signed-in Threads has a tall hidden
   feed behind the opened post, so the document is scrollable but is not what moves.

### Screenshot Correctness
1. **Never trust the requested scroll offset:** read it back; browsers clamp at the end
2. **Derive scale from the captured bitmap**, not `devicePixelRatio` alone (zoom, HiDPI)
3. **The document is not always the scroller** (app shells, modal scroll-lock)
4. **Occluded windows produce no frames at all** - time out instead of blocking
5. **Infinite feeds need a height ceiling** decided before the first frame

### Canvas Operations
1. **OffscreenCanvas:** Works in service workers
2. **createImageBitmap():** Async image loading for workers; `close()` each bitmap
3. **convertToBlob():** Convert canvas to downloadable blob
4. **Limits:** ~16384px per dimension, ~32Mpx per canvas -> emit PNG segments

### Forensic Best Practices
1. **Hash the bytes you write:** build each file once, hash those bytes, download those bytes
2. **Never write a file's own hash into it** (that was the v1.1.x manifest bug)
3. **SHA-256 for everything:** Every file gets a hash
4. **ISO 8601 timestamps:** UTC timestamps for consistency
5. **Chain of custody:** Log every action, including reloads, key events and CDP attach
6. **Report what is missing:** captured-vs-reported reply counts, truncation, failed media
7. **Do not record auth tokens** from captured API requests (`fb_dtsg`, `lsd`, `jazoest`)

## Development Commands

### Testing
```bash
# Load extension in Chrome
chrome://extensions/ → Developer mode → Load unpacked → select folder

# View service worker console
chrome://extensions/ → Service Worker (inspect)

# Reload extension after changes
chrome://extensions/ → Reload button

# Test hash verification
cd Downloads/forensic-capture-{TIMESTAMP}/
shasum -a 256 -c *-hashes.txt   # macOS; sha256sum -c on Linux
```

### Packaging
```bash
# Create ZIP for Chrome Web Store
zip -r forensic-capture.zip . -x "*.git*" -x "*.DS_Store"

# Build for Firefox (requires web-ext)
web-ext build
```

## Troubleshooting

### "browser is not defined"
- **Cause:** Missing polyfill import
- **Fix:** Already implemented (v1.0.1) - polyfill in all modules

### "Could not establish connection"
- **Cause:** Content script not loaded on existing tab
- **Fix:** Already implemented (v1.0.1) - auto-injection with PING

### "MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND"
- **Cause:** Too many captureVisibleTab() calls
- **Fix:** Already implemented (v1.1.0) - 600ms delay between captures

### Screenshot missing top of page
- **Cause:** Capture started from current scroll position
- **Fix:** Already implemented (v1.1.2) - scroll to top before capture

### Screenshot is zoomed / only shows part of each section
- **Cause:** CSS pixels mixed with device pixels on HiDPI displays
- **Fix:** Already implemented (v1.2.0) - scale derived from the captured bitmap

### Screenshot repeats the header all the way down
- **Cause:** Fixed/sticky overlays captured in every frame
- **Fix:** Already implemented (v1.2.0) - overlays hidden after the first frame

### "Screenshot timed out. Keep the browser window visible…"
- **Cause:** the window is minimised or fully covered, so the OS stopped compositing it
- **Solution:** bring the window to the front and re-run; this is an OS limit, not a bug

### Threads capture: "Threads refused to open post … (error=invalid_post)" completeness note
- **Cause:** signed-in Threads can refuse to load a post from its link (redirects to the feed,
  sometimes with `?error=invalid_post`) even though the in-app view shows it. A plain reload of
  the user's tab hits the same thing, which is why v1.2.0 never navigates the user's tab.
- **Behavior:** the fresh load happens in a separate tab; on refusal that tab is closed and the
  post is captured as displayed in the user's tab. Posts rendered before the capture then have
  rendered text only (their API responses were not recorded)
- **Verified:** simulated by answering the post URL's document request with a 302 to
  `/?error=invalid_post` at the browser level; capture completed with the note in thread.json,
  report and manifest

### Threads capture reports fewer replies than the post claims
- **Cause:** hidden/restricted/deleted replies, account filtering, or nested replies that live
  on their own permalink
- **Solution:** expected; see the report's completeness notes and the listed permalinks

### Download timeout on large files
- **Cause:** Default 30s timeout too short for large screenshots
- **Fix:** Already implemented (v1.1.1) - 60s timeout

### Screenshot is blank/incomplete
- **Cause:** Page not fully loaded or CSP blocking
- **Solution:** Wait for page load before capturing, check console for CSP errors

### Folder not created
- **Cause:** Browser download settings or permissions
- **Solution:** Check browser's download settings, ensure extension has downloads permission

## Credits

**Developer:** Built with AI assistance (Claude)
**License:** MIT License
**Platform:** WebExtensions API (Manifest V3)
**Browser Support:** Chrome, Firefox, Safari

## Documentation Files

- **README.md** - User guide and installation instructions
- **CHANGELOG.md** - Version history and upgrade guide
- **IMPROVEMENTS.md** - Feature documentation (v1.1.0)
- **BUILD_COMPLETE.md** - Build status and quick start
- **FIXED.md** - Bug fixes and solutions
- **NEXT_STEPS.md** - Testing checklist and roadmap
- **CLAUDE.md** - This file (development notes)
- **tests/** - `npm test`: stitcher geometry, Threads parser contract, evidence pipeline

---

## Version History Summary

| Version | Date | Type | Key Changes |
|---------|------|------|-------------|
| **1.2.1** | 2026-09-23 | Rename | 🏷️ Renamed to Exhibit<br>🎨 Evidence-tag icon (16/32/48/128) |
| **1.2.0** | 2026-09-22 | Feature + Fixes | 🧵 Threads post + reply capture (thread.json, HTML report, raw API evidence, media)<br>🐛 HiDPI screenshots, duplicated bottom strip, repeated sticky overlays, inner scroll containers, infinite feeds<br>🐛 hashes.txt now verifies the manifest<br>🐛 Removed broken declarative content script |
| **1.1.2** | 2026-01-09 | Bug Fix | 🐛 Fixed screenshots cutting off top of pages<br>✨ Restore scroll position after capture |
| **1.1.1** | 2026-01-08 | Security | 🔒 Added Content Security Policy<br>🐛 60s download timeout<br>🐛 Fixed memory leak |
| **1.1.0** | 2026-01-08 | Feature | 📁 Folder organization<br>📸 Full-page scrolling screenshots |
| **1.0.1** | 2026-01-08 | Bug Fix | 🐛 Browser polyfill imports<br>🐛 Content script injection |
| **1.0.0** | 2026-01-08 | Initial | 🎉 Core forensic capture functionality |

---

**Current Version:** 1.2.1
**Last Updated:** 2026-09-23
**Status:** ✅ Production Ready
