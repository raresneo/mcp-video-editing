import { config } from './config.js';

const SECRETS = [config.SUPABASE_SERVICE_KEY, config.CRON_SECRET].filter(Boolean);

function redact(s: string): string {
  let out = s;
  for (const secret of SECRETS) out = out.split(secret).join('***REDACTED***');
  return out;
}

function fmt(args: unknown[]): string {
  return redact(
    args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' '),
  );
}

export const log = {
  info: (...a: unknown[]) => console.log('[info]', fmt(a)),
  warn: (...a: unknown[]) => console.warn('[warn]', fmt(a)),
  error: (...a: unknown[]) => console.error('[error]', fmt(a)),
};
