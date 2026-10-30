-- Daily prices from @start. Python picks adj_close or close per ticker (price_basis).
SELECT ticker, d, close, adj_close
FROM `portfolio-intel-512216.portfolio_intel.prices`
WHERE d >= @start
