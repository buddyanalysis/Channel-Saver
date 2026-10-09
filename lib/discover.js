/**
 * "Similar channels" without a database: candidates come from YouTube itself
 * (channels recommended next to the seed's best videos, and channels that rank
 * for the seed's own topics), then each candidate is fetched and scored by how
 * much its video titles overlap with the seed's.
 */
import { fetchChannel, relatedChannels, searchChannels } from './yt.js';
import { computeMetrics } from './metrics.js';

/* ---------- text ---------- */

// English + Roman Urdu/Hindi filler words, plus YouTube boilerplate.
const STOP = new Set(`a an the and or but of to in on at for from by with without into over under about after before as is are was were be been
being it its this that these those you your we our they their he she his her i my me how why what who when where which whom will can could
should would may might must do does did not no yes all any some more most very just than then so if up down out off new full part episode
ep video videos official channel shorts short live watch subscribe vs vlog explained story stories hindi urdu english
ka ki ke ko se me mein hai hain tha thi the aur ya kya kaise kyun kab kaun jo ye yeh wo woh is us un in ek do teen par per bhi nahi na hi
sab apna apni apne hum tum aap kar karo karna kiya diya liya gaya raha rahe rahi wala wali wale tak bas ab phir lekin magar agar toh to`
  .split(/\s+/));

export function tokens(s) {
  return (String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
}

const titlesOf = (ch) => [...(ch.videos || []).map((v) => v.title), ...(ch.shorts || []).slice(0, 15).map((v) => v.title)];

function termFreq(texts) {
  const tf = new Map();
  for (const t of texts) for (const w of new Set(tokens(t))) tf.set(w, (tf.get(w) || 0) + 1);
  return tf;
}

/** Cosine similarity of two tf maps weighted by idf. */
function cosine(a, b, idf) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [w, x] of a) {
    const wx = x * (idf.get(w) || 1);
    na += wx * wx;
    const y = b.get(w);
    if (y) dot += wx * y * (idf.get(w) || 1);
  }
  for (const [w, y] of b) {
    const wy = y * (idf.get(w) || 1);
    nb += wy * wy;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Rough writing system of a channel's titles: 'deva', 'arab' or 'latn'. */
function script(texts) {
  const s = texts.join(' ');
  const deva = (s.match(/[ऀ-ॿ]/g) || []).length;
  const arab = (s.match(/[؀-ۿ]/g) || []).length;
  const latn = (s.match(/[a-z]/gi) || []).length;
  if (deva > latn * 0.3) return 'deva';
  if (arab > latn * 0.3) return 'arab';
  return 'latn';
}

/** Search phrases that describe the seed: its strongest terms and best titles. */
function seedQueries(seed, max = 4) {
  const tf = termFreq(titlesOf(seed));
  const top = [...tf].sort((x, y) => y[1] - x[1]).map(([w]) => w);
  const queries = [];
  if (top.length >= 2) queries.push(top.slice(0, 3).join(' '));
  if (top.length >= 5) queries.push(top.slice(3, 6).join(' '));
  if (top.length >= 8) queries.push(top.slice(6, 9).join(' '));
  const best = [...(seed.videos || [])].sort((x, y) => y.views - x.views).slice(0, max > 4 ? 4 : 2);
  for (const v of best) {
    const words = tokens(v.title).slice(0, 6);
    if (words.length >= 2) queries.push(words.join(' '));
  }
  const kw = /"([^"]+)"/.exec(seed.keywords || '')?.[1];
  if (kw && kw.toLowerCase() !== (seed.title || '').toLowerCase()) queries.push(kw);
  return [...new Set(queries)].slice(0, max);
}

/* ---------- search ---------- */

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Finds channels similar to `seed` (a fetched or saved channel record).
 * onProgress(stage, done, total, partialResults) is called as it goes.
 * Returns results sorted by similarity, best first.
 */
/**
 * mode "quick": a couple of best videos and searches, ~10 channels in well under a minute.
 * mode "deep": best and newest videos, more searches, ~25 channels — catches newer competitors.
 */
export async function findSimilar(seed, { mode = 'quick', limit, onProgress = () => {} } = {}) {
  const deep = mode === 'deep';
  limit = limit || (deep ? 25 : 10);
  const hits = new Map(); // channelId → { name, related, search }
  const bump = (c, key) => {
    if (!c.channelId || c.channelId === seed.channelId) return;
    const h = hits.get(c.channelId) || { name: c.name, related: 0, search: 0 };
    h[key]++;
    hits.set(c.channelId, h);
  };

  const byViews = [...(seed.videos || [])].sort((a, b) => b.views - a.views);
  const newest = [...(seed.videos || [])].filter((v) => v.ageDays != null).sort((a, b) => a.ageDays - b.ageDays);
  // In-depth also follows the newest uploads, where fresh competitors show up first.
  const best = [...new Set([...byViews.slice(0, deep ? 5 : 3), ...(deep ? newest.slice(0, 3) : [])].map((v) => v.id))];
  const queries = seedQueries(seed, deep ? 7 : 2);
  const steps = best.length + queries.length;
  let step = 0;
  for (const id of best) {
    onProgress('Looking at recommended videos', ++step, steps, []);
    try {
      for (const c of await relatedChannels(id)) bump(c, 'related');
    } catch {
      /* skip */
    }
    await pause(400);
  }
  for (const q of queries) {
    onProgress(`Searching “${q}”`, ++step, steps, []);
    try {
      for (const c of await searchChannels(q)) bump(c, 'search');
    } catch {
      /* skip */
    }
    await pause(400);
  }

  // Recommended next to several of the seed's videos is the strongest signal.
  const ranked = [...hits].map(([id, h]) => ({ id, ...h, weight: h.related * 2 + h.search }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, Math.round(limit * (deep ? 1.6 : 1.4)));

  const seedTitles = titlesOf(seed);
  const seedTf = termFreq(seedTitles);
  const seedScript = script(seedTitles);
  const results = [];
  let done = 0;
  for (const cand of ranked) {
    onProgress('Checking channels', ++done, ranked.length, results);
    let ch;
    try {
      ch = await fetchChannel(`https://www.youtube.com/channel/${cand.id}`, { videoPages: 1 });
    } catch {
      continue;
    }
    const titles = titlesOf(ch);
    if (!titles.length) continue;
    const tf = termFreq(titles);
    // idf over just these two channels plus the seed vocabulary keeps rare shared words valuable.
    const idf = new Map();
    for (const w of new Set([...seedTf.keys(), ...tf.keys()])) idf.set(w, seedTf.has(w) && tf.has(w) ? 1.6 : 1);
    let sim = cosine(seedTf, tf, idf);
    const sameScript = script(titles) === seedScript;
    if (!sameScript) sim *= 0.6;
    // YouTube recommending it next to several of the seed's videos is strong
    // evidence even when the titles are worded differently.
    sim = sim * 1.3 + Math.min(0.32, cand.related * 0.08) + Math.min(0.1, cand.search * 0.04);
    // Brand-new tiny channels match on a handful of titles; damp the noise.
    if ((ch.subs || 0) < 1000) sim *= 0.8;
    sim = Math.min(0.99, sim);

    const m = computeMetrics(ch);
    results.push({
      channelId: ch.channelId,
      title: ch.title,
      handle: ch.handle,
      url: ch.url,
      avatar: ch.avatar,
      subs: ch.subs,
      videoCount: ch.videoCount,
      country: ch.country,
      joined: ch.joined,
      similarity: Math.round(sim * 100),
      sameLanguage: sameScript,
      medianViews: Math.round(m.medianViews),
      ageDays: m.ageDays != null ? Math.round(m.ageDays) : null,
      uploadsPerMonth: m.uploadsPerWeek != null ? +(m.uploadsPerWeek * 4.3).toFixed(1) : null,
      lastUpload: m.daysSinceUpload != null ? Math.round(m.daysSinceUpload * 10) / 10 : null,
      outliers: m.outliers.length,
      score: m.score,
      format: m.format,
      topVideo: m.top[0] ? { id: m.top[0].id, title: m.top[0].title, views: m.top[0].views } : null,
      seenIn: { related: cand.related, search: cand.search },
    });
    results.sort((a, b) => b.similarity - a.similarity);
    await pause(300);
  }
  return results.filter((r) => r.similarity >= 10).slice(0, limit);
}
