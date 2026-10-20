// ─────────────────────────────────────────────
//  PAGES: one section group at a time instead of one long scroll
// ─────────────────────────────────────────────
// Every old #section link still works: it opens the page that holds that section.
const PAGES = [
  {id: 'home', label: 'Home', sections: ['overview', 'performance', 'compare', 'mix', 'signals']},
  {id: 'copy', label: 'Copy test', sections: ['copy']},
  {id: 'smart', label: 'Smart money', sections: ['smart']},
  {id: 'leaders', label: 'Leaderboard', sections: ['leaders']},
  {id: 'disclosures', label: 'Disclosures', sections: ['disclosures']},
  {id: 'portfolio', label: 'Portfolio', sections: ['review-sec', 'holdings', 'import']},
  {id: 'cash', label: 'Cash & yield', sections: ['cash']},
  {id: 'dividends', label: 'Dividends', sections: ['dividends']},
  {id: 'risk', label: 'Risk', sections: ['risk']},
  {id: 'news', label: 'News', sections: ['news']},
  {id: 'ask', label: 'Ask', sections: ['ask']},
  {id: 'alerts', label: 'Alerts', sections: ['alerts']},
];
const pageOf = id => PAGES.find(p => p.id === id || p.sections.includes(id)) || PAGES[0];
let currentPage = null;

function showPage(target, {scroll = true} = {}) {
  const page = pageOf(target);
  const changed = currentPage !== page.id;
  currentPage = page.id;
  PAGES.forEach(p => p.sections.forEach(s => { const el = $(s); if (el) el.classList.toggle('page-on', p.id === page.id); }));
  // Hide the dark or light background band when none of its sections are on this page
  document.querySelectorAll('main > .zone-dark, main > .zone-light').forEach(z => z.classList.toggle('zone-off', !z.querySelector('section.page-on')));
  document.querySelectorAll('.navlinks a').forEach(a => {
    const on = a.dataset.page === page.id;
    a.classList.toggle('active', on);
    if (on) { a.setAttribute('aria-current', 'page'); const row = a.parentElement; if (row.scrollWidth > row.clientWidth) row.scrollTo({left: a.offsetLeft - 14, behavior: reduced ? 'auto' : 'smooth'}); }
    else a.removeAttribute('aria-current');
  });
  document.querySelectorAll('.page-next').forEach(b => b.hidden = b.dataset.page !== page.id);
  document.title = page.id === 'home' ? 'Portfolio Intel' : `${page.label} · Portfolio Intel`;
  // Show anything on the page that animates in on scroll, and let charts measure their new size
  document.querySelectorAll('section.page-on .reveal').forEach(e => e.classList.add('in'));
  window.dispatchEvent(new Event('resize'));
  if (!scroll) return;
  const first = page.sections[0];
  if (changed && (target === page.id || target === first)) window.scrollTo({top: 0, behavior: 'auto'});
  else { const el = $(target); if (el) el.scrollIntoView({behavior: changed || reduced ? 'auto' : 'smooth', block: 'start'}); }
}

function wirePages() {
  document.body.classList.add('paged');
  // Top menu: one link per page
  $('navlinks').innerHTML = PAGES.map(p => `<a href="#${p.sections[0]}" data-page="${p.id}">${esc(p.label)}</a>`).join('');
  // "Next" button at the end of every page
  PAGES.forEach((p, i) => {
    const next = PAGES[i + 1]; if (!next) return;
    const last = $(p.sections[p.sections.length - 1]); if (!last) return;
    const wrap = document.createElement('div');
    wrap.className = 'page-next'; wrap.dataset.page = p.id;
    wrap.innerHTML = `<a class="btn glass" href="#${next.sections[0]}">Next: ${esc(next.label)} →</a>`;
    last.appendChild(wrap);
  });
  const go = () => showPage(decodeURIComponent(location.hash.slice(1)) || 'overview');
  window.addEventListener('hashchange', go);
  // Links to the page you are already on (e.g. tapping Home again) still scroll to the top
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href^="#"]'); if (!a) return;
    const id = a.getAttribute('href').slice(1);
    if ('#' + id === location.hash) { e.preventDefault(); showPage(id); }
  });
  go();
}
