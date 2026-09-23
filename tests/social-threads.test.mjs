/**
 * Threads adapter + engine contract: extraction from the payload shapes the live site
 * serves, reply linkage, related-post exclusion and completeness reporting.
 *
 * Run: bun tests/social-threads.test.mjs
 */
import threads from '../src/social/platforms/threads.js';
import {
  parseJsonDocuments,
  summarizeMetaFormRequest,
  createApiStore,
  collectApiPosts,
  buildThreadDataset
} from '../src/social/engine.js';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`);
};

const fixture = JSON.parse(await Bun.file(new URL('./fixtures/threads-post.json', import.meta.url)).text());

console.log('== post URL parsing ==');
check('post permalink parsed', JSON.stringify(threads.parsePostUrl('https://www.threads.com/@some.user/post/DdjvqxNAdWd?xmt=1')) ===
  JSON.stringify({ platform: 'threads', username: 'some.user', code: 'DdjvqxNAdWd', canonicalUrl: 'https://www.threads.com/@some.user/post/DdjvqxNAdWd', displayLabel: '@some.user · DdjvqxNAdWd' }));
check('threads.net accepted and canonicalised', threads.parsePostUrl('https://threads.net/@u/post/ABC')?.canonicalUrl === 'https://www.threads.com/@u/post/ABC');
check('profile page rejected', threads.parsePostUrl('https://www.threads.com/@mosseri') === null);
check('media lightbox URL rejected', threads.parsePostUrl('https://www.threads.com/@u/post/ABC/media') === null);
check('other hosts rejected', threads.parsePostUrl('https://threads.example.com/@u/post/ABC') === null);
check('isThreadsUrl recognises non-post threads pages', threads.isPlatformUrl('https://www.threads.com/') && !threads.isPlatformUrl('https://instagram.com/'));

console.log('\n== response body parsing ==');
check('anti-hijacking prefix stripped', parseJsonDocuments('for (;;);{"a":1}')[0].a === 1);
check('newline-delimited documents parsed', parseJsonDocuments('{"a":1}\n{"b":2}').length === 2);
check('garbage lines skipped, not fatal', parseJsonDocuments('{"a":1}\nnot json\n{"b":2}').length === 2);
check('empty body yields nothing', parseJsonDocuments('').length === 0);

console.log('\n== graphql request summary ==');
const summary = summarizeMetaFormRequest('av=1&fb_dtsg=SECRET&lsd=LSDTOKEN&jazoest=2934&fb_api_req_friendly_name=BarcelonaPostPageRepliesQuery&doc_id=99&variables=%7B%22postID%22%3A%227%22%7D');
check('friendly name kept', summary.friendlyName === 'BarcelonaPostPageRepliesQuery');
check('doc id kept', summary.docId === '99');
check('variables parsed', summary.variables.postID === '7');
check('no auth tokens recorded', !JSON.stringify(summary).includes('SECRET') && !JSON.stringify(summary).includes('LSDTOKEN') && !JSON.stringify(summary).includes('2934'));

console.log('\n== api extraction ==');
const api = createApiStore({ rootCode: 'ROOT1' });
for (const payload of fixture.embedded) collectApiPosts(payload, 'embedded', api, threads.parser);
for (const doc of parseJsonDocuments(fixture.graphqlResponse)) collectApiPosts(doc, 'network', api, threads.parser);

check('root, replies and related posts found', [...api.posts.keys()].sort().join(',') === 'RELATED1,REPLY1,REPLY2,REPLY3,ROOT1', [...api.posts.keys()].join(','));
check('quoted post is not registered as a thread post', !api.posts.has('QUOTED1'));
check('unavailable-replies flag recorded for the root id', api.replyInfo.get('3991243342016009629_63482099442')?.hasUnavailableReplies === true);

const root = api.posts.get('ROOT1');
check('root text extracted', root.text === 'Spotlight: a root post with media');
check('root timestamp converted to UTC', root.createdAt === new Date(1790013304 * 1000).toISOString());
check('root counts extracted', JSON.stringify(root.counts) === JSON.stringify({ likes: 95, replies: 19, reposts: 3, quotes: 0, reshares: 3 }));
check('carousel media type', root.mediaType === 'carousel');
check('highest-resolution image chosen', root.media[0].url === 'https://cdn.example/big.jpg' && root.media[0].width === 1088);
check('video picked over its poster', root.media[1].kind === 'video' && root.media[1].url === 'https://cdn.example/clip.mp4' && root.media[1].posterUrl === 'https://cdn.example/poster.jpg');
check('author identity extracted', root.author.username === 'rootauthor' && root.author.userId === '63482099442' && root.author.isVerified === true);

const reply1 = api.posts.get('REPLY1');
check('reply parent recorded as the container post id (resolved later)',
  reply1.parentCode === null && reply1.parentId === '3991243342016009629_63482099442',
  `parentCode=${reply1.parentCode}, parentId=${reply1.parentId}`);
check('reply-to author recorded', reply1.replyToUsername === 'rootauthor');
check('mentions extracted', JSON.stringify(reply1.mentions) === JSON.stringify(['rootauthor']));
check('links extracted', reply1.links[0].url === 'https://example.org/evidence');

const reply2 = api.posts.get('REPLY2');
check('quoted post summarised on its parent', reply2.quotedPost?.code === 'QUOTED1' && reply2.quotedPost.author === 'quoted_author');
check('image accessibility caption kept', reply2.media[0].accessibilityCaption === 'A painting');

check('related post flagged as related', api.posts.get('RELATED1').related === true);
check('paginated reply came from the network source', JSON.stringify(api.posts.get('REPLY3').sources) === JSON.stringify(['network']));

console.log('\n== dataset ==');
const domPosts = new Map(fixture.domPosts.map(p => [p.code, { ...p, firstObservedAt: '2026-09-22T03:00:00.000Z' }]));
const dataset = buildThreadDataset({ rootCode: 'ROOT1', api, domPosts, platform: threads });

check('root identified', dataset.root.code === 'ROOT1' && dataset.root.role === 'root');
check('thread contains root + 4 replies', dataset.posts.length === 5, JSON.stringify(dataset.posts.map(p => `${p.role}:${p.code}`)));
check('related post excluded from the thread', dataset.relatedPosts.length === 1 && dataset.relatedPosts[0].code === 'RELATED1');
check('root is first, then DOM order, then API-only posts', JSON.stringify(dataset.posts.map(p => p.code)) === JSON.stringify(['ROOT1', 'REPLY1', 'REPLY2', 'DOMONLY1', 'REPLY3']), JSON.stringify(dataset.posts.map(p => p.code)));
check('rendered text attached to API posts', dataset.posts[1].rendered.text.includes('First reply'));
check('DOM-only reply kept with rendered text and no API fields', (() => {
  const domOnly = dataset.posts.find(p => p.code === 'DOMONLY1');
  return domOnly.role === 'reply' && domOnly.text === null && domOnly.counts === null && domOnly.rendered.text.includes('Rendered-only reply') && JSON.stringify(domOnly.sources) === JSON.stringify(['dom']);
})());
check('API-only reply kept without rendered text', (() => {
  const apiOnly = dataset.posts.find(p => p.code === 'REPLY3');
  return apiOnly.rendered === null && apiOnly.text.includes('paginated GraphQL batch');
})());

const stats = dataset.statistics;
check('statistics count replies', stats.replies === 4 && stats.threadPosts === 5, JSON.stringify(stats));
check('reported, linked and inferred direct replies all stated',
  stats.rootReportedReplies === 19 && stats.rootReportedRepliesScope === 'direct' && stats.directRepliesWithConfirmedParent === 2 && stats.directRepliesInferredFromReplyTo === 1,
  JSON.stringify([stats.rootReportedReplies, stats.directRepliesWithConfirmedParent, stats.directRepliesInferredFromReplyTo]));
check('id-only parent links resolved to shortcodes in the dataset',
  dataset.posts.filter(p => p.parentCode === 'ROOT1').map(p => p.code).join(',') === 'REPLY1,REPLY2',
  dataset.posts.map(p => `${p.code}->${p.parentCode}`).join(' '));
check('API/DOM provenance counted', stats.postsWithApiData === 4 && stats.postsRenderedOnly === 1 && stats.postsApiOnly === 1);
check('unavailable replies surfaced', stats.rootHasUnavailableReplies === true);
check('missing replies warned about', dataset.warnings.some(w => w.includes('19 direct replies')));
check('unavailable replies warned about', dataset.warnings.some(w => w.includes('unavailable')));
check('nested replies that are not shown are listed', JSON.stringify(dataset.repliesWithUncapturedChildren) === JSON.stringify([
  { code: 'REPLY1', url: 'https://www.threads.com/@replier_one/post/REPLY1', reportedReplies: 2, capturedReplies: 0 }
]), JSON.stringify(dataset.repliesWithUncapturedChildren));

console.log('\n== ancestor handling (capturing a reply permalink) ==');
const ancestorApi = createApiStore({ rootCode: 'REPLY1' });
for (const payload of fixture.embedded) collectApiPosts(payload, 'embedded', ancestorApi, threads.parser);
for (const doc of parseJsonDocuments(fixture.graphqlResponse)) collectApiPosts(doc, 'network', ancestorApi, threads.parser);
const ancestorDataset = buildThreadDataset({ rootCode: 'REPLY1', api: ancestorApi, domPosts, platform: threads });
check('the post above the captured reply becomes an ancestor', ancestorDataset.posts[0].code === 'ROOT1' && ancestorDataset.posts[0].role === 'ancestor', JSON.stringify(ancestorDataset.posts.map(p => `${p.role}:${p.code}`)));
check('captured post is the root of the report', ancestorDataset.root.code === 'REPLY1');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
