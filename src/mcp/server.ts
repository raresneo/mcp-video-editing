import { TOOLS } from './tools.js';
import { enqueue } from '../jobs.js';
import { getJob } from '../supabase.js';
import { downloadToTmp } from '../media/download.js';
import { cleanup } from '../media/cleanup.js';
import { FORMAT_DIMS } from '../config.js';
import { log } from '../logger.js';
import {
  normalizeVideo, concatNormalized, mixAudio, trim,
  drawCaptions, normalizeVideoForPlatform,
} from '../media/ffmpeg.js';
import { normalizeImage, textOverlayImage } from '../media/image.js';
import { generateMusicLyria } from '../media/lyria.js';
import { supabase } from '../supabase.js';

// ---- Handlerele efective (rulează în background prin jobs.enqueue) ----

import { probe } from '../media/ffmpeg.js';

async function hConcat(input: any) {
  const tmp: string[] = [];
  try {
    const w = input.output?.w ?? 1080;
    const h = input.output?.h ?? 1920;
    const fps = input.fps ?? 30;
    const downloaded: string[] = [];
    const probes: any[] = [];
    
    for (const url of input.clips) {
      const dl = await downloadToTmp(url);
      tmp.push(dl.path);
      downloaded.push(dl.path);
      probes.push(await probe(dl.path));
    }
    
    const transition = input.transition ?? 'none';
    const canCopy = transition === 'none' && probes.length > 1 && probes.every((p, i, arr) => {
      // Must match exactly the requested w, h, fps
      if (p.width !== w || p.height !== h || String(p.fps) !== String(fps)) return false;
      if (i === 0) return true;
      return p.videoCodec === arr[0].videoCodec &&
             p.audioCodec === arr[0].audioCodec &&
             p.width === arr[0].width &&
             p.height === arr[0].height &&
             p.fps === arr[0].fps &&
             p.pixFmt === arr[0].pixFmt;
    });

    let finalClips = downloaded;
    
    if (!canCopy) {
      finalClips = [];
      for (const path of downloaded) {
        const n = await normalizeVideo(path, w, h, fps);
        tmp.push(n);
        finalClips.push(n);
      }
    }
    
    const out = await concatNormalized(finalClips, transition, input.transition_duration_s ?? 0.3);
    return { localPath: out, contentType: 'video/mp4', meta: { clips: input.clips.length, w, h, fps, fastPath: canCopy } };
  } finally {
    await cleanup(tmp);
  }
}

async function hAddAudio(input: any) {
  const tmp: string[] = [];
  try {
    const v = await downloadToTmp(input.video_url); tmp.push(v.path);
    let music: string | null = null;
    if (input.music_url) { const m = await downloadToTmp(input.music_url); tmp.push(m.path); music = m.path; }
    
    const sfx: { path: string; at: number }[] = [];
    for (const s of input.sfx ?? []) {
      const d = await downloadToTmp(s.url); tmp.push(d.path);
      sfx.push({ path: d.path, at: s.at_seconds });
    }
    
    // Standard de brand: patul muzical înlocuiește sunetul clipului, nu se adună cu el.
    const muteOriginal = input.mute_original ?? true;

    const out = await mixAudio(v.path, music, sfx, {
      musicVolume: input.music_volume ?? 0.6,
      duck: Boolean(input.duck),
      muteOriginal,
    });
    return {
      localPath: out,
      contentType: 'video/mp4',
      meta: { music: Boolean(music), sfx: sfx.length, muteOriginal },
    };
  } finally { await cleanup(tmp); }
}

async function hNormalize(input: any) {
  const tmp: string[] = [];
  try {
    const dims = FORMAT_DIMS[input.target_format];
    if (!dims) throw new Error(`target_format necunoscut: ${input.target_format}`);
    
    const dl = await downloadToTmp(input.media_url); tmp.push(dl.path);
    
    if (dl.kind === 'image') {
      // IMAGINE: sharp, NU ffmpeg.
      const out = await normalizeImage(dl.path, dims.w, dims.h);
      return { localPath: out, contentType: 'image/jpeg', meta: { branch: 'image', ...dims } };
    }
    
    // VIDEO: ffmpeg, NU sharp.
    const { path, passthrough } = await normalizeVideoForPlatform(dl.path, dims.w, dims.h);
    return { localPath: path, contentType: 'video/mp4', meta: { branch: 'video', passthrough, ...dims } };
  } finally { await cleanup(tmp); }
}

async function hTrim(input: any) {
  const tmp: string[] = [];
  try {
    const dl = await downloadToTmp(input.video_url); tmp.push(dl.path);
    const out = await trim(dl.path, input.start_s, input.end_s);
    return { localPath: out, contentType: 'video/mp4', meta: { start: input.start_s, end: input.end_s } };
  } finally { await cleanup(tmp); }
}

async function hCaptions(input: any) {
  const tmp: string[] = [];
  try {
    const dl = await downloadToTmp(input.video_url); tmp.push(dl.path);
    const caps = input.captions.map((c: any) => ({ text: c.text, start: c.start_s, end: c.end_s, style: c.style }));
    const out = await drawCaptions(dl.path, caps);
    return { localPath: out, contentType: 'video/mp4', meta: { captions: caps.length } };
  } finally { await cleanup(tmp); }
}

async function hOverlay(input: any) {
  const tmp: string[] = [];
  try {
    const dl = await downloadToTmp(input.image_url); tmp.push(dl.path);
    if (dl.kind !== 'image') throw new Error('add_text_overlay_image acceptă doar imagini');
    
    const out = await textOverlayImage(dl.path, input.texts);
    return { localPath: out, contentType: 'image/jpeg', meta: { texts: input.texts.length } };
  } finally { await cleanup(tmp); }
}

async function enqueueMusic(name: string, input: any, key: string | null): Promise<any> {
  const { data, error } = await supabase.from('video_jobs').insert({
    tool: name, input, idempotency_key: key
  }).select('id').single();
  if (error || !data) throw new Error(`DB init job fail: ${error?.message}`);
  const jobId = data.id;

  // Run in background
  (async () => {
    try {
      await supabase.from('video_jobs').update({ status: 'processing' }).eq('id', jobId);
      const { prompt, duration_s = 30, brand, mood, has_build } = input;
      log.info(`generate_music => prompt: ${prompt}`);
      const url = await generateMusicLyria(prompt, duration_s, brand, mood, has_build);
      await supabase.from('video_jobs').update({ status: 'completed', output_url: url }).eq('id', jobId);
    } catch (e: any) {
      log.error('Job error', e.message);
      await supabase.from('video_jobs').update({ status: 'failed', error: e.message }).eq('id', jobId);
    }
  })();
  return { content: [{ type: 'text', text: jobId }] };
}

async function hListAudioLibrary(args: any): Promise<any> {
  const { brand, mood } = args;
  let q = supabase.from('audio_library').select('*').order('created_at', { ascending: false });
  if (brand) q = q.eq('brand', brand);
  if (mood) q = q.eq('mood', mood);
  
  const { data, error } = await q;
  if (error) throw new Error(`DB Error: ${error.message}`);
  
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
  };
}

// Mapare tool -> handler async (toate întorc job_id, mai puțin get_job_status care e sincron).
export async function runTool(name: string, args: any): Promise<any> {
  const key = args?.idempotency_key ?? null;
  switch (name) {
    case 'concat_clips': return enqueue(name, args, key, hConcat);
    case 'add_audio': return enqueue(name, args, key, hAddAudio);
    case 'add_captions': return enqueue(name, args, key, hCaptions);
    case 'trim_video': return enqueue(name, args, key, hTrim);
    case 'normalize_platform': return enqueue(name, args, key, hNormalize);
    case 'add_text_overlay_image': return enqueue(name, args, key, hOverlay);
    case 'generate_music': return enqueueMusic(name, args, key);
    case 'list_audio_library': return hListAudioLibrary(args);
    case 'get_job_status': {
      const job = await getJob(args.job_id);
      if (!job) throw new Error(`job inexistent: ${args.job_id}`);
      return { job_id: job.id, status: job.status, output_url: job.output_url, error: job.error, meta: job.meta };
    }
    default: throw new Error(`tool necunoscut: ${name}`);
  }
}

// ---- JSON-RPC dispatcher ----
export async function handleRpc(body: any): Promise<any> {
  const { id, method, params } = body ?? {};
  const reply = (result: any) => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
  
  try {
    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'mcp-video-editing', version: '1.0.0' },
        });
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const out = await runTool(params.name, params.arguments ?? {});
        return reply({ content: [{ type: 'text', text: JSON.stringify(out) }] });
      }
      case 'notifications/initialized':
        return null; // notificare, fără răspuns
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error('rpc error', method, msg);
    return fail(-32000, msg);
  }
}
