import { readFile, stat, mkdtemp, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { config, TMP_DIR } from '../config.js';
import { log } from '../logger.js';

export interface Word {
  text: string;
  start: number;
  end: number;
}

export interface Caption {
  text: string;
  start: number;
  end: number;
}

// Limita hard a endpointului OpenAI e 25MB. Stam sub ea cu marja.
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

// Sparge segmente (fraze) in pseudo-cuvinte, distribuind timpul proportional cu
// lungimea fiecarui cuvant. Folosit cand providerul nu da timestamps word-level.
function spreadSegments(segments: Caption[]): Word[] {
  const words: Word[] = [];
  for (const seg of segments) {
    const parts = seg.text.split(/\s+/).filter(Boolean);
    if (!parts.length) continue;

    const totalChars = parts.reduce((n, p) => n + p.length, 0) || 1;
    const span = Math.max(0.01, seg.end - seg.start);
    let cursor = seg.start;

    for (const part of parts) {
      const dur = (part.length / totalChars) * span;
      words.push({ text: part, start: cursor, end: cursor + dur });
      cursor += dur;
    }
  }
  return words;
}

// ---- Provider 1: OpenAI Whisper (timestamps word-level, cel mai precis) ----
async function viaWhisper(audioPath: string, language?: string): Promise<Word[]> {
  const key = config.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY lipseste');

  const { size } = await stat(audioPath);
  if (size > MAX_AUDIO_BYTES) {
    throw new Error(
      `Audio ${size} bytes depaseste limita de 25MB a Whisper. ` +
        `Taie clipul cu trim_clip inainte de auto_caption.`,
    );
  }

  const form = new FormData();
  const buf = await readFile(audioPath);
  form.append('file', new Blob([buf], { type: 'audio/mpeg' }), basename(audioPath));
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');
  if (language) form.append('language', language);

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(180_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Whisper ${res.status}: ${body.slice(0, 500)}`);
  }

  const data: any = await res.json();

  if (Array.isArray(data.words) && data.words.length) {
    return data.words
      .map((w: any) => ({
        text: String(w.word ?? '').trim(),
        start: Number(w.start),
        end: Number(w.end),
      }))
      .filter((w: Word) => w.text.length > 0 && Number.isFinite(w.start) && Number.isFinite(w.end));
  }

  if (Array.isArray(data.segments) && data.segments.length) {
    log.info('whisper: fara words, cad pe segments');
    return spreadSegments(
      data.segments
        .map((s: any) => ({
          text: String(s.text ?? '').trim(),
          start: Number(s.start),
          end: Number(s.end),
        }))
        .filter((s: Caption) => s.text && Number.isFinite(s.start) && Number.isFinite(s.end)),
    );
  }

  throw new Error('Whisper nu a intors nici words, nici segments.');
}

// ---- Provider 2: Gemini pe Vertex (fallback, fara env noi) ----
async function viaGemini(audioPath: string, language?: string): Promise<Word[]> {
  const { GoogleGenAI } = await import('@google/genai');
  const fs = await import('node:fs');

  const projectId = process.env.GOOGLE_CLOUD_PROJECT || 'mcp-video-photo-social';
  if (process.env.GOOGLE_CREDENTIALS_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const tmpPath = '/tmp/gcp-credentials.json';
    fs.writeFileSync(tmpPath, process.env.GOOGLE_CREDENTIALS_JSON);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpPath;
  }

  const client = new GoogleGenAI({ project: projectId, location: 'us-central1', vertexai: true });
  const buf = await readFile(audioPath);
  const langHint = language
    ? `Limba vorbita este "${language}".`
    : 'Detecteaza singur limba vorbita.';

  const res: any = await client.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'audio/mpeg', data: buf.toString('base64') } },
          {
            text:
              `Transcrie exact acest audio, pe segmente scurte cu timestamps in secunde. ` +
              `${langHint} Pastreaza diacriticele corecte. Nu traduce, nu rescrie, nu inventa ` +
              `text si nu adauga segmente pentru liniste. Intoarce DOAR JSON.`,
          },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'object',
        properties: {
          segments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                start: { type: 'number' },
                end: { type: 'number' },
              },
              required: ['text', 'start', 'end'],
            },
          },
        },
        required: ['segments'],
      },
    },
  });

  const raw = typeof res?.text === 'string' ? res.text : '';
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Gemini a intors JSON invalid: ${raw.slice(0, 300)}`);
  }

  const segments: Caption[] = (parsed?.segments ?? [])
    .map((s: any) => ({
      text: String(s?.text ?? '').trim(),
      start: Number(s?.start),
      end: Number(s?.end),
    }))
    .filter((s: Caption) => s.text && Number.isFinite(s.start) && Number.isFinite(s.end));

  if (!segments.length) throw new Error('Gemini nu a intors segmente utilizabile.');
  return spreadSegments(segments);
}

// Whisper daca avem cheie, altfel Gemini. Daca Whisper crapa, tot cadem pe Gemini.
export async function transcribeWords(
  audioPath: string,
  language?: string,
): Promise<{ words: Word[]; provider: string }> {
  if (config.OPENAI_API_KEY) {
    try {
      const words = await viaWhisper(audioPath, language);
      return { words, provider: 'whisper-1' };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error('whisper a picat, incerc Gemini', msg);
    }
  }
  const words = await viaGemini(audioPath, language);
  return { words, provider: 'gemini-2.5-flash' };
}

export interface GroupOpts {
  maxWords?: number;
  maxChars?: number;
  maxDuration?: number;
  gapSplit?: number;
}

// Grupeaza cuvintele in linii scurte de caption: taie pe pauza, pe punctuatie
// finala, si pe limitele de cuvinte/caractere/durata.
export function groupWords(words: Word[], opts: GroupOpts = {}): Caption[] {
  const maxWords = opts.maxWords ?? 4;
  const maxChars = opts.maxChars ?? 28;
  const maxDuration = opts.maxDuration ?? 2.4;
  const gapSplit = opts.gapSplit ?? 0.45;

  const out: Caption[] = [];
  let current: Word[] = [];

  const flush = () => {
    if (!current.length) return;
    const text = current
      .map((w) => w.text)
      .join(' ')
      .replace(/\s+([,.!?;:])/g, '$1')
      .trim();
    if (text) {
      out.push({ text, start: current[0]!.start, end: current[current.length - 1]!.end });
    }
    current = [];
  };

  for (const w of words) {
    if (current.length) {
      const prev = current[current.length - 1]!;
      const charsIfAdded =
        current.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
      const durIfAdded = w.end - current[0]!.start;

      if (
        w.start - prev.end >= gapSplit ||
        current.length >= maxWords ||
        charsIfAdded > maxChars ||
        durIfAdded > maxDuration
      ) {
        flush();
      }
    }

    current.push(w);
    if (/[.!?\u2026]$/.test(w.text)) flush();
  }
  flush();

  // Durata minima vizibila + fara suprapuneri intre linii consecutive.
  for (let i = 0; i < out.length; i++) {
    const c = out[i]!;
    if (c.end - c.start < 0.35) c.end = c.start + 0.35;
    const next = out[i + 1];
    if (next && c.end > next.start) {
      c.end = Math.max(c.start + 0.2, next.start - 0.02);
    }
  }

  return out;
}

// Scrie un JSON temporar (folosit de auto_caption cu dry_run).
export async function writeJsonFile(data: unknown): Promise<string> {
  const dir = await mkdtemp(join(TMP_DIR, 'out-'));
  const path = join(dir, 'transcript.json');
  await writeFile(path, JSON.stringify(data, null, 2), 'utf8');
  return path;
}
