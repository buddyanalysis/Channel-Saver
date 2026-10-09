/**
 * Adds a "Save" button next to Subscribe on YouTube channel pages and video
 * pages. YouTube is a single-page app that re-renders its header freely, so
 * instead of inserting once we re-check on navigation and on DOM changes.
 */
(() => {
  const BTN_ATTR = 'data-cs-save';
  let currentUrl = null; // channel URL the button is showing state for
  let saved = null; // saved channel record, or null
  let niches = [];
  let menu = null;
  let busy = false;

  const send = (type, payload = {}) =>
    new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (res) => {
          if (chrome.runtime.lastError) return reject(new Error('Extension was updated — reload this page.'));
          if (res?.error) return reject(new Error(res.error));
          resolve(res?.data);
        });
      } catch {
        reject(new Error('Extension was updated — reload this page.'));
      }
    });

  const visible = (el) => el && el.offsetParent !== null && el.getBoundingClientRect().width > 0;

  // Where the button goes, and which channel it's for.
  function context() {
    const path = location.pathname;
    if (path === '/watch') {
      const owner = document.querySelector('ytd-watch-metadata #owner');
      const sub = owner?.querySelector('#subscribe-button');
      const link = owner?.querySelector('ytd-channel-name a[href], a.yt-simple-endpoint[href^="/@"], a[href^="/channel/"]');
      if (!visible(sub) || !link) return null;
      return { anchor: sub, url: new URL(link.getAttribute('href'), location.origin).href };
    }
    if (/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/.test(path)) {
      const candidates = document.querySelectorAll(
        'yt-page-header-renderer yt-flexible-actions-view-model, ytd-c4-tabbed-header-renderer #subscribe-button, #page-header yt-subscribe-button-view-model',
      );
      const anchor = [...candidates].find(visible);
      if (!anchor) return null;
      const m = /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/.exec(path);
      return { anchor, url: `${location.origin}/${m[1]}`, inside: anchor.matches('yt-flexible-actions-view-model') };
    }
    return null;
  }

  function render(btn) {
    btn.classList.toggle('cs-saved', !!saved);
    btn.classList.toggle('cs-gone', saved?.status === 'gone');
    btn.replaceChildren();
    const icon = document.createElement('span');
    icon.className = 'cs-icon';
    icon.textContent = busy ? '' : saved ? '✓' : '+';
    if (busy) icon.classList.add('cs-spin');
    const label = document.createElement('span');
    label.textContent = saved ? 'Saved' : 'Save';
    btn.append(icon, label);
    btn.title = saved ? `In Channel Saver${saved.nicheIds.length ? '' : ' (no niche yet)'}` : 'Save to Channel Saver';
  }

  async function refreshState(url) {
    try {
      const res = await send('lookup', { url });
      if (url !== currentUrl) return;
      saved = res.channel;
      niches = res.niches;
    } catch {
      saved = null;
    }
    const btn = document.querySelector(`[${BTN_ATTR}]`);
    if (btn) render(btn);
  }

  function ensureButton() {
    const ctx = context();
    const existing = document.querySelector(`[${BTN_ATTR}]`);
    if (!ctx) {
      if (existing && !visible(existing)) existing.remove();
      return;
    }
    if (ctx.url !== currentUrl) {
      currentUrl = ctx.url;
      saved = null;
      closeMenu();
      refreshState(ctx.url);
    }
    // Already in the right place.
    if (existing && (ctx.inside ? existing.parentElement === ctx.anchor : existing.previousElementSibling === ctx.anchor)) return;
    existing?.remove();

    const btn = document.createElement('button');
    btn.setAttribute(BTN_ATTR, '');
    btn.className = 'cs-btn';
    btn.type = 'button';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (menu) closeMenu();
      else openMenu(btn);
    });
    render(btn);
    if (ctx.inside) ctx.anchor.appendChild(btn);
    else ctx.anchor.insertAdjacentElement('afterend', btn);
  }

  /* ---------- menu ---------- */

  function closeMenu() {
    menu?.remove();
    menu = null;
    parts = null;
    document.removeEventListener('mousedown', outside, true);
  }

  function outside(e) {
    if (menu && !menu.contains(e.target) && !e.target.closest?.(`[${BTN_ATTR}]`)) closeMenu();
  }

  function el(tag, cls, txt) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }

  function toast(msg, isError) {
    const t = el('div', `cs-toast${isError ? ' cs-toast-err' : ''}`, msg);
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('cs-toast-out'), 2600);
    setTimeout(() => t.remove(), 3000);
  }

  async function run(fn) {
    if (busy) return;
    busy = true;
    const btn = document.querySelector(`[${BTN_ATTR}]`);
    if (btn) render(btn);
    paintMenu();
    try {
      await fn();
    } catch (e) {
      toast(e.message, true);
    } finally {
      busy = false;
      await refreshState(currentUrl);
      paintMenu();
    }
  }

  async function toggleNiche(nicheId) {
    await run(async () => {
      if (!saved) {
        const res = await send('add', { input: currentUrl, nicheId });
        toast(res.already ? 'Already in this niche' : `Saved ${res.channel.title}`);
      } else {
        const on = !saved.nicheIds.includes(nicheId);
        await send('setNiche', { channelId: saved.channelId, nicheId, on });
      }
    });
  }

  /**
   * Menu = search box, niche list, "new niche" box. Built once per open; only
   * the header, list and busy line repaint, so the inputs keep focus and text.
   */
  let parts = null;

  function buildMenu() {
    const head = el('div', 'cs-head');
    const search = el('input', 'cs-search');
    search.placeholder = 'Search niches…';
    search.addEventListener('input', paintMenu);
    search.addEventListener('keydown', (e) => {
      // Enter picks the only match.
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const matches = filtered();
      if (matches.length === 1) toggleNiche(matches[0].id);
    });
    const list = el('div', 'cs-list');

    const form = el('form', 'cs-new');
    const label = el('div', 'cs-label', 'New niche');
    const input = el('input');
    input.placeholder = 'Write niche name and press Enter';
    input.maxLength = 80;
    form.append(label, input);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      run(async () => {
        const { niche } = await send('createNiche', { title });
        if (!saved) {
          const res = await send('add', { input: currentUrl, nicheId: niche.id });
          toast(`Saved ${res.channel.title} to ${niche.title}`);
        } else {
          await send('setNiche', { channelId: saved.channelId, nicheId: niche.id, on: true });
          toast(`Added to ${niche.title}`);
        }
        input.value = '';
      });
    });
    const busyLine = el('div', 'cs-busy', 'Fetching channel data…');
    menu.append(head, search, list, form, busyLine);
    parts = { head, search, list, input, busyLine };
  }

  function filtered() {
    const q = (parts?.search.value || '').trim().toLowerCase();
    return [...niches]
      .filter((n) => !q || n.title.toLowerCase().includes(q))
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || a.title.localeCompare(b.title));
  }

  function paintMenu() {
    if (!menu || !parts) return;
    const { head, search, list, input, busyLine } = parts;
    head.replaceChildren(
      el('div', 'cs-title', saved ? saved.title : 'Save this channel'),
      el('div', 'cs-sub', saved ? `${fmt(saved.subs)} subscribers · in ${saved.nicheIds.length} niche${saved.nicheIds.length === 1 ? '' : 's'}` : 'Choose a niche to save it in'),
    );
    search.hidden = niches.length < 6; // Only worth it once the list gets long.

    const rows = filtered();
    list.replaceChildren();
    for (const n of rows) {
      const on = !!saved?.nicheIds.includes(n.id);
      const row = el('button', `cs-row${on ? ' cs-on' : ''}`);
      row.type = 'button';
      row.disabled = busy;
      const box = el('span', 'cs-box', on ? '✓' : '');
      box.style.setProperty('--c', n.color);
      row.append(box, el('span', 'cs-name', n.title));
      row.addEventListener('click', () => toggleNiche(n.id));
      list.append(row);
    }
    if (!niches.length) list.append(el('div', 'cs-empty', 'No niches yet — write the first one below.'));
    else if (!rows.length) list.append(el('div', 'cs-empty', 'No niche with that name.'));

    search.disabled = busy;
    input.disabled = busy;
    busyLine.hidden = !busy;
  }

  async function openMenu(btn) {
    menu = el('div', 'cs-menu');
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    menu.style.top = `${r.bottom + window.scrollY + 8}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + innerWidth - 300))}px`;
    buildMenu();
    paintMenu();
    document.addEventListener('mousedown', outside, true);
    await refreshState(currentUrl);
    paintMenu();
    (parts.search.hidden ? (niches.length ? null : parts.input) : parts.search)?.focus();
  }

  function fmt(n) {
    if (!n) return '0';
    if (n >= 1e6) return `${+(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
    return String(n);
  }

  /* ---------- keep it there ---------- */

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      ensureButton();
    }, 400);
  };
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('yt-navigate-finish', () => {
    closeMenu();
    schedule();
  });
  // The library may change from the dashboard; keep the button truthful.
  chrome.storage.onChanged.addListener((changes) => {
    if (currentUrl && (changes.channels || changes.niches)) refreshState(currentUrl).then(paintMenu);
  });
  schedule();
})();
