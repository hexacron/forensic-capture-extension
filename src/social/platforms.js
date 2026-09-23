/**
 * Registry of social platform adapters. Pure module (popup, worker and tests).
 */

import threads from './platforms/threads.js';
import instagram from './platforms/instagram.js';
import x from './platforms/x.js';

export const PLATFORMS = [threads, instagram, x];

/** @returns {{platform: Object, target: Object} | null} the post a URL points at */
export function detectPost(url) {
  for (const platform of PLATFORMS) {
    const target = platform.parsePostUrl(url);
    if (target) return { platform, target };
  }
  return null;
}

/** The platform whose site a URL is on (post page or not), or null. */
export function platformForUrl(url) {
  return PLATFORMS.find(platform => platform.isPlatformUrl(url)) || null;
}

export function platformById(id) {
  return PLATFORMS.find(platform => platform.id === id) || null;
}
