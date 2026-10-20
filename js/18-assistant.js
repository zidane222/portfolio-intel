// ─────────────────────────────────────────────
//  FLOATING ASSISTANT (pop-up chat)
// ─────────────────────────────────────────────
let chat = [];
try { chat = JSON.parse(sessionStorage.getItem('pi.chat')) || []; } catch (e) {}
function chatSuggestions() {
  const s = [];
  if (myPortfolio.length) {
    if (myPortfolio.some(h => h.isCash)) s.push('How much more could my cash earn?');
    s.push('Am I too heavy in cash?', 'Which of my stocks is Congress trading?', 'Explain my risk level');
  } else s.push('How do I add my portfolio?');
  s.push('What is Congress buying this month?', 'Who is the best politician to copy?', 'Any big insider buys this week?');
  return s.slice(0, 5);
}
function renderChat() {
  const box = $('as-msgs');
  if (!chat.length) {
    box.innerHTML = `<div class="as-hello"><div class="as-hi">Hi, how can I help?</div><div class="as-sub">I can see your portfolio, live prices, Congress filings, insider buys and cash rates.</div>
      <div class="as-chips">${chatSuggestions().map(q => `<button type="button" class="as-chip">${esc(q)}</button>`).join('')}</div></div>`;
    box.querySelectorAll('.as-chip').forEach(b => b.onclick = () => sendChat(b.textContent));
  } else {
    box.innerHTML = chat.map(m => `<div class="as-m ${m.role}">${m.role === 'bot' ? '' : ''}<div class="as-b">${esc(m.text)}</div></div>`).join('')
      + (chat.busy ? '<div class="as-m bot"><div class="as-b as-typing" aria-label="Thinking"><span></span><span></span><span></span></div></div>' : '');
  }
  box.scrollTop = box.scrollHeight;
  try { sessionStorage.setItem('pi.chat', JSON.stringify(chat.slice(-30))); } catch (e) {}
}
async function sendChat(q) {
  q = (q || '').trim(); if (!q || chat.busy) return;
  const hist = chat.slice();
  chat.push({role: 'user', text: q}); chat.busy = true; renderChat();
  $('as-in').value = ''; $('as-send').disabled = true;
  try { chat.push({role: 'bot', text: await askAI(q, hist)}); }
  catch (e) { chat.push({role: 'bot', text: e.status === 429 ? e.message : 'I can\'t reach the assistant right now. Try again in a minute.'}); }
  chat.busy = false; $('as-send').disabled = false; renderChat();
  if (matchMedia('(hover: hover)').matches) $('as-in').focus();
}
function openAssist(open) {
  const panel = $('as-panel'), fab = $('as-fab');
  const on = open === undefined ? panel.hidden : open;
  panel.hidden = !on; fab.setAttribute('aria-expanded', on);
  fab.classList.toggle('open', on);
  if (on) { renderChat(); setTimeout(() => { if (matchMedia('(hover: hover)').matches) $('as-in').focus(); }, 50); }
  else fab.focus();
}
function wireAssist() {
  $('as-fab').onclick = () => openAssist();
  $('as-close').onclick = () => openAssist(false);
  $('as-clear').onclick = () => { chat = []; renderChat(); };
  $('as-form').onsubmit = e => { e.preventDefault(); sendChat($('as-in').value); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('as-panel').hidden) openAssist(false); });
  // Tap or click anywhere outside the chat to close it
  document.addEventListener('pointerdown', e => { if (!$('as-panel').hidden && !e.target.closest('#as-panel, #as-fab, #tk-sheet')) openAssist(false); });
}

function wireAsk() {
  $('presets').innerHTML = [...new Set([...chatSuggestions().slice(0, 3), ...PRESETS])].slice(0, 5).map(p => `<button class="preset" type="button">${esc(p)}</button>`).join('');
  $('presets').querySelectorAll('.preset').forEach(b => b.onclick = () => { $('ask-q').value = b.textContent; ask(b.textContent); });
  $('ask-form').onsubmit = e => { e.preventDefault(); ask($('ask-q').value); };
}
