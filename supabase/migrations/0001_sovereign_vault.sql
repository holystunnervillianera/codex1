-- Sovereign Vault baseline schema for Supabase.
-- Apply from the Supabase SQL editor or Supabase CLI.

create extension if not exists pgcrypto;

create type public.vault_object_status as enum ('imported', 'processing', 'processed', 'quarantined', 'archived');
create type public.import_run_status as enum ('started', 'completed', 'failed');
create type public.ai_job_status as enum ('queued', 'running', 'completed', 'failed', 'cancelled');

create table public.import_sources (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  source_kind text not null check (source_kind in ('local_folder', 'proton_drive_sync', 'proton_mail_export', 'proton_bridge_export', 'manual_upload', 'api_drop')),
  schedule_minutes integer not null check (schedule_minutes in (5, 10)),
  encrypted_config jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, label)
);

create table public.import_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  import_source_id uuid references public.import_sources(id) on delete set null,
  status public.import_run_status not null default 'started',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  files_seen integer not null default 0,
  files_imported integer not null default 0,
  error_message text
);

create table public.vault_objects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  import_run_id uuid references public.import_runs(id) on delete set null,
  parent_object_id uuid references public.vault_objects(id) on delete set null,
  original_name text not null,
  object_path text not null,
  bucket_name text not null default 'vault-raw',
  mime_type text,
  byte_size bigint not null check (byte_size >= 0),
  plaintext_sha256 text not null check (plaintext_sha256 ~ '^[a-f0-9]{64}$'),
  ciphertext_sha256 text not null check (ciphertext_sha256 ~ '^[a-f0-9]{64}$'),
  encryption jsonb not null,
  status public.vault_object_status not null default 'imported',
  tags text[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  retained_forever boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, plaintext_sha256)
);

create table public.ai_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  input_object_id uuid not null references public.vault_objects(id) on delete cascade,
  output_object_id uuid references public.vault_objects(id) on delete set null,
  job_type text not null check (job_type in ('ocr', 'classify', 'summarize', 'dedupe', 'transcode', 'metadata_extract', 'cleanup', 'upgrade')),
  provider_label text not null default 'local',
  status public.ai_job_status not null default 'queued',
  policy jsonb not null default jsonb_build_object('allow_public_ai', false),
  result jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  event_time timestamptz not null default now(),
  actor text not null default 'owner',
  action text not null,
  subject_type text not null,
  subject_id uuid,
  details jsonb not null default '{}'::jsonb,
  previous_event_hash text check (previous_event_hash is null or previous_event_hash ~ '^[a-f0-9]{64}$'),
  event_hash text not null check (event_hash ~ '^[a-f0-9]{64}$'),
  local_sequence bigint generated always as identity,
  unique (owner_id, event_hash)
);

create table public.audit_anchors (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  from_event_hash text not null check (from_event_hash ~ '^[a-f0-9]{64}$'),
  to_event_hash text not null check (to_event_hash ~ '^[a-f0-9]{64}$'),
  merkle_root text not null check (merkle_root ~ '^[a-f0-9]{64}$'),
  chain text not null,
  transaction_id text not null,
  anchored_at timestamptz not null default now(),
  notes text
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_import_sources_updated_at
before update on public.import_sources
for each row execute function public.set_updated_at();

create trigger set_vault_objects_updated_at
before update on public.vault_objects
for each row execute function public.set_updated_at();

create or replace function public.reject_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit records are append-only';
end;
$$;

create trigger reject_audit_events_update
before update on public.audit_events
for each row execute function public.reject_audit_mutation();

create trigger reject_audit_events_delete
before delete on public.audit_events
for each row execute function public.reject_audit_mutation();

create trigger reject_audit_anchors_update
before update on public.audit_anchors
for each row execute function public.reject_audit_mutation();

create trigger reject_audit_anchors_delete
before delete on public.audit_anchors
for each row execute function public.reject_audit_mutation();

alter table public.import_sources enable row level security;
alter table public.import_runs enable row level security;
alter table public.vault_objects enable row level security;
alter table public.ai_jobs enable row level security;
alter table public.audit_events enable row level security;
alter table public.audit_anchors enable row level security;

create policy "owner can manage import sources"
on public.import_sources
for all
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy "owner can manage import runs"
on public.import_runs
for all
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy "owner can manage vault objects"
on public.vault_objects
for all
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy "owner can manage ai jobs"
on public.ai_jobs
for all
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy "owner can insert audit events"
on public.audit_events
for insert
to authenticated
with check (owner_id = auth.uid());

create policy "owner can read audit events"
on public.audit_events
for select
to authenticated
using (owner_id = auth.uid());

create policy "owner can insert audit anchors"
on public.audit_anchors
for insert
to authenticated
with check (owner_id = auth.uid());

create policy "owner can read audit anchors"
on public.audit_anchors
for select
to authenticated
using (owner_id = auth.uid());

create policy "owner can read private vault storage"
on storage.objects
for select
to authenticated
using (
  bucket_id in ('vault-raw', 'vault-processed')
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "owner can upload private vault storage"
on storage.objects
for insert
to authenticated
with check (
  bucket_id in ('vault-raw', 'vault-processed')
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "owner can update private vault storage metadata"
on storage.objects
for update
to authenticated
using (
  bucket_id in ('vault-raw', 'vault-processed')
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id in ('vault-raw', 'vault-processed')
  and (storage.foldername(name))[1] = auth.uid()::text
);

create index vault_objects_owner_created_idx on public.vault_objects(owner_id, created_at desc);
create index vault_objects_owner_hash_idx on public.vault_objects(owner_id, plaintext_sha256);
create index ai_jobs_owner_status_idx on public.ai_jobs(owner_id, status, created_at);
create index audit_events_owner_sequence_idx on public.audit_events(owner_id, local_sequence);
create index audit_events_owner_time_idx on public.audit_events(owner_id, event_time desc);
