# Database grants for the app roles (roadmap 3a, finding F8)

The app's anon key and signed-in users (role authenticated) need only select, insert, update and
delete, and only where RLS allows it. They must not hold TRUNCATE, TRIGGER or REFERENCES on any
table, and must not be able to run public.rls_auto_enable().

## Owner step (after the PR that adds supabase/grants.sql is merged)

1. Apply supabase/grants.sql in the SQL editor: Supabase, SQL Editor, New query, paste the whole file, Run.
2. Then run the check query (the last statement in the file, it runs with step 1). Expect no rows.
   Before the fix it returned 23 rows on 2026-11-14.
3. Open the app and sign in, sync, and open a history chart. All three must work as before.
4. Send the check result (row count) so it can be recorded in docs/compliance/EVIDENCE.md.

If step 3 fails: the file only removes rights the app does not use, so first check the browser
console for the failing request. To undo, grant the removed rights back on the named table, for
example `grant truncate, trigger, references on public.hist_prices to anon, authenticated;`.

## What the file keeps

- RLS policies, and every select, insert, update and delete grant.
- service_role rights.
- public.ping(): the keep-awake step in .github/workflows/fetch_trades.yml calls it daily with the
  anon key. It is SECURITY DEFINER with an empty search_path and returns the constant 'ok'.

## Fresh setup

supabase/schema.sql and supabase/history.sql now carry the same revokes, and schema.sql changes the
default privileges of role postgres so new tables in public do not get the three rights. news.sql
and flags.sql already revoke all rights from anon and authenticated. Run grants.sql last.

## Known limits

- Default privileges are changed only for role postgres (the SQL editor role). Tables created by
  supabase_admin still get Supabase's defaults. Re-run grants.sql after adding tables.
- anon and authenticated also hold MAINTAIN (Postgres 17) on hist_trades and hist_prices, and
  authenticated on synced_data. Out of scope for this change; follow-up.
