/**
 * Similar channels right on YouTube: a side panel (channel pages) or a tab
 * inside the video page's Similar panel. The search runs in the background
 * and writes progress to storage.local.similar, so the list fills in live.
 */
(() => {
  const CS = window.CS;
  const { el } = CS;

  /** The animated "Looking for you…" block shown while a search runs. */
  CS.lookingFor = (stage, done, total) => {
    const box = el('div', 'cs-looking');
    const glass = el('div', 'cs-glass');
    glass.append(el('span', null, '🔍'));
    const txt = el('div', 'cs-looking-txt');
    txt.append(el('b', null, 'Looking for you…'), el('div', 'cs-res-s', stage ? `${stage}${total ? ` · ${done}/${total}` : ''}` : 'Finding channels like this one'));
    box.append(glass, txt);
    if (total) {
      const bar = el('div', 'cs-progress');
      const fill = el('i');
      fill.style.width = `${Math.round((done / total) * 100)}%`;
      bar.append(fill);
      box.append(bar);
    }
    return box;
  };

  /**
   * Runs (or reuses) a similar search for `input` and keeps `box` updated.
   * Returns a stop function that detaches the live updates.
   */
  CS.similarChannelsInto = (box, input, mode = 'quick') => {
    let seedId = null;
    let stopped = false;
    let saved = new Set();

    const row = (r) => {
      const item = el('div', 'cs-sim-row');
      const av = el('div', 'cs-hover-av');
      if (r.avatar) av.style.backgroundImage = `url("${r.avatar}")`;
      const meta = el('div', 'cs-sim-meta');
      const name = el('a', 'cs-sim-name', r.title);
      name.href = r.handle ? `/${r.handle}` : `/channel/${r.channelId}`;
      const bar = el('div', 'cs-sim-bar');
      const fill = el('i');
      fill.style.width = `${r.similarity}%`;
      bar.append(fill);
      meta.append(
        name,
        el('div', 'cs-res-s', [`${CS.num(r.subs)} subs`, r.medianViews ? `${CS.num(r.medianViews)} avg views` : '', r.country].filter(Boolean).join(' · ')),
        el('div', 'cs-res-s', [r.ageDays != null ? `${r.ageDays.toLocaleString()} days old` : '', r.uploadsPerMonth != null ? `${r.uploadsPerMonth}/month` : '', r.lastUpload != null ? `last ${CS.ago(r.lastUpload)}` : ''].filter(Boolean).join(' · ')),
        bar,
        el('div', 'cs-res-s', `${r.similarity}% similar${r.sameLanguage ? '' : ' · other language'}`),
      );
      const acts = el('div', 'cs-sim-acts');
      const isSaved = saved.has(r.channelId);
      const save = el('button', isSaved ? 'cs-btn-s' : 'cs-btn-p', isSaved ? '✓ Saved' : '+ Save');
      save.disabled = isSaved;
      save.addEventListener('click', async () => {
        save.disabled = true;
        save.textContent = 'Saving…';
        try {
          await CS.send('add', { input: r.url || `https://www.youtube.com/channel/${r.channelId}` });
          save.textContent = '✓ Saved';
          save.className = 'cs-btn-s';
          CS.toast(`Saved ${r.title}`);
        } catch (e) {
          save.disabled = false;
          save.textContent = '+ Save';
          CS.toast(e.message, true);
        }
      });
      const more = el('button', 'cs-btn-s', '🔍');
      more.title = 'Find channels like this one';
      more.addEventListener('click', () => CS.similarPanel(r.url || `https://www.youtube.com/channel/${r.channelId}`, r.title));
      acts.append(save, more);
      item.append(av, meta, acts);
      return item;
    };

    function paint(entry) {
      if (stopped) return;
      const kids = [];
      if (!entry || entry.status === 'running') {
        kids.push(CS.lookingFor(entry?.stage, entry?.done, entry?.total));
      } else if (entry.status === 'error') {
        kids.push(el('div', 'cs-panel-info', `Search failed: ${entry.error}`));
      }
      const results = entry?.results || [];
      if (results.length) {
        if (entry.status === 'done') kids.push(el('div', 'cs-panel-info', `${results.length} channels like ${entry.seed?.title || 'this one'} · ${entry.mode === 'deep' ? 'In-depth' : 'Quick'} search`));
        kids.push(...results.map(row));
      } else if (entry?.status === 'done') {
        kids.push(el('div', 'cs-panel-info', 'No similar channels found.'));
      }
      box.replaceChildren(...kids);
    }

    const onChange = (changes, area) => {
      if (area !== 'local') return;
      if (changes.channels) saved = new Set(Object.keys(changes.channels.newValue || {}));
      if (changes.similar && seedId) paint(changes.similar.newValue?.[seedId]);
    };
    chrome.storage.onChanged.addListener(onChange);

    (async () => {
      paint(null);
      const { channels = {} } = await chrome.storage.local.get('channels');
      saved = new Set(Object.keys(channels));
      try {
        const r = await CS.send('findSimilar', { input, mode });
        seedId = r.seedId;
        const { similar = {} } = await chrome.storage.local.get('similar');
        paint(similar[seedId] || null);
      } catch (e) {
        if (!stopped) box.replaceChildren(el('div', 'cs-panel-info', e.message));
      }
    })();

    return () => {
      stopped = true;
      chrome.storage.onChanged.removeListener(onChange);
    };
  };

  /** Side panel with similar channels for a channel (used on channel pages). */
  let stopLive = null;
  CS.similarPanel = (input, title) => {
    CS.closePanels();
    stopLive?.();
    const panel = el('aside', 'cs-panel');
    const head = el('div', 'cs-panel-head');
    const x = el('button', 'cs-x', '✕');
    x.addEventListener('click', () => {
      stopLive?.();
      panel.remove();
    });
    head.append(el('b', null, `🔍 Similar to ${title || 'this channel'}`), x);
    const modes = el('div', 'cs-hover-tabs cs-simv-tabs');
    const body = el('div', 'cs-results cs-sim-list');
    const start = (mode) => {
      stopLive?.();
      qb.classList.toggle('on', mode === 'quick');
      db.classList.toggle('on', mode === 'deep');
      stopLive = CS.similarChannelsInto(body, input, mode);
    };
    const qb = el('button', 'on', '⚡ Quick (20)');
    const db = el('button', null, '🔬 In-depth (40)');
    qb.addEventListener('click', () => start('quick'));
    db.addEventListener('click', () => start('deep'));
    modes.append(qb, db);
    const foot = el('div', 'cs-row-actions');
    const open = el('button', 'cs-btn-s', 'Open in dashboard ↗');
    open.addEventListener('click', () => CS.send('openDashboard', { hash: `#similar=${encodeURIComponent(input)}` }));
    foot.append(open);
    panel.append(head, modes, body, foot);
    document.body.appendChild(panel);
    start('quick');
  };
})();
