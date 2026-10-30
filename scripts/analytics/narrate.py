"""Plain-language text from fixed templates. Every number in a sentence is formatted from a field of the same
object, so text and JSON cannot disagree (decision D3). No AI, no forecasts, no advice."""

EVIDENCE_WORDS = {
    'ahead': 'ahead of SPY over this period and in the hold-out period',
    'behind': 'behind SPY over this period and in the hold-out period',
    'not_distinguishable': 'not statistically distinguishable from SPY',
}

RULES = {
    'copy-senate-buys': 'Enters each disclosed Senate purchase at the next close after the filing date, holds it {hold_days} days, ignores sales, and weights active positions equally.',
    'copy-house-buys': 'Enters each disclosed House purchase at the next close after the filing date, holds it {hold_days} days, ignores sales, and weights active positions equally.',
    'copy-top-members': 'Copies the disclosed purchases of {members} members picked using data before 2024 only, and is tested on 2024 onward only. Members are not named.',
    'momentum-sectors': 'Each month end, holds the {holdings} sector ETFs with the highest 12-1 month return for the next month, equal weight.',
    'dividend-basket': 'Holds SCHD, VYM, DGRO and VIG in equal weight and rebalances each January.',
    'tbill-proxy': 'Holds SHV, a 0 to 1 year Treasury ETF, as a stand-in for a T-bill ladder.',
    'balanced-annual': 'Holds 60 percent SPY and 40 percent IEF and rebalances each January.',
    'balanced-never': 'Holds 60 percent SPY and 40 percent IEF and never rebalances.',
    'balanced-band': 'Holds 60 percent SPY and 40 percent IEF and rebalances when a weight drifts more than 5 points from target.',
}


def f2(x):
    return f'{abs(float(x)):.2f}'


def _dir(x):
    return 'above' if x > 0 else 'below'


SUBJECT = {
    'A1': lambda f: f"Disclosed {f['subject']['chamber'].capitalize()} purchases",
    'A2': lambda f: 'Disclosed sales',
    'A5': lambda f: f"Disclosed purchases in {f['subject']['sector']}",
}


def finding_summary(f):
    h = f['horizon_days']
    ho = f['holdout']
    if f['analysis'] in SUBJECT:
        head = (f"{SUBJECT[f['analysis']](f)}, entered at the next close after filing, averaged {f2(f['mean_excess_pct'])} percentage points "
                f"{_dir(f['mean_excess_pct'])} SPY over {h} days (95 percent interval {f['ci95_pct'][0]:.2f} to {f['ci95_pct'][1]:.2f}; "
                f"{f['n_events']} trades over {f['n_months']} months).")
    elif f['analysis'] == 'A3':
        head = (f"Purchases filed within 15 days averaged {f2(f['mean_excess_pct'])} percentage points {_dir(f['mean_excess_pct'])} purchases filed after more than 30 days, "
                f"measured against SPY over {h} days (95 percent interval {f['ci95_pct'][0]:.2f} to {f['ci95_pct'][1]:.2f}; {f['n_events']} trades).")
    else:
        head = (f"Across the four disclosed size ranges, excess return over SPY at {h} days changed by {f2(f['mean_excess_pct'])} percentage points "
                f"{'upward' if f['mean_excess_pct'] > 0 else 'downward'} from the smallest to the largest range (95 percent interval {f['ci95_pct'][0]:.2f} to {f['ci95_pct'][1]:.2f}; {f['n_events']} trades).")
    tail = (f" In the hold-out period from 2024 the figure was {f2(ho['mean_excess_pct'])} points {_dir(ho['mean_excess_pct'])}. "
            f"After an assumed round-trip cost the figure is {f2(f['net_mean_excess_pct'])}.")
    if f.get('placebo_pct') is not None:
        tail += f" Random picks from the same universe reached {f2(f['placebo_pct'])} at the 95th percentile."
    return head + tail + ' This describes the past only.'


def run_description(r):
    p = r['params']
    rule = RULES.get(r['id'], '').format(**{k: v for k, v in p.items() if isinstance(v, (int, str))})
    rel = r['relative']
    m = r['metrics']['full']
    b = r['benchmark_metrics']['full']
    cagr = 'no value' if m['cagr_pct'] is None else f"{m['cagr_pct']:.2f} percent a year"
    return (f"Simulated. {rule} From {r['period']['start']} to {r['period']['end']} the simulation returned {cagr} "
            f"against {b['cagr_pct']:.2f} for SPY, with a largest drawdown of {f2(m['max_dd_pct'])} percent. "
            f"Its difference from SPY was {f2(rel['excess_cagr_pct'])} points a year "
            f"{_dir(rel['excess_cagr_pct'])} SPY, which is {EVIDENCE_WORDS[r['evidence']]}. Hypothetical, not a record of real trades.")
