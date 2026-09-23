/**
 * Instagram adapter contract: post/Reel URL parsing, media + comment extraction from
 * the embedded and GraphQL shapes, comment linkage and completeness reporting.
 *
 * Run: bun tests/social-instagram.test.mjs
 */
import instagram from '../src/social/platforms/instagram.js';
import { parseJsonDocuments, createApiStore, collectApiPosts, buildThreadDataset } from '../src/social/engine.js';
import { renderThreadReport } from '../src/social/report.js';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`);
};

const fixture = JSON.parse(await Bun.file(new URL('./fixtures/instagram-post.json', import.meta.url)).text());

console.log('== post URL parsing ==');
const accepted = [
  ['https://www.instagram.com/p/X1/', 'post'],
  ['https://www.instagram.com/reel/X1/', 'reel'],
  ['https://www.instagram.com/someuser/p/X1/', 'post'],
  ['https://www.instagram.com/someuser/reel/X1/', 'reel'],
  ['https://www.instagram.com/p/X1/c/123/', 'post'],
  ['https://m.instagram.com/p/X1/', 'post']
];
for (const [url, kind] of accepted) {
  const target = instagram.parsePostUrl(url);
  check(`accepted ${url}`, target?.code === 'X1' && target.kind === kind && target.canonicalUrl === 'https://www.instagram.com/p/X1/', JSON.stringify(target));
}
check('username kept for display', instagram.parsePostUrl('https://www.instagram.com/someuser/p/X1/').displayLabel === '@someuser · X1');
for (const url of ['https://www.instagram.com/someuser/', 'https://www.instagram.com/explore/', 'https://www.instagram.com/stories/u/1/', 'https://instagram.example.com/p/X1/']) {
  check(`rejected ${url}`, instagram.parsePostUrl(url) === null);
}

const extract = rootCommentCount => {
  const store = createApiStore({ rootCode: 'IGROOT1' });
  const embedded = structuredClone(fixture.embedded);
  if (rootCommentCount !== undefined) {
    embedded[0].require[0][3][0].__bbox.require[0][3][1].__bbox.result.data.xig_polaris_media.if_not_gated_logged_out.comment_count = rootCommentCount;
  }
  for (const payload of embedded) collectApiPosts(payload, 'embedded', store, instagram.parser);
  for (const doc of parseJsonDocuments(fixture.graphqlResponse)) collectApiPosts(doc, 'network', store, instagram.parser);
  return store;
};
const domPosts = new Map(fixture.domPosts.map(p => [p.code, { ...p, firstObservedAt: '2026-09-23T03:00:00.000Z' }]));

console.log('\n== api extraction ==');
const api = extract();
check('media and comments extracted; carousel items not registered', [...api.posts.keys()].sort().join(',') === '201,202,203,204,IGOTHER1,IGROOT1', [...api.posts.keys()].join(','));
const root = api.posts.get('IGROOT1');
check('root comment count read as replies', root.counts.replies === 5);
check('carousel with one image and one video', root.mediaType === 'carousel' &&
  root.media.map(m => m.kind).join(',') === 'image,video' &&
  root.media[0].url === 'https://cdn.example/ig-big.jpg' && root.media[1].url === 'https://cdn.example/ig-clip.mp4');
check('caption mentions extracted', JSON.stringify(root.mentions) === JSON.stringify(['friend_one']), JSON.stringify(root.mentions));
check('comment permalink built on the post code', api.posts.get('203').url === 'https://www.instagram.com/p/IGROOT1/c/203/');

console.log('\n== dataset ==');
const dataset = buildThreadDataset({ rootCode: 'IGROOT1', api, domPosts, platform: instagram });
const byCode = new Map(dataset.posts.map(p => [p.code, p]));
check('child comment linked to its parent comment', byCode.get('204')?.parentCode === '201', byCode.get('204')?.parentCode);
check('top-level comments linked to the post', ['201', '202', '203'].every(c => byCode.get(c)?.parentCode === 'IGROOT1'),
  ['201', '202', '203'].map(c => `${c}->${byCode.get(c)?.parentCode}`).join(' '));
check('other media object is related, not part of the thread', dataset.relatedPosts.map(p => p.code).join(',') === 'IGOTHER1');
check('thread in rendered order', dataset.posts.map(p => p.code).join(',') === 'IGROOT1,201,204,202,203,299', dataset.posts.map(p => p.code).join(','));
check('comments counted, reported count covers replies to comments',
  dataset.statistics.replies === 5 && dataset.statistics.rootReportedReplies === 5 && dataset.statistics.rootReportedRepliesScope === 'all',
  JSON.stringify(dataset.statistics));

// Comments harvested while the page scrolled can carry a position above the post's own block.
const shifted = new Map([...domPosts].map(([code, p]) => [code, code === '202' ? { ...p, documentY: -300 } : p]));
const shiftedDataset = buildThreadDataset({ rootCode: 'IGROOT1', api: extract(), domPosts: shifted, platform: instagram });
check('a comment rendered above the post is still a reply, not an ancestor',
  shiftedDataset.statistics.ancestors === 0 && shiftedDataset.posts.find(p => p.code === '202')?.role === 'reply',
  shiftedDataset.posts.map(p => `${p.role}:${p.code}`).join(' '));
check('no missing-comments warning when everything was captured', !dataset.warnings.some(w => w.includes('including replies')), JSON.stringify(dataset.warnings));

const short = buildThreadDataset({ rootCode: 'IGROOT1', api: extract(9), domPosts, platform: instagram });
check('missing comments warned about', short.warnings.some(w => w.includes('9 comments') && w.includes('including replies')), JSON.stringify(short.warnings));

console.log('\n== report ==');
const html = renderThreadReport({
  dataset,
  platform: instagram,
  capture: { captureId: 'c', timestamp: 't', url: 'u', finalUrl: 'u', extensionVersion: '1', investigator: 'i', caseNumber: 'n', method: 'm' },
  files: [],
  screenshots: []
});
check('report titled by platform and uses comment wording', html.includes('<title>Instagram post by @ig_owner (IGROOT1)</title>') && html.includes('Comments 5') && html.includes('5 comments'));

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
