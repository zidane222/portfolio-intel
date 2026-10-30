// ─────────────────────────────────────────────
//  PAGES: one section group at a time instead of one long scroll
// ─────────────────────────────────────────────
// Every old #section link still works: it opens the page that holds that section.
// Order follows the questions a visitor asks next ("why?"), so each page answers the last one.
const PAGES = [
  {id: 'home', label: 'Home', sections: ['overview', 'performance', 'compare', 'mix', 'signals']},
  {id: 'disclosures', label: 'Disclosures', sections: ['disclosures'], ask: 'Why? See what they\'re buying'},
  {id: 'leaders', label: 'Leaderboard', sections: ['leaders'], ask: 'Who\'s best at it?'},
  {id: 'smart', label: 'Smart money', sections: ['smart'], ask: 'Do insiders and top investors agree?'},
  {id: 'portfolio', label: 'Portfolio', sections: ['review-sec', 'holdings', 'import'], ask: 'What does it mean for my portfolio?'},
  {id: 'risk', label: 'Risk', sections: ['risk'], ask: 'Am I taking too much risk?'},
  {id: 'cash', label: 'Cash & yield', sections: ['cash'], ask: 'Is my cash earning enough?'},
  {id: 'dividends', label: 'Dividends', sections: ['dividends'], ask: 'Could I earn more income?'},
  {id: 'private', label: 'Private markets', sections: ['private'], ask: 'What about companies that aren\'t public yet?'},
  {id: 'insights', label: 'Insights', sections: ['insights'], ask: 'What does the history actually show?'},
  {id: 'copy', label: 'Copy test', sections: ['copy'], ask: 'What if I had followed them?'},
  {id: 'news', label: 'News', sections: ['news'], ask: 'What\'s happening right now?'},
  // One page, two menu links that jump to each part
  {id: 'ask', label: 'Ask & alerts', sections: ['ask', 'alerts'], links: [['ask', 'Ask'], ['alerts', 'Alerts']], ask: 'Still have a question? Ask, or set alerts'},
  // The original single long page, everything in its first order and colors
  {id: 'all', label: 'See it all', all: true, ask: 'Or see it all on one page'},
];
const ALL_IDS = () => [...document.querySelectorAll('main section[id]')].map(s => s.id);
// Where each section sat inside its background band on the original long page (top, bottom as a
// fraction of the band), measured from the one-page layout. Each page shows exactly that slice of
// the gradient, so every section keeps the colors it always had.
const BAND = {
  wide: {overview: [0, .0377], performance: [.0377, .1068], compare: [.1068, .1556], copy: [.1556, .2515], smart: [.2515, .5663],
    leaders: [.5663, .6877], mix: [.6877, .7625], disclosures: [.7625, 1], 'review-sec': [.007, .1743], holdings: [.1743, .2444],
    import: [.2444, .3426], cash: [.3426, .6242], dividends: [.6242, .6775], risk: [.6775, .7298], news: [.7298, .7816],
    ask: [.7816, .8353], alerts: [.8353, .9357], signals: [.9357, .9814]},
  narrow: {overview: [0, .0262], performance: [.0262, .0954], compare: [.0954, .2011], copy: [.2011, .2875], smart: [.2875, .6366],
    leaders: [.6366, .7331], mix: [.7331, .8018], disclosures: [.8018, 1], 'review-sec': [.0048, .1807], holdings: [.1807, .234],
    import: [.234, .325], cash: [.325, .6674], dividends: [.6674, .7039], risk: [.7039, .7397], news: [.7397, .7751],
    ask: [.7751, .8278], alerts: [.8278, .9304], signals: [.9304, .984]},
};
function paintBands() {
  if (currentPage === 'all') {
    document.querySelectorAll('main > .zone-dark, main > .zone-light, main section[id]').forEach(el => { el.style.background = ''; el.style.backgroundSize = ''; el.style.backgroundPosition = ''; });
    return;
  }
  const table = innerWidth < 700 ? BAND.narrow : BAND.wide;
  document.querySelectorAll('main > .zone-dark, main > .zone-light').forEach(z => {
    const grad = getComputedStyle(z).backgroundImage;
    let lastSlice = null;
    z.querySelectorAll('section[id]').forEach(sec => {
      const r = table[sec.id];
      if (!sec.classList.contains('page-on') || !r) { sec.style.background = ''; return; }
      // Each section shows exactly the part of the band it covered on the original long page
      const h = sec.getBoundingClientRect().height, full = h / Math.max(r[1] - r[0], 0.005);
      sec.style.background = `${grad} 0 ${-r[0] * full}px / 100% ${full}px no-repeat`;
      lastSlice = [r[1], full];
    });
    // Space below the last section (the Next button) continues the same gradient
    if (lastSlice) { z.style.backgroundSize = `100% ${lastSlice[1]}px`; z.style.backgroundPosition = `0 ${-lastSlice[0] * lastSlice[1] + (z.getBoundingClientRect().height - 0)}px`; }
    else z.style.backgroundSize = z.style.backgroundPosition = '';
  });
}

const pageOf = id => PAGES.find(p => p.id === id || (p.sections || []).includes(id)) || PAGES[0];
const secsOf = p => p.all ? ALL_IDS() : p.sections;
let currentPage = null;

function showPage(target, {scroll = true} = {}) {
  const page = pageOf(target);
  const changed = currentPage !== page.id;
  currentPage = page.id;
  document.querySelectorAll('main section[id]').forEach(el => el.classList.toggle('page-on', secsOf(page).includes(el.id)));
  document.body.classList.toggle('page-all', !!page.all);
  // Hide the dark or light background band when none of its sections are on this page
  document.querySelectorAll('main > .zone-dark, main > .zone-light').forEach(z => z.classList.toggle('zone-off', !z.querySelector('section.page-on')));
  const pageLinks = [...document.querySelectorAll(`.navlinks a[data-page="${page.id}"]`)];
  const exact = pageLinks.find(a => a.getAttribute('href') === '#' + target);
  const activeLink = exact || pageLinks[0];
  document.querySelectorAll('.navlinks a').forEach(a => {
    const on = a === activeLink;
    a.classList.toggle('active', on);
    if (on) { a.setAttribute('aria-current', 'page'); const row = a.parentElement; if (row.scrollWidth > row.clientWidth) row.scrollTo({left: a.offsetLeft - 14, behavior: reduced ? 'auto' : 'smooth'}); }
    else a.removeAttribute('aria-current');
  });
  document.querySelectorAll('.page-next').forEach(b => b.hidden = b.dataset.page !== page.id);
  document.title = page.id === 'home' ? 'Portfolio Intel' : `${page.label} · Portfolio Intel`;
  // Show anything on the page that animates in on scroll, and let charts measure their new size
  document.querySelectorAll('section.page-on .reveal').forEach(e => e.classList.add('in'));
  window.dispatchEvent(new Event('resize'));
  paintBands();
  if (!scroll) return;
  const first = secsOf(page)[0];
  if (changed && (target === page.id || target === first)) window.scrollTo({top: 0, behavior: 'auto'});
  else { const el = ALL_IDS().includes(target) ? $(target) : null; if (el) el.scrollIntoView({behavior: changed || reduced ? 'auto' : 'smooth', block: 'start'}); }
}

function wirePages() {
  document.body.classList.add('paged');
  // Top menu: one link per page
  $('navlinks').innerHTML = PAGES.map(p => (p.links || [[p.all ? 'all' : p.sections[0], p.label]]).map(([h, l]) => `<a href="#${h}" data-page="${p.id}">${esc(l)}</a>`).join('')).join('');
  // "Next" button at the end of every page
  PAGES.forEach((p, i) => {
    const next = PAGES[i + 1]; if (!next || p.all) return;
    const last = $(p.sections[p.sections.length - 1]); if (!last) return;
    const wrap = document.createElement('div');
    wrap.className = 'page-next'; wrap.dataset.page = p.id;
    wrap.innerHTML = `<a class="btn glass" href="#${next.all ? 'all' : next.sections[0]}">${esc(next.ask || 'Next: ' + next.label)} →</a>`;
    last.appendChild(wrap);
  });
  // Keep the background slice right as content loads in or the window resizes
  if ('ResizeObserver' in window) { const ro = new ResizeObserver(() => paintBands()); document.querySelectorAll('main > .zone-dark, main > .zone-light').forEach(z => ro.observe(z)); }
  addEventListener('resize', paintBands);
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
