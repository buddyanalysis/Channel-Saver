/**
 * Competitor tracking. Pure functions over the stored channel record, shared by
 * the background worker (which applies each RSS poll) and the dashboard (which
 * turns the history into a schedule, 24h views and a timeline).
 *
 * rec.track = {
 *   since:   when tracking started (uploads before this are history, not "new"),
 *   uploads: [{ id, title, published }]               newest first, kept for the schedule
 *   videos:  { [id]: { pts: [[t, views, likes]] } }  view history, first 30 days of each video
 *   log:     [{ t, type, videoId, text }]              newest first
 * }
 */

const HOUR = 3600000;
const DAY = 24 * HOUR;
const MAX_UPLOADS = 300;
const MAX_LOG = 300;
const TRACK_DAYS = 30;

export const emptyTrack = (now = Date.now()) => ({ since: now, uploads: [], videos: {}, log: [] });

/**
 * View points: dense while a video is young (every poll for 3 days), then at
 * most one every 12h, so a month of history stays small.
 */
function addPoint(v, t, views, likes, published) {
  const pts = v.pts || (v.pts = []);
  const last = pts[pts.length - 1];
  if (last && last[1] === views && last[2] === likes) return;
  const young = t - published < 3 * DAY;
  if (last && !young && t - last[0] < 12 * HOUR) pts[pts.length - 1] = [t, views, likes];
  else pts.push([t, views, likes]);
}

/**
 * Merges one RSS poll into rec.track. Returns the events worth telling the
 * user about ({ type: 'upload' | 'title', ... }). The very first poll only
 * seeds history, so adding a competitor doesn't fire 15 "new upload" alerts.
 */
export function applyFeed(rec, feed, now = Date.now()) {
  const first = !rec.track;
  const tr = rec.track || (rec.track = emptyTrack(now));
  const known = new Map(tr.uploads.map((u) => [u.id, u]));
  const events = [];

  for (const v of feed) {
    const prev = known.get(v.id);
    if (!prev) {
      const u = { id: v.id, title: v.title, published: v.published };
      tr.uploads.push(u);
      known.set(v.id, u);
      // New = appeared after tracking began. Old videos showing up for the
      // first time (e.g. made public later) still count if published recently.
      if (!first && v.published >= tr.since - DAY) {
        const ev = { t: now, type: 'upload', videoId: v.id, title: v.title, published: v.published };
        events.push(ev);
        tr.log.unshift({ t: now, type: 'upload', videoId: v.id, text: v.title, published: v.published });
      }
    } else if (prev.title !== v.title && v.title) {
      if (!first) {
        events.push({ t: now, type: 'title', videoId: v.id, from: prev.title, title: v.title });
        tr.log.unshift({ t: now, type: 'title', videoId: v.id, text: v.title, from: prev.title });
      }
      prev.title = v.title;
    }
    if (now - v.published <= TRACK_DAYS * DAY) {
      const vt = tr.videos[v.id] || (tr.videos[v.id] = {});
      addPoint(vt, now, v.views, v.likes, v.published);
    }
  }

  tr.uploads.sort((a, b) => b.published - a.published);
  tr.uploads.length = Math.min(tr.uploads.length, MAX_UPLOADS);
  for (const id of Object.keys(tr.videos)) {
    const u = known.get(id);
    if (!u || now - u.published > TRACK_DAYS * DAY) delete tr.videos[id];
  }
  tr.log.length = Math.min(tr.log.length, MAX_LOG);
  tr.polledAt = now;
  return events;
}

/** Records a "this video became an outlier" event once per video. */
export function noteOutlier(rec, video, x, now = Date.now()) {
  const tr = rec.track;
  if (!tr || tr.log.some((l) => l.type === 'outlier' && l.videoId === video.id)) return false;
  tr.log.unshift({ t: now, type: 'outlier', videoId: video.id, text: video.title, x });
  tr.log.length = Math.min(tr.log.length, MAX_LOG);
  return true;
}

/* ---------- analysis (dashboard) ---------- */

const median = (a) => {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Views at `hours` after publish, interpolated between the points around it. */
export function viewsAt(pts, published, hours) {
  if (!pts?.length) return null;
  const target = published + hours * HOUR;
  let before = null;
  let after = null;
  for (const p of pts) {
    if (p[0] <= target) before = p;
    else {
      after = p;
      break;
    }
  }
  if (before && after) {
    // Only trust it when the points are close to the target.
    if (after[0] - before[0] > Math.max(6 * HOUR, hours * HOUR * 0.5)) return null;
    const f = (target - before[0]) / (after[0] - before[0]);
    return Math.round(before[1] + (after[1] - before[1]) * f);
  }
  if (before && target - before[0] <= 2 * HOUR) return before[1];
  if (after && after[0] - target <= 2 * HOUR) return after[1];
  return null;
}

/** Current speed: views per hour over the last two points at least 30 min apart. */
export function viewsPerHour(pts) {
  if (!pts || pts.length < 2) return null;
  const last = pts[pts.length - 1];
  for (let i = pts.length - 2; i >= 0; i--) {
    const dt = last[0] - pts[i][0];
    if (dt >= 0.5 * HOUR) return (last[1] - pts[i][1]) / (dt / HOUR);
  }
  return null;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function fmtHour(h) {
  const am = h < 12;
  const hh = h % 12 || 12;
  return `${hh} ${am ? 'AM' : 'PM'}`;
}

/**
 * Upload habits from publish times, in the viewer's local time zone:
 * which weekdays, what hour, how many days apart, and when the next one is due.
 */
export function schedule(uploads, now = Date.now()) {
  const recent = uploads.filter((u) => now - u.published <= 120 * DAY).slice(0, 40);
  if (recent.length < 2) return null;

  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  const byDay = Array(7).fill(0);
  const byHour = Array(24).fill(0);
  for (const u of recent) {
    const d = new Date(u.published);
    grid[d.getDay()][d.getHours()]++;
    byDay[d.getDay()]++;
    byHour[d.getHours()]++;
  }

  // Busiest hour, counting the hour either side so 7:58 and 8:03 agree.
  let bestHour = 0;
  let bestScore = -1;
  for (let h = 0; h < 24; h++) {
    const score = byHour[(h + 23) % 24] + byHour[h] * 2 + byHour[(h + 1) % 24];
    if (score > bestScore) {
      bestScore = score;
      bestHour = h;
    }
  }
  const nearHour = recent.filter((u) => {
    const h = new Date(u.published).getHours();
    return Math.min(Math.abs(h - bestHour), 24 - Math.abs(h - bestHour)) <= 1;
  }).length;
  const hourShare = nearHour / recent.length;

  // A weekday is "usual" when it carries a real share of uploads.
  const maxDay = Math.max(...byDay);
  const topDays = byDay.map((n, i) => ({ i, n })).filter((d) => d.n >= Math.max(2, maxDay * 0.5)).map((d) => d.i);
  const dayShare = topDays.reduce((s, i) => s + byDay[i], 0) / recent.length;
  const daily = topDays.length >= 6;

  const sorted = [...recent].sort((a, b) => a.published - b.published);
  const gaps = sorted.slice(1).map((u, i) => (u.published - sorted[i].published) / DAY);
  const gapDays = median(gaps);

  // Next upload: the next usual weekday at the usual hour, or last + typical gap.
  let next = null;
  const last = sorted[sorted.length - 1].published;
  if (topDays.length && dayShare >= 0.6 && !daily) {
    const d = new Date(Math.max(now, last + 0.5 * DAY));
    for (let i = 0; i < 8; i++) {
      const cand = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, bestHour, 0, 0);
      if (topDays.includes(cand.getDay()) && cand.getTime() > Math.max(now - 2 * HOUR, last + 12 * HOUR)) {
        next = cand.getTime();
        break;
      }
    }
  } else if (gapDays) {
    const d = new Date(last + gapDays * DAY);
    next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hourShare >= 0.5 ? bestHour : d.getHours()).getTime();
    while (next < now - 2 * HOUR) next += Math.max(1, Math.round(gapDays)) * DAY;
  }

  const days = daily ? 'Every day' : topDays.length ? topDays.map((i) => WEEKDAYS[i]).join(', ') : 'No fixed days';
  const time = hourShare >= 0.5 ? `around ${fmtHour(bestHour)}` : 'at varying times';
  return {
    grid,
    byDay,
    byHour,
    topDays,
    bestHour,
    hourShare,
    dayShare,
    gapDays,
    perWeek: gapDays ? 7 / gapDays : null,
    next,
    summary: `${days} · ${time}`,
    sample: recent.length,
    overdue: next != null && now > next + 3 * HOUR,
  };
}

/**
 * Per-upload performance for the newest uploads we have view history for:
 * exact time, current views, first-24h views, speed, likes.
 */
export function uploadStats(rec, limit = 15) {
  const tr = rec.track;
  if (!tr) return { rows: [], typical24h: null };
  const rows = tr.uploads.slice(0, limit).map((u) => {
    const pts = tr.videos[u.id]?.pts;
    const last = pts?.[pts.length - 1];
    return {
      ...u,
      views: last?.[1] ?? null,
      likes: last?.[2] ?? null,
      likeRate: last && last[1] ? last[2] / last[1] : null,
      v24: viewsAt(pts, u.published, 24),
      v1: viewsAt(pts, u.published, 1),
      speed: viewsPerHour(pts),
      tracked: !!pts && pts[0][0] - u.published < 6 * HOUR, // watched since near publish
    };
  });
  const typical24h = median(rows.map((r) => r.v24).filter((v) => v != null));
  for (const r of rows) r.vs24 = r.v24 != null && typical24h ? r.v24 / typical24h : null;
  return { rows, typical24h };
}

export function fmtWhen(t, withYear = false) {
  const d = new Date(t);
  const date = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}

export { WEEKDAYS };
