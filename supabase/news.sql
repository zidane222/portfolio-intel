-- Portfolio Intel: news reads (Phase 3, docs/plans/phase3-news-agents.md section 7).
--
-- FOR THE OWNER: run once in Supabase: SQL Editor > New query > paste this whole file > Run.
-- Safe to run again (every statement is "if not exists" or "create or replace").
-- Run supabase/history.sql first: news_universe() reads public.hist_trades.
--
-- Access model: these tables are private. Row level security is ON and there are NO policies,
-- and every privilege is revoked from anon and authenticated, so the app's anon key cannot read
-- or write anything here. Only the service role (pi-newsdesk Worker and scripts/history_load.py)
-- uses them. The functions are SECURITY DEFINER and only service_role may execute them.
--
-- Check after running (should return no rows and "permission denied" with the anon key):
--   select * from pg_policies where tablename in ('news_verdicts','news_jobs','news_budget');

-- ── Verdicts: batch news reads for the public universe, kept 2 years ─────────────
create table if not exists public.news_verdicts (
  id             uuid primary key,              -- stable hash of ticker, run_date, origin (set by the Worker)
  run_date       date not null,
  created        timestamptz not null,
  ticker         text not null check (ticker ~ '^[A-Z.-]{1,6}$'),
  origin         text not null default 'batch' check (origin = 'batch'),  -- on-demand reads never land here
  mode           text check (mode in ('debate', 'collaborate', 'thin')),
  stance         text check (stance in ('positive', 'negative', 'mixed', 'unclear')),
  confidence     text check (confidence in ('low', 'medium', 'high')),
  status         text not null check (status in ('PASS', 'fallback', 'thin', 'skipped', 'error')),
  groq_calls     int not null default 0,
  tokens         int not null default 0,
  model          text,
  prompt_version text,
  price_ref_date date,
  record         jsonb not null,                -- full pi/news-verdict/v1 record; no user fields
  unique (ticker, run_date, origin)
);
create index if not exists news_verdicts_day on public.news_verdicts (run_date);

-- ── Jobs: one row per ticker per batch day, claimed in small chunks by the cron ──
create table if not exists public.news_jobs (
  run_date   date not null,
  ticker     text not null,
  status     text not null default 'pending'
             check (status in ('pending', 'running', 'ok', 'thin', 'fallback', 'skipped', 'error')),
  attempts   int not null default 0,
  claimed_at timestamptz,
  primary key (run_date, ticker)
);

-- ── Budget: global daily Groq cap shared by batch and on-demand ──────────────────
create table if not exists public.news_budget (
  day         date primary key,
  calls       int not null default 0,
  tokens      int not null default 0,
  batch_calls int not null default 0
);

-- ── 7-day view for the app (served only through pi-newsdesk /reads) ──────────────
create or replace view public.news_reads_7d with (security_invoker = on) as
  select distinct on (ticker, run_date) ticker, run_date, created, record
  from public.news_verdicts
  where run_date >= current_date - 6 and origin = 'batch'
  order by ticker, run_date desc, created desc;

-- ── Lock down: RLS on, no policies, no anon/authenticated privileges ─────────────
alter table public.news_verdicts enable row level security;
alter table public.news_jobs     enable row level security;
alter table public.news_budget   enable row level security;
revoke all on public.news_verdicts, public.news_jobs, public.news_budget, public.news_reads_7d from public, anon, authenticated;
grant select, insert, update, delete on public.news_verdicts, public.news_jobs, public.news_budget to service_role;
grant select on public.news_reads_7d to service_role;

-- ── Functions ────────────────────────────────────────────────────────────────────

-- Top tickers by congressional trade count in the last `days` days.
create or replace function public.news_universe(days int default 30, n int default 20)
returns setof text language sql stable security definer set search_path = public, pg_temp as $$
  select ticker from public.hist_trades
  where traded >= current_date - days and ticker ~ '^[A-Z.-]{1,6}$'
  group by ticker
  order by count(*) desc, ticker
  limit greatest(0, least(n, 50))
$$;

-- Seeds the day's jobs: fixed list first, then the universe, deduped, cap 30.
-- No-op (returns 0) when the day is already seeded. Also deletes jobs older than 14 days.
create or replace function public.news_seed(d date, fixed text[])
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare added int;
begin
  if exists (select 1 from public.news_jobs where run_date = d) then return 0; end if;
  delete from public.news_jobs where run_date < d - 14;
  with u as (
    select upper(t) as t, o from unnest(fixed) with ordinality as f(t, o)
    union all
    select t, 1000 + o from public.news_universe() with ordinality as g(t, o)
  ), k as (
    select t, min(o) as o from u where t ~ '^[A-Z.-]{1,6}$' group by t order by min(o) limit 30
  )
  insert into public.news_jobs (run_date, ticker) select d, t from k
  on conflict do nothing;
  get diagnostics added = row_count;
  return added;
end $$;

-- Claims up to k jobs: pending ones, or running ones stuck over 10 minutes with attempts left.
-- Stuck jobs that used all 3 attempts become 'error'. Safe under concurrent ticks (skip locked).
create or replace function public.news_claim(d date, k int)
returns table (ticker text, attempts int) language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_column
begin
  update public.news_jobs j set status = 'error'
   where j.run_date = d and j.status = 'running' and j.attempts >= 3
     and j.claimed_at < now() - interval '10 minutes';
  return query
  with c as (
    select j.run_date, j.ticker from public.news_jobs j
     where j.run_date = d
       and j.attempts < 3
       and (j.status = 'pending' or (j.status = 'running' and j.claimed_at < now() - interval '10 minutes'))
     order by j.ticker
     limit greatest(0, least(k, 5))
     for update skip locked
  )
  update public.news_jobs j set status = 'running', attempts = j.attempts + 1, claimed_at = now()
    from c where j.run_date = c.run_date and j.ticker = c.ticker
  returning j.ticker, j.attempts;
end $$;

-- Atomically reserves Groq budget. Returns false (and changes nothing) when it would pass a cap.
create or replace function public.news_take(d date, calls int, tokens int, batch boolean,
                                            cap_calls int, cap_tokens int, cap_batch int)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare ok boolean;
begin
  if calls < 0 or tokens < 0 then return false; end if;
  insert into public.news_budget as b (day, calls, tokens, batch_calls)
  select d, calls, tokens, case when batch then calls else 0 end
   where calls <= cap_calls and tokens <= cap_tokens and (not batch or calls <= cap_batch)
     and (batch or calls <= cap_calls - cap_batch)
  on conflict (day) do update
     set calls = b.calls + excluded.calls,
         tokens = b.tokens + excluded.tokens,
         batch_calls = b.batch_calls + excluded.batch_calls
   where b.calls + excluded.calls <= cap_calls
     and b.tokens + excluded.tokens <= cap_tokens
     and (not batch or b.batch_calls + excluded.batch_calls <= cap_batch)
     -- on-demand reads may only use the share not reserved for the batch, so they can't starve it
     and (batch or (b.calls - b.batch_calls) + excluded.calls <= cap_calls - cap_batch)
  returning true into ok;
  return coalesce(ok, false);
end $$;

-- Retention: verdicts over 2 years (already archived in BigQuery), budget rows over 30 days.
create or replace function public.news_purge()
returns json language plpgsql security definer set search_path = public, pg_temp as $$
declare v int; b int;
begin
  delete from public.news_verdicts where run_date < current_date - interval '2 years';
  get diagnostics v = row_count;
  delete from public.news_budget where day < current_date - 30;
  get diagnostics b = row_count;
  return json_build_object('verdicts', v, 'budget', b);
end $$;

revoke all on function public.news_universe(int, int) from public, anon, authenticated;
revoke all on function public.news_seed(date, text[]) from public, anon, authenticated;
revoke all on function public.news_claim(date, int) from public, anon, authenticated;
revoke all on function public.news_take(date, int, int, boolean, int, int, int) from public, anon, authenticated;
revoke all on function public.news_purge() from public, anon, authenticated;
grant execute on function public.news_universe(int, int), public.news_seed(date, text[]), public.news_claim(date, int),
  public.news_take(date, int, int, boolean, int, int, int), public.news_purge() to service_role;
