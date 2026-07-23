import sharp from 'sharp';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { TMP_DIR } from '../config.js';
import { log } from '../logger.js';

async function outPath(ext = '.jpg'): Promise<string> {
  const dir = await mkdtemp(join(TMP_DIR, 'img-'));
  return join(dir, `out${ext}`);
}

// Rezolvă "story negru": PNG cu alpha -> JPEG flatten, resize cover.
export async function normalizeImage(input: string, w: number, h: number): Promise<string> {
  const meta = await sharp(input).metadata();
  log.info('normalize image IN', JSON.stringify({ format: meta.format, w: meta.width, h: meta.height, alpha: meta.hasAlpha }));
  
  const out = await outPath('.jpg');
  await sharp(input)
    .resize(w, h, { fit: 'cover', position: 'attention' })
    .flatten({ background: '#000000' }) // elimină alpha (PNG transparent -> fundal solid)
    .jpeg({ quality: 90 })
    .toFile(out);
    
  const outMeta = await sharp(out).metadata();
  log.info('normalize image OUT', JSON.stringify({ format: outMeta.format, w: outMeta.width, h: outMeta.height }));
  return out;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export interface OverlayText {
  content: string;
  x: number;
  y: number;
  color?: string;
  highlight_color?: string;
  font_size?: number;
}

// Overlay text pe imagine via SVG composite (diacritice RO corecte).
export async function textOverlayImage(input: string, texts: OverlayText[]): Promise<string> {
  const base = sharp(input);
  const meta = await base.metadata();
  const w = meta.width ?? 1080;
  const h = meta.height ?? 1080;
  
  const nodes = texts
    .map((t) => {
      const fs = t.font_size ?? 48;
      const fill = t.color ?? '#ffffff';
      const rect = t.highlight_color
        ? `<rect x="${t.x - 10}" y="${t.y - fs}" width="${t.content.length * fs * 0.6 + 20}" height="${fs * 1.4}" fill="${t.highlight_color}" rx="8"/>`
        : '';
      return `${rect}<text x="${t.x}" y="${t.y}" font-family="DejaVu Sans, sans-serif" font-weight="700" font-size="${fs}" fill="${fill}">${xmlEscape(t.content)}</text>`;
    })
    .join('');
    
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${nodes}</svg>`;
  const out = await outPath('.jpg');
  
  await base
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .flatten({ background: '#000000' })
    .jpeg({ quality: 92 })
    .toFile(out);
    
  log.info('text overlay OUT', JSON.stringify({ w, h, texts: texts.length }));
  return out;
}
