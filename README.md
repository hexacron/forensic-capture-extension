# Forensic Data Capture Extension

A cross-browser extension for forensic data capture from web browsers. Captures screenshots, DOM structure, cookies, and browser storage with cryptographic integrity verification and chain of custody tracking.

## Features

- **Cross-Browser Compatible**: Works on Chrome, Firefox, and Safari using standard WebExtensions API
- **Comprehensive Data Capture**:
  - Full-page screenshots (scroll-and-stitch, native resolution, PNG)
  - Complete DOM structure with metadata
  - HTTP cookies with all attributes
  - Browser storage (localStorage, sessionStorage, IndexedDB)
- **Threads post capture** (threads.com / threads.net):
  - Loads the whole reply thread, including replies behind "show more replies"
  - Structured thread data: text, authors, user ids, UTC timestamps, like/reply/repost/quote counts, mentions, links, quoted posts, media
  - Raw Threads API responses and per-post HTML kept as evidence
  - Post images and videos downloaded alongside the evidence
  - Self-contained HTML report of the thread
  - Reports how many replies Threads claims versus how many were captured
- **Forensic Integrity**:
  - SHA-256 hashing for all captured files
  - ISO 8601 timestamps (UTC)
  - Chain of custody logging
  - Audit trail tracking
  - Forensic manifest generation
- **Standards Compliant**: Follows forensic best practices for evidence collection

## Installation

### Development Installation

1. **Clone or download this repository**

2. **Generate extension icons** (optional, but recommended):
   ```bash
   # Install Python Pillow library
   pip3 install Pillow

   # Generate icons
   python3 generate_icons.py
   ```

3. **Load the extension in your browser**:

   **Chrome/Edge:**
   - Navigate to `chrome://extensions/`
   - Enable "Developer mode" (toggle in top right)
   - Click "Load unpacked"
   - Select the `forensic-capture-extension` directory

   **Firefox:**
   - Navigate to `about:debugging#/runtime/this-firefox`
   - Click "Load Temporary Add-on"
   - Select any file in the `forensic-capture-extension` directory

   **Safari:**
   - Safari requires converting to Safari App Extension
   - See [Apple Developer Documentation](https://developer.apple.com/documentation/safariservices/safari_web_extensions/converting_a_web_extension_for_safari)

## Usage

### Basic Capture

1. Navigate to the web page you want to capture
2. Click the extension icon in your browser toolbar
3. Click the "Capture Evidence" button
4. Keep the tab active and the browser window visible while the capture runs
5. Files are downloaded into a timestamped folder in your downloads directory

### Capturing a Threads post with all replies

1. Open the post's own page: `https://www.threads.com/@user/post/CODE`
   (a profile or feed page is not enough - the popup asks for a post page)
2. Click the extension icon. The popup shows **Threads post detected** with four options:
   - **Load all replies** - scroll and expand the thread until no new replies appear
   - **Load the post fresh** - open the post's own link in a new tab so its API responses are
     recorded as evidence; the new tab is closed afterwards and your tab is left as it was.
     If Threads refuses to open the post from its link (it redirects to the feed, e.g.
     `?error=invalid_post`), the post is captured as displayed in your tab instead and the
     report says so
   - **Download media** - save post images and videos next to the evidence files
   - **Careful pacing** (on by default) - scroll and pause like a person reading and cap how
     often replies are fetched; see *Protecting the capturing account* below
3. Click **Capture Post + Replies** and leave the window in the foreground.
   Chrome displays a "being debugged" bar for the duration; that is the extension
   recording API traffic and taking screenshots.
4. Log in to Threads first if the thread is only fully visible to signed-in accounts -
   the capture records exactly what that account can see.

With careful pacing a long thread takes several minutes (roughly 2-4 s per scroll step and
at most 10 reply-page fetches per minute); the screenshot is taken one viewport at a time.

### Protecting the capturing account

Capturing from an account you want to keep (e.g. an investigation account) should not look
like automation to Threads. What the extension does so that site scripts see an ordinary
visitor:

- **Nothing runs in the page.** All page reading happens in the extension's isolated world;
  no scripts are inserted, nothing is posted on `window`, nothing is logged to the page
  console, and no extension file is exposed to websites (so sites cannot probe for it).
- **The page is not modified.** Threads screenshots crop the sticky header out of later
  frames instead of restyling it.
- **Only genuine input events.** Scrolling uses mouse-wheel events, "show more replies" is
  pressed with a real mouse click (after moving the pointer there), dialogs are closed with a
  real Escape key press. Without the DevTools protocol (Firefox/Safari) nothing is clicked.
- **Clicks are verified before they happen.** A genuine click acts as your account, so the
  pointer is moved first and the button is only pressed if the element under the pointer is
  that "show more replies" control (not a post, link, like or follow button); otherwise the
  click is skipped and logged.
- **No detectable DevTools domains.** The DevTools connection never enables the `Runtime`,
  `Debugger`, `Console`, `Log` or `Profiler` domains, whose effects page code can observe;
  the code refuses those commands.
- **It backs off instead of insisting.** Escape is pressed at most once per dialog (never
  again if it did not work, at most 6 per capture), and if wheel scrolling stops moving the
  page (e.g. a blocking prompt), reply loading stops with a note in the report rather than
  repeating input at an unresponsive page.
- **Signed-out captures** (no Threads `sessionid` cookie, so no account at risk) are allowed
  robust fallbacks: programmatic scrolling when a login prompt locks the page, and hiding that
  prompt during screenshots. The manifest records which policy applied (`automationFootprint`).
- **Human pacing** (Careful pacing option): randomised reading pauses, partial-viewport
  scrolls, occasional longer stops, and a cap on reply-page fetches per minute.

What it cannot hide: the account still loads every reply you capture (volume), requests still
come from your IP, Chrome shows its "being debugged" bar to *you* (not to the site), and
"Load the post fresh" opens the post link once more in a new tab. No tool can guarantee that
a platform will not flag an account; very large threads mean many requests however they are
paced.

### Captured Files

Every capture is saved as **one file**, `forensic-capture-YYYYMMDDTHHmmssZ.zip` (a single
download, so at most one save prompt). The popup shows the ZIP's SHA-256 and it is kept in the
capture history; record it in your notes, as an archive cannot contain its own hash.

Unzipping gives the folder `forensic-capture-YYYYMMDDTHHmmssZ/` containing:

- `YYYYMMDDTHHmmssZ-manifest.json` - Forensic manifest with metadata and file hashes
- `YYYYMMDDTHHmmssZ-screenshot.png` - Full-page screenshot (`-partNN.png` for very long pages)
- `YYYYMMDDTHHmmssZ-dom.json` - DOM structure at the end of capture
- `YYYYMMDDTHHmmssZ-storage.json` - Browser storage data
- `YYYYMMDDTHHmmssZ-cookies.json` - HTTP cookies
- `YYYYMMDDTHHmmssZ-hashes.txt` - SHA-256 hashes (sha256sum format)

Threads captures additionally contain:

- `YYYYMMDDTHHmmssZ-thread.json` - Normalized post + replies (API data merged with what was rendered)
- `YYYYMMDDTHHmmssZ-thread-report.html` - Readable report of the thread; open it in a browser
- `raw/YYYYMMDDTHHmmssZ-threads-api-responses.json` - Raw `/api/graphql` response bodies
- `raw/YYYYMMDDTHHmmssZ-threads-embedded-data.json` - Raw server-embedded JSON payloads
- `raw/YYYYMMDDTHHmmssZ-threads-dom-posts.json` - Per-post `outerHTML` and rendered text
- `media/CODE-NN.jpg|mp4` - Downloaded post media

### Verifying Integrity

Unzip the package, then from inside the extracted capture folder:

```bash
# macOS
shasum -a 256 -c *-hashes.txt

# Linux
sha256sum -c *-hashes.txt

# Windows (PowerShell, single file)
Get-FileHash -Algorithm SHA256 *-manifest.json
```

`hashes.txt` covers every file in the folder, including the manifest and the report.

## Project Structure

```
forensic-capture-extension/
├── manifest.json                    # Extension manifest (Manifest V3)
├── package.json                     # Dependencies
├── generate_icons.py                # Icon generator script
│
├── lib/
│   └── browser-polyfill.min.js     # Cross-browser API compatibility
│
├── src/
│   ├── background/                 # Background service worker
│   │   ├── background.js           # Main service worker
│   │   ├── capture-manager.js      # Capture orchestration, evidence files, hashing
│   │   ├── screenshot-capture.js   # Scroll-and-stitch full-page screenshots
│   │   ├── threads-capture.js      # Threads session: reply loading, API recording, media
│   │   ├── cdp-session.js          # chrome.debugger (DevTools protocol) wrapper
│   │   ├── page-tools-client.js    # Injects and calls the page-side toolkit
│   │   ├── forensic-metadata.js    # Manifest generation
│   │   └── download-manager.js     # File downloads
│   │
│   ├── content/                    # Extension isolated-world scripts (never page context)
│   │   ├── content-injector.js     # DOM + storage capture (message handler)
│   │   └── page-tools.js           # Scrolling, harvesting, overlay handling
│   │
│   ├── threads/                    # Pure Threads logic (no browser APIs)
│   │   ├── threads-parser.js       # URL parsing, API extraction, thread dataset
│   │   └── threads-report.js       # HTML evidence report
│   │
│   ├── popup/                      # User interface
│   │   ├── popup.html              # Popup UI
│   │   ├── popup.js                # Popup logic
│   │   └── popup.css               # Popup styling
│   │
│   └── utils/                      # Utility modules
│       ├── crypto-utils.js         # SHA-256 hashing
│       ├── encoding-utils.js       # base64 <-> bytes
│       ├── zip-writer.js           # Packages each capture as one ZIP
│       ├── timestamp-utils.js      # ISO 8601 timestamps
│       ├── logger.js               # Forensic logging
│       └── validation.js           # Data validation
│
├── icons/                          # Extension icons (16, 48, 128 px)
└── docs/                           # Documentation
```

## Forensic Manifest Structure

Each capture includes a forensic manifest with:

```json
{
  "forensicMetadata": {
    "captureId": "uuid-v4",
    "timestamp": "2025-12-18T14:30:45.123Z",
    "browser": { "name": "Chrome", "version": "120.0" },
    "investigator": "Optional investigator name",
    "caseNumber": "Optional case number"
  },
  "targetPage": {
    "url": "https://example.com",
    "title": "Page Title",
    "captureTimestamp": "2025-12-18T14:30:45.123Z"
  },
  "capturedFiles": [
    {
      "filename": "20251218T143045Z-screenshot.png",
      "type": "screenshot",
      "size": 1234567,
      "sha256": "abc123...",
      "captureMethod": "browser.tabs.captureVisibleTab"
    }
  ],
  "chainOfCustody": [
    {
      "action": "capture-initiated",
      "timestamp": "2025-12-18T14:30:45.000Z",
      "actor": "extension-user"
    }
  ],
  "auditTrail": {
    "captureAttempts": 1,
    "captureErrors": [],
    "retries": 0,
    "completionStatus": "success"
  }
}
```

## Technical Details

### Cross-Browser Compatibility

- **Manifest V3**: Latest extension standard
- **WebExtensions API**: Standard APIs supported by all browsers
- **webextension-polyfill**: Provides Promise-based API consistency

### Capture Methodology

1. **Screenshot**: scroll-and-stitch. The page's real scroll container is scrolled one
   viewport at a time; frames are placed at the scroll offset read back from the page and
   composited at the device pixel ratio, so output is native resolution with no duplicated
   or missing strips. Fixed/sticky overlays are visible in the first frame only. Very long
   pages are split into `-partNN.png` segments to stay inside canvas limits.
   Frames come from `chrome.debugger` (`Page.captureScreenshot`) for Threads captures and
   from `browser.tabs.captureVisibleTab()` otherwise.
2. **DOM**: `document.documentElement.outerHTML` via content script
3. **Cookies**: `browser.cookies.getAll()` with full attributes
4. **Storage**: Page-context injection for localStorage/sessionStorage/IndexedDB
5. **Threads data**: server-embedded Relay payloads + `/api/graphql` response bodies
   recorded over the DevTools protocol + per-post DOM harvested while scrolling, merged
   by post shortcode
6. **Hashing**: `crypto.subtle.digest("SHA-256")` over the exact bytes that are written to disk

### Privacy & Permissions

The extension requires the following permissions:

- `activeTab`: Access current tab for capture
- `tabs`: Capture screenshots and manage tabs
- `downloads`: Save captured files
- `storage`: Store capture history and Threads options
- `cookies`: Capture HTTP cookies
- `scripting`: Inject content scripts
- `debugger`: Record Threads API responses and capture screenshots without the
  `captureVisibleTab` rate limit (Chromium only; Chrome shows a "being debugged" bar while
  it is in use). Captures still work without it, with DOM-only Threads extraction.
- `<all_urls>`: Access any website for forensic capture

**Important**: This extension does NOT:
- Send data over the network, except fetching post media from Threads' CDN when
  "Download media" is enabled
- Store data in the cloud
- Share data with third parties
- All processing happens locally

**Note**: `cookies.json` contains the capturing browser's cookies for the captured site,
including its session cookie. Treat capture folders as sensitive.

## Limitations

### Known Constraints

1. **Dynamic Content**: Captures represent a single point in time
2. **Browser Restrictions**: Cannot capture browser internal pages (chrome://, about://)
3. **Private Browsing**: Some storage may be inaccessible in private/incognito mode
4. **CSP**: Content Security Policy may block script injection on some sites
5. **Storage Access**: Safari may require user permission for storage access
6. **Window must stay visible**: operating systems stop compositing minimised or fully
   covered windows, and no screenshot can be taken then; the capture aborts with an error
7. **Threads replies depend on the account**: hidden, restricted, deleted and
   account-filtered replies cannot be captured. The report and manifest state how many
   replies Threads claims versus how many were captured
8. **Nested replies**: replies to replies live on their own permalink; the report lists
   which posts have replies that this page does not show
9. **Threads virtualises its list**: `dom.json` only holds the posts rendered at the end of
   capture; `raw/…-threads-dom-posts.json` holds every post's HTML as it was observed

### Browser-Specific Notes

**Chrome/Edge:**
- Full support for all features
- Manifest V3 required (enforced since 2024)
- Only Chromium exposes `chrome.debugger`, so Threads API-response recording and
  rate-limit-free screenshots are Chromium-only

**Firefox:**
- Screenshots, DOM, cookies and storage are fully supported
- Threads captures fall back to embedded page data plus the rendered DOM (no API-response
  recording); screenshots use `captureVisibleTab` and are therefore slower
- IndexedDB blocked if cookies disabled

**Safari:**
- May prompt for storage access permissions
- Requires Safari 16.4+ for Manifest V3 support
- Same Threads fallback as Firefox

## Development

### Requirements

- Modern web browser (Chrome 120+, Firefox 109+, Safari 16.4+)
- Python 3 (for icon generation, optional)
- Pillow library (for icon generation, optional)

### Building from Source

1. Clone the repository
2. No build process required - extension is ready to load
3. For production, consider minification and packaging

### Testing

Automated checks (require [Bun](https://bun.sh); no other dependencies):

```bash
bun run lint                           # undeclared identifiers (ESLint no-undef)
bun tests/stitcher-geometry.test.mjs   # screenshot stitching geometry (HiDPI, clamping, segments)
bun tests/threads-parser.test.mjs      # Threads API extraction, reply linkage, completeness
bun tests/evidence-pipeline.test.mjs   # hashes.txt verified with shasum -c, report escaping

npm test                               # all of the above
```

Manual checks that need a real browser:

```
- A Threads post you can see while signed in (replies load, media downloads)
- A long page (screenshot splits into -partNN.png, no gaps or repeated headers)
- A page whose inner element scrolls (app shell layouts)
- shasum -a 256 -c *-hashes.txt inside the capture folder
```

### Debugging

Enable debug logging:
```javascript
// Check browser console for:
[Background] - Service worker logs
[Content] - Content script logs
[Injected] - Page-context script logs
[CaptureManager] - Capture process logs
[DownloadManager] - Download logs
```

## Troubleshooting

### Capture Button Doesn't Work

- Check browser console for errors
- Ensure page is not a browser internal page (chrome://, about://)
- Verify extension permissions are granted
- Try reloading the extension

### Files Not Downloading

- Check browser's download settings
- Ensure downloads folder is accessible
- Check for download permission prompts
- Verify sufficient disk space

### Storage Capture Fails

- Check if page allows storage access
- Disable strict privacy/tracking protection temporarily
- For Firefox: Enable cookies
- For Safari: Grant storage access permission

### Hash Verification Fails

- Ensure no files were modified after download
- Use correct hash file for verification
- Check file encoding (should be UTF-8 for JSON files)

## Contributing

This is a research project. Contributions, suggestions, and feedback are welcome.

### Future Enhancements

- [ ] Full-page screenshot (scroll-and-stitch)
- [ ] Network traffic capture (HAR export)
- [ ] Configurable capture options
- [ ] Batch capture multiple tabs
- [ ] ZIP packaging of evidence files
- [ ] Settings page for investigator info
- [ ] Export to specific forensic formats

## License

MIT License - See LICENSE file for details

## Disclaimer

This tool is designed for authorized forensic investigation, security research, and educational purposes. Users are responsible for ensuring their use complies with applicable laws and regulations. The authors assume no liability for misuse of this tool.

## Version History

### v1.0.0 (Current)
- Initial release
- Cross-browser support (Chrome, Firefox, Safari)
- Full data capture (screenshot, DOM, cookies, storage)
- SHA-256 integrity verification
- Chain of custody logging
- Forensic manifest generation

## Support

For issues, questions, or feature requests:
- Check the troubleshooting section above
- Review browser console logs
- Check extension permissions
- Ensure browser is up to date

## Acknowledgments

- Built using WebExtensions API standard
- Uses Mozilla's webextension-polyfill for cross-browser compatibility
- Follows NIST and ISO forensic guidelines
- Inspired by forensic best practices and digital evidence collection standards
