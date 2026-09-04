import ffmpegPath from 'ffmpeg-static';
import Ffmpeg from 'fluent-ffmpeg';
import { mkdtemp, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FONT_BOLD, TMP_DIR } from '../config.js';
import { log } from '../logger.js';

// Folosim executabilele din sistem (instalate via apt în Docker)
// pentru că ffmpeg-static nu are suport pentru libfreetype (drawtext).
Ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');
Ffmpeg.setFfprobePath('/usr/bin/ffprobe');

export interface Probe {
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  videoCodec?: string;
  audioCodec?: string;
  fps?: string;
  pixFmt?: string;
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
        videoCodec: v?.codec_name,
        audioCodec: a?.codec_name,
        fps: v?.r_frame_rate || v?.avg_frame_rate,
        pixFmt: v?.pix_fmt,
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

function getOutputOptions(duration: number): string[] {
  if (duration <= 60) {
    return ['-preset', 'veryfast', '-crf', '20', '-maxrate', '8000k', '-bufsize', '16000k', '-movflags', '+faststart', '-threads', '2'];
  }
  const maxrate = Math.floor(360000 / duration);
  return ['-preset', 'veryfast', '-crf', '24', '-maxrate', `${maxrate}k`, '-bufsize', `${maxrate * 2}k`, '-movflags', '+faststart', '-threads', '2'];
}

// Normalizează un video la w/h/fps, H.264+AAC, cover+crop (fără bare negre).
export async function normalizeVideo(
  input: string,
  w: number,
  h: number,
  fps: number,
): Promise<string> {
  const p = await probe(input);
  const out = await outPath('.mp4');
  const vf =
    `scale=${w}:${h}:force_original_aspect_ratio=increase,` +
    `crop=${w}:${h},fps=${fps},format=yuv420p,setsar=1`;
  const cmd = Ffmpeg(input)
    .videoFilters(vf)
    .videoCodec('libx264')
    .outputOptions(getOutputOptions(p.duration))
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

  const probes: Probe[] = [];
  for (const c of clips) probes.push(await probe(c));

  const canCopy = transition === 'none' && probes.length > 1 && probes.every((p, i, arr) => {
    if (i === 0) return true;
    return p.videoCodec === arr[0]!.videoCodec &&
           p.audioCodec === arr[0]!.audioCodec &&
           p.width === arr[0]!.width &&
           p.height === arr[0]!.height &&
           p.fps === arr[0]!.fps &&
           p.pixFmt === arr[0]!.pixFmt;
  });

  if (canCopy) {
    log.info('concat: using fast path (stream copy)');
    const listTxt = await outPath('.txt');
    const localClips = await Promise.all(clips.map(async (c, i) => {
      if (c.startsWith('http')) {
        const dest = await outPath(`.clip${i}.mp4`);
        const res = await fetch(c, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`Failed to download ${c}`);
        const arr = await res.arrayBuffer();
        await writeFile(dest, Buffer.from(arr));
        return dest;
      }
      return c;
    }));
    const content = localClips.map(c => `file '${c.replace(/'/g, "'\\''")}'`).join('\n');
    await writeFile(listTxt, content);
    
    const cmd = Ffmpeg()
      .input(listTxt)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c', 'copy', '-y']);
    return run(cmd, out);
  }

  log.info('concat: fallback to sequential re-encode');
  
  const preset = XFADE[transition] ?? XFADE.crossfade;
  const dur = transition === 'none' ? 0 : (transitionDur || preset!.d);
  const isXfade = transition !== 'none';
  const tType = preset!.t;

  let currentFile = clips[0]!;
  let cumulative = probes[0]!.duration;

  for (let i = 1; i < clips.length; i++) {
    const nextFile = clips[i]!;
    const nextDur = probes[i]!.duration;
    const outTmp = await outPath('.mp4');
    const cCmd = Ffmpeg();
    cCmd.input(currentFile).input(nextFile);

    const totalDuration = isXfade ? cumulative + nextDur - dur : cumulative + nextDur;

    if (isXfade) {
      const offset = Math.max(0, cumulative - dur);
      cCmd.complexFilter([
        `[0:v][1:v]xfade=transition=${tType}:duration=${dur}:offset=${offset.toFixed(3)}[v]`,
        `[0:a][1:a]acrossfade=d=${dur}[a]`
      ], ['v', 'a']);
    } else {
      cCmd.complexFilter([
        `[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]`
      ], ['v', 'a']);
    }

    cCmd.outputOptions([
      '-c:v', 'libx264', '-c:a', 'aac',
      ...getOutputOptions(totalDuration)
    ]);
    
    currentFile = await run(cCmd, outTmp);
    cumulative = totalDuration;
  }

  await copyFile(currentFile, out);
  return out;
}

const AFMT = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';

// Muzică de fundal + SFX la timpi exacți peste audio-ul original.
export async function mixAudio(
  video: string,
  music: string | null,
  sfx: { path: string; at: number }[],
  musicVolume: number,
  duck: boolean,
): Promise<string> {
  const out = await outPath('.mp4');
  const p = await probe(video);
  const cmd = Ffmpeg(video);
  let idx = 1;

  const musicIdx = music ? idx++ : -1;
  if (music) cmd.input(music);

  const sfxIdx: number[] = [];
  for (const s of sfx) { cmd.input(s.path); sfxIdx.push(idx++); }

  const filters: string[] = [];
  const mixLabels: string[] = [];

  // Baza de mix. Dacă videoul n-are pistă audio, [0:a] nu există:
  // generăm liniște pe durata clipului, altfel ffmpeg crapă.
  if (p.hasAudio) {
    filters.push(`[0:a]${AFMT}[abase]`);
  } else {
    const d = Math.max(0.1, p.duration || 0.1).toFixed(3);
    filters.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${d}[abase]`);
  }

  if (music && duck) {
    // [abase] nu poate fi refolosit în filtergraph: îl spargem cu asplit.
    // O copie intră în mix, cealaltă e sidechain key pentru duck.
    filters.push(`[abase]asplit=2[a0mix][a0key]`);
    mixLabels.push('[a0mix]');
    filters.push(`[${musicIdx}:a]${AFMT},aloop=loop=-1:size=2e9,volume=${musicVolume}[mus]`);
    filters.push(`[mus][a0key]sidechaincompress=threshold=0.05:ratio=8:attack=5:release=250[musd]`);
    mixLabels.push('[musd]');
  } else {
    mixLabels.push('[abase]');
    if (music) {
      filters.push(`[${musicIdx}:a]${AFMT},aloop=loop=-1:size=2e9,volume=${musicVolume}[mus]`);
      mixLabels.push('[mus]');
    }
  }

  sfx.forEach((s, k) => {
    const ms = Math.round(s.at * 1000);
    filters.push(`[${sfxIdx[k]}:a]${AFMT},adelay=${ms}|${ms}[sfx${k}]`);
    mixLabels.push(`[sfx${k}]`);
  });

  const n = mixLabels.length;
  // normalize=0: altfel amix împarte volumul fiecărui input la n
  // și music_volume cerut nu mai înseamnă nimic.
  filters.push(
    `${mixLabels.join('')}amix=inputs=${n}:duration=first:dropout_transition=0:normalize=0[aout]`,
  );

  // ATENȚIE: nu pasăm output labels la complexFilter. fluent-ffmpeg ar adăuga
  // singur -map [aout], iar noi îl avem deja explicit mai jos => label folosit
  // de două ori și ffmpeg refuză filtergraph-ul.
  cmd.complexFilter(filters);
  cmd.outputOptions([
    '-map', '0:v', '-map', '[aout]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart',
  ]);

  return run(cmd, out);
}

export async function trim(input: string, start: number, end: number): Promise<string> {
  const out = await outPath('.mp4');
  const duration = Math.max(0.05, end - start);
  const cmd = Ffmpeg(input)
    .setStartTime(start)
    .duration(duration)
    .videoCodec('libx264')
    .audioCodec('aac')
    .outputOptions(getOutputOptions(duration));
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

// Rupe textul în linii care intră în lățimea cadrului.
// Lățimea medie a unui caracter la font bold ≈ 0.55 * fontsize.
function wrapText(text: string, fontsize: number, frameW: number): string[] {
  const usable = frameW * 0.9;
  const maxChars = Math.max(8, Math.floor(usable / (fontsize * 0.55)));
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = w;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [text];
}

// Burn-in captions. Fiecare caption apare între start_s și end_s.
// style: { color, highlight_color, font_size } — highlight = box color.
export async function drawCaptions(
  input: string,
  captions: { text: string; start: number; end: number; style?: any }[],
): Promise<string> {
  const out = await outPath('.mp4');
  const p = await probe(input);
  const frameW = p.width || 1080;

  const filters: string[] = [];

  for (const c of captions) {
    const color = c.style?.color ?? 'white';
    const box = c.style?.highlight_color ?? c.style?.highlight;
    // font_size e dat pentru un cadru de referință de 1080px lățime;
    // scalăm ca textul să arate la fel pe 720p sau 1080p.
    const requested = c.style?.font_size ?? 54;
    const fontsize = Math.max(14, Math.round(requested * (frameW / 1080)));
    const boxPart = box
      ? `:box=1:boxcolor=${box}@0.9:boxborderw=18`
      : `:borderw=${Math.max(2, Math.round(fontsize / 12))}:bordercolor=black@0.85:shadowcolor=black@0.6:shadowx=2:shadowy=2`;

    const lines = wrapText(c.text, fontsize, frameW);
    const lineH = Math.round(fontsize * 1.35);

    lines.forEach((line, i) => {
      // Bloc centrat pe același baseline ca înainte (h - h/4).
      const offset = Math.round(i * lineH - ((lines.length - 1) * lineH) / 2);
      const sign = offset >= 0 ? '+' : '-';
      filters.push(
        `drawtext=fontfile=${FONT_BOLD}:text='${esc(line)}':` +
        `fontsize=${fontsize}:fontcolor=${color}:` +
        `x=(w-text_w)/2:y=h-h/4${sign}${Math.abs(offset)}${boxPart}:` +
        `enable='between(t,${c.start},${c.end})'`,
      );
    });
  }

  const cmd = Ffmpeg(input)
    .videoFilters(filters)
    .videoCodec('libx264')
    .audioCodec('aac')
    .outputOptions(getOutputOptions(p.duration));
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
    .outputOptions(getOutputOptions(Math.min(60, p.duration)));
  return { path: await run(cmd, out), passthrough: false };
}
