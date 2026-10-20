// ─────────────────────────────────────────────
//  IMPORT: any document → holdings
// ─────────────────────────────────────────────
const LIBS = {
  // Exact versions, each checked against a fingerprint before it runs
  xlsx: ['https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', 'sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw'],
  pdf: ['https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js', 'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e'],
  pdfWorker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
  ocr: ['https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js', 'sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F'],
};
function importState(s, text) {
  $('import-card').style.display = s === 'review' ? 'none' : 'block';
  $('review').style.display = s === 'review' ? 'block' : 'none';
  $('fail').style.display = s === 'fail' ? 'block' : 'none';
  $('progress').style.display = s === 'busy' ? 'flex' : 'none';
  $('drop').style.display = s === 'busy' ? 'none' : 'flex';
  if (s === 'fail' && text) $('fail-text').textContent = text;
  if (s === 'busy' && text) $('progress-text').textContent = text;
  if (s === 'fail') $('import-card').style.display = 'none';
}
function splitCSVLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === ',' && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur); return out;
}
function parseCSV(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  let h = -1;
  for (let i = 0; i < Math.min(15, lines.length); i++) { const l = lines[i].toLowerCase(); if ((l.includes('symbol') || l.includes('ticker')) && (l.includes('quantity') || l.includes('shares') || l.includes('qty'))) { h = i; break; } }
  if (h < 0) return [];
  const hdr = splitCSVLine(lines[h]).map(x => x.replace(/"/g, '').trim().toLowerCase());
  const find = keys => { for (const k of keys) { const i = hdr.findIndex(x => x.includes(k)); if (i >= 0) return i; } return -1; };
  const cT = find(['symbol', 'ticker']), cS = find(['quantity', 'shares', 'qty']);
  const cC = find(['avg cost', 'average cost', 'unit cost', 'cost/share', 'cost per share', 'avg price', 'cost basis']);
  const cP = find(['last price', 'current price', 'market price', 'price']), cV = find(['market value', 'current value', 'total value', 'value']);
  const cN = find(['description', 'security', 'name', 'company']);
  const num = s => parseFloat(String(s || '').replace(/[$,%\s"]/g, '').replace(/^\((.*)\)$/, '-$1'));
  const rows = [];
  for (let i = h + 1; i < lines.length; i++) {
    const c = splitCSVLine(lines[i]);
    const ticker = String(c[cT] || '').replace(/"/g, '').trim().toUpperCase();
    if (!ticker || /^\d+$/.test(ticker) || /symbol|total|account/i.test(ticker)) continue;
    const shares = num(c[cS]);
    const price = num(c[cP]) || 0, value = num(c[cV]) || 0;
    const isCash = CASH_TICKERS.has(ticker) || /money market|cash/i.test(c[cN] || '') && !(shares > 0 && price > 1.01);
    if (!(shares > 0) && !(isCash && value > 0)) continue;
    let cost = num(c[cC]) || 0;
    // Some brokers export total cost basis; convert to per-share when it is clearly a total
    if (cost && price && shares > 1 && cost > price * 5) cost = cost / shares;
    rows.push({ticker, shares: shares || 0, avgCost: cost || 0, currentPrice: price, marketValue: value || shares * price, company: cN >= 0 ? String(c[cN] || '').replace(/"/g, '').trim() : '', isCash});
  }
  return rows;
}
function redact(text) {
  let lines = String(text).split(/\r?\n/);
  // Learn the owner's name from header lines like "JANE DOE Account Number: ..." and remove it everywhere
  const names = new Set();
  lines.forEach(l => { const m = l.match(/^\s*([A-Za-z][A-Za-z .'-]{2,50}?)\s+(account\s*(number|no\.?|#)|your .{0,30}(report|statement))/i); if (m && m[1].trim().split(/\s+/).length <= 5) names.add(m[1].trim()); });
  const firstLine = lines.find(l => l.trim());
  if (firstLine && /^[A-Z][A-Za-z.'-]+(\s+[A-Z][A-Za-z.'-]+){1,3}\s*$/.test(firstLine.trim())) names.add(firstLine.trim());
  names.forEach(n => { const re = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); lines = lines.map(l => l.replace(re, '')); });
  // Statements open with the owner's name and address: skip everything before the first financial heading
  const start = lines.findIndex(l => /portfolio|summary|holdings|assets|positions|symbol|quantity|account value|net worth|balance/i.test(l) && !/account number|access code/i.test(l));
  const SENSITIVE = [
    /account\s*(number|no\.?|#)|primary account|access code|routing|social security|ssn|tax id|date of birth/i,
    /\b\d{1,6}\s+[\w .'-]{0,40}\b(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|way|court|ct|circle|cir|place|pl|parkway|pkwy|highway|hwy|apt|suite|ste|unit)\b\.?(\s+#?\w{1,6})?\s*$/i,
    /\bp\.?\s?o\.?\s*box\b/i,
    /\b[A-Z][A-Za-z .'-]+,?\s+[A-Z]{2}\s+\d{5}(-\d{4})?\b/,
    /@[\w-]+\.[\w.]+|\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/,
  ];
  return lines.slice(Math.max(0, start))
    .filter(l => !SENSITIVE.some(r => r.test(l)))
    .join('\n')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[redacted]')
    .replace(/\b[A-Z0-9]{2,4}-[A-Z0-9]{2,4}[A-Z0-9-]*\b/g, m => /\d/.test(m) && /[A-Z]/.test(m) ? '[redacted]' : m)
    .replace(/\b[A-Z0-9]{0,4}\d{6,}[A-Z0-9-]*\b/g, '[redacted]')
    .split('\n').filter(l => /\d/.test(l) || /holdings|positions|cash|money market|deposit|equities|funds|symbol|description|quantity/i.test(l))
    .filter(l => !/^\s*(page \d|member sipc|investment products|are not fdic|important information)/i.test(l))
    .map(l => l.replace(/\s{2,}/g, ' ').trim()).filter(Boolean)
    .join('\n').slice(0, 24000);
}
async function aiExtract(text) {
  // The extraction instructions live on the server
  const req = () => getJSON(BACKEND_URL + '/api/ai', {method: 'POST', timeout: 120000, headers: {'Content-Type': 'application/json'}, body: JSON.stringify({mode: 'extract', question: redact(text)})});
  // Wake the server first, then retry once if the first try fails (cold start or a busy AI model)
  try { await getJSON(BACKEND_URL + '/health', {timeout: 60000}); } catch (e) {}
  let d;
  try { d = await req(); } catch (e) { if (e.status === 429 && /limit/i.test(e.message)) throw e; importState('busy', 'Still working, trying once more…'); await new Promise(r => setTimeout(r, 3000)); d = await req(); }
  if (d.error) throw new Error(d.error);
  const a = String(d.answer || '');
  let arr = [];
  try {
    const o = JSON.parse(a.slice(a.indexOf('{'), a.lastIndexOf('}') + 1));
    if (Array.isArray(o)) throw new Error('array');
    arr = Array.isArray(o.holdings) ? o.holdings : [];
    stmtInfo = o.statement_date && o.net_value > 0 ? {d: String(o.statement_date).slice(0, 10), v: +o.net_value} : null;
  } catch (err) {
    const s = a.indexOf('['), e = a.lastIndexOf(']');
    if (s < 0 || e < s) return [];
    try { arr = JSON.parse(a.slice(s, e + 1)); } catch (err2) { return []; }
  }
  return (Array.isArray(arr) ? arr : []).map(x => ({
    ticker: String(x.ticker || '').toUpperCase().trim(),
    shares: Number(x.shares) || 0,
    avgCost: Number(x.avgCost) || 0,
    company: String(x.name || ''),
    isCash: !!x.isCash || CASH_TICKERS.has(String(x.ticker || '').toUpperCase()),
    marketValue: Number(x.marketValue) || 0,
    apy: Number(x.apy) > 0 && Number(x.apy) < 20 ? Number(x.apy) : undefined,
  })).filter(x => x.ticker || x.isCash);
}
async function fileToText(file) {
  const name = file.name.toLowerCase(), type = file.type || '';
  if (/\.(csv|txt)$/.test(name) || type === 'text/csv') return {kind: 'csv', text: await file.text()};
  if (/\.(xlsx|xls)$/.test(name)) {
    importState('busy', 'Opening spreadsheet…');
    await loadScript(LIBS.xlsx);
    const wb = XLSX.read(await file.arrayBuffer(), {type: 'array'});
    const text = wb.SheetNames.map(n => XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n');
    return {kind: 'csv', text};
  }
  if (/\.pdf$/.test(name) || type === 'application/pdf') {
    importState('busy', 'Reading PDF…');
    await loadScript(LIBS.pdf);
    pdfjsLib.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker;
    let pdf;
    try { pdf = await pdfjsLib.getDocument({data: await file.arrayBuffer(), isEvalSupported: false}).promise; }
    catch (e) { throw new Error(/password/i.test(e.message) ? 'This PDF is password protected. Remove the password or upload a screenshot instead.' : 'This PDF could not be opened.'); }
    let text = '';
    for (let i = 1; i <= Math.min(pdf.numPages, 25); i++) {
      const c = await (await pdf.getPage(i)).getTextContent();
      let lastY = null;
      for (const it of c.items) { if (lastY !== null && Math.abs(it.transform[5] - lastY) > 2) text += '\n'; else text += ' '; text += it.str; lastY = it.transform[5]; }
      text += '\n';
    }
    if (text.replace(/\s/g, '').length < 40) throw new Error('This PDF looks like a scanned image. Upload a screenshot of it instead.');
    return {kind: 'text', text};
  }
  if (type.startsWith('image/') || /\.(png|jpe?g|webp|heic)$/.test(name)) {
    importState('busy', 'Reading screenshot…');
    await loadScript(LIBS.ocr);
    const r = await Tesseract.recognize(file, 'eng');
    const text = (r && r.data && r.data.text) || '';
    if (text.replace(/\s/g, '').length < 20) throw new Error('We couldn\'t read text in this image. Try a sharper screenshot of your positions page.');
    return {kind: 'text', text};
  }
  throw new Error('That file type isn\'t supported. Use a PDF, screenshot, spreadsheet, or CSV.');
}
async function handleFile(file) {
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) return importState('fail', 'That file is over 20 MB. Try a smaller export or a screenshot.');
  importState('busy', 'Reading your file…');
  try {
    const {kind, text} = await fileToText(file);
    let rows = kind === 'csv' ? parseCSV(text) : [];
    stmtInfo = null;
    if (!rows.length) { importState('busy', 'Finding your holdings… this can take up to a minute for long statements.'); rows = await aiExtract(text); }
    if (!rows.length) return importState('fail', 'We couldn\'t find holdings in this file. It may not be a statement, or the positions may be cut off. Try another file or add them by hand.');
    openReview(rows, file.name);
  } catch (e) {
    importState('fail', /HTTP|abort|fetch|unavailable/i.test(e.message) ? 'The reader is temporarily unavailable. Try again in a minute, or add holdings by hand.' : e.message);
  }
}
let draft = [];
let stmtInfo = null;
function openReview(rows, source) {
  draft = rows.map(r => ({...r}));
  importState('review');
  $('review-title').textContent = source ? `Found ${draft.filter(r => !r.isCash).length} holdings` : 'Your holdings';
  $('review-sub').textContent = source ? `From ${source}. Check the numbers. Nothing is saved until you confirm.` : 'Add a row for each stock or fund you own.';
  renderReview();
  $('review').scrollIntoView({behavior: reduced ? 'auto' : 'smooth', block: 'center'});
}
function rowFlags(r) {
  const f = [];
  if (!r.isCash && !/^[A-Z][A-Z0-9.\-]{0,6}$/.test(r.ticker)) f.push('ticker');
  if (!r.isCash && !(r.shares > 0)) f.push('shares');
  return f;
}
function renderReview() {
  const box = $('review-rows');
  box.innerHTML = draft.map((r, i) => {
    const f = rowFlags(r);
    return `<div class="review-row ${f.length ? 'flag' : ''}" data-i="${i}">
      <input aria-label="Ticker" class="${f.includes('ticker') ? 'f' : ''}" data-k="ticker" value="${esc(r.ticker)}" autocapitalize="characters">
      ${r.isCash
        ? `<input aria-label="Money market balance" data-k="marketValue" inputmode="decimal" value="${r.marketValue || ''}" placeholder="Balance $">`
        : `<input aria-label="Shares" class="${f.includes('shares') ? 'f' : ''}" data-k="shares" inputmode="decimal" value="${r.shares || ''}" placeholder="0">`}
      ${r.isCash ? `<input aria-label="Yield (APY %)" data-k="apy" inputmode="decimal" value="${r.apy || ''}" placeholder="APY %">` : `<input aria-label="Average cost" data-k="avgCost" inputmode="decimal" value="${r.avgCost || ''}" placeholder="Optional">`}
      <button class="icon-btn" type="button" aria-label="Remove ${esc(r.ticker || 'row')}" data-del="${i}"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>
    </div>`;
  }).join('') || '<div class="empty" style="padding:16px">No rows yet.</div>';
  const flagged = draft.filter(r => rowFlags(r).length).length;
  $('review-warn').style.display = flagged ? 'block' : 'none';
  $('review-warn').textContent = flagged ? `${flagged} ${flagged === 1 ? 'row needs' : 'rows need'} a look. Fix or remove the highlighted fields.` : '';
  box.querySelectorAll('input').forEach(inp => inp.oninput = () => {
    const i = +inp.closest('.review-row').dataset.i, k = inp.dataset.k;
    draft[i][k] = k === 'ticker' ? inp.value.toUpperCase().trim() : parseFloat(inp.value.replace(/[$,]/g, '')) || 0;
    const row = inp.closest('.review-row'), f = rowFlags(draft[i]);
    row.classList.toggle('flag', f.length > 0);
    row.querySelectorAll('input').forEach(x => x.classList.toggle('f', f.includes(x.dataset.k)));
  });
  box.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { draft.splice(+b.dataset.del, 1); renderReview(); });
}
function confirmReview() {
  const bad = draft.filter(r => rowFlags(r).length);
  if (bad.length) { $('review-warn').style.display = 'block'; $('review-warn').textContent = 'Fix or remove the highlighted rows before saving.'; return; }
  myPortfolio = draft.filter(r => r.isCash ? r.marketValue > 0 : r.shares > 0).map(r => ({...r, isCash: !!r.isCash}));
  savePortfolio();
  if (stmtInfo) saveSnap(stmtInfo.d, stmtInfo.v, 'statement');
  stmtInfo = null;
  importState('idle');
  $('file').value = '';
  refreshAll();
  $('overview').scrollIntoView({behavior: reduced ? 'auto' : 'smooth'});
}
function wireImport() {
  const drop = $('drop'), inp = $('file');
  inp.onchange = () => handleFile(inp.files[0]);
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => handleFile(e.dataTransfer.files[0]));
  const manual = () => openReview(myPortfolio.length ? myPortfolio : [{ticker: '', shares: 0, avgCost: 0}], null);
  $('manual').onclick = manual; $('fail-manual').onclick = manual; $('edit-holdings').onclick = manual;
  $('retry').onclick = () => { importState('idle'); inp.value = ''; inp.click(); };
  $('add-row').onclick = () => { draft.push({ticker: '', shares: 0, avgCost: 0}); renderReview(); };
  $('confirm').onclick = confirmReview;
  $('cancel').onclick = () => { importState('idle'); inp.value = ''; };
  $('clear-holdings').onclick = () => { if (confirm('Remove your saved portfolio from this device?')) { myPortfolio = []; savePortfolio(); delete shown.hero; refreshAll(); } };
}
