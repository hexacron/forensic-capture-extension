/**
 * Human-readable, self-contained HTML report for a captured social post and its
 * replies. Pure function; no scripts and no remote resources (viewing the report
 * never contacts the platform). Local media is referenced by relative path.
 */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatCount(value) {
  return value === null || value === undefined ? '—' : String(value);
}

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function renderMedia(post) {
  const local = new Map((post.localMedia || []).map(m => [m.index, m]));
  const items = (post.media || []).map((media, index) => {
    const file = local.get(index);
    if (file && media.kind === 'image') {
      return `<a href="${escapeHtml(file.path)}"><img src="${escapeHtml(file.path)}" alt="${escapeHtml(media.accessibilityCaption || '')}"></a>`;
    }
    if (file && media.kind === 'video') {
      return `<video controls preload="metadata" src="${escapeHtml(file.path)}"></video>`;
    }
    const reason = post.mediaErrors && post.mediaErrors[index] ? ` (${escapeHtml(post.mediaErrors[index])})` : '';
    return `<div class="media-missing">${escapeHtml(media.kind)} not downloaded${reason}</div>`;
  });
  return items.length ? `<div class="media">${items.join('')}</div>` : '';
}

function renderPost(post, rootCode, platform) {
  const author = post.author || {};
  const indent = post.role === 'reply' && post.parentCode && post.parentCode !== rootCode ? ' nested' : '';
  const replyTo = post.replyToUsername ? `<div class="reply-to">Replying to @${escapeHtml(post.replyToUsername)}</div>` : '';
  const text = post.text !== null && post.text !== undefined
    ? `<div class="text">${escapeHtml(post.text)}</div>`
    : `<div class="text rendered"><span class="label">Rendered text (no API data):</span>\n${escapeHtml(post.rendered ? post.rendered.text : '')}</div>`;
  const countParts = post.counts
    ? platform.report.countLabels(post)
      .filter(([key]) => post.counts[key] !== null && post.counts[key] !== undefined)
      .map(([key, label]) => `${escapeHtml(label)} ${formatCount(post.counts[key])}`)
    : [];
  const counts = countParts.length ? `<div class="counts">${countParts.join(' · ')}</div>` : '';
  const quoted = post.quotedPost
    ? `<div class="quoted">Quoted <a href="${escapeHtml(post.quotedPost.url)}">@${escapeHtml(post.quotedPost.author)}</a>: ${escapeHtml(post.quotedPost.text || '')}</div>`
    : '';
  const links = (post.links || []).length
    ? `<div class="links">Links: ${post.links.map(l => escapeHtml(l.url)).join(', ')}</div>`
    : '';
  const flags = [
    post.captionEdited ? 'edited' : null,
    post.unavailable ? 'unavailable' : null
  ].filter(Boolean).map(f => `<span class="flag">${f}</span>`).join('');

  return `
  <article class="post ${escapeHtml(post.role)}${indent}" id="post-${escapeHtml(post.code)}">
    <header>
      <span class="name">${escapeHtml(author.fullName || '')}</span>
      <span class="handle">@${escapeHtml(author.username)}</span>${author.isVerified ? '<span class="verified" title="Verified">✔</span>' : ''}
      <span class="role">${escapeHtml(post.role)}</span>${flags}
    </header>
    <div class="meta">
      <span>Posted: ${escapeHtml(post.createdAt || 'unknown')}</span>
      <span>Code: <a href="${escapeHtml(post.url)}">${escapeHtml(post.code)}</a></span>
      ${author.userId ? `<span>User ID: ${escapeHtml(author.userId)}</span>` : ''}
      ${post.parentCode ? `<span>Parent: <a href="#post-${escapeHtml(post.parentCode)}">${escapeHtml(post.parentCode)}</a></span>` : ''}
    </div>
    ${replyTo}
    ${text}
    ${renderMedia(post)}
    ${quoted}
    ${links}
    ${counts}
    <div class="sources">Sources: ${escapeHtml(post.sources.join(', '))}</div>
  </article>`;
}

/**
 * @param {Object} input
 * @param {Object} input.dataset - buildThreadDataset() result (with localMedia filled)
 * @param {Object} input.platform - Platform adapter the dataset was built with
 * @param {Object} input.capture - { captureId, timestamp, url, finalUrl, extensionVersion, investigator, caseNumber, method }
 * @param {Array} input.files - Evidence files already hashed: [{ path, sha256, size }]
 * @param {Array<string>} input.screenshots - Screenshot file paths
 */
export function renderThreadReport({ dataset, platform, capture, files, screenshots }) {
  const { label, words } = platform;
  const stats = dataset.statistics;
  const root = dataset.root;
  const title = root
    ? `${label} post by @${root.author.username} (${root.code})`
    : `${label} post ${dataset.rootCode}`;
  const scopeWord = stats.rootReportedRepliesScope === 'direct' ? 'direct ' : '';

  const warnings = dataset.warnings.length
    ? `<section class="warnings"><h2>Completeness notes</h2><ul>${dataset.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul></section>`
    : '';

  const uncaptured = dataset.repliesWithUncapturedChildren.length
    ? `<section><h2>${capitalize(words.replies)} with nested ${words.replies} not shown</h2><table><tr><th>Post</th><th>Reported</th><th>Captured</th></tr>${
      dataset.repliesWithUncapturedChildren.map(r => `<tr><td><a href="${escapeHtml(r.url)}">${escapeHtml(r.code)}</a></td><td>${r.reportedReplies}</td><td>${r.capturedReplies}</td></tr>`).join('')
    }</table></section>`
    : '';

  const hashRows = files
    .map(f => `<tr><td>${escapeHtml(f.path)}</td><td>${f.size}</td><td class="hash">${escapeHtml(f.sha256)}</td></tr>`)
    .join('');

  const screenshotLinks = screenshots
    .map(path => `<li><a href="${escapeHtml(path)}">${escapeHtml(path)}</a></li>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title>
<style>
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; background: #f4f4f5; color: #18181b; }
  main { max-width: 860px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 24px 0 8px; }
  table { border-collapse: collapse; width: 100%; background: #fff; font-size: 12px; }
  th, td { border: 1px solid #e4e4e7; padding: 4px 8px; text-align: left; vertical-align: top; }
  .hash { font-family: ui-monospace, Menlo, monospace; word-break: break-all; }
  .warnings { background: #fffbeb; border: 1px solid #fcd34d; padding: 8px 16px; border-radius: 6px; }
  .post { background: #fff; border: 1px solid #e4e4e7; border-radius: 8px; padding: 12px 16px; margin: 10px 0; }
  .post.root { border: 2px solid #18181b; }
  .post.ancestor { opacity: .85; }
  .post.nested { margin-left: 40px; }
  .post header { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .name { font-weight: 600; }
  .handle { color: #52525b; }
  .verified { color: #0095f6; }
  .role, .flag { font-size: 11px; text-transform: uppercase; background: #f4f4f5; border-radius: 4px; padding: 0 6px; color: #52525b; }
  .flag { background: #fee2e2; color: #991b1b; }
  .meta, .sources, .counts, .reply-to, .links { font-size: 12px; color: #52525b; display: flex; gap: 12px; flex-wrap: wrap; }
  .text { white-space: pre-wrap; margin: 8px 0; font-size: 15px; }
  .text.rendered { color: #52525b; font-size: 13px; }
  .label { font-weight: 600; }
  .media { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
  .media img, .media video { max-height: 320px; max-width: 100%; border-radius: 6px; border: 1px solid #e4e4e7; }
  .media-missing { font-size: 12px; color: #991b1b; }
  .quoted { border-left: 3px solid #d4d4d8; padding-left: 8px; font-size: 13px; margin: 8px 0; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(title)}</h1>
  <table>
    <tr><th>Captured URL</th><td>${escapeHtml(capture.url)}</td></tr>
    <tr><th>Final URL</th><td>${escapeHtml(capture.finalUrl || capture.url)}</td></tr>
    <tr><th>Capture time (UTC)</th><td>${escapeHtml(capture.timestamp)}</td></tr>
    <tr><th>Capture ID</th><td>${escapeHtml(capture.captureId)}</td></tr>
    <tr><th>Investigator</th><td>${escapeHtml(capture.investigator)}</td></tr>
    <tr><th>Case number</th><td>${escapeHtml(capture.caseNumber)}</td></tr>
    <tr><th>Tool</th><td>Exhibit v${escapeHtml(capture.extensionVersion)}</td></tr>
    <tr><th>Method</th><td>${escapeHtml(capture.method)}</td></tr>
    <tr><th>Posts captured</th><td>${stats.threadPosts} (${stats.ancestors} ancestor, 1 root, ${stats.replies} ${words.replies}); root reports ${formatCount(stats.rootReportedReplies)} ${scopeWord}${words.replies}</td></tr>
  </table>
  ${warnings}
  <h2>Screenshots</h2>
  <ul>${screenshotLinks}</ul>
  <h2>${escapeHtml(words.heading)}</h2>
  ${dataset.posts.map(post => renderPost(post, dataset.rootCode, platform)).join('\n')}
  ${uncaptured}
  <h2>Evidence file hashes (SHA-256)</h2>
  <p>This report and the manifest are hashed in the hashes file.</p>
  <table><tr><th>File</th><th>Bytes</th><th>SHA-256</th></tr>${hashRows}</table>
</main>
</body>
</html>
`;
}
