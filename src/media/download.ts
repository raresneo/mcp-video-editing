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
  'video/x-matroska': '.mkv',
};

// Linkurile de share NU sunt fișiere binare. Google Drive întoarce o pagină HTML
// pentru /file/d/ID/view, iar Dropbox pentru ?dl=0. Le rescriem în endpointul de
// download direct. Pentru Drive, confirm=t sare peste interstitialul de virus scan
// care apare la fișiere mari.
export function resolveUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }

  const host = u.hostname.toLowerCase();

  if (host === 'drive.google.com' || host === 'drive.usercontent.google.com') {
    const fromPath = u.pathname.match(/\/file\/d\/([^/]+)/)?.[1];
    const id = fromPath ?? u.searchParams.get('id');
    if (id) {
      return `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
    }
  }

  if (host.endsWith('dropbox.com')) {
    u.searchParams.set('dl', '1');
    return u.toString();
  }

  return raw;
}

// Extensia reală vine adesea doar din Content-Disposition.
function extFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  const name = match?.[1];
  if (!name) return null;
  const dot = name.lastIndexOf('.');
  return dot > -1 ? name.slice(dot).toLowerCase() : null;
}

export async function downloadToTmp(url: string): Promise<Downloaded> {
  const resolved = resolveUrl(url);
  if (resolved !== url) {
    log.info('url rescris pentru download direct', JSON.stringify({ from: url, to: resolved }));
  }

  const res = await fetch(resolved, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download ${res.status} pentru ${resolved}`);

  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();

  // Dacă primim HTML, fișierul nu e public: e pagina de login/consent, nu media.
  if (contentType.startsWith('text/html')) {
    throw new Error(
      `URL-ul a întors o pagină HTML, nu un fișier media (${resolved}). ` +
        `Dacă e Google Drive, pune sharing pe "Anyone with the link".`,
    );
  }

  const dispExt = extFromDisposition(res.headers.get('content-disposition'));
  // detectKind validează image/* sau video/* (content-type, extensie URL sau hint); aruncă altfel.
  const kind = detectKind(contentType, url, dispExt);

  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared && declared > config.MAX_DOWNLOAD_BYTES) {
    throw new Error(`Fișier prea mare: ${declared} > ${config.MAX_DOWNLOAD_BYTES}`);
  }

  const dir = await mkdtemp(join(TMP_DIR, 'src-'));
  const ext = EXT_BY_CT[contentType] ?? dispExt ?? (kind === 'image' ? '.img' : '.mp4');
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

  log.info('downloaded', JSON.stringify({ url: resolved, kind, contentType, bytes: received }));
  return { path, kind, contentType, bytes: received };
}
