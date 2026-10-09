/**
 * Niche Finder: scans YouTube live (no database of our own) for each category —
 * the most viewed videos of the last day / week / month / 90 days — looks up the
 * channels behind them and works out:
 *   · viral videos on small channels (views ÷ subscribers, views per hour)
 *   · outlier channels (small channels whose videos beat their size by far)
 *   · niches with high future competition (young channels already breaking out)
 *   · categories ranked by how many small channels are winning there
 *   · trending keywords (phrases repeated across the viral titles)
 * No chrome.* here — the future website can run the same scan on its server.
 */
import { searchVideos, channelAbout } from './yt.js';

export const DEFAULT_CATEGORIES = [
  { name: 'True crime', q: 'true crime story' },
  { name: 'Drama', q: 'movie recap' },
  { name: 'Celeb news', q: 'celebrity news' },
  { name: 'History', q: 'history documentary' },
  { name: 'Tech reviews', q: 'tech review' },
  { name: 'Cooking', q: 'easy recipe' },
  { name: 'Gaming', q: 'gameplay' },
  { name: 'Finance', q: 'personal finance' },
  { name: 'Motivation', q: 'motivational story' },
  { name: 'AI tools', q: 'ai tools tutorial' },
  { name: 'Horror stories', q: 'horror stories animated' },
  { name: 'Science facts', q: 'science explained' },
];

// YouTube search filter codes: sorted by view count + upload date + videos only.
export const WINDOWS = {
  day: { label: 'Last 24 hours', sp: 'CAMSBAgCEAE%3D', days: 1 },
  week: { label: '7 days', sp: 'CAMSBAgDEAE%3D', days: 7 },
  month: { label: '30 days', sp: 'CAMSBAgEEAE%3D', days: 31 },
  quarter: { label: '90 days', sp: 'CAMSBAgFEAE%3D', days: 90 }, // "this year", trimmed to 90 days
};

const LANG_SUFFIX = { any: '', en: '', hi: ' in hindi', ur: ' urdu' };
const DAY = 86400000;
const SUBS_TTL = 3 * DAY;

const STOP = new Set(('a an and are as at be but by for from has have how i in is it its my of on or so that the this to was we what when where who why will with you your vs ft feat official video full new part ep episode shorts short live 2024 2025 2026 hd 4k').split(' '));

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/** Repeated 2–3 word phrases across titles, weighted by views. */
export function keywords(videos, limit = 15) {
  const score = new Map();
  const count = new Map();
  for (const v of videos) {
    const words = (String(v.title).toLowerCase().match(/[\p{L}\p{N}']+/gu) || []).filter((w) => w.length > 1);
    const seen = new Set();
    for (const n of [2, 3]) {
      for (let i = 0; i + n <= words.length; i++) {
        const gram = words.slice(i, i + n);
        if (STOP.has(gram[0]) || STOP.has(gram[n - 1]) || gram.every((w) => STOP.has(w))) continue;
        const k = gram.join(' ');
        if (seen.has(k)) continue;
        seen.add(k);
        count.set(k, (count.get(k) || 0) + 1);
        score.set(k, (score.get(k) || 0) + Math.log10(10 + (v.views || 0)));
      }
    }
  }
  const list = [...score].filter(([k]) => count.get(k) >= 2).sort((a, b) => b[1] - a[1]);
  // Drop a 2-word phrase when a 3-word one containing it ranks above.
  const picked = [];
  for (const [k] of list) {
    if (picked.some((p) => p.includes(k) || k.includes(p))) continue;
    picked.push(k);
    if (picked.length >= limit) break;
  }
  return picked.map((k) => ({ phrase: k, videos: count.get(k) }));
}

/**
 * Runs one scan. categories = [{ name, q }]; window = key of WINDOWS;
 * maxSubs = "small channel" limit; lang = any|en|hi|ur.
 * subsCache = { [channelId]: { at, ...channel } } (updated in place, pass it back next time).
 */
export async function scanNiches({ categories = DEFAULT_CATEGORIES, window = 'week', maxSubs = 50000, lang = 'any', subsCache = {}, onProgress = () => {} } = {}) {
  const win = WINDOWS[window] || WINDOWS.week;
  const now = Date.now();
  let done = 0;
  const total = categories.length + 1;
  const tick = (stage) => onProgress({ stage, done, total });

  // 1. Most viewed videos per category in the time window.
  tick('Searching YouTube');
  const perCat = await pool(categories, 3, async (cat) => {
    let list = [];
    try {
      list = await searchVideos(`${cat.q}${LANG_SUFFIX[lang] || ''}`, { sp: win.sp });
    } catch {
      /* one category failing doesn't stop the scan */
    }
    done++;
    tick(`Searched ${cat.name}`);
    return list
      .filter((v) => v.channelId && v.views > 0 && (v.ageDays == null || v.ageDays <= win.days + 1))
      .slice(0, 20)
      .map((v) => ({ ...v, category: cat.name }));
  });

  // 2. Subscriber counts for the channels behind the top videos (cached for 3 days).
  const ids = [...new Set(perCat.flatMap((l) => l.slice(0, 12).map((v) => v.channelId)))];
  const need = ids.filter((id) => !(subsCache[id] && now - subsCache[id].at < SUBS_TTL));
  onProgress({ stage: 'Checking channels', done, total: total + need.length });
  let checked = 0;
  await pool(need, 4, async (id) => {
    try {
      const a = await channelAbout(`/channel/${id}`);
      subsCache[id] = { at: now, channelId: id, title: a.title, handle: a.handle, avatar: a.avatar, subs: a.subs, videoCount: a.videoCount, joined: a.joined };
    } catch {
      /* skip */
    }
    checked++;
    onProgress({ stage: 'Checking channels', done: done + checked, total: total + need.length });
  });

  // 3. Work out the lists.
  const videos = perCat.flat().map((v) => {
    const ch = subsCache[v.channelId];
    const subs = ch?.subs || 0;
    const hours = Math.max(1, (v.ageDays ?? win.days) * 24);
    return { ...v, subs, ratio: subs ? v.views / subs : null, vph: Math.round(v.views / hours) };
  });
  const isSmall = (v) => v.subs > 0 && v.subs < maxSubs;

  const viral = videos.filter((v) => isSmall(v) && v.ratio >= 1).sort((a, b) => b.ratio - a.ratio).slice(0, 40);

  const byChannel = new Map();
  for (const v of videos) {
    const ch = subsCache[v.channelId];
    if (!ch?.subs) continue;
    const e = byChannel.get(v.channelId) || { ...ch, videos: [], categories: new Set() };
    e.videos.push(v);
    e.categories.add(v.category);
    byChannel.set(v.channelId, e);
  }
  const channels = [...byChannel.values()].map((c) => {
    const started = Date.parse(c.joined);
    const avgViews = Math.round(c.videos.reduce((a, v) => a + v.views, 0) / c.videos.length);
    return {
      channelId: c.channelId,
      title: c.title,
      handle: c.handle,
      avatar: c.avatar,
      subs: c.subs,
      videoCount: c.videoCount,
      daysSinceStart: Number.isFinite(started) ? Math.max(0, Math.round((now - started) / DAY)) : null,
      avgViews,
      outlier: Math.max(...c.videos.map((v) => v.ratio || 0)),
      bestVideo: c.videos.sort((a, b) => b.views - a.views)[0],
      categories: [...c.categories],
    };
  });

  const outlierChannels = channels.filter((c) => c.subs < maxSubs && c.outlier >= 3).sort((a, b) => b.outlier - a.outlier).slice(0, 24);
  const rising = channels.filter((c) => c.daysSinceStart != null && c.daysSinceStart <= 730 && c.outlier >= 2).sort((a, b) => b.outlier - a.outlier).slice(0, 24);

  const cats = categories.map((cat) => {
    const vs = videos.filter((v) => v.category === cat.name);
    const chs = channels.filter((c) => c.categories.includes(cat.name));
    const small = chs.filter((c) => c.subs < maxSubs && c.outlier >= 3);
    return { name: cat.name, q: cat.q, channels: chs.length, videos: vs.length, outliers: small.length, topRatio: small.length ? Math.max(...small.map((c) => c.outlier)) : 0, views: vs.reduce((a, v) => a + v.views, 0) };
  }).sort((a, b) => b.outliers - a.outliers || b.topRatio - a.topRatio);

  return {
    at: now,
    window,
    maxSubs,
    lang,
    counts: { videos: videos.length, channels: channels.length },
    viral,
    outlierChannels,
    rising,
    categories: cats,
    keywords: keywords(videos),
  };
}
