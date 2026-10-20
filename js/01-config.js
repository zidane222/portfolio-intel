// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────
// API: Cloudflare Worker first; the old Render server answers only if the Worker fails.
const BACKEND_URL = 'https://portfolio-intel-api.viphashkahn.workers.dev';
const FALLBACK_URL = 'https://portfolio-intel-escf.onrender.com';
const STORE_KEY = 'pi.portfolio.v2';
const WATCH_KEY = 'pi.watch.v1';

// Reference baskets. Nothing here is a guess at share counts.
// Pelosi: built at load time from her House filings (buildPelosiRef).
// Trump: only the DJT stake reported in SEC filings (Form 4, 114,750,000 shares held by his revocable trust).
// His other assets are private or reported only in value ranges in OGE reports, so they are not modeled.
const REF = {
  pelosi: [],
  trump: [
    {ticker:'DJT',shares:114750000,sector:'Communication Services',src:'SEC Form 4'},
  ],
};
function amountMid(a) {
  const n = String(a || '').match(/[\d,]+/g); if (!n) return 0;
  const v = n.map(x => +x.replace(/,/g, '')).filter(Boolean);
  return v.length > 1 ? (v[0] + v[1]) / 2 : v[0] || 0;
}
// Stocks she has bought and not sold since, sized by the middle of each reported range.
function buildPelosiRef() {
  const rows = trades.filter(t => /pelosi/i.test(t.representative) && t.ticker && !t.private && /^(Purchase|Sale)/.test(t.type))
    .sort((x, y) => (x.date || '').localeCompare(y.date || '') || (/^Sale/.test(x.type) ? -1 : 1));
  const m = {};
  rows.forEach(t => {
    if (/^Sale/.test(t.type)) delete m[t.ticker];
    else m[t.ticker] = {ticker: t.ticker, usd: (m[t.ticker] ? m[t.ticker].usd : 0) + amountMid(t.amount), sector: t.sector || sectorOf(t.ticker) || 'Other', since: t.date};
  });
  REF.pelosi = Object.values(m).sort((x, y) => y.usd - x.usd).slice(0, 15).map(h => ({...h, shares: 0}));
  sizeRef();
}
function sizeRef() { REF.pelosi.forEach(h => { const p = prices[h.ticker]; if (p && p.price) { h.shares = h.usd / p.price; h.cost = p.price; } }); }
const CASH_TICKERS = new Set(['MLPDA','TMCXX','SPAXX','FDRXX','VMFXX','VMMXX','SWVXX','SPRXX','CASH','MMDA','QACDS']);
// Known sectors so the pie works instantly; anything else is looked up once and cached on the device
const SECTOR_MAP = {
  'Technology': 'AAPL MSFT NVDA AMD AVGO ORCL CRM ADBE INTC QCOM TXN CSCO IBM CRWD PANW NOW SNOW PLTR MU AMAT LRCX KLAC SHOP UBER INTU ANET SMCI DELL ARM MRVL',
  'Communication Services': 'GOOGL GOOG META NFLX DIS T VZ TMUS CMCSA DJT SPOT RDDT PINS SNAP',
  'Consumer Cyclical': 'AMZN TSLA HD MCD NKE SBUX LOW BKNG TJX GM F RIVN ABNB CMG LULU',
  'Consumer Defensive': 'WMT COST PG KO PEP PM MO MDLZ CL TGT KR',
  'Financial Services': 'JPM BAC WFC C GS MS V MA AXP SCHW BLK BRK.B BRK-B PYPL SQ XYZ COIN HOOD SOFI',
  'Healthcare': 'UNH JNJ LLY PFE MRK ABBV TMO ABT DHR BMY AMGN GILD CVS ISRG NVO',
  'Energy': 'XOM CVX COP SLB EOG OXY PSX MPC KMI',
  'Industrials': 'BA CAT GE HON UPS RTX LMT DE UNP NOC GD MMM',
  'Utilities': 'NEE DUK SO D AEP',
  'Real Estate': 'GEO PLD AMT O SPG EQIX',
  'Basic Materials': 'LIN NEM FCX DOW',
  'Funds & ETFs': 'VOO SPY IVV VTI QQQ QQQM DIA SCHD VUG VGT VXUS VEA VWO BND AGG GLD SLV IAU TLT ARKK XLK XLF XLE SOXX SMH IWM VYM JEPI',
};
const SECTOR_OF = {};
Object.entries(SECTOR_MAP).forEach(([sec, list]) => list.split(' ').forEach(t => SECTOR_OF[t] = sec));
const SECTOR_KEY = 'pi.sectors.v1';
const MIX_COLORS = ['#0A84FF','#64D2FF','#BF5AF2','#FF9F0A','#30D158','#FF375F','#FFD60A','#5E5CE6'];
const BANNER_EXTRA = ['SPY','QQQ','DIA'];
const RANGES = [['1D','1d'],['1W','5d'],['1M','1mo'],['6M','6mo'],['YTD','ytd'],['1Y','1y'],['5Y','5y']];
const SERIES = [
  {key:'me',label:'You',color:'#F5F5F7',width:3},
  {key:'pelosi',label:'Pelosi',color:'#0A84FF',width:2,area:true},
  {key:'trump',label:'Trump',color:'#FF9F0A',width:2},
  {key:'voo',label:'VOO',color:'#8E9BB3',width:2,dashed:true},
];
