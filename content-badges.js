/**
 * Every video tile on YouTube gets a small badge row: channel subscribers,
 * outlier score (this video's views ÷ the channel's typical views) and views
 * per hour. The tiles' numbers also feed the Filter panel and the channel
 * hover preview.
 */
(() => {
  const CS = window.CS;
  const { el } = CS;

  const TILE = 'ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-rich-grid-media, yt-lockup-view-model, ytd-reel-item-renderer, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2';
  const tiles = new Map(); // videoId → record (latest seen)

  function readTile(t) {
    const link = t.querySelector('a[href*="/watch?v="], a[href^="/shorts/"]');
    if (!link) return null;
    const u = new URL(link.getAttribute('href'), location.origin);
    const id = u.searchParams.get('v') || /^\/shorts\/([\w-]{11})/.exec(u.pathname)?.[1];
    if (!id) return null;
    const isShort = u.pathname.startsWith('/shorts/') || t.matches('ytd-reel-item-renderer, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2');
    const txt = (t.innerText || '').replace(/ /g, ' ');
    // Exact views live in the title link's aria-label ("… 153,456 views 4 months ago …").
    const labels = [...t.querySelectorAll('a[aria-label], h3[aria-label], [aria-label*="views"]')].map((a) => a.getAttribute('aria-label')).join(' ');
    // Some layouts print just "153K • 4mo ago" with no "views" word.
    const bits = [...t.querySelectorAll('#metadata-line span, .inline-metadata-item, .yt-content-metadata-view-model__metadata-text, .yt-content-metadata-view-model-wiz__metadata-text')].map((s) => s.textContent.trim());
    const views = /([\d.,]+\s*[KMB]?)\s*views?/i.exec(labels) || /([\d.,]+\s*[KMB]?)\s*views?/i.exec(txt)
      || (() => {
        const b = bits.find((x) => /^[\d.,]+\s*[KMB]?(\s*views?)?$/i.test(x));
        return b ? [b, b] : null;
      })();
    const watching = /([\d.,]+\s*[KMB]?)\s*watching/i.test(txt);
    const ageRe = /(?:Streamed\s+)?(\d+\s*(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?|[smhdwy]|mo))\s+ago/i;
    const age = ageRe.exec(bits.join(' • ')) || ageRe.exec(txt) || ageRe.exec(labels);
    const titleEl = t.querySelector('#video-title, h3, .yt-lockup-metadata-view-model__title, a[title]');
    let channelPath = CS.channelPathFrom(t);
    if (!channelPath && CS.page() === 'channel') channelPath = CS.liteKey(location.pathname);
    const dur = /(\d+:)?\d+:\d\d/.exec(t.querySelector('badge-shape, .ytd-thumbnail-overlay-time-status-renderer, ytd-thumbnail-overlay-time-status-renderer, .yt-badge-shape__text')?.textContent || '')?.[0];
    return {
      id,
      isShort,
      live: watching,
      title: (titleEl?.getAttribute('title') || titleEl?.textContent || '').trim(),
      views: views ? CS.parseCount(views[1]) : null,
      ageDays: age ? CS.parseAge(age[1]) : null,
      channelPath,
      channelName: (t.querySelector('ytd-channel-name #text, ytd-channel-name a, .yt-content-metadata-view-model__metadata-text, .yt-content-metadata-view-model-wiz__metadata-text')?.textContent || '').trim(),
      duration: dur ? CS.parseMmss(dur) : null,
    };
  }

  function badgeHost(t) {
    return t.querySelector('#metadata-line')?.parentElement
      || t.querySelector('.yt-lockup-metadata-view-model__text-container, yt-content-metadata-view-model, .yt-lockup-metadata-view-model-wiz__text-container')
      || t.querySelector('#meta, #details, #dismissible')
      || t;
  }

  function paint(t, rec, lite) {
    let row = t.querySelector(':scope .cs-badges');
    if (!row) {
      row = el('div', 'cs-badges');
      badgeHost(t).appendChild(row);
    }
    row.replaceChildren();
    const add = (cls, text, title) => {
      const b = el('span', `cs-b ${cls}`, text);
      if (title) b.title = title;
      row.append(b);
    };
    if (lite?.subs) add('subs', `👤 ${CS.num(lite.subs)}`, `${lite.title || 'Channel'}: ${lite.subs.toLocaleString()} subscribers`);
    if (rec.outlier != null) {
      const x = rec.outlier;
      add(x >= 3 ? 'hot' : x >= 1.5 ? 'warm' : x < 0.5 ? 'cold' : '', `${x >= 10 ? Math.round(x) : x.toFixed(1)}x`, `Outlier: ${x.toFixed(1)}× this channel's typical views (${CS.num(lite.medianViews)})`);
    }
    if (rec.vph != null) add('vph', `${CS.num(rec.vph)}/h`, 'Views per hour since upload');
    // 📸 share card for this video.
    const cam = el('button', 'cs-b cs-cam', '📸');
    cam.type = 'button';
    cam.title = 'Share card of this video';
    cam.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      CS.shareCard?.({ id: rec.id, title: rec.title, channelName: rec.channelName || lite?.title, views: rec.views, ageText: rec.ageDays != null ? CS.ago(rec.ageDays) : '', duration: rec.duration, avatar: lite?.avatar });
    });
    if (row.childElementCount) row.append(cam);
    row.hidden = !row.childElementCount;
  }

  async function decorate(t) {
    const rec = readTile(t);
    if (!rec) return;
    // YouTube fills tile text in after inserting it: retry a few ticks until views appear.
    const tries = t.dataset.csId === rec.id ? Number(t.dataset.csTries || 0) + 1 : 1;
    t.dataset.csId = rec.id;
    t.dataset.csTries = String(tries);
    t.dataset.csFull = rec.views != null || rec.live || tries >= 6 ? '1' : '';
    if (rec.views != null && rec.ageDays) rec.vph = rec.views / Math.max(1, rec.ageDays * 24);
    tiles.set(rec.id, { ...tiles.get(rec.id), ...rec, el: t });
    paint(t, rec, null);
    if (!rec.channelPath) return;
    const lite = await CS.lite(rec.channelPath);
    if (!lite || t.dataset.csId !== rec.id) return; // tile reused for another video meanwhile
    rec.subs = lite.subs;
    rec.channelName = rec.channelName || lite.title;
    rec.channelAge = lite.ageDays;
    if (rec.views != null && lite.medianViews > 0 && !rec.live) rec.outlier = rec.views / lite.medianViews;
    tiles.set(rec.id, { ...tiles.get(rec.id), ...rec, el: t });
    paint(t, rec, lite);
  }

  CS.tiles = () => [...tiles.values()].filter((r) => r.el?.isConnected);

  CS.onTick(() => {
    if (!CS.features.badges && !CS.features.filter) return;
    if (!['home', 'search', 'subscriptions', 'watch', 'channel'].includes(CS.page())) return;
    for (const t of document.querySelectorAll(TILE)) {
      if (t.parentElement?.closest(TILE)) continue; // inner part of a tile we already handle
      const id = readTile(t)?.id;
      if (!id || (t.dataset.csId === id && t.dataset.csFull === '1')) continue;
      decorate(t);
    }
    document.documentElement.classList.toggle('cs-no-badges', !CS.features.badges);
  });

  /* ---------- Filter panel ---------- */

  let fab = null;
  let panel = null;
  const f = { sort: 'outlier', maxSubs: '', minViews: '', within: '', format: '', minOutlier: '' };

  function ensureFab() {
    const on = CS.features.filter && ['home', 'search', 'subscriptions'].includes(CS.page());
    if (!on) {
      fab?.remove();
      fab = null;
      panel?.remove();
      panel = null;
      return;
    }
    if (!fab) {
      fab = el('button', 'cs-fab');
      fab.type = 'button';
      fab.addEventListener('click', () => (panel?.isConnected ? closePanel() : openPanel()));
      document.body.appendChild(fab);
    }
    fab.textContent = `⚡ Filter ${CS.tiles().length} videos`;
  }

  function closePanel() {
    panel?.remove();
    panel = null;
  }

  function filtered() {
    const now = { day: 1, week: 7, month: 31, year: 365 }[f.within];
    let list = CS.tiles().filter((r) => !r.live);
    if (f.format === 'long') list = list.filter((r) => !r.isShort);
    if (f.format === 'shorts') list = list.filter((r) => r.isShort);
    if (f.maxSubs) list = list.filter((r) => r.subs != null && r.subs <= Number(f.maxSubs));
    if (f.minViews) list = list.filter((r) => (r.views || 0) >= Number(f.minViews));
    if (now) list = list.filter((r) => r.ageDays != null && r.ageDays <= now);
    if (f.minOutlier) list = list.filter((r) => (r.outlier || 0) >= Number(f.minOutlier));
    const key = {
      outlier: (r) => r.outlier ?? -1,
      ratio: (r) => (r.subs ? (r.views || 0) / r.subs : -1),
      vph: (r) => r.vph ?? -1,
      views: (r) => r.views ?? -1,
      newest: (r) => -(r.ageDays ?? 1e9),
      smallest: (r) => -(r.subs ?? 1e12),
    }[f.sort] || ((r) => r.outlier ?? -1);
    return list.sort((a, b) => key(b) - key(a));
  }

  function select(name, label, options) {
    const s = el('select');
    for (const [v, t] of options) {
      const o = el('option', null, t);
      o.value = v;
      s.append(o);
    }
    s.value = f[name];
    s.addEventListener('change', () => {
      f[name] = s.value;
      paintPanel();
    });
    const wrap = el('label', 'cs-f');
    wrap.append(el('span', null, label), s);
    return wrap;
  }

  // The panel repaints itself as data arrives, so the button's state lives here.
  let loading = false;

  async function loadMore() {
    if (loading) return;
    loading = true;
    const endBusy = globalThis.CSBusy?.start('Loading more videos…') || (() => {});
    paintPanel();
    const start = CS.tiles().length;
    const y = window.scrollY;
    let stalled = 0;
    for (let i = 0; i < 14 && CS.tiles().length < start + 80 && stalled < 4; i++) {
      const n = CS.tiles().length;
      const btn = panel?.querySelector('.cs-more');
      if (btn) btn.textContent = `Loading… ${n} videos`;
      // YouTube loads the next page when its continuation spinner comes into view.
      const spinner = document.querySelector('ytd-continuation-item-renderer');
      if (spinner) spinner.scrollIntoView({ block: 'center' });
      window.scrollTo(0, document.documentElement.scrollHeight);
      window.dispatchEvent(new Event('scroll'));
      await new Promise((r) => setTimeout(r, 1500));
      CS.schedule();
      await new Promise((r) => setTimeout(r, 600));
      stalled = CS.tiles().length > n ? 0 : stalled + 1;
    }
    window.scrollTo(0, y);
    loading = false;
    endBusy();
    paintPanel();
    if (CS.tiles().length === start) CS.toast('YouTube has no more results for this page.');
  }

  function openPanel() {
    CS.closePanels();
    panel = el('aside', 'cs-panel');
    document.body.appendChild(panel);
    paintPanel();
  }

  function paintPanel() {
    // Another tool's panel may have replaced ours.
    if (panel && !panel.isConnected) panel = null;
    if (!panel) return;
    const head = el('div', 'cs-panel-head');
    const close = el('button', 'cs-x', '✕');
    close.addEventListener('click', closePanel);
    head.append(el('b', null, 'Filter loaded videos'), close);

    const controls = el('div', 'cs-filters');
    controls.append(
      select('sort', 'Sort', [['outlier', 'Outlier score'], ['ratio', 'Views ÷ subscribers'], ['vph', 'Views per hour'], ['views', 'Most views'], ['newest', 'Newest'], ['smallest', 'Smallest channels']]),
      select('within', 'Uploaded', [['', 'Any time'], ['day', 'Today'], ['week', 'This week'], ['month', 'This month'], ['year', 'This year']]),
      select('format', 'Format', [['', 'All'], ['long', 'Long videos'], ['shorts', 'Shorts']]),
      select('maxSubs', 'Channel size', [['', 'Any'], ['1000', 'Under 1K subs'], ['10000', 'Under 10K'], ['50000', 'Under 50K'], ['100000', 'Under 100K'], ['500000', 'Under 500K']]),
      select('minViews', 'Views', [['', 'Any'], ['10000', '10K+'], ['100000', '100K+'], ['1000000', '1M+']]),
      select('minOutlier', 'Outlier', [['', 'Any'], ['1.5', '1.5x+'], ['3', '3x+'], ['5', '5x+'], ['10', '10x+']]),
    );

    const list = filtered();
    const more = el('button', 'cs-more', loading ? `Loading… ${CS.tiles().length} videos` : 'Load more videos');
    more.disabled = loading;
    more.addEventListener('click', loadMore);
    const info = el('div', 'cs-panel-info', `${list.length} of ${CS.tiles().length} loaded videos match. Badges fill in as channel data loads.`);

    const rows = el('div', 'cs-results');
    for (const r of list.slice(0, 150)) {
      const a = el('a', 'cs-res');
      a.href = r.isShort ? `/shorts/${r.id}` : `/watch?v=${r.id}`;
      const th = el('div', 'cs-res-th');
      th.style.backgroundImage = `url("https://i.ytimg.com/vi/${r.id}/mqdefault.jpg")`;
      if (r.outlier != null) th.append(el('span', `cs-res-x${r.outlier >= 3 ? ' hot' : ''}`, `${r.outlier >= 10 ? Math.round(r.outlier) : r.outlier.toFixed(1)}x`));
      const meta = el('div', 'cs-res-meta');
      meta.append(
        el('div', 'cs-res-t', r.title),
        el('div', 'cs-res-s', [r.channelName, r.subs != null ? `${CS.num(r.subs)} subs` : ''].filter(Boolean).join(' · ')),
        el('div', 'cs-res-s', [r.views != null ? `${CS.num(r.views)} views` : '', r.ageDays != null ? CS.ago(r.ageDays) : '', r.vph != null ? `${CS.num(r.vph)}/h` : '', r.isShort ? 'Short' : ''].filter(Boolean).join(' · ')),
      );
      a.append(th, meta);
      rows.append(a);
    }
    if (!list.length) rows.append(el('div', 'cs-panel-info', 'No loaded video matches. Loosen a filter or load more videos.'));
    panel.replaceChildren(head, controls, info, rows, more);
  }

  CS.onTick(() => {
    ensureFab();
    // Keep the open panel current as more tiles and channel data arrive.
    if (panel && !panel.matches(':hover')) paintPanel();
  });

  /* ---------- channel hover preview ---------- */

  let card = null;
  let showTimer = null;
  let hideTimer = null;
  let anchor = null;

  function hideCard() {
    clearTimeout(showTimer);
    hideTimer = setTimeout(() => {
      card?.remove();
      card = null;
      anchor = null;
    }, 250);
  }

  async function showCard(a, path) {
    const lite = await CS.lite(path);
    if (!lite || anchor !== a) return;
    card?.remove();
    card = el('div', 'cs-hover');
    card.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    card.addEventListener('mouseleave', hideCard);
    const head = el('div', 'cs-hover-head');
    const av = el('div', 'cs-hover-av');
    if (lite.avatar) av.style.backgroundImage = `url("${lite.avatar}")`;
    const who = el('div');
    who.append(el('b', null, lite.title || path), el('div', 'cs-res-s', [lite.handle, lite.country].filter(Boolean).join(' · ')));
    head.append(av, who);
    const stats = el('div', 'cs-hover-stats');
    const stat = (k, v) => {
      const s = el('div');
      s.append(el('span', null, k), el('b', null, v));
      stats.append(s);
    };
    stat('Subscribers', CS.num(lite.subs));
    stat('Videos', CS.num(lite.videoCount));
    stat('Typical views', CS.num(lite.medianViews));
    stat('Channel age', lite.ageDays != null ? (lite.ageDays < 60 ? `${lite.ageDays} days` : lite.ageDays < 730 ? `${Math.round(lite.ageDays / 30.4)} months` : `${(lite.ageDays / 365).toFixed(1)} years`) : '—');
    stat('Uploads / month', lite.uploadsPerMonth ?? '—');
    stat('Last upload', lite.lastUpload ? CS.ago((Date.now() - lite.lastUpload) / 86400000) : '—');
    const vids = el('div', 'cs-hover-vids');
    const fill = (list, ageOf) => {
      vids.replaceChildren();
      for (const v of list.slice(0, 4)) {
        const va = el('a', 'cs-hover-vid');
        va.href = `/watch?v=${v.id}`;
        const th = el('div', 'cs-res-th');
        th.style.backgroundImage = `url("https://i.ytimg.com/vi/${v.id}/mqdefault.jpg")`;
        va.append(th, el('div', 'cs-res-t', v.title), el('div', 'cs-res-s', `${CS.num(v.views)} views · ${ageOf(v)}`));
        vids.append(va);
      }
      if (!list.length) vids.append(el('div', 'cs-res-s', 'No videos found.'));
    };
    const showLatest = () => fill(lite.latest || [], (v) => CS.ago((Date.now() - v.published) / 86400000));
    showLatest();
    // Latest | Popular tabs; Popular loads on first click (two small requests).
    const tabs = el('div', 'cs-hover-tabs');
    const tLatest = el('button', 'on', 'Latest uploads');
    const tPopular = el('button', null, 'Most popular');
    let popular = null;
    tLatest.addEventListener('click', () => {
      tLatest.classList.add('on');
      tPopular.classList.remove('on');
      showLatest();
    });
    tPopular.addEventListener('click', async () => {
      tPopular.classList.add('on');
      tLatest.classList.remove('on');
      if (!popular) {
        vids.replaceChildren(el('div', 'cs-res-s', 'Loading most popular…'));
        try {
          popular = await CS.send('channelPopular', { path });
        } catch {
          popular = [];
        }
      }
      if (tPopular.classList.contains('on')) fill(popular, (v) => v.ageText || '');
    });
    tabs.append(tLatest, tPopular);
    const actions = el('div', 'cs-hover-actions');
    const sim = el('button', 'cs-link', '🔍 Similar channels');
    sim.addEventListener('click', () => {
      card?.remove();
      CS.similarPanel(`https://www.youtube.com${path}`, lite.title);
    });
    const open = el('a', 'cs-link', 'Open channel ↗');
    open.href = path;
    actions.append(sim, open);
    card.append(head, stats, tabs, vids, actions);
    document.body.appendChild(card);
    const r = a.getBoundingClientRect();
    const w = 340;
    card.style.left = `${Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + innerWidth - w - 12))}px`;
    const below = r.bottom + 8 + card.offsetHeight < innerHeight;
    card.style.top = `${(below ? r.bottom + 8 : r.top - card.offsetHeight - 8) + window.scrollY}px`;
  }

  document.addEventListener('mouseover', (e) => {
    if (!CS.features.hover) return;
    const a = e.target.closest?.('a[href^="/@"], a[href^="/channel/"]');
    if (!a || a === anchor || a.closest('.cs-hover, .cs-panel, .cs-menu')) return;
    // Only names/avatars on video tiles and the video owner, not the whole UI.
    if (!a.closest(`${TILE}, ytd-video-owner-renderer, ytd-channel-name`)) return;
    const m = /^\/(@[^/?#]+|channel\/UC[\w-]{22})/.exec(new URL(a.getAttribute('href'), location.origin).pathname);
    if (!m) return;
    clearTimeout(hideTimer);
    clearTimeout(showTimer);
    anchor = a;
    showTimer = setTimeout(() => showCard(a, `/${decodeURIComponent(m[1])}`), 550);
    a.addEventListener('mouseleave', hideCard, { once: true });
  });
})();
