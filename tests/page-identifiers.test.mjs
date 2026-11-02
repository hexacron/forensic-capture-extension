/**
 * Page metadata and platform identifiers (src/content/page-identifiers.js): what is read from the
 * address versus the page, the guards against another post's data, and the host matching.
 * The pages in tests/fixtures/pages keep the structure of live pages; see their header comments.
 *
 * Run: bun tests/page-identifiers.test.mjs
 */
import { parseHTML } from 'linkedom';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`);
};

const source = await Bun.file(new URL('../src/content/page-identifiers.js', import.meta.url)).text();
const sandbox = {};
new Function('window', source)(sandbox);
const { extractPageMetadata, extractPageIdentifiers } = sandbox.__exhibitPageIdentifiers;

const page = async name => parseHTML(await Bun.file(new URL(`./fixtures/pages/${name}`, import.meta.url)).text()).document;
const html = body => parseHTML(`<!DOCTYPE html><html><head></head><body>${body}</body></html>`).document;
const empty = html('');
const json = value => JSON.stringify(value);

console.log('== page metadata ==');
const linkedinPage = await page('linkedin-post.html');
const meta = extractPageMetadata(linkedinPage);
check('description, language and Open Graph read', meta.description === 'Example post text.' && meta.language === 'en' &&
  meta.openGraph.siteName === 'LinkedIn' && meta.openGraph.type === 'article', json(meta));
check('absent values are null, not placeholders', meta.keywords === null && meta.canonicalUrl === null);
const redditPage = await page('reddit-post.html');
check('canonical URL read', extractPageMetadata(redditPage).canonicalUrl.endsWith('/1x0j559/margaret_hamilton_computing_pioneer_who_led/'));
const blank = extractPageMetadata(empty);
check('empty document gives all nulls', blank.description === null && blank.openGraph.image === null && blank.language === null);

console.log('\n== reddit ==');
const postUrl = 'https://www.reddit.com/r/programming/comments/1x0j559/margaret_hamilton_computing_pioneer_who_led/';
let r = extractPageIdentifiers(redditPage, postUrl);
check('post, subreddit and author ids', r.fields.postId === '1x0j559' && r.fields.postFullname === 't3_1x0j559' &&
  r.fields.author === 'example_author' && r.fields.authorId === 't2_3c9g' && r.fields.subredditId === 't5_2fwo', json(r.fields));
check('the element for this post is used, not the first on the page', r.fields.author !== 'other_user');
check('provenance recorded', r.sources.postId === 'url' && r.sources.author === 'dom');
r = extractPageIdentifiers(empty, postUrl);
check('address alone still gives the post id', r.fields.postId === '1x0j559' && r.fields.subreddit === 'programming' && !r.fields.author, json(r.fields));
check('a subreddit listing is not a post', extractPageIdentifiers(redditPage, 'https://www.reddit.com/r/programming/') === null);
check('user-profile comment link', extractPageIdentifiers(empty, 'https://www.reddit.com/user/someone/comments/abc123/title/').fields.postId === 'abc123');

console.log('\n== tiktok ==');
const tiktokPage = await page('tiktok-video.html');
const videoUrl = 'https://www.tiktok.com/@tiktok/video/7106594312292453675';
let t = extractPageIdentifiers(tiktokPage, videoUrl);
check('embedded data adds author id, caption and download URL', t.fields.authorId === '107955' && t.fields.authorUsername === 'tiktok' &&
  t.fields.description.startsWith('how many frogs') && t.fields.downloadUrl.includes('mime_type=video_mp4'), json(t.fields));
check('provenance recorded', t.sources.videoId === 'url' && t.sources.authorId === 'embedded-json');
t = extractPageIdentifiers(tiktokPage, 'https://www.tiktok.com/@someone/video/7000000000000000001');
check('embedded data for a different video is not used', t.fields.videoId === '7000000000000000001' && !t.fields.authorId && !t.fields.description, json(t.fields));
check('the mismatch is noted', t.notes.length === 1 && t.notes[0].includes('7106594312292453675'), json(t.notes));
t = extractPageIdentifiers(html('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{broken</script>'), videoUrl);
check('unparseable embedded data keeps the URL fields and notes it', t.fields.videoId === '7106594312292453675' && t.notes.length === 1);
check('a profile page is not a video', extractPageIdentifiers(tiktokPage, 'https://www.tiktok.com/@tiktok') === null);

console.log('\n== linkedin ==');
const feedUrl = 'https://www.linkedin.com/feed/update/urn:li:activity:7330494895339499520/';
let l = extractPageIdentifiers(linkedinPage, feedUrl);
check('URN from /feed/update/ and the poster from JSON-LD', l.fields.postUrn === 'urn:li:activity:7330494895339499520' &&
  l.fields.authorName === 'Example Poster' && l.fields.authorUrl.endsWith('/in/exampleposter') && l.fields.datePublished.startsWith('2025-05-20'), json(l.fields));
check('the poster, not the original author of a reshare', l.fields.authorName !== 'Original Company');
check('provenance recorded', l.sources.postId === 'url' && l.sources.authorName === 'json-ld');
l = extractPageIdentifiers(empty, 'https://www.linkedin.com/posts/exampleposter_topic-words-activity-7330494895339499520-AbCd');
check('/posts/ slug form: id, type and author handle', l.fields.postId === '7330494895339499520' && l.fields.authorHandle === 'exampleposter' && !l.fields.authorName, json(l.fields));
l = extractPageIdentifiers(empty, 'https://www.linkedin.com/feed/update/urn%3Ali%3AugcPost%3A7000000000000000000');
check('percent-encoded URN and ugcPost type', l.fields.postUrn === 'urn:li:ugcPost:7000000000000000000', json(l?.fields));
check('JSON-LD of another post is ignored', !extractPageIdentifiers(linkedinPage, 'https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/').fields.authorName);
check('profile page is not a post', extractPageIdentifiers(linkedinPage, 'https://www.linkedin.com/in/exampleposter/') === null);

console.log('\n== facebook (address only) ==');
const fbCases = [
  ['https://www.facebook.com/somepage/posts/10153231379946729', { contentType: 'post', postId: '10153231379946729', ownerHandle: 'somepage' }],
  ['https://www.facebook.com/somepage/posts/pfbid02AbCdEf123', { contentType: 'post', postToken: 'pfbid02AbCdEf123', ownerHandle: 'somepage' }],
  ['https://m.facebook.com/permalink.php?story_fbid=pfbid0Xyz9&id=100012345678901', { postToken: 'pfbid0Xyz9', ownerId: '100012345678901' }],
  ['https://www.facebook.com/story.php?story_fbid=1234567890123&id=9876543210', { postId: '1234567890123', ownerId: '9876543210' }],
  ['https://www.facebook.com/somepage/videos/555666777888', { contentType: 'video', videoId: '555666777888' }],
  ['https://www.facebook.com/reel/1234567890', { contentType: 'reel', videoId: '1234567890' }],
  ['https://www.facebook.com/watch/?v=998877665544', { contentType: 'video', videoId: '998877665544' }],
  ['https://www.facebook.com/groups/12345/posts/67890123/', { groupId: '12345', postId: '67890123' }],
  ['https://www.facebook.com/photo/?fbid=1122334455&set=a.1', { contentType: 'photo', photoId: '1122334455' }],
  ['https://www.facebook.com/somepage/photos/a.123/4455667788/', { contentType: 'photo', photoId: '4455667788' }],
  ['https://www.facebook.com/share/p/1AbCdEfGh/', { contentType: 'post', shareToken: '1AbCdEfGh' }],
  ['https://www.facebook.com/profile.php?id=100044445555666', { contentType: 'profile', profileId: '100044445555666' }]
];
for (const [url, expected] of fbCases) {
  const f = extractPageIdentifiers(empty, url);
  const ok = f && Object.entries(expected).every(([k, v]) => f.fields[k] === v);
  check(url.replace('https://', ''), ok, ok ? '' : json(f?.fields));
}
check('a vanity profile or feed gives nothing', extractPageIdentifiers(empty, 'https://www.facebook.com/somepage') === null &&
  extractPageIdentifiers(empty, 'https://www.facebook.com/') === null);
const viewer = extractPageIdentifiers(html('<script>{"userID":"1000099999999","USER_ID":"1000099999999"}</script>'), 'https://www.facebook.com/profile.php?id=100044445555666');
check('the viewing account\'s id in page data is never read', !json(viewer).includes('1000099999999'), json(viewer.fields));

console.log('\n== vk ==');
const vkWall = extractPageIdentifiers(empty, 'https://vk.com/wall-22822305_1234');
check('community wall post', vkWall.fields.postId === '-22822305_1234' && vkWall.fields.ownerId === '-22822305' &&
  vkWall.fields.ownerType === 'community' && vkWall.fields.localPostId === '1234', json(vkWall.fields));
const vkQuery = extractPageIdentifiers(empty, 'https://vk.ru/vk?w=wall-22822305_1234%2Fall');
check('?w= form on vk.ru', vkQuery?.fields.postId === '-22822305_1234', json(vkQuery?.fields));
check('user wall post', extractPageIdentifiers(empty, 'https://m.vk.com/wall12345_6').fields.ownerType === 'user');
check('a wall without a post id is not a post', extractPageIdentifiers(empty, 'https://vk.com/wall-1') === null);

console.log('\n== host matching ==');
for (const url of [
  'https://www.netflix.com/title/80100172',
  'https://notreddit.com/comments/abc123/x',
  'https://evilfacebook.com/somepage/posts/10153231379946729',
  'https://x.com/user/status/1',
  'https://www.instagram.com/p/ABC/',
  'https://www.threads.com/@user/post/ABC'
]) {
  check(`no identifiers for ${url.replace('https://', '')}`, extractPageIdentifiers(empty, url) === null);
}
check('invalid URL gives null', extractPageIdentifiers(empty, 'not a url') === null);

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
