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

  const send = (type, payload = {}) => (globalThis.CSBusy?.track ?? ((t, p) => p))(type,
    new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (res) => {
          if (chrome.runtime.lastError) return reject(new Error('Extension was updated — reload this page.'));
          if (res?.error) {
            // Old background still running after new files were copied in.
            if (/^Unknown request/.test(res.error)) return reject(new Error('Channel Saver was updated — open its dashboard and click "Restart now".'));
            return reject(new Error(res.error));
          }
          resolve(res?.data);
        });
      } catch {
        reject(new Error('Extension was updated — reload this page.'));
      }
    }));

  const visible = (el) => el && el.offsetParent !== null && el.getBoundingClientRect().width > 0;

  // Where the button goes, and which channel it's for.
  function context() {
    const path = location.pathname;
    if (path === '/watch') {
      const owner = document.querySelector('ytd-watch-metadata #owner');
      const sub = owner?.querySelector('#subscribe-button');
      const link = owner?.querySelector('ytd-channel-name a[href], a.yt-simple-endpoint[href^="/@"], a[href^="/channel/"]');
      if (!visible(sub)) return null;
      // Collab videos ("A and B") have no channel link; the video URL still
      // leads the background to the channel when saving it.
      const videoId = new URL(location.href).searchParams.get('v');
      return { anchor: sub, videoId, url: link ? new URL(link.getAttribute('href'), location.origin).href : `${location.origin}/watch?v=${videoId}` };
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

  /*
   * On a video page the button saves the VIDEO into niches (that's what people
   * do most); a Video | Channel switch in the menu can save the channel too.
   * On channel pages it saves the channel.
   */
  let mode = 'channel'; // 'video' | 'channel'
  let videoId = null;
  let videoItem = null; // saved video record (swipe item) or null

  const isSaved = () => (mode === 'video' ? !!videoItem?.nicheIds?.length : !!saved);
  const activeNicheIds = () => (mode === 'video' ? videoItem?.nicheIds || [] : saved?.nicheIds || []);

  function render(btn) {
    const on = isSaved();
    btn.classList.toggle('cs-saved', on);
    btn.classList.toggle('cs-gone', mode === 'channel' && saved?.status === 'gone');
    btn.replaceChildren();
    const icon = document.createElement('span');
    icon.className = 'cs-icon';
    icon.textContent = busy ? '' : on ? '✓' : '+';
    if (busy) icon.classList.add('cs-spin');
    const label = document.createElement('span');
    label.textContent = on ? 'Saved' : 'Save';
    btn.append(icon, label);
    btn.title = mode === 'video' ? (on ? 'Video saved in a niche' : 'Save this video into a niche') : saved ? `Channel in Channel Saver${saved.nicheIds.length ? '' : ' (no niche yet)'}` : 'Save this channel';
  }

  // Set when the extension can't be reached (usually: it was reloaded/updated
  // and this tab still runs the old copy). The menu then says so instead of
  // pretending there are no niches.
  let lookupError = null;

  async function refreshState(url) {
    try {
      const res = await send('lookup', { url });
      if (url !== currentUrl) return;
      saved = res.channel;
      niches = res.niches;
      videoItem = videoId ? (await send('videoLookup', { videoId })).item : null;
      lookupError = null;
    } catch (e) {
      saved = null;
      lookupError = e.message || 'Channel Saver could not be reached.';
    }
    const btn = document.querySelector(`[${BTN_ATTR}]`);
    if (btn) render(btn);
  }

  const SIM_ATTR = 'data-cs-similar';

  // "🔍 Similar" next to Save on channel pages: opens the dashboard search.
  function ensureSimilar(ctx) {
    const existing = document.querySelector(`[${SIM_ATTR}]`);
    const onChannel = /^\/(@|channel\/|c\/|user\/)/.test(location.pathname);
    if (!ctx || !onChannel || window.CS?.features.similarButton === false) return existing?.remove();
    const save = document.querySelector(`[${BTN_ATTR}]`);
    if (existing && (save ? existing.previousElementSibling === save : existing.isConnected)) return;
    existing?.remove();
    const b = document.createElement('button');
    b.setAttribute(SIM_ATTR, '');
    b.type = 'button';
    b.className = 'cs-btn cs-btn-ghost';
    b.title = 'Find channels similar to this one';
    b.textContent = '🔍 Similar';
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Opens a side panel right here on YouTube (falls back to the dashboard).
      const name = document.querySelector('yt-page-header-renderer h1, #page-header h1, ytd-channel-name#channel-name')?.textContent?.trim();
      if (window.CS?.similarPanel) window.CS.similarPanel(currentUrl || ctx.url, name);
      else send('openDashboard', { hash: `#similar=${encodeURIComponent(currentUrl || ctx.url)}` }).catch((err) => toast(err.message, true));
    });
    if (save) save.insertAdjacentElement('afterend', b);
    else if (ctx.inside) ctx.anchor.appendChild(b);
    else ctx.anchor.insertAdjacentElement('afterend', b);
  }

  function ensureButton() {
    const ctx = context();
    const existing = document.querySelector(`[${BTN_ATTR}]`);
    if (!ctx) {
      if (existing && !visible(existing)) existing.remove();
      ensureSimilar(null);
      return;
    }
    // Save button switched off in Settings.
    if (window.CS?.features.saveButton === false) {
      existing?.remove();
      closeMenu();
      ensureSimilar(ctx);
      return;
    }
    // Same channel, next video: still a new state for the video save.
    if (ctx.url !== currentUrl || (ctx.videoId || null) !== videoId) {
      currentUrl = ctx.url;
      videoId = ctx.videoId || null;
      mode = videoId ? 'video' : 'channel';
      saved = null;
      videoItem = null;
      closeMenu();
      refreshState(ctx.url);
    }
    // Already in the right place.
    if (existing && (ctx.inside ? existing.parentElement === ctx.anchor : existing.previousElementSibling === ctx.anchor)) return ensureSimilar(ctx);
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
    ensureSimilar(ctx);
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
      if (mode === 'video') {
        const on = !(videoItem?.nicheIds || []).includes(nicheId);
        const res = await send('saveVideoToNiche', { videoId, nicheId, on });
        const n = niches.find((x) => x.id === nicheId);
        toast(on ? `Video saved to ${n?.title || 'niche'}` : `Removed from ${n?.title || 'niche'}`);
        videoItem = res.item;
        return;
      }
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
      else if (!matches.length && search.value.trim()) {
        parts.input.value = search.value.trim();
        search.value = '';
        parts.input.form.requestSubmit();
      }
    });
    const list = el('div', 'cs-list');

    const form = el('form', 'cs-new');
    const labelRow = el('div', 'cs-new-head');
    const create = el('button', 'cs-create', '＋ Create & save');
    create.type = 'submit';
    labelRow.append(el('div', 'cs-label', 'New niche'), create);
    const input = el('input');
    input.placeholder = 'Write a niche name…';
    input.maxLength = 80;
    form.append(labelRow, input);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const title = input.value.trim();
      if (!title) {
        input.focus();
        return;
      }
      run(async () => {
        const { niche } = await send('createNiche', { title });
        if (mode === 'video') {
          videoItem = (await send('saveVideoToNiche', { videoId, nicheId: niche.id, on: true })).item;
          toast(`Video saved to ${niche.title}`);
        } else if (!saved) {
          const res = await send('add', { input: currentUrl, nicheId: niche.id });
          toast(`Saved ${res.channel.title} to ${niche.title}`);
        } else {
          await send('setNiche', { channelId: saved.channelId, nicheId: niche.id, on: true });
          toast(`Added to ${niche.title}`);
        }
        input.value = '';
      });
    });
    const busyLine = el('div', 'cs-busy', 'Saving…');
    // Search first, so a long niche list is one keystroke away.
    menu.append(search, head, list, form, busyLine);
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
    const kids = [];
    if (videoId) {
      // Video | Channel switch (video pages only).
      const sw = el('div', 'cs-mode');
      for (const [m, label] of [['video', '🎬 Video'], ['channel', '📺 Channel']]) {
        const b = el('button', mode === m ? 'on' : null, label);
        b.type = 'button';
        b.addEventListener('click', () => {
          mode = m;
          paintMenu();
          const btn = document.querySelector(`[${BTN_ATTR}]`);
          if (btn) render(btn);
        });
        sw.append(b);
      }
      kids.push(sw);
    }
    if (mode === 'video') {
      const n = videoItem?.nicheIds?.length || 0;
      kids.push(
        el('div', 'cs-title', 'Save this video'),
        el('div', 'cs-sub', n ? `Saved in ${n} niche${n === 1 ? '' : 's'} · click a niche to add or remove` : 'Choose a niche to save the video in'),
      );
    } else {
      kids.push(
        el('div', 'cs-title', saved ? saved.title : 'Save this channel'),
        el('div', 'cs-sub', saved ? `${fmt(saved.subs)} subscribers · in ${saved.nicheIds.length} niche${saved.nicheIds.length === 1 ? '' : 's'}` : 'Choose a niche to save it in'),
      );
    }
    head.replaceChildren(...kids);
    search.hidden = !niches.length;

    const rows = filtered();
    list.replaceChildren();
    for (const n of rows) {
      const on = activeNicheIds().includes(n.id);
      const row = el('button', `cs-row${on ? ' cs-on' : ''}`);
      row.type = 'button';
      row.disabled = busy;
      const box = el('span', 'cs-box', on ? '✓' : '');
      box.style.setProperty('--c', n.color);
      row.append(box, el('span', 'cs-name', n.title));
      row.addEventListener('click', () => toggleNiche(n.id));
      list.append(row);
    }
    if (lookupError) {
      // Can't reach the extension: say so (and how to fix) instead of "no niches".
      const box = el('div', 'cs-empty cs-err');
      const fix = el('button', 'cs-link', '⟳ Refresh this page');
      fix.type = 'button';
      fix.addEventListener('click', () => location.reload());
      box.append(el('div', null, /reload|updated/i.test(lookupError)
        ? 'Channel Saver was just updated. Refresh this YouTube page to load your niches.'
        : lookupError), fix);
      list.append(box);
    } else if (!niches.length) list.append(el('div', 'cs-empty', 'No niches yet — write the first one below.'));
    else if (!rows.length) {
      // Not there yet: offer to create it straight from the search box.
      const q = search.value.trim();
      const add = el('button', 'cs-row cs-add-row', `＋ Create niche “${q}” and save`);
      add.type = 'button';
      add.disabled = busy;
      add.addEventListener('click', () => {
        input.value = q;
        search.value = '';
        input.form.requestSubmit();
      });
      list.append(add);
    }

    search.disabled = busy || !!lookupError;
    input.disabled = busy || !!lookupError;
    input.form.querySelector('.cs-create').disabled = busy || !!lookupError;
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
    if (currentUrl && (changes.channels || changes.niches || changes.swipe)) refreshState(currentUrl).then(paintMenu);
  });
  // Settings toggles apply right away.
  window.CS?.onFeatures?.(schedule);
  schedule();
})();
