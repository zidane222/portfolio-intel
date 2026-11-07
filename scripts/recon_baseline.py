"""Dry-run baseline for congressional trade reconciliation (read only).

Official House Clerk and Senate eFD records are the source of truth; FMP is the cross-check and
gap fill. Nothing here writes trades.json, Supabase or BigQuery. Output goes to --out-dir only:
baseline_report.json and baseline_report.md.

Definitions (owner decisions):
- Filing period = calendar month of the filing date. House: FilingDate in the Clerk's yearly
  index (public_disc/financial-pdfs/<year>FD.zip). Senate: the eFD "received" date.
- Late filing = filing date more than 45 days after the transaction date. Counted on its own,
  not part of completeness.
- Window = the last 12 months up to --today (default today). No fixed multi-year assumption.

Parsing reuses scripts/house_ptr.py, scripts/senate_ptr.py and scripts/senate_fmp.py.
FMP_API_KEY is read from the environment and never printed.

Usage: python3 scripts/recon_baseline.py --out-dir recon_out [--today 2026-11-07] [--senate-budget 900]
"""
import argparse, collections, datetime, io, json, os, re, signal, sys, time, unicodedata, zipfile
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import requests  # noqa: E402
import house_ptr as hp  # noqa: E402
import senate_ptr as sp  # noqa: E402
import senate_fmp as sf  # noqa: E402

LATE_DAYS = 45
CAUSES = ['paper_scanned', 'parse_error', 'amendment', 'pagination_index_gap', 'rate_limit_or_blocked',
          'ticker_mapping', 'date_amount_parsing', 'other']
FIELDS = ['member', 'ticker', 'transaction_type', 'transaction_date', 'amount_range', 'owner', 'filing_date']


def log(msg):
    print(hp.safe(msg), flush=True)


def d_iso(s):
    s = (s or '').strip()[:10]
    for fmt in ('%Y-%m-%d', '%m/%d/%Y'):
        try:
            return datetime.datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    return None


def month(day):
    return day.strftime('%Y-%m') if day else None


def plain(x):
    return unicodedata.normalize('NFKD', str(x or '')).encode('ascii', 'ignore').decode().lower().strip()


def last_name(n):
    return plain(str(n).split(',')[0])


def amount_norm(a):
    nums = re.findall(r'\d[\d,]*', str(a or ''))
    return '-'.join(x.replace(',', '') for x in nums)


def doc_id(url):
    m = re.search(r'/([^/]+?)(?:\.pdf)?/?$', str(url or ''))
    return m.group(1) if m else ''


class Budget(Exception):
    pass


# ------------------------------------------------------------------ House (official)
def house_index(year):
    """PTR filings in the Clerk's yearly index: DocID -> {name, filed}. None if unreachable."""
    url = f'{hp.BASE}/public_disc/financial-pdfs/{year}FD.zip'
    try:
        r = requests.get(url, headers=hp.headers, timeout=60)
        if r.status_code != 200:
            return None, f'index {year}: HTTP {r.status_code}'
        z = zipfile.ZipFile(io.BytesIO(r.content))
        xml_name = next(n for n in z.namelist() if n.lower().endswith('.xml'))
        root = ET.fromstring(z.read(xml_name))
    except Exception as e:
        return None, f'index {year}: {type(e).__name__}'
    out = {}
    for m in root.iter('Member'):
        g = lambda k: (m.findtext(k) or '').strip()
        if g('FilingType') != 'P':
            continue
        out[g('DocID')] = {'name': f"{g('Last')}, {g('First')}", 'filed': d_iso(g('FilingDate'))}
    return out, ''


def house_official(year, index, start, end):
    """Run house_ptr.scrape for one filing year and attribute each trade to its filing.

    house_ptr parses one filing at a time and calls check_date on each of its trades right after,
    so recording the PDF URL being fetched tags each trade with its filing. Filings the index dates
    outside the window are not downloaded (answered with a stub 404 and dropped from the counts)."""
    state = {'current': '', 'requested': [], 'skipped': set()}
    orig_session, orig_check = hp.requests.Session, hp.check_date

    def out_of_window(url):
        info = (index or {}).get(doc_id(url))
        return bool(info and info['filed'] and not (start <= info['filed'] <= end))

    class Recording(orig_session):
        def get(self, url, *a, **k):
            if str(url).lower().endswith('.pdf'):
                if out_of_window(url):
                    state['skipped'].add(url)
                    stub = requests.Response(); stub.status_code = 404; stub._content = b''
                    return stub
                state['current'] = url
                state['requested'].append(url)
            return super().get(url, *a, **k)

    def tagging_check(t):
        t['_doc'] = state['current']
        return orig_check(t)

    hp.requests.Session, hp.check_date = Recording, tagging_check
    try:
        trades, report = hp.scrape(year, log=lambda m: None)
    finally:
        hp.requests.Session, hp.check_date = orig_session, orig_check
    empty = [e for e in report.get('empty', []) if e.get('url') not in state['skipped']]
    return trades, report, empty, state['requested']


def house_filing_status(requested, empty, trades):
    by_doc = collections.Counter(t.get('_doc') for t in trades)
    ocr = {t.get('_doc') for t in trades if t.get('ocr')}
    reasons = {e['url']: e.get('reason', '') for e in empty if e.get('url')}
    status = {}
    for url in requested:
        why = reasons.get(url, '')
        if 'no text layer' in why or url in ocr:
            s = 'scanned_paper'
        elif why.startswith(('parse error', 'download failed')) or why == 'no transaction rows recognized':
            s = 'parse_failure'
        elif by_doc.get(url):
            s = 'parsed_ok'
        else:
            s = 'parse_failure'
        status[url] = {'status': s, 'reason': why, 'trades': by_doc.get(url, 0)}
    return status


# ------------------------------------------------------------------ Senate (official)
def senate_official(start, budget):
    """eFD PTR list and electronic reports, with a time budget. Returns (filings, trades, notes)."""
    filings, trades, notes = [], [], []

    def stop(*_):
        raise Budget()
    old = signal.signal(signal.SIGALRM, stop)
    signal.alarm(max(1, int(budget)))
    try:
        s = sp.session()
        reports = sp.list_reports(s, start)
        for rep in reports:
            f = {'url': rep['url'], 'name': rep['name'], 'filed': d_iso(rep['received']), 'paper': rep['paper'], 'trades': 0}
            filings.append(f)
        for f in filings:
            if f['paper']:
                f['status'] = 'scanned_paper'; continue
            try:
                r = s.get(f['url'], timeout=30)
            except requests.RequestException as e:
                f['status'], f['reason'] = 'parse_failure', f'download failed ({type(e).__name__})'; continue
            if r.status_code in (403, 429):
                f['status'], f['reason'] = 'rate_limited', f'HTTP {r.status_code}'; continue
            if r.status_code != 200:
                f['status'], f['reason'] = 'parse_failure', f'HTTP {r.status_code}'; continue
            try:
                rows = sp.parse_report(r.text, f['name'], f['filed'].isoformat() if f['filed'] else '')
            except Exception as e:
                f['status'], f['reason'] = 'parse_failure', f'parse error ({type(e).__name__})'; continue
            for t in rows:
                t['_doc'] = f['url']
            trades.extend(rows)
            f['trades'] = len(rows)
            f['amendment'] = 'amend' in r.text[:4000].lower()
            f['status'] = 'parsed_ok' if rows else 'parse_failure'
            if not rows:
                f['reason'] = 'no transaction rows recognized'
            time.sleep(0.3)
    except Budget:
        notes.append(f'Senate official: time budget of {budget}s reached; later filings not read')
    except Exception as e:
        code = getattr(getattr(e, 'response', None), 'status_code', None)
        notes.append(f'Senate official unreachable: {type(e).__name__}' + (f' HTTP {code}' if code else ''))
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old)
    for f in filings:
        f.setdefault('status', 'not_read')
    return filings, trades, notes


# ------------------------------------------------------------------ FMP
def fmp_rows(path, k, notes, max_pages=40):
    """Every page FMP will serve. The free plan is documented to serve only page 0; later pages are tried
    and the first refusal is recorded. Error text never includes the key."""
    rows, pages = [], 0
    for p in range(max_pages):
        try:
            got = sf.get(path, {'page': p}, k)
        except Exception as e:
            notes.append(f'FMP {path} page {p}: {str(e)[:80] if isinstance(e, RuntimeError) else type(e).__name__}')
            break
        if not got:
            break
        rows.extend(got); pages += 1
        if len(got) < 25:
            break
        time.sleep(0.5)
    return rows, pages


def fmp_trade(r):
    t = sf.to_trade(r)
    if not t:
        return None
    t['_raw'] = {'type': str(r.get('type') or ''), 'amount': str(r.get('amount') or ''), 'symbol': str(r.get('symbol') or ''),
                 'owner': str(r.get('owner') or ''), 'filed': (r.get('disclosureDate') or '')[:10]}
    t['_doc'] = str(r.get('link') or '')
    t['_amend'] = any('amend' in str(v).lower() for v in r.values() if isinstance(v, str))
    return t


# ------------------------------------------------------------------ pairing
def pair(ours, fmp):
    """Greedy pairing in three passes. Returns (pairs, only_ours, only_fmp)."""
    used_o, used_f, pairs = set(), set(), []
    def k_exact(t): return (last_name(t['representative']), sf.norm_ticker(t['ticker']), t['date'], (t['type'] or '')[:4])
    idx = collections.defaultdict(list)
    for i, t in enumerate(ours):
        if t['ticker']:
            idx[k_exact(t)].append(i)
    for j, f in enumerate(fmp):
        if not f['ticker']:
            continue
        for i in idx.get(k_exact(f), []):
            if i not in used_o:
                used_o.add(i); used_f.add(j); pairs.append((ours[i], f)); break
    by_last = collections.defaultdict(list)
    for i, t in enumerate(ours):
        by_last[last_name(t['representative'])].append(i)
    def close(a, b, days):
        da, db = d_iso(a), d_iso(b)
        return bool(da and db and abs((da - db).days) <= days)
    def same_asset(o, f):
        return (o['ticker'] and sf.norm_ticker(o['ticker']) == sf.norm_ticker(f['ticker'])) or sf._same_company(o['description'], f['description'])
    passes = [
        lambda o, f: same_asset(o, f) and o['date'] == f['date'],                                  # type differs
        lambda o, f: same_asset(o, f) and (o['type'] or '')[:4] == (f['type'] or '')[:4] and close(o['date'], f['date'], 7),
        lambda o, f: same_asset(o, f) and close(o['date'], f['date'], 7),
    ]
    for ok in passes:
        for j, f in enumerate(fmp):
            if j in used_f:
                continue
            for i in by_last.get(last_name(f['representative']), []):
                if i not in used_o and ok(ours[i], f):
                    used_o.add(i); used_f.add(j); pairs.append((ours[i], f)); break
    return pairs, [t for i, t in enumerate(ours) if i not in used_o], [f for j, f in enumerate(fmp) if j not in used_f]


def compare(o, f, ours_filed):
    """Per field: (raw_equal, normalized_equal); None when a side does not carry the field."""
    fd, od = d_iso(f['_raw']['filed']), ours_filed
    res = {
        'member': (o['representative'] == f['representative'], last_name(o['representative']) == last_name(f['representative'])),
        'ticker': (o['ticker'] == f['_raw']['symbol'], bool(sf.norm_ticker(o['ticker']) == sf.norm_ticker(f['ticker']) or sf._same_company(o['description'], f['description']))),
        'transaction_type': (o['type'] == f['_raw']['type'], (o['type'] or '')[:4] == (f['type'] or '')[:4]),
        'transaction_date': (o['date'] == f['date'], d_iso(o['date']) == d_iso(f['date'])),
        'amount_range': (o['amount'] == f['_raw']['amount'], amount_norm(o['amount']) == amount_norm(f['amount'])),
        'owner': None,  # our parsers do not keep the owner column (SP/JT/DC); not comparable yet
        'filing_date': (o.get('filed') == f['_raw']['filed'], bool(od and fd and abs((od - fd).days) <= 3)),
    }
    return res


# ------------------------------------------------------------------ chamber report
def chamber_report(name, filings, ours, fmp, filing_date_of, fmp_from, months, notes, official_reachable):
    """filings: list of {url, filed, status, trades, amendment?}; ours/fmp trades carry _doc."""
    per = {m: collections.Counter() for m in months}
    for f in filings:
        m = month(f['filed'])
        if m in per:
            per[m]['filings'] += 1
            per[m][f['status']] += 1
    for t in ours:
        m = month(filing_date_of(t))
        if m in per:
            per[m]['trades_ours'] += 1
    for t in fmp:
        m = month(d_iso(t['_raw']['filed']))
        if m in per:
            per[m]['trades_fmp'] += 1

    # Compare only where both sides could have the trade: filings dated on or after FMP's oldest row
    def in_cmp(day):
        return bool(day and fmp_from and day >= fmp_from)
    ours_c = [t for t in ours if in_cmp(filing_date_of(t))]
    fmp_c = [t for t in fmp if in_cmp(d_iso(t['_raw']['filed']))]
    pairs, only_ours, only_fmp = pair(ours_c, fmp_c)

    mism_raw, mism_norm, not_cmp = collections.Counter(), collections.Counter(), collections.Counter()
    raw_ok = norm_ok = 0
    mism_cause = collections.Counter()
    for o, f in pairs:
        c = compare(o, f, filing_date_of(o))
        r_all = n_all = True
        for fld in FIELDS:
            if c[fld] is None:
                not_cmp[fld] += 1; continue
            if not c[fld][0]:
                mism_raw[fld] += 1; r_all = False
            if not c[fld][1]:
                mism_norm[fld] += 1; n_all = False
                mism_cause['ticker_mapping' if fld == 'ticker' else 'date_amount_parsing' if fld in ('transaction_date', 'amount_range', 'filing_date') else 'other'] += 1
        raw_ok += r_all; norm_ok += n_all

    fstat = {f['url']: f for f in filings}
    fstat_by_id = {doc_id(u): f for u, f in fstat.items()}
    def miss_cause(t):
        if t.get('_amend'):
            return 'amendment'
        f = fstat_by_id.get(doc_id(t['_doc'])) if t['_doc'] else None
        if f is None:
            return 'rate_limit_or_blocked' if not official_reachable else 'pagination_index_gap'
        if f.get('amendment'):
            return 'amendment'
        return {'scanned_paper': 'paper_scanned', 'parse_failure': 'parse_error', 'rate_limited': 'rate_limit_or_blocked',
                'not_read': 'rate_limit_or_blocked'}.get(f['status'], 'other')
    miss = collections.Counter(miss_cause(t) for t in only_fmp)
    for t in only_fmp:
        m = month(d_iso(t['_raw']['filed']))
        if m in per:
            per[m]['missing'] += 1
    for t in only_ours:
        m = month(filing_date_of(t))
        if m in per:
            per[m]['only_ours'] += 1
    for o, _ in pairs:
        m = month(filing_date_of(o))
        if m in per:
            per[m]['both'] += 1

    def late(trades, filed_of):
        n = tot = 0
        for t in trades:
            td, fd = d_iso(t['date']), filed_of(t)
            if td and fd:
                tot += 1; n += (fd - td).days > LATE_DAYS
        return n, tot
    late_ours = late(ours, filing_date_of)
    late_fmp = late(fmp, lambda t: d_iso(t['_raw']['filed']))
    late_filings = 0
    late_docs = {t['_doc'] for t in ours if d_iso(t['date']) and filing_date_of(t) and (filing_date_of(t) - d_iso(t['date'])).days > LATE_DAYS}
    late_filings = len(late_docs)

    rows = []
    for m in months:
        c = per[m]
        covered = bool(fmp_from and month(fmp_from) <= m)
        denom = c['both'] + c['only_ours'] + c['missing']
        rows.append({
            'month': m, 'official_filings': c['filings'], 'parsed_ok': c['parsed_ok'], 'scanned_paper': c['scanned_paper'],
            'parse_failures': c['parse_failure'], 'rate_limited_or_not_read': c['rate_limited'] + c['not_read'],
            'trades_ours': c['trades_ours'], 'trades_fmp': c['trades_fmp'], 'fmp_could_fill': c['missing'], 'missing': c['missing'],
            'fmp_compared': covered, 'fmp_partial_month': bool(fmp_from and month(fmp_from) == m and fmp_from.day > 1),
            'filing_completeness': round(c['parsed_ok'] / c['filings'], 3) if c['filings'] else None,
            'trade_completeness': round((c['both'] + c['only_ours']) / denom, 3) if covered and denom else None,
        })
    tot = lambda k: sum(r[k] for r in rows)
    denom = len(pairs) + len(only_ours) + len(only_fmp)
    return {
        'chamber': name,
        'totals_12m': {'official_filings': tot('official_filings'), 'parsed_ok': tot('parsed_ok'), 'scanned_paper': tot('scanned_paper'),
                       'parse_failures': tot('parse_failures'), 'rate_limited_or_not_read': tot('rate_limited_or_not_read'),
                       'trades_ours': tot('trades_ours'), 'trades_fmp': tot('trades_fmp'),
                       'filing_completeness': round(tot('parsed_ok') / tot('official_filings'), 3) if tot('official_filings') else None},
        'comparison': {'fmp_oldest_filing_date': fmp_from.isoformat() if fmp_from else None,
                       'ours_in_scope': len(ours_c), 'fmp_in_scope': len(fmp_c), 'both': len(pairs),
                       'only_ours': len(only_ours), 'only_fmp': len(only_fmp), 'fmp_could_fill': len(only_fmp),
                       'trade_completeness': round((len(pairs) + len(only_ours)) / denom, 3) if denom else None,
                       'raw_match_rate': round(raw_ok / len(pairs), 3) if pairs else None,
                       'normalized_match_rate': round(norm_ok / len(pairs), 3) if pairs else None,
                       'mismatch_raw_by_field': {f: mism_raw.get(f, 0) for f in FIELDS},
                       'mismatch_normalized_by_field': {f: mism_norm.get(f, 0) for f in FIELDS},
                       'fields_not_comparable': dict(not_cmp)},
        'causes': {'misses_only_fmp': {c: miss.get(c, 0) for c in CAUSES},
                   'mismatches_normalized': {c: mism_cause.get(c, 0) for c in CAUSES},
                   'ranked': sorted(((c, miss.get(c, 0) + mism_cause.get(c, 0)) for c in CAUSES), key=lambda x: -x[1])},
        'late_filings': {'threshold_days': LATE_DAYS, 'ours_trades_late': late_ours[0], 'ours_trades_with_dates': late_ours[1],
                         'ours_filings_with_a_late_trade': late_filings, 'fmp_trades_late': late_fmp[0], 'fmp_trades_with_dates': late_fmp[1]},
        'per_month': rows,
        'samples_only_fmp': [{'member': t['representative'], 'ticker': t['ticker'], 'date': t['date'], 'type': t['type'],
                              'filed': t['_raw']['filed'], 'cause': miss_cause(t)} for t in only_fmp[:40]],
        'notes': notes,
    }


def months_between(start, end):
    out, y, m = [], start.year, start.month
    while (y, m) <= (end.year, end.month):
        out.append(f'{y:04d}-{m:02d}')
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def md(report):
    L = [f"# Reconciliation baseline (dry run)", '', f"Window {report['window']['start']} to {report['window']['end']}. "
         "Filing period is the month of the filing date. Official records are the source of truth; FMP is cross-check and gap fill.", '']
    for c in report['chambers']:
        t, cmp_ = c['totals_12m'], c['comparison']
        L += [f"## {c['chamber']}", '',
              f"Official PTR filings {t['official_filings']}: parsed {t['parsed_ok']}, scanned/paper {t['scanned_paper']}, "
              f"parse failures {t['parse_failures']}, not read (blocked or budget) {t['rate_limited_or_not_read']}. "
              f"Trades ours {t['trades_ours']}, FMP {t['trades_fmp']}.", '',
              f"Compared from {cmp_['fmp_oldest_filing_date']}: both {cmp_['both']}, only ours {cmp_['only_ours']}, only FMP {cmp_['only_fmp']}, "
              f"trade completeness {cmp_['trade_completeness']}, raw match {cmp_['raw_match_rate']}, normalized match {cmp_['normalized_match_rate']}.", '',
              '| Month | Filings | Parsed | Scanned | Failed | Ours | FMP | Missing | Filing compl. | Trade compl. |',
              '|---|---|---|---|---|---|---|---|---|---|']
        for r in c['per_month']:
            L.append(f"| {r['month']} | {r['official_filings']} | {r['parsed_ok']} | {r['scanned_paper']} | {r['parse_failures']} | "
                     f"{r['trades_ours']} | {r['trades_fmp']} | {r['missing']} | {r['filing_completeness']} | {r['trade_completeness']} |")
        L += ['', 'Mismatch by field (normalized): ' + ', '.join(f'{k} {v}' for k, v in cmp_['mismatch_normalized_by_field'].items()),
              '', 'Causes ranked: ' + ', '.join(f'{k} {v}' for k, v in c['causes']['ranked']),
              '', f"Late filings (over {LATE_DAYS} days): {c['late_filings']['ours_trades_late']} of {c['late_filings']['ours_trades_with_dates']} trades, "
              f"{c['late_filings']['ours_filings_with_a_late_trade']} filings.", '']
        L += [f'- {n}' for n in c['notes']] + ['']
    L += ['## Notes', ''] + [f'- {n}' for n in report['notes']]
    return '\n'.join(L) + '\n'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out-dir', required=True)
    ap.add_argument('--today', default=datetime.date.today().isoformat())
    ap.add_argument('--senate-budget', type=int, default=900)
    ap.add_argument('--senate-fmp-saved', default='senate_last.json', help='read only: the saved FMP Senate copy on main')
    a = ap.parse_args()
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', a.today):
        sys.exit('--today must be YYYY-MM-DD')
    end = datetime.date.fromisoformat(a.today)
    start = end.replace(year=end.year - 1)
    months = months_between(start, end)
    os.makedirs(a.out_dir, exist_ok=True)
    notes = [f'Generated {datetime.datetime.now(datetime.timezone.utc).isoformat()}. Read only; no data files written outside the output folder.']
    k = os.environ.get('FMP_API_KEY', '').strip()
    if not k:
        notes.append('FMP_API_KEY not set; FMP side is empty')

    # ---- House
    hnotes, h_filings, h_ours, h_reports = [], [], [], {}
    idx_all = {}
    for year in range(start.year, end.year + 1):
        idx, err = house_index(year)
        if err:
            hnotes.append(f'House index unreachable ({err}); filing months for {year} fall back to the signature date')
        idx_all.update(idx or {})
        log(f'House {year}: index {len(idx or {})} PTRs; scraping')
        try:
            trades, report, empty, requested = house_official(year, idx, start, end)
        except Exception as e:
            hnotes.append(f'House scrape {year} failed: {type(e).__name__}')
            continue
        status = house_filing_status(requested, empty, trades)
        no_link = [e for e in empty if not e.get('url')]
        if no_link:
            hnotes.append(f'House {year}: {len(no_link)} search rows had no PDF link')
        if len(report.get('empty', [])) >= 200:
            hnotes.append(f'House {year}: parse report list capped at 200 entries; some failure reasons may be missing')
        in_search = {doc_id(u) for u in requested}
        gap = [d for d, v in (idx or {}).items() if v['filed'] and start <= v['filed'] <= end and d not in in_search]
        h_reports[year] = {'search_filings': report.get('filings'), 'index_in_window_not_in_search': len(gap),
                           'search_rows_without_pdf': len(no_link), 'date_suspect': report.get('date_suspect'), 'date_corrected': report.get('date_corrected')}
        for d in gap:
            v = idx[d]
            h_filings.append({'url': f'index:{d}', 'name': v['name'], 'filed': v['filed'], 'status': 'index_gap', 'trades': 0})
        for url, s in status.items():
            info = (idx or {}).get(doc_id(url))
            sig = next((d_iso(t.get('filed')) for t in trades if t.get('_doc') == url and t.get('filed')), None)
            filed = info['filed'] if info and info['filed'] else sig
            if filed and start <= filed <= end:
                h_filings.append({'url': url, 'filed': filed, **s})
        h_ours.extend(trades)
        log(f'House {year}: {len(requested)} filings read, {len(trades)} trades')
    h_filed = {f['url']: f['filed'] for f in h_filings}
    h_ours = [t for t in h_ours if h_filed.get(t.get('_doc'))]
    hnotes.append('Our House rows have no owner field (house_ptr drops the SP/JT/DC code); owner is not compared.')
    hnotes.append('Our House "filed" is the signature date; FMP disclosureDate is the Clerk posting date. Filing month uses the Clerk index date.')

    h_fmp, fnotes = [], []
    if k:
        rows, pages = fmp_rows('house-latest', k, fnotes)
        h_fmp = [t for t in (fmp_trade(r) for r in rows) if t]
        fnotes.append(f'FMP house-latest: {pages} page(s), {len(rows)} rows')
    h_fmp = [t for t in h_fmp if d_iso(t['_raw']['filed']) and start <= d_iso(t['_raw']['filed']) <= end]
    h_from = min((d_iso(t['_raw']['filed']) for t in h_fmp), default=None)
    house = chamber_report('House', h_filings, h_ours, h_fmp, lambda t: h_filed.get(t.get('_doc')), h_from, months,
                           hnotes + fnotes, True)
    house['scrape_reports'] = h_reports
    house['totals_12m']['index_gap_filings'] = sum(1 for f in h_filings if f['status'] == 'index_gap')

    # ---- Senate
    log(f'Senate official: listing since {start} (budget {a.senate_budget}s)')
    s_filings, s_ours, snotes = senate_official(start, a.senate_budget)
    s_filings = [f for f in s_filings if f['filed'] and start <= f['filed'] <= end]
    s_filed = {f['url']: f['filed'] for f in s_filings}
    s_ours = [t for t in s_ours if s_filed.get(t.get('_doc'))]
    reachable = bool(s_filings)
    s_fmp, s_fnotes = [], []
    if k:
        rows, pages = fmp_rows('senate-latest', k, s_fnotes)
        live = [t for t in (fmp_trade(r) for r in rows) if t]
        s_fnotes.append(f'FMP senate-latest: {pages} page(s), {len(rows)} rows')
        s_fmp.extend(live)
    if os.path.exists(a.senate_fmp_saved):
        try:
            saved = json.load(open(a.senate_fmp_saved)).get('trades', [])
        except (ValueError, AttributeError):
            saved = []
        for t in saved:
            t = dict(t)
            t['_raw'] = {'type': t.get('type', ''), 'amount': t.get('amount', ''), 'symbol': t.get('ticker', ''), 'owner': '', 'filed': t.get('filed', '')}
            t['_doc'], t['_amend'] = t.get('link', ''), False
            s_fmp.append(t)
        s_fnotes.append(f'Saved FMP Senate copy ({a.senate_fmp_saved}): {len(saved)} rows, read only. Its type/amount are already normalized, so raw match is not meaningful for these rows.')
    seen, dedup = set(), []
    for t in s_fmp:
        kk = sf.tkey(t)
        if kk not in seen:
            seen.add(kk); dedup.append(t)
    s_fmp = [t for t in dedup if d_iso(t['_raw']['filed']) and start <= d_iso(t['_raw']['filed']) <= end]
    s_from = min((d_iso(t['_raw']['filed']) for t in s_fmp), default=None)
    snotes.append('Senate owner column is not kept by senate_ptr.parse_report; owner is not compared.')
    senate = chamber_report('Senate', s_filings, s_ours, s_fmp, lambda t: s_filed.get(t.get('_doc')), s_from, months,
                            snotes + s_fnotes, reachable)
    if not reachable:
        senate['notes'].append('No official Senate filings were read, so every FMP Senate row counts as only_fmp with cause rate_limit_or_blocked.')

    report = {'window': {'start': start.isoformat(), 'end': end.isoformat(), 'months': months},
              'definitions': {'filing_period': 'calendar month of filing date', 'late_filing_days': LATE_DAYS,
                              'trade_completeness': '(both + only_ours) / (both + only_ours + only_fmp), compared only for filings dated on or after FMP oldest row',
                              'filing_completeness': 'parsed_ok / official filings'},
              'chambers': [house, senate], 'notes': notes}
    with open(os.path.join(a.out_dir, 'baseline_report.json'), 'w') as fh:
        json.dump(report, fh, indent=1, default=str)
    with open(os.path.join(a.out_dir, 'baseline_report.md'), 'w') as fh:
        fh.write(md(report))
    for c in report['chambers']:
        log(f"{c['chamber']}: {json.dumps(c['totals_12m'])} | {json.dumps({x: c['comparison'][x] for x in ('both', 'only_ours', 'only_fmp', 'trade_completeness')})}")


if __name__ == '__main__':
    main()
