const url = process.env.MCP_URL || 'http://localhost:10000';
const secret = process.env.CRON_SECRET || ''; // opțional la test local, depinde de setări

async function rpc(method, params) {
  const headers = { 'Content-Type': 'application/json' };
  if (secret) headers['Authorization'] = 'Bearer ' + secret;
  
  const res = await fetch(url + '/api/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    if (json.error) throw new Error(json.error.message);
    return json.result;
  } catch (e) {
    throw new Error(`Invalid JSON / Error: ${text}`);
  }
}

async function callTool(name, args) {
  return await rpc('tools/call', { name, arguments: args });
}

const TEST_CLIP = 'https://raw.githubusercontent.com/mdn/learning-area/master/html/multimedia-and-embedding/video-and-audio-content/rabbit320.mp4';
const TEST_IMAGE = 'https://raw.githubusercontent.com/github/explore/80688e429a7d4ef2fca1e82350fe8e3517d3494d/topics/javascript/javascript.png';
const TEST_SFX = 'https://www.soundjay.com/buttons/sounds/button-10.mp3';

async function main() {
  console.log('\n[1] Apel auto_caption cu dry_run=true (preluare json)...');
  const dryRunOut = await callTool('auto_caption', {
    video_url: TEST_CLIP,
    dry_run: true,
    idempotency_key: `dryrun-${Date.now()}`
  });
  
  console.log('Rezultat Dry Run:');
  console.log(dryRunOut.content[0].text);

  console.log('\n[2] Apel auto_caption complet (randare)...');
  const fullCall = await callTool('auto_caption', {
    video_url: TEST_CLIP,
    elements: [
      { type: 'image', url: TEST_IMAGE, start_s: 0, end_s: 3, x: 50, y: 50 },
      { type: 'sfx', url: TEST_SFX, start_s: 0.5 }
    ],
    idempotency_key: `fullrun-${Date.now()}`
  });

  const parsed = JSON.parse(fullCall.content[0].text);
  const jobId = parsed.job_id || parsed; // format poate fi string direct sau { job_id: "..." }
  const actualJobId = typeof jobId === 'string' ? jobId : jobId.job_id;
  
  if (!actualJobId) throw new Error('Nu s-a returnat job_id valid');
  
  process.stdout.write(`⏳ Aștept procesarea jobului ${actualJobId}`);
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 5000));
    process.stdout.write('.');
    
    const statusOut = await callTool('get_job_status', { job_id: actualJobId });
    const state = JSON.parse(statusOut.content[0].text);
    
    if (state.status === 'completed') {
      console.log(`\n✅ SUCCES -> ${state.output_url}`);
      return;
    }
    if (state.status === 'failed') {
      console.log(`\n❌ FAIL: job failed: ${state.error}`);
      return;
    }
  }
  console.log('\n❌ FAIL: Timeout la poll');
}

main().catch(console.error);
