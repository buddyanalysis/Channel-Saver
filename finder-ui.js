/**
 * Niche Finder page (dashboard). Sections like Nexlev's home page, each with
 * its own period picker: outlier channels, niches with high future competition,
 * trending keywords, most popular categories and viral videos on small channels.
 * The data comes from live YouTube scans run by the background (lib/finder.js);
 * every period's last scan is kept in storage.local.finder.results.
 */
import { WINDOWS, DEFAULT_CATEGORIES } from './lib/finder.js';

let ctx; // { h, set, send, toast, fmtNum, fmtAge, getDb, $, openSimilar }

/** The Niche Finder's own pages (shown in the sidebar while inside the tool). */
export const FINDER_TABS = [
  ['overview', '🏠 Overview'],
  ['outliers', '🚀 Outlier channels'],
  ['rising', '📈 Future competition'],
  ['viral', '🔥 Viral videos'],
  ['keywords', '🔑 Keywords'],
  ['cats', '🗂 Categories'],
];
let tab = 'overview';
export const finderTab = () => tab;
export function setFinderTab(t) {
  tab = FINDER_TABS.some(([k]) => k === t) ? t : 'overview';
  ui.more = {};
}
const ui = {
  sec: { outliers: 'day', rising: 'week', keywords: 'day', cats: 'day', viral: 'day' },
  maxSubs: 50000,
  lang: 'any',
  query: '',
  viralSort: 'ratio',
  viralCat: '',
  seed: 0,
  more: {},
};

export function initFinder(c) {
  ctx = c;
  try {
    const saved = JSON.parse(localStorage.getItem('cs-finder-ui') || '{}');
    Object.assign(ui.sec, saved.sec || {});
    if (saved.maxSubs) ui.maxSubs = saved.maxSubs;
    if (saved.lang) ui.lang = saved.lang;
  } catch {}
}
const remember = () => {
  try {
    localStorage.setItem('cs-finder-ui', JSON.stringify({ sec: ui.sec, maxSubs: ui.maxSubs, lang: ui.lang }));
  } catch {}
};

let state = {}; // storage.local.finder
let subsCount = 0;

async function load() {
  const s = await chrome.storage.local.get(['finder', 'finderSubs']);
  state = s.finder || {};
  subsCount = Object.keys(s.finderSubs || {}).length;
}

const ytVideo = (id) => `https://www.youtube.com/watch?v=${id}`;
const ytChannel = (c) => (c.handle ? `https://www.youtube.com/${c.handle}` : `https://www.youtube.com/channel/${c.channelId}`);
const thumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const x = (n) => (n >= 10 ? `${Math.round(n)}×` : `${n.toFixed(1)}×`);
const ageText = (d) => (d == null ? '' : d < 1 ? `${Math.max(1, Math.round(d * 24))}h ago` : d < 30 ? `${Math.round(d)}d ago` : ctx.fmtAge(d));

async function scan(window) {
  try {
    const r = await ctx.send('nicheScan', { window, maxSubs: ui.maxSubs, lang: ui.lang });
    if (r && !r.started && r.running) ctx.toast('A scan is already running');
  } catch (e) {
    ctx.toast(e.message, true);
  }
}

/* ---------- pieces ---------- */

function periodPicker(key) {
  const { h } = ctx;
  return h('div.fd-tabs', Object.entries(WINDOWS).map(([k, w]) => h('button.fd-tab' + (ui.sec[key] === k ? '.on' : ''), {
    onclick: () => { ui.sec[key] = k; remember(); paint(); },
  }, w.label)));
}

function section(key, title, body, extra = null) {
  const { h } = ctx;
  // On the Overview each card links to its own full page ("View all").
  const viewAll = tab === 'overview' ? h('button.fd-viewall', { onclick: () => { setFinderTab(key); ctx.rerender(); } }, 'View all →') : null;
  return h(`section.fd-sec.fd-sec-${key}`,
    h('div.fd-sec-head', h('h2', title), h('div.fd-row', extra, viewAll)),
    periodPicker(key),
    body);
}

/** Result for a section's period, or an inline "scan" prompt. */
function resultFor(key) {
  const w = ui.sec[key];
  const r = state.results?.[w];
  if (r) return { r };
  const { h } = ctx;
  const running = state.status === 'running' && state.options?.window === w;
  return {
    empty: h('div.fd-empty', running
      ? h('span', `Scanning ${WINDOWS[w].label.toLowerCase()}…`)
      : [h('span', `Not scanned for ${WINDOWS[w].label.toLowerCase()} yet. `), h('button.btn.small', { onclick: () => scan(w) }, `Scan ${WINDOWS[w].label.toLowerCase()}`)]),
  };
}

function strength(xv) {
  const { h } = ctx;
  const lit = xv >= 20 ? 4 : xv >= 10 ? 3 : xv >= 5 ? 2 : 1;
  return h('span.fd-dashes' + (lit >= 3 ? '.hot' : ''), [1, 2, 3, 4].map((i) => h('i' + (i <= lit ? '.on' : ''))));
}

function channelRow(c, { full = false } = {}) {
  const { h, fmtNum } = ctx;
  const saved = !!ctx.getDb().channels[c.channelId];
  const save = h('button.btn.small' + (saved ? '' : '.primary'), { disabled: saved, title: 'Save to My Library', onclick: async (e) => {
    e.preventDefault();
    e.currentTarget.disabled = true;
    try {
      await ctx.send('add', { input: `https://www.youtube.com/channel/${c.channelId}` });
      ctx.toast(`Saved ${c.title}`);
    } catch (err) {
      ctx.toast(err.message, true);
      e.currentTarget.disabled = false;
    }
  } }, saved ? '✓' : '+ Save');
  const sim = h('button.btn.small', { title: 'Similar channels', onclick: (e) => { e.preventDefault(); ctx.openSimilar(c.channelId); } }, '🔍');
  return h('div.fd-rowcard' + (full ? '.full' : ''),
    h('a.fd-rowimg', { href: c.bestVideo ? ytVideo(c.bestVideo.id) : ytChannel(c), target: '_blank', rel: 'noopener', style: { backgroundImage: `url("${c.bestVideo ? thumb(c.bestVideo.id) : c.avatar}")` } }),
    h('a.fd-rowname', { href: ytChannel(c), target: '_blank', rel: 'noopener' }, h('b', c.title || 'Channel'), h('span', `${fmtNum(c.subs)} subscribers`)),
    full
      ? h('div.fd-rowstats',
        h('span', 'Avg views'), h('b', fmtNum(c.avgViews)),
        h('span', 'Videos'), h('b', c.videoCount ? c.videoCount.toLocaleString() : '—'),
        h('span', 'Days since start'), h('b', c.daysSinceStart != null ? c.daysSinceStart.toLocaleString() : '—'),
        h('span', 'Outlier'), h('b', x(c.outlier)))
      : h('div.fd-rowx', h('b', x(c.outlier)), strength(c.outlier)),
    h('div.fd-rowact', save, sim));
}

function moreToggle(key, total, shown) {
  const { h } = ctx;
  if (total <= shown && !ui.more[key]) return null;
  return h('button.btn.small.fd-more', { onclick: () => { ui.more[key] = !ui.more[key]; paint(); } }, ui.more[key] ? 'Show less' : `View all (${total})`);
}

/* ---------- sections ---------- */

function outliersSec() {
  const { h } = ctx;
  const { r, empty } = resultFor('outliers');
  let body = empty;
  if (r) {
    const list = r.outlierChannels || [];
    const base = tab === 'overview' ? 5 : 12;
    const n = ui.more.outliers ? list.length : base;
    body = list.length
      ? h('div', h('div.fd-rows', list.slice(0, n).map((c) => channelRow(c))), tab === 'overview' ? null : moreToggle('outliers', list.length, base))
      : h('div.fd-empty', 'No small channel broke out in this period. Try 7 or 30 days, or raise the small-channel limit.');
  }
  return section('outliers', 'Recently added outlier channels', body);
}

function risingSec() {
  const { h } = ctx;
  const { r, empty } = resultFor('rising');
  let body = empty;
  if (r) {
    const list = r.rising || [];
    const base = tab === 'overview' ? 5 : 12;
    const n = ui.more.rising ? list.length : base;
    body = list.length
      ? h('div', h('div.fd-rows', list.slice(0, n).map((c) => channelRow(c, { full: true }))), tab === 'overview' ? null : moreToggle('rising', list.length, base))
      : h('div.fd-empty', 'No young channel (under 2 years) is breaking out in this period yet.');
  }
  return section('rising', 'Niches with high future competition', h('div', h('p.fd-hint', 'Channels under 2 years old already beating their size — their niches will get crowded.'), body));
}

function keywordsSec() {
  const { h } = ctx;
  const { r, empty } = resultFor('keywords');
  let body = empty;
  if (r) {
    body = r.keywords?.length
      ? h('div.fd-kw', r.keywords.map((k) => h('a.fd-kw-chip', { href: `https://www.youtube.com/results?search_query=${encodeURIComponent(k.phrase)}`, target: '_blank', rel: 'noopener', title: `in ${k.videos} viral titles — search on YouTube` }, k.phrase, h('span', k.videos))))
      : h('div.fd-empty', 'No keywords found for the selected time period');
  }
  return section('keywords', 'Trending keywords', body);
}

function catsSec() {
  const { h, fmtNum } = ctx;
  const { r, empty } = resultFor('cats');
  const add = h('button.btn.small', { onclick: addCategory }, '+ Add category');
  let body = empty;
  if (r) {
    body = h('div.fd-cats', (r.categories || []).map((c) => h('button.fd-cat' + (ui.viralCat === c.name ? '.on' : ''), {
      title: 'Show this category’s viral videos below',
      onclick: () => {
        ui.viralCat = ui.viralCat === c.name ? '' : c.name;
        ui.sec.viral = ui.sec.cats;
        paint();
        document.querySelector('.fd-sec-viral')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    },
    h('b', c.name),
    h('span', `${c.channels.toLocaleString()} channels`),
    h('span.fd-cat-sub', c.outliers ? `${c.outliers} outlier${c.outliers === 1 ? '' : 's'} · up to ${x(c.topRatio)}` : `${fmtNum(c.views)} views`))));
  }
  return section('cats', 'Most popular categories', body, add);
}

function viralSec() {
  const { h, fmtNum } = ctx;
  const { r, empty } = resultFor('viral');
  const sort = h('select.fd-period', [['ratio', 'Outlier'], ['vph', 'Views per hour'], ['views', 'Most views'], ['new', 'Newest'], ['random', 'Random']].map(([v, l]) => h('option', { value: v }, l)));
  sort.value = ui.viralSort;
  sort.addEventListener('change', () => { ui.viralSort = sort.value; paint(); });
  const random = h('button.btn.primary.small', { onclick: () => { ui.viralSort = 'random'; ui.seed = Math.random(); paint(); } }, 'Random ⟳');
  let body = empty;
  if (r) {
    let list = (r.viral || []).filter((v) => !ui.viralCat || v.category === ui.viralCat);
    const by = { ratio: (v) => -v.ratio, vph: (v) => -v.vph, views: (v) => -v.views, new: (v) => v.ageDays ?? 99 };
    if (ui.viralSort === 'random') {
      let s = ui.seed || 0.5;
      const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
      list = list.map((v) => [rnd(), v]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
    } else list = [...list].sort((a, b) => by[ui.viralSort](a) - by[ui.viralSort](b));
    const base = tab === 'overview' ? 8 : 24;
    const n = ui.more.viral ? list.length : base;
    body = list.length
      ? h('div',
        ui.viralCat ? h('div.fd-filter', `Category: ${ui.viralCat} `, h('button.btn.small', { onclick: () => { ui.viralCat = ''; paint(); } }, '✕ Clear')) : null,
        h('div.fd-grid.fd-grid-vid', list.slice(0, n).map((v) => h('a.fd-vid', { href: ytVideo(v.id), target: '_blank', rel: 'noopener' },
          h('div.fd-thumb', { style: { backgroundImage: `url("${thumb(v.id)}")` } }, h('span.fd-x-pill', x(v.ratio))),
          h('div.fd-vt', v.title),
          h('div.fd-vm', `${fmtNum(v.views)} views · ${ageText(v.ageDays)}`),
          h('div.fd-vm', `${v.channelName} · ${fmtNum(v.subs)} subs`),
          h('span.fd-vph', `${fmtNum(v.vph)} VPH`)))),
        tab === 'overview' ? null : moreToggle('viral', list.length, base))
      : h('div.fd-empty', ui.viralCat ? 'No viral small-channel video in this category for this period.' : 'No viral videos on small channels in this period.');
  }
  return section('viral', 'Viral videos on small channels', body, h('div.fd-row', sort, random));
}

async function addCategory() {
  const name = prompt('Category name (e.g. "Islamic stories")');
  if (!name?.trim()) return;
  const q = prompt('YouTube search words for it', name.trim());
  if (!q?.trim()) return;
  const db = ctx.getDb();
  const list = [...(db.settings.finderCategories || []).filter((c) => c.name !== name.trim()), { name: name.trim(), q: q.trim() }];
  await ctx.send('saveSettings', { patch: { finderCategories: list } });
  ctx.toast(`Added “${name.trim()}” — it’s included in the next scan`);
}

/* ---------- page ---------- */

function header() {
  const { h } = ctx;
  const search = h('input.input.fd-search', { placeholder: 'Search by channel — paste a link or @handle' });
  search.value = ui.query;
  search.addEventListener('input', () => { ui.query = search.value; });
  const go = () => {
    if (!ui.query.trim()) return search.focus();
    ctx.openSimilar(ui.query.trim());
  };
  search.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  const subs = h('select.input', [[10000, 'Small = under 10K subs'], [50000, 'Small = under 50K subs'], [100000, 'Small = under 100K subs'], [500000, 'Small = under 500K subs']].map(([v, l]) => h('option', { value: v }, l)));
  subs.value = String(ui.maxSubs);
  subs.addEventListener('change', () => { ui.maxSubs = Number(subs.value); remember(); });
  const lang = h('select.input', [['any', 'Any language'], ['en', 'English'], ['hi', 'Hindi'], ['ur', 'Urdu']].map(([v, l]) => h('option', { value: v }, l)));
  lang.value = ui.lang;
  lang.addEventListener('change', () => { ui.lang = lang.value; remember(); });
  const running = state.status === 'running';
  const w = state.options?.window;
  const allCats = DEFAULT_CATEGORIES.length + (ctx.getDb().settings.finderCategories || []).length;
  return h('div.fd-head',
    h('div.fd-searchrow', search, h('button.btn.primary', { onclick: go }, '🔍 Find similar')),
    h('div.fd-stats',
      h('div.fd-stat', h('span', 'Channels analyzed'), h('b', subsCount.toLocaleString())),
      h('div.fd-stat', h('span', 'Categories'), h('b', String(allCats))),
      h('div.fd-stat', h('span', 'Last scan'), h('b', lastScanText()))),
    h('div.fd-controls', subs, lang,
      h('button.btn' + (running ? '' : '.primary'), { disabled: running, onclick: () => scan(ui.sec.viral) }, running ? 'Scanning…' : `⟳ Scan ${WINDOWS[ui.sec.viral].label.toLowerCase()}`)),
    running ? h('div.fd-progress', h('div.cs-looking-mini', `🔎 ${state.stage || 'Scanning'}… ${state.done || 0}/${state.total || '?'} — ${WINDOWS[w]?.label || ''}`), h('div.fd-bar', h('i', { style: { width: `${Math.round(((state.done || 0) / (state.total || 1)) * 100)}%` } }))) : null,
    state.status === 'error' ? h('div.ai-err', state.error) : null,
    h('p.fd-hint', 'Live data straight from YouTube: each scan checks the most viewed videos of every category for the chosen period and the channels behind them (1–2 minutes). Results are kept per period.'));
}

function lastScanText() {
  const times = Object.values(state.results || {}).map((r) => r.at).filter(Boolean);
  if (!times.length) return 'never';
  const mins = Math.round((Date.now() - Math.max(...times)) / 60000);
  return mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
}

function paint() {
  const { h, set, $ } = ctx;
  const list = $('list');
  if (!list) return;
  // Don't rebuild under someone typing in the search box (storage updates repaint often during a scan).
  if (list.contains(document.activeElement) && document.activeElement.classList.contains('fd-search')) {
    const p = list.querySelector('.fd-progress');
    if (p && state.status === 'running') p.firstChild.textContent = `🔎 ${state.stage || 'Scanning'}… ${state.done || 0}/${state.total || '?'}`;
    return;
  }
  const pages = {
    overview: () => [h('div.fd-two', outliersSec(), risingSec()), viralSec(), h('div.fd-two', keywordsSec(), catsSec())],
    outliers: () => [outliersSec()],
    rising: () => [risingSec()],
    viral: () => [viralSec()],
    keywords: () => [keywordsSec()],
    cats: () => [catsSec(), viralSec()],
  };
  set(list, h('section.finder', header(), ...(pages[tab] || pages.overview)()));
}

export async function renderFinder() {
  await load();
  paint();
}
