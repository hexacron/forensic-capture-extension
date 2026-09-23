/**
 * Human-like, trusted input for pages that watch for automation (Threads/Meta).
 *
 * Everything is dispatched through the DevTools protocol Input domain, so the page
 * receives genuine browser events (isTrusted === true): wheel scrolling instead of
 * programmatic scroll jumps, mouse paths before clicks, real key presses.
 *
 * Pacing profiles randomise every delay. Nothing here guarantees a platform will not
 * flag an account; it removes the obvious automation signals and slows the capture
 * to a human browsing rate.
 */

export const PACING_PROFILES = {
  careful: {
    name: 'careful',
    roundPause: [1800, 4200],     // reading pause between scroll rounds (ms)
    longPauseChance: 0.12,        // occasional longer stop
    longPause: [5000, 9000],
    scrollFraction: [0.45, 0.8],  // share of the viewport scrolled per round
    wheelTick: [60, 125],         // pixels per wheel event
    wheelTickGap: [18, 48],       // ms between wheel events
    frameSettle: [800, 1700],     // screenshot: wait after each scroll
    clickPause: [700, 1600],
    maxGraphqlPerMinute: 10,      // cap on reply-page fetches
    maxLoadMinutes: 30
  },
  fast: {
    name: 'fast',
    roundPause: [900, 1400],
    longPauseChance: 0,
    longPause: [0, 0],
    scrollFraction: [0.85, 0.95],
    wheelTick: [120, 240],
    wheelTickGap: [8, 16],
    frameSettle: [450, 650],
    clickPause: [250, 500],
    maxGraphqlPerMinute: 60,
    maxLoadMinutes: 10
  }
};

export function randomBetween([min, max]) {
  return min + Math.random() * (max - min);
}

export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class HumanInput {
  /**
   * @param {import('./cdp-session.js').CdpSession} cdp
   * @param {Object} pacing - one of PACING_PROFILES
   */
  constructor(cdp, pacing) {
    this.cdp = cdp;
    this.pacing = pacing;
    this.mouse = null; // last pointer position (viewport CSS px)
    this.stats = { wheelEvents: 0, clicks: 0, keys: 0, pausesMs: 0 };
  }

  async pause(range) {
    const ms = randomBetween(range);
    this.stats.pausesMs += ms;
    await delay(ms);
  }

  /** Reading pause between rounds, sometimes longer. */
  async readingPause() {
    const long = Math.random() < this.pacing.longPauseChance;
    await this.pause(long ? this.pacing.longPause : this.pacing.roundPause);
  }

  /** Move the pointer along a slightly curved, eased path. */
  async moveTo(x, y) {
    const from = this.mouse || { x: x + randomBetween([-180, 180]), y: y + randomBetween([-120, 120]) };
    const steps = Math.round(randomBetween([6, 13]));
    const bend = { x: randomBetween([-40, 40]), y: randomBetween([-30, 30]) };
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const arc = Math.sin(Math.PI * t);
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(from.x + (x - from.x) * ease + bend.x * arc),
        y: Math.round(from.y + (y - from.y) * ease + bend.y * arc)
      });
      await delay(randomBetween([8, 22]));
    }
    this.mouse = { x, y };
  }

  /**
   * Scroll by deltaY CSS px with wheel events at (x, y). Negative scrolls up.
   */
  async wheel(deltaY, x, y) {
    if (!this.mouse || Math.abs(this.mouse.x - x) > 60 || Math.abs(this.mouse.y - y) > 60) {
      await this.moveTo(x, y);
    }
    const direction = Math.sign(deltaY);
    let remaining = Math.abs(deltaY);
    while (remaining > 0.5) {
      const tick = Math.min(remaining, randomBetween(this.pacing.wheelTick));
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: this.mouse.x,
        y: this.mouse.y,
        deltaX: 0,
        deltaY: direction * tick
      });
      this.stats.wheelEvents++;
      remaining -= tick;
      await delay(randomBetween(this.pacing.wheelTickGap));
    }
  }

  /** A random point inside rect {x, y, width, height}, away from the edges. */
  pointIn(rect) {
    return {
      x: Math.round(rect.x + rect.width * randomBetween([0.3, 0.7])),
      y: Math.round(rect.y + rect.height * randomBetween([0.3, 0.7]))
    };
  }

  /**
   * Press and release the left button at (x, y). Callers must move the pointer there
   * first and verify what is under it: a trusted click acts as the signed-in user.
   */
  async press(x, y) {
    await delay(randomBetween([60, 180]));
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await delay(randomBetween([55, 130]));
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    this.stats.clicks++;
  }

  async pressKey(key, code, keyCode) {
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode });
    await delay(randomBetween([40, 110]));
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
    this.stats.keys++;
  }
}
