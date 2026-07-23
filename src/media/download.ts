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
};

export async function downloadToTmp(url: string): Promise<Downloaded> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download ${res.status} pentru ${url}`);

  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
  // detectKind validează image/* sau video/* (content-type sau extensie); aruncă altfel.
  const kind = detectKind(contentType, url);

  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared && declared > config.MAX_DOWNLOAD_BYTES) {
    throw new Error(`Fișier prea mare: ${declared} > ${config.MAX_DOWNLOAD_BYTES}`);
  }

  const dir = await mkdtemp(join(TMP_DIR, 'src-'));
  const ext = EXT_BY_CT[contentType] ?? (kind === 'image' ? '.img' : '.mp4');
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
