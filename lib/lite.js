/**
 * Small per-channel facts for badges, hover cards and the Shorts box:
 * About page (subs, videos, join date) + RSS feed (recent uploads with exact
 * views). Cached for a day in memory and in storage.local.lite, and fetched
 * at most three at a time so a busy home page doesn't hammer YouTube.
 */
import { channelAbout, fetchFeed } from './yt.js';

const DAY = 86400000;
const TTL = DAY;
const MAX = 400;
const memory = new Map(); // key → lite
const inflight = new Map(); // key → promise

const median = (a) => {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * One key per channel path. Handles are case-insensitive but channel ids are
 * not ("UCuAX…" ≠ "ucuax…"), so only handles are lowercased.
 */
export const liteKey = (path) => {
  const p = String(path || '').replace(/^https?:\/\/[^/]+/, '').replace(/\/(videos|shorts|about|featured|streams|community|playlists).*$/, '').split('?')[0];
  return /^\/channel\//i.test(p) ? p.replace(/^\/channel\//i, '/channel/') : p.toLowerCase();
};

let active = 0;
const waiters = [];
async function slot(fn) {
  if (active >= 3) await new Promise((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

async function build(path) {
  const about = await channelAbout(path);
  let feed = [];
  try {
    if (about.channelId) feed = await fetchFeed(about.channelId, { exact: false });
  } catch {
    /* badges still work with About data alone */
  }
  const now = Date.now();
  const settled = feed.filter((v) => now - v.published > DAY);
  const span = feed.length > 1 ? (feed[0].published - feed[feed.length - 1].published) / DAY : 0;
  const in30 = feed.filter((v) => now - v.published <= 30 * DAY).length;
  // The feed holds 15 uploads; a busy channel fills it in under 30 days.
  const uploadsPerMonth = feed.length >= 15 && span > 0 && span < 30 ? (feed.length / span) * 30 : in30;
  const joined = Date.parse(about.joined) || null;
  return {
    ...about,
    ageDays: joined ? Math.round((now - joined) / DAY) : null,
    medianViews: Math.round(median((settled.length ? settled : feed).map((v) => v.views))),
    uploadsPerMonth: Math.round(uploadsPerMonth * 10) / 10,
    lastUpload: feed[0]?.published || null,
    latest: feed.slice(0, 6).map(({ id, title, published, views }) => ({ id, title, published, views })),
    at: now,
  };
}

async function fromStorage(key) {
  const { lite = {} } = await chrome.storage.local.get('lite');
  const hit = lite[key];
  return hit && Date.now() - hit.at < TTL ? hit : null;
}

let saveTimer = null;
const pending = {};
function persist(keys, value) {
  for (const k of keys) pending[k] = value;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const { lite = {} } = await chrome.storage.local.get('lite');
    Object.assign(lite, pending);
    for (const k of Object.keys(pending)) delete pending[k];
    const keep = Object.entries(lite).sort((a, b) => b[1].at - a[1].at).slice(0, MAX);
    await chrome.storage.local.set({ lite: Object.fromEntries(keep) });
  }, 1500);
}

export async function getLite(path) {
  const key = liteKey(path);
  if (!key) throw new Error('No channel');
  const mem = memory.get(key);
  if (mem && Date.now() - mem.at < TTL) return mem;
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    const stored = await fromStorage(key);
    if (stored) {
      memory.set(key, stored);
      return stored;
    }
    const lite = await slot(() => build(key));
    // Remember under every name this channel is reachable by.
    const keys = new Set([key, lite.channelId && `/channel/${lite.channelId}`, lite.handle && `/${lite.handle.toLowerCase()}`].filter(Boolean));
    for (const k of keys) memory.set(k, lite);
    persist(keys, lite);
    return lite;
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** Many at once; failures come back as null so one bad channel doesn't sink the batch. */
export async function getLiteMany(paths) {
  const unique = [...new Set(paths.map(liteKey).filter(Boolean))];
  const out = {};
  await Promise.all(unique.map(async (k) => {
    try {
      out[k] = await getLite(k);
    } catch {
      out[k] = null;
    }
  }));
  return out;
}
