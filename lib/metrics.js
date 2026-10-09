/**
 * Everything derived from a saved channel. Pure functions over the stored
 * record, recomputed on render, so changing a formula never needs a migration.
 *
 * Ages are stored as "days old when fetched"; adding the days since fetchedAt
 * keeps them right between refreshes.
 */

const DAY = 86400000;

export const DEFAULT_RPM = { low: 1, high: 4 };
// Shorts pay a small fraction of long-form RPM.
const SHORTS_RPM = { low: 0.03, high: 0.1 };
export const OUTLIER_X = 3;

const median = (nums) => {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

export function ageNow(video, fetchedAt) {
  if (video.ageDays == null) return null;
  return video.ageDays + Math.max(0, (Date.now() - (fetchedAt || Date.now())) / DAY);
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** "Apr 26, 2026" → Date, or null. */
export function parseJoined(s) {
  const m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})/.exec(s || '');
  if (!m || MONTHS[m[1].toLowerCase()] == null) return null;
  return new Date(Number(m[3]), MONTHS[m[1].toLowerCase()], Number(m[2]));
}

/**
 * Growth from the stored snapshots: change per day over the longest span
 * available (at most the last 30 days), or null with fewer than two points
 * a day apart.
 */
export function growth(snapshots = []) {
  if (snapshots.length < 2) return null;
  const last = snapshots[snapshots.length - 1];
  const from = snapshots.find((s) => last.t - s.t <= 30 * DAY) || snapshots[0];
  const days = (last.t - from.t) / DAY;
  if (days < 0.9) return null;
  return {
    days: Math.round(days),
    subsPerDay: (last.subs - from.subs) / days,
    viewsPerDay: last.views && from.views ? (last.views - from.views) / days : null,
    subsChange: last.subs - from.subs,
  };
}

/**
 * What changed for a watched channel: latest snapshot against the one closest
 * to 1 and 7 days earlier. null fields mean there isn't data that far back yet.
 */
export function changes(snapshots = []) {
  const last = snapshots[snapshots.length - 1];
  if (!last) return { subs1d: null, subs7d: null, views1d: null, views7d: null };
  const back = (days) => {
    const target = last.t - days * DAY;
    let best = null;
    for (const s of snapshots) {
      if (s === last || s.t > last.t - 0.5 * DAY) continue;
      if (!best || Math.abs(s.t - target) < Math.abs(best.t - target)) best = s;
    }
    // Too far from the target to call it a "1 day" / "7 day" change.
    return best && Math.abs(best.t - target) <= Math.max(1, days * 0.5) * DAY ? best : null;
  };
  const d1 = back(1);
  const d7 = back(7);
  const diff = (a, k) => (a && last[k] && a[k] ? last[k] - a[k] : null);
  return { subs1d: diff(d1, 'subs'), subs7d: diff(d7, 'subs'), views1d: diff(d1, 'views'), views7d: diff(d7, 'views') };
}

export function computeMetrics(ch, rpm = DEFAULT_RPM) {
  const videos = (ch.videos || []).filter((v) => !v.live);
  const shorts = ch.shorts || [];
  const withAge = videos.map((v) => ({ ...v, age: ageNow(v, ch.fetchedAt) }));

  // Median views ignore videos under 3 days old: they haven't had time yet.
  const settled = withAge.filter((v) => v.age == null || v.age >= 3);
  const medianViews = median(settled.map((v) => v.views));

  const outliers = medianViews
    ? withAge
        .filter((v) => v.views >= medianViews * OUTLIER_X)
        .map((v) => ({ ...v, x: v.views / medianViews }))
        .sort((a, b) => b.x - a.x)
    : [];

  const top = [...withAge].sort((a, b) => b.views - a.views);

  const last30 = withAge.filter((v) => v.age != null && v.age <= 30);
  const last90 = withAge.filter((v) => v.age != null && v.age <= 90);
  let uploadsPerWeek = null;
  if (last90.length >= 2 || last30.length) {
    uploadsPerWeek = last90.length >= last30.length * 3 ? last90.length / (90 / 7) : last30.length / (30 / 7);
  }
  // The list only covers the newest few dozen, so a full list inside 90 days understates frequency.
  const newest = withAge.find((v) => v.age != null);
  const daysSinceUpload = newest ? newest.age : null;

  const joined = parseJoined(ch.joined);
  const ageDays = joined ? (Date.now() - joined.getTime()) / DAY : null;

  // Monthly views: measured growth if we have it, else the last 30 days of uploads,
  // else the lifetime average. The label says which one was used.
  const g = growth(ch.snapshots);
  let monthlyViews = 0;
  let monthlySource = '';
  if (g?.viewsPerDay != null && g.viewsPerDay > 0) {
    monthlyViews = g.viewsPerDay * 30;
    monthlySource = `measured over ${g.days}d`;
  } else if (last30.length) {
    monthlyViews = last30.reduce((s, v) => s + v.views, 0);
    monthlySource = 'views on last-30-day uploads';
  } else if (ch.totalViews && ageDays) {
    monthlyViews = ch.totalViews / Math.max(1, ageDays / 30.4);
    monthlySource = 'lifetime average';
  }

  // Shorts share of uploads decides how much of the views earn long-form RPM.
  const shortsShare = shorts.length + videos.length ? shorts.length / (shorts.length + videos.length) : 0;
  const longViews = monthlyViews * (1 - shortsShare);
  const shortViews = monthlyViews * shortsShare;
  const revenue = {
    low: (longViews / 1000) * rpm.low + (shortViews / 1000) * SHORTS_RPM.low,
    high: (longViews / 1000) * rpm.high + (shortViews / 1000) * SHORTS_RPM.high,
  };

  let format = 'Long';
  if (!videos.length && shorts.length) format = 'Shorts';
  else if (shorts.length && shortsShare > 0.6) format = 'Mostly Shorts';
  else if (shorts.length && shortsShare > 0.2) format = 'Mixed';

  const avgDuration = median(videos.map((v) => v.duration).filter(Boolean));
  const viewsPerSub = ch.subs ? medianViews / ch.subs : null;

  // Monetisation needs 1,000 subs plus watch hours we can't see; this is only the subs half.
  const monetizable = ch.subs >= 1000;

  /**
   * Opportunity: 0-100. Rewards channels that are young, get many views per
   * subscriber, upload regularly and have breakout videos — the pattern of a
   * niche with demand that isn't saturated yet.
   */
  let score = 0;
  if (viewsPerSub != null) score += Math.min(35, viewsPerSub * 35);
  if (ageDays != null) score += ageDays < 180 ? 25 : ageDays < 365 ? 18 : ageDays < 730 ? 8 : 0;
  score += Math.min(20, outliers.length * 5);
  if (uploadsPerWeek) score += Math.min(10, uploadsPerWeek * 4);
  if (revenue.high > 0) score += Math.min(10, Math.log10(revenue.high + 1) * 3);
  score = Math.round(Math.min(100, score));

  return {
    medianViews,
    outliers,
    top,
    uploadsPerWeek,
    daysSinceUpload,
    ageDays,
    joined,
    monthlyViews,
    monthlySource,
    revenue,
    format,
    shortsShare,
    avgDuration,
    viewsPerSub,
    monetizable,
    growth: g,
    score,
    change: changes(ch.snapshots),
    uploads7d: withAge.filter((v) => v.age != null && v.age <= 7).length,
    latest: withAge.filter((v) => v.age != null).sort((a, b) => a.age - b.age),
  };
}

/* ---------- formatting ---------- */

export function fmtNum(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(n / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `${+(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(n));
}

export function fmtMoney(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) return `$${fmtNum(n)}`;
  return `$${Math.round(n)}`;
}

export function fmtAge(days) {
  if (days == null) return '';
  if (days < 1) return 'today';
  if (days < 7) return `${Math.round(days)}d ago`;
  if (days < 30) return `${Math.round(days / 7)}w ago`;
  if (days < 365) return `${Math.round(days / 30.4)}mo ago`;
  return `${+(days / 365).toFixed(1)}y ago`;
}

export function fmtDuration(secs) {
  if (!secs) return '';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtChannelAge(days) {
  if (days == null) return '—';
  if (days < 60) return `${Math.round(days)} days`;
  if (days < 730) return `${Math.round(days / 30.4)} months`;
  return `${+(days / 365).toFixed(1)} years`;
}
