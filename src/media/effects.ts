import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

// Efecte selective pe segmente din TIMPUL sursei. Segmentele nedeclarate
// raman neschimbate. Fara sunet, fara shell: argumentele ajung ca array.

export type Effect = 'none' | 'grayscale';

export interface EffectSegment {
  start: number;
  end: number;
  speed?: number;
  effect?: Effect;
  saturation?: number;
}

export interface ResolvedSegment {
  start: number;
  end: number;
  speed: number;
  effect: Effect;
  saturation: number;
}

export const MAX_SEGMENTS = 16;
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 2;
export const SATURATION_MIN = 0;
export const SATURATION_MAX = 2;
// Limite de resurse: sursa max 120s, durata estimată a ieșirii max 120s.
export const MAX_SOURCE_S = 120;
export const MAX_OUTPUT_S = 120;
const EFFECTS: readonly Effect[] = ['none', 'grayscale'];

export interface ProbeResult {
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
}
export type ProbeFn = (path: string) => Promise<ProbeResult>;
export type RunFn = (bin: string, args: string[]) => Promise<void>;

function num(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${field} trebuie sa fie numar finit`);
  }
  return v;
}

// Durata estimată a ieșirii (secunde), după aplicarea vitezei.
export function outputDuration(segs: ResolvedSegment[]): number {
  return segs.reduce((sum, s) => sum + (s.end - s.start) / s.speed, 0);
}

// Valideaza planul si umple golurile cu segmente intacte (speed 1, fara efect).
export function resolveSegments(input: unknown, duration: number): ResolvedSegment[] {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('durata sursei nu e valida');
  }
  if (duration > MAX_SOURCE_S) {
    throw new Error(`sursa depășește ${MAX_SOURCE_S}s`);
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('segments trebuie sa fie o lista nevida');
  }
  if (input.length > MAX_SEGMENTS) {
    throw new Error(`maximum ${MAX_SEGMENTS} segmente`);
  }

  const parsed: ResolvedSegment[] = input.map((raw, i) => {
    if (raw === null || typeof raw !== 'object') throw new Error(`segments[${i}] invalid`);
    const s = raw as EffectSegment;
    const start = num(s.start, `segments[${i}].start`);
    const end = num(s.end, `segments[${i}].end`);
    if (start < 0) throw new Error(`segments[${i}].start nu poate fi negativ`);
    if (!(start < end)) throw new Error(`segments[${i}]: trebuie start < end`);
    if (end > duration) throw new Error(`segments[${i}].end depaseste durata (${duration}s)`);

    const speed = s.speed === undefined ? 1 : num(s.speed, `segments[${i}].speed`);
    if (speed < SPEED_MIN || speed > SPEED_MAX) {
      throw new Error(`segments[${i}].speed in afara intervalului ${SPEED_MIN}-${SPEED_MAX}`);
    }

    const effect = s.effect === undefined ? 'none' : s.effect;
    if (!EFFECTS.includes(effect)) throw new Error(`segments[${i}].effect necunoscut`);

    const saturation = s.saturation === undefined ? 1 : num(s.saturation, `segments[${i}].saturation`);
    if (saturation < SATURATION_MIN || saturation > SATURATION_MAX) {
      throw new Error(`segments[${i}].saturation in afara intervalului ${SATURATION_MIN}-${SATURATION_MAX}`);
    }

    return { start, end, speed, effect, saturation };
  });

  const sorted = [...parsed].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.start < sorted[i - 1]!.end) throw new Error('segmentele nu se pot suprapune');
  }

  // Umple golurile cu segmente intacte, ca sa acopere toata sursa.
  const full: ResolvedSegment[] = [];
  let cursor = 0;
  for (const seg of sorted) {
    if (seg.start > cursor) {
      full.push({ start: cursor, end: seg.start, speed: 1, effect: 'none', saturation: 1 });
    }
    full.push(seg);
    cursor = seg.end;
  }
  if (cursor < duration) {
    full.push({ start: cursor, end: duration, speed: 1, effect: 'none', saturation: 1 });
  }

  const outDur = outputDuration(full);
  if (outDur > MAX_OUTPUT_S) {
    throw new Error(`durata estimată a ieșirii (${outDur.toFixed(3)}s) depășește ${MAX_OUTPUT_S}s`);
  }
  return full;
}

const fmt = (n: number) => n.toFixed(6);

// Construieste filter_complex. Toate valorile sunt numere validate sau enumerari.
export function buildFilterGraph(segments: ResolvedSegment[]): string {
  const parts: string[] = [];
  segments.forEach((seg, i) => {
    const fx: string[] = [];
    if (seg.effect === 'grayscale') fx.push('hue=s=0');
    if (seg.saturation !== 1) fx.push(`eq=saturation=${fmt(seg.saturation)}`);
    fx.push('format=yuv420p');
    const speedPart = seg.speed === 1 ? '' : `setpts=(PTS-STARTPTS)/${fmt(seg.speed)},`;
    parts.push(
      `[0:v]trim=start=${fmt(seg.start)}:end=${fmt(seg.end)},setpts=PTS-STARTPTS,` +
        `${speedPart}${fx.join(',')}[v${i}]`,
    );
  });
  const labels = segments.map((_, i) => `[v${i}]`).join('');
  parts.push(`${labels}concat=n=${segments.length}:v=1:a=0[vout]`);
  return parts.join(';');
}

// Argumentele ffmpeg: fara sunet, fara suprascriere (-n), iesire noua.
export function buildFfmpegArgs(input: string, output: string, segments: ResolvedSegment[]): string[] {
  return [
    '-hide_banner', '-nostdin', '-n',
    '-i', input,
    '-filter_complex', buildFilterGraph(segments),
    '-map', '[vout]',
    '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-threads', '2',
    output,
  ];
}

export function runFfmpeg(bin: string, args: string[], timeoutMs = 300_000): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) => {
      if (err) reject(new Error(`ffmpeg: ${err.message}\n${String(stderr).slice(-2000)}`));
      else resolve();
    });
  });
}

// Randează ieșirea într-un director nou. Orice eșec șterge directorul (nu rămâne ieșire orfană);
// la succes ieșirea e păstrată pentru upload.
export async function renderEffects(opts: {
  inputPath: string;
  outRoot: string;
  src: { width: number; height: number; duration: number };
  segments: unknown;
  probe: ProbeFn;
  run?: RunFn;
  ffmpegBin?: string;
}): Promise<{ path: string; segments: number; width: number; height: number }> {
  const segs = resolveSegments(opts.segments, opts.src.duration);
  const dir = await mkdtemp(join(opts.outRoot, 'fx-'));
  const out = join(dir, 'out.mp4');
  try {
    await (opts.run ?? runFfmpeg)(opts.ffmpegBin ?? 'ffmpeg', buildFfmpegArgs(opts.inputPath, out, segs));
    const res = await opts.probe(out);
    if (res.width !== opts.src.width || res.height !== opts.src.height) {
      throw new Error('dimensiunile ieșirii diferă de sursă');
    }
    if (res.hasAudio) throw new Error('ieșirea nu trebuie să aibă sunet');
    return { path: out, segments: segs.length, width: res.width, height: res.height };
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
}
