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

// Un clip real, de test, public.
const TEST_CLIP = 'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4';

async function main() {
  console.log('init:', (await rpc('initialize', {})).serverInfo);
  const toolsList = (await rpc('tools/list', {})).tools.map((t) => t.name);
  console.log('tools:', toolsList.join(', '));
  
  if (!toolsList.includes('trim_clip')) {
    throw new Error('Serverul nu exporta trim_clip!');
  }
  
  console.log('\n[Acceptance Test] trim_clip');
  console.log(`Tai clip-ul de la secunda 2 la secunda 6...`);
  const c = await callTool('trim_clip', {
    video_url: TEST_CLIP,
    start_s: 2,
    end_s: 6,
    idempotency_key: `test-trim-${Date.now()}`,
  });
  const trimJob = await waitJob(c.job_id);
  console.log('\n✅ SUCCES ->', trimJob.output_url);
}

main().catch((e) => { console.error('\nFAIL:', e.message); process.exit(1); });
