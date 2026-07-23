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

- concat_clips, add_audio, normalize_for_platform, trim_clip, add_captions, add_text_overlay_image, get_job_status.
Toate (mai puțin get_job_status) sunt async: întorc job_id, procesare în background, poll get_job_status.

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

## Fază 2 (nu inclus)

- auto_caption (Whisper: transcript word-level -> burn-in).
- smart_cut (silencedetect + scene detect, opțional vision pass).
