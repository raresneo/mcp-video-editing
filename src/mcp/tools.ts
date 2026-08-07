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
    description: 'Burn-in text pe video (drawtext), diacritice RO. Stil brand: alb + cuvinte highlighted, sans bold. Primește segmentele gata făcute; pentru transcriere automată folosește auto_caption. Returnează job_id.',
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
    name: 'auto_caption',
    description: 'Auto-caption complet într-un singur apel: extrage pista audio, o transcrie cu timestamps (Whisper word-level dacă există OPENAI_API_KEY, altfel Gemini) și arde subtitrările pe video în stil brand, cu diacritice RO. Acceptă și linkuri de share Google Drive. meta conține transcriptul și segmentele folosite. Returnează job_id (poll get_job_status).',
    inputSchema: {
      type: 'object',
      properties: {
        video_url: { type: 'string' },
        language: { type: 'string', description: 'ISO 639-1, ex "ro". Omis => auto-detect.' },
        max_words_per_line: { type: 'number', default: 4 },
        max_chars_per_line: { type: 'number', default: 28 },
        uppercase: { type: 'boolean', default: true },
        position: { type: 'string', enum: ['bottom', 'center', 'top'], default: 'bottom' },
        font_size: { type: 'number', description: 'Px. Default ~4.5% din înălțimea video.' },
        color: { type: 'string', default: '#FFFFFF' },
        highlight_color: { type: 'string', default: '#D4AF37' },
        highlight_words: {
          type: 'array',
          items: { type: 'string' },
          description: 'Cuvinte colorate cu highlight_color.',
        },
        dry_run: {
          type: 'boolean',
          default: false,
          description: 'Nu randează: întoarce doar transcriptul + segmentele ca JSON, ca să poți corecta textul înainte.',
        },
        idempotency_key: { type: 'string' },
      },
      required: ['video_url'],
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
  {
    name: 'generate_music',
    description: 'Generează o piesă audio de fundal folosind Google Lyria 3 Pro. Returnează job_id.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Descrierea piesei' },
        duration_s: { type: 'number', description: 'Durata în secunde. Default 30.' },
        brand: { type: 'string', description: 'fya | neoboost | bmh | fia' },
        mood: { type: 'string', description: 'ambient | ritmic | energic | calm' },
        has_build: { type: 'boolean', description: 'Dacă are crescendo la final (reveal)' },
        idempotency_key: { type: 'string' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'list_audio_library',
    description: 'Returnează piesele audio salvate în library.',
    inputSchema: {
      type: 'object',
      properties: {
        brand: { type: 'string' },
        mood: { type: 'string' }
      }
    }
  }
];
