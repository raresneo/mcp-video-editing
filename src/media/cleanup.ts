import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { log } from '../logger.js';

export async function cleanup(paths: string[]): Promise<void> {
  const dirs = new Set<string>();
  for (const p of paths) {
    if (!p) continue;
    dirs.add(dirname(p));
  }
  for (const d of dirs) {
    try {
      await rm(d, { recursive: true, force: true });
    } catch (e) {
      log.warn('cleanup failed', d, String(e));
    }
  }
}
