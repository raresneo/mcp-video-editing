const url = process.env.MCP_URL;
const secret = process.env.CRON_SECRET;
if (!url || !secret) {
  console.error("Setează MCP_URL și CRON_SECRET");
  process.exit(1);
}

async function rpc(method, params) {
  const res = await fetch(url + '/api/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + secret },
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
  const res = await rpc('tools/call', { name, arguments: args });
  return res;
}

const TEST_CLIP = 'https://raw.githubusercontent.com/mdn/learning-area/master/html/multimedia-and-embedding/video-and-audio-content/rabbit320.mp4';

async function main() {
  console.log('\n[Acceptance Test] test_grep (drawtext test)');
  const grepOut = await callTool('test_grep', {});
  console.log(grepOut);

  console.log('\n[Acceptance Test] add_captions (drawtext test)');
  const captionsCall = await callTool('add_captions', {
    video_url: TEST_CLIP,
    captions: [
      { text: 'Salut!', start_s: 0, end_s: 2, style: { color: 'white', highlight_color: 'blue', font_size: 54 } },
      { text: 'Ce faci?', start_s: 2, end_s: 4, style: { color: 'yellow', highlight_color: 'red', font_size: 54 } }
    ],
    idempotency_key: `test-captions-${Date.now()}`
  });

  const jobId = captionsCall.content[0].text;
  if (!jobId) throw new Error('Nu s-a returnat job_id');
  
  process.stdout.write('⏳ Aștept procesarea');
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 5000));
    process.stdout.write('.');
    
    const statusOut = await callTool('get_job_status', { job_id: jobId });
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
