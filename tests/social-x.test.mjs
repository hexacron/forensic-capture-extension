/**
 * X adapter contract: status URL parsing, GraphQL request summaries, tweet extraction
 * from TweetDetail-shaped responses (both user layouts, visibility wrappers, quotes),
 * reply linkage, other-conversation exclusion and snowflake dating of DOM-only posts.
 *
 * Run: bun tests/social-x.test.mjs
 */
import x from '../src/social/platforms/x.js';
import { parseJsonDocuments, createApiStore, collectApiPosts, buildThreadDataset } from '../src/social/engine.js';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`);
};

const fixture = JSON.parse(await Bun.file(new URL('./fixtures/x-post.json', import.meta.url)).text());
const R = '1000000000000000001';
const A = '1000000000000000002';
const B = '1000000000000000003';
const Q = '1000000000000000004';
const P = '1000000000000000005';
const DOM_ONLY = '1770888775830262034';

console.log('== post URL parsing ==');
for (const url of ['https://x.com/u/status/1', 'https://twitter.com/u/status/1', 'https://mobile.x.com/u/status/1/photo/1', 'https://x.com/i/web/status/1']) {
  check(`accepted ${url}`, x.parsePostUrl(url)?.code === '1', JSON.stringify(x.parsePostUrl(url)));
}
check('canonical URL on x.com', x.parsePostUrl('https://twitter.com/u/status/1').canonicalUrl === 'https://x.com/u/status/1' &&
  x.parsePostUrl('https://x.com/i/web/status/1').canonicalUrl === 'https://x.com/i/status/1');
for (const url of ['https://x.com/home', 'https://x.com/u', 'https://x.com/i/status/abc']) {
  check(`rejected ${url}`, x.parsePostUrl(url) === null);
}

console.log('\n== request summary ==');
const summary = x.api.summarizeRequest({ url: 'https://x.com/i/api/graphql/abc/TweetDetail?variables=%7B%22focalTweetId%22%3A%221%22%7D&features=%7B%7D' });
check('operation, query id and variables only', JSON.stringify(summary) === JSON.stringify({ friendlyName: 'TweetDetail', docId: 'abc', variables: { focalTweetId: '1' } }), JSON.stringify(summary));
check('TweetDetail is a content fetch, badge polling is not', x.api.isContentFetch({ friendlyName: 'TweetDetail' }) && !x.api.isContentFetch({ friendlyName: 'BadgeCount' }));

console.log('\n== api extraction ==');
const api = createApiStore({ rootCode: R });
for (const doc of parseJsonDocuments(fixture.graphqlResponse)) collectApiPosts(doc, 'network', api, x.parser);
check('conversation tweets extracted, quoted tweet not registered', [...api.posts.keys()].sort().join(',') === [R, A, B, P].sort().join(','), [...api.posts.keys()].join(','));
check('quoted tweet summarised on the quoting reply', api.posts.get(A).quotedPost?.code === Q && api.posts.get(A).quotedPost.author === 'quoted_user');
check('usernames from legacy and core user layouts', api.posts.get(R).author.username === 'root_user' && api.posts.get(A).author.username === 'replier_a');
check('highest-bitrate mp4 chosen', api.posts.get(A).media[0]?.url === 'https://video.example/high.mp4');
check('timestamp converted to UTC', api.posts.get(R).createdAt === '2024-03-21T19:02:40.000Z');

console.log('\n== dataset ==');
const domPosts = new Map(fixture.domPosts.map(p => [p.code, { ...p, firstObservedAt: '2026-09-23T03:00:00.000Z' }]));
const dataset = buildThreadDataset({ rootCode: R, api, domPosts, platform: x });
const byCode = new Map(dataset.posts.map(p => [p.code, p]));
check('tweet from another conversation is related', dataset.relatedPosts.map(p => p.code).join(',') === P);
check('thread in rendered order', dataset.posts.map(p => p.code).join(',') === [R, A, B, DOM_ONLY].join(','), dataset.posts.map(p => p.code).join(','));
check('reply-to-reply linked to its parent', byCode.get(B)?.parentCode === A);
check('DOM-only post dated from its snowflake id', byCode.get(DOM_ONLY)?.createdAt === '2024-03-21T19:02:40.337Z' &&
  byCode.get(DOM_ONLY).createdAtSource.includes('snowflake'), JSON.stringify([byCode.get(DOM_ONLY)?.createdAt, byCode.get(DOM_ONLY)?.createdAtSource]));
check('pre-snowflake ids are not dated', x.parser.domFallbackCreatedAt('20') === null);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
