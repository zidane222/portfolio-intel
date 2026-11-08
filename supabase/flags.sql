-- Portfolio Intel: feature flag audit (docs/runbooks/feature-flags.md).
--
-- FOR THE OWNER: run once in Supabase: SQL Editor > New query > paste this whole file > Run.
-- Safe to run again. Not applied automatically.
--
-- Access model: RLS ON and NO policies; every privilege revoked from anon and authenticated.
-- pi-flags writes through flag_audit_add (SECURITY DEFINER, fixed search_path) with its own
-- Supabase secret key (SUPABASE_FLAGS_KEY in the Cloudflare Secrets Store). scripts/history_load.py
-- reads rows for the BigQuery archive and purges old rows through flag_audit_purge.
-- SUPABASE_FLAGS_KEY is service_role equivalent: it bypasses RLS and can do anything the service key
-- can. It is separate only so it can be rotated and revoked on its own. Follow-up: a custom role that
-- can only execute flag_audit_add.
-- Rows hold the owner's email (actor) and a short reason. No user data.
--
-- Check after running (should return no rows; anon select and rpc should be denied):
--   select * from pg_policies where tablename = 'flag_audit';

create table if not exists public.flag_audit (
  id      uuid primary key,
  at      timestamptz not null,
  flag    text not null check (flag ~ '^[a-z0-9_]{1,40}$'),
  is_on   boolean not null,
  actor   text not null check (char_length(actor) <= 254),
  reason  text not null check (char_length(reason) between 3 and 200),
  v       int not null check (v >= 0)
);
create index if not exists flag_audit_at on public.flag_audit (at);

alter table public.flag_audit enable row level security;
revoke all on table public.flag_audit from public, anon, authenticated;
grant select, insert, delete on table public.flag_audit to service_role;

create or replace function public.flag_audit_add(p_id uuid, p_at timestamptz, p_flag text, p_on boolean, p_actor text, p_reason text, p_v int)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- Size guard shared with the history tables (450 MB): stop audit writes before the project fills up.
  if pg_database_size(current_database()) >= 450 * 1024 * 1024 then
    raise exception 'flag_audit: database over 450 MB, write skipped';
  end if;
  insert into public.flag_audit (id, at, flag, is_on, actor, reason, v)
  values (p_id, p_at, p_flag, p_on, p_actor, p_reason, p_v)
  on conflict (id) do nothing;
end $$;

-- Keep 1 year in Supabase; BigQuery keeps everything (history_load.py runs this after a good merge).
create or replace function public.flag_audit_purge()
returns json language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  delete from public.flag_audit where at < now() - interval '1 year';
  get diagnostics n = row_count;
  return json_build_object('audit', n);
end $$;

revoke all on function public.flag_audit_add(uuid, timestamptz, text, boolean, text, text, int) from public, anon, authenticated;
revoke all on function public.flag_audit_purge() from public, anon, authenticated;
grant execute on function public.flag_audit_add(uuid, timestamptz, text, boolean, text, text, int), public.flag_audit_purge() to service_role;
