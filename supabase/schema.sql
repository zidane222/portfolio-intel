-- Portfolio Intel: synced_data table (not related to Supabase Vault). Run once in Supabase: SQL Editor > New query > paste > Run.
-- Each row holds ONE user's data, encrypted on their device before upload (Supabase can't read it).

create table if not exists public.synced_data (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  enc_salt   text not null,          -- salt for the passcode key (not secret)
  payload    text not null,          -- AES-GCM ciphertext of the user's holdings, history, cash, watchlist
  updated_at timestamptz not null default now()
);

-- Row level security: a signed-in user can only ever see or change their own row.
alter table public.synced_data enable row level security;

drop policy if exists "own row: read" on public.synced_data;
drop policy if exists "own row: insert" on public.synced_data;
drop policy if exists "own row: update" on public.synced_data;
drop policy if exists "own row: delete" on public.synced_data;
create policy "own row: read"   on public.synced_data for select to authenticated using (user_id = auth.uid());
create policy "own row: insert" on public.synced_data for insert to authenticated with check (user_id = auth.uid());
create policy "own row: update" on public.synced_data for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own row: delete" on public.synced_data for delete to authenticated using (user_id = auth.uid());

-- Only signed-in users may use the table; anonymous visitors get nothing.
revoke all on public.synced_data from anon;
grant select, insert, update, delete on public.synced_data to authenticated;

-- Keep payloads a sane size (about 2 MB).
alter table public.synced_data drop constraint if exists payload_size;
alter table public.synced_data add constraint payload_size check (length(payload) < 2000000);

-- Keep-awake: a tiny function the daily job calls so the free project never pauses.
create or replace function public.ping() returns text language sql security definer set search_path = '' as $$ select 'ok' $$;
revoke all on function public.ping() from public;
grant execute on function public.ping() to anon;
