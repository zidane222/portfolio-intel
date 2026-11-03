-- Phase 5: second AI provider for news reads (docs/plans/phase5-news-dual-provider.md).
-- Run once in Supabase (SQL Editor) BEFORE deploying the Worker change. Safe to run again.
-- The new news_take has p with a default of 'groq', so the running Worker (which sends no p) keeps working.

alter table public.news_verdicts drop constraint if exists news_verdicts_origin_check;
alter table public.news_verdicts add constraint news_verdicts_origin_check check (origin in ('batch', 'shadow'));
alter table public.news_verdicts add column if not exists provider text;  -- null for rows written before phase 5

alter table public.news_budget add column if not exists provider text not null default 'groq';
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.news_budget'::regclass and contype = 'p'
                 and pg_get_constraintdef(oid) like '%(day, provider)%') then
    alter table public.news_budget drop constraint if exists news_budget_pkey;
    alter table public.news_budget add primary key (day, provider);
  end if;
end $$;

create or replace function public.news_take(d date, calls int, tokens int, batch boolean,
                                            cap_calls int, cap_tokens int, cap_batch int, p text default 'groq')
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare ok boolean;
begin
  if calls < 0 or tokens < 0 or p not in ('groq', 'gemini') then return false; end if;
  insert into public.news_budget as b (day, provider, calls, tokens, batch_calls)
  select d, p, calls, tokens, case when batch then calls else 0 end
   where calls <= cap_calls and tokens <= cap_tokens and (not batch or calls <= cap_batch)
     and (batch or calls <= cap_calls - cap_batch)
  on conflict (day, provider) do update
     set calls = b.calls + excluded.calls,
         tokens = b.tokens + excluded.tokens,
         batch_calls = b.batch_calls + excluded.batch_calls
   where b.calls + excluded.calls <= cap_calls
     and b.tokens + excluded.tokens <= cap_tokens
     and (not batch or b.batch_calls + excluded.batch_calls <= cap_batch)
     and (batch or (b.calls - b.batch_calls) + excluded.calls <= cap_calls - cap_batch)
  returning true into ok;
  return coalesce(ok, false);
end $$;

revoke all on function public.news_take(date, int, int, boolean, int, int, int, text) from public, anon, authenticated;
grant execute on function public.news_take(date, int, int, boolean, int, int, int, text) to service_role;
-- The old 7-argument signature would make calls without p ambiguous, so it goes. The new one answers them.
drop function if exists public.news_take(date, int, int, boolean, int, int, int);
