#!/usr/bin/env python3
"""Feature flags for the GitHub jobs. Stdlib only.

Reads GET /api/flags on the gateway (5 s timeout, 2 tries). If it cannot be reached, each flag
takes its registry default (scripts/flags_registry.json) and a ::warning:: line is printed.

Usage:
  python3 scripts/flags.py house_scrape            prints true or false
  python3 scripts/flags.py --github-output a b c   writes a=true|false lines to $GITHUB_OUTPUT (and prints them)
Env: FLAGS_URL (default: the gateway /api/flags)
"""
import json
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_URL = 'https://portfolio-intel-api.viphashkahn.workers.dev/api/flags'


def registry():
    with open(os.path.join(HERE, 'flags_registry.json'), encoding='utf-8') as fh:
        return json.load(fh)


def fetch(url=None, tries=2, timeout=5, opener=urllib.request.urlopen, sleep=time.sleep):
    """The flags dict from the gateway, or None when it cannot be read."""
    url = url or os.environ.get('FLAGS_URL') or DEFAULT_URL
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'portfolio-intel-jobs', 'Accept': 'application/json'})
            with opener(req, timeout=timeout) as r:
                d = json.loads(r.read(65536).decode('utf-8'))
            flags = d.get('flags') if isinstance(d, dict) else None
            if isinstance(flags, dict):
                return {k: v for k, v in flags.items() if isinstance(v, bool)}
        except Exception:
            pass
        if i + 1 < tries:
            sleep(1)
    return None


def values(names, live, reg=None):
    reg = reg or registry()
    out = {}
    for n in names:
        if n not in reg:
            raise SystemExit(f'unknown flag: {n}')
        out[n] = live[n] if live is not None and n in live else reg[n]['default']
    return out


def main(argv):
    gh = argv[:1] == ['--github-output']
    names = argv[1:] if gh else argv
    if not names:
        print(__doc__)
        return 2
    live = fetch()
    if live is None:
        print('::warning::Feature flags unreachable; using registry defaults')
    vals = values(names, live)
    lines = [f'{k}={"true" if v else "false"}' for k, v in vals.items()]
    if gh:
        path = os.environ.get('GITHUB_OUTPUT')
        if path:
            with open(path, 'a', encoding='utf-8') as fh:
                fh.write('\n'.join(lines) + '\n')
        print('\n'.join(lines))
    else:
        print('\n'.join('true' if v else 'false' for v in vals.values()))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
