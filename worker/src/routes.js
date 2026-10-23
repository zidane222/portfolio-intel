// Which service owns which paths. The gateway uses this to forward requests.
// Each service's own routes live in src/services/<name>.js.
export const OWNERS = [
  [/^\/api\/(prices|history|sectors|dividends)(\/|$)/, 'market', 'MARKET'],
  [/^\/api\/(news|feeds)(\/|$)/, 'news', 'NEWS'],
  [/^\/api\/top-rates$/, 'rates', 'RATES'],
  [/^\/api\/ai$/, 'ai', 'AI_SVC'],
  [/^\/api\/plaid\//, 'broker', 'BROKER'],
  [/^\/api\/all-trades$/, 'disclosures', 'DISCLOSURES'],
  [/^\/api\/private(\/stats)?$/, 'private', 'PRIVATE'],
];
export const ownerOf = path => OWNERS.find(([re]) => re.test(path)) || null;
