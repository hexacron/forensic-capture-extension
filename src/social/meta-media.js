/**
 * Media extraction for Meta API post objects (Threads and Instagram share the
 * `image_versions2` / `video_versions` / `carousel_media` layout). Pure functions.
 */

export function pickImage(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  return [...candidates]
    .filter(c => c && c.url)
    .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0] || null;
}

export function extractMedia(post) {
  const items = Array.isArray(post.carousel_media) && post.carousel_media.length
    ? post.carousel_media
    : [post];
  const media = [];
  for (const item of items) {
    if (!item) continue;
    const image = pickImage(item.image_versions2 && item.image_versions2.candidates);
    const video = Array.isArray(item.video_versions) ? item.video_versions.find(v => v && v.url) : null;
    if (video) {
      media.push({
        kind: 'video',
        url: video.url,
        width: item.original_width ?? null,
        height: item.original_height ?? null,
        posterUrl: image ? image.url : null
      });
    } else if (image) {
      media.push({
        kind: 'image',
        url: image.url,
        width: image.width ?? null,
        height: image.height ?? null,
        accessibilityCaption: item.accessibility_caption ?? null
      });
    }
  }
  return media;
}
