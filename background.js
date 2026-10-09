import { fetchChannel, fetchFeed, parseInput } from './lib/yt.js';
import { applyFeed, noteOutlier, fmtWhen } from './lib/track.js';
import { computeMetrics } from './lib/metrics.js';
import { load, mutate, uid } from './lib/store.js';
import { UPDATE_URL, isNewer } from './lib/config.js';

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
    if (patch.competitor) await pollCompetitor(channelId).catch(() => {});
    return res;
  },

  pollCompetitors: () => pollCompetitors({ force: true }),

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
      for (const [id, c] of Object.entries(data.channels)) {
        if (!c?.channelId) continue;
        const prev = s.channels[id];
        if (prev) prev.nicheIds = [...new Set([...prev.nicheIds, ...(c.nicheIds || [])])];
        else {
          s.channels[id] = c;
          channels++;
        }
      }
      return { niches, channels };
    }),

  saveSettings: ({ patch }) =>
    mutate((s) => {
      Object.assign(s.settings, patch);
      return { settings: s.settings };
    }),

  checkUpdate: () => checkUpdate(),
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
    .then(() => fn(msg))
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

/* ---------- update check ---------- */

async function checkUpdate() {
  if (!UPDATE_URL) return { configured: false };
  const r = await fetch(`${UPDATE_URL}${UPDATE_URL.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
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

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('refresh', { periodInMinutes: 30, delayInMinutes: 1 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('refresh', { periodInMinutes: 30, delayInMinutes: 1 });
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'refresh') tick().catch(() => {});
});
