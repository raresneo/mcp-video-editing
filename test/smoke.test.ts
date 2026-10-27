import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { renderEffects, runFfmpeg, outputDuration, resolveSegments } from '../src/media/effects.js';

// Rulează doar dacă FFMPEG_FIXTURE indică un MP4 real (ex. sursa de 15.042s). Nu rulează în CI implicit.
const fixture = process.env.FFMPEG_FIXTURE;
const run = promisify(execFile);

async function probe(path: string) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height:format=duration', '-of', 'json', path]);
  const j = JSON.parse(stdout);
  const { stdout: a } = await run('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', path]);
  return {
    width: j.streams[0].width as number,
    height: j.streams[0].height as number,
    duration: Number(j.format.duration),
    hasAudio: a.trim().length > 0,
  };
}

test('smoke: real render matches expected duration within one frame, no audio, source untouched',
  { skip: fixture ? false : 'FFMPEG_FIXTURE nesetat' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'fx-smoke-'));
    const before = createHash('sha256').update(await readFile(fixture!)).digest('hex');
    const plan = [
      { start: 0, end: 3, effect: 'grayscale' as const, speed: 0.8 },
      { start: 3, end: 11 },
      { start: 11, end: 15.042, speed: 0.8 },
    ];
    const src = await probe(fixture!);
    const res = await renderEffects({ inputPath: fixture!, outRoot: root, src, segments: plan, probe, run: (b, a) => runFfmpeg(b, a) });
    const out = await probe(res.path);
    const expected = outputDuration(resolveSegments(plan, src.duration));
    assert.ok(Math.abs(out.duration - expected) <= 1 / 24 + 0.001, `duration ${out.duration} vs ${expected}`);
    assert.equal(out.hasAudio, false);
    assert.equal(out.width, src.width);
    assert.equal(out.height, src.height);
    await stat(res.path);
    const after = createHash('sha256').update(await readFile(fixture!)).digest('hex');
    assert.equal(after, before);
  });
