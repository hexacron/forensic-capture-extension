/**
 * Evidence-file pipeline: the real helpers from capture-manager.js build the bytes, the real
 * crypto util hashes them, and hashes.txt is then checked with the same tool an investigator
 * uses (shasum -a 256 -c). Also renders the real thread report (Threads adapter) and checks its escaping.
 *
 * Run: bun tests/evidence-pipeline.test.mjs
 */
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { $ } from 'bun';

const ROOT = new URL('../', import.meta.url).pathname;
const cmSrc = await Bun.file(ROOT + 'src/background/capture-manager.js').text();

// real helpers, verbatim
const jsonFileSrc = cmSrc.slice(cmSrc.indexOf('function jsonFile('), cmSrc.indexOf('async function hashFiles('));
const hashFilesSrc = cmSrc.slice(cmSrc.indexOf('async function hashFiles('));
const hashLineSrc = cmSrc.match(/bytes: textEncoder\.encode\((files\.map[\s\S]*?)\)\n/)[1];
console.log('hashes.txt content expression:', hashLineSrc.trim());

const { generateSHA256 } = await import(ROOT + 'src/utils/crypto-utils.js');
const { renderThreadReport } = await import(ROOT + 'src/social/report.js');
const parser = await import(ROOT + 'src/social/engine.js');
const { default: threads } = await import(ROOT + 'src/social/platforms/threads.js');
const { createZip } = await import(ROOT + 'src/utils/zip-writer.js');

const textEncoder = new TextEncoder();
const helpers = new Function('textEncoder', 'generateSHA256', `${jsonFileSrc}\n${hashFilesSrc}\nreturn { jsonFile, hashFiles };`)(textEncoder, generateSHA256);

// ---------------------------------------------------------------------------
// Build a realistic evidence set from the Threads payload fixture
// ---------------------------------------------------------------------------
const fixture = JSON.parse(await Bun.file(new URL('./fixtures/threads-post.json', import.meta.url)).text());
const api = parser.createApiStore({ rootCode: 'ROOT1' });
for (const payload of fixture.embedded) parser.collectApiPosts(payload, 'embedded', api, threads.parser);
for (const doc of parser.parseJsonDocuments(fixture.graphqlResponse)) parser.collectApiPosts(doc, 'network', api, threads.parser);
const domPosts = new Map(fixture.domPosts.map(p => [p.code, { ...p, firstObservedAt: '2026-09-22T03:00:00.000Z' }]));
const dataset = parser.buildThreadDataset({ rootCode: 'ROOT1', api, domPosts, platform: threads });
console.log('dataset:', JSON.stringify(dataset.statistics));

const ts = '20260922T030000Z';
const files = [
  { path: `${ts}-screenshot.png`, type: 'screenshot', mimeType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]) },
  helpers.jsonFile(`${ts}-dom.json`, 'dom', { html: '<html>…</html>', title: 'Thread' }),
  helpers.jsonFile(`${ts}-cookies.json`, 'cookies', [{ name: 'sessionid', value: 'x' }]),
  helpers.jsonFile(`${ts}-thread.json`, 'thread-data', { statistics: dataset.statistics, posts: dataset.posts }),
  helpers.jsonFile(`raw/${ts}-threads-api-responses.json`, 'api-responses', { responses: [] }),
  // incompressible binary (stored) and a large repetitive JSON (deflated)
  { path: `media/ROOT1-01.mp4`, type: 'media', mimeType: 'video/mp4', bytes: crypto.getRandomValues(new Uint8Array(60000)) },
  helpers.jsonFile(`raw/${ts}-threads-dom-posts.json`, 'dom-posts', Array.from({ length: 400 }, (_, i) => ({ code: `P${i}`, html: '<div data-pressable-container>'.repeat(20) })))
];
await helpers.hashFiles(files);
const evidenceFiles = [...files]; // what the report was handed, before it exists itself

// report, hashed after the files it lists (same order as capture-manager)
const html = renderThreadReport({
  dataset,
  platform: threads,
  capture: {
    captureId: 'test-capture-id', timestamp: '2026-09-22T03:00:00.000Z',
    url: 'https://www.threads.com/@rootauthor/post/ROOT1',
    finalUrl: 'https://www.threads.com/@rootauthor/post/ROOT1',
    extensionVersion: '1.2.0', investigator: 'Tester', caseNumber: 'CASE-1',
    method: 'CDP Page.captureScreenshot screenshots; reply loading enabled'
  },
  files: evidenceFiles,
  screenshots: [`${ts}-screenshot.png`]
});
const report = { path: `${ts}-thread-report.html`, type: 'thread-report', mimeType: 'text/html', bytes: textEncoder.encode(html) };
await helpers.hashFiles([report]);
files.push(report);

const manifest = helpers.jsonFile(`${ts}-manifest.json`, 'manifest', {
  forensicMetadata: { captureId: 'test-capture-id', timestamp: '2026-09-22T03:00:00.000Z' },
  capturedFiles: files.map(f => ({ filename: f.path, sha256: f.sha256, size: f.size })),
  integrityVerification: { hashAlgorithm: 'SHA-256', manifestHashLocation: `${ts}-hashes.txt` }
});
await helpers.hashFiles([manifest]);
const all = [...files, manifest];

// hashes.txt exactly as capture-manager builds it
const hashListBytes = textEncoder.encode(new Function('files', `return ${hashLineSrc}`)(all));

// ---------------------------------------------------------------------------
// Package exactly as capture-manager.savePackage does (one ZIP with the capture
// folder inside), extract it with the system unzip, and verify with shasum -c.
// ---------------------------------------------------------------------------
const folder = `forensic-capture-${ts}`;
const archive = await createZip(
  [...all, { path: `${ts}-hashes.txt`, bytes: hashListBytes }].map(f => ({ path: `${folder}/${f.path}`, bytes: f.bytes })),
  new Date('2026-09-22T03:00:00.000Z')
);
const work = '/tmp/evidence-verify';
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
writeFileSync(`${work}/${folder}.zip`, archive);
const dir = `${work}/${folder}`;

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`); };

console.log('== evidence package (zip) ==');
const integrity = await $`unzip -tq ${folder}.zip`.cwd(work).nothrow().quiet();
check('unzip -t reports no errors (CRCs, offsets, compression)', integrity.exitCode === 0, new TextDecoder().decode(integrity.stdout).trim());
const extract = await $`unzip -q ${folder}.zip`.cwd(work).nothrow().quiet();
check('archive extracts', extract.exitCode === 0, new TextDecoder().decode(extract.stderr).trim());
check('extracted into one capture folder with raw/ and media/', ['raw', 'media'].every(d => Bun.file(`${dir}/${d}`).size !== undefined) && (await $`ls ${dir}`.quiet().text()).includes(`${ts}-manifest.json`));
const sumRaw = [...all].reduce((n, f) => n + f.bytes.length, 0);
check('text evidence is compressed, binary evidence stored', archive.length < sumRaw, `${archive.length} bytes zipped vs ${sumRaw} raw`);

console.log('\n== hashes.txt ==');
const hashText = new TextDecoder().decode(hashListBytes);
check('no comment lines (shasum -c compatible)', !hashText.split('\n').some(l => l.startsWith('#')));
check('every line is "<64 hex>  <path>"', hashText.trim().split('\n').every(l => /^[0-9a-f]{64} {2}\S+$/.test(l)), JSON.stringify(hashText.split('\n')[0]));
check('covers every file including manifest and report', hashText.trim().split('\n').length === all.length, `${hashText.trim().split('\n').length} lines / ${all.length} files`);
check('manifest is listed', hashText.includes(`${ts}-manifest.json`));
check('report is listed', hashText.includes(`${ts}-thread-report.html`));

const verify = await $`shasum -a 256 -c ${ts}-hashes.txt`.cwd(dir).nothrow().quiet();
console.log(new TextDecoder().decode(verify.stdout).trim());
check('shasum -a 256 -c verifies every extracted file', verify.exitCode === 0, `exit=${verify.exitCode} ${new TextDecoder().decode(verify.stderr).trim()}`);

console.log('\n== manifest self-reference ==');
const manifestJson = JSON.parse(new TextDecoder().decode(manifest.bytes));
check('manifest does not contain its own hash', !JSON.stringify(manifestJson).includes(manifest.sha256), `manifest sha=${manifest.sha256.slice(0, 12)}…`);
check('manifest points at the hash file', manifestJson.integrityVerification.manifestHashLocation === `${ts}-hashes.txt`);
check('manifest file hashes match the files on disk', manifestJson.capturedFiles.every(entry => {
  const file = all.find(f => f.path === entry.filename);
  return file && file.sha256 === entry.sha256 && file.size === entry.size;
}));

console.log('\n== report ==');
check('report is a complete HTML document', html.startsWith('<!DOCTYPE html>') && html.trimEnd().endsWith('</html>'));
check('report contains no script tags', !/<script/i.test(html));
check('report references no remote resources', !/https?:\/\/(?!www\.threads\.com)[^"']*\.(png|jpg|jpeg|webp|mp4)/i.test(html.replace(/href="https:\/\/www\.threads\.com[^"]*"/g, '')));
check('report shows the root author', html.includes('@rootauthor'));
check('report shows every captured post', dataset.posts.every(p => html.includes(`id="post-${p.code}"`)), `${dataset.posts.length} posts`);
check('report shows the completeness warning', html.includes('Completeness notes') && html.includes('direct replies'));
check('report lists the hash of every file it was given', evidenceFiles.every(f => html.includes(f.sha256)));
check('report escapes HTML in post text', !html.includes('<script>alert'));

console.log('\n== xss escaping ==');
const evil = parser.buildThreadDataset({
  rootCode: 'EVIL',
  api: (() => {
    const store = parser.createApiStore({ rootCode: 'EVIL' });
    parser.collectApiPosts({ media: { code: 'EVIL', pk: '1', id: '1_2', taken_at: 1790000000, user: { username: '<img src=x onerror=alert(1)>', pk: '2' }, caption: { text: '</div><script>alert(1)</script>' }, text_post_app_info: { is_reply: false } } }, 'embedded', store, threads.parser);
    return store;
  })(),
  domPosts: new Map(),
  platform: threads
});
const evilHtml = renderThreadReport({ dataset: evil, platform: threads, capture: { captureId: '<b>x</b>', timestamp: 't', url: 'u', finalUrl: 'u', extensionVersion: '1', investigator: '"><script>alert(2)</script>', caseNumber: 'c', method: 'm' }, files: [], screenshots: [] });
check('script tag in post text is escaped', !/<script>alert\(1\)/.test(evilHtml) && evilHtml.includes('&lt;script&gt;alert(1)'));
check('img onerror in username is escaped', !/<img src=x onerror/.test(evilHtml));
check('script in investigator field is escaped', !/<script>alert\(2\)/.test(evilHtml));

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
console.log('evidence folder:', dir);
process.exit(failures === 0 ? 0 : 1);
