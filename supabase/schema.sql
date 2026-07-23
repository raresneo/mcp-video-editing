-- Tabela de joburi. Rulează în SQL Editor din Supabase.
create table if not exists public.video_jobs (
  id uuid primary key default gen_random_uuid(),
  tool text not null,
  status text not null default 'pending', -- pending | processing | completed | failed
  idempotency_key text,
  input jsonb not null,
  output_url text,
  error text,
  meta jsonb,                             -- tip+dimensiune media înainte/după
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotency: același key => același job (evită reprocesare la retry).
create unique index if not exists video_jobs_idempotency_key_uidx
  on public.video_jobs (idempotency_key)
  where idempotency_key is not null;

create index if not exists video_jobs_status_idx on public.video_jobs (status);
