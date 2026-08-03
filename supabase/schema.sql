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

-- ============================================================================
-- TASK 2: AUDIO LIBRARY (Rulează în SQL Editor din Supabase)
-- ============================================================================

-- 1. Creare tabel audio_library
create table if not exists public.audio_library (
  id uuid primary key default gen_random_uuid(),
  brand text,
  mood text,
  duration_s integer,
  has_build boolean,
  url text not null,
  source text default 'lyria',
  license text default 'commercial',
  prompt text,
  created_at timestamptz not null default now()
);

-- RLS dezactivat pe audio_library
alter table public.audio_library disable row level security;

-- 2. Creare bucket audio-library PUBLIC
insert into storage.buckets (id, name, public) 
values ('audio-library', 'audio-library', true) 
on conflict (id) do nothing;

-- 3. Policy-uri pentru bucket (acces public de citire, scriere doar prin service key)
create policy "Audio library is publicly accessible"
  on storage.objects for select
  using ( bucket_id = 'audio-library' );

create policy "Service role can upload to audio library"
  on storage.objects for insert
  with check ( bucket_id = 'audio-library' );
