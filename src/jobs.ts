import { config } from './config.js';
import { log } from './logger.js';
import { createJob, updateJob, findByIdempotency, type Job } from './supabase.js';
import { runTool } from './mcp/server.js';

// Rezultatul unui handler de tool: path local final + content-type pt upload.
export interface ToolResult {
  localPath: string;
  contentType: string;
  meta?: Record<string, unknown>;
}

export type ToolHandler = (input: any, job: Job) => Promise<ToolResult>;

// Creează job (sau întoarce pe cel existent la idempotency hit), procesează în background.
export async function enqueue(
  tool: string,
  input: any,
  idempotencyKey: string | null,
  handler: ToolHandler,
): Promise<{ job_id: string; status: string; output_url: string | null }> {
  if (idempotencyKey) {
    const existing = await findByIdempotency(idempotencyKey);
    if (existing) {
      log.info('idempotency hit', idempotencyKey, existing.id, existing.status);
      return { job_id: existing.id, status: existing.status, output_url: existing.output_url };
    }
  }
  
  const job = await createJob(tool, input, idempotencyKey);
  
  // fire-and-forget cu timeout
  void process(job, handler);
  
  return { job_id: job.id, status: 'pending', output_url: null };
}

async function process(job: Job, handler: ToolHandler): Promise<void> {
  await updateJob(job.id, { status: 'processing' });
  
  const timeout = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error(`Timeout job > ${config.JOB_TIMEOUT_MS}ms`)), config.JOB_TIMEOUT_MS),
  );
  
  try {
    const { uploadOutput } = await import('./supabase.js');
    const result = await Promise.race([handler(job.input, job), timeout]);
    const url = await uploadOutput(result.localPath, result.contentType);
    
    await updateJob(job.id, { status: 'completed', output_url: url, meta: result.meta ?? null });
    log.info('job completed', job.id, job.tool);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await updateJob(job.id, { status: 'failed', error: msg }); // eroarea ffmpeg completă
    log.error('job failed', job.id, job.tool, msg);
  }
}

export { runTool };
