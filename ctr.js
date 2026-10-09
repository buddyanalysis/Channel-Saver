/**
 * CTR Tester. Before publishing, compare up to three thumbnail + title
 * variants against the videos you actually compete with:
 *   Preview    — YouTube-like Home / Mobile / Search / Sidebar / Large layouts,
 *                light/dark, squint (blur) and grayscale tests, time badge.
 *   Score      — image analysis on a canvas: contrast, colour, clutter,
 *                small-size readability, how much it stands out from the
 *                competitors, and whether the time badge covers anything.
 *   Click test — rounds of "which would you watch?" with your variant hidden
 *                among competitors at a random spot; gives a pick rate per
 *                variant (a stand-in for CTR) and time-to-notice.
 * Nothing is uploaded: images stay in this browser (storage.local.ctrTest).
 * Real CTR only exists after publishing — YouTube Studio's "Test & compare"
 * measures it on live viewers, and the page links to it.
 */

let ctx; // { h, set, send, toast, fmtNum, fmtDuration, getDb, $ }
const LETTERS = ['A', 'B', 'C'];

const st = {
  variants: [], // { image, title }
  channel: 'Your channel',
  duration: 600,
  source: 'competitors',
  query: '',
  videos: [], // competitor tiles: { id, title, channelName, views, ageText, duration, avatar }
  tab: 'preview',
  layout: 'home',
  dark: false,
  squint: false,
  gray: false,
  show: 0, // which variant the preview shows
  seed: Math.random(),
  scores: null,
  analysing: false,
  test: null, // running click test
  results: null,
};

let loaded = false;
async function restore() {
  if (loaded) return;
  loaded = true;
  try {
    const { ctrTest } = await chrome.storage.local.get('ctrTest');
    if (ctrTest) Object.assign(st, { variants: ctrTest.variants || [], channel: ctrTest.channel || st.channel, duration: ctrTest.duration ?? st.duration, results: ctrTest.results || null });
  } catch {}
}
function persist() {
  chrome.storage.local.set({ ctrTest: { variants: st.variants, channel: st.channel, duration: st.duration, results: st.results } }).catch(() => {});
}

/* ---------- image analysis ---------- */

const W = 160;
const H = 90;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image could not be read'));
    img.src = src;
  });
}

function pixels(img, w = W, hgt = H, blur = 0) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = hgt;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (blur) g.filter = `blur(${blur}px)`;
  g.drawImage(img, 0, 0, w, hgt);
  return g.getImageData(0, 0, w, hgt).data;
}

const lumOf = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

/** Numbers that describe how a thumbnail reads in a feed. */
function analyse(img) {
  const d = pixels(img);
  const n = W * H;
  const lum = new Float32Array(n);
  let sum = 0;
  let rgSum = 0;
  let ybSum = 0;
  let rg2 = 0;
  let yb2 = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  const hue = new Float32Array(12);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const L = lumOf(d, i);
    lum[p] = L;
    sum += L;
    r += d[i];
    g += d[i + 1];
    b += d[i + 2];
    const rg = d[i] - d[i + 1];
    const yb = 0.5 * (d[i] + d[i + 1]) - d[i + 2];
    rgSum += rg;
    ybSum += yb;
    rg2 += rg * rg;
    yb2 += yb * yb;
    // Hue histogram weighted by saturation, for "does it look like the others?"
    const mx = Math.max(d[i], d[i + 1], d[i + 2]);
    const mn = Math.min(d[i], d[i + 1], d[i + 2]);
    const sat = mx ? (mx - mn) / mx : 0;
    if (sat > 0.15 && mx > 40) {
      let hh;
      if (mx === d[i]) hh = ((d[i + 1] - d[i + 2]) / (mx - mn)) % 6;
      else if (mx === d[i + 1]) hh = (d[i + 2] - d[i]) / (mx - mn) + 2;
      else hh = (d[i] - d[i + 1]) / (mx - mn) + 4;
      hue[Math.floor(((hh * 60 + 360) % 360) / 30)] += sat;
    }
  }
  const mean = sum / n;
  let varL = 0;
  for (let p = 0; p < n; p++) varL += (lum[p] - mean) ** 2;
  const contrast = Math.sqrt(varL / n); // 0–128
  const sdRg = Math.sqrt(rg2 / n - (rgSum / n) ** 2);
  const sdYb = Math.sqrt(yb2 / n - (ybSum / n) ** 2);
  const colorfulness = Math.sqrt(sdRg ** 2 + sdYb ** 2) + 0.3 * Math.sqrt((rgSum / n) ** 2 + (ybSum / n) ** 2); // Hasler–Süsstrunk

  // Sobel edges: overall detail and how busy the time-badge corner is.
  let edges = 0;
  let cornerEdges = 0;
  let cornerPx = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const at = (xx, yy) => lum[yy * W + xx];
      const gx = -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) + at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
      const gy = -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
      const strong = Math.hypot(gx, gy) > 110 ? 1 : 0;
      edges += strong;
      if (x > W * 0.78 && y > H * 0.76) {
        cornerEdges += strong;
        cornerPx++;
      }
    }
  }
  const clutter = edges / ((W - 2) * (H - 2));
  const corner = cornerPx ? cornerEdges / cornerPx : 0;

  // Readability at sidebar size: shrink, soften, measure what contrast survives.
  const small = pixels(img, 56, 32, 1);
  let sSum = 0;
  const sl = [];
  for (let i = 0; i < small.length; i += 4) {
    const L = lumOf(small, i);
    sl.push(L);
    sSum += L;
  }
  const sMean = sSum / sl.length;
  const smallContrast = Math.sqrt(sl.reduce((a, L) => a + (L - sMean) ** 2, 0) / sl.length);

  const hTotal = hue.reduce((a, x) => a + x, 0) || 1;
  return {
    brightness: mean / 255,
    contrast,
    colorfulness,
    clutter,
    corner,
    smallContrast,
    color: [r / n, g / n, b / n],
    hue: [...hue].map((x) => x / hTotal),
  };
}

const clamp = (x, a = 0, b = 100) => Math.max(a, Math.min(b, x));

/** Scores (0–100) and tips for one variant, given the competitors' numbers. */
function score(v, comps) {
  const tips = [];
  const out = {};
  out.contrast = clamp((v.contrast / 75) * 100);
  if (v.contrast < 45) tips.push('Low contrast — make the subject and text pop (darker background or brighter subject).');

  out.color = clamp((v.colorfulness / 80) * 100);
  if (v.colorfulness < 35) tips.push('Quite dull — one bold, saturated colour helps it catch the eye.');

  // Some detail is good; too much reads as noise at small sizes.
  out.clutter = clamp(v.clutter < 0.06 ? 60 + v.clutter * 600 : v.clutter <= 0.2 ? 100 : 100 - (v.clutter - 0.2) * 350);
  if (v.clutter > 0.26) tips.push('Busy image — fewer elements, bigger subject, 3–4 words of text at most.');
  if (v.clutter < 0.04) tips.push('Very plain — add a clear subject or a few large words.');

  out.small = clamp((v.smallContrast / 60) * 100);
  if (v.smallContrast < 38) tips.push('Gets muddy when small (mobile / sidebar) — larger shapes and stronger contrast.');

  out.brightness = clamp(v.brightness < 0.22 ? v.brightness * 400 : v.brightness > 0.82 ? (1 - v.brightness) * 500 : 100);
  if (v.brightness < 0.22) tips.push('Very dark — it may disappear in dark mode.');
  if (v.brightness > 0.82) tips.push('Very bright — it may wash out in light mode.');

  // Stands out = far from what the competitors look like (colour + hue mix + brightness).
  if (comps.length) {
    const avgColor = [0, 1, 2].map((k) => comps.reduce((a, c) => a + c.color[k], 0) / comps.length);
    const avgHue = v.hue.map((_, k) => comps.reduce((a, c) => a + c.hue[k], 0) / comps.length);
    const avgBright = comps.reduce((a, c) => a + c.brightness, 0) / comps.length;
    const colorDist = Math.hypot(...v.color.map((x, k) => x - avgColor[k])) / 255;
    const hueDist = v.hue.reduce((a, x, k) => a + Math.abs(x - avgHue[k]), 0) / 2;
    const brightDist = Math.abs(v.brightness - avgBright);
    out.stand = clamp(colorDist * 180 + hueDist * 70 + brightDist * 90);
    if (out.stand < 40) tips.push('Looks a lot like the competitors — try a different main colour or background brightness.');
  } else {
    out.stand = null;
  }

  out.corner = clamp(100 - Math.max(0, v.corner - 0.12) * 400);
  if (v.corner > 0.22) tips.push('Detail in the bottom-right corner — YouTube’s time badge covers it. Move text/faces away from there.');

  const weights = { contrast: 18, color: 12, clutter: 14, small: 20, brightness: 6, stand: 22, corner: 8 };
  let total = 0;
  let wsum = 0;
  for (const [k, w] of Object.entries(weights)) {
    if (out[k] == null) continue;
    total += out[k] * w;
    wsum += w;
  }
  out.total = Math.round(total / wsum);
  out.tips = tips;
  return out;
}

async function runScores() {
  if (!st.variants.length) return;
  st.analysing = true;
  paint();
  try {
    const compImgs = [];
    for (const v of st.videos.slice(0, 12)) {
      try {
        const r = await ctx.send('fetchImage', { urls: [`https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`] });
        compImgs.push(await loadImage(r.dataUrl));
      } catch {
        /* skip one */
      }
    }
    const comps = compImgs.map(analyse);
    st.comps = comps;
    st.boost = {};
    const mine = [];
    for (const v of st.variants) mine.push(analyse(await loadImage(v.image)));
    st.scores = mine.map((m) => ({ raw: m, ...score(m, comps) }));
    st.compAvg = comps.length ? Math.round(comps.map((c) => score(c, comps).total).reduce((a, x) => a + x, 0) / comps.length) : null;
  } catch (e) {
    ctx.toast(e.message, true);
  } finally {
    st.analysing = false;
    paint();
  }
}

/* ---------- loading competitors ---------- */

async function loadVideos(btn) {
  if (btn) btn.disabled = true;
  try {
    const db = ctx.getDb();
    if (st.source === 'search') {
      if (!st.query.trim()) throw new Error('Type a search term first');
      st.videos = (await ctx.send('searchVideos', { query: st.query })).map((v) => ({ ...v, avatar: v.channelAvatar }));
    } else {
      const chans = Object.values(db.channels).filter((c) => {
        if (st.source === 'competitors') return c.competitor;
        if (st.source.startsWith('niche:')) return (c.nicheIds || []).includes(st.source.slice(6));
        return c.channelId === st.source;
      });
      if (!chans.length) throw new Error(st.source === 'competitors' ? 'Add some competitors first (or compare against a YouTube search).' : 'No channels there yet');
      st.videos = chans.flatMap((c) => (c.videos || []).slice(0, 12).map((v) => ({ ...v, channelName: c.title, avatar: c.avatar, ageText: ctx.fmtAge(v.ageDays) })))
        .sort(() => Math.random() - 0.5);
    }
    st.seed = Math.random();
    st.scores = null;
    paint();
    if (st.variants.length) runScores();
  } catch (e) {
    ctx.toast(e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ---------- tiles ---------- */

function tile(v, mine, idx) {
  const { h, fmtNum, fmtDuration } = ctx;
  const img = mine ? st.variants[idx]?.image : `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`;
  return h('div.ctr-tile' + (mine ? '.mine' : ''), { 'data-mine': mine ? LETTERS[idx] : null, 'data-id': mine ? null : v.id },
    h('div.ctr-thumb', { style: { backgroundImage: `url("${img}")` } },
      (mine ? st.duration : v.duration) ? h('span.ctr-dur', fmtDuration(mine ? st.duration : v.duration)) : null),
    h('div.ctr-meta',
      st.layout === 'search' || st.layout === 'sidebar' ? null : h('div.ctr-av', { style: !mine && v.avatar ? { backgroundImage: `url("${v.avatar}")` } : null }),
      h('div.ctr-text',
        h('div.ctr-title', mine ? st.variants[idx]?.title || 'Your title here' : v.title),
        h('div.ctr-sub', mine ? st.channel : v.channelName),
        h('div.ctr-sub', mine ? 'just now' : [v.views != null ? `${fmtNum(v.views)} views` : '', v.ageText || ''].filter(Boolean).join(' • ')))));
}

function grid(variantIdx, seed, count) {
  const { h } = ctx;
  const n = Math.min(st.videos.length, count);
  const tiles = st.videos.slice(0, n).map((v) => tile(v, false));
  const pos = Math.floor(seed * (n + 1));
  if (st.variants[variantIdx]) tiles.splice(pos, 0, tile(null, true, variantIdx));
  return h(`div.ctr-grid.l-${st.layout}${st.dark ? '.dark' : ''}${st.squint ? '.squint' : ''}${st.gray ? '.gray' : ''}`, tiles);
}

/* ---------- click test ---------- */

function startTest(rounds) {
  if (!st.variants.length) return ctx.toast('Upload at least one thumbnail', true);
  if (st.videos.length < 6) return ctx.toast('Load competitor videos first (at least 6)', true);
  st.test = { round: 0, rounds, picks: st.variants.map(() => ({ shown: 0, picked: 0, ms: [] })), other: 0, startedAt: 0 };
  nextRound();
}

function nextRound() {
  const t = st.test;
  if (t.round >= t.rounds) {
    st.results = { at: Date.now(), rounds: t.rounds, variants: t.picks.map((p, i) => ({ letter: LETTERS[i], ...p, rate: p.shown ? p.picked / p.shown : 0, avgMs: p.ms.length ? Math.round(p.ms.reduce((a, x) => a + x, 0) / p.ms.length) : null })) };
    st.test = null;
    persist();
    closeOverlay();
    st.tab = 'test';
    paint();
    return;
  }
  // Rotate variants so each is shown equally often; shuffle competitors each round.
  t.variant = t.round % st.variants.length;
  t.picks[t.variant].shown++;
  st.videos.sort(() => Math.random() - 0.5);
  t.round++;
  t.startedAt = performance.now();
  showOverlay();
}

let overlay = null;
function closeOverlay() {
  overlay?.remove();
  overlay = null;
}

function showOverlay() {
  const { h } = ctx;
  const t = st.test;
  closeOverlay();
  const keep = st.layout;
  st.layout = 'home';
  const g = grid(t.variant, Math.random(), 11);
  st.layout = keep;
  g.addEventListener('click', (e) => {
    const tl = e.target.closest('.ctr-tile');
    if (!tl) return;
    const ms = performance.now() - t.startedAt;
    if (tl.dataset.mine) {
      t.picks[t.variant].picked++;
      t.picks[t.variant].ms.push(ms);
    } else t.other++;
    nextRound();
  });
  overlay = h('div.ctr-overlay',
    h('div.ctr-ov-head',
      h('b', `Round ${t.round} of ${t.rounds}`),
      h('span', 'Click the video you would watch first. Be honest — go with your first instinct.'),
      h('button.btn', { onclick: () => nextRound() }, 'None of these ⏭'),
      h('button.btn', { onclick: () => { st.test = null; closeOverlay(); paint(); } }, '✕ Stop')),
    g);
  document.body.append(overlay);
}

/* ---------- page ---------- */

function variantSlot(i) {
  const { h } = ctx;
  const v = st.variants[i];
  const file = h('input', { type: 'file', accept: 'image/*', hidden: true });
  file.addEventListener('change', () => {
    const f = file.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      // Store a 1280×720 JPEG: same look, a fraction of the size.
      loadImage(r.result).then((img) => {
        const c = document.createElement('canvas');
        c.width = 1280;
        c.height = 720;
        c.getContext('2d').drawImage(img, 0, 0, 1280, 720);
        st.variants[i] = { image: c.toDataURL('image/jpeg', 0.9), title: st.variants[i]?.title || '' };
        st.scores = null;
        persist();
        paint();
        if (st.videos.length) runScores();
      });
    };
    r.readAsDataURL(f);
  });
  const title = h('input.input', { placeholder: `Title ${LETTERS[i]}` });
  title.value = v?.title || '';
  title.addEventListener('change', () => {
    if (!st.variants[i]) return;
    st.variants[i].title = title.value;
    persist();
    paint();
  });
  return h('div.ctr-slot' + (v ? '.has' : ''),
    h('div.ctr-slot-head', h('b', `Variant ${LETTERS[i]}`),
      v ? h('button.icon-btn', { title: 'Remove', onclick: () => { st.variants.splice(i, 1); st.scores = null; persist(); paint(); } }, '✕') : null),
    h('div.ctr-slot-img', { style: v ? { backgroundImage: `url("${v.image}")` } : null, onclick: () => file.click() }, v ? null : h('span', '＋ Upload thumbnail')),
    v ? title : h('div.vm', 'JPG/PNG, 16:9'),
    file);
}

function bar(label, value, hint) {
  const { h } = ctx;
  if (value == null) return h('div.ctr-bar', h('span', label), h('div.ctr-bar-track', h('i', { style: { width: '0%' } })), h('b', '—'));
  const cls = value >= 70 ? 'good' : value >= 45 ? 'ok' : 'bad';
  return h('div.ctr-bar', { title: hint }, h('span', label), h('div.ctr-bar-track', h(`i.${cls}`, { style: { width: `${Math.round(value)}%` } })), h('b', Math.round(value)));
}

function scorePane() {
  const { h } = ctx;
  if (!st.variants.length) return h('div.empty', h('p', 'Upload a thumbnail to score it.'));
  if (st.analysing) return h('div.empty', h('p', 'Analysing your thumbnails against the competitors…'));
  if (!st.scores) return h('div.empty', h('p', st.videos.length ? 'Press “Score” to analyse.' : 'Load competitor videos first so “stands out” can be measured.'), h('button.btn.primary', { onclick: runScores }, 'Score now'));
  const best = st.scores.reduce((bi, s, i, a) => (s.total > a[bi].total ? i : bi), 0);
  return h('div.ctr-scores',
    st.scores.map((s, i) => h('div.ctr-score-card' + (i === best && st.scores.length > 1 ? '.best' : ''),
      h('div.ctr-score-top',
        h('div.ctr-score-img', { style: { backgroundImage: `url("${st.variants[i].image}")` } }),
        h('div', h('div.vm', `Variant ${LETTERS[i]}${i === best && st.scores.length > 1 ? ' · best' : ''}`), h('div.ctr-total', s.total), h('div.vm', st.compAvg != null ? `competitors average ${st.compAvg}` : ''))),
      bar('Stands out from competitors', s.stand, 'Distance from the competitors’ colours, hues and brightness'),
      bar('Readable when small', s.small, 'Contrast left after shrinking to sidebar size'),
      bar('Contrast', s.contrast),
      bar('Colour', s.color),
      bar('Clean (not cluttered)', s.clutter),
      bar('Brightness', s.brightness),
      bar('Time badge corner clear', s.corner),
      s.tips.length ? h('ul.ctr-tips', s.tips.map((t) => h('li', t))) : h('div.ctr-ok', '✓ No obvious problems.'))),
    h('p.vm.ctr-note', 'The score predicts how well a thumbnail stands out and reads in a feed. It is not your real CTR — that depends on your audience. After publishing, use YouTube Studio → your video → Thumbnail → “Test & compare” to test up to 3 thumbnails on real viewers.'),
    h('a.btn', { href: 'https://support.google.com/youtube/answer/13861714', target: '_blank', rel: 'noopener' }, 'How YouTube “Test & compare” works ↗'));
}

/* ---------- Improve CTR: a fix list for one specific thumbnail ---------- */

const WEIGHTS = { contrast: 18, color: 12, clutter: 14, small: 20, brightness: 6, stand: 22, corner: 8 };
const HUES = ['red', 'orange', 'yellow', 'lime green', 'green', 'teal', 'cyan', 'sky blue', 'blue', 'purple', 'magenta', 'pink'];
const HUE_CSS = ['#e53935', '#fb8c00', '#fdd835', '#9ccc65', '#43a047', '#00897b', '#00bcd4', '#29b6f6', '#1e63e9', '#8e24aa', '#d81b60', '#f06292'];

/** Colours the competitors use most and least — the least-used one is the gap to take. */
function compColours() {
  const comps = st.comps || [];
  if (!comps.length) return null;
  const hue = HUES.map((_, k) => comps.reduce((a, c) => a + c.hue[k], 0) / comps.length);
  const order = hue.map((x, k) => [x, k]).sort((a, b) => b[0] - a[0]);
  const bright = comps.reduce((a, c) => a + c.brightness, 0) / comps.length;
  // Pick the free colour farthest from their main colour on the wheel.
  const main = order[0][1];
  const free = order.slice(-6).map(([, k]) => k).sort((a, b) => Math.abs(((b - main + 18) % 12) - 6) - Math.abs(((a - main + 18) % 12) - 6))[0];
  return { main, second: order[1][1], free, bright };
}

/** What to change in this thumbnail, biggest score gain first. */
function fixList(i) {
  const s = st.scores[i];
  const raw = s.raw;
  const cc = compColours();
  const wsum = Object.entries(WEIGHTS).reduce((a, [k, w]) => a + (s[k] == null ? 0 : w), 0);
  const gain = (k) => (s[k] == null || s[k] >= 80 ? 0 : Math.round(((80 - s[k]) * WEIGHTS[k]) / wsum));
  const items = [];
  const add = (k, title, why, steps) => { const g = gain(k); if (g > 0) items.push({ k, g, title, why, steps }); };

  add('stand', 'Make it look different from the other videos',
    cc ? `Most competitor thumbnails are ${HUES[cc.main]} and ${HUES[cc.second]}, and ${cc.bright < 0.4 ? 'dark' : cc.bright > 0.6 ? 'bright' : 'mid-bright'}. Yours blends in with them.` : 'It blends in with the videos around it.',
    [cc ? `Use ${HUES[cc.free]} as your main colour (background, text or an outline) — almost nobody in this feed uses it.` : 'Change the main background colour.',
      cc ? (cc.bright < 0.45 ? 'The feed is mostly dark: a brighter background will jump out.' : 'The feed is mostly bright: a darker, moody background will jump out.') : 'Try the opposite brightness to the videos around you.',
      'Keep one style for your channel so returning viewers spot you, but not the same look as everyone else.']);
  add('small', 'Make it readable on a phone',
    'Most views come from mobile and the sidebar, where your thumbnail is about the size of a stamp. Right now the details melt together when it is small.',
    ['Make the main subject (face / object) fill at least a third of the image.',
      'Use 3–4 words maximum, very big, in a thick bold font with a dark outline or shadow.',
      'Check the “📱 Mobile” and “➡ Sidebar” previews — if you can’t read it in one second, enlarge it.']);
  add('contrast', 'Add more contrast',
    'The light and dark parts are too close, so nothing pops.',
    [raw.brightness > 0.5 ? 'Darken the background (or add a dark vignette) so the subject stands out.' : 'Brighten the subject and face; add a rim light or glow around it.',
      'Put light text on dark areas or dark text on light areas — never mid-grey on mid-grey.',
      'Try “⚫ Grayscale” in Preview: if it turns into a grey blob, contrast is too low.']);
  add('color', 'Use bolder colour',
    'The image looks dull next to colourful thumbnails.',
    ['Raise saturation on the subject (not everything) by 20–30%.',
      cc ? `Add one strong accent in ${HUES[cc.free]} — an arrow, circle, text or background.` : 'Add one strong accent colour — an arrow, circle, text or background.',
      'Avoid many different colours; one or two strong ones read better.']);
  if (raw.clutter > 0.2) {
    add('clutter', 'Remove clutter',
      'There is too much going on. At small sizes the viewer can’t tell what the video is about.',
      ['Keep ONE focal point: a face, an object or a short text.', 'Blur or darken the background.', 'Delete small text, logos and extra objects.']);
  } else {
    add('clutter', 'Add one clear subject',
      'The image is very plain — there is nothing to look at.',
      ['Add a close-up face with a clear emotion, or the key object of the video, big and centred-left.', 'Add 2–4 big words that create curiosity (don’t repeat the title).']);
  }
  add('brightness', raw.brightness < 0.3 ? 'Brighten it' : 'Tone down the brightness',
    raw.brightness < 0.3 ? 'It is very dark and will vanish in YouTube dark mode.' : 'It is very bright and washes out in light mode.',
    [raw.brightness < 0.3 ? 'Lift exposure/shadows so the subject is clearly lit.' : 'Lower highlights or add a darker background area.', 'Check both “🌙 Dark” and light previews.']);
  add('corner', 'Clear the bottom-right corner',
    'YouTube puts the video length badge there and covers whatever is underneath.',
    ['Move text, faces and important objects away from the bottom-right corner.']);
  items.sort((a, b) => b.g - a.g);
  return items;
}

/** Title checks for this variant (CTR = thumbnail + title together). */
function titleTips(t) {
  const out = [];
  if (!t) return ['Add the title you plan to use — viewers judge thumbnail and title together.'];
  if (t.length > 60) out.push(`Title is ${t.length} characters — mobile cuts it near 60. Put the hook in the first 40.`);
  if (t.length < 25) out.push('Title is very short — add what makes it worth clicking (a result, a number, a question).');
  if (!/\d/.test(t)) out.push('Numbers make titles concrete (“7 mistakes…”, “in 24 hours”, “$1 vs $1000”). Consider one.');
  const caps = t.split(/\s+/).filter((w) => w.length > 3 && w === w.toUpperCase() && /[A-Z]/.test(w)).length;
  if (caps > 2) out.push('Too many ALL-CAPS words look like spam — keep at most one for emphasis.');
  if (!/[?!]|how|why|what|secret|truth|never|nobody|finally|actually/i.test(t)) out.push('Add curiosity: a question, a surprise or a “why/how” angle that the thumbnail doesn’t fully answer.');
  if (!out.length) out.push('✓ Title length and style look good. Make sure the thumbnail text adds to the title instead of repeating it.');
  return out;
}

/** An automatically tuned copy (contrast, colour, brightness), scored against the same competitors. */
async function autoBoost(i) {
  const s = st.scores[i];
  const raw = s.raw;
  const img = await loadImage(st.variants[i].image);
  const c = document.createElement('canvas');
  c.width = 1280;
  c.height = 720;
  const g = c.getContext('2d');
  const con = s.contrast < 70 ? 1.25 : 1.08;
  const sat = s.color < 70 ? 1.35 : 1.1;
  const bri = raw.brightness < 0.3 ? 1.25 : raw.brightness > 0.75 ? 0.88 : 1.03;
  g.filter = `contrast(${con}) saturate(${sat}) brightness(${bri})`;
  g.drawImage(img, 0, 0, 1280, 720);
  const image = c.toDataURL('image/jpeg', 0.9);
  const sc = score(analyse(await loadImage(image)), st.comps || []);
  st.boost[i] = { image, total: sc.total };
  paint();
}

function improvePane() {
  const { h } = ctx;
  if (!st.variants.length) return h('div.empty', h('p', 'Upload a thumbnail first.'));
  if (st.analysing) return h('div.empty', h('p', 'Analysing your thumbnails…'));
  if (!st.scores) return h('div.empty', h('p', st.videos.length ? 'Press “Analyse” to get a fix list for each thumbnail.' : 'Load competitor videos first (above) — the advice depends on what you compete with.'), st.videos.length ? h('button.btn.primary', { onclick: runScores }, 'Analyse') : null);
  st.boost = st.boost || {};
  const r = st.results;
  return h('div.ctr-improve',
    st.scores.map((s, i) => {
      const fixes = fixList(i);
      const b = st.boost[i];
      const pick = r?.variants?.[i];
      return h('div.ctr-imp-card',
        h('div.ctr-imp-head',
          h('div.ctr-score-img', { style: { backgroundImage: `url("${st.variants[i].image}")` } }),
          h('div',
            h('b', `How to raise the CTR of Variant ${LETTERS[i]}`),
            h('div.vm', `Score now ${s.total}${fixes.length ? ` → up to ${Math.min(100, s.total + fixes.reduce((a, f) => a + f.g, 0))} if you fix the list below` : ''}`),
            pick && pick.shown ? h('div.vm', `Click test: picked ${Math.round(pick.rate * 100)}% of the time${pick.rate < 0.34 ? ' — viewers preferred other videos, start with fix #1' : ''}`) : null)),
        fixes.length ? h('ol.ctr-fixes', fixes.map((f) => h('li',
          h('div.ctr-fix-top', h('b', f.title), h('span.ctr-gain', `+${f.g} pts`)),
          h('div.vm', f.why),
          h('ul', f.steps.map((t) => h('li', t)))))) : h('div.ctr-ok', '✓ This thumbnail already does well on every measure. Test it against a second idea with the Click test.'),
        f0Colour(),
        h('div.ctr-sub', '✍ Title'),
        h('ul.ctr-tips', titleTips(st.variants[i].title).map((t) => h('li', t))),
        h('div.ctr-sub', '⚡ Auto-boost'),
        b ? h('div.ctr-boost',
          h('div.ctr-score-img.big', { style: { backgroundImage: `url("${b.image}")` } }),
          h('div',
            h('div', `Tuned copy scores ${b.total} (was ${s.total})`),
            h('div.vm', 'Contrast, colour and brightness adjusted automatically. Use it as a starting point in your editor.'),
            h('div.ctr-row',
              st.variants.length < 3 ? h('button.btn.small.primary', { onclick: () => { st.variants.push({ image: b.image, title: st.variants[i].title }); st.scores = null; persist(); runScores(); } }, `Add as Variant ${LETTERS[st.variants.length]}`) : null,
              h('a.btn.small', { href: b.image, download: `thumbnail-${LETTERS[i]}-boosted.jpg` }, '⤓ Download'))))
          : h('button.btn.small', { onclick: (e) => { e.currentTarget.disabled = true; autoBoost(i); } }, 'Make a tuned copy'));
    }),
    h('div.ctr-imp-card',
      h('b', 'Always worth checking'),
      h('ul.ctr-tips',
        ['A face with a strong, clear emotion (surprise, fear, joy) usually beats no face.',
          'One idea per thumbnail: the viewer should get it in under 1 second.',
          'Text on the thumbnail should add curiosity, not repeat the title.',
          'Show the result or the “before → after”, not the boring middle.',
          'After publishing, run YouTube Studio “Test & compare” with your best 2–3 versions — that is your real CTR.'].map((t) => h('li', t)))));

  function f0Colour() {
    const cc = compColours();
    if (!cc) return null;
    return h('div.ctr-colours',
      h('span.vm', 'Feed colours:'),
      h('i', { style: { background: HUE_CSS[cc.main] }, title: `Most used: ${HUES[cc.main]}` }),
      h('i', { style: { background: HUE_CSS[cc.second] }, title: `Second: ${HUES[cc.second]}` }),
      h('span.vm', '→ stand out with'),
      h('i.free', { style: { background: HUE_CSS[cc.free] }, title: HUES[cc.free] }),
      h('b', HUES[cc.free]));
  }
}

function testPane() {
  const { h } = ctx;
  const r = st.results;
  const rounds = h('select.input', [6, 12, 18, 24].map((n) => h('option', { value: n }, `${n} rounds`)));
  rounds.value = '12';
  return h('div.ctr-test',
    h('p.sim-intro', 'A quick stand-in for CTR: each round shows a feed with one of your variants hidden among competitor videos. Click what you would watch. Even better — let a friend or someone from your audience do it, since you already know your thumbnail.'),
    h('div.ctr-row', rounds, h('button.btn.primary', { onclick: () => startTest(Number(rounds.value)) }, '▶ Start click test')),
    r ? h('div.ctr-results',
      h('h3', `Last result · ${r.rounds} rounds`),
      h('table',
        h('thead', h('tr', h('th', 'Variant'), h('th.num', 'Shown'), h('th.num', 'Picked'), h('th.num', 'Pick rate'), h('th.num', 'Time to pick'))),
        h('tbody', r.variants.map((v) => h('tr',
          h('td', v.letter),
          h('td.num', String(v.shown)),
          h('td.num', String(v.picked)),
          h('td.num', `${Math.round(v.rate * 100)}%`),
          h('td.num', v.avgMs != null ? `${(v.avgMs / 1000).toFixed(1)}s` : '—'))))),
      h('p.vm', 'Higher pick rate = clicked more often. Faster time = noticed sooner. With few rounds the numbers are rough; more rounds and more people make them trustworthy.')) : null);
}

function previewPane() {
  const { h } = ctx;
  const seg = (key, opts) => h('div.seg', opts.map(([val, label]) => h('button' + (st[key] === val ? '.on' : ''), { onclick: () => { st[key] = val; paint(); } }, label)));
  const tog = (key, label) => h('button.btn.small' + (st[key] ? '.primary' : ''), { onclick: () => { st[key] = !st[key]; paint(); } }, label);
  const count = { home: 12, mobile: 6, search: 6, sidebar: 10, large: 6 }[st.layout];
  return h('div',
    h('div.ctr-row',
      seg('layout', [['home', '🏠 Home'], ['mobile', '📱 Mobile'], ['search', '🔎 Search'], ['sidebar', '➡ Sidebar'], ['large', '📺 Large']]),
      tog('dark', '🌙 Dark'), tog('squint', '👓 Squint test'), tog('gray', '⚫ Grayscale'),
      st.variants.length > 1 ? seg('show', st.variants.map((_, i) => [i, `Show ${LETTERS[i]}`])) : null,
      h('button.btn.small', { onclick: () => { st.seed = Math.random(); paint(); } }, '⟳ Move it')),
    h('p.vm.ctr-hint', st.squint ? 'Squint test: everything is blurred like a quick glance. The thumbnail you can still recognise wins.' : st.gray ? 'Grayscale: shows pure light/dark contrast. If your thumbnail turns into a grey blob, add contrast.' : 'Your thumbnail is placed at a random spot (marked only in Score). Can you find it in a second?'),
    st.videos.length ? grid(Math.min(st.show, st.variants.length - 1), st.seed, count) : h('div.empty', h('p', 'Load videos to compare against (above).')));
}

export function initCtr(c) {
  ctx = c;
}

export async function renderCtr(force) {
  const list = ctx.$('list');
  if (!force && list.querySelector('.ctr')) return;
  await restore();
  paint();
}

function paint() {
  const { h, set, $ } = ctx;
  const list = $('list');
  if (!list || (!list.querySelector('.ctr') && document.getElementById('viewTitle')?.textContent !== 'CTR Tester')) return;
  const db = ctx.getDb();
  const source = h('select.input',
    h('option', { value: 'competitors' }, 'Against my competitors'),
    h('option', { value: 'search' }, 'Against a YouTube search'),
    db.niches.map((n) => h('option', { value: `niche:${n.id}` }, `Against niche: ${n.title}`)),
    Object.values(db.channels).sort((a, b) => a.title.localeCompare(b.title)).map((ch) => h('option', { value: ch.channelId }, `Against ${ch.title}`)));
  source.value = st.source;
  const query = h('input.input', { placeholder: 'Search term, e.g. "history of inventions"' });
  query.value = st.query;
  query.hidden = st.source !== 'search';
  source.addEventListener('change', () => { st.source = source.value; query.hidden = st.source !== 'search'; });
  query.addEventListener('input', () => { st.query = query.value; });
  const load = h('button.btn.primary', { onclick: (e) => loadVideos(e.currentTarget) }, st.videos.length ? `⟳ Reload (${st.videos.length})` : 'Load videos');
  query.addEventListener('keydown', (e) => e.key === 'Enter' && load.click());
  const chan = h('input.input', { placeholder: 'Your channel name' });
  chan.value = st.channel;
  chan.addEventListener('change', () => { st.channel = chan.value; persist(); paint(); });
  const dur = h('input.input', { placeholder: 'Length, e.g. 12:34' });
  dur.value = ctx.fmtDuration(st.duration) || '';
  dur.addEventListener('change', () => {
    const p = dur.value.split(':').map(Number);
    st.duration = p.some(Number.isNaN) ? 0 : p.reduce((a, x) => a * 60 + x, 0);
    persist();
    paint();
  });
  const live = h('button.btn', { onclick: async () => {
    const v = st.variants[st.show] || st.variants[0];
    if (!v) return ctx.toast('Upload a thumbnail first', true);
    await chrome.storage.local.set({ thumbTest: { active: true, image: v.image, title: v.title, channel: st.channel, position: 'random', seed: Math.random() } });
    chrome.tabs.create({ url: 'https://www.youtube.com/' });
  } }, '▶ Test inside YouTube');

  const tabs = h('div.seg.ctr-tabs', [['preview', '👁 Preview'], ['score', '📊 Score'], ['improve', '🚀 Improve CTR'], ['test', '🖱 Click test']].map(([k, label]) =>
    h('button' + (st.tab === k ? '.on' : ''), { onclick: () => { st.tab = k; paint(); if ((k === 'score' || k === 'improve') && !st.scores && st.variants.length && st.videos.length) runScores(); } }, label)));

  set(list, h('section.ctr',
    h('p.sim-intro', 'Test up to 3 thumbnails and titles before you publish: see them among your real competitors, score how much they stand out, and run a click test. Everything stays in this browser.'),
    h('div.ctr-slots', [0, 1, 2].map((i) => (i <= st.variants.length ? variantSlot(i) : null))),
    h('div.ctr-row.ctr-setup',
      h('label.field', 'Channel name', chan),
      h('label.field', 'Video length', dur),
      h('label.field', 'Compare against', source, query),
      h('div.ctr-buttons', load, live)),
    tabs,
    st.tab === 'preview' ? previewPane() : st.tab === 'score' ? scorePane() : st.tab === 'improve' ? improvePane() : testPane()));
}
