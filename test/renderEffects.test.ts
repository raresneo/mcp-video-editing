import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderEffects } from '../src/media/effects.js';

const SRC = { width: 1080, height: 1920, duration: 16.8 };
const PLAN = [{ start: 0, end: 3, effect: 'grayscale' as const }];

async function emptyRoot() {
  return mkdtemp(join(tmpdir(), 'fx-test-'));
}

test('a failing ffmpeg run leaves no output directory behind', async () => {
  const root = await emptyRoot();
  await assert.rejects(renderEffects({
    inputPath: '/tmp/in.mp4', outRoot: root, src: SRC, segments: PLAN,
    run: async () => { throw new Error('ffmpeg boom'); },
    probe: async () => { throw new Error('should not probe'); },
  }), /ffmpeg boom/);
  assert.deepEqual(await readdir(root), []);
});

test('a failing probe of the output removes the output', async () => {
  const root = await emptyRoot();
  await assert.rejects(renderEffects({
    inputPath: '/tmp/in.mp4', outRoot: root, src: SRC, segments: PLAN,
    run: async (_b, args) => { await writeFile(args[args.length - 1]!, 'x'); },
    probe: async () => { throw new Error('probe failed'); },
  }), /probe failed/);
  assert.deepEqual(await readdir(root), []);
});

test('a dimension mismatch or audio in the output is rejected and cleaned up', async () => {
  const root = await emptyRoot();
  const run = async (_b: string, args: string[]) => { await writeFile(args[args.length - 1]!, 'x'); };
  await assert.rejects(renderEffects({
    inputPath: '/tmp/in.mp4', outRoot: root, src: SRC, segments: PLAN, run,
    probe: async () => ({ width: 720, height: 1280, duration: 16.8, hasAudio: false }),
  }), /dimensiunile/);
  await assert.rejects(renderEffects({
    inputPath: '/tmp/in.mp4', outRoot: root, src: SRC, segments: PLAN, run,
    probe: async () => ({ width: 1080, height: 1920, duration: 16.8, hasAudio: true }),
  }), /sunet/);
  assert.deepEqual(await readdir(root), []);
});

test('invalid segments fail before any directory is created', async () => {
  const root = await emptyRoot();
  await assert.rejects(renderEffects({
    inputPath: '/tmp/in.mp4', outRoot: root, src: SRC, segments: [{ start: 5, end: 2 }],
    probe: async () => { throw new Error('no'); },
  }));
  assert.deepEqual(await readdir(root), []);
});

test('a successful render keeps the output for upload and reports the result', async () => {
  const root = await emptyRoot();
  await mkdir(root, { recursive: true });
  const res = await renderEffects({
    inputPath: '/tmp/in.mp4', outRoot: root, src: SRC, segments: PLAN,
    run: async (_b, args) => { await writeFile(args[args.length - 1]!, 'x'); },
    probe: async () => ({ width: 1080, height: 1920, duration: 16.8, hasAudio: false }),
  });
  assert.equal(res.width, 1080);
  assert.equal(res.height, 1920);
  assert.equal(res.segments, 2);
  const kept = await readdir(join(res.path, '..'));
  assert.deepEqual(kept, ['out.mp4']);
});

test('a truncated output (duration off by more than 0.1s) is rejected and cleaned up', async () => {
  const root = await emptyRoot();
  const run = async (_b: string, args: string[]) => { await writeFile(args[args.length - 1]!, 'x'); };
  await assert.rejects(renderEffects({
    inputPath: '/tmp/in.mp4', outRoot: root, src: SRC, segments: PLAN, run,
    probe: async () => ({ width: 1080, height: 1920, duration: 5, hasAudio: false }),
  }), /diferă de cea așteptată/);
  await assert.rejects(renderEffects({
    inputPath: '/tmp/in.mp4', outRoot: root, src: SRC, segments: PLAN, run,
    probe: async () => ({ width: 1080, height: 1920, duration: 16.95, hasAudio: false }),
  }), /diferă/);
  assert.deepEqual(await readdir(root), []);
});

test('a duration within 0.1s of the expected value passes', async () => {
  const root = await emptyRoot();
  const res = await renderEffects({
    inputPath: '/tmp/in.mp4', outRoot: root, src: SRC, segments: PLAN,
    run: async (_b, args) => { await writeFile(args[args.length - 1]!, 'x'); },
    probe: async () => ({ width: 1080, height: 1920, duration: 16.85, hasAudio: false }),
  });
  assert.equal(res.segments, 2);
});
