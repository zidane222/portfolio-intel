"""Pre-declared constants for the weekly analysis. Changing any value means a new method_version.
Nothing here is tuned on results: thresholds are fixed in advance (plan section 5.1, decision D9)."""
import math

METHOD_VERSION_DS = 'ds-1'
METHOD_VERSION_ST = 'st-1'

PROJECT = 'portfolio-intel-512216'
DATASET = 'portfolio_intel'

SEED = 42
RESAMPLES = 10000
FDR_Q = 0.10
SPLIT_DATE = '2024-01-01'          # discovery before, hold-out on or after. Reviewed once a year, never tuned.
HORIZONS = (30, 90, 180)
PRIMARY_HORIZON = 90
COST_BPS_ROUNDTRIP = 50
PLACEBO_PER_EVENT = 200
PLACEBO_DRAWS = 1000
MAX_FILING_LAG_DAYS = 365
PRICE_GAP_DAYS = 3                 # use the next trading day up to this many days when a price is missing

# Practical floor: minimum absolute net mean excess (percentage points) per horizon.
FLOOR_PT = {30: 0.5, 90: 1.5, 180: 3.0}

# Minimum samples: (events, months, tickers). Months must also be >= 4 x block length.
MIN_HEADLINE = (200, 24, 20)
MIN_MEMBER = (30, 12, 10)
MIN_SECTOR = (100, 24, 10)
MIN_BUCKET = 100                   # per bucket for A3 and A6

SIZE_BUCKETS = (('<=15K', 0, 15000), ('15K-50K', 15000, 50000), ('50K-250K', 50000, 250000), ('>250K', 250000, math.inf))
DELAY_BUCKETS = (('0-15', 0, 15), ('16-30', 16, 30), ('31-45', 31, 45), ('>45', 46, 10 ** 6))

# Strategies
COST_BPS_STOCK = 25
COST_BPS_ETF = 5
COPY_HOLD_DAYS = 90
COMMON_WINDOW_START = '2021-01-01'
TOP_MEMBERS = 5
TOP_MEMBERS_MIN_PURCHASES = 30
BAND_POINTS = 5.0
SECTOR_ETFS = ('XLK', 'XLF', 'XLV', 'XLY', 'XLP', 'XLE', 'XLI', 'XLB', 'XLU', 'XLRE', 'XLC')
DIVIDEND_ETFS = ('SCHD', 'VYM', 'DGRO', 'VIG')
REQUIRED_TICKERS = ('SPY', 'QQQ', 'SHV', 'IEF', 'AGG') + SECTOR_ETFS + DIVIDEND_ETFS
MIN_TICKER_COVERAGE = 0.95
MAX_SPY_AGE_DAYS = 5

# News stance gate (A7)
NEWS_MIN_SCORED = 200
NEWS_MIN_DAYS = 40
NEWS_MIN_PER_STANCE = 30

# BigQuery spend guard (bytes)
MAX_BYTES_PER_QUERY = 2 * 1024 ** 3
MAX_BYTES_PER_RUN = 5 * 1024 ** 3

STALE_DAYS = 10

LABEL_INSIGHTS = ('Historical analysis of public disclosures. Not investment advice. '
                  'Past results do not predict future results.')
LABEL_STRATEGIES = ('SIMULATED. Hypothetical backtests on past data. Not investment advice, not a recommendation, '
                    'no trades are placed. Past results do not predict future results.')

CAVEATS = {
    'amount_ranges': 'Amounts are disclosed ranges, not exact. Size buckets use the low end of the range. Dollar-weighted results are not computed.',
    'filing_delay': 'Filings arrive up to 45 days after the trade, sometimes later. Rows with a missing or impossible filing date are dropped and counted. Entering on the trade date is not achievable for the public.',
    'missing_tickers': 'Rows without a usable ticker (bonds, funds without symbols, private assets, options) are excluded and counted. Ticker renames and reuse can cause mismatches.',
    'survivorship': 'The price universe is the tickers Congress traded plus a fixed ETF set. Delisted or acquired names may be missing or cut short, which flatters stock-picking results.',
    'universe_bias': 'Congress trades large, popular US names. Doing better than SPY can reflect that tilt, so results are also compared with random picks from the same universe.',
    'short_history': 'About five years of data and one market regime. There are few independent windows at 180 days.',
    'price_basis': 'Prices use adjusted close when available, otherwise close (price return only, no dividends).',
    'owner_unknown': 'The data does not show whether a trade was the member\'s, a spouse\'s or a dependent\'s.',
    'no_wrongdoing': 'A statistical pattern in disclosed trades does not show use of nonpublic information.',
    'costs': 'Costs are assumptions, not measurements. No taxes, no market impact, execution at the close.',
    'data_license': 'Only derived aggregates are published, never raw filings or price series. Source terms apply.',
}
