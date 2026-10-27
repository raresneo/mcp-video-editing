import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSegments, buildFilterGraph, buildFfmpegArgs, MAX_SEGMENTS } from '../src/media/effects.js';

const DUR = 16.8;

test('gaps are filled with untouched segments that cover the whole source', () => {
  const segs = resolveSegments([{ start: 3, end: 11 }], DUR);
  assert.equal(segs.length, 3);
  assert.deepEqual(segs[0], { start: 0, end: 3, speed: 1, effect: 'none', saturation: 1 });
  assert.equal(segs[2]!.end, DUR);
});

test('the reference plan resolves with defaults and full coverage', () => {
  const segs = resolveSegments([
    { start: 0, end: 3, effect: 'grayscale', speed: 0.8 },
    { start: 3, end: 11, saturation: 1.0 },
    { start: 11, end: 15.042, saturation: 0.8 },
  ], DUR);
  assert.equal(segs.length, 4);
  assert.equal(segs[0]!.effect, 'grayscale');
  assert.equal(segs[3]!.start, 15.042);
  assert.equal(segs[3]!.end, DUR);
});

test('segments are sorted by source time before validation', () => {
  const segs = resolveSegments([{ start: 5, end: 6 }, { start: 1, end: 2 }], DUR);
  assert.equal(segs[1]!.start, 1);
  assert.equal(segs[3]!.start, 5);
});

test('invalid inputs are rejected', () => {
  const bad: unknown[] = [
    [],
    'nope',
    [{ start: 0, end: 20 }],
    [{ start: 3, end: 3 }],
    [{ start: 4, end: 2 }],
    [{ start: 0, end: 5 }, { start: 4, end: 6 }],
    [{ start: 0, end: 2, speed: 0.1 }],
    [{ start: 0, end: 2, speed: 3 }],
    [{ start: 0, end: 2, speed: Infinity }],
    [{ start: NaN, end: 2 }],
    [{ start: '0', end: 2 }],
    [{ start: -1, end: 2 }],
    [{ start: 0, end: 2, effect: 'sepia' }],
    [{ start: 0, end: 2, saturation: -1 }],
    [{ start: 0, end: 2, saturation: 3 }],
    Array.from({ length: MAX_SEGMENTS + 1 }, (_, i) => ({ start: i * 0.5, end: i * 0.5 + 0.4 })),
  ];
  for (const plan of bad) {
    assert.throws(() => resolveSegments(plan, DUR));
  }
});

test('a non-finite or zero duration is rejected', () => {
  assert.throws(() => resolveSegments([{ start: 0, end: 1 }], 0));
  assert.throws(() => resolveSegments([{ start: 0, end: 1 }], NaN));
});

test('the filter graph contains speed, grayscale and a concat of every segment', () => {
  const segs = resolveSegments([{ start: 0, end: 3, effect: 'grayscale', speed: 0.8 }], DUR);
  const g = buildFilterGraph(segs);
  assert.match(g, /hue=s=0/);
  assert.match(g, /setpts=\(PTS-STARTPTS\)\/0\.800000/);
  assert.match(g, /concat=n=2:v=1:a=0\[vout\]$/);
});

test('ffmpeg args are an array with no audio, no overwrite and no shell', () => {
  const segs = resolveSegments([{ start: 0, end: 3 }], DUR);
  const args = buildFfmpegArgs('/tmp/in.mp4', '/tmp/out.mp4', segs);
  assert.ok(args.includes('-an'));
  assert.ok(args.includes('-n'));
  assert.equal(args[args.indexOf('-i') + 1], '/tmp/in.mp4');
  assert.equal(args[args.length - 1], '/tmp/out.mp4');
  assert.ok(args.every((a) => typeof a === 'string'));
});
