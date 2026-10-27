import { execFile } from 'node:child_process';

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
const EFFECTS: readonly Effect[] = ['none', 'grayscale'];

function num(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${field} trebuie sa fie numar finit`);
  }
  return v;
}

// Valideaza planul si umple golurile cu segmente intacte (speed 1, fara efect).
export function resolveSegments(input: unknown, duration: number): ResolvedSegment[] {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('durata sursei nu e valida');
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
