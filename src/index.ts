import express from 'express';
import { config } from './config.js';
import { log } from './logger.js';
import { ensureBucket } from './supabase.js';
import { handleRpc } from './mcp/server.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'mcp-video-editing' }));

// Auth opțional prin bearer (CRON_SECRET).
app.use('/api/mcp', (req, res, next) => {
  if (!config.CRON_SECRET) return next();
  const auth = req.header('authorization') ?? '';
  if (auth === `Bearer ${config.CRON_SECRET}`) return next();
  return res.status(401).json({ error: 'unauthorized' });
});

// Endpoint MCP JSON-RPC (HTTP streamable-compatible: acceptă POST cu body JSON-RPC).
app.post('/api/mcp', async (req, res) => {
  const result = await handleRpc(req.body);
  if (result === null) return res.status(202).end(); // notificare
  res.json(result);
});

async function main() {
  await ensureBucket();
  app.listen(config.PORT, () => log.info(`mcp-video-editing on :${config.PORT}`));
}

main().catch((e) => { log.error('boot failed', String(e)); process.exit(1); });
