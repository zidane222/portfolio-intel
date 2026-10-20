// ─────────────────────────────────────────────
//  ASK
// ─────────────────────────────────────────────
const PRESETS = ['Should I follow Pelosi\'s trades?', 'Which of my stocks is Congress buying?', 'Compare my risk to Trump\'s portfolio', 'What sectors is Congress buying this month?'];
// Everything the assistant knows: the same live data shown on the page
function buildContext() {
  const L = [];
  L.push(`Today: ${new Date().toISOString().slice(0, 10)}.`);
  const priceCtx = Object.entries(prices).slice(0, 45).map(([t, p]) => `${t} $${p.price} (${pct(p.change_pct, 2)})`).join(', ');
  if (priceCtx) L.push(`Live prices (change is the latest session): ${priceCtx}`);
  if (myPortfolio.length) {
    const tot = myPortfolio.reduce((s, h) => s + valueOf(h), 0);
    L.push(`USER PORTFOLIO, total ${usd(tot)}:`);
    myPortfolio.forEach(h => {
      if (h.isCash) L.push(`- ${h.ticker} (cash/money market): ${usd(h.marketValue || 0)}${h.apy ? ` earning ${h.apy}% APY (${usd(incomeOf(h), 0)}/yr)` : ', yield unknown'}`);
      else { const p = priceOf(h.ticker, 0); L.push(`- ${h.ticker}: ${h.shares} sh, value ${usd(valueOf(h))}${h.avgCost ? `, cost ${usd(h.avgCost)}/sh, gain ${pct((p - h.avgCost) / h.avgCost * 100)}` : ''}${divData[h.ticker] ? `, dividend yield ${divData[h.ticker].yield}%` : ''}, ${classOf(h)}`); }
    });
    const inc = myPortfolio.reduce((s, h) => s + incomeOf(h), 0);
    const cls = {}; myPortfolio.forEach(h => cls[classOf(h)] = (cls[classOf(h)] || 0) + valueOf(h));
    L.push(`Allocation: ${Object.entries(cls).map(([k, v]) => `${k} ${(v / tot * 100).toFixed(1)}%`).join(', ')}. Estimated annual income ${usd(inc, 0)}.`);
    const snapStmt = snapshots.filter(x => x.src === 'statement').pop();
    if (snapStmt) L.push(`Last uploaded statement: ${usd(snapStmt.v)} on ${snapStmt.d}.`);
  } else L.push('User has not added a portfolio yet.');
  if (watchlist.length) L.push(`Watchlist: ${watchlist.join(', ')}`);
  if (Object.keys(lastReturns).length) L.push(`Chart returns over ${range}: ` + Object.entries(lastReturns).map(([k, v]) => `${k} ${pct(v)}`).join(', '));
  if (yields && yields.curve) L.push(`Treasury yields ${yields.date}: ` + Object.entries(yields.curve).map(([k, v]) => `${k} ${v}%`).join(', '));
  try {
    const opts = cashOptions().filter(o => !o.promo).sort((x, y) => y.apy - x.apy).slice(0, 8);
    if (opts.length) L.push('Cash options: ' + opts.map(o => `${o.name.split(' · ')[0]} ${o.apy}%${o.min ? ` (min ${usd(o.min, 0)})` : ''}${o.cap ? ` (only first ${usd(o.cap, 0)})` : ''} [${o.catName}]`).join('; '));
  } catch (e) {}
  L.push(`Pelosi basket (stocks bought in her filings and not sold since; not her full portfolio): ${REF.pelosi.map(h => h.ticker).join(', ')}. Trump disclosed public stock (SEC filings; other assets private): ${REF.trump.map(h => h.ticker).join(', ')}.`);
  const tr = trades.slice(0, 50).map(t => `${t.filed || t.date} ${nameOf(t.representative)} ${/purchase/i.test(t.type) ? 'BUY' : 'SELL'} ${t.ticker || t.description + ' (private)'} ${t.amount}${t.committees && t.committees.length ? ' [committee overlap]' : ''}`);
  if (tr.length) L.push('Recent congressional filings (newest first):\n' + tr.join('\n'));
  if (insiderBuys.length) L.push('Recent insider purchases: ' + insiderBuys.slice(0, 12).map(b => `${b.ticker} ${compact(b.value)} by ${b.role} (${b.filed})`).join('; '));
  const invs = (smart.investors || []).filter(x => x.quarters && x.quarters[0]);
  if (invs.length) L.push('Famous investors top holdings: ' + invs.map(x => `${x.name}: ${x.quarters[0].holdings.slice(0, 5).map(h => h.ticker || h.name).join(', ')}`).join('; '));
  return L.join('\n').slice(0, 14000);
}
// The assistant's instructions live on the server (backend/main.py, AI_MODES).
async function askAI(question, history) {
  const convo = (history || []).slice(-8).map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n');
  const d = await getJSON(BACKEND_URL + '/api/ai', {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({mode: 'assistant', context: buildContext(), question: (convo ? 'Conversation so far:\n' + convo + '\n\nNew question: ' : '') + question})});
  if (d.error) throw new Error(d.error);
  return (d.answer || 'No answer came back. Try rephrasing.').replace(/\*\*|__|^#+\s/gm, '').trim();
}
async function ask(q) {
  q = (q || '').trim(); if (!q) return;
  const btn = $('ask-go'), out = $('answer');
  btn.disabled = true; btn.textContent = 'Thinking…'; out.textContent = '';
  try { out.textContent = await askAI(q); }
  catch (e) { out.textContent = 'The assistant is unavailable right now. Try again in a minute.'; }
  btn.disabled = false; btn.textContent = 'Ask';
}
