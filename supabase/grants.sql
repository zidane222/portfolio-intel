-- Portfolio Intel: remove table rights the app roles never use (roadmap 3a, finding F8, Jira KAN-51).
--
-- FOR THE OWNER: run in Supabase: SQL Editor > New query > paste this whole file > Run.
-- Safe to run twice. Not applied automatically.
--
-- What it does:
--   1. Revokes TRUNCATE, TRIGGER and REFERENCES on every table and view in public from anon and authenticated.
--   2. Revokes EXECUTE on public.rls_auto_enable() from public, anon and authenticated. It is the event
--      trigger function behind ensure_rls. Event triggers still run it; nobody can call it by hand.
--   3. Changes the default privileges of role postgres in public so new tables do not get those rights back.
--
-- What it does NOT change: RLS policies, any select, insert, update or delete grant, service_role,
-- or public.ping() (the daily keep-awake step in fetch_trades.yml calls it with the anon key).
--
-- The last statement is a check query. After the file runs it must return no rows.

-- 1. Existing tables and views.
revoke truncate, trigger, references on all tables in schema public from anon, authenticated;

-- 2. rls_auto_enable() exists only on projects where Supabase created it, so guard the revoke.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;

-- 3. Future tables created by postgres (the SQL editor role).
alter default privileges for role postgres in schema public
  revoke truncate, trigger, references on tables from anon, authenticated;

-- Check: every row returned is a right that should not be there. Expect no rows.
select 'table' as kind, c.relname::text as object, r.rolname::text as role, p.priv as privilege
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join (select rolname from pg_roles where rolname in ('anon', 'authenticated')) r
cross join (values ('TRUNCATE'), ('TRIGGER'), ('REFERENCES')) p(priv)
where n.nspname = 'public'
  and c.relkind in ('r', 'v', 'm', 'p', 'f')
  and has_table_privilege(r.rolname, c.oid, p.priv)
union all
select 'function', 'rls_auto_enable()', r.rolname::text, 'EXECUTE'
from (select rolname from pg_roles where rolname in ('anon', 'authenticated')) r
where has_function_privilege(r.rolname, to_regprocedure('public.rls_auto_enable()'), 'EXECUTE')
union all
select 'default', 'tables in public (for role postgres)', pg_get_userbyid(a.grantee)::text, a.privilege_type::text
from pg_default_acl d
join pg_namespace n on n.oid = d.defaclnamespace
cross join lateral aclexplode(d.defaclacl) a
where n.nspname = 'public'
  and d.defaclobjtype = 'r'
  and d.defaclrole = 'postgres'::regrole
  and pg_get_userbyid(a.grantee) in ('anon', 'authenticated')
  and a.privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES')
order by 1, 2, 3, 4;
