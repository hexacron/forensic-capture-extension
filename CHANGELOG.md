# Changelog - Exhibit (formerly Forensic Data Capture Extension)

All notable changes to this project will be documented in this file.

---

## [1.2.1] - 2026-09-23

### 🏷️ Renamed to Exhibit, new icon

- The extension is now called **Exhibit** ("Web Evidence Capture"): Chrome toolbar and
  extensions page, popup header, `capturedBy` in the forensic manifest, the "Tool" row of the
  Threads HTML report, and the `hashes.txt` header. Evidence files keep their names
  (`forensic-capture-<timestamp>.zip`).
- New evidence-tag icon, drawn per size so it stays sharp; adds a 32 px icon for the toolbar on
  Retina/HiDPI displays. Regenerate with `python3 generate_icons.py`.

---

## [1.2.0] - 2026-09-22

### ✨ Threads Post Capture

Opening a Threads post (`threads.com/@user/post/CODE`) now switches the popup into
thread mode and captures the post together with its replies.

- **Reply loading** — scrolls and clicks "show more replies" until the thread stops
  growing, so virtualised replies are all observed. Stops at the "Related threads"
  marker, so the endless recommendation feed is never pulled in.
- **Thread data extraction** (`YYYYMMDDTHHmmssZ-thread.json`) — post text, author,
  user id, UTC timestamps, like/reply/repost/quote counts, mentions, links, quoted
  and reposted posts, media URLs and reply linkage, merged from three sources:
  server-embedded Relay payloads, `/api/graphql` responses recorded over the
  DevTools protocol, and the rendered DOM.
- **Evidence report** (`YYYYMMDDTHHmmssZ-thread-report.html`) — self-contained,
  script-free rendering of the thread with capture metadata and file hashes.
- **Raw API evidence** (`raw/`) — GraphQL response bodies, embedded JSON payloads and
  per-post `outerHTML` (needed because Threads removes off-screen posts from the DOM).
  Request tokens (`fb_dtsg`, `lsd`, `jazoest`) are deliberately not recorded.
- **Media download** (`media/`) — post images and videos fetched from the CDN URLs in
  the API data, hashed like every other file.
- **Completeness reporting** — captured replies are compared against the reply count
  Threads reports, and hidden/restricted/nested-but-not-shown replies are listed in
  the report, the manifest and the popup.
- **Options** (persisted): load all replies, load the post fresh, download media.
- **Fresh load in a separate tab** — the post is opened from its own link in a new tab with
  the network recorder attached, captured there, and the tab is closed. The user's tab is
  never navigated: signed-in Threads can refuse a direct load (redirect to the feed or
  `/?error=invalid_post`), and navigating the user's tab would destroy the in-app view with
  no way back. On refusal the post is captured as displayed and a completeness note says so.
- **Login prompts / modal dialogs** are dismissed before every reply-loading round and
  screenshot frame (they scroll-lock the page) and hidden if they reappear; the count is in
  the manifest.
- **One download per capture** — the capture folder is saved as a single
  `forensic-capture-<timestamp>.zip` instead of one download per file, so Chrome's "ask where
  to save" prompt appears once. File bytes inside are unchanged (text deflated, media stored),
  so `hashes.txt` verifies after unzipping; the ZIP's own SHA-256 is shown in the popup and
  stored in the capture history.
- **Hidden feed posts excluded** — signed-in Threads keeps the feed mounted but hidden behind a
  post opened in-app; posts from that hidden layer were harvested as replies. Only displayed
  posts are harvested now.
- **Account safety (low automation footprint)** — captures should not look like a bot to
  Threads:
  - Storage is read from the extension's isolated world. The old page-context script
    (`src/injected/injected.js`) is removed: it inserted a `chrome-extension://` script tag,
    broadcast the storage dump with `window.postMessage` and logged to the page console, and
    `web_accessible_resources` let any site probe for the extension.
  - Scrolling, "show more replies" clicks and Escape presses are genuine browser input
    (DevTools protocol Input domain) instead of `scrollTo()` jumps and scripted `.click()`
    (`isTrusted === false`). Before each click the pointer is moved to the button and the
    element under it is hit-tested; anything other than the expander is never pressed,
    since a genuine click acts as the signed-in account.
  - Threads screenshots crop the sticky header band instead of restyling page elements.
  - `CdpSession` refuses `Runtime/Debugger/Console/Log/Profiler.enable`, whose effects page
    code can detect.
  - New **Careful pacing** option (default on): randomised pauses, partial scrolls, reply
    fetches capped at 10 per minute.
  - Escape is pressed at most once per dialog (max 6 per capture); reply loading stops if wheel
    scrolling no longer moves the page. Signed-out captures (no `sessionid` cookie, no account
    at risk) may fall back to programmatic scrolling and hide login prompts; the manifest
    records the policy under `threadsCapture.automationFootprint`.
  - Verified with an in-page detector (untrusted events, style mutations, injected scripts,
    `postMessage`, console hooks, the `Runtime.enable` stack-getter check) on a real Threads
    capture: the previous build tripped six signals (synthetic click, scroll without wheel,
    4 style mutations, injected script exposing the extension id, 2 broadcast messages,
    4 console lines). Signed-in policy: none. Signed-out policy: only the documented login-
    prompt hiding.

### 🐛 Bug Fixes

- **Signed-in captures did not scroll.** Signed in, Threads keeps the feed mounted (hidden)
  while an opened post scrolls in its own layer. The tall hidden feed made the toolkit measure
  the document, which never moves, so after 3 wheel steps reply loading stopped with
  `page-not-scrolling` and the screenshot was truncated. The scroll container is now the
  nearest scrollable ancestor of the visible posts. Each wheel event goes to a hit-tested point
  where the wheel actually scrolls that container, with a real PageDown key press as a second
  genuine-input attempt. `threadsCapture.replyLoading.scrolling` in the manifest records the
  detected container and which inputs moved the page.
- **Signed-in captures crawled (careful pacing).** The 10-per-minute reply-fetch cap counted
  every GraphQL request. Signed-in Threads polls about 12 times a minute on its own (like
  counts, notification badge, screen time); in one real capture only 2 of 75 requests were
  reply fetches. The capture therefore waited before almost every step (39 waits, 8 rounds in
  5.3 minutes). Only content fetches (`…Replies…`, `…Pagination…`, `…PostPage…`; unnamed
  operations too, to stay cautious) now count toward the cap and the network-idle wait. The
  manifest reports the rest as `automationFootprint.backgroundGraphqlRequestsNotRateLimited`.
- **Screenshots were wrong on HiDPI/Retina displays.** The stitcher mixed CSS pixels
  with the device pixels that `captureVisibleTab` returns, so only the top-left
  quarter of each frame was drawn at 2× scale. Scale is now derived from the captured
  image itself, and output is native resolution.
- **Screenshots duplicated content at the bottom of pages.** Frames were placed at the
  requested scroll offset; the browser clamps the last scroll, so the final frame
  overlapped. Frames are now placed at the offset read back from the page.
- **Fixed/sticky headers and nav rails repeated in every stitched frame.** They are
  now hidden after the first frame and restored afterwards.
- **Pages that scroll an inner element (app shells, modal scroll-lock) captured only
  the first viewport.** The real scroll container is detected and scrolled.
- **Infinite-scroll pages never finished capturing.** The captured height is now fixed
  before the first frame.
- **hashes.txt did not verify the manifest.** The manifest hash was computed and then
  written into the manifest itself, changing the file after hashing. Every file is now
  built once as bytes, hashed from those bytes and downloaded from those bytes, and
  `hashes.txt` is plain `sha256sum` format with no comment lines.
- **Failed downloads were reported as a successful capture.** Download failures now
  fail the capture and are recorded in the chain of custody.
- **`content.js` threw on every page load.** It was registered as a content script but
  used ES module `import`, which content scripts cannot do; every page paid a script
  error and the extension silently fell back to programmatic injection. The dead
  declarative registration, `content.js` and `dom-capture.js` were removed.
- **Screenshot capture could hang forever** when the browser window was minimised or
  covered (the OS stops compositing, so no screenshot can be produced). Capture now
  times out with an actionable message.
- **Popup rendered capture URLs with `innerHTML`.** History and results are built as
  DOM nodes.

### 🔧 Technical

- New `debugger` permission (Chromium only). Used to record Threads API responses and
  to capture screenshots without the `captureVisibleTab` rate limit. Chrome shows a
  "being debugged" bar while a Threads capture runs; captures fall back to
  `captureVisibleTab` and DOM-only extraction when the protocol is unavailable.
- Screenshots are split into `-partNN.png` segments when a page exceeds canvas limits.
- New modules: `src/content/page-tools.js` (page-side toolkit), `src/background/cdp-session.js`,
  `src/background/threads-capture.js`, `src/threads/threads-parser.js`,
  `src/threads/threads-report.js`, `src/utils/encoding-utils.js`.

---

## [1.1.2] - 2026-01-09

### 🐛 Critical Bug Fix

#### Screenshot Capture Issue
- **Fixed: Screenshots cutting off top of pages**
- File: `src/background/screenshot-capture.js`
- **Root Cause:** Capture started from current scroll position instead of page top
- **Solution:** Explicitly scroll to (0, 0) before starting capture loop
- **Additional Improvement:** Restore original scroll position after capture completes

### 🎯 Changes Made

**Before:**
- Started capturing from wherever page was scrolled
- First capture could miss top content
- Scrolled back to top (0, 0) after capture

**After:**
- Scroll to absolute top (0, 0) BEFORE first capture
- Wait 500ms for scroll to settle
- Skip delay on first capture (already at top)
- Restore original scroll position after capture
- User's scroll position preserved

### ⚡ Impact
- Full-page screenshots now correctly include top of page
- Better UX: User's scroll position is preserved
- No performance impact (same number of delays)

---

## [1.1.1] - 2026-01-08

### 🔒 Security Improvements

#### Content Security Policy
- **Added strict CSP to manifest.json**
- Prevents XSS attacks on extension pages
- Policy: `script-src 'self'; object-src 'self'`
- Follows Manifest V3 security best practices

### 🐛 Bug Fixes

#### Download Timeout
- **Increased timeout from 30s to 60s**
- File: `src/background/download-manager.js`
- Prevents download failures for large files on slow connections
- Improves reliability for screenshots >2MB

#### Message Listener Memory Leak
- **Fixed duplicate message listeners in popup**
- File: `src/popup/popup.js`
- Added listener cleanup on capture completion/error
- Prevents listener accumulation on repeated captures
- Improves popup performance

### 🧹 Code Quality

#### UI Cleanup
- **Removed non-functional settings link**
- Settings page not yet implemented (planned for v1.2.0)
- Updated popup footer to show v1.1.1
- Added comment for future reference

### 📝 Version Updates
- `manifest.json`: v1.1.0 → v1.1.1
- `popup.html`: v1.0.0 → v1.1.1
- Documentation updated

### ⚡ Impact
- No user-facing feature changes
- All v1.1.0 features work identically
- Improved security and reliability
- Better memory management

---

## [1.1.0] - 2026-01-08

### 🎉 New Features

#### Folder Organization
- **All captured files now download into organized folders**
- Folder naming: `forensic-capture-{TIMESTAMP}/`
- All 6 evidence files contained in single timestamped folder
- Keeps Downloads folder clean and organized
- Easy to manage multiple captures

#### Full-Page Screenshot Capture
- **Complete page capture using scroll-and-stitch algorithm**
- Captures entire scrollable page (not just viewport)
- Handles pages of any height (5000px, 10000px+)
- High-quality PNG stitching with no visible seams
- Automatic fallback to viewport capture if scroll fails
- Progress tracking during multi-section capture

### 🔧 Technical Improvements

#### New Files
- `src/background/screenshot-capture.js` - Full-page screenshot module
  - Scroll-and-stitch implementation
  - Canvas-based image stitching
  - Viewport fallback logic

#### Modified Files
- `src/background/capture-manager.js`
  - Added folder organization support
  - Integrated full-page screenshot capture
  - Enhanced error handling with fallback
  - Improved logging for folder operations

- `src/background/download-manager.js`
  - Added `folderName` parameter for file downloads
  - Automatic folder creation in Downloads directory
  - Updated path handling for nested downloads

- `manifest.json` - Version bumped to 1.1.0
- `package.json` - Version bumped to 1.1.0

### 📚 Documentation
- Added `IMPROVEMENTS.md` - Feature documentation
- Added `CHANGELOG.md` - This file

### ⚡ Performance Notes
- Capture time increased for long pages: 5-20 seconds (was 2-5 sec)
- Screenshot file size increased: 500KB-3MB (was 100KB-500KB)
- Worth the tradeoff for complete forensic evidence

### 🐛 Bug Fixes
- None (new feature release)

---

## [1.0.0] - 2026-01-08

### 🎉 Initial Release

#### Core Features
- Cross-browser support (Chrome, Firefox, Safari)
- Viewport screenshot capture (PNG, 100% quality)
- Complete DOM structure capture with metadata
- Browser storage capture (localStorage, sessionStorage, IndexedDB)
- HTTP cookies capture with all attributes
- SHA-256 hashing for all files
- ISO 8601 timestamps (UTC)
- Chain of custody logging
- Audit trail tracking
- Forensic manifest generation

#### Architecture
- Manifest V3 service worker
- Content script with automatic injection
- Page-context storage access
- Cross-browser polyfill support
- Professional purple-themed UI

#### Files Captured (per capture)
1. `{timestamp}-manifest.json` - Forensic metadata
2. `{timestamp}-screenshot.png` - Page screenshot
3. `{timestamp}-dom.json` - HTML structure
4. `{timestamp}-storage.json` - Browser storage
5. `{timestamp}-cookies.json` - HTTP cookies
6. `{timestamp}-hashes.txt` - SHA-256 hashes

#### Documentation
- Comprehensive README.md
- NEXT_STEPS.md roadmap
- BUILD_COMPLETE.md status
- FIXED.md troubleshooting

### 🐛 Bug Fixes (Post-Launch)

#### v1.0.1 (Same Day)
- **Fixed:** "browser is not defined" error
  - Added webextension-polyfill imports to background modules
  - Files: background.js, capture-manager.js, forensic-metadata.js, download-manager.js

- **Fixed:** "Could not establish connection" error
  - Implemented automatic content script injection
  - Created content-injector.js for programmatic injection
  - Added PING message handler
  - Works on both new and existing tabs

---

## Version Comparison

| Feature | v1.0.0 | v1.1.0 |
|---------|--------|--------|
| Screenshot Type | Viewport only | Full-page scroll |
| File Organization | Downloads root | Timestamped folders |
| Capture Time | 2-5 sec | 5-20 sec (long pages) |
| Screenshot Size | 100-500 KB | 500KB-3MB |
| Page Height Limit | Viewport (~1000px) | Unlimited |
| Fallback Support | No | Yes (viewport fallback) |

---

## Upgrade Guide

### From v1.0.0 to v1.1.0

**No breaking changes!** Simply reload the extension:

1. **Chrome:** `chrome://extensions/` → Click reload (🔄)
2. **Firefox:** `about:debugging` → Click "Reload"

**What to expect:**
- Files now download into folders (not Downloads root)
- Screenshots take longer but capture full page
- Larger screenshot files (better evidence quality)
- Same file structure within folders

**Compatibility:**
- All v1.0.0 features still work
- Hash verification unchanged
- Manifest format unchanged
- No data migration needed

---

## Roadmap

### v1.2.0 (Planned)
- Settings page for user preferences
- Toggle between full-page and viewport capture
- Custom folder name prefix
- Capture progress bar in popup UI
- Configurable scroll delay

### v1.3.0 (Planned)
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

---

## Known Issues

### v1.1.0
- **Very long pages** (>20,000px): May take 30+ seconds to capture
  - Expected behavior - wait patiently

- **Sticky headers/footers**: May appear in multiple screenshot sections
  - Expected behavior - shows actual page state during scroll

- **Lazy-loaded images**: May not load during rapid scrolling
  - Workaround: Scroll page manually before capturing

- **Animated content**: May look different in each section
  - Expected behavior - captures state at each position

### v1.0.0
- All issues resolved in v1.0.1 patch

---

## Credits

**Developer:** AI-Assisted Development
**License:** MIT License
**Platform:** WebExtensions API (Manifest V3)

---

## Support

**Documentation:** See README.md and IMPROVEMENTS.md
**Issues:** Check FIXED.md for troubleshooting
**Roadmap:** See NEXT_STEPS.md

---

**Current Version:** 1.2.1
**Last Updated:** 2026-09-23
