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
  let json;
  try {
    json = await res.json();
  } catch (e) {
    const txt = await res.text();
    throw new Error(`JSON parse failed. Status: ${res.status}. Body: ${txt}`);
  }
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

// Un clip real, de test, public.
const TEST_CLIP = 'https://raw.githubusercontent.com/mdn/learning-area/master/html/multimedia-and-embedding/video-and-audio-content/rabbit320.mp4';

async function main() {
  console.log('init:', (await rpc('initialize', {})).serverInfo);
  const toolsList = (await rpc('tools/list', {})).tools.map((t) => t.name);
  console.log('tools:', toolsList.join(', '));
  
  if (!toolsList.includes('concat_clips')) {
    throw new Error('Serverul nu exporta concat_clips!');
  }
  
  console.log('\n[Acceptance Test] concat_clips (fast path stream copy)');
  const c = await callTool('concat_clips', {
    clips: [TEST_CLIP, TEST_CLIP, TEST_CLIP],
    transition: 'none',
    transition_duration_s: 0,
    output: { w: 1080, h: 1920 },
    fps: 30,
    idempotency_key: `test-concat-fast-${Date.now()}`,
  });
  
  process.stdout.write('⏳ Aștept procesarea...');
  const concatJob = await waitJob(c.job_id);
  console.log('\n✅ SUCCES ->', concatJob.output_url);
}

main().catch((e) => { console.error('\nFAIL:', e.message); process.exit(1); });
