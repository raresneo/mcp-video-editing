# mcp-video-editing

MCP server pe Render (Node 20 + TS + Express) pentru editare/normalizare video + imagine via ffmpeg + sharp, cu surse
remote (URL) și persistență Supabase. Produce assets finale pentru mcp-social.

## De ce există

Sandbox-urile AI n-au internet și nu pot procesa clipuri din Higgsfield/Drive. Acest server rulează cu net + ffmpeg complet: descarcă din orice URL public, procesează, întoarce URL final gata de postat.

## Setup local

1. `cp .env.example .env` și completează SUPABASE_URL + SUPABASE_SERVICE_KEY.
2. Rulează `supabase/schema.sql` în SQL Editor din Supabase.
3. `npm install`
4. `npm run dev` (necesită ffmpeg local: `brew install ffmpeg` pe Mac).
5. Test: `MCP_URL=http://localhost:10000 node test-client.mjs` (setează CLIP1/CLIP2/CLIP3/WHOOSH/PNG).

## Deploy Render

1. Push repo pe GitHub.
2. New > Blueprint > selectează repo (citește render.yaml).
3. Setează env secrets: SUPABASE_URL, SUPABASE_SERVICE_KEY, CRON_SECRET.
4. Deploy. Health check: `GET /health`.

## Endpoint MCP

`POST /api/mcp` — JSON-RPC 2.0. Metode: initialize, tools/list, tools/call.
Auth opțional: header `Authorization: Bearer <CRON_SECRET>`.

## Tools

- concat_clips, add_audio, normalize_for_platform, trim_clip, add_captions, auto_caption,
  add_text_overlay_image, generate_music, list_audio_library, get_job_status.
Toate (mai puțin get_job_status și list_audio_library) sunt async: întorc job_id, procesare în background, poll get_job_status.

### auto_caption

Un singur apel face tot lanțul: descarcă video, extrage pista audio (mono 16kHz mp3),
o transcrie cu timestamps, grupează cuvintele în linii scurte și arde subtitrările pe video.

- Transcriere: Whisper `whisper-1` cu `timestamp_granularities=word` dacă există `OPENAI_API_KEY`.
  Fără cheie (sau dacă Whisper crapă) cade automat pe `gemini-2.5-flash` prin Vertex AI,
  cu aceleași credentials folosite deja de `generate_music`.
- Render: generăm un fișier ASS și aplicăm UN singur filtru `ass=`. Varianta cu N filtre
  `drawtext` înlănțuite (folosită de `add_captions`) devine foarte scumpă peste ~20 de segmente.
  Audio-ul e copiat, nu re-encodat.
- Stil: alb bold cu contur negru, uppercase, jos la ~14% din înălțime. `highlight_words`
  colorează cuvintele cheie cu `highlight_color` (default auriu brand `#D4AF37`).
- `dry_run: true` nu randează nimic: întoarce transcriptul + segmentele ca JSON, ca să poți
  corecta textul și apoi să dai `add_captions` cu segmentele tale.

Dacă limita de 25MB a Whisper e depășită, taie clipul cu `trim_clip` întâi.
Clipurile fără pistă audio dau eroare explicită, nu subtitrări inventate.

## Surse remote

`downloadToTmp` rescrie automat linkurile de share în download direct:

- Google Drive `/file/d/ID/view`, `open?id=`, `uc?id=` -> `drive.usercontent.google.com/download?...&confirm=t`
- Dropbox `?dl=0` -> `?dl=1`

Fișierul trebuie să fie public ("Anyone with the link"). Altfel Google întoarce HTML și
primești o eroare explicită, nu un fișier corupt.

## Integrare mcp-social

Output URL-urile sunt publice/semnate și se pasează direct ca media_urls / media_url în publish_social / publish_story.
Folosește ACELAȘI proiect Supabase ca mcp-social pentru flux Higgsfield -> edit -> publish fără pași manuali.

## Reguli respectate

- Idempotency key per request (retry-safe).
- Timeout job 300s, failed cu eroarea ffmpeg completă.
- Nu logăm secretele (service key redactat).
- Normalizare obligatorie înainte de concat.
- Log tip+dimensiune media înainte/după transformare.
- normalize_for_platform: imagine -> sharp, video -> ffmpeg (nu se amestecă).
- Numele tool-urilor din `TOOLS` sunt sursa de adevăr pentru rutarea din `runTool`.

## Fază 2 (nu inclus)

- smart_cut (silencedetect + scene detect, opțional vision pass).
- karaoke word-by-word highlight (avem deja timestamps word-level de la Whisper).
