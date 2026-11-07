// Which service owns which paths. The gateway uses this to forward requests.
// The 4th column is the feature flag for the row (lib/flags.js); null means only maintenance applies.
// Each service's own routes live in src/services/<name>.js.
export const OWNERS = [
  [/^\/api\/(prices|history|sectors|dividends)(\/|$)/, 'market', 'MARKET', 'market'],
  [/^\/api\/(news|feeds)(\/|$)/, 'news', 'NEWS', 'news'],
  [/^\/api\/top-rates$/, 'rates', 'RATES', null],
  [/^\/api\/ai$/, 'ai', 'AI_SVC', 'ai'],
  [/^\/api\/plaid\//, 'broker', 'BROKER', 'broker'],
  [/^\/api\/all-trades$/, 'disclosures', 'DISCLOSURES', 'disclosures'],
  [/^\/api\/private(\/stats)?$/, 'private', 'PRIVATE', null],
  [/^\/api\/insights(\/strategies)?$/, 'insights', 'INSIGHTS', null],
  [/^\/api\/newsdesk\/(read|reads)$/, 'newsdesk', 'NEWSDESK', 'news'], // both special-cased in index.js; listed for health and the 503 path
];
export const ownerOf = path => OWNERS.find(([re]) => re.test(path)) || null;
