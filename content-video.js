/**
 * Video page tools, in one bar under the title: exact upload time, thumbnail
 * download/copy, frame screenshot, transcript, save to Swipe file and
 * Similar videos.
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

  // The clipboard only takes PNG images.
  async function toPng(blob) {
    if (blob.type === 'image/png') return blob;
    const bmp = await createImageBitmap(blob);
    const c = el('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    return new Promise((r) => c.toBlob(r, 'image/png'));
  }

  async function copyImage(blob) {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': await toPng(blob) })]);
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
    panel?.remove();
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

  /* ---------- transcript (YouTube's own panel, read from the page) ---------- */

  async function readTranscript() {
    const segSel = 'ytd-transcript-segment-renderer, transcript-segment-view-model';
    const read = () => [...document.querySelectorAll(segSel)].map((s) => ({
      t: (s.querySelector('.segment-timestamp, .ytwTranscriptSegmentViewModelTimestamp, [class*="timestamp"]')?.textContent || '').trim(),
      text: (s.querySelector('.segment-text, yt-formatted-string.segment-text, [class*="segment-text"], span[role="text"]')?.textContent || s.textContent || '').replace(/\s+/g, ' ').trim(),
    })).filter((x) => x.text);
    let segs = read();
    if (segs.length) return segs;
    // Open the description and press YouTube's own (visible) "Show transcript";
    // the page also keeps hidden copies of that button that do nothing.
    document.querySelector('ytd-watch-metadata #description-inline-expander #expand, tp-yt-paper-button#expand')?.click();
    await new Promise((r) => setTimeout(r, 500));
    const candidates = [...document.querySelectorAll('ytd-video-description-transcript-section-renderer button, button')]
      .filter((b) => /show transcript/i.test(`${b.textContent} ${b.getAttribute('aria-label') || ''}`));
    const btn = candidates.find((b) => b.offsetParent) || candidates[0];
    if (!btn) throw new Error('This video has no transcript.');
    btn.click();
    for (let i = 0; i < 40 && !segs.length; i++) {
      await new Promise((r) => setTimeout(r, 300));
      segs = read();
    }
    if (!segs.length) throw new Error('YouTube did not send a transcript for this video right now. Try again in a minute, or open YouTube’s own “Show transcript” under the description.');
    return segs;
  }

  async function showTranscript() {
    const body = el('div', 'cs-transcript', 'Loading transcript…');
    openPanel('Transcript', body);
    try {
      const segs = await readTranscript();
      const plain = segs.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
      const timed = segs.map((s) => `${s.t} ${s.text}`).join('\n');
      const words = plain.split(/\s+/).length;
      const copy1 = el('button', 'cs-btn-s', 'Copy text');
      copy1.addEventListener('click', () => navigator.clipboard.writeText(plain).then(() => CS.toast('Transcript copied')));
      const copy2 = el('button', 'cs-btn-s', 'Copy with timestamps');
      copy2.addEventListener('click', () => navigator.clipboard.writeText(timed).then(() => CS.toast('Transcript with timestamps copied')));
      const dl = el('button', 'cs-btn-s', 'Download .txt');
      dl.addEventListener('click', () => saveBlob(new Blob([timed], { type: 'text/plain' }), `${fileName(info?.title || document.title)}-transcript.txt`));
      const actions = el('div', 'cs-row-actions');
      actions.append(copy1, copy2, dl);
      const list = el('div', 'cs-tr-list');
      for (const s of segs) {
        const r = el('div', 'cs-tr-seg');
        r.append(el('span', 'cs-tr-t', s.t), el('span', null, s.text));
        list.append(r);
      }
      body.replaceChildren(el('div', 'cs-panel-info', `${segs.length} lines · ${words.toLocaleString()} words · about ${Math.max(1, Math.round(words / 150))} min read`), actions, list);
    } catch (e) {
      body.textContent = e.message;
    }
  }

  /* ---------- similar videos ---------- */

  const STOP = new Set('the a an and or of to in on for with how why what is are was were this that you your from by at as it its be vs new full video official hindi urdu ka ki ke ko se mein hai aur kya kaise'.split(' '));

  async function showSimilarVideos() {
    const body = el('div', 'cs-simv');
    body.append(el('div', 'cs-panel-info', 'Searching YouTube for this topic…'));
    openPanel('Similar videos', body);
    const title = info?.title || document.querySelector('ytd-watch-metadata h1')?.textContent || '';
    const words = (title.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 2 && !STOP.has(w));
    const query = words.slice(0, 7).join(' ') || title;
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
      body.replaceChildren(el('div', 'cs-panel-info', `Searched “${query}” · ${list.length} videos from other channels, most viewed first. The badge is views ÷ that channel's typical views.`), rows);
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
      button('⧉ Copy thumbnail', 'Copy the thumbnail image', (b) => act(b, async () => copyImage(await thumbnail()), 'Thumbnail copied')),
      button('📷 Frame', 'Download a screenshot of the current frame', (b) => act(b, async () => saveBlob(await frame(), `${fileName(info?.title)}-${CS.mmss(document.querySelector('video')?.currentTime).replace(/:/g, '-')}.png`), 'Frame saved')),
      button('⧉ Copy frame', 'Copy the current frame', (b) => act(b, async () => copyImage(await frame()), 'Frame copied')),
      button('📝 Transcript', 'Read, copy or download the transcript', showTranscript),
      button('📌 Swipe file', 'Save this video, a part of it, or its thumbnail', showSwipe),
      button('🔍 Similar videos', 'Same topic on other channels', showSimilarVideos),
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
