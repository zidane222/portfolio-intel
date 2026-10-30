-- News read verdicts for the A7 gate (progress counts only until the gate opens).
SELECT run_date, ticker, stance, status
FROM `portfolio-intel-512216.portfolio_intel.news_verdicts`
WHERE status = 'PASS'
