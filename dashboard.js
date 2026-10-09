import {
  computeMetrics, fmtNum, fmtAge, fmtDuration, fmtChannelAge, OUTLIER_X,
} from './lib/metrics.js';

import { schedule, uploadStats, fmtWhen, fmtHour, WEEKDAYS } from './lib/track.js';
import { initCtr, renderCtr } from './ctr.js';

const VERSION = chrome.runtime.getManifest().version;

/**
 * The version these dashboard files belong to (release.ps1 keeps it in sync
 * with manifest.json). Chrome serves an unpacked extension's pages straight
 * from disk but keeps running the old background until the extension is
 * reloaded, so after copying new files the two can disagree — then saving
 * silently breaks. When they differ, ask for a one-click restart.
 */
const BUILD = '1.6.0';

function showRestart(reason) {
  if (document.getElementById('restartBanner')) return;
  const bar = document.createElement('div');
  bar.id = 'restartBanner';
  bar.className = 'restart-banner';
  const msg = document.createElement('span');
  msg.textContent = reason || 'Channel Saver was updated. Click Restart to finish — your saved channels stay.';
  const btn = document.createElement('button');
  btn.textContent = 'Restart now';
  btn.addEventListener('click', () => chrome.runtime.reload());
  bar.append(msg, btn);
  document.body.prepend(bar);
  document.body.classList.add('has-restart');
}
if (VERSION !== BUILD) showRestart();

/* ---------- state ---------- */

let db = { niches: [], channels: {}, settings: {} };
const ui = {
  view: 'all', // 'all' | 'unsorted' | 'starred' | 'gone' | nicheId
  search: '',
  nicheSearch: '',
  sort: 'added',
  format: '',
  age: '',
  layout: 'cards',
  openId: null,
};
const refreshing = new Set();

try {
  Object.assign(ui, JSON.parse(localStorage.getItem('cs-ui') || '{}'), { openId: null, search: '' });
} catch {}
const saveUi = () => {
  try {
    const { view, sort, format, age, layout } = ui;
    localStorage.setItem('cs-ui', JSON.stringify({ view, sort, format, age, layout }));
  } catch {}
};

const $ = (id) => document.getElementById(id);

// replaceChildren() would print null/false as text; skip them.
const set = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));

/** Tiny element builder: h('div.cls', {attrs}, ...children). Text is always textContent. */
function h(sel, attrs, ...kids) {
  const [tag, ...cls] = sel.split('.');
  const n = document.createElement(tag || 'div');
  if (cls.length) n.className = cls.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    kids.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k.startsWith('--')) n.style.setProperty(k, v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return n;
}

const send = (type, payload = {}) =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (res?.error) {
        // An old background that doesn't know this request = files updated without a reload.
        if (/^Unknown request/.test(res.error)) showRestart();
        return reject(new Error(/^Unknown request/.test(res.error) ? 'Click "Restart now" at the top to finish the update.' : res.error));
      }
      resolve(res?.data);
    });
  });

let toastTimer;
function toast(msg, bad = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast${bad ? ' bad' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2800);
}

const thumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const ytVideo = (id) => `https://www.youtube.com/watch?v=${id}`;
const ytShort = (id) => `https://www.youtube.com/shorts/${id}`;
const nicheById = (id) => db.niches.find((n) => n.id === id);

/** RPM the user set on one of the channel's niches (highest wins), or null. */
function rpmFor(ch) {
  const custom = ch.nicheIds.map(nicheById).filter((n) => n && n.rpmHigh != null);
  if (!custom.length) return null;
  const n = custom.sort((a, b) => b.rpmHigh - a.rpmHigh)[0];
  return { low: n.rpmLow ?? n.rpmHigh, high: n.rpmHigh };
}

function rpmText(ch) {
  const r = rpmFor(ch);
  if (!r) return 'Not set';
  return r.low === r.high ? `$${r.low}` : `$${r.low}–$${r.high}`;
}

const metricsCache = new Map();
function M(ch) {
  const key = `${ch.channelId}:${ch.fetchedAt}:${(ch.snapshots || []).length}`;
  let m = metricsCache.get(ch.channelId);
  if (!m || m.key !== key) {
    m = { key, ...computeMetrics(ch) };
    metricsCache.set(ch.channelId, m);
  }
  return m;
}

/* ---------- filtering ---------- */

const SPECIAL_VIEWS = ['all', 'starred', 'unsorted', 'gone', 'competitors', 'similar', 'swipe', 'thumbtest'];
const VIEW_TITLES = { all: 'All channels', starred: 'Need to look', unsorted: 'No niche', gone: 'Removed by YouTube', competitors: 'Competitors', similar: 'Similar channels', swipe: 'Swipe file', thumbtest: 'CTR Tester' };

function inView(ch) {
  if (ui.view === 'gone') return ch.status === 'gone';
  if (ch.status === 'gone' && ui.view !== 'all') return false;
  if (ui.view === 'competitors') return !!ch.competitor;
  if (ui.view === 'unsorted') return !ch.nicheIds.length;
  if (ui.view === 'starred') return !!ch.starred;
  if (ui.view !== 'all') return ch.nicheIds.includes(ui.view);
  return true;
}

function visibleChannels() {
  const q = ui.search.trim().toLowerCase();
  let list = Object.values(db.channels).filter(inView);
  if (q) {
    list = list.filter((c) =>
      [c.title, c.handle, c.notes, c.keywords, c.description, c.country, ...c.nicheIds.map((id) => nicheById(id)?.title)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }
  if (ui.format) {
    list = list.filter((c) => {
      const f = M(c).format;
      return ui.format === 'shorts' ? /Shorts/.test(f) : f === 'Long' || f === 'Mixed';
    });
  }
  if (ui.age) list = list.filter((c) => M(c).ageDays != null && M(c).ageDays <= Number(ui.age));

  const by = {
    added: (c) => c.addedAt,
    score: (c) => M(c).score,
    monthly: (c) => M(c).monthlyViews,
    subs: (c) => c.subs || 0,
    growth: (c) => M(c).growth?.subsPerDay ?? -Infinity,
    young: (c) => -(M(c).ageDays ?? Infinity),
    uploads: (c) => M(c).uploadsPerWeek ?? 0,
    outliers: (c) => M(c).outliers.length,
    vps: (c) => M(c).viewsPerSub ?? 0,
  }[ui.sort] || ((c) => c.addedAt);
  return list.sort((a, b) => by(b) - by(a));
}

/* ---------- sidebar ---------- */

function renderSide() {
  const all = Object.values(db.channels);
  $('stats').textContent = `${all.length} channel${all.length === 1 ? '' : 's'} · ${db.niches.length} niche${db.niches.length === 1 ? '' : 's'}`;

  const item = (id, label, n, extra = {}) =>
    h('button.nav-item' + (ui.view === id ? '.on' : '') + (extra.drop ? '.drop' : ''), { onclick: () => setView(id), ...extra.attrs, ...(extra.drop ? dropTarget(extra.drop) : {}) },
      extra.dot ? h('span.dot', { style: { background: extra.dot } }) : null,
      h('span.name', label),
      extra.pin ? h('span.pin', '📌') : null,
      h('span.n', n));

  const live = all.filter((c) => c.status !== 'gone');
  const gone = all.length - live.length;
  set($('nav'), 
    item('all', 'All channels', all.length),
    item('starred', '🔖 Need to look', live.filter((c) => c.starred).length, {
      drop: (id) => send('updateChannel', { channelId: id, patch: { starred: true } }).then(() => toast('Added to Need to look')),
    }),
    item('unsorted', 'No niche', live.filter((c) => !c.nicheIds.length).length),
    item('swipe', '📌 Swipe file', (db.swipe || []).length || ''),
    gone ? item('gone', 'Removed by YouTube', gone) : null,
  );
  set($('discover'),
    item('similar', '🔍 Similar channels', Object.keys(db.similar || {}).length || ''),
    item('thumbtest', '🎯 CTR Tester', ''));
  set($('watch'),
    item('competitors', '⚔ Competitors', live.filter((c) => c.competitor).length, {
      drop: (id) => {
        if (db.channels[id]?.competitor) return toast('Already a competitor');
        return send('updateChannel', { channelId: id, patch: { competitor: true } }).then(() => toast('Added to competitors — checked every 6 hours'));
      },
    }));

  const q = ui.nicheSearch.trim().toLowerCase();
  const niches = [...db.niches]
    .filter((n) => !q || n.title.toLowerCase().includes(q))
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || a.title.localeCompare(b.title));
  set($('niches'), 
    ...niches.map((n) =>
      item(n.id, n.title, live.filter((c) => c.nicheIds.includes(n.id)).length, {
        dot: n.color,
        pin: n.pinned,
        attrs: { oncontextmenu: (e) => { e.preventDefault(); nicheMenu(n, e.clientX, e.clientY); } },
        drop: (id) => {
          if (db.channels[id]?.nicheIds.includes(n.id)) return toast(`Already in ${n.title}`);
          return send('setNiche', { channelId: id, nicheId: n.id, on: true }).then(() => toast(`Added to ${n.title}`));
        },
      }),
    ),
    db.niches.length ? null : h('div', { style: { padding: '6px 10px', color: 'var(--faint)', fontSize: '13px' } }, 'No niches yet'),
  );
  $('autoRefresh').checked = db.settings.autoRefresh !== false;
  const lb = db.settings.lastBackupAt;
  $('backupInfo').textContent = lb ? `Auto-backup: ${fmtAge((Date.now() - lb) / 86400000).replace('today', 'today')} · every 12h` : 'Auto-backup: every 12h (first one soon)';
  $('backupInfo').title = 'Saved to Downloads › Channel Saver Backups. Click to back up now.';
  $('notify').checked = db.settings.notify !== false;
}

function setView(id) {
  ui.view = id;
  saveUi();
  $('side').classList.remove('open');
  render();
}

/* ---------- niche summary ---------- */

function renderNicheBar(list) {
  const bar = $('nicheBar');
  const niche = nicheById(ui.view);
  if (ui.view === 'competitors' && list.length) return renderCompetitorBar(bar, list);
  if (!list.length || (!niche && ui.view !== 'all')) {
    bar.hidden = true;
    return;
  }
  const ms = list.map(M);
  const sum = (f) => ms.reduce((s, m) => s + (f(m) || 0), 0);
  const med = (arr) => {
    const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
    return a.length ? a[Math.floor(a.length / 2)] : null;
  };
  const young = ms.filter((m) => m.ageDays != null && m.ageDays < 365).length;
  bar.hidden = false;
  set(bar, 
    stat('Avg opportunity', Math.round(sum((m) => m.score) / ms.length), 'out of 100'),
    stat('Median subscribers', fmtNum(med(list.map((c) => c.subs))), `${list.length} channels`),
    stat('Median views / video', fmtNum(med(ms.map((m) => m.medianViews))), 'recent uploads'),
    stat('Under 1 year old', `${young}`, young ? 'new channels growing here' : 'no young channels'),
    stat('Outlier videos', `${sum((m) => m.outliers.length)}`, `${OUTLIER_X}x+ the channel's median`),
    niche?.notes ? h('div.niche-notes', niche.notes) : null,
  );
}

function stat(k, v, s) {
  return h('div.stat', h('div.k', k), h('div.v', v), s ? h('div.s', s) : null);
}

/* ---------- cards ---------- */

function scoreBadge(score) {
  return h('div.score' + (score >= 60 ? '.hi' : score >= 35 ? '.mid' : ''), { title: 'Opportunity score: young channel, many views per subscriber, outlier videos, regular uploads' },
    h('b', score), h('span', 'score'));
}

function channelChips(ch, m) {
  const chips = [];
  for (const id of ch.nicheIds) {
    const n = nicheById(id);
    if (n) chips.push(h('span.chip.niche', { '--c': n.color }, n.title));
  }
  if (ch.status === 'gone') chips.push(h('span.chip.bad', 'Removed by YouTube'));
  chips.push(h('span.chip', m.format));
  if (ch.competitor && ui.view !== 'competitors') chips.push(h('span.chip.accent', 'Competitor'));
  if (m.ageDays != null && m.ageDays < 365) chips.push(h('span.chip.good', `New · ${fmtChannelAge(m.ageDays)}`));
  if (!m.monetizable) chips.push(h('span.chip.warn', 'Under 1K subs'));
  if (ch.country) chips.push(h('span.chip', ch.country));
  return chips;
}

function growthText(m) {
  if (!m.growth) return { v: '—', cls: '' };
  const d = m.growth.subsPerDay;
  return { v: `${d >= 0 ? '+' : ''}${fmtNum(d)}/day`, cls: d > 0 ? 'up' : d < 0 ? 'down' : '' };
}

function videoTile(v, m) {
  const x = m.medianViews ? v.views / m.medianViews : 0;
  return h('a.vid', { href: ytVideo(v.id), target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation() },
    h('div.thumb', { style: { backgroundImage: `url("${thumb(v.id)}")` } },
      v.duration ? h('span.dur', fmtDuration(v.duration)) : null,
      x >= OUTLIER_X ? h('span.x', `${x.toFixed(1)}x`) : null),
    h('div.vt', v.title),
    h('div.vm', `${fmtNum(v.views)} views · ${fmtAge(v.age)}`));
}

function card(ch) {
  const m = M(ch);
  const g = growthText(m);
  const busy = refreshing.has(ch.channelId);
  const watch = ui.view === 'competitors';
  const focused = watch && ui.compFocus === ch.channelId;
  return h('article.card' + (ch.status === 'gone' ? '.gone' : '') + (focused ? '.focus' : ''), {
    // On Competitors a click picks whose uploads to show up top; ⓘ opens details.
    onclick: () => {
      if (!watch) return openDrawer(ch.channelId);
      ui.compFocus = focused ? null : ch.channelId;
      render();
      if (ui.compFocus) window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    title: watch ? (focused ? 'Click again to hide its uploads' : 'Click to see this competitor’s uploads') : null,
    draggable: 'true',
    ondragstart: (e) => dragStart(e, ch),
    ondragend: dragEnd,
  },
    h('div.banner', { style: ch.banner ? { backgroundImage: `url("${ch.banner}")` } : null }),
    h('div.card-head',
      h('div.avatar', { style: ch.avatar ? { backgroundImage: `url("${ch.avatar}")` } : null }),
      scoreBadge(m.score)),
    h('div.card-title',
      h('h3', h('span.t', ch.title || ch.handle)),
      h('div.meta', `${ch.handle || ''} · ${fmtNum(ch.subs)} subs · ${fmtNum(ch.videoCount)} videos`)),
    h('div.chips', channelChips(ch, m)),
    watch ? competitorMetrics(ch, m) : h('div.metrics',
      h('div.metric', { title: 'Set RPM from the niche ⋯ menu → RPM & notes' }, h('div.k', 'RPM'), h('div.v' + (rpmFor(ch) ? '' : '.muted'), rpmText(ch))),
      metric('Views / month', fmtNum(m.monthlyViews)),
      metric('Subs growth', g.v, g.cls),
      metric('Uploads / week', m.uploadsPerWeek != null ? m.uploadsPerWeek.toFixed(1) : '—'),
      metric('Channel age', fmtChannelAge(m.ageDays)),
      metric('Outliers', `${m.outliers.length}`)),
    watch && m.latest.length ? h('div.vids-label', 'Latest uploads') : null,
    h('div.vids', (watch ? m.latest : m.outliers.length ? [...m.outliers, ...m.top.filter((v) => !m.outliers.includes(v))] : m.top).slice(0, 3).map((v) => videoTile(v, m))),
    ch.notes ? h('div.card-notes', ch.notes) : null,
    ch.error && ch.status !== 'gone' ? h('div.err', `Last refresh failed: ${ch.error}`) : null,
    h('div.card-foot',
      h('span.when', busy ? 'Refreshing…' : `Updated ${fmtAge((Date.now() - ch.fetchedAt) / 86400000)}`),
      iconBtn('🔖', ch.starred ? 'Remove from Need to look' : 'Need to look', () => send('updateChannel', { channelId: ch.channelId, patch: { starred: !ch.starred } }), ch.starred),
      iconBtn('⟳', 'Refresh data', () => refresh(ch.channelId)),
      watch ? iconBtn('ⓘ', 'Details: schedule, uploads, activity', () => openDrawer(ch.channelId)) : null,
      iconBtn('↗', 'Open on YouTube', () => window.open(ch.url, '_blank', 'noopener')),
      iconBtn('⋯', 'More', (e) => channelMenu(ch, e.clientX, e.clientY))));
}

function metric(k, v, cls = '') {
  return h('div.metric', h('div.k', k), h('div.v' + (cls ? `.${cls}` : ''), v));
}

function iconBtn(label, title, fn, on) {
  return h('button.icon-btn' + (on ? '.on' : ''), {
    title,
    'aria-label': title,
    onclick: (e) => { e.stopPropagation(); fn(e); },
  }, label);
}

/* ---------- table ---------- */

function table(list) {
  const cols = [
    ['Channel', (c) => h('div.tch', h('div.avatar', { style: c.avatar ? { backgroundImage: `url("${c.avatar}")` } : null }), h('div', c.title))],
    ['Niche', (c) => c.nicheIds.map((id) => nicheById(id)?.title).filter(Boolean).join(', ') || '—'],
    ['Score', (c) => M(c).score, 'num'],
    ['Subs', (c) => fmtNum(c.subs), 'num'],
    ['Growth', (c) => growthText(M(c)).v, 'num'],
    ['Views / mo', (c) => fmtNum(M(c).monthlyViews), 'num'],
    ['RPM', (c) => (rpmFor(c) ? rpmText(c) : '—'), 'num'],
    ['Median views', (c) => fmtNum(M(c).medianViews), 'num'],
    ['Uploads / wk', (c) => (M(c).uploadsPerWeek != null ? M(c).uploadsPerWeek.toFixed(1) : '—'), 'num'],
    ['Outliers', (c) => M(c).outliers.length, 'num'],
    ['Age', (c) => fmtChannelAge(M(c).ageDays)],
    ['Format', (c) => M(c).format],
    ['Country', (c) => c.country || '—'],
  ];
  if (ui.view === 'competitors') {
    cols.splice(2, 0,
      ['Subs 24h', (c) => signed(M(c).change.subs1d), 'num'],
      ['Subs 7d', (c) => signed(M(c).change.subs7d), 'num'],
      ['Views 24h', (c) => signed(M(c).change.views1d), 'num'],
      ['Uploads 7d', (c) => M(c).uploads7d, 'num'],
      ['Last upload', (c) => fmtAge(M(c).daysSinceUpload) || '—']);
  }
  return h('div.table-wrap', h('table',
    h('thead', h('tr', cols.map(([t, , cls]) => h('th' + (cls ? `.${cls}` : ''), t)))),
    h('tbody', list.map((c) => h('tr', { onclick: () => openDrawer(c.channelId) },
      cols.map(([, f, cls]) => h('td' + (cls ? `.${cls}` : ''), f(c))))))));
}

/* ---------- main render ---------- */

function render() {
  if (!SPECIAL_VIEWS.includes(ui.view) && !nicheById(ui.view)) ui.view = 'all';
  renderSide();
  const niche = nicheById(ui.view);
  $('viewTitle').textContent = niche ? niche.title
    : VIEW_TITLES[ui.view];
  const listView = !['similar', 'swipe', 'thumbtest'].includes(ui.view);
  document.querySelector('.toolbar').hidden = !listView;
  $('search').hidden = !listView;
  $('viewCount').hidden = !listView;
  if (!listView) {
    $('nicheBar').hidden = true;
    $('nicheOpts').hidden = true;
    if (ui.view === 'similar') renderSimilar();
    else if (ui.view === 'swipe') renderSwipe();
    else renderCtr();
    renderUpdate();
    if (ui.openId) renderDrawer();
    return;
  }
  const list = visibleChannels();
  $('viewCount').textContent = list.length;
  for (const [id, key] of [['sort', 'sort'], ['fFormat', 'format'], ['fAge', 'age']]) $(id).value = ui[key];
  $('viewCards').classList.toggle('on', ui.layout === 'cards');
  $('viewTable').classList.toggle('on', ui.layout === 'table');
  renderNicheBar(list);

  const box = $('list');
  if (!Object.keys(db.channels).length) {
    set(box, h('div.empty',
      h('h2', 'Save your first channel'),
      h('p', 'Open any channel or video on YouTube and click the purple Save button next to Subscribe. Or paste channel links here.'),
      h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' } },
        h('button.btn.primary', { onclick: () => addModal() }, '+ Add channels'),
        h('button.btn', { onclick: () => $('importFile').click() }, '⤒ Restore from backup')),
      h('p.restore-hint', 'Had channels before? Click “Restore from backup” and pick Downloads › Channel Saver Backups › channel-saver-backup-latest.json.')));
  } else if (!list.length) {
    set(box,
      niche ? nicheVideos(niche) : null,
      ui.view === 'competitors'
        ? h('div.empty', h('h2', 'No competitors yet'), h('p', 'Drag a channel card onto ⚔ Competitors in the left menu, or open a channel and click "Add to competitors". Competitors are checked every 6 hours so you can see what they post and how fast they grow.'))
        : niche && nicheVideoItems(niche).length
          ? h('div.feed-hint', 'No channels in this niche yet — save one from its channel page, or with + Add channels.')
          : h('div.empty', h('h2', 'Nothing here'), h('p', niche ? 'Save videos or channels into this niche with the purple Save button on YouTube, with + Add channels, or drag a card onto the niche.' : 'No channels match these filters.')));
  } else {
    set(box,
      niche ? nicheVideos(niche) : null,
      ui.view === 'competitors' ? competitorFeed(list) : null,
      ui.layout === 'table' ? table(list) : ui.sort === 'added' ? dayGroups(list) : h('div.grid', list.map(card)));
  }
  renderUpdate();
  $('nicheOpts').hidden = !niche;
  // Don't rebuild the drawer under someone typing in it (each keystroke saves and re-renders).
  const typing = $('drawer').contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA';
  if (ui.openId && !typing) renderDrawer();
}

/* ---------- videos saved into a niche ---------- */

const nicheVideoItems = (niche) => (db.swipe || []).filter((it) => it.videoId && (it.nicheIds || []).includes(niche.id));

function nicheVideos(niche) {
  const items = nicheVideoItems(niche);
  if (!items.length) return null;
  const remove = async (it) => {
    if (it.type === 'video') await send('saveVideoToNiche', { videoId: it.videoId, nicheId: niche.id, on: false });
    else await send('updateSwipe', { id: it.id, patch: { nicheIds: (it.nicheIds || []).filter((x) => x !== niche.id) } });
    toast(`Removed from ${niche.title}`);
  };
  return h('section.feed.niche-videos',
    h('h2.day-head', '🎬 Saved videos', h('span.count', items.length)),
    h('div.feed-row', items.map((it) => h('div.feed-item.nv',
      h('a', { href: swipeLink(it), target: '_blank', rel: 'noopener' },
        h('div.thumb', { style: { backgroundImage: `url("${thumb(it.videoId)}")` } },
          it.type === 'part' && it.start != null ? h('span.dur', `${fmtDuration(it.start) || '0:00'}–${fmtDuration(it.end)}`) : it.duration ? h('span.dur', fmtDuration(it.duration)) : null),
        h('div.vt', it.title || '(video)')),
      h('div.vm', [it.channelName, it.views ? `${fmtNum(it.views)} views` : ''].filter(Boolean).join(' · ')),
      h('div.vm', it.published ? `Uploaded ${fmtWhen(it.published)}` : `Saved ${fmtAge((Date.now() - it.addedAt) / 86400000)}`),
      h('div.nv-actions',
        iconBtn('⧉', 'Copy link', () => navigator.clipboard.writeText(swipeLink(it)).then(() => toast('Link copied'))),
        iconBtn('✕', `Remove from ${niche.title}`, () => remove(it)))))));
}

/* ---------- day groups (Recently added) ---------- */

function dayLabel(t) {
  const d = new Date(t);
  const today = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function dayGroups(list) {
  const groups = [];
  for (const c of list) {
    const label = dayLabel(c.addedAt);
    if (groups[groups.length - 1]?.label !== label) groups.push({ label, items: [] });
    groups[groups.length - 1].items.push(c);
  }
  return groups.map((g) => h('section.day',
    h('h2.day-head', g.label, h('span.count', g.items.length)),
    h('div.grid', g.items.map(card))));
}

/* ---------- competitors ---------- */

const signed = (n) => (n == null ? '—' : `${n > 0 ? '+' : ''}${fmtNum(n)}`);
const trend = (n) => (n == null ? '' : n > 0 ? 'up' : n < 0 ? 'down' : '');

function competitorMetrics(ch, m) {
  const c = m.change;
  const sch = ch.track ? schedule(ch.track.uploads) : null;
  const last = ch.track?.uploads[0];
  return [
    h('div.metrics',
      metric('Subs · 24h', signed(c.subs1d), trend(c.subs1d)),
      metric('Subs · 7 days', signed(c.subs7d), trend(c.subs7d)),
      metric('Views · 24h', signed(c.views1d), trend(c.views1d)),
      metric('Uploads · 7 days', `${m.uploads7d}`),
      metric('Typical 24h views', fmtNum(uploadStats(ch).typical24h)),
      metric('Median views', fmtNum(m.medianViews))),
    h('div.track-line',
      h('div', h('span.k', 'Last upload '), last ? fmtWhen(last.published) : fmtAge(m.daysSinceUpload) || '—'),
      sch ? h('div', h('span.k', 'Usually '), sch.summary) : null,
      sch?.next ? h('div' + (sch.overdue ? '.late' : ''), h('span.k', sch.overdue ? 'Expected (late) ' : 'Next likely '), fmtWhen(sch.next)) : null),
  ];
}

function renderCompetitorBar(bar, list) {
  const ms = list.map(M);
  const sum = (f) => ms.reduce((s, m) => s + (f(m) || 0), 0);
  const fresh = ms.filter((m) => m.daysSinceUpload != null && m.daysSinceUpload <= 1).length;
  const gaining = [...list].sort((a, b) => (M(b).change.subs1d ?? -Infinity) - (M(a).change.subs1d ?? -Infinity))[0];
  const g = gaining && M(gaining).change.subs1d;
  bar.hidden = false;
  set(bar,
    stat('Competitors', `${list.length}`, 'checked every 6 hours'),
    stat('Posted in last 24h', `${fresh}`, fresh ? 'channels uploaded today' : 'nobody uploaded today'),
    stat('Uploads · 7 days', `${sum((m) => m.uploads7d)}`, 'all competitors together'),
    stat('Fastest today', g != null && g > 0 ? signed(g) : '—', g != null && g > 0 ? gaining.title : 'needs 2 days of data'),
    stat('Subs gained · 7 days', signed(ms.some((m) => m.change.subs7d != null) ? sum((m) => m.change.subs7d) : null), 'all competitors together'));
}

/** Newest uploads across all competitors: the "what are they doing" strip. */
function competitorFeed(all) {
  // Hidden until you click a competitor; then only that competitor's uploads.
  const focus = all.find((c) => c.channelId === ui.compFocus);
  if (!focus) {
    ui.compFocus = null;
    return h('div.feed-hint', '👇 Click a competitor below to see its latest uploads with exact upload times.');
  }
  const list = [focus];
  const WEEK = 7 * 86400000;
  const vids = list.flatMap((c) => {
    const m = M(c);
    if (c.track) {
      const { rows } = uploadStats(c, 15);
      return rows.filter((r) => Date.now() - r.published <= WEEK).map((r) => {
        const known = c.videos?.find((v) => v.id === r.id);
        return { id: r.id, title: r.title, views: r.views ?? known?.views ?? 0, duration: known?.duration, age: (Date.now() - r.published) / 86400000, published: r.published, v24: r.v24, vs24: r.vs24, ch: c, m };
      });
    }
    return m.latest.filter((v) => v.age <= 7).map((v) => ({ ...v, ch: c, m }));
  })
    .sort((a, b) => a.age - b.age)
    .slice(0, 16);
  const close = h('button.btn.small', { onclick: () => { ui.compFocus = null; render(); } }, '✕ Hide');
  if (!vids.length) return h('div.feed-empty', h('span', `${focus.title} hasn’t uploaded in the last 7 days.`), close);
  return h('section.feed',
    h('h2.day-head', `${focus.title} · uploads in the last 7 days`, h('span.count', vids.length), close),
    h('div.feed-row', vids.map((v) => {
      const x = v.m.medianViews ? v.views / v.m.medianViews : 0;
      return h('a.feed-item', { href: ytVideo(v.id), target: '_blank', rel: 'noopener' },
        h('div.thumb', { style: { backgroundImage: `url("${thumb(v.id)}")` } },
          v.duration ? h('span.dur', fmtDuration(v.duration)) : null,
          x >= OUTLIER_X ? h('span.x', `${x.toFixed(1)}x`) : null),
        h('div.vt', v.title),
        h('div.vm', `${v.ch.title} · ${fmtNum(v.views)} views`),
        h('div.vm.when', v.published ? fmtWhen(v.published) : fmtAge(v.age)),
        v.v24 != null ? h('div.vm' + (v.vs24 >= 1.5 ? '.hot' : v.vs24 != null && v.vs24 < 0.6 ? '.cold' : ''), `First 24h: ${fmtNum(v.v24)}${v.vs24 ? ` (${v.vs24.toFixed(1)}x usual)` : ''}`) : null);
    })));
}

async function toggleCompetitor(ch) {
  const on = !ch.competitor;
  await send('updateChannel', { channelId: ch.channelId, patch: { competitor: on } });
  toast(on ? 'Added to competitors — checked every 6 hours' : 'Removed from competitors');
}

/* ---------- settings ---------- */

const FEATURE_LABELS = [
  ['saveButton', '+ Save button next to Subscribe'],
  ['badges', 'Badges on every video (subscribers, outlier, views per hour)'],
  ['filter', 'Filter button on Home, Search and Subscriptions'],
  ['hover', 'Channel preview when hovering a channel name'],
  ['shorts', 'Stats box while watching Shorts'],
  ['videoTools', 'Tools under videos (thumbnail, frame, transcript, swipe file, similar videos)'],
  ['similarButton', '🔍 Similar button on channel pages'],
  ['assistedReply', '💬 Assisted reply on comments (YouTube Studio and video pages)'],
];

function settingsModal() {
  const feats = { saveButton: true, badges: true, filter: true, hover: true, shorts: true, videoTools: true, similarButton: true, assistedReply: true, ...(db.settings.features || {}) };
  const boxes = FEATURE_LABELS.map(([k, label]) => {
    const cb = h('input', { type: 'checkbox' });
    cb.checked = feats[k] !== false;
    cb.dataset.k = k;
    return h('label.set-row', cb, h('span', label));
  });
  const auto = h('input', { type: 'checkbox' });
  auto.checked = db.settings.autoRefresh !== false;
  const notify = h('input', { type: 'checkbox' });
  notify.checked = db.settings.notify !== false;
  openModal(
    h('h3', 'Settings'),
    h('p', 'Turn off anything you don’t use. Changes apply on YouTube right away.'),
    h('div.set-group', h('div.set-h', 'On YouTube'), boxes),
    h('div.set-group', h('div.set-h', 'Background'),
      h('label.set-row', auto, h('span', 'Refresh saved channels daily (growth tracking)')),
      h('label.set-row', notify, h('span', 'Notify me when a competitor uploads'))),
    h('div.actions',
      h('button.btn', { onclick: closeModal }, 'Cancel'),
      h('button.btn.primary', { onclick: async () => {
        const features = Object.fromEntries(boxes.map((b) => { const cb = b.querySelector('input'); return [cb.dataset.k, cb.checked]; }));
        await send('saveSettings', { patch: { features, autoRefresh: auto.checked, notify: notify.checked } });
        closeModal();
        toast('Settings saved');
      } }, 'Save')),
  );
}

/* ---------- swipe file ---------- */

const SWIPE_TYPES = { video: 'Video', part: 'Part', thumbnail: 'Thumbnail', channel: 'Channel' };

function swipeLink(it) {
  if (it.type === 'channel') return `https://www.youtube.com/channel/${it.channelId}`;
  return `https://www.youtube.com/watch?v=${it.videoId}${it.type === 'part' && it.start != null ? `&t=${it.start}s` : ''}`;
}

function editSwipe(it) {
  const note = h('textarea', { rows: 4 });
  note.value = it.note || '';
  const tags = h('input.input', { placeholder: 'Tags, comma separated' });
  tags.value = (it.tags || []).join(', ');
  const niche = h('select.input', h('option', { value: '' }, 'No niche'), db.niches.map((n) => h('option', { value: n.id }, n.title)));
  niche.value = it.nicheIds?.[0] || '';
  openModal(
    h('h3', 'Edit swipe'),
    h('p', it.title),
    h('label.field', 'Note', note),
    h('label.field', 'Tags', tags),
    h('label.field', 'Niche', niche),
    h('div.actions',
      h('button.btn', { onclick: closeModal }, 'Cancel'),
      h('button.btn.primary', { onclick: async () => {
        await send('updateSwipe', { id: it.id, patch: { note: note.value, tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean), nicheIds: niche.value ? [niche.value] : [] } });
        closeModal();
      } }, 'Save')),
  );
}

function renderSwipe() {
  const items = db.swipe || [];
  const q = (ui.swipeQ || '').toLowerCase();
  let list = items;
  if (ui.swipeType) list = list.filter((it) => it.type === ui.swipeType);
  if (ui.swipeNiche) list = list.filter((it) => (it.nicheIds || []).includes(ui.swipeNiche));
  if (q) list = list.filter((it) => [it.title, it.channelName, it.note, ...(it.tags || [])].join(' ').toLowerCase().includes(q));
  const tagCounts = {};
  for (const it of items) for (const t of it.tags || []) tagCounts[t] = (tagCounts[t] || 0) + 1;

  const search = h('input.input', { id: 'swipeQ', placeholder: 'Search titles, notes, tags…' });
  search.value = ui.swipeQ || '';
  search.addEventListener('input', () => {
    ui.swipeQ = search.value;
    renderSwipe();
    const s = document.getElementById('swipeQ');
    s.focus();
    s.setSelectionRange(s.value.length, s.value.length);
  });
  const type = h('select.input', h('option', { value: '' }, 'All types'), Object.entries(SWIPE_TYPES).map(([v, t]) => h('option', { value: v }, t)));
  type.value = ui.swipeType || '';
  type.addEventListener('change', () => { ui.swipeType = type.value; renderSwipe(); });
  const niche = h('select.input', h('option', { value: '' }, 'All niches'), db.niches.map((n) => h('option', { value: n.id }, n.title)));
  niche.value = ui.swipeNiche || '';
  niche.addEventListener('change', () => { ui.swipeNiche = niche.value; renderSwipe(); });

  const head = h('section.sw-head',
    h('p.sim-intro', 'Videos, parts of videos and thumbnails you saved with 📌 Swipe file under any YouTube video. Search, filter by type, niche or tag.'),
    h('div.sw-form', search, type, niche),
    Object.keys(tagCounts).length ? h('div.chips', { style: { padding: '10px 0 0' } }, Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([t, n]) =>
      h('button.chip' + (ui.swipeQ === t ? '.accent' : ''), { onclick: () => { ui.swipeQ = ui.swipeQ === t ? '' : t; renderSwipe(); } }, `#${t} ${n}`))) : null);

  if (!items.length) {
    set($('list'), head, h('div.empty', h('h2', 'Your swipe file is empty'), h('p', 'Open any YouTube video and click 📌 Swipe file under the title to save the video, a part of it (great hook, intro…) or its thumbnail.')));
    return;
  }
  set($('list'), head, list.length ? h('div.sw-grid', list.map((it) =>
    h('article.sw-card',
      h('a.thumb.sw-thumb', { href: swipeLink(it), target: '_blank', rel: 'noopener', style: { backgroundImage: it.videoId ? `url("https://i.ytimg.com/vi/${it.videoId}/mqdefault.jpg")` : null } },
        h('span.sw-type', SWIPE_TYPES[it.type] || it.type),
        it.type === 'part' && it.start != null ? h('span.dur', `${fmtDuration(it.start) || '0:00'}–${fmtDuration(it.end)}`) : it.duration ? h('span.dur', fmtDuration(it.duration)) : null),
      h('div.sw-body',
        h('div.sw-title', it.title || '(untitled)'),
        h('div.vm', [it.channelName, it.views ? `${fmtNum(it.views)} views` : '', it.published ? new Date(it.published).toLocaleDateString() : ''].filter(Boolean).join(' · ')),
        it.note ? h('div.sw-note', it.note) : null,
        h('div.chips', { style: { padding: '6px 0 0' } },
          (it.nicheIds || []).map((id) => nicheById(id)).filter(Boolean).map((n) => h('span.chip.niche', { '--c': n.color }, n.title)),
          (it.tags || []).map((t) => h('span.chip', `#${t}`)))),
      h('div.sw-actions',
        h('span.vm', `Saved ${fmtAge((Date.now() - it.addedAt) / 86400000)}`),
        iconBtn('✎', 'Edit note, tags, niche', () => editSwipe(it)),
        iconBtn('⧉', 'Copy link', () => navigator.clipboard.writeText(swipeLink(it)).then(() => toast('Link copied'))),
        iconBtn('🗑', 'Delete', async () => { if (confirm('Delete this swipe?')) await send('deleteSwipe', { id: it.id }); }))))) : h('div.empty', h('p', 'Nothing matches these filters.')));
}

/* ---------- similar channels ---------- */

/** Opens the Similar view for a saved channel id or any channel link, starting a search if needed. */
async function openSimilar(input, force = false, mode = 'quick') {
  ui.view = 'similar';
  saveUi();
  const known = db.channels[input]?.channelId;
  if (known) ui.similarSeed = known;
  render();
  try {
    const r = await send('findSimilar', { input, force, mode });
    ui.similarSeed = r.seedId;
    render();
  } catch (e) {
    toast(e.message, true);
  }
}

const savedIds = () => new Set(Object.keys(db.channels));

function similarRow(r, seedRec) {
  const saved = savedIds().has(r.channelId);
  const save = async () => {
    // Same niches as the seed, when the seed is in the library.
    const nicheId = seedRec?.nicheIds?.[0] || null;
    try {
      const res = await send('add', { input: r.url || `https://www.youtube.com/channel/${r.channelId}`, nicheId });
      for (const id of (seedRec?.nicheIds || []).slice(1)) await send('setNiche', { channelId: res.channel.channelId, nicheId: id, on: true });
      toast(`Saved ${r.title}${nicheId ? ` to ${nicheById(nicheId)?.title}` : ''}`);
    } catch (e) {
      toast(e.message, true);
    }
  };
  return h('tr',
    h('td', h('div.tch',
      h('div.avatar', { style: r.avatar ? { backgroundImage: `url("${r.avatar}")` } : null }),
      h('div', h('div.sim-name', r.title), h('div.vm', [r.handle, r.country].filter(Boolean).join(' · '))))),
    h('td', h('div.sim-bar', h('span', { style: { width: `${r.similarity}%` } })), h('div.vm', `${r.similarity}% similar${r.sameLanguage ? '' : ' · other language'}`)),
    h('td.num', fmtNum(r.subs)),
    h('td.num', fmtNum(r.medianViews)),
    h('td.num', r.ageDays != null ? r.ageDays.toLocaleString() : '—'),
    h('td.num', r.uploadsPerMonth != null ? r.uploadsPerMonth : '—'),
    h('td.num', r.lastUpload != null ? fmtAge(r.lastUpload) : '—'),
    h('td.num', r.outliers),
    h('td.top-vid', r.topVideo ? h('a', { href: ytVideo(r.topVideo.id), target: '_blank', rel: 'noopener', title: `${r.topVideo.title} — ${fmtNum(r.topVideo.views)} views` },
      h('div.thumb', { style: { backgroundImage: `url("${thumb(r.topVideo.id)}")` } }, h('span.dur', fmtNum(r.topVideo.views)))) : '—'),
    h('td.actions',
      saved ? h('button.btn.small', { onclick: () => openDrawer(r.channelId) }, '✓ Saved') : h('button.btn.small.primary', { onclick: save }, '+ Save'),
      h('button.icon-btn', { title: 'Find channels similar to this one', onclick: () => openSimilar(r.url || r.channelId) }, '🔍'),
      h('button.icon-btn', { title: 'Open on YouTube', onclick: () => window.open(r.url, '_blank', 'noopener') }, '↗')));
}

function renderSimilar() {
  const all = db.similar || {};
  const seeds = Object.values(all).sort((a, b) => (b.at || 0) - (a.at || 0));
  if (!ui.similarSeed || !all[ui.similarSeed]) ui.similarSeed = seeds[0]?.seed?.channelId || null;
  const cur = ui.similarSeed ? all[ui.similarSeed] : null;

  const wasTyping = document.activeElement?.id === 'simInput';
  const input = h('input.input', { id: 'simInput', placeholder: 'Paste a YouTube channel or video link…' });
  input.value = ui.simDraft || '';
  input.addEventListener('input', () => { ui.simDraft = input.value; });
  const find = (mode) => {
    const v = input.value.trim() || pick.value;
    if (!v) return toast('Paste a channel link or pick a saved channel', true);
    ui.simDraft = '';
    openSimilar(v, false, mode);
  };
  if (wasTyping) setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && find('quick'));
  const pick = h('select.input',
    h('option', { value: '' }, 'or pick a saved channel…'),
    Object.values(db.channels).sort((a, b) => a.title.localeCompare(b.title)).map((c) => h('option', { value: c.channelId }, c.title)));
  pick.addEventListener('change', () => pick.value && openSimilar(pick.value, false, 'quick'));

  const head = h('section.sim-head',
    h('p.sim-intro', 'Finds channels like this one using what YouTube recommends next to its videos and what ranks for its topics, then scores how closely their videos match. Quick ≈ 20 channels in about a minute; In-depth ≈ 40 channels and also follows the newest uploads, so it finds newer competitors.'),
    h('div.sim-form.sim-form3', input,
      h('button.btn.primary', { onclick: () => find('quick'), title: 'At least 20 channels, about a minute' }, '⚡ Quick search'),
      h('button.btn', { onclick: () => find('deep'), title: 'About 40 channels, 2–4 minutes' }, '🔬 In-depth search'),
      pick),
    // Past searches; hover one for ✕ to remove it from the history.
    seeds.length ? h('div.chips.sim-recent', seeds.slice(0, 20).map((x) =>
      h('span.chip.sim-chip' + (x.seed.channelId === ui.similarSeed ? '.accent' : ''), { onclick: () => { ui.similarSeed = x.seed.channelId; render(); } },
        x.seed.title,
        h('button.sim-x', {
          title: 'Remove from history',
          'aria-label': `Remove ${x.seed.title} from history`,
          onclick: (e) => {
            e.stopPropagation();
            if (ui.similarSeed === x.seed.channelId) ui.similarSeed = null;
            send('forgetSimilar', { seedId: x.seed.channelId });
          },
        }, '✕')))) : null);

  if (!cur) {
    set($('list'), head, h('div.empty', h('h2', 'Find channels like any channel'), h('p', 'Paste a link above, or open a saved channel and click 🔍 Similar channels.')));
    return;
  }

  const seedRec = db.channels[cur.seed.channelId];
  const runningNow = cur.status === 'running';
  const pct = runningNow && cur.total ? Math.round((cur.done / cur.total) * 100) : 100;
  const SIM_SORTS = {
    similarity: ['Most similar', (r) => r.similarity],
    subs: ['Most subscribers', (r) => r.subs || 0],
    views: ['Highest avg views', (r) => r.medianViews || 0],
    newest: ['Newest channels', (r) => -(r.ageDays ?? 1e9)],
    uploads: ['Most uploads / month', (r) => r.uploadsPerMonth ?? -1],
    recent: ['Uploaded most recently', (r) => -(r.lastUpload ?? 1e9)],
    outliers: ['Most outliers', (r) => r.outliers || 0],
  };
  const sortKey = SIM_SORTS[ui.simSort] ? ui.simSort : 'similarity';
  const results = [...(cur.results || [])].sort((a, b) => SIM_SORTS[sortKey][1](b) - SIM_SORTS[sortKey][1](a));
  const sortSel = h('select.input.sim-sort', Object.entries(SIM_SORTS).map(([k, [label]]) => h('option', { value: k }, `Sort: ${label}`)));
  sortSel.value = sortKey;
  sortSel.addEventListener('change', () => { ui.simSort = sortSel.value; render(); });
  const modeLabel = cur.mode === 'deep' ? 'In-depth' : 'Quick';
  set($('list'),
    head,
    h('section.sim-seed',
      h('div.avatar', { style: cur.seed.avatar ? { backgroundImage: `url("${cur.seed.avatar}")` } : null }),
      h('div', h('h2', `Channels like ${cur.seed.title}`),
        h('div.vm', runningNow ? `${modeLabel} search · ${cur.stage}… ${cur.done}/${cur.total}` : cur.status === 'error' ? `Search failed: ${cur.error}` : `${results.length} channels · ${modeLabel} search · ${fmtAge((Date.now() - cur.at) / 86400000)}`)),
      h('div.sim-actions',
        results.length ? sortSel : null,
        h('button.btn', { disabled: runningNow, onclick: () => openSimilar(cur.seed.channelId, true, 'quick') }, runningNow ? 'Searching…' : '⚡ Quick again'),
        h('button.btn', { disabled: runningNow, onclick: () => openSimilar(cur.seed.channelId, true, 'deep') }, '🔬 In-depth'),
        results.length ? h('button.btn', { onclick: () => navigator.clipboard.writeText(results.map((r) => r.url).join('\n')).then(() => toast(`${results.length} links copied`)) }, 'Copy links') : null,
        h('button.icon-btn', { title: 'Remove this search', onclick: () => send('forgetSimilar', { seedId: cur.seed.channelId }) }, '✕'))),
    runningNow ? h('div.cs-looking',
      h('div.cs-glass', h('span', '🔍')),
      h('div.cs-looking-txt', h('b', 'Looking for you…'), h('div.vm', `${cur.stage || 'Starting'}${cur.total ? ` · ${cur.done}/${cur.total}` : ''}`)),
      h('div.cs-progress', h('i', { style: { width: `${pct}%` } }))) : null,
    results.length
      ? h('div.table-wrap', h('table.sim-table',
          h('thead', h('tr', ['Channel', 'Similarity', 'Subs', 'Avg views / video', 'Days since start', 'Uploads / month', 'Last upload', 'Outliers', 'Top video', ''].map((t, i) => h('th' + (i >= 2 && i <= 7 ? '.num' : ''), t)))),
          h('tbody', results.map((r) => similarRow(r, seedRec)))))
      : runningNow ? h('div.empty', h('p', 'Searching YouTube… results appear here as they are checked (about a minute).')) : h('div.empty', h('p', 'No similar channels found. Try another channel or search again later.')));
}

/* ---------- competitor tracking (drawer) ---------- */

function heatmap(sch) {
  const max = Math.max(1, ...sch.grid.flat());
  // Rows Mon..Sun read more naturally than Sun..Sat.
  const order = [1, 2, 3, 4, 5, 6, 0];
  return h('div.heat',
    h('div.heat-row.heat-hours', h('span'), [0, 3, 6, 9, 12, 15, 18, 21].map((hr) => h('span.hh', { style: { gridColumn: `${hr + 2} / span 3` } }, fmtHour(hr)))),
    order.map((d) => h('div.heat-row',
      h('span.hd', WEEKDAYS[d]),
      sch.grid[d].map((n, hr) => h('span.cell', {
        title: `${WEEKDAYS[d]} ${fmtHour(hr)}: ${n} upload${n === 1 ? '' : 's'}`,
        style: n ? { background: `rgba(139, 92, 246, ${0.25 + 0.75 * (n / max)})` } : null,
      })))));
}

const LOG_ICON = { upload: '▶', title: '✎', outlier: '🔥' };

function trackingSection(ch) {
  const tr = ch.track;
  const check = h('button.btn', { onclick: async (e) => {
    e.currentTarget.disabled = true;
    try {
      const r = await send('pollCompetitors');
      toast(r.events ? `${r.events} new update${r.events === 1 ? '' : 's'} found` : 'No new uploads');
    } catch (err) {
      toast(err.message, true);
    }
  } }, '⟳ Check now');
  if (!tr) {
    return h('div.section', h('h4', 'Competitor tracking'),
      h('div.note', 'Collecting upload history… it appears within a minute.'), check);
  }
  const sch = schedule(tr.uploads);
  const { rows, typical24h } = uploadStats(ch, 15);
  return h('div.section.track',
    h('h4', 'Competitor tracking'),
    h('div.kv',
      stat('Usually uploads', sch ? sch.summary : '—', sch ? `from ${sch.sample} recent uploads` : 'needs 2+ uploads'),
      stat(sch?.overdue ? 'Expected (late)' : 'Next upload likely', sch?.next ? fmtWhen(sch.next) : '—', sch?.next ? 'based on their pattern' : ''),
      stat('Uploads per week', sch?.perWeek ? sch.perWeek.toFixed(1) : '—', sch?.gapDays ? `every ${sch.gapDays.toFixed(1)} days` : ''),
      stat('Typical first 24h', fmtNum(typical24h), typical24h ? 'views on a new video' : 'fills in as new videos come out'),
      stat('Checked', tr.polledAt ? fmtAge((Date.now() - tr.polledAt) / 86400000) : '—', 'every 30 min while Chrome is open'),
      stat('Tracking since', new Date(tr.since).toLocaleDateString(), `${tr.uploads.length} uploads known`)),
    sch ? h('div.sub-h', 'When they upload (your local time)') : null,
    sch ? heatmap(sch) : null,
    h('div.sub-h', 'Uploads'),
    h('div.table-wrap', h('table.uploads',
      h('thead', h('tr', h('th', 'Published'), h('th', 'Video'), h('th.num', 'Views'), h('th.num', 'First 24h'), h('th.num', 'Views/hour'), h('th.num', 'Likes'))),
      h('tbody', rows.map((r) => h('tr', { onclick: () => window.open(ytVideo(r.id), '_blank', 'noopener') },
        h('td', fmtWhen(r.published)),
        h('td.vt-cell', r.title),
        h('td.num', r.views != null ? r.views.toLocaleString() : '—'),
        h('td.num' + (r.vs24 >= 1.5 ? '.hot' : r.vs24 != null && r.vs24 < 0.6 ? '.cold' : ''), r.v24 != null ? `${fmtNum(r.v24)}${r.vs24 ? ` · ${r.vs24.toFixed(1)}x` : ''}` : '—'),
        h('td.num', r.speed != null ? fmtNum(Math.max(0, r.speed)) : '—'),
        h('td.num', r.likes != null ? `${fmtNum(r.likes)}${r.likeRate ? ` · ${(r.likeRate * 100).toFixed(1)}%` : ''}` : '—')))))),
    h('div.note', 'First 24h is measured only for videos uploaded after tracking started (Chrome must be open around that time). 1.5x+ is green, under 0.6x is red.'),
    h('div.sub-h', 'Activity'),
    tr.log.length
      ? h('div.log-list', tr.log.slice(0, 30).map((l) => h('div.log-item',
          h('span.li', LOG_ICON[l.type] || '•'),
          h('div',
            h('div', l.type === 'upload' ? `Uploaded: ${l.text}` : l.type === 'title' ? `Changed title to: ${l.text}` : `Became an outlier (${(l.x || 0).toFixed(1)}x): ${l.text}`),
            l.type === 'title' && l.from ? h('div.vm', `Was: ${l.from}`) : null,
            h('div.vm', l.type === 'upload' && l.published ? `Published ${fmtWhen(l.published)}` : fmtWhen(l.t))))))
      : h('div.note', 'Nothing yet. New uploads, title changes and breakout videos will show up here.'),
    h('div', { style: { marginTop: '10px' } }, check));
}

/* ---------- drag & drop ---------- */

function dragStart(e, ch) {
  e.dataTransfer.setData('text/x-channel', ch.channelId);
  e.dataTransfer.effectAllowed = 'copy';
  document.body.classList.add('dragging');
}
function dragEnd() {
  document.body.classList.remove('dragging');
  document.querySelectorAll('.drop-over').forEach((n) => n.classList.remove('drop-over'));
}
function dropTarget(onDrop) {
  return {
    ondragover: (e) => {
      if (!e.dataTransfer.types.includes('text/x-channel')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      e.currentTarget.classList.add('drop-over');
    },
    ondragleave: (e) => e.currentTarget.classList.remove('drop-over'),
    ondrop: (e) => {
      e.preventDefault();
      const id = e.dataTransfer.getData('text/x-channel');
      dragEnd();
      if (id) Promise.resolve(onDrop(id)).catch((err) => toast(err.message, true));
    },
  };
}

/* ---------- updates ---------- */

function renderUpdate() {
  const u = db.settings.update;
  const box = $('updateBanner');
  $('versionBtn').textContent = `Version ${VERSION} · Check for updates`;
  if (!u) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  set(box,
    h('div',
      h('b', `Update available: version ${u.version}`),
      u.notes ? h('div.upd-notes', u.notes) : null,
      h('div.upd-steps', '1. Download  2. Unzip it over your channel-saver folder (replace files)  3. Click Restart. Your saved channels stay.')),
    u.download ? h('a.btn.primary', { href: u.download, target: '_blank', rel: 'noopener' }, 'Download') : null,
    h('button.btn', { onclick: () => send('restart') }, 'Restart'));
}

async function checkUpdates() {
  try {
    const r = await send('checkUpdate');
    if (!r.configured) toast(`You have version ${VERSION}. Automatic update checks start once an update link is set up.`);
    else if (r.unpublished) toast(`You have version ${VERSION}. No newer version has been published yet.`);
    else if (r.update) toast(`Version ${r.update.version} is available`);
    else toast(`You have the latest version (${VERSION})`);
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------- drawer ---------- */

function openDrawer(id) {
  ui.openId = id;
  history.replaceState(null, '', `#ch=${id}`);
  $('drawerWrap').hidden = false;
  renderDrawer();
  $('drawer').scrollTop = 0;
}

function closeDrawer() {
  ui.openId = null;
  history.replaceState(null, '', location.pathname);
  $('drawerWrap').hidden = true;
}

function growthChart(snaps) {
  const W = 560;
  const H = 120;
  const P = 24;
  if (!snaps || snaps.length < 2) {
    return h('div.stat', h('div.k', 'Subscriber growth'), h('div.s', 'The chart fills in as Channel Saver re-checks this channel each day. Come back tomorrow.'));
  }
  const xs = snaps.map((s) => s.t);
  const ys = snaps.map((s) => s.subs);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  let [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  if (y0 === y1) { y0 -= 1; y1 += 1; }
  const X = (x) => P + ((x - x0) / (x1 - x0 || 1)) * (W - 2 * P);
  const Y = (y) => H - P + 6 - ((y - y0) / (y1 - y0)) * (H - 2 * P);
  const pts = snaps.map((s) => `${X(s.t).toFixed(1)},${Y(s.subs).toFixed(1)}`).join(' ');
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Subscribers from ${fmtNum(ys[0])} to ${fmtNum(ys[ys.length - 1])}`);
  const mk = (tag, attrs, txt) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (txt) e.textContent = txt;
    svg.append(e);
  };
  mk('polygon', { points: `${X(x0)},${H - P + 6} ${pts} ${X(x1)},${H - P + 6}`, fill: 'rgba(139,92,246,0.15)' });
  mk('polyline', { points: pts, fill: 'none', stroke: '#8b5cf6', 'stroke-width': 2, 'stroke-linejoin': 'round' });
  mk('text', { x: P, y: 14 }, `${fmtNum(y1)} subs`);
  mk('text', { x: P, y: H - 4 }, new Date(x0).toLocaleDateString());
  mk('text', { x: W - P, y: H - 4, 'text-anchor': 'end' }, new Date(x1).toLocaleDateString());
  return svg;
}

function renderDrawer() {
  const ch = db.channels[ui.openId];
  const d = $('drawer');
  if (!ch) {
    closeDrawer();
    return;
  }
  const m = M(ch);
  const g = growthText(m);
  const busy = refreshing.has(ch.channelId);

  const notes = h('textarea', { rows: 4, placeholder: 'Why did you save this channel? Ideas, style, what to copy…' });
  notes.value = ch.notes || '';
  let notesTimer;
  notes.addEventListener('input', () => {
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => send('updateChannel', { channelId: ch.channelId, patch: { notes: notes.value } }), 500);
  });


  const shortsTop = [...(ch.shorts || [])].sort((a, b) => b.views - a.views).slice(0, 6);

  set(d, 
    h('button.icon-btn.d-close', { onclick: closeDrawer, 'aria-label': 'Close' }, '✕'),
    h('div.d-banner', { style: ch.banner ? { backgroundImage: `url("${ch.banner}")` } : null }),
    h('div.d-head',
      h('div.avatar', { style: ch.avatar ? { backgroundImage: `url("${ch.avatar}")` } : null }),
      scoreBadge(m.score)),
    h('div.d-body',
      h('h2', ch.title),
      h('div.d-sub', [ch.handle, `${fmtNum(ch.subs)} subscribers`, `${fmtNum(ch.videoCount)} videos`, ch.totalViews ? `${fmtNum(ch.totalViews)} total views` : null].filter(Boolean).join(' · ')),
      h('div.chips', { style: { padding: '10px 0 0' } }, channelChips(ch, m)),
      h('div.d-actions',
        h('a.btn.primary', { href: ch.url, target: '_blank', rel: 'noopener' }, 'Open on YouTube ↗'),
        h('button.btn', { onclick: () => refresh(ch.channelId), disabled: busy }, busy ? 'Refreshing…' : '⟳ Refresh'),
        h('button.btn' + (ch.starred ? '.primary' : ''), { onclick: () => send('updateChannel', { channelId: ch.channelId, patch: { starred: !ch.starred } }) }, ch.starred ? '🔖 Need to look' : '🔖 Mark: need to look'),
        h('button.btn' + (ch.competitor ? '.primary' : ''), { onclick: () => toggleCompetitor(ch) }, ch.competitor ? '⚔ Competitor' : '⚔ Add to competitors'),
        h('button.btn', { onclick: () => { closeDrawer(); openSimilar(ch.channelId); } }, '🔍 Similar channels'),
        h('button.btn.danger', { onclick: () => deleteChannel(ch) }, 'Delete')),

      ch.competitor ? trackingSection(ch) : null,

      h('div.section', h('h4', 'Views & RPM'),
        h('div.kv',
          stat('RPM', rpmText(ch), rpmFor(ch) ? 'set on the niche' : 'set it from the niche ⋯ menu'),
          stat('Views per month', fmtNum(m.monthlyViews), m.monthlySource),
          stat('Monetisation', m.monetizable ? '1K+ subs' : 'Under 1K subs', m.monetizable ? 'meets the subscriber rule' : 'probably not monetised yet'))),

      h('div.section', h('h4', 'Growth'),
        h('div.kv',
          stat('Subscribers / day', g.v, m.growth ? `over ${m.growth.days} days` : 'needs 2+ days of data'),
          stat('Channel age', fmtChannelAge(m.ageDays), ch.joined ? `joined ${ch.joined}` : ''),
          stat('Uploads / week', m.uploadsPerWeek != null ? m.uploadsPerWeek.toFixed(1) : '—', m.daysSinceUpload != null ? `last upload ${fmtAge(m.daysSinceUpload)}` : ''),
          stat('Median views', fmtNum(m.medianViews), 'per recent long video'),
          stat('Views per sub', m.viewsPerSub != null ? m.viewsPerSub.toFixed(2) : '—', 'above 0.5 = audience is hungry'),
          stat('Typical length', fmtDuration(m.avgDuration) || '—', m.format)),
        h('div', { style: { marginTop: '10px' } }, growthChart(ch.snapshots))),

      h('div.section', h('h4', `Outlier videos (${m.outliers.length}) — ${OUTLIER_X}x+ the channel's median`),
        m.outliers.length
          ? h('div.vlist', m.outliers.slice(0, 8).map((v) => vrow(v, `${v.x.toFixed(1)}x median`)))
          : h('div.note', 'No video has beaten this channel\'s median by 3x yet.')),

      h('div.section', h('h4', 'Top videos by views'),
        h('div.vlist', m.top.slice(0, 6).map((v) => vrow(v)))),

      shortsTop.length
        ? h('div.section', h('h4', `Top Shorts (of latest ${ch.shorts.length})`),
            h('div.vlist', shortsTop.map((s) => h('a.vrow', { href: ytShort(s.id), target: '_blank', rel: 'noopener' },
              h('div.thumb', { style: { backgroundImage: `url("${thumb(s.id)}")`, width: '64px', aspectRatio: '9/16' } }),
              h('div', h('div.vt', s.title), h('div.vm', `${fmtNum(s.views)} views`))))))
        : null,

      h('div.section', h('h4', 'Niches'),
        h('div.checks',
          db.niches.map((n) => {
            const on = ch.nicheIds.includes(n.id);
            return h('button.check' + (on ? '.on' : ''), {
              '--c': n.color,
              onclick: () => send('setNiche', { channelId: ch.channelId, nicheId: n.id, on: !on }),
            }, n.title);
          }),
          h('button.check', { '--c': 'var(--faint)', onclick: () => newNiche(ch.channelId) }, '+ New niche'))),


      h('div.section', h('h4', 'Notes'), notes),

      ch.description ? h('div.section', h('h4', 'About'), h('div.desc', ch.description)) : null,
      ch.links?.length
        ? h('div.section', h('h4', 'Links'), h('div.links', ch.links.map((l) =>
            h('a', { href: /^https?:/.test(l.url) ? l.url : `https://${l.url}`, target: '_blank', rel: 'noopener' }, l.title || l.url))))
        : null,
      h('div.note', `Added ${new Date(ch.addedAt).toLocaleDateString()} · data from ${new Date(ch.fetchedAt).toLocaleString()}`)),
  );
}

function vrow(v, extra) {
  return h('a.vrow', { href: ytVideo(v.id), target: '_blank', rel: 'noopener' },
    h('div.thumb', { style: { backgroundImage: `url("${thumb(v.id)}")` } }, v.duration ? h('span.dur', fmtDuration(v.duration)) : null),
    h('div', h('div.vt', v.title), h('div.vm', [`${fmtNum(v.views)} views`, fmtAge(v.age), extra].filter(Boolean).join(' · '))));
}

/* ---------- actions ---------- */

async function refresh(id) {
  if (refreshing.has(id)) return;
  refreshing.add(id);
  render();
  try {
    const res = await send('refresh', { channelId: id });
    if (res?.error) toast(res.error, true);
    else toast('Updated');
  } catch (e) {
    toast(e.message, true);
  } finally {
    refreshing.delete(id);
    render();
  }
}

async function deleteChannel(ch) {
  if (!confirm(`Delete ${ch.title} from Channel Saver? Its notes will be lost.`)) return;
  await send('deleteChannel', { channelId: ch.channelId });
  closeDrawer();
  toast('Deleted');
}

async function newNiche(attachTo) {
  const title = prompt('Niche name (for example "Ancient history", "AI tools"):');
  if (!title?.trim()) return;
  try {
    const { niche } = await send('createNiche', { title });
    if (attachTo) await send('setNiche', { channelId: attachTo, nicheId: niche.id, on: true });
    else setView(niche.id);
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------- popup menus ---------- */

let pop = null;
function closePop() {
  pop?.remove();
  pop = null;
}
function popMenu(x, y, items) {
  closePop();
  pop = h('div.menu-pop', items.map((it) => (it === '-' ? h('hr') : h('button' + (it.danger ? '.danger' : ''), { onclick: () => { closePop(); it.fn(); } }, it.label))));
  document.body.append(pop);
  const r = pop.getBoundingClientRect();
  pop.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  pop.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
}
document.addEventListener('mousedown', (e) => { if (pop && !pop.contains(e.target)) closePop(); });

function channelMenu(ch, x, y) {
  popMenu(x, y, [
    { label: 'Details', fn: () => openDrawer(ch.channelId) },
    { label: 'Find similar channels', fn: () => openSimilar(ch.channelId) },
    { label: 'Refresh data', fn: () => refresh(ch.channelId) },
    { label: ch.competitor ? 'Remove from competitors' : 'Add to competitors', fn: () => toggleCompetitor(ch) },
    { label: ch.starred ? 'Remove from Need to look' : 'Need to look', fn: () => send('updateChannel', { channelId: ch.channelId, patch: { starred: !ch.starred } }) },
    { label: 'Copy link', fn: () => navigator.clipboard.writeText(ch.url).then(() => toast('Link copied')) },
    '-',
    ...(nicheById(ui.view) ? [{ label: `Remove from ${nicheById(ui.view).title}`, fn: () => send('setNiche', { channelId: ch.channelId, nicheId: ui.view, on: false }) }] : []),
    { label: 'Delete channel', danger: true, fn: () => deleteChannel(ch) },
  ]);
}

function nicheMenu(n, x, y) {
  popMenu(x, y, [
    { label: 'Rename', fn: async () => {
      const t = prompt('New name', n.title);
      if (t?.trim()) await send('updateNiche', { id: n.id, patch: { title: t.trim().slice(0, 80) } });
    } },
    { label: n.pinned ? 'Unpin' : 'Pin to top', fn: () => send('updateNiche', { id: n.id, patch: { pinned: !n.pinned } }) },
    { label: 'RPM & notes…', fn: () => nicheSettings(n) },
    { label: 'Copy all channel links', fn: () => copyLinks(Object.values(db.channels).filter((c) => c.nicheIds.includes(n.id))) },
    '-',
    { label: 'Delete niche', danger: true, fn: async () => {
      if (!confirm(`Delete the niche "${n.title}"? Channels stay saved, they just leave this niche.`)) return;
      await send('deleteNiche', { id: n.id });
    } },
  ]);
}

/* ---------- modals ---------- */

function openModal(...content) {
  set($('modal'), ...content);
  $('modalWrap').hidden = false;
}
function closeModal() {
  $('modalWrap').hidden = true;
}

function nicheSettings(n) {
  const low = h('input.input', { type: 'number', min: 0, step: 0.1, placeholder: '1' });
  const high = h('input.input', { type: 'number', min: 0, step: 0.1, placeholder: '4' });
  const notes = h('textarea', { rows: 5, placeholder: 'What you learned about this niche, video ideas, competitors…' });
  low.value = n.rpmLow ?? '';
  high.value = n.rpmHigh ?? '';
  notes.value = n.notes || '';
  openModal(
    h('h3', n.title),
    h('p', 'RPM = what YouTube pays per 1,000 views. It is shown on every channel in this niche.'),
    h('div.row', h('label.field', 'RPM low ($)', low), h('label.field', 'RPM high ($)', high)),
    h('label.field', 'Notes', notes),
    h('div.actions',
      h('button.btn', { onclick: closeModal }, 'Cancel'),
      h('button.btn.primary', { onclick: async () => {
        const num = (v) => (v === '' ? null : Math.max(0, Number(v)));
        let lo = num(low.value);
        let hi = num(high.value);
        if (lo != null && hi == null) hi = lo;
        if (hi != null && lo == null) lo = hi;
        if (lo != null && lo > hi) [lo, hi] = [hi, lo];
        await send('updateNiche', { id: n.id, patch: { rpmLow: lo, rpmHigh: hi, notes: notes.value } });
        closeModal();
        toast('Saved');
      } }, 'Save')),
  );
}

function addModal() {
  const area = h('textarea', { rows: 7, placeholder: 'https://www.youtube.com/@channel\n@anotherchannel\nhttps://www.youtube.com/watch?v=…' });
  const sel = h('select.input',
    h('option', { value: '' }, 'No niche'),
    [...db.niches].sort((a, b) => a.title.localeCompare(b.title)).map((n) => h('option', { value: n.id }, n.title)),
    h('option', { value: '__new' }, '+ Create new niche…'));
  if (nicheById(ui.view)) sel.value = ui.view;
  const newName = h('input.input', { placeholder: 'New niche name, e.g. "Ancient history"', maxlength: 80 });
  const newField = h('label.field', { hidden: true }, 'New niche name', newName);
  sel.addEventListener('change', () => {
    newField.hidden = sel.value !== '__new';
    if (!newField.hidden) newName.focus();
  });
  // Resolves the chosen niche to an id, creating it first if needed.
  async function targetNiche() {
    if (sel.value !== '__new') return sel.value || null;
    const title = newName.value.trim();
    if (!title) throw new Error('Write a name for the new niche');
    const { niche } = await send('createNiche', { title });
    // Keep it selected for the rest of this run and any next run.
    sel.insertBefore(h('option', { value: niche.id }, niche.title), sel.lastElementChild);
    sel.value = niche.id;
    newField.hidden = true;
    newName.value = '';
    return niche.id;
  }
  const bar = h('div', { style: { width: '0%' } });
  const progress = h('div.progress', { hidden: true }, bar);
  const log = h('div.log');
  let stop = false;
  const go = h('button.btn.primary', { onclick: run }, 'Add');
  const cancel = h('button.btn', { onclick: () => { stop = true; closeModal(); } }, 'Close');

  async function run() {
    const lines = [...new Set(area.value.split(/[\r\n,\t]+/).map((s) => s.trim()).filter(Boolean))];
    if (!lines.length) return;
    let nicheId;
    try {
      nicheId = await targetNiche();
    } catch (e) {
      toast(e.message, true);
      newName.focus();
      return;
    }
    stop = false;
    go.disabled = true;
    area.disabled = true;
    progress.hidden = false;
    log.textContent = '';
    const failed = [];
    for (let i = 0; i < lines.length && !stop; i++) {
      bar.style.width = `${(i / lines.length) * 100}%`;
      try {
        const res = await send('add', { input: lines[i], nicheId });
        log.prepend(h('div', `${res.already ? '• Already there' : '✓ Added'}: ${res.channel.title}`));
      } catch (e) {
        failed.push(lines[i]);
        log.prepend(h('div.bad', `✕ ${lines[i]} — ${e.message}`));
      }
      // A short pause keeps YouTube from rate-limiting a long list.
      if (i < lines.length - 1) await new Promise((r) => setTimeout(r, 1200));
    }
    bar.style.width = '100%';
    area.disabled = false;
    area.value = failed.join('\n');
    go.disabled = false;
    toast(failed.length ? `${lines.length - failed.length} added, ${failed.length} failed` : `${lines.length} added`, !!failed.length);
  }

  openModal(
    h('h3', 'Add channels'),
    h('p', 'Paste channel or video links, one per line. Many at once is fine — they are added one by one. Failed links stay in the box.'),
    h('label.field', 'Links', area),
    h('label.field', 'Put them in', sel),
    newField,
    progress, log,
    h('div.actions', cancel, go),
  );
  area.focus();
}

/* ---------- export / import ---------- */

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function copyLinks(list) {
  if (!list.length) return toast('No channels to copy', true);
  navigator.clipboard.writeText(list.map((c) => c.url).join('\n')).then(() => toast(`${list.length} links copied`));
}

function exportCsv() {
  const list = visibleChannels();
  if (!list.length) return toast('Nothing to export', true);
  const head = ['Channel', 'Handle', 'URL', 'Niches', 'Subscribers', 'Videos', 'Total views', 'Joined', 'Channel age (days)', 'Country',
    'Opportunity score', 'Median views', 'Views per month', 'RPM', 'Subs per day',
    'Uploads per week', 'Outlier videos', 'Format', 'Competitor', 'Need to look', 'Added', 'Notes'];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = list.map((c) => {
    const m = M(c);
    return [c.title, c.handle, c.url, c.nicheIds.map((id) => nicheById(id)?.title).filter(Boolean).join('; '), c.subs, c.videoCount, c.totalViews,
      c.joined, m.ageDays != null ? Math.round(m.ageDays) : '', c.country, m.score, Math.round(m.medianViews), Math.round(m.monthlyViews),
      rpmFor(c) ? rpmText(c) : '', m.growth ? m.growth.subsPerDay.toFixed(1) : '',
      m.uploadsPerWeek != null ? m.uploadsPerWeek.toFixed(1) : '', m.outliers.length, m.format,
      c.competitor ? 'Yes' : '', c.starred ? 'Yes' : '', new Date(c.addedAt).toLocaleDateString(), c.notes];
  });
  // BOM so Excel reads Urdu/emoji titles correctly.
  download(`channel-saver-${new Date().toISOString().slice(0, 10)}.csv`, `﻿${[head, ...rows].map((r) => r.map(esc).join(',')).join('\r\n')}`, 'text/csv');
}

function backup() {
  const data = { app: 'channel-saver', version: VERSION, exportedAt: new Date().toISOString(), niches: db.niches, channels: db.channels, swipe: db.swipe || [] };
  download(`channel-saver-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), 'application/json');
}

async function importFile(file) {
  try {
    const data = JSON.parse(await file.text());
    const res = await send('importData', { data });
    toast(`Restored ${res.channels} channels, ${res.niches} niches${res.swipe ? ` and ${res.swipe} swipes` : ''}`);
  } catch (e) {
    toast(e.message.includes('JSON') ? 'That file is not a backup' : e.message, true);
  }
}

/* ---------- wiring ---------- */

function bind() {
  $('search').addEventListener('input', (e) => { ui.search = e.target.value; render(); });
  $('nicheSearch').addEventListener('input', (e) => { ui.nicheSearch = e.target.value; renderSide(); });
  for (const [id, key] of [['sort', 'sort'], ['fFormat', 'format'], ['fAge', 'age']]) {
    $(id).addEventListener('change', (e) => { ui[key] = e.target.value; saveUi(); render(); });
  }
  $('viewCards').onclick = () => { ui.layout = 'cards'; saveUi(); render(); };
  $('viewTable').onclick = () => { ui.layout = 'table'; saveUi(); render(); };
  $('addBtn').onclick = () => addModal();
  $('newNicheBtn').onclick = () => newNiche();
  $('nicheOpts').onclick = (e) => {
    const n = nicheById(ui.view);
    const r = e.currentTarget.getBoundingClientRect();
    if (n) nicheMenu(n, r.left, r.bottom + 6);
  };
  $('copyLinks').onclick = () => copyLinks(visibleChannels());
  $('exportCsv').onclick = exportCsv;
  $('versionBtn').onclick = checkUpdates;
  $('settingsBtn').onclick = settingsModal;
  $('backupInfo').onclick = async () => {
    try {
      const r = await send('backupNow');
      toast(r.ok ? `Backed up ${r.channels} channels to Downloads › Channel Saver Backups` : `Nothing to back up (${r.skipped})`);
    } catch (e) {
      toast(e.message, true);
    }
  };
  $('backupBtn').onclick = backup;
  $('importBtn').onclick = () => $('importFile').click();
  $('importFile').onchange = (e) => { if (e.target.files[0]) importFile(e.target.files[0]); e.target.value = ''; };
  $('autoRefresh').onchange = (e) => send('saveSettings', { patch: { autoRefresh: e.target.checked } });
  $('notify').onchange = (e) => send('saveSettings', { patch: { notify: e.target.checked } });
  $('menuBtn').onclick = () => $('side').classList.toggle('open');
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { closeDrawer(); closeModal(); }));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closePop(); closeModal(); closeDrawer(); }
  });
  // Right-click a niche for its menu; also a ⋯ on hover would crowd the list.
  $('niches').title = 'Right-click a niche for rename, RPM, notes, delete';
  window.addEventListener('hashchange', fromHash);
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    await loadDb();
    render();
  });
}

function fromHash() {
  const id = /#ch=([\w-]+)/.exec(location.hash)?.[1];
  if (id && db.channels[id]) openDrawer(id);
  const sim = /#similar=(.+)$/.exec(location.hash)?.[1];
  if (sim) {
    history.replaceState(null, '', location.pathname);
    openSimilar(decodeURIComponent(sim));
  }
}

async function loadDb() {
  const s = await chrome.storage.local.get(['niches', 'channels', 'settings', 'similar', 'swipe']);
  db = { niches: s.niches || [], channels: s.channels || {}, settings: s.settings || {}, similar: s.similar || {}, swipe: s.swipe || [] };
}

await loadDb();
initCtr({ h, set, send, toast, fmtNum, fmtDuration, fmtAge, getDb: () => db, $ });
bind();
render();
fromHash();
