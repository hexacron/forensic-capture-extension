/**
 * Screenshot stitching geometry: the maths that produced the HiDPI quarter-crop and the
 * duplicated bottom strip. The canvas is stubbed so every source/destination rectangle
 * the real Stitcher emits can be asserted exactly.
 *
 * Run: bun tests/stitcher-geometry.test.mjs
 */
const src = await Bun.file(new URL('../src/background/screenshot-capture.js', import.meta.url)).text();
const consts = src.match(/const MAX_SEGMENT_HEIGHT[\s\S]*?const MAX_SEGMENT_PIXELS = [^;]+;/)[0];
const stitcherSrc = src.slice(src.indexOf('class Stitcher'), src.indexOf('async function waitForActiveTab'));

const draws = [];
globalThis.OffscreenCanvas = class {
  constructor(width, height) {
    this.width = width;
    this.height = height;
  }
  getContext() {
    const canvas = this;
    return {
      drawImage(bitmap, sx, sy, sw, sh, dx, dy, dw, dh) {
        if (arguments.length === 3) { draws.push({ copy: true, canvas: canvas.height }); return; }
        draws.push({ segmentHeight: canvas.height, sx, sy, sw, sh, dx, dy, dw, dh, bitmap: bitmap.id });
      }
    };
  }
  async convertToBlob() {
    return { arrayBuffer: async () => new ArrayBuffer(this.width * 4) };
  }
};
globalThis.createImageBitmap = async (frame) => ({ ...frame, close() {} });

const module = new Function(`${consts}\n${stitcherSrc}\nreturn Stitcher;`)();

function run({ viewportCss, region, scale, scrollTops, pageHeight, ceiling }) {
  draws.length = 0;
  const stitcher = new module(viewportCss.width, region);
  const frames = [];
  for (const scrollTop of scrollTops) {
    const frame = { id: `f${scrollTop}`, width: Math.round(viewportCss.width * scale), height: Math.round(viewportCss.height * scale) };
    frames.push({ frame, scrollTop });
  }
  return (async () => {
    for (const { frame, scrollTop } of frames) {
      await stitcher.addFrame(frame, scrollTop, region, ceiling ?? pageHeight);
    }
    const segments = await stitcher.finish();
    return { stitcher, segments, draws: draws.filter(d => !d.copy) };
  })();
}

let failures = 0;
function check(label, condition, detail = '') {
  if (!condition) failures++;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`);
}

// ---------------------------------------------------------------------------
// Case 1: HiDPI page, exact multiple of the viewport, two segments
// ---------------------------------------------------------------------------
{
  const viewportCss = { width: 1280, height: 900 };
  const region = { left: 0, top: 0, width: 1280, height: 900 };
  const scale = 2;
  const pageHeight = 9000;
  const scrollTops = [0, 900, 1800, 2700, 3600, 4500, 5400, 6300, 7200, 8100];
  const { stitcher, segments, draws } = await run({ viewportCss, region, scale, scrollTops, pageHeight });

  console.log('\n== Case 1: 1280x900 viewport, DPR 2, 9000px page ==');
  check('scale derived from bitmap', stitcher.scale === 2, `scale=${stitcher.scale}`);
  check('output width is native (1280*2)', stitcher.width === 2560, `width=${stitcher.width}`);
  const expectedSegmentHeight = Math.min(16384, Math.floor(32 * 1024 * 1024 / 2560));
  check('segment height from canvas budget', stitcher.segmentHeight === expectedSegmentHeight, `segmentHeight=${stitcher.segmentHeight}`);
  check('covered the whole page', stitcher.coveredCss === pageHeight, `covered=${stitcher.coveredCss}`);

  const totalHeight = segments.reduce((sum, s) => sum + s.height, 0);
  check('total image height = page * scale', totalHeight === pageHeight * scale, `${totalHeight} vs ${pageHeight * scale}`);
  check('two segments emitted', segments.length === 2, JSON.stringify(segments.map(s => [s.width, s.height])));
  check('segments keep native width', segments.every(s => s.width === 2560));

  // every frame contributes exactly one viewport of rows, in order, without gaps
  let cursor = 0;
  let contiguous = true;
  let scaled = true;
  for (const d of draws) {
    const absoluteDest = d.segmentHeight === stitcher.segmentHeight && d.dy >= 0 ? d.dy : d.dy;
    if (cursor % stitcher.segmentHeight !== absoluteDest) contiguous = false;
    // source row must map back to the same page offset
    const frameScrollTop = Number(d.bitmap.slice(1));
    const pageY = frameScrollTop + (d.sy / scale - region.top);
    if (Math.round(pageY * scale) !== cursor) scaled = false;
    if (d.sw !== 2560 || d.dw !== 2560) scaled = false;
    cursor += d.dh;
  }
  check('draws are contiguous within segments', contiguous);
  check('source rows map to the right page offset at scale', scaled);
  check('draw coverage equals total height', cursor === pageHeight * scale, `${cursor}`);
}

// ---------------------------------------------------------------------------
// Case 2: clamped last scroll (the duplicated-bottom-strip bug)
// ---------------------------------------------------------------------------
{
  const viewportCss = { width: 1280, height: 900 };
  const region = { left: 0, top: 0, width: 1280, height: 900 };
  const scale = 1;
  const pageHeight = 2000;
  // the page can only scroll to 1100; a naive implementation would place the last
  // frame at 1800 and repeat 700px of content
  const scrollTops = [0, 900, 1100];
  const { stitcher, segments, draws } = await run({ viewportCss, region, scale, scrollTops, pageHeight });

  console.log('\n== Case 2: clamped final scroll, 2000px page ==');
  check('covered exactly the page height', stitcher.coveredCss === 2000, `covered=${stitcher.coveredCss}`);
  const total = segments.reduce((s, x) => s + x.height, 0);
  check('no duplicated rows', total === 2000, `height=${total}`);
  const last = draws[draws.length - 1];
  check('final frame only contributes the uncovered strip', last.dh === 200, `dh=${last.dh}`);
  check('final strip is read from the correct source row', last.sy === 700, `sy=${last.sy}`);
}

// ---------------------------------------------------------------------------
// Case 3: inner scroll container + height ceiling (infinite feed)
// ---------------------------------------------------------------------------
{
  const viewportCss = { width: 1400, height: 1000 };
  const region = { left: 60, top: 80, width: 800, height: 700 };
  const scale = 2;
  const ceiling = 1500; // thread content ends here, feed continues below
  const scrollTops = [0, 700, 1400];
  const { stitcher, segments, draws } = await run({ viewportCss, region, scale, scrollTops, pageHeight: 99999, ceiling });

  console.log('\n== Case 3: inner scroller (800x700 at 60,80), DPR 2, ceiling 1500 ==');
  check('width follows the scroll region', stitcher.width === 1600, `width=${stitcher.width}`);
  check('stopped at the ceiling', stitcher.coveredCss === ceiling, `covered=${stitcher.coveredCss}`);
  const total = segments.reduce((s, x) => s + x.height, 0);
  check('image height = ceiling * scale', total === ceiling * scale, `height=${total}`);
  check('source x offset = region.left * scale', draws.every(d => d.sx === 120), JSON.stringify(draws.map(d => d.sx)));
  check('first source row = region.top * scale', draws[0].sy === 160, `sy=${draws[0].sy}`);
  check('last frame cropped to the ceiling', draws[draws.length - 1].dh === (ceiling - 1400) * scale, `dh=${draws[draws.length - 1].dh}`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
