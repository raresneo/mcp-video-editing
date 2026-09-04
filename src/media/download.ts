import { createWriteStream } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { config, TMP_DIR } from '../config.js';
import { log } from '../logger.js';
import { detectKind, type MediaKind } from './detect.js';

export interface Downloaded {
  path: string;
  kind: MediaKind;
  contentType: string;
  bytes: number;
}

const EXT_BY_CT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/wave': '.wav',
  'audio/x-wav': '.wav',
  'audio/vnd.wave': '.wav',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
  'application/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
};

const EXT_BY_KIND: Record<MediaKind, string> = {
  image: '.img',
  video: '.mp4',
  audio: '.audio',
};

export async function downloadToTmp(url: string): Promise<Downloaded> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download ${res.status} pentru ${url}`);

  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
  // detectKind validează image/*, video/* sau audio/* (content-type sau extensie); aruncă altfel.
  const kind = detectKind(contentType, url);

  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared && declared > config.MAX_DOWNLOAD_BYTES) {
    throw new Error(`Fișier prea mare: ${declared} > ${config.MAX_DOWNLOAD_BYTES}`);
  }

  const dir = await mkdtemp(join(TMP_DIR, 'src-'));
  // Preferăm extensia din URL când content-type-ul nu e în tabel (CDN-uri generice).
  const urlExt = (url.split('?')[0]?.match(/\.[a-z0-9]{2,5}$/i)?.[0] ?? '').toLowerCase();
  const ext = EXT_BY_CT[contentType.toLowerCase()] ?? (urlExt || EXT_BY_KIND[kind]);
  const path = join(dir, `in${ext}`);

  // Stream cu enforce hard-limit pe bytes reali.
  let received = 0;
  const nodeStream = Readable.fromWeb(res.body as any);
  nodeStream.on('data', (chunk: Buffer) => {
    received += chunk.length;
    if (received > config.MAX_DOWNLOAD_BYTES) {
      nodeStream.destroy(new Error(`Depășit ${config.MAX_DOWNLOAD_BYTES} bytes la download`));
    }
  });

  await pipeline(nodeStream, createWriteStream(path));

  log.info('downloaded', JSON.stringify({ url, kind, contentType, bytes: received }));
  return { path, kind, contentType, bytes: received };
}
