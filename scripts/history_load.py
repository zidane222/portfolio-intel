"""Load Congress trades and daily prices into the history stores.

  Supabase  - rolling 5 years, read by the app. Writes stop at 450 MB.
  BigQuery  - full archive, never pruned. Writes stop at 9 GB.
  News verdicts (pi-newsdesk, supabase/news.sql) - last 3 days copied from Supabase to BigQuery
            news_verdicts (MERGE on id); then Supabase rows over 2 years are purged.

Either store is skipped if its settings are missing, so this is safe to run anywhere.

Env:
  SUPABASE_URL, SUPABASE_SERVICE_KEY      (service role key; server only, never in the app)
  BQ_PROJECT [, BQ_DATASET=portfolio_intel] and Google credentials (GOOGLE_APPLICATION_CREDENTIALS)

Usage:
  python3 scripts/history_load.py --trades trades.json [more.json ...] --prices recent|5y|none
"""
import argparse, datetime, hashlib, json, os, re, sys, time
from concurrent.futures import ThreadPoolExecutor
import requests

KEEP_YEARS = 5
SUPABASE_LIMIT = 450 * 1024 * 1024
BIGQUERY_LIMIT = 9 * 1024 * 1024 * 1024
UA = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'}


def notice(msg):
    print(f'::notice::{msg}' if os.environ.get('GITHUB_ACTIONS') else msg, flush=True)


def warn(msg):
    print(f'::warning::{msg}' if os.environ.get('GITHUB_ACTIONS') else 'WARNING ' + msg, flush=True)


# ── Normalize ───────────────────────────────────────────
def money(s):
    return int(s.replace(',', '')) if s else None


def amount_bounds(a):
    a = a or ''
    m = re.search(r'\$([\d,]+)\s*-\s*\$([\d,]+)', a)
    if m:
        return money(m.group(1)), money(m.group(2))
    m = re.search(r'Over \$([\d,]+)', a)
    return (money(m.group(1)), None) if m else (None, None)


def iso(d):
    return d if isinstance(d, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', d) else None


def trade_row(t):
    member = (t.get('representative') or '').strip()
    ticker = (t.get('ticker') or '').strip().upper() or None
    asset = (t.get('description') or '').strip()[:120] or None
    amount = (t.get('amount') or '').strip() or None
    traded = iso(t.get('date'))
    if not member or not traded:
        return None
    key = '|'.join([t.get('source') or 'house', member, traded, t.get('type') or '', ticker or (asset or '').lower(), amount or ''])
    lo, hi = amount_bounds(amount)
    return {
        'id': hashlib.sha1(key.encode()).hexdigest(),
        'chamber': t.get('source') or 'house',
        'member': member, 'ticker': ticker, 'asset': asset, 'kind': t.get('kind'),
        'tx_type': t.get('type'), 'amount': amount, 'amount_low': lo, 'amount_high': hi,
        'traded': traded, 'filed': iso(t.get('filed')),
    }


def load_trades(paths):
    rows = {}
    for p in paths:
        with open(p) as f:
            d = json.load(f)
        for t in (d.get('trades', []) if isinstance(d, dict) else d):
            r = trade_row(t)
            if r:
                rows[r['id']] = r
    return list(rows.values())


# ── Prices (Yahoo daily closes) ─────────────────────────
def fetch_prices(ticker, rng):
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?range={rng}&interval=1d'
    for attempt in range(3):
        try:
            r = requests.get(url, headers=UA, timeout=15)
            if r.status_code == 429:
                time.sleep(2 + attempt * 3)
                continue
            if r.status_code != 200:
                return []
            res = (r.json().get('chart', {}).get('result') or [{}])[0]
            closes = ((res.get('indicators', {}).get('quote') or [{}])[0].get('close')) or []
            return [{'ticker': ticker, 'd': datetime.datetime.utcfromtimestamp(ts).strftime('%Y-%m-%d'), 'close': round(c, 4)}
                    for ts, c in zip(res.get('timestamp') or [], closes) if c is not None]
        except Exception:
            time.sleep(1)
    return []


def load_prices(tickers, rng):
    out = []
    with ThreadPoolExecutor(max_workers=6) as pool:
        for rows in pool.map(lambda t: fetch_prices(t, rng), sorted(tickers)):
            out.extend(rows)
    return out


# ── Supabase (rolling 5 years) ──────────────────────────
class Supabase:
    def __init__(self, url, key):
        self.url = url.rstrip('/').removesuffix('/rest/v1')
        self.h = {'apikey': key, 'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'}

    def size(self):
        r = requests.post(f'{self.url}/rest/v1/rpc/hist_size', headers=self.h, json={}, timeout=30)
        r.raise_for_status()
        return int(r.json() or 0)

    def upsert(self, table, rows, conflict):
        for i in range(0, len(rows), 500):
            r = requests.post(f'{self.url}/rest/v1/{table}?on_conflict={conflict}',
                              headers={**self.h, 'Prefer': 'resolution=merge-duplicates,return=minimal'},
                              data=json.dumps(rows[i:i + 500]), timeout=60)
            if r.status_code >= 300:
                raise RuntimeError(f'{table} upsert failed: {r.status_code} {r.text[:200]}')

    def clear_chamber(self, chamber):
        r = requests.delete(f'{self.url}/rest/v1/hist_trades?chamber=eq.{chamber}', headers={**self.h, 'Prefer': 'return=minimal'}, timeout=120)
        if r.status_code >= 300:
            raise RuntimeError(f'clearing {chamber} failed: {r.status_code} {r.text[:150]}')

    def prune(self, cutoff):
        for table, col in (('hist_trades', 'traded'), ('hist_prices', 'd')):
            r = requests.delete(f'{self.url}/rest/v1/{table}?{col}=lt.{cutoff}', headers={**self.h, 'Prefer': 'return=minimal'}, timeout=120)
            if r.status_code >= 300:
                warn(f'Supabase prune of {table} failed: {r.status_code} {r.text[:150]}')


REPLACE = []  # chambers to clear before loading (set by --replace-chamber)


def to_supabase(trades, prices):
    url, key = os.environ.get('SUPABASE_URL', '').strip(), os.environ.get('SUPABASE_SERVICE_KEY', '').strip()
    if not url or not key:
        warn('Supabase history: not configured, skipped')
        return
    sb = Supabase(url, key)
    cutoff = (datetime.date.today() - datetime.timedelta(days=365 * KEEP_YEARS)).isoformat()
    for c in REPLACE:
        sb.clear_chamber(c)
        notice(f'Supabase history: cleared old {c} rows before reloading')
    sb.prune(cutoff)  # drop rows older than 5 years first (they stay in BigQuery)
    used = sb.size()
    if used >= SUPABASE_LIMIT:
        warn(f'Supabase history is at {used / 1e6:.0f} MB (limit 450 MB). Writes skipped; switch reads to BigQuery.')
        return
    t = [r for r in trades if r['traded'] >= cutoff]
    p = [r for r in prices if r['d'] >= cutoff]
    sb.upsert('hist_trades', t, 'id')
    sb.upsert('hist_prices', p, 'ticker,d')
    notice(f'Supabase history: {len(t)} trades and {len(p)} prices written; {sb.size() / 1e6:.1f} MB used of 450 MB')


# ── BigQuery (full archive) ─────────────────────────────
TRADE_SCHEMA = [('id', 'STRING', 'REQUIRED'), ('chamber', 'STRING', 'NULLABLE'), ('member', 'STRING', 'REQUIRED'),
                ('ticker', 'STRING', 'NULLABLE'), ('asset', 'STRING', 'NULLABLE'), ('kind', 'STRING', 'NULLABLE'),
                ('tx_type', 'STRING', 'NULLABLE'), ('amount', 'STRING', 'NULLABLE'), ('amount_low', 'INT64', 'NULLABLE'),
                ('amount_high', 'INT64', 'NULLABLE'), ('traded', 'DATE', 'NULLABLE'), ('filed', 'DATE', 'NULLABLE')]
PRICE_SCHEMA = [('ticker', 'STRING', 'REQUIRED'), ('d', 'DATE', 'REQUIRED'), ('close', 'FLOAT64', 'REQUIRED')]


def bq_dataset():
    """BigQuery client and dataset id with the sandbox expiry removed, or (None, None) when not configured."""
    project = os.environ.get('BQ_PROJECT', '').strip()
    if not project:
        return None, None
    from google.cloud import bigquery
    client = bigquery.Client(project=project)
    ds_id = f"{project}.{os.environ.get('BQ_DATASET', 'portfolio_intel')}"
    ds = client.create_dataset(bigquery.Dataset(ds_id), exists_ok=True)
    # A dataset created while the project had no billing (BigQuery sandbox) gets 60-day table and
    # partition expiry, which silently deletes the archive. The archive must never expire.
    if ds.default_table_expiration_ms or ds.default_partition_expiration_ms:
        ds.default_table_expiration_ms = None
        ds.default_partition_expiration_ms = None
        client.update_dataset(ds, ['default_table_expiration_ms', 'default_partition_expiration_ms'])
        warn('BigQuery: removed the sandbox 60-day expiry from the dataset')
    return client, ds_id


def bq_ensure(client, ds_id, name, schema, part_field):
    from google.cloud import bigquery
    t = bigquery.Table(f'{ds_id}.{name}', schema=[bigquery.SchemaField(*s) for s in schema])
    # Monthly partitions keep queries cheap and stay far under BigQuery's partition limit
    t.time_partitioning = bigquery.TimePartitioning(type_=bigquery.TimePartitioningType.MONTH, field=part_field)
    t = client.create_table(t, exists_ok=True)
    if t.expires or (t.time_partitioning and t.time_partitioning.expiration_ms):
        t.expires = None
        tp = t.time_partitioning
        tp.expiration_ms = None
        t.time_partitioning = tp
        t = client.update_table(t, ['expires', 'time_partitioning'])
        warn(f'BigQuery: removed expiry from table {name}')
    return t


def bq_merge(client, ds_id, name, rows, schema, keys):
    if not rows:
        return
    from google.cloud import bigquery
    stage = f'{ds_id}._stage_{name}'
    job = client.load_table_from_json(rows, stage, job_config=bigquery.LoadJobConfig(
        schema=[bigquery.SchemaField(*s) for s in schema], write_disposition='WRITE_TRUNCATE'))
    job.result()
    cols = [s[0] for s in schema]
    on = ' AND '.join(f'T.{k} = S.{k}' for k in keys)
    sets = ', '.join(f'{c} = S.{c}' for c in cols if c not in keys)
    client.query(f"""MERGE `{ds_id}.{name}` T USING `{stage}` S ON {on}
        WHEN MATCHED THEN UPDATE SET {sets}
        WHEN NOT MATCHED THEN INSERT ({', '.join(cols)}) VALUES ({', '.join('S.' + c for c in cols)})""").result()
    client.delete_table(stage, not_found_ok=True)


def bq_dedupe(client, ds_id, name, keys, part):
    # Remove duplicate rows (left behind when sandbox expiry hid old partitions during earlier merges).
    # Checked each run; only rewrites a table when duplicates exist.
    k = ', '.join(keys)
    row = list(client.query(f'SELECT COUNT(*) AS n, COUNT(DISTINCT TO_JSON_STRING(STRUCT({k}))) AS u FROM `{ds_id}.{name}`').result())[0]
    if row.n > row.u:
        client.query(f'''CREATE OR REPLACE TABLE `{ds_id}.{name}` PARTITION BY DATE_TRUNC({part}, MONTH) AS
            SELECT * FROM `{ds_id}.{name}` WHERE TRUE QUALIFY ROW_NUMBER() OVER (PARTITION BY {k}) = 1''').result()
        warn(f'BigQuery: removed {row.n - row.u} duplicate rows from {name}')


def bq_count(client, ds_id, name):
    return list(client.query(f'SELECT COUNT(*) AS c FROM `{ds_id}.{name}`').result())[0].c


def to_bigquery(trades, prices):
    client, ds_id = bq_dataset()
    if not client:
        warn('BigQuery history: not configured, skipped')
        return
    tables = {'trades': bq_ensure(client, ds_id, 'trades', TRADE_SCHEMA, 'traded'),
              'prices': bq_ensure(client, ds_id, 'prices', PRICE_SCHEMA, 'd')}
    used = sum(client.get_table(t.reference).num_bytes or 0 for t in tables.values())
    if used >= BIGQUERY_LIMIT:
        warn(f'BigQuery history is at {used / 1e9:.2f} GB (limit 9 GB). Writes skipped.')
        return

    bq_merge(client, ds_id, 'trades', trades, TRADE_SCHEMA, ['id'])
    bq_merge(client, ds_id, 'prices', prices, PRICE_SCHEMA, ['ticker', 'd'])
    for name, keys, part in (('trades', ['id'], 'traded'), ('prices', ['ticker', 'd'], 'd')):
        bq_dedupe(client, ds_id, name, keys, part)

    # Count what is actually stored (metadata count, no bytes scanned), so a silent miss shows up
    counts = {n: bq_count(client, ds_id, n) for n in tables}
    used = sum(client.get_table(t.reference).num_bytes or 0 for t in tables.values())
    notice(f'BigQuery history: {len(trades)} trades and {len(prices)} prices merged; stored now {counts["trades"]} trades and '
           f'{counts["prices"]} prices; {used / 1e6:.1f} MB used of 9 GB')
    if prices and not counts['prices']:
        raise RuntimeError('BigQuery prices table is empty after the merge')


# ── News verdicts (Supabase -> BigQuery archive) ────────
# Batch news reads written by the pi-newsdesk Worker (supabase/news.sql). Supabase keeps 2 years;
# BigQuery keeps everything. The last NEWS_DAYS days are re-copied each run so late rows are caught.
NEWS_DAYS = 3
NEWS_SCHEMA = [('id', 'STRING', 'REQUIRED'), ('run_date', 'DATE', 'REQUIRED'), ('created', 'TIMESTAMP', 'NULLABLE'),
               ('ticker', 'STRING', 'REQUIRED'), ('origin', 'STRING', 'NULLABLE'), ('mode', 'STRING', 'NULLABLE'),
               ('stance', 'STRING', 'NULLABLE'), ('confidence', 'STRING', 'NULLABLE'), ('status', 'STRING', 'NULLABLE'),
               ('groq_calls', 'INT64', 'NULLABLE'), ('tokens', 'INT64', 'NULLABLE'), ('model', 'STRING', 'NULLABLE'),
               ('prompt_version', 'STRING', 'NULLABLE'), ('price_ref_date', 'DATE', 'NULLABLE'), ('record', 'STRING', 'NULLABLE')]


def news_rows(sb, since):
    cols = ','.join(c for c, _, _ in NEWS_SCHEMA)
    out, step = [], 1000
    while True:
        r = requests.get(f'{sb.url}/rest/v1/news_verdicts?select={cols}&run_date=gte.{since}&order=id&limit={step}&offset={len(out)}',
                         headers=sb.h, timeout=60)
        if r.status_code >= 300:
            raise RuntimeError(f'news_verdicts read failed: {r.status_code}')  # no body: rows hold model text
        page = r.json()
        for row in page:
            row['record'] = json.dumps(row.get('record'), separators=(',', ':'), sort_keys=True)
        out.extend(page)
        if len(page) < step:
            return out


def to_bigquery_news(*_):
    url, key = os.environ.get('SUPABASE_URL', '').strip(), os.environ.get('SUPABASE_SERVICE_KEY', '').strip()
    if not url or not key:
        warn('News verdicts archive: Supabase not configured, skipped')
        return
    client, ds_id = bq_dataset()
    if not client:
        warn('News verdicts archive: BigQuery not configured, skipped (Supabase rows are not purged)')
        return
    sb = Supabase(url, key)
    since = (datetime.date.today() - datetime.timedelta(days=NEWS_DAYS)).isoformat()
    try:
        rows = news_rows(sb, since)
    except RuntimeError as e:
        if ' 404' in str(e):  # supabase/news.sql not run yet
            warn('News verdicts archive: table news_verdicts not found (run supabase/news.sql), skipped')
            return
        raise
    rows = list({r['id']: r for r in rows}.values())
    table = bq_ensure(client, ds_id, 'news_verdicts', NEWS_SCHEMA, 'run_date')
    bq_merge(client, ds_id, 'news_verdicts', rows, NEWS_SCHEMA, ['id'])
    bq_dedupe(client, ds_id, 'news_verdicts', ['id'], 'run_date')
    stored = bq_count(client, ds_id, 'news_verdicts')
    used = client.get_table(table.reference).num_bytes or 0
    if rows and not stored:
        raise RuntimeError('BigQuery news_verdicts table is empty after the merge')
    # Purge Supabase rows over 2 years only after the archive merge succeeded
    r = requests.post(f'{sb.url}/rest/v1/rpc/news_purge', headers=sb.h, json={}, timeout=60)
    purged = r.json() if r.status_code < 300 else None
    if purged is None:
        warn(f'News verdicts: Supabase purge failed: {r.status_code}')
    notice(f'News verdicts archive: {len(rows)} rows since {since} merged; stored now {stored} rows; {used / 1e6:.1f} MB; '
           f'Supabase purged {(purged or {}).get("verdicts", 0)} verdicts over 2 years')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--trades', nargs='+', required=True)
    ap.add_argument('--prices', choices=['recent', '5y', 'max', 'none'], default='recent')
    ap.add_argument('--replace-chamber', action='append', default=[], help='delete this chamber from the history first (fixes)')
    a = ap.parse_args()
    REPLACE.extend(a.replace_chamber)
    trades = load_trades(a.trades)
    tickers = {t['ticker'] for t in trades if t['ticker'] and re.fullmatch(r'[A-Z][A-Z.]{0,6}', t['ticker'])}
    prices = [] if a.prices == 'none' else load_prices(tickers, {'recent': '1mo', '5y': '5y', 'max': 'max'}[a.prices])
    notice(f'History: {len(trades)} trades, {len(tickers)} tickers, {len(prices)} daily prices')
    ok = True
    for name, fn in (('Supabase', to_supabase), ('BigQuery', to_bigquery), ('News verdicts', to_bigquery_news)):
        try:
            fn(trades, prices)
        except Exception as e:
            ok = False
            warn(f'{name} history failed: {e}')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
