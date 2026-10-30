-- Disclosed trades. Columns only, no filters from data. Read once per run.
SELECT id, chamber, member, ticker, asset, kind, tx_type, amount, amount_low, amount_high, traded, filed
FROM `portfolio-intel-512216.portfolio_intel.trades`
