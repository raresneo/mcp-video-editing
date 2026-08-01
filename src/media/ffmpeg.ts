import ffmpegPath from 'ffmpeg-static';
import Ffmpeg from 'fluent-ffmpeg';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { FONT_BOLD, TMP_DIR } from '../config.js';
import { log } from '../logger.js';

if (ffmpegPath) Ffmpeg.setFfmpegPath(ffmpegPath as unknown as string);
// ffprobe din PATH (instalat via apt în Docker):
Ffmpeg.setFfprobePath('/usr/bin/ffprobe');

export interface Probe {
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

export function probe(path: string): Promise<Probe> {
  return new Promise((resolve, reject) => {
    Ffmpeg.ffprobe(path, (err, data) => {
      if (err) return reject(new Error(`ffprobe: ${err.message}`));
      const v = data.streams.find((s) => s.codec_type === 'video');
      const a = data.streams.find((s) => s.codec_type === 'audio');
      resolve({
        duration: Number(data.format.duration ?? 0),
        width: Number(v?.width ?? 0),
        height: Number(v?.height ?? 0),
        hasAudio: Boolean(a),
      });
    });
  });
}

async function outPath(ext = '.mp4'): Promise<string> {
  const dir = await mkdtemp(join(TMP_DIR, 'out-'));
  return join(dir, `out${ext}`);
}

function run(cmd: Ffmpeg.FfmpegCommand, out: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    cmd
      .on('stderr', (line) => (stderr += line + '\n'))
      .on('error', (err) => reject(new Error(`ffmpeg: ${err.message}\n---\n${stderr}`)))
      .on('end', () => resolve(out))
      .save(out);
  });
}

// Normalizează un video la w/h/fps, H.264+AAC, cover+crop (fără bare negre).
export async function normalizeVideo(
  input: string,
  w: number,
  h: number,
  fps: number,
): Promise<string> {
  const out = await outPath('.mp4');
  const vf =
    `scale=${w}:${h}:force_original_aspect_ratio=increase,` +
    `crop=${w}:${h},fps=${fps},format=yuv420p,setsar=1`;
  const cmd = Ffmpeg(input)
    .videoFilters(vf)
    .videoCodec('libx264')
    .outputOptions(['-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart', '-threads', '2'])
    .audioCodec('aac')
    .audioFrequency(48000)
    .audioChannels(2);
  return run(cmd, out);
}

const XFADE: Record<string, { t: string; d: number }> = {
  none: { t: 'fade', d: 0 },
  fade: { t: 'fade', d: 0.3 },
  crossfade: { t: 'fade', d: 0.3 },
  whip: { t: 'wiperight', d: 0.2 },
};

// Lipește clipuri deja normalizate. Cu tranziții => xfade + acrossfade.
export async function concatNormalized(
  clips: string[],
  transition: string,
  transitionDur: number,
): Promise<string> {
  const out = await outPath('.mp4');

  if (transition === 'none' || clips.length === 1) {
    // concat filter simplu (clipurile sunt deja identice ca format)
    const cmd = Ffmpeg();
    clips.forEach((c) => cmd.input(c));
    const n = clips.length;
    const streams = clips.map((_, i) => `[${i}:v][${i}:a]`).join('');
    cmd.complexFilter([`${streams}concat=n=${n}:v=1:a=1[v][a]`]);
    cmd.outputOptions(['-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-c:a', 'aac',
      '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart', '-threads', '2']);
    return run(cmd, out);
  }

  const preset = XFADE[transition] ?? XFADE.crossfade;
  const dur = transitionDur || preset!.d;

  const durations: number[] = [];
  for (const c of clips) durations.push((await probe(c)).duration);

  const cmd = Ffmpeg();
  clips.forEach((c) => cmd.input(c));

  const filters: string[] = [];
  let lastV = '0:v';
  let lastA = '0:a';
  let cumulative = durations[0]!;

  for (let i = 1; i < clips.length; i++) {
    const offset = Math.max(0, cumulative - dur);
    const vOut = `v${i}`;
    const aOut = `a${i}`;
    filters.push(
      `[${lastV}][${i}:v]xfade=transition=${preset!.t}:duration=${dur}:offset=${offset.toFixed(3)}[${vOut}]`,
    );
    filters.push(`[${lastA}][${i}:a]acrossfade=d=${dur}[${aOut}]`);
    lastV = vOut;
    lastA = aOut;
    cumulative = cumulative + durations[i]! - dur;
  }

  cmd.complexFilter(filters, [lastV, lastA]);
  cmd.outputOptions([
    '-map', `[${lastV}]`, '-map', `[${lastA}]`,
    '-c:v', 'libx264', '-c:a', 'aac',
    '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart', '-threads', '2',
  ]);
  return run(cmd, out);
}

// Muzică de fundal + SFX la timpi exacți peste audio-ul original.
export async function mixAudio(
  video: string,
  music: string | null,
  sfx: { path: string; at: number }[],
  musicVolume: number,
  duck: boolean,
): Promise<string> {
  const out = await outPath('.mp4');
  const cmd = Ffmpeg(video);
  let idx = 1;

  const musicIdx = music ? idx++ : -1;
  if (music) cmd.input(music);

  const sfxIdx: number[] = [];
  for (const s of sfx) { cmd.input(s.path); sfxIdx.push(idx++); }

  const filters: string[] = [];
  const mixLabels: string[] = [];

  if (music && duck) {
    // [0:a] nu poate fi refolosit în filtergraph: îl spargem cu asplit.
    // O copie intră în mix, cealaltă e sidechain key pentru duck.
    filters.push(`[0:a]asplit=2[a0mix][a0key]`);
    mixLabels.push('[a0mix]');
    filters.push(`[${musicIdx}:a]aloop=loop=-1:size=2e9,volume=${musicVolume}[mus]`);
    filters.push(`[mus][a0key]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=250[musd]`);
    mixLabels.push('[musd]');
  } else {
    mixLabels.push('[0:a]');
    if (music) {
      filters.push(`[${musicIdx}:a]aloop=loop=-1:size=2e9,volume=${musicVolume}[mus]`);
      mixLabels.push('[mus]');
    }
  }

  sfx.forEach((s, k) => {
    const ms = Math.round(s.at * 1000);
    filters.push(`[${sfxIdx[k]}:a]adelay=${ms}|${ms}[sfx${k}]`);
    mixLabels.push(`[sfx${k}]`);
  });

  const n = mixLabels.length;
  filters.push(`${mixLabels.join('')}amix=inputs=${n}:duration=first:dropout_transition=0[aout]`);

  cmd.complexFilter(filters, ['aout']);
  cmd.outputOptions([
    '-map', '0:v', '-map', '[aout]',
    '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-movflags', '+faststart',
  ]);

  return run(cmd, out);
}

export async function trim(input: string, start: number, end: number): Promise<string> {
  const out = await outPath('.mp4');
  const cmd = Ffmpeg(input)
    .setStartTime(start)
    .duration(Math.max(0.05, end - start))
    .videoCodec('libx264')
    .audioCodec('aac')
    .outputOptions(['-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart', '-threads', '2']);
  return run(cmd, out);
}

// escape pentru drawtext
function esc(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\u2019")
    .replace(/%/g, '\\%');
}

// Burn-in captions. Fiecare caption apare între start_s și end_s.
// style: { color, highlight } — highlight = box color (cuvinte evidențiate).
export async function drawCaptions(
  input: string,
  captions: { text: string; start: number; end: number; style?: any }[],
): Promise<string> {
  const out = await outPath('.mp4');
  const filters = captions.map((c) => {
    const color = c.style?.color ?? 'white';
    const box = c.style?.highlight_color ?? c.style?.highlight;
    const fontsize = c.style?.font_size ?? 54;
    const boxPart = box
      ? `:box=1:boxcolor=${box}@0.9:boxborderw=18`
      : `:borderw=3:bordercolor=black@0.8`;

    return (
      `drawtext=fontfile=${FONT_BOLD}:text='${esc(c.text)}':` +
      `fontsize=${fontsize}:fontcolor=${color}:` +
      `x=(w-text_w)/2:y=h-h/4${boxPart}:` +
      `enable='between(t,${c.start},${c.end})'`
    );
  });

  const cmd = Ffmpeg(input)
    .videoFilters(filters)
    .videoCodec('libx264')
    .audioCodec('aac')
    .outputOptions(['-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart', '-threads', '2']);
  return run(cmd, out);
}

// Normalizează video la format target (cover+crop), max 60s.
export async function normalizeVideoForPlatform(
  input: string,
  w: number,
  h: number,
): Promise<{ path: string; passthrough: boolean }> {
  const p = await probe(input);
  const conform = p.width === w && p.height === h && p.duration <= 60;
  if (conform) {
    log.info('normalize video: pass-through', JSON.stringify(p));
    return { path: input, passthrough: true };
  }

  const out = await outPath('.mp4');
  const vf =
    `scale=${w}:${h}:force_original_aspect_ratio=increase,` +
    `crop=${w}:${h},format=yuv420p,setsar=1`;
  const cmd = Ffmpeg(input)
    .videoFilters(vf)
    .duration(60)
    .videoCodec('libx264')
    .audioCodec('aac')
    .outputOptions(['-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart', '-threads', '2']);
  return { path: await run(cmd, out), passthrough: false };
}
