-- Production hardening for lifetime retention and operational controls.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('vault-raw', 'vault-raw', false, null, null),
  ('vault-processed', 'vault-processed', false, null, null)
on conflict (id) do update set public = false;

create table if not exists public.retention_holds (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  vault_object_id uuid references public.vault_objects(id) on delete cascade,
  hold_reason text not null,
  hold_forever boolean not null default true,
  created_at timestamptz not null default now(),
  released_at timestamptz,
  check (hold_forever or released_at is not null)
);

alter table public.retention_holds enable row level security;

create policy "owner can manage retention holds"
on public.retention_holds
for all
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create or replace function public.reject_retained_vault_object_delete()
returns trigger
language plpgsql
as $$
begin
  if old.retained_forever then
    raise exception 'vault object is retained forever and cannot be deleted through the API';
  end if;
  return old;
end;
$$;

create trigger reject_retained_vault_object_delete
before delete on public.vault_objects
for each row execute function public.reject_retained_vault_object_delete();

create or replace function public.reject_import_run_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'import run records are retained for auditability';
end;
$$;

create trigger reject_import_run_delete
before delete on public.import_runs
for each row execute function public.reject_import_run_delete();

create or replace function public.prevent_public_ai_without_explicit_policy()
returns trigger
language plpgsql
as $$
begin
  if new.provider_label <> 'local' and coalesce((new.policy ->> 'allow_public_ai')::boolean, false) is not true then
    raise exception 'non-local AI jobs require policy.allow_public_ai=true';
  end if;
  return new;
end;
$$;

create trigger prevent_public_ai_without_explicit_policy_insert
before insert on public.ai_jobs
for each row execute function public.prevent_public_ai_without_explicit_policy();

create trigger prevent_public_ai_without_explicit_policy_update
before update on public.ai_jobs
for each row execute function public.prevent_public_ai_without_explicit_policy();

create index if not exists retention_holds_owner_object_idx on public.retention_holds(owner_id, vault_object_id);
