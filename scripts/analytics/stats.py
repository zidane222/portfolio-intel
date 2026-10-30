"""Statistics: moving-block bootstrap over filing-month clusters, Benjamini-Hochberg, shrinkage.
Pure numpy so every function can be tested on synthetic arrays with no network."""
import math
import zlib

import numpy as np


def rng_for(test_id, seed=42):
    """Deterministic generator per test id (same inputs and seed give the same numbers)."""
    return np.random.default_rng([int(seed), zlib.crc32(str(test_id).encode())])


def block_len(h):
    return max(1, math.ceil(h / 30))


def block_indices(m, length, b, rng):
    """(b, m) array of month indices for a moving-block bootstrap with the given block length."""
    length = max(1, min(int(length), m))
    k = -(-m // length)
    starts = rng.integers(0, m - length + 1, size=(b, k))
    idx = (starts[:, :, None] + np.arange(length)).reshape(b, k * length)[:, :m]
    return idx


def block_bootstrap(arrs, fn, length, b, rng):
    """arrs: dict of per-month arrays (same length). fn(dict of totals) -> statistic (scalar or array).
    Returns (observed, boot array without NaNs)."""
    m = len(next(iter(arrs.values())))
    idx = block_indices(m, length, b, rng)
    with np.errstate(divide='ignore', invalid='ignore'):
        obs = float(fn({k: np.asarray(a, float).sum() for k, a in arrs.items()}))
        boot = np.asarray(fn({k: np.asarray(a, float)[idx].sum(axis=1) for k, a in arrs.items()}), float)
    return obs, boot[np.isfinite(boot)]


def p_two_sided(boot):
    if len(boot) == 0:
        return 1.0
    p = 2 * min(float((boot <= 0).mean()), float((boot >= 0).mean()))
    return float(min(1.0, max(p, 1.0 / (len(boot) + 1))))


def p_one_sided(boot, sign):
    """P that the bootstrap statistic is on the wrong side of zero, for the stated sign of the effect."""
    if len(boot) == 0:
        return 1.0
    wrong = (boot * sign <= 0)
    return float(max(wrong.mean(), 1.0 / (len(boot) + 1)))


def ci(boot, level=0.95):
    a = (1 - level) / 2 * 100
    lo, hi = np.percentile(boot, [a, 100 - a])
    return float(lo), float(hi)


def bh_adjust(pvals):
    """Benjamini-Hochberg adjusted p-values (monotone step-up), same order as the input."""
    p = np.asarray(pvals, float)
    n = len(p)
    if n == 0:
        return []
    order = np.argsort(p)
    ranked = p[order] * n / (np.arange(n) + 1)
    adj = np.minimum.accumulate(ranked[::-1])[::-1]
    out = np.empty(n)
    out[order] = np.minimum(adj, 1.0)
    return [float(x) for x in out]


def by_level(selected, total, q, base=0.95):
    """Confidence level for the selected set: 1 - q*R/m, never narrower than the base level."""
    if selected <= 0 or total <= 0:
        return base
    return max(base, 1 - q * selected / total)


def shrink(means, ses):
    """Empirical-Bayes shrinkage toward the precision-free grand mean (method of moments).
    Returns (shrunk list, tau2, grand mean)."""
    m = np.asarray(means, float)
    s2 = np.asarray(ses, float) ** 2
    if len(m) == 0:
        return [], 0.0, 0.0
    mu = float(m.mean())
    tau2 = max(0.0, float(m.var(ddof=1) - s2.mean())) if len(m) > 1 else 0.0
    w = tau2 / (tau2 + np.maximum(s2, 1e-12))
    return [float(x) for x in mu + w * (m - mu)], tau2, mu


def stationary_indices(t, b, mean_block, rng):
    """Generator of (b,) index arrays for a stationary bootstrap of a length-t series."""
    p = 1.0 / mean_block
    idx = rng.integers(0, t, size=b)
    yield idx
    for _ in range(t - 1):
        new = rng.random(b) < p
        idx = np.where(new, rng.integers(0, t, size=b), (idx + 1) % t)
        yield idx
