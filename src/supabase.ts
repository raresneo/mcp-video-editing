import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';
import { log } from './logger.js';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';

export const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

export async function ensureBucket(): Promise<void> {
  const { data } = await supabase.storage.listBuckets();
  const exists = data?.some((b) => b.name === config.SUPABASE_BUCKET);
  if (!exists) {
    const { error } = await supabase.storage.createBucket(config.SUPABASE_BUCKET, {
      public: true,
    });
    if (error) throw new Error(`createBucket failed: ${error.message}`);
    log.info('created bucket', config.SUPABASE_BUCKET);
  }
}

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface Job {
  id: string;
  tool: string;
  status: JobStatus;
  idempotency_key: string | null;
  input: unknown;
  output_url: string | null;
  error: string | null;
  meta: unknown;
}

export async function findByIdempotency(key: string): Promise<Job | null> {
  const { data } = await supabase
    .from('video_jobs')
    .select('*')
    .eq('idempotency_key', key)
    .maybeSingle();
  return (data as Job) ?? null;
}

export async function createJob(
  tool: string,
  input: unknown,
  idempotencyKey: string | null,
): Promise<Job> {
  const { data, error } = await supabase
    .from('video_jobs')
    .insert({ tool, input, idempotency_key: idempotencyKey, status: 'pending' })
    .select('*')
    .single();
  if (error) throw new Error(`createJob failed: ${error.message}`);
  return data as Job;
}

export async function updateJob(id: string, patch: Partial<Job>): Promise<void> {
  const { error } = await supabase
    .from('video_jobs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) log.error('updateJob failed', error.message);
}

export async function getJob(id: string): Promise<Job | null> {
  const { data } = await supabase.from('video_jobs').select('*').eq('id', id).maybeSingle();
  return (data as Job) ?? null;
}

// Adaugă ?download=<nume> ca browserul să salveze fișierul în loc să încerce
// să-l streameze (și ca numele descărcat să fie citibil, nu "out.mp4").
function withDownload(url: string, filename: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set('download', filename);
    return u.toString();
  } catch {
    return url;
  }
}

async function isBucketPublic(): Promise<boolean> {
  const { data } = await supabase.storage.listBuckets();
  return Boolean(data?.find((b) => b.name === config.SUPABASE_BUCKET)?.public);
}

export async function uploadOutput(localPath: string, contentType: string): Promise<string> {
  const key = `${Date.now()}-${basename(localPath)}`;
  const stream = createReadStream(localPath);
  const { error } = await supabase.storage
    .from(config.SUPABASE_BUCKET)
    .upload(key, stream, { contentType, upsert: false, duplex: 'half' });
  
  if (error) throw new Error(`upload failed: ${error.message}`);

  // Bucket public => link scurt, stabil, fără token care expiră sau se rupe la paste.
  if (await isBucketPublic()) {
    const publicUrl = supabase.storage.from(config.SUPABASE_BUCKET).getPublicUrl(key).data.publicUrl;
    return withDownload(publicUrl, key);
  }

  if (config.SIGNED_URL_TTL_S > 0) {
    const { data, error: sErr } = await supabase.storage
      .from(config.SUPABASE_BUCKET)
      .createSignedUrl(key, config.SIGNED_URL_TTL_S);
    if (sErr) throw new Error(`signed url failed: ${sErr.message}`);
    return withDownload(data.signedUrl, key);
  }
  
  const publicUrl = supabase.storage.from(config.SUPABASE_BUCKET).getPublicUrl(key).data.publicUrl;
  return withDownload(publicUrl, key);
}

export async function recoverStuckJobs(): Promise<void> {
  const { error } = await supabase
    .from('video_jobs')
    .update({ status: 'failed', error: 'Server restarted unexpectedly during processing' })
    .eq('status', 'processing');
  if (error) log.error('recoverStuckJobs failed', error.message);
  else log.info('Recovered any stuck processing jobs');
}
