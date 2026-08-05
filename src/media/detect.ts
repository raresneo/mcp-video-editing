// Detectează image vs video din Content-Type + extensie.
export type MediaKind = 'image' | 'video';

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const VIDEO_EXT = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'];

// extHint: extensie luată din Content-Disposition (ex ".mov"), folosită când
// nici content-type nici URL-ul nu spun nimic util. Google Drive & co. trimit
// frecvent application/octet-stream pe URL-uri fără extensie.
export function detectKind(
  contentType: string,
  url: string,
  extHint?: string | null,
): MediaKind {
  const ct = (contentType || '').toLowerCase();
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/')) return 'video';

  const candidates = [
    url.split('?')[0]?.toLowerCase() ?? '',
    (extHint ?? '').toLowerCase(),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (IMAGE_EXT.some((e) => candidate.endsWith(e))) return 'image';
    if (VIDEO_EXT.some((e) => candidate.endsWith(e))) return 'video';
  }

  throw new Error(
    `Nu pot detecta tipul media (content-type="${contentType}", url="${url}", hint="${extHint ?? ''}")`,
  );
}
