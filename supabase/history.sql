-- Portfolio Intel: public market history (rolling 5 years in Supabase; the full archive lives in BigQuery).
-- Run once in Supabase: SQL Editor > New query > paste > Run. Safe to run again.

create table if not exists public.hist_trades (
  id          text primary key,            -- stable hash of member, date, type, asset, amount
  chamber     text not null default 'house',
  member      text not null,
  ticker      text,
  asset       text,
  kind        text,
  tx_type     text,
  amount      text,
  amount_low  bigint,
  amount_high bigint,
  traded      date,
  filed       date,
  loaded_at   timestamptz not null default now()
);
create index if not exists hist_trades_ticker on public.hist_trades (ticker, traded);
create index if not exists hist_trades_member on public.hist_trades (member, traded);
create index if not exists hist_trades_traded on public.hist_trades (traded);

create table if not exists public.hist_prices (
  ticker text not null,
  d      date not null,
  close  real not null,
  primary key (ticker, d)
);
create index if not exists hist_prices_d on public.hist_prices (d);

-- Public data: anyone may read, nobody but the server job (service role) may write.
alter table public.hist_trades enable row level security;
alter table public.hist_prices enable row level security;
drop policy if exists "public read" on public.hist_trades;
drop policy if exists "public read" on public.hist_prices;
create policy "public read" on public.hist_trades for select to anon, authenticated using (true);
create policy "public read" on public.hist_prices for select to anon, authenticated using (true);
revoke insert, update, delete on public.hist_trades, public.hist_prices from anon, authenticated;
grant select on public.hist_trades, public.hist_prices to anon, authenticated;

-- Size of the history tables in bytes, for the loader's 450 MB guard.
create or replace function public.hist_size() returns bigint language sql security definer set search_path = '' as $$
  select coalesce(sum(pg_total_relation_size(c.oid)), 0)::bigint
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname in ('hist_trades', 'hist_prices')
$$;
revoke all on function public.hist_size() from public, anon, authenticated;
grant execute on function public.hist_size() to service_role;
-- The server job (service role) writes and prunes the history tables.
grant select, insert, update, delete on public.hist_trades, public.hist_prices to service_role;
