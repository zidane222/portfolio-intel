import unittest

import numpy as np

from scripts.analytics import stats as S


class StatsTests(unittest.TestCase):
    def test_bh_known_values(self):
        adj = S.bh_adjust([0.01, 0.04, 0.03, 0.20])
        self.assertAlmostEqual(adj[0], 0.04)
        self.assertAlmostEqual(adj[2], 0.0533333, places=5)
        self.assertAlmostEqual(adj[1], 0.0533333, places=5)
        self.assertAlmostEqual(adj[3], 0.20)
        self.assertEqual(S.bh_adjust([]), [])

    def test_block_bootstrap_recovers_mean_and_ci(self):
        rng = np.random.default_rng(0)
        m = 60
        n = np.full(m, 20.0)
        s = rng.normal(2.0, 0.5, m) * n
        obs, boot = S.block_bootstrap({'s': s, 'n': n}, lambda t: t['s'] / t['n'], 3, 4000, np.random.default_rng(1))
        self.assertAlmostEqual(obs, s.sum() / n.sum())
        lo, hi = S.ci(boot)
        self.assertTrue(lo < 2.0 < hi)
        self.assertLess(S.p_two_sided(boot), 0.01)

    def test_null_gives_large_p(self):
        rng = np.random.default_rng(3)
        n = np.full(48, 10.0)
        s = rng.normal(0, 1, 48) * n
        _, boot = S.block_bootstrap({'s': s, 'n': n}, lambda t: t['s'] / t['n'], 3, 4000, np.random.default_rng(2))
        self.assertGreater(S.p_two_sided(boot), 0.05)

    def test_shrinkage_pulls_toward_mean_and_keeps_signal(self):
        shr, tau2, mu = S.shrink([10, 0, 0, 0], [3, 3, 3, 3])
        self.assertLess(shr[0], 10)
        self.assertGreater(shr[0], mu)
        shr2, tau2b, _ = S.shrink([10, -10, 5, -5], [0.1, 0.1, 0.1, 0.1])
        self.assertAlmostEqual(shr2[0], 10, delta=0.2)

    def test_by_level_never_narrower_than_95(self):
        self.assertEqual(S.by_level(0, 10, 0.1), 0.95)
        self.assertEqual(S.by_level(10, 10, 0.1), 0.95)
        self.assertGreater(S.by_level(1, 100, 0.1), 0.95)

    def test_deterministic_rng(self):
        a = S.rng_for('x', 42).random(3)
        b = S.rng_for('x', 42).random(3)
        c = S.rng_for('y', 42).random(3)
        self.assertTrue((a == b).all())
        self.assertFalse((a == c).all())


if __name__ == '__main__':
    unittest.main()
