/**
 * YouTube channel reader. Pure fetch + parse, no chrome.* calls, so the same
 * file runs in the extension's service worker and in Node for testing.
 *
 * YouTube changes its page JSON often, so every lookup goes through small
 * deep-search helpers instead of fixed paths: when a wrapper object gets
 * renamed, the field inside it is usually still found.
 */

const BASE = 'https://www.youtube.com';
const HEADERS = { 'Accept-Language': 'en-US,en;q=0.9' };

/* ---------- generic helpers ---------- */

// Pulls `var NAME = {...};` out of the page by brace-matching (regex can't).
export function extractJson(html, name) {
  let i = html.indexOf(`${name} = {`);
  if (i < 0) i = html.indexOf(`${name}={`);
  if (i < 0) return null;
  const start = html.indexOf('{', i);
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, j + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Every value stored under `key` anywhere inside obj, in document order.
export function findAll(obj, key, out = [], limit = Infinity) {
  if (!obj || typeof obj !== 'object' || out.length >= limit) return out;
  if (Array.isArray(obj)) {
    for (const v of obj) findAll(v, key, out, limit);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === key) out.push(v);
    if (v && typeof v === 'object') findAll(v, key, out, limit);
    if (out.length >= limit) break;
  }
  return out;
}

export const findFirst = (obj, key) => findAll(obj, key, [], 1)[0];

// YouTube text comes as {simpleText}, {runs:[{text}]}, {content} or a plain string.
export function text(t) {
  if (t == null) return '';
  if (typeof t === 'string') return t;
  if (t.simpleText) return t.simpleText;
  if (t.content) return t.content;
  if (Array.isArray(t.runs)) return t.runs.map((r) => r.text).join('');
  return '';
}

const bestImage = (sources) => {
  if (!Array.isArray(sources) || !sources.length) return '';
  const s = [...sources].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  let url = s.url || '';
  if (url.startsWith('//')) url = `https:${url}`;
  return url;
};

/** "16.8K subscribers" / "1,234 views" / "2.1M" → number. */
export function parseCount(str) {
  if (!str) return 0;
  const s = String(str).replace(/,/g, '');
  if (/no views/i.test(s)) return 0;
  const m = /([\d.]+)\s*([KMB])?/i.exec(s);
  if (!m) return 0;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
}

/** "3 days ago" / "2d ago" / "3mo ago" / "Streamed 2 weeks ago" → approximate age in days. */
export function parseAgeDays(str) {
  const m = /(\d+)\s*(seconds?|s|minutes?|min|m(?!o)|hours?|h|days?|d|weeks?|w|months?|mo|years?|y)\b/i.exec(str || '');
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  const days =
    u.startsWith('mo') ? 30.4
    : u.startsWith('s') ? 1 / 86400
    : u.startsWith('m') ? 1 / 1440
    : u.startsWith('h') ? 1 / 24
    : u.startsWith('d') ? 1
    : u.startsWith('w') ? 7
    : 365;
  return n * days;
}

/** "12:34" / "1:02:03" → seconds. */
export function parseDuration(str) {
  if (!str) return 0;
  const parts = String(str).trim().split(':').map(Number);
  if (parts.some(Number.isNaN)) return 0;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/* ---------- network ---------- */

async function getPage(path) {
  const r = await fetch(`${BASE}${path}`, { headers: HEADERS, credentials: 'omit' });
  if (r.status === 404) {
    const e = new Error('Channel not found');
    e.notFound = true;
    throw e;
  }
  if (!r.ok) throw new Error(`YouTube answered ${r.status}`);
  return r.text();
}

function innertube(html) {
  return {
    key: /"INNERTUBE_API_KEY":"([^"]+)"/.exec(html)?.[1] || '',
    version: /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/.exec(html)?.[1] || '2.20250101.00.00',
  };
}

async function browse(it, body) {
  const r = await fetch(`${BASE}/youtubei/v1/browse?prettyPrint=false${it.key ? `&key=${it.key}` : ''}`, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json', ...HEADERS },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion: it.version, hl: 'en', gl: 'US' } },
      ...body,
    }),
  });
  if (!r.ok) throw new Error(`YouTube browse ${r.status}`);
  return r.json();
}

/* ---------- URL handling ---------- */

/**
 * Accepts a channel URL, a bare @handle, a channel id, or a video URL, and
 * returns the path to request ("/@handle", "/channel/UC...") or a video id.
 */
export function parseInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (/^@[\w.\-]+$/.test(raw)) return { path: `/${raw}` };
  if (/^UC[\w-]{22}$/.test(raw)) return { path: `/channel/${raw}` };
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(u.hostname)) return null;
  if (/youtu\.be$/i.test(u.hostname)) return { videoId: u.pathname.slice(1).split('/')[0] };
  const ch = /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/.exec(u.pathname);
  if (ch) return { path: `/${decodeURIComponent(ch[1])}` };
  const v = u.searchParams.get('v') || /^\/(shorts|live)\/([\w-]+)/.exec(u.pathname)?.[2];
  if (v) return { videoId: v };
  return null;
}

async function channelPathFromVideo(videoId) {
  const html = await getPage(`/watch?v=${encodeURIComponent(videoId)}`);
  const id = /"channelId":"(UC[\w-]{22})"/.exec(html)?.[1] || /"externalChannelId":"(UC[\w-]{22})"/.exec(html)?.[1];
  if (!id) throw new Error('Could not find the channel of this video');
  return `/channel/${id}`;
}

/* ---------- parsing ---------- */

function parseHeader(data) {
  const meta = findFirst(data, 'channelMetadataRenderer') || {};
  const out = {
    channelId: meta.externalId || '',
    title: meta.title || '',
    description: meta.description || '',
    avatar: bestImage(meta.avatar?.thumbnails),
    keywords: meta.keywords || '',
    familySafe: meta.isFamilySafe !== false,
    handle: '',
    banner: '',
    subs: 0,
    videoCount: 0,
    verified: false,
  };
  const vanity = meta.vanityChannelUrl || '';
  out.handle = /\/(@[^/?]+)/.exec(vanity)?.[1] || '';

  // Newer layout: pageHeaderViewModel. Older: c4TabbedHeaderRenderer.
  const ph = findFirst(data, 'pageHeaderViewModel');
  if (ph) {
    out.title = out.title || text(ph.title?.dynamicTextViewModel?.text);
    out.avatar = bestImage(findFirst(ph.image, 'sources')) || out.avatar;
    out.banner = bestImage(findFirst(ph.banner, 'sources'));
    const parts = findAll(ph.metadata, 'metadataParts').flat();
    for (const p of parts) {
      const t = text(p.text);
      if (/subscriber/i.test(t)) out.subs = parseCount(t);
      else if (/video/i.test(t)) out.videoCount = parseCount(t);
      else if (t.startsWith('@')) out.handle = out.handle || t;
    }
    out.verified = JSON.stringify(ph.title || {}).includes('CHECK_CIRCLE');
  }
  const c4 = findFirst(data, 'c4TabbedHeaderRenderer');
  if (c4) {
    out.banner = out.banner || bestImage(c4.banner?.thumbnails);
    out.subs = out.subs || parseCount(text(c4.subscriberCountText));
    out.videoCount = out.videoCount || parseCount(text(c4.videosCountText));
    out.handle = out.handle || text(c4.channelHandleText);
  }
  return out;
}

// Normalises the two video item shapes YouTube currently ships.
function parseVideoItem(item) {
  const vr = item.videoRenderer || item.gridVideoRenderer;
  if (vr?.videoId) {
    return {
      id: vr.videoId,
      title: text(vr.title),
      views: parseCount(text(vr.viewCountText)),
      ageText: text(vr.publishedTimeText),
      ageDays: parseAgeDays(text(vr.publishedTimeText)),
      duration: parseDuration(text(vr.lengthText) || findFirst(vr.thumbnailOverlays, 'text')?.simpleText),
      live: !!text(vr.viewCountText).match(/watching/i),
    };
  }
  const lv = item.lockupViewModel;
  if (lv?.contentId && /VIDEO/.test(lv.contentType || 'VIDEO')) {
    // Only the visible metadata block: the "..." menu nests its own parts too.
    const lm = lv.metadata?.lockupMetadataViewModel || {};
    const parts = findAll(lm.metadata, 'metadataParts').flat();
    // The visible text is compact ("5.7K", "2d ago"); the label spells it out.
    const rows = parts.map((p) => `${p.accessibilityLabel || ''} ${text(p.text)}`);
    const viewsPart = parts.find((p) => p.leadingIcon?.name?.includes('PLAY') || /view/i.test(p.accessibilityLabel || text(p.text)));
    const viewsText = viewsPart ? text(viewsPart.text) || viewsPart.accessibilityLabel : '';
    const ageText = (rows.find((r) => /ago/i.test(r)) || '').trim();
    const badge = findAll(lv.contentImage, 'thumbnailBadgeViewModel').map((b) => b.text).find(Boolean) || '';
    return {
      id: lv.contentId,
      title: text(lm.title),
      views: parseCount(viewsText),
      ageText: text(parts.find((p) => /ago/i.test(text(p.text)))?.text) || ageText,
      ageDays: parseAgeDays(ageText),
      duration: parseDuration(badge),
      live: false,
    };
  }
  return null;
}

function parseShortItem(item) {
  const sl = item.shortsLockupViewModel;
  if (sl) {
    const id = sl.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId || /([\w-]{11})/.exec(sl.entityId || '')?.[1];
    return {
      id,
      title: text(sl.overlayMetadata?.primaryText),
      views: parseCount(text(sl.overlayMetadata?.secondaryText)),
    };
  }
  const rr = item.reelItemRenderer;
  if (rr) return { id: rr.videoId, title: text(rr.headline), views: parseCount(text(rr.viewCountText)) };
  return null;
}

function gridItems(data) {
  const items = [];
  for (const g of findAll(data, 'richItemRenderer')) if (g.content) items.push(g.content);
  for (const g of findAll(data, 'gridVideoRenderer')) items.push({ gridVideoRenderer: g });
  const token = findAll(data, 'continuationCommand').map((c) => c.token).find(Boolean) || null;
  return { items, token };
}

async function readTab(path, tab, it, wantPages, parse) {
  let html;
  try {
    html = await getPage(`${path}/${tab}`);
  } catch {
    return { list: [], html: null };
  }
  const data = extractJson(html, 'ytInitialData');
  if (!data) return { list: [], html };
  // A channel without this tab redirects to its home tab; detect that.
  const selected = findAll(data, 'tabRenderer').find((t) => t.selected);
  if (selected && !new RegExp(tab, 'i').test(selected.endpoint?.commandMetadata?.webCommandMetadata?.url || '')) {
    return { list: [], html, data };
  }
  let { items, token } = gridItems(data);
  const list = items.map(parse).filter((v) => v && v.id);
  for (let page = 1; page < wantPages && token; page++) {
    try {
      const more = await browse(it, { continuation: token });
      const next = gridItems(more);
      const parsed = next.items.map(parse).filter((v) => v && v.id);
      if (!parsed.length) break;
      list.push(...parsed);
      token = next.token;
    } catch {
      break;
    }
  }
  return { list, html, data };
}

function parseAbout(about) {
  return {
    joined: text(about.joinedDateText).replace(/^Joined\s*/i, ''),
    totalViews: parseCount(text(about.viewCountText)),
    country: text(about.country),
    subs: parseCount(text(about.subscriberCountText)),
    videoCount: parseCount(text(about.videoCountText)),
    links: findAll(about.links, 'channelExternalLinkViewModel').map((l) => ({
      title: text(l.title),
      url: text(l.link),
    })),
  };
}

/**
 * The About panel (join date, total views, country). The /about URL embeds it
 * in the page, which is a plain GET; the continuation call is the fallback.
 */
async function readAbout(path, data, it) {
  try {
    const page = extractJson(await getPage(`${path}/about`), 'ytInitialData');
    const about = findFirst(page, 'aboutChannelViewModel');
    if (about) return parseAbout(about);
  } catch {
    /* fall through to the continuation */
  }
  const tokens = findAll(data?.header, 'continuationCommand').map((c) => c.token).filter(Boolean);
  for (const token of tokens) {
    try {
      const about = findFirst(await browse(it, { continuation: token }), 'aboutChannelViewModel');
      if (about) return parseAbout(about);
    } catch {
      /* try the next token */
    }
  }
  return null;
}

/* ---------- RSS feed (exact upload times) ---------- */

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) =>
  String(s || '').replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return XML_ENTITIES[e] ?? m;
  });

/**
 * The channel's public RSS feed: the newest ~15 uploads with exact publish
 * time, exact view count and like count. One small GET, so it's cheap enough
 * to poll competitors often. (No DOMParser in a service worker, hence regex.)
 */
export async function fetchFeed(channelId) {
  const r = await fetch(`${BASE}/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, { credentials: 'omit' });
  if (r.status === 404) {
    const e = new Error('Channel not found');
    e.notFound = true;
    throw e;
  }
  if (!r.ok) throw new Error(`YouTube feed answered ${r.status}`);
  const xml = await r.text();
  const pick = (block, re) => re.exec(block)?.[1] ?? '';
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    .map(([, b]) => ({
      id: pick(b, /<yt:videoId>([^<]+)</),
      title: unxml(pick(b, /<title>([^<]*)</)),
      published: Date.parse(pick(b, /<published>([^<]+)</)) || null,
      views: Number(pick(b, /<media:statistics views="(\d+)"/)) || 0,
      likes: Number(pick(b, /<media:starRating count="(\d+)"/)) || 0,
    }))
    .filter((v) => v.id && v.published);
}

/**
 * Fetches everything we show for one channel.
 * Throws for invalid input or a missing channel; partial data is fine otherwise.
 */
export async function fetchChannel(input, { videoPages = 2 } = {}) {
  const parsed = parseInput(input);
  if (!parsed) throw new Error('Not a YouTube channel or video link');
  const path = parsed.path || (await channelPathFromVideo(parsed.videoId));

  const videosTab = await readTab(path, 'videos', null, 1, parseVideoItem);
  let data = videosTab.data;
  let html = videosTab.html;
  if (!data) {
    html = await getPage(path);
    data = extractJson(html, 'ytInitialData');
    if (!data) throw new Error('YouTube page could not be read');
  }
  if (findFirst(data, 'alertRenderer') && !findFirst(data, 'channelMetadataRenderer')) {
    const msg = text(findFirst(findFirst(data, 'alertRenderer'), 'text'));
    const e = new Error(msg || 'This channel is not available');
    e.gone = true;
    throw e;
  }

  const it = innertube(html);
  const header = parseHeader(data);

  // More pages of long videos via continuation, now that we have the key.
  let videos = videosTab.list;
  if (videoPages > 1 && videos.length) {
    const more = await readTab(path, 'videos', it, videoPages, parseVideoItem);
    if (more.list.length > videos.length) videos = more.list;
  }

  const [shortsTab, about] = await Promise.all([
    readTab(path, 'shorts', it, 1, parseShortItem),
    readAbout(path, data, it),
  ]);

  return {
    ...header,
    url: header.handle ? `${BASE}/${header.handle}` : `${BASE}/channel/${header.channelId}`,
    subs: header.subs || about?.subs || 0,
    videoCount: header.videoCount || about?.videoCount || 0,
    totalViews: about?.totalViews || 0,
    joined: about?.joined || '',
    country: about?.country || '',
    links: about?.links || [],
    videos,
    shorts: shortsTab.list,
    fetchedAt: Date.now(),
  };
}
