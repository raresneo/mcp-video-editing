// Detectează image vs video din Content-Type + extensie.
export type MediaKind = 'image' | 'video';

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const VIDEO_EXT = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'];

export function detectKind(contentType: string, url: string): MediaKind {
  const ct = (contentType || '').toLowerCase();
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/')) return 'video';
  
  const path = url.split('?')[0]?.toLowerCase() ?? '';
  if (IMAGE_EXT.some((e) => path.endsWith(e))) return 'image';
  if (VIDEO_EXT.some((e) => path.endsWith(e))) return 'video';
  
  throw new Error(`Nu pot detecta tipul media (content-type="${contentType}", url="${url}")`);
}
