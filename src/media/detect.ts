// Detectează image vs video vs audio din Content-Type + extensie.
export type MediaKind = 'image' | 'video' | 'audio';

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const VIDEO_EXT = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'];
const AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac'];

// Unele CDN-uri trimit content-type generic sau greșit; extensia decide atunci.
const GENERIC_CT = ['', 'application/octet-stream', 'binary/octet-stream'];

export function detectKind(contentType: string, url: string): MediaKind {
  const ct = (contentType || '').toLowerCase();
  const path = url.split('?')[0]?.toLowerCase() ?? '';

  // Extensia are prioritate când content-type-ul e generic/absent.
  if (GENERIC_CT.includes(ct)) {
    if (IMAGE_EXT.some((e) => path.endsWith(e))) return 'image';
    if (VIDEO_EXT.some((e) => path.endsWith(e))) return 'video';
    if (AUDIO_EXT.some((e) => path.endsWith(e))) return 'audio';
  }

  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('audio/')) return 'audio';
  // audio/wave, audio/x-wav, audio/mpeg, audio/mp4 intră deja mai sus;
  // aici prindem cazurile exotice tip 'application/ogg'.
  if (ct === 'application/ogg' || ct === 'application/x-flac') return 'audio';

  if (IMAGE_EXT.some((e) => path.endsWith(e))) return 'image';
  if (VIDEO_EXT.some((e) => path.endsWith(e))) return 'video';
  if (AUDIO_EXT.some((e) => path.endsWith(e))) return 'audio';

  throw new Error(`Nu pot detecta tipul media (content-type="${contentType}", url="${url}")`);
}
