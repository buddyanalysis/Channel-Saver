/**
 * Video page tools, in one bar under the title: exact upload time, thumbnail
 * download, frame screenshot, save to Swipe file and Similar videos.
 */
(() => {
  const CS = window.CS;
  const { el } = CS;
  let bar = null;
  let barFor = null;
  let info = null;
  let panel = null;

  const videoId = () => new URL(location.href).searchParams.get('v');
  const fileName = (s) => String(s || 'video').replace(/[\\/:*?"<>|]+/g, '').slice(0, 80).trim() || 'video';

  /* ---------- files & clipboard ---------- */

  async function dataUrlToBlob(url) {
    return (await fetch(url)).blob();
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function thumbnail() {
    const id = videoId();
    const sizes = ['maxresdefault', 'sddefault', 'hqdefault'].map((s) => `https://i.ytimg.com/vi/${id}/${s}.jpg`);
    const r = await CS.send('fetchImage', { urls: sizes });
    return dataUrlToBlob(r.dataUrl);
  }

  function frame() {
    const v = document.querySelector('video.html5-main-video, #movie_player video');
    if (!v || !v.videoWidth) throw new Error('Play the video first, then take the screenshot.');
    const c = el('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return new Promise((r) => c.toBlob(r, 'image/png'));
  }

  async function act(btn, fn, done) {
    btn.disabled = true;
    try {
      await fn();
      if (done) CS.toast(done);
    } catch (e) {
      CS.toast(e.message || 'Something went wrong', true);
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------- side panel ---------- */

  function openPanel(title, ...content) {
    CS.closePanels();
    panel = el('aside', 'cs-panel');
    const head = el('div', 'cs-panel-head');
    const close = el('button', 'cs-x', '✕');
    close.addEventListener('click', () => {
      panel?.remove();
      panel = null;
    });
    head.append(el('b', null, title), close);
    panel.append(head, ...content);
    document.body.appendChild(panel);
    return panel;
  }

  /* ---------- similar videos ---------- */

  const STOP = new Set('the a an and or of to in on for with how why what is are was were this that you your from by at as it its be vs new full video official hindi urdu ka ki ke ko se mein hai aur kya kaise'.split(' '));

  // Words that carry a title's *shape* rather than its topic ("How a … Became the World's …").
  const FORMAT = new Set(`how why what when who which where the a an of to in on is was were are this that these those
    became become becomes changed change changes world world's worlds history first ever most every truth behind real
    story inside secret secrets you your didn't never know knew really actually i my we our tried did does do made make
    built build invented invent discovered discover forgotten untold hidden simple one man woman people day days years
    hours minutes 24 100 1000 $1 vs than greatest biggest deadliest worst best richest only`.split(/\s+/));

  /** A quoted phrase of the longest run of "shape" words in the title, e.g. "became the world's". */
  function formatQuery(title) {
    const words = String(title || '').toLowerCase().replace(/[’']/g, "'").match(/[\p{L}\p{N}$']+/gu) || [];
    let best = [];
    let run = [];
    for (const w of words) {
      if (FORMAT.has(w)) run.push(w);
      else {
        if (run.length > best.length) best = run;
        run = [];
      }
    }
    if (run.length > best.length) best = run;
    // Trim leading/trailing glue words so the phrase isn't just "the a of".
    while (best.length && /^(the|a|an|of|to|in|on|is)$/.test(best[0])) best.shift();
    while (best.length && /^(the|a|an|of|to|in|on|is)$/.test(best[best.length - 1])) best.pop();
    if (best.length >= 2) return `"${best.join(' ')}"`;
    return words.slice(0, 3).join(' ');
  }

  let stopSimLive = null;

  async function showSimilarVideos(_btn, mode = 'topic') {
    const body = el('div', 'cs-simv');
    const tabs = el('div', 'cs-hover-tabs cs-simv-tabs');
    const tTopic = el('button', mode === 'topic' ? 'on' : null, 'Same topic');
    const tFormat = el('button', mode === 'format' ? 'on' : null, 'Same title format');
    const tChannels = el('button', mode === 'channels' ? 'on' : null, 'Similar channels');
    tTopic.addEventListener('click', () => showSimilarVideos(null, 'topic'));
    tFormat.addEventListener('click', () => showSimilarVideos(null, 'format'));
    tChannels.addEventListener('click', () => showSimilarVideos(null, 'channels'));
    tabs.append(tTopic, tFormat, tChannels);
    stopSimLive?.();
    if (mode === 'channels') {
      // Channels like this video's channel: a quick read on the whole niche.
      body.classList.add('cs-results', 'cs-sim-list');
      openPanel('Similar', tabs, body);
      if (!info?.channelId) {
        body.replaceChildren(el('div', 'cs-panel-info', 'Loading video details… try again in a second.'));
        return;
      }
      stopSimLive = CS.similarChannelsInto(body, `https://www.youtube.com/channel/${info.channelId}`);
      return;
    }
    body.append(el('div', 'cs-panel-info', mode === 'topic' ? 'Searching YouTube for this topic…' : 'Searching YouTube for this title format…'));
    openPanel('Similar videos', tabs, body);
    const title = info?.title || document.querySelector('ytd-watch-metadata h1')?.textContent || '';
    const words = (title.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 2 && !STOP.has(w));
    const query = mode === 'format' ? formatQuery(title) : words.slice(0, 7).join(' ') || title;
    try {
      const list = (await CS.send('searchVideos', { query, exclude: info?.channelId })).filter((v) => v.id !== videoId());
      const lites = await Promise.all(list.map((v) => (v.channelId ? CS.lite(`/channel/${v.channelId}`) : null)));
      list.forEach((v, i) => {
        const l = lites[i];
        v.subs = l?.subs ?? null;
        v.outlier = l?.medianViews ? v.views / l.medianViews : null;
      });
      list.sort((a, b) => b.views - a.views);
      const rows = el('div', 'cs-results');
      for (const v of list) {
        const a = el('a', 'cs-res');
        a.href = `/watch?v=${v.id}`;
        const th = el('div', 'cs-res-th');
        th.style.backgroundImage = `url("https://i.ytimg.com/vi/${v.id}/mqdefault.jpg")`;
        if (v.outlier != null) th.append(el('span', `cs-res-x${v.outlier >= 3 ? ' hot' : ''}`, `${v.outlier >= 10 ? Math.round(v.outlier) : v.outlier.toFixed(1)}x`));
        const meta = el('div', 'cs-res-meta');
        meta.append(
          el('div', 'cs-res-t', v.title),
          el('div', 'cs-res-s', [v.channelName, v.subs != null ? `${CS.num(v.subs)} subs` : ''].filter(Boolean).join(' · ')),
          el('div', 'cs-res-s', [`${CS.num(v.views)} views`, v.ageText].filter(Boolean).join(' · ')),
        );
        a.append(th, meta);
        rows.append(a);
      }
      body.replaceChildren(el('div', 'cs-panel-info', `Searched ${mode === 'format' ? query : `“${query}”`} · ${list.length} videos from other channels, most viewed first. The badge is views ÷ that channel's typical views.`), rows);
    } catch (e) {
      body.replaceChildren(el('div', 'cs-panel-info', e.message));
    }
  }

  /* ---------- swipe file ---------- */

  async function showSwipe() {
    const v = document.querySelector('video.html5-main-video');
    const now = Math.floor(v?.currentTime || 0);
    const { niches = [] } = await chrome.storage.local.get('niches');
    const type = el('select');
    for (const [val, t] of [['video', 'Whole video'], ['part', 'Part of the video'], ['thumbnail', 'Thumbnail']]) {
      const o = el('option', null, t);
      o.value = val;
      type.append(o);
    }
    const start = el('input');
    start.value = CS.mmss(now);
    const end = el('input');
    end.value = CS.mmss(Math.min(now + 30, info?.lengthSeconds || now + 30));
    const partRow = el('div', 'cs-two');
    const l1 = el('label', 'cs-f');
    l1.append(el('span', null, 'From'), start);
    const l2 = el('label', 'cs-f');
    l2.append(el('span', null, 'To'), end);
    partRow.append(l1, l2);
    partRow.hidden = true;
    type.addEventListener('change', () => { partRow.hidden = type.value !== 'part'; });
    const note = el('textarea');
    note.rows = 3;
    note.placeholder = 'Why save it? (great hook, title idea, thumbnail style…)';
    const tags = el('input');
    tags.placeholder = 'Tags, comma separated';
    const niche = el('select');
    niche.append(Object.assign(el('option', null, 'No niche'), { value: '' }));
    for (const n of [...niches].sort((a, b) => a.title.localeCompare(b.title))) niche.append(Object.assign(el('option', null, n.title), { value: n.id }));
    const save = el('button', 'cs-btn-p', 'Save to Swipe file');
    save.addEventListener('click', () => act(save, async () => {
      const item = {
        type: type.value,
        videoId: videoId(),
        channelId: info?.channelId,
        title: info?.title || document.querySelector('ytd-watch-metadata h1')?.textContent?.trim(),
        channelName: info?.channelName,
        views: info?.views,
        published: info?.published,
        duration: info?.lengthSeconds,
        note: note.value,
        tags: tags.value.split(','),
        nicheIds: niche.value ? [niche.value] : [],
      };
      if (type.value === 'part') {
        item.start = CS.parseMmss(start.value);
        item.end = CS.parseMmss(end.value);
        if (item.start == null || item.end == null || item.end <= item.start) throw new Error('Set a valid From and To time (mm:ss).');
      }
      await CS.send('saveSwipe', { item });
      panel?.remove();
      panel = null;
    }, 'Saved to Swipe file'));
    const f = (label, input) => {
      const l = el('label', 'cs-f');
      l.append(el('span', null, label), input);
      return l;
    };
    const form = el('div', 'cs-form');
    form.append(f('Save', type), partRow, f('Note', note), f('Tags', tags), f('Niche', niche), save);
    openPanel('Save to Swipe file', form);
  }

  /* ---------- the bar ---------- */

  function button(label, title, fn) {
    const b = el('button', 'cs-vt-btn', label);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      fn(b);
    });
    return b;
  }

  async function build(id) {
    const host = document.querySelector('ytd-watch-metadata #title');
    if (!host) return;
    bar?.remove();
    bar = el('div', 'cs-vtools');
    barFor = id;
    const meta = el('div', 'cs-vt-info', 'Channel Saver · loading…');
    const tools = el('div', 'cs-vt-row');
    tools.append(
      button('⤓ Thumbnail', 'Download the thumbnail in the best size', (b) => act(b, async () => saveBlob(await thumbnail(), `${fileName(info?.title)}-thumbnail.jpg`), 'Thumbnail downloaded')),
      button('📷 Frame', 'Download a screenshot of the current frame', (b) => act(b, async () => saveBlob(await frame(), `${fileName(info?.title)}-${CS.mmss(document.querySelector('video')?.currentTime).replace(/:/g, '-')}.png`), 'Frame saved')),
      button('📌 Swipe file', 'Save this video, a part of it, or its thumbnail', showSwipe),
      button('🔍 Similar videos', 'Same topic or title format on other channels', showSimilarVideos),
    );
    bar.append(meta, tools);
    host.insertAdjacentElement('afterend', bar);
    try {
      info = await CS.send('videoInfo', { videoId: id });
      if (barFor !== id) return;
      const lite = info.channelId ? await CS.lite(`/channel/${info.channelId}`) : null;
      const parts = [info.published ? `Uploaded ${CS.when(info.published)}` : '', `${info.views.toLocaleString()} views`];
      if (lite?.medianViews) {
        const x = info.views / lite.medianViews;
        parts.push(`${x >= 10 ? Math.round(x) : x >= 1 ? x.toFixed(1) : x.toFixed(2)}x the channel's typical views (${CS.num(lite.medianViews)})`);
      }
      meta.textContent = parts.filter(Boolean).join(' · ');
    } catch {
      meta.textContent = '';
    }
  }

  CS.onTick(() => {
    const id = CS.page() === 'watch' ? videoId() : null;
    if (!CS.features.videoTools || !id) {
      bar?.remove();
      bar = null;
      barFor = null;
      return;
    }
    if (barFor !== id || !bar?.isConnected) build(id);
  });
})();
