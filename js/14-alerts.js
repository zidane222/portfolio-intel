// ─────────────────────────────────────────────
//  ALERTS SETUP
// ─────────────────────────────────────────────
function renderAlerts() {
  let topic = null;
  try { topic = localStorage.getItem('pi.ntfy'); } catch (e) {}
  if (!topic || topic.startsWith('portfolio-intel-')) { // older short names are replaced with a longer random one
    const rnd = (crypto.getRandomValues ? [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(36).padStart(2, '0')).join('') : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
    topic = 'pi-' + rnd.slice(0, 28);
    try { localStorage.setItem('pi.ntfy', topic); } catch (e) {}
  }
  $('ntfy-topic').textContent = topic; $('v-topic').textContent = topic;
  $('v-tickers').textContent = [...followed()].join(',') || 'NVDA,VOO';
  let rule = {};
  try { rule = JSON.parse(localStorage.getItem('pi.alertrule')) || {}; } catch (e) {}
  const last = rule.members ? rule.members.split(/\s+/).slice(-1)[0] : 'Pelosi';
  $('v-members').textContent = last;
  $('v-sectors').textContent = rule.sectors || '(optional)';
  $('v-type').textContent = rule.type || '(optional)';
  $('v-min').textContent = rule.min ? String(rule.min) : '(optional)';
}
function wireCopyButtons() {
  document.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
    const text = $(b.dataset.copy).textContent;
    try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; }
    catch (e) { const r = document.createRange(); r.selectNodeContents($(b.dataset.copy)); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); b.textContent = 'Selected'; }
    setTimeout(() => b.textContent = 'Copy', 1600);
  });
}
