/**
 * Shared helpers for every Channel Saver script on YouTube. Content scripts
 * listed together in the manifest share one isolated world, so the others use
 * window.CS. Loaded first.
 */
(() => {
  const CS = (window.CS = window.CS || {});

  CS.send = (type, payload = {}) =>
    new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (res) => {
          if (chrome.runtime.lastError) return reject(new Error('Channel Saver was updated — reload this page.'));
          if (res?.error) {
            if (/^Unknown request/.test(res.error)) return reject(new Error('Channel Saver was updated — open its dashboard and click "Restart now".'));
            return reject(new Error(res.error));
          }
          resolve(res?.data);
        });
      } catch {
        reject(new Error('Channel Saver was updated — reload this page.'));
      }
    });

  CS.el = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  };

  CS.toast = (msg, isError) => {
    const t = CS.el('div', `cs-toast${isError ? ' cs-toast-err' : ''}`, msg);
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('cs-toast-out'), 2600);
    setTimeout(() => t.remove(), 3000);
  };

  CS.closePanels = () => document.querySelectorAll('.cs-panel').forEach((p) => p.remove());

  CS.visible = (el) => !!el && el.offsetParent !== null && el.getBoundingClientRect().width > 0;

  /* ---------- formatting ---------- */

  CS.num = (n) => {
    if (n == null || !Number.isFinite(n)) return '—';
    const a = Math.abs(n);
    if (a >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
    if (a >= 1e6) return `${+(n / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
    if (a >= 1e3) return `${+(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`;
    return String(Math.round(n));
  };
  CS.ago = (days) => {
    if (days == null) return '';
    if (days < 1 / 24) return `${Math.max(1, Math.round(days * 1440))}m ago`;
    if (days < 1) return `${Math.round(days * 24)}h ago`;
    if (days < 7) return `${Math.round(days)}d ago`;
    if (days < 30) return `${Math.round(days / 7)}w ago`;
    if (days < 365) return `${Math.round(days / 30.4)}mo ago`;
    return `${+(days / 365).toFixed(1)}y ago`;
  };
  CS.when = (t) => {
    const d = new Date(t);
    return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  };
  /** "1.2M views" / "1,234 views" / "1.2K" → number. */
  CS.parseCount = (s) => {
    const m = /([\d.,]+)\s*([KMB])?/i.exec(String(s || '').replace(/,(?=\d{3})/g, ''));
    if (!m) return null;
    return Math.round(parseFloat(m[1].replace(/,/g, '.')) * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1));
  };
  /** "3 days ago" / "2d ago" / "Streamed 5 hours ago" → days. */
  CS.parseAge = (s) => {
    const m = /(\d+)\s*(seconds?|s|minutes?|min|m(?!o)|hours?|h|days?|d|weeks?|w|months?|mo|years?|y)\b/i.exec(s || '');
    if (!m) return null;
    const u = m[2].toLowerCase();
    const per = u.startsWith('mo') ? 30.4 : u.startsWith('s') ? 1 / 86400 : u.startsWith('m') ? 1 / 1440 : u.startsWith('h') ? 1 / 24 : u.startsWith('d') ? 1 : u.startsWith('w') ? 7 : 365;
    return Number(m[1]) * per;
  };
  CS.mmss = (secs) => {
    secs = Math.max(0, Math.round(secs || 0));
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  };
  CS.parseMmss = (str) => {
    const p = String(str || '').trim().split(':').map(Number);
    if (!p.length || p.some(Number.isNaN)) return null;
    return p.reduce((a, x) => a * 60 + x, 0);
  };

  /* ---------- settings ---------- */

  const DEFAULTS = { saveButton: true, badges: true, filter: true, hover: true, shorts: true, videoTools: true, similarButton: true };
  CS.features = { ...DEFAULTS };
  const listeners = [];
  CS.onFeatures = (fn) => listeners.push(fn);
  chrome.storage.local.get('settings').then(({ settings }) => {
    CS.features = { ...DEFAULTS, ...(settings?.features || {}) };
    listeners.forEach((f) => f(CS.features));
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !ch.settings) return;
    CS.features = { ...DEFAULTS, ...(ch.settings.newValue?.features || {}) };
    listeners.forEach((f) => f(CS.features));
  });

  /* ---------- page changes ---------- */

  // YouTube is a single-page app: one debounced tick for every script on DOM
  // changes and navigation, instead of each running its own observer.
  const ticks = [];
  CS.onTick = (fn) => ticks.push(fn);
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      for (const fn of ticks) {
        try {
          fn();
        } catch (e) {
          console.debug('[Channel Saver]', e);
        }
      }
    }, 450);
  };
  CS.schedule = schedule;
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('yt-navigate-finish', schedule);

  /* ---------- channel facts (batched) ---------- */

  // Collects lookups for ~150ms, then asks the background once.
  const liteCache = new Map();
  let want = new Map();
  let timer = null;
  // Same rule as the background: handles lowercase, channel ids keep their case.
  CS.liteKey = (path) => {
    const p = String(path || '').replace(/^https?:\/\/[^/]+/, '').replace(/\/(videos|shorts|about|featured|streams|community|playlists).*$/, '').split('?')[0];
    return /^\/channel\//i.test(p) ? p.replace(/^\/channel\//i, '/channel/') : p.toLowerCase();
  };
  CS.lite = (path) => {
    const key = CS.liteKey(path);
    if (!key) return Promise.resolve(null);
    if (liteCache.has(key)) return liteCache.get(key);
    const p = new Promise((resolve) => {
      const list = want.get(key) || [];
      list.push(resolve);
      want.set(key, list);
    });
    liteCache.set(key, p);
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const batch = want;
      want = new Map();
      let res = {};
      try {
        res = await CS.send('channelLite', { paths: [...batch.keys()] });
      } catch {
        /* resolve all as null below */
      }
      for (const [k, resolvers] of batch) {
        const v = res?.[k] || null;
        if (!v) liteCache.delete(k); // allow a retry later
        resolvers.forEach((r) => r(v));
      }
    }, 150);
    return p;
  };

  /** Channel path from any link inside a video tile. */
  CS.channelPathFrom = (root) => {
    const a = root.querySelector('a[href^="/@"], a[href^="/channel/"], a[href*="youtube.com/@"]');
    if (!a) return '';
    const m = /^\/(@[^/?#]+|channel\/UC[\w-]{22})/.exec(new URL(a.getAttribute('href'), location.origin).pathname);
    return m ? `/${decodeURIComponent(m[1])}` : '';
  };

  CS.page = () => {
    const p = location.pathname;
    if (p === '/') return 'home';
    if (p === '/results') return 'search';
    if (p.startsWith('/feed/subscriptions')) return 'subscriptions';
    if (p === '/watch') return 'watch';
    if (p.startsWith('/shorts/')) return 'shorts';
    if (/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/.test(p)) return 'channel';
    return 'other';
  };
})();
