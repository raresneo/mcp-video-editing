import { z } from 'zod';

const schema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(10),
  SUPABASE_BUCKET: z.string().default('media-out'),
  CRON_SECRET: z.string().optional().default(''),
  PORT: z.coerce.number().default(10000),
  MAX_DOWNLOAD_BYTES: z.coerce.number().default(209_715_200),
  JOB_TIMEOUT_MS: z.coerce.number().default(300_000),
  SIGNED_URL_TTL_S: z.coerce.number().default(604_800),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Nu logăm valorile, doar cheile lipsă/invalide.
  console.error('[config] env invalid:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

// Dimensiuni target per format.
export const FORMAT_DIMS: Record<string, { w: number; h: number }> = {
  story: { w: 1080, h: 1920 },
  reel: { w: 1080, h: 1920 },
  feed_4_5: { w: 1080, h: 1350 },
  feed_1_1: { w: 1080, h: 1080 },
  feed_16_9: { w: 1920, h: 1080 },
};

export const FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
export const FONT_REGULAR = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
export const TMP_DIR = '/tmp';
