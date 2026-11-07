"""One-off reachability test: can Render reach Senate eFD? Prints only status codes and counts."""
import http.cookiejar, json, os, re, urllib.error, urllib.parse, urllib.request
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer

BASE = 'https://efdsearch.senate.gov'
jar = http.cookiejar.CookieJar()
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
op.addheaders = [('User-Agent', 'Mozilla/5.0 (compatible; efd-reachability-test/1.0)')]


def req(step, path, data=None, headers=None):
    body = urllib.parse.urlencode(data).encode() if data is not None else None
    r = urllib.request.Request(BASE + path, data=body, headers=headers or {})
    try:
        with op.open(r, timeout=30) as resp:
            text = resp.read().decode('utf-8', 'replace')
            print(f'EFDTEST {step} status={resp.status} final_path={urllib.parse.urlparse(resp.geturl()).path}', flush=True)
            return resp.status, text, resp.geturl()
    except urllib.error.HTTPError as e:
        print(f'EFDTEST {step} status={e.code}', flush=True)
        return e.code, '', ''
    except Exception as e:
        print(f'EFDTEST {step} error={type(e).__name__}', flush=True)
        return None, '', ''


def csrf_cookie():
    return next((c.value for c in jar if c.name == 'csrftoken'), '')


def run():
    req('1_get_search', '/search/')
    st, html, _ = req('2_get_home', '/search/home/')
    m = re.search(r'name="csrfmiddlewaretoken" value="([^"]+)"', html)
    print(f'EFDTEST csrf_token_found={bool(m)}', flush=True)
    if st != 200 or not m:
        print('EFDTEST stop=no_csrf', flush=True); return
    st, _, url = req('3_post_agreement', '/search/home/', {'prohibition_agreement': '1', 'csrfmiddlewaretoken': m.group(1)},
                     {'Referer': BASE + '/search/home/'})
    agreed = st == 200 and not urllib.parse.urlparse(url).path.rstrip('/').endswith('/search/home')
    print(f'EFDTEST agreement_ok={agreed}', flush=True)
    since = (date.today() - timedelta(days=30)).strftime('%m/%d/%Y 00:00:00')
    st, text, _ = req('4_post_results', '/search/report/data/', {
        'start': '0', 'length': '100', 'report_types': '[11]', 'filer_types': '[1,5]', 'submitted_start_date': since,
        'submitted_end_date': '', 'candidate_state': '', 'senator_state': '', 'office_id': '', 'first_name': '',
        'last_name': '', 'draw': '1'},
        {'Referer': BASE + '/search/', 'X-CSRFToken': csrf_cookie(), 'X-Requested-With': 'XMLHttpRequest'})
    try:
        d = json.loads(text)
        print(f"EFDTEST rows_returned={len(d.get('data') or [])} records_filtered={d.get('recordsFiltered')}", flush=True)
    except Exception:
        print('EFDTEST results_not_json', flush=True)


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
    do_HEAD = do_GET
    def log_message(self, *a):
        pass


if __name__ == '__main__':
    run()
    HTTPServer(('0.0.0.0', int(os.environ.get('PORT', '10000'))), H).serve_forever()
