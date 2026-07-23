// Test end-to-end contra serverului pornit local (npm run dev) sau pe Render.
// Rulează: MCP_URL=http://localhost:10000 CRON_SECRET=... node test-client.mjs

const BASE = process.env.MCP_URL ?? 'http://localhost:10000';
const SECRET = process.env.CRON_SECRET ?? '';

const headers = { 'content-type': 'application/json' };
if (SECRET) headers.authorization = `Bearer ${SECRET}`;

let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(`${BASE}/api/mcp`, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

async function callTool(name, args) {
  const r = await rpc('tools/call', { name, arguments: args });
  return JSON.parse(r.content[0].text);
}

async function waitJob(jobId) {
  for (let i = 0; i < 120; i++) {
    const s = await callTool('get_job_status', { job_id: jobId });
    if (s.status === 'completed') return s;
    if (s.status === 'failed') throw new Error(`job failed: ${s.error}`);
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error('timeout poll');
}

// URL-uri demo (înlocuiește cu ale tale din Higgsfield/Drive).
const CLIP1 = process.env.CLIP1 ?? 'https://example.com/clip1.mp4';
const CLIP2 = process.env.CLIP2 ?? 'https://example.com/clip2.mp4';
const CLIP3 = process.env.CLIP3 ?? 'https://example.com/clip3.mp4';
const WHOOSH = process.env.WHOOSH ?? 'https://example.com/whoosh.mp3';
const PNG = process.env.PNG ?? 'https://example.com/story.png';

async function main() {
  console.log('init:', (await rpc('initialize', {})).serverInfo);
  console.log('tools:', (await rpc('tools/list', {})).tools.map((t) => t.name).join(', '));
  
  // (1) Lipește 3 clipuri cu whip transition.
  console.log('\n[1] concat_clips (whip)');
  const c = await callTool('concat_clips', {
    clips: [CLIP1, CLIP2, CLIP3],
    transition: 'whip',
    transition_duration_s: 0.2,
    output: { w: 1080, h: 1920 }, fps: 30,
    idempotency_key: 'demo-concat-1',
  });
  const concatJob = await waitJob(c.job_id);
  console.log('\n->', concatJob.output_url);
  
  // (2) Adaugă whoosh pe fiecare tranziție (~la joncțiuni).
  console.log('\n[2] add_audio (whoosh pe tranziții)');
  const a = await callTool('add_audio', {
    video_url: concatJob.output_url,
    sfx: [
      { url: WHOOSH, at_seconds: 2.8 },
      { url: WHOOSH, at_seconds: 5.6 },
    ],
    music_volume: 0.6,
    idempotency_key: 'demo-audio-1',
  });
  const audioJob = await waitJob(a.job_id);
  console.log('\n->', audioJob.output_url);
  
  // (3) Normalizează PNG -> JPEG story 1080x1920 (rezolvă story negru).
  console.log('\n[3] normalize_for_platform (PNG -> story)');
  const n = await callTool('normalize_for_platform', {
    media_url: PNG,
    target_format: 'story',
    idempotency_key: 'demo-norm-1',
  });
  const normJob = await waitJob(n.job_id);
  console.log('\n->', normJob.output_url, normJob.meta);
  
  console.log('\nDONE. Pasează aceste URL-uri în mcp-social publish_social / publish_story.');
}

main().catch((e) => { console.error('\nFAIL:', e.message); process.exit(1); });
