import { fetchChannel, fetchFeed, parseInput, videoInfo, searchVideos, popularVideos } from './lib/yt.js';
import { getLiteMany } from './lib/lite.js';
import { applyFeed, noteOutlier, fmtWhen } from './lib/track.js';
import { computeMetrics } from './lib/metrics.js';
import { findSimilar } from './lib/discover.js';
import { load, mutate, uid } from './lib/store.js';
import { UPDATE_URL, isNewer } from './lib/config.js';
import { askJson, thumbnailReview, titleIdeas, nicheAnalysis, replyDraft } from './lib/ai.js';
import { callLicense, normalizeKey, isExpired } from './lib/license.js';
import { scanNiches, DEFAULT_CATEGORIES } from './lib/finder.js';

/* ---------- Niche Finder ---------- */

// One scan at a time; progress and results live in storage.local.finder for the dashboard.
let finderRun = null;
async function runFinder({ window = 'week', maxSubs = 50000, lang = 'any', categories: names = null }) {
  if (finderRun) return { started: false, running: true };
  const { settings = {}, finderSubs = {}, finder: prev = {} } = await chrome.storage.local.get(['settings', 'finderSubs', 'finder']);
  const all = [...DEFAULT_CATEGORIES, ...(settings.finderCategories || [])];
  // names = scan only these categories (a click on one category); default all.
  const categories = names?.length ? all.filter((c) => names.includes(c.name)) : all;
  const setState = (patch) => chrome.storage.local.set({ finder: { ...prev, ...patch } });
  await setState({ status: 'running', stage: 'Starting', done: 0, total: categories.length + 1, error: '', options: { window, maxSubs, lang } });
  finderRun = (async () => {
    try {
      const result = await scanNiches({
        categories, window, maxSubs, lang, subsCache: finderSubs,
        onProgress: (p) => setState({ status: 'running', stage: p.stage, done: p.done, total: p.total, options: { window, maxSubs, lang } }),
      });
      // Keep the channel cache small: drop entries older than a week.
      for (const [id, c] of Object.entries(finderSubs)) if (Date.now() - c.at > 7 * 86400000) delete finderSubs[id];
      // One result per time window, so switching a section's period is instant once scanned.
      await chrome.storage.local.set({ finderSubs, finder: { status: 'done', results: { ...(prev.results || {}), [window]: result }, options: { window, maxSubs, lang }, error: '' } });
    } catch (e) {
      await setState({ status: 'error', error: e.message });
    } finally {
      finderRun = null;
    }
  })();
  return { started: true };
}


/* ---------- activation key (checked by letrestart.com) ---------- */

// What works before activation: the activation screen itself, updates and backups.
const OPEN_REQUESTS = new Set(['activate', 'deactivate', 'licenseStatus', 'checkUpdate', 'restart', 'openDashboard', 'backupNow', 'fpResult']);
const LOCKED = 'Channel Saver is not activated. Open the Channel Saver dashboard and enter your activation key.';
const LIC_HOUR = 3600000; // (HOUR is declared further down)
const CHECK_EVERY = 6 * LIC_HOUR;

/** This computer's id: made once, kept for good (sent with every key request). */
async function deviceId() {
  const { deviceId: id } = await chrome.storage.local.get(['deviceId']);
  if (id) return id;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ deviceId: fresh });
  return fresh;
}

/**
 * The computer fingerprint (lib/fingerprint.js), kept in storage. Pages hand it over when they
 * have it; otherwise a hidden offscreen page computes it (the service worker has no WebGL).
 */
let fpWaiters = [];
async function computerFp() {
  const { fp, deviceInfo } = await chrome.storage.local.get(['fp', 'deviceInfo']);
  if (fp && deviceInfo) return fp;
  try {
    const got = new Promise((resolve) => {
      fpWaiters.push(resolve);
      setTimeout(() => resolve({ fp: '' }), 8000);
    });
    if (!(await chrome.offscreen.hasDocument?.())) {
      await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['DOM_SCRAPING'], justification: 'Compute the computer fingerprint (WebGL renderer, screen) used for licence activation.' });
    }
    const { fp: value, info } = await got;
    chrome.offscreen.closeDocument().catch(() => {});
    if (value) await chrome.storage.local.set({ fp: value, deviceInfo: info || null });
    return value || fp || '';
  } catch {
    return '';
  }
}

/** { fp, info, version } for a licence request. */
async function deviceExtra() {
  const fp = await computerFp();
  const { deviceInfo } = await chrome.storage.local.get(['deviceInfo']);
  return { fp, info: deviceInfo || null, version: chrome.runtime.getManifest().version };
}

const publicInfo = (l) => ({ ok: !!l?.ok, name: l?.name || '', activatedAt: l?.activatedAt || 0, expiresAt: l?.expiresAt || 0, lifetime: !!l?.lifetime, checkedAt: l?.checkedAt || 0, error: l?.error || '', key: l?.key ? `${l.key.slice(0, 7)}…${l.key.slice(-4)}` : '' });

/**
 * The current verdict. Uses the saved answer, re-asks letrestart.com every
 * few hours (or when force), and locks on ok:false or when the key runs out.
 */
let checking = null;
async function license({ force = false } = {}) {
  const { license: lic } = await chrome.storage.local.get(['license']);
  if (!lic?.key) return { ok: false, error: 'Not activated yet.' };
  if (lic.ok && isExpired(lic)) {
    const next = { ...lic, ok: false, error: 'This activation key has expired. Ask your admin for a new key.' };
    await chrome.storage.local.set({ license: next });
    return next;
  }
  const due = force || !lic.checkedAt || Date.now() - lic.checkedAt > CHECK_EVERY;
  if (!due || (!lic.ok && !force)) return lic;
  checking ||= (async () => {
    try {
      const res = await callLicense('check', lic.key, await deviceId(), await deviceExtra());
      const next = res.ok
        ? { key: lic.key, ...res, ok: true, error: '', checkedAt: Date.now(), lastGood: Date.now() }
        : { ...lic, ok: false, error: res.error, checkedAt: Date.now() };
      await chrome.storage.local.set({ license: next });
      return next;
    } catch (e) {
      // Offline or server trouble is never a verdict on the key: an activated key stays
      // active until the user removes it or the website answers ok:false. Ask again in an hour.
      const next = { ...lic, checkedAt: Date.now() - CHECK_EVERY + LIC_HOUR };
      await chrome.storage.local.set({ license: next });
      return next;
    } finally {
      checking = null;
    }
  })();
  return checking;
}


/* ---------- optional AI (user's own key in storage.local.ai) ---------- */

const AI_TASKS = { thumbnail: thumbnailReview, titles: titleIdeas, niche: nicheAnalysis, reply: replyDraft };

async function runAi({ task, input }) {
  const fn = AI_TASKS[task];
  if (!fn) throw new Error(`Unknown AI task: ${task}`);
  const { ai } = await chrome.storage.local.get(['ai']);
  return fn(ai, input || {});
}

/**
 * The only writer of the library. The dashboard and the YouTube button send
 * messages here; they read state straight from chrome.storage and re-render
 * on storage.onChanged.
 */

const DAY = 86400000;
const HOUR = 3600000;

/**
 * YouTube answers 403 to its own API when the request carries an extension
 * Origin. Our fetches (and only ours: initiatorDomains) get YouTube's origin
 * instead. Session rules vanish on browser restart, so this runs at every
 * worker start; it's idempotent.
 */
chrome.declarativeNetRequest?.updateSessionRules({
  removeRuleIds: [1],
  addRules: [{
    id: 1,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'origin', operation: 'set', value: 'https://www.youtube.com' }],
    },
    condition: {
      urlFilter: '||www.youtube.com/youtubei/',
      initiatorDomains: [chrome.runtime.id],
      resourceTypes: ['xmlhttprequest', 'other'],
    },
  }],
}).catch(() => {});
const NICHE_COLORS = ['#8b5cf6', '#06b6d4', '#f59e0b', '#ef4444', '#10b981', '#ec4899', '#3b82f6', '#84cc16'];

/* ---------- record building ---------- */

// Keep only what the UI uses: storage stays small even with hundreds of channels.
function compact(data) {
  return {
    channelId: data.channelId,
    title: data.title,
    handle: data.handle,
    url: data.url,
    avatar: data.avatar,
    banner: data.banner,
    description: (data.description || '').slice(0, 1000),
    keywords: (data.keywords || '').slice(0, 500),
    subs: data.subs,
    videoCount: data.videoCount,
    totalViews: data.totalViews,
    joined: data.joined,
    country: data.country,
    verified: data.verified,
    familySafe: data.familySafe,
    links: (data.links || []).slice(0, 8),
    videos: (data.videos || []).slice(0, 60).map(({ id, title, views, ageDays, duration, live }) => ({
      id, title, views, ageDays, duration, live,
    })),
    shorts: (data.shorts || []).slice(0, 48).map(({ id, title, views }) => ({ id, title, views })),
    fetchedAt: data.fetchedAt,
  };
}

function addSnapshot(rec) {
  const snap = { t: Date.now(), subs: rec.subs || 0, views: rec.totalViews || 0, videos: rec.videoCount || 0 };
  const list = rec.snapshots || [];
  const last = list[list.length - 1];
  // One point per calendar day: later refreshes the same day update that day's point.
  if (last && new Date(last.t).toDateString() === new Date(snap.t).toDateString()) list[list.length - 1] = snap;
  else list.push(snap);
  rec.snapshots = list.slice(-400);
}

/** Saved channel that a URL / @handle / id points at, if any. */
function findSaved(channels, input) {
  const p = parseInput(input);
  if (!p?.path) return null;
  const [, kind, value] = /^\/(@|channel\/|c\/|user\/)?(.+)$/.exec(p.path) || [];
  const v = decodeURIComponent(value || '').toLowerCase();
  return (
    Object.values(channels).find((c) =>
      kind === 'channel/' ? c.channelId.toLowerCase() === v : (c.handle || '').toLowerCase() === `@${v}`,
    ) || null
  );
}

/* ---------- actions ---------- */

async function addChannel({ input, nicheId, notes }) {
  const st = await load();
  const known = findSaved(st.channels, input);
  if (known && nicheId && known.nicheIds.includes(nicheId)) {
    return { channel: known, already: true };
  }
  // Already saved and fresh: just file it, no network.
  if (known && Date.now() - (known.fetchedAt || 0) < DAY) {
    return mutate((s) => {
      const c = s.channels[known.channelId];
      if (nicheId && !c.nicheIds.includes(nicheId)) c.nicheIds.push(nicheId);
      if (notes) c.notes = c.notes ? `${c.notes}\n${notes}` : notes;
      return { channel: c };
    });
  }

  const data = compact(await fetchChannel(input));
  if (!data.channelId) throw new Error('YouTube did not return a channel id');

  return mutate((s) => {
    const prev = s.channels[data.channelId];
    if (prev && nicheId && prev.nicheIds.includes(nicheId)) return { channel: prev, already: true };
    const rec = {
      nicheIds: [],
      notes: '',
      tags: [],
      addedAt: Date.now(),
      snapshots: [],
      ...prev,
      ...data,
      status: 'ok',
      error: '',
    };
    if (nicheId && !rec.nicheIds.includes(nicheId)) rec.nicheIds.push(nicheId);
    if (notes) rec.notes = rec.notes ? `${rec.notes}\n${notes}` : notes;
    addSnapshot(rec);
    s.channels[data.channelId] = rec;
    return { channel: rec };
  });
}

async function refreshChannel({ channelId }) {
  const st = await load();
  const c = st.channels[channelId];
  if (!c) throw new Error('Channel not saved');
  try {
    const data = compact(await fetchChannel(`https://www.youtube.com/channel/${channelId}`));
    return mutate((s) => {
      const rec = s.channels[channelId];
      if (!rec) return null;
      Object.assign(rec, data, { status: 'ok', error: '' });
      addSnapshot(rec);
      if (rec.competitor && rec.track) {
        const m = computeMetrics(rec);
        for (const v of m.outliers) if (v.age != null && v.age <= 30) noteOutlier(rec, v, v.x);
      }
      return { channel: rec };
    });
  } catch (e) {
    return mutate((s) => {
      const rec = s.channels[channelId];
      if (!rec) return null;
      rec.fetchedAt = Date.now();
      if (e.gone || e.notFound) {
        rec.status = 'gone';
        rec.error = e.message || 'This channel is no longer on YouTube';
      } else {
        rec.error = e.message || 'Refresh failed';
      }
      return { channel: rec, error: rec.error };
    });
  }
}

const HANDLERS = {
  lookup: async ({ url }) => {
    const st = await load();
    return { channel: findSaved(st.channels, url), niches: st.niches };
  },
  add: addChannel,
  refresh: refreshChannel,

  setNiche: ({ channelId, nicheId, on }) =>
    mutate((s) => {
      const c = s.channels[channelId];
      if (!c) throw new Error('Channel not saved');
      c.nicheIds = c.nicheIds.filter((id) => id !== nicheId);
      if (on) c.nicheIds.push(nicheId);
      return { channel: c };
    }),

  updateChannel: async ({ channelId, patch }) => {
    const res = await mutate((s) => {
      const c = s.channels[channelId];
      if (!c) throw new Error('Channel not saved');
      for (const k of ['notes', 'tags', 'starred', 'competitor']) if (k in patch) c[k] = patch[k];
      if ('competitor' in patch) c.competitorSince = patch.competitor ? Date.now() : null;
      return { channel: c };
    });
    // Upload history can take a few seconds when the RSS feed is down; don't hold the reply.
    if (patch.competitor) pollCompetitor(channelId).catch(() => {});
    return res;
  },

  pollCompetitors: () => pollCompetitors({ force: true }),
  backupNow: () => autoBackup({ force: true }),
  findSimilar: runSimilar,
  nicheScan: runFinder,
  forgetSimilar: async ({ seedId }) => {
    const { similar = {} } = await chrome.storage.local.get('similar');
    delete similar[seedId];
    await chrome.storage.local.set({ similar });
    return { ok: true };
  },

  deleteChannel: ({ channelId }) =>
    mutate((s) => {
      delete s.channels[channelId];
      return { ok: true };
    }),

  createNiche: ({ title }) =>
    mutate((s) => {
      const name = String(title || '').trim().slice(0, 80);
      if (!name) throw new Error('Give the niche a name');
      const dup = s.niches.find((n) => n.title.toLowerCase() === name.toLowerCase());
      if (dup) return { niche: dup };
      const niche = {
        id: uid(),
        title: name,
        color: NICHE_COLORS[s.niches.length % NICHE_COLORS.length],
        notes: '',
        rpmLow: null,
        rpmHigh: null,
        pinned: false,
        createdAt: Date.now(),
      };
      s.niches.push(niche);
      return { niche };
    }),

  updateNiche: ({ id, patch }) =>
    mutate((s) => {
      const n = s.niches.find((x) => x.id === id);
      if (!n) throw new Error('Niche not found');
      for (const k of ['title', 'color', 'notes', 'rpmLow', 'rpmHigh', 'pinned']) if (k in patch) n[k] = patch[k];
      return { niche: n };
    }),

  deleteNiche: ({ id }) =>
    mutate((s) => {
      s.niches = s.niches.filter((n) => n.id !== id);
      for (const c of Object.values(s.channels)) c.nicheIds = c.nicheIds.filter((x) => x !== id);
      for (const it of s.swipe) it.nicheIds = (it.nicheIds || []).filter((x) => x !== id);
      return { ok: true };
    }),

  importData: ({ data }) =>
    mutate((s) => {
      if (!data || !Array.isArray(data.niches) || typeof data.channels !== 'object') {
        throw new Error('This is not a Channel Saver backup file');
      }
      let niches = 0;
      let channels = 0;
      for (const n of data.niches) {
        if (n?.id && n.title && !s.niches.some((x) => x.id === n.id)) {
          s.niches.push(n);
          niches++;
        }
      }
      let swipe = 0;
      for (const it of Array.isArray(data.swipe) ? data.swipe : []) {
        if (it?.id && !s.swipe.some((x) => x.id === it.id)) {
          s.swipe.push(it);
          swipe++;
        }
      }
      s.swipe.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
      for (const [id, c] of Object.entries(data.channels)) {
        if (!c?.channelId) continue;
        const prev = s.channels[id];
        if (prev) prev.nicheIds = [...new Set([...prev.nicheIds, ...(c.nicheIds || [])])];
        else {
          s.channels[id] = c;
          channels++;
        }
      }
      return { niches, channels, swipe };
    }),

  saveSettings: ({ patch }) =>
    mutate((s) => {
      if (patch.features) patch = { ...patch, features: { ...s.settings.features, ...patch.features } };
      Object.assign(s.settings, patch);
      return { settings: s.settings };
    }),

  checkUpdate: () => checkUpdate(),

  activate: async ({ key, fp: pageFp, info: pageInfo }) => {
    const k = normalizeKey(key);
    if (!k) throw new Error('That doesn’t look like an activation key. It looks like LR-XXXX-XXXX-XXXX-XXXX.');
    const device = await deviceId();
    if (pageFp) await chrome.storage.local.set({ fp: pageFp, ...(pageInfo ? { deviceInfo: pageInfo } : {}) });
    const extra = await deviceExtra();
    let res = await callLicense('activate', k, device, extra);
    // Re-entering a key already activated on this same computer: confirm it with a check.
    if (!res.ok && /already/i.test(res.error) && !/another device/i.test(res.error)) res = await callLicense('check', k, device, extra);
    if (!res.ok) throw new Error(res.error);
    const lic = { key: k, ...res, ok: true, error: '', checkedAt: Date.now(), lastGood: Date.now() };
    await chrome.storage.local.set({ license: lic });
    return publicInfo(lic);
  },
  deactivate: async () => {
    await chrome.storage.local.remove('license');
    return { ok: false };
  },
  // The dashboard asks on open: re-check with the website if the last check is over an hour old.
  // The offscreen page reports the fingerprint here.
  fpResult: async ({ fp, info }) => {
    const waiters = fpWaiters;
    fpWaiters = [];
    waiters.forEach((w) => w({ fp: fp || '', info: info || null }));
    return { ok: true };
  },
  licenseStatus: async () => {
    const { license: lic } = await chrome.storage.local.get(['license']);
    return publicInfo(await license({ force: !!lic?.key && Date.now() - (lic.checkedAt || 0) > LIC_HOUR }));
  },

  ai: runAi,
  aiTest: ({ cfg }) => askJson(cfg, { system: 'You answer with JSON.', prompt: 'Return {"ok": true}', maxTokens: 50 }),

  /* ---- on-page tools ---- */
  channelLite: ({ paths }) => getLiteMany(paths || []),
  channelPopular: async ({ path }) => {
    const hit = popularCache.get(path);
    if (hit && Date.now() - hit.at < DAY) return hit.list;
    const list = await popularVideos(path);
    popularCache.set(path, { at: Date.now(), list });
    return list;
  },
  videoInfo: ({ videoId }) => videoInfo(videoId),
  searchVideos: async ({ query, exclude }) => {
    const list = await searchVideos(query);
    return exclude ? list.filter((v) => v.channelId !== exclude) : list;
  },
  // Thumbnails as data URLs, so pages can download or copy them without CORS trouble.
  fetchImage: async ({ urls }) => {
    for (const url of urls || []) {
      try {
        const r = await fetch(url, { credentials: 'omit' });
        if (!r.ok) continue;
        const blob = await r.blob();
        // YouTube answers a missing maxres thumbnail with a 120×90 grey image.
        if (blob.size < 2000) continue;
        const buf = new Uint8Array(await blob.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return { url, dataUrl: `data:${blob.type || 'image/jpeg'};base64,${btoa(bin)}` };
      } catch {
        /* try the next size */
      }
    }
    throw new Error('Thumbnail not available');
  },

  /* ---- videos saved into niches (from the Save button on a video page) ---- */
  videoLookup: async ({ videoId }) => {
    const st = await load();
    return { item: st.swipe.find((x) => x.type === 'video' && x.videoId === videoId) || null };
  },
  saveVideoToNiche: async ({ videoId, nicheId, on = true }) => {
    if (!videoId || !nicheId) throw new Error('Missing video or niche');
    const st = await load();
    const existing = st.swipe.find((x) => x.type === 'video' && x.videoId === videoId);
    // A new video: look up its title, channel, views and exact upload time first.
    const info = existing || !on ? null : await videoInfo(videoId).catch(() => null);
    return mutate((s) => {
      let it = s.swipe.find((x) => x.type === 'video' && x.videoId === videoId);
      if (!it) {
        if (!on) return { item: null };
        it = {
          id: uid(),
          type: 'video',
          videoId,
          channelId: info?.channelId || '',
          title: info?.title || '',
          channelName: info?.channelName || '',
          views: info?.views || 0,
          published: info?.published || null,
          duration: info?.lengthSeconds || 0,
          start: null,
          end: null,
          note: '',
          tags: [],
          nicheIds: [],
          addedAt: Date.now(),
        };
        s.swipe.unshift(it);
      }
      it.nicheIds = (it.nicheIds || []).filter((x) => x !== nicheId);
      if (on) it.nicheIds.push(nicheId);
      return { item: it };
    });
  },

  /* ---- swipe file ---- */
  saveSwipe: ({ item }) =>
    mutate((s) => {
      if (!item?.videoId && !item?.channelId) throw new Error('Nothing to save');
      const rec = {
        id: uid(),
        type: item.type || 'video', // video | part | thumbnail | channel
        videoId: item.videoId || '',
        channelId: item.channelId || '',
        title: String(item.title || '').slice(0, 300),
        channelName: String(item.channelName || '').slice(0, 120),
        views: Number(item.views) || 0,
        published: item.published || null,
        duration: Number(item.duration) || 0,
        start: item.start ?? null,
        end: item.end ?? null,
        note: String(item.note || '').slice(0, 2000),
        tags: (item.tags || []).map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 12),
        nicheIds: item.nicheIds || [],
        addedAt: Date.now(),
      };
      s.swipe.unshift(rec);
      return { item: rec };
    }),
  updateSwipe: ({ id, patch }) =>
    mutate((s) => {
      const it = s.swipe.find((x) => x.id === id);
      if (!it) throw new Error('Item not found');
      for (const k of ['note', 'tags', 'nicheIds', 'start', 'end']) if (k in patch) it[k] = patch[k];
      return { item: it };
    }),
  deleteSwipe: ({ id }) =>
    mutate((s) => {
      s.swipe = s.swipe.filter((x) => x.id !== id);
      return { ok: true };
    }),
  restart: async () => {
    setTimeout(() => chrome.runtime.reload(), 100);
    return { ok: true };
  },

  openDashboard: async ({ hash } = {}) => {
    await openDashboard(hash);
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const fn = HANDLERS[msg?.type];
  if (!fn) {
    sendResponse({ error: `Unknown request ${msg?.type}` });
    return false;
  }
  Promise.resolve()
    .then(async () => {
      if (!OPEN_REQUESTS.has(msg.type) && !(await license()).ok) throw new Error(LOCKED);
      return fn(msg);
    })
    .then((data) => sendResponse({ data }))
    .catch((err) => sendResponse({ error: String(err?.message || err) }));
  return true;
});

/* ---------- dashboard tab ---------- */

async function openDashboard(hash = '') {
  const url = chrome.runtime.getURL('dashboard.html');
  // getContexts finds our own open dashboard without the "tabs" permission
  // (which would show a "read your browsing history" warning on install).
  const contexts = (await chrome.runtime.getContexts?.({ contextTypes: ['TAB'] }).catch(() => [])) || [];
  const ctx = contexts.find((c) => (c.documentUrl || '').startsWith(url));
  if (ctx?.tabId > 0) {
    await chrome.tabs.update(ctx.tabId, { active: true, ...(hash ? { url: `${url}${hash}` } : {}) });
    await chrome.windows.update(ctx.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: `${url}${hash}` });
  }
}

chrome.action.onClicked.addListener(() => openDashboard());

// The activation screen restarted the extension to finish an update: open the dashboard again.
chrome.storage.local.get(['reopenDashboard']).then(({ reopenDashboard }) => {
  if (!reopenDashboard) return;
  chrome.storage.local.remove('reopenDashboard');
  if (Date.now() - reopenDashboard < 60000) openDashboard().catch(() => {});
});

/* ---------- similar channels ---------- */

/**
 * Results live in storage.local.similar[seedId] so the dashboard can show
 * progress live (storage.onChanged) and reopen past searches instantly.
 * Separate key from the library so a long search never rewrites it.
 */
const SIMILAR_TTL = 3 * DAY;
const running = new Map();
const popularCache = new Map(); // channel path → { at, list }

// Writes run one at a time: a late progress write must never undo "done".
let similarChain = Promise.resolve();
function saveSimilar(seedId, patch) {
  similarChain = similarChain.then(() => writeSimilar(seedId, patch)).catch(() => {});
  return similarChain;
}

async function writeSimilar(seedId, patch) {
  const { similar = {} } = await chrome.storage.local.get('similar');
  similar[seedId] = { ...(similar[seedId] || {}), ...patch };
  // Keep the 30 most recent searches.
  const keep = Object.entries(similar).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 30);
  await chrome.storage.local.set({ similar: Object.fromEntries(keep) });
}

async function runSimilar({ input, force = false, mode = 'quick' }) {
  const st = await load();
  let seed = st.channels[input] || findSaved(st.channels, input);
  if (!seed) seed = compact(await fetchChannel(input));
  const seedId = seed.channelId;
  if (running.has(seedId)) return running.get(seedId);

  const { similar = {} } = await chrome.storage.local.get('similar');
  const cached = similar[seedId];
  // An in-depth result also answers a quick request; not the other way round.
  const enough = cached?.mode === 'deep' || cached?.mode === mode || (!cached?.mode && mode === 'quick');
  if (!force && cached?.status === 'done' && enough && Date.now() - cached.at < SIMILAR_TTL) return { seedId, cached: true };

  const job = (async () => {
    const info = { channelId: seedId, title: seed.title, handle: seed.handle, avatar: seed.avatar, subs: seed.subs, url: seed.url };
    await saveSimilar(seedId, { seed: info, mode, status: 'running', stage: 'Starting', done: 0, total: 1, results: cached?.results || [], at: Date.now(), error: '' });
    let lastWrite = 0;
    try {
      const results = await findSimilar(seed, {
        mode,
        onProgress: (stage, done, total, partial) => {
          // Throttle storage writes; the UI only needs a smooth bar.
          if (Date.now() - lastWrite < 700 && done < total) return;
          lastWrite = Date.now();
          saveSimilar(seedId, { stage, done, total, ...(partial.length ? { results: partial.slice(0, mode === 'deep' ? 40 : 20) } : {}) });
        },
      });
      await saveSimilar(seedId, { status: 'done', stage: 'Done', results, at: Date.now() });
      return { seedId, count: results.length };
    } catch (e) {
      await saveSimilar(seedId, { status: 'error', error: e.message || 'Search failed' });
      throw e;
    } finally {
      running.delete(seedId);
    }
  })();
  running.set(seedId, job);
  // Answer right away with the id; progress arrives through storage.
  job.catch(() => {});
  return { seedId, started: true };
}

/* ---------- competitor tracking ---------- */

/**
 * One RSS poll for one competitor: new uploads, title changes and a view
 * point for each recent video. Cheap (one small GET), so it runs every 30 min.
 */
async function pollCompetitor(channelId) {
  const feed = await fetchFeed(channelId);
  const { events, title, notify } = await mutate((s) => {
    const rec = s.channels[channelId];
    if (!rec?.competitor) return { events: [] };
    return { events: applyFeed(rec, feed), title: rec.title, notify: s.settings.notify !== false };
  });
  if (notify) for (const ev of events) notifyEvent(channelId, title, ev);
  return { events: events.length };
}

async function pollCompetitors({ force = false } = {}) {
  const st = await load();
  const due = Object.values(st.channels).filter(
    (c) => c.competitor && c.status !== 'gone' && (force || Date.now() - (c.track?.polledAt || 0) > 25 * 60000),
  );
  let found = 0;
  for (const c of due) {
    try {
      found += (await pollCompetitor(c.channelId)).events;
    } catch {
      /* one failing feed shouldn't stop the rest */
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  return { checked: due.length, events: found };
}

function notifyEvent(channelId, channelTitle, ev) {
  if (!chrome.notifications) return;
  const id = `cs|${ev.videoId}|${ev.type}|${Date.now()}`;
  const opts = ev.type === 'upload'
    ? { title: `${channelTitle} uploaded a video`, message: ev.title, contextMessage: `Published ${fmtWhen(ev.published)}` }
    : { title: `${channelTitle} changed a title`, message: `Now: ${ev.title}`, contextMessage: `Was: ${ev.from}` };
  chrome.notifications.create(id, { type: 'basic', iconUrl: 'icons/icon128.png', priority: 1, ...opts }, () => void chrome.runtime.lastError);
}

chrome.notifications?.onClicked.addListener((id) => {
  const [tag, videoId] = id.split('|');
  if (tag !== 'cs' || !videoId) return;
  chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${videoId}` });
  chrome.notifications.clear(id);
});

/* ---------- daily auto-refresh ---------- */

// Each 30-min tick polls competitor feeds, then refreshes a few stale channels: gentle on YouTube,
// and every channel still gets a growth point about once a day.
const PER_TICK = 12;

/* ---------- auto-backup ---------- */

/**
 * Chrome deletes an extension's storage when it is removed (or loaded again
 * from a different folder), so every 12 hours the whole library is written to
 * Downloads/Channel Saver Backups: one "latest" file plus one per day. It runs
 * quietly — the download bubble is hidden and the entries are cleared from the
 * downloads list; the files stay on disk.
 */
const BACKUP_EVERY = 12 * HOUR;
const BACKUP_DIR = 'Channel Saver Backups';

function toDataUrl(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:application/json;base64,${btoa(bin)}`;
}

function downloadDone(id) {
  return new Promise((resolve) => {
    const onChange = (delta) => {
      if (delta.id !== id || !delta.state || delta.state.current === 'in_progress') return;
      chrome.downloads.onChanged.removeListener(onChange);
      resolve(delta.state.current);
    };
    chrome.downloads.onChanged.addListener(onChange);
    setTimeout(() => {
      chrome.downloads.onChanged.removeListener(onChange);
      resolve('timeout');
    }, 30000);
  });
}

async function autoBackup({ force = false } = {}) {
  if (!chrome.downloads) return { skipped: 'no downloads permission' };
  const st = await load();
  if (!force && Date.now() - (st.settings.lastBackupAt || 0) < BACKUP_EVERY) return { skipped: 'not due' };
  const count = Object.keys(st.channels).length + st.niches.length + st.swipe.length;
  if (!count) return { skipped: 'library is empty' };
  const data = {
    app: 'channel-saver',
    version: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    auto: true,
    niches: st.niches,
    channels: st.channels,
    swipe: st.swipe,
  };
  const url = toDataUrl(JSON.stringify(data));
  const day = new Date().toISOString().slice(0, 10);
  const names = [`${BACKUP_DIR}/channel-saver-backup-latest.json`, `${BACKUP_DIR}/channel-saver-backup-${day}.json`];
  await chrome.downloads.setUiOptions?.({ enabled: false }).catch(() => {});
  let ok = 0;
  try {
    for (const filename of names) {
      const id = await chrome.downloads.download({ url, filename, conflictAction: 'overwrite', saveAs: false });
      if ((await downloadDone(id)) === 'complete') ok++;
      await chrome.downloads.erase({ id }).catch(() => {});
    }
  } finally {
    await chrome.downloads.setUiOptions?.({ enabled: true }).catch(() => {});
  }
  if (!ok) throw new Error('Backup could not be saved to Downloads');
  await mutate((s) => {
    s.settings.lastBackupAt = Date.now();
    s.settings.lastBackupCount = Object.keys(s.channels).length;
  });
  return { ok: true, channels: Object.keys(st.channels).length, file: names[0] };
}

/* ---------- update check ---------- */

async function checkUpdate() {
  if (!UPDATE_URL) return { configured: false };
  const r = await fetch(`${UPDATE_URL}${UPDATE_URL.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
  // 404 = nothing published at the update link yet; not an error for the user.
  if (r.status === 404) return { configured: true, unpublished: true, current: chrome.runtime.getManifest().version, update: null };
  if (!r.ok) throw new Error(`Update check failed (${r.status})`);
  const info = await r.json();
  const current = chrome.runtime.getManifest().version;
  const update = info?.version && isNewer(info.version, current)
    ? { version: String(info.version), download: String(info.download || ''), notes: String(info.notes || '') }
    : null;
  await mutate((s) => {
    s.settings.update = update;
    s.settings.updateCheckedAt = Date.now();
  });
  return { configured: true, current, update };
}

async function tick() {
  const st = await load();
  if (UPDATE_URL && Date.now() - (st.settings.updateCheckedAt || 0) > 12 * HOUR) await checkUpdate().catch(() => {});
  // Backups keep running even while locked, so nobody's data is ever at risk.
  await autoBackup().catch(() => {});
  if (!(await license()).ok) return;
  await pollCompetitors().catch(() => {});
  if (!st.settings.autoRefresh) return;
  const age = (c) => Date.now() - (c.fetchedAt || 0);
  const stale = Object.values(st.channels)
    .filter((c) => c.status !== 'gone' && age(c) > (c.competitor ? 6 * HOUR : DAY))
    .sort((a, b) => (b.competitor ? 1 : 0) - (a.competitor ? 1 : 0) || (a.fetchedAt || 0) - (b.fetchedAt || 0))
    .slice(0, PER_TICK);
  for (const c of stale) {
    await refreshChannel({ channelId: c.channelId });
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/**
 * On browser start and after an update, re-activate with the saved key by itself —
 * the user is only asked for a key when letrestart.com answers ok:false.
 */
async function autoActivate(action = 'activate') {
  const { license: lic } = await chrome.storage.local.get(['license']);
  if (!lic?.key) return;
  try {
    const res = await callLicense(action, lic.key, await deviceId(), await deviceExtra());
    const next = res.ok
      ? { key: lic.key, ...res, ok: true, error: '', checkedAt: Date.now(), lastGood: Date.now() }
      : { ...lic, ok: false, error: res.error, checkedAt: Date.now() };
    await chrome.storage.local.set({ license: next });
  } catch {
    /* offline: keep the saved state, the regular check tries again later */
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('refresh', { periodInMinutes: 30, delayInMinutes: 1 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('refresh', { periodInMinutes: 30, delayInMinutes: 1 });
});

// When the background starts (it also restarts by itself every few minutes, so this is guarded):
//  · a new version (update — including a new folder loaded with "Load unpacked", which Chrome
//    reports as an install) → ?cc=activate with the saved key, no key screen;
//  · otherwise once per browser session → ?cc=check, so the admin panel's "Last seen" updates.
// A few seconds later: right at browser launch the network often isn't up yet.
setTimeout(async () => {
  try {
    const version = chrome.runtime.getManifest().version;
    const { autoActivated } = await chrome.storage.local.get(['autoActivated']);
    if (autoActivated?.version !== version) {
      await chrome.storage.local.set({ autoActivated: { version, at: Date.now() } });
      await chrome.storage.session.set({ seenSent: true });
      return autoActivate('activate');
    }
    const { seenSent } = await chrome.storage.session.get(['seenSent']);
    if (seenSent) return;
    await chrome.storage.session.set({ seenSent: true });
    await autoActivate('check');
  } catch {
    /* tries again next start */
  }
}, 3000);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'refresh') tick().catch(() => {});
});
