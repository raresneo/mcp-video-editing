// Schemele JSON ale tool-urilor expuse (folosite la tools/list).
export const TOOLS = [
  {
    name: 'concat_clips',
    description: 'Descarcă și lipește clipuri (URL) cu tranziții. Normalizează la aceeași rezoluție/fps/codec înainte de concat. Returnează job_id (poll get_job_status).',
    inputSchema: {
      type: 'object',
      properties: {
        clips: { type: 'array', items: { type: 'string' }, description: 'URL-uri în ordine' },
        transition: { type: 'string', enum: ['none', 'crossfade', 'whip', 'fade'], default: 'none' },
        transition_duration_s: { type: 'number', default: 0.3 },
        output: {
          type: 'object',
          properties: { w: { type: 'number', default: 1080 }, h: { type: 'number', default: 1920 } },
        },
        fps: { type: 'number', default: 30 },
        idempotency_key: { type: 'string' },
      },
      required: ['clips'],
    },
  },
  {
    name: 'add_audio',
    description: 'Mixează muzică de fundal + SFX (whoosh) la timpi exacți peste video. Returnează job_id.',
    inputSchema: {
      type: 'object',
      properties: {
        video_url: { type: 'string' },
        music_url: { type: 'string' },
        sfx: {
          type: 'array',
          items: {
            type: 'object',
            properties: { url: { type: 'string' }, at_seconds: { type: 'number' } },
            required: ['url', 'at_seconds'],
          },
        },
        music_volume: { type: 'number', default: 0.6 },
        duck: { type: 'boolean', default: false },
        idempotency_key: { type: 'string' },
      },
      required: ['video_url'],
    },
  },
  {
    name: 'normalize_for_platform',
    description: 'Detectează image vs video și aplică ramura corectă. IMAGINE -> sharp resize cover + JPEG q90 (rezolvă story negru). VIDEO -> ffmpeg 9:16 H.264+AAC max 60s. NU convertește video în JPEG, NU trece imagine prin ffmpeg. Returnează job_id.',
    inputSchema: {
      type: 'object',
      properties: {
        media_url: { type: 'string' },
        target_format: { type: 'string', enum: ['story', 'reel', 'feed_4_5', 'feed_1_1', 'feed_16_9'] },
        idempotency_key: { type: 'string' },
      },
      required: ['media_url', 'target_format'],
    },
  },
  {
    name: 'trim_clip',
    description: 'Taie un segment din video între start_s și end_s. Returnează job_id.',
    inputSchema: {
      type: 'object',
      properties: {
        video_url: { type: 'string' },
        start_s: { type: 'number' },
        end_s: { type: 'number' },
        idempotency_key: { type: 'string' },
      },
      required: ['video_url', 'start_s', 'end_s'],
    },
  },
  {
    name: 'add_captions',
    description: 'Burn-in text pe video (drawtext), diacritice RO. Stil brand: alb + cuvinte highlighted, sans bold. Returnează job_id.',
    inputSchema: {
      type: 'object',
      properties: {
        video_url: { type: 'string' },
        captions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              start_s: { type: 'number' },
              end_s: { type: 'number' },
              style: { type: 'object' },
            },
            required: ['text', 'start_s', 'end_s'],
          },
        },
        idempotency_key: { type: 'string' },
      },
      required: ['video_url', 'captions'],
    },
  },
  {
    name: 'add_text_overlay_image',
    description: 'Overlay text pe imagine via sharp/SVG (infografice, ex NeoBoost alb+albastru). Diacritice RO corecte. Returnează job_id.',
    inputSchema: {
      type: 'object',
      properties: {
        image_url: { type: 'string' },
        texts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              x: { type: 'number' }, y: { type: 'number' },
              color: { type: 'string' }, highlight_color: { type: 'string' },
              font_size: { type: 'number' },
            },
            required: ['content', 'x', 'y'],
          },
        },
        idempotency_key: { type: 'string' },
      },
      required: ['image_url', 'texts'],
    },
  },
  {
    name: 'get_job_status',
    description: 'Status job: pending/processing/completed/failed + output_url + eroare.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
    },
  },
];
