/**
 * While scrolling Shorts, a small box shows the current Short's numbers and
 * its channel's: when it was uploaded, its views, the channel's typical
 * views, upload count and age. Updates as the URL changes.
 */
(() => {
  const CS = window.CS;
  const { el } = CS;
  let box = null;
  let current = null;
  let dismissed = null; // the Short the user closed the box on

  function remove() {
    box?.remove();
    box = null;
    current = null;
  }

  function row(k, v, cls) {
    const r = el('div', `cs-sb-row${cls ? ` ${cls}` : ''}`);
    r.append(el('span', null, k), el('b', null, v));
    return r;
  }

  async function show(id) {
    current = id;
    if (!box) {
      box = el('div', 'cs-shortsbox');
      document.body.appendChild(box);
    }
    box.replaceChildren(el('div', 'cs-sb-title', 'Channel Saver'), el('div', 'cs-sb-loading', 'Loading…'));
    let v;
    let lite = null;
    try {
      v = await CS.send('videoInfo', { videoId: id });
      if (v.channelId) lite = await CS.lite(`/channel/${v.channelId}`);
    } catch (e) {
      if (current === id) box.replaceChildren(el('div', 'cs-sb-title', 'Channel Saver'), el('div', 'cs-sb-loading', e.message));
      return;
    }
    if (current !== id || !box) return;
    const close = el('button', 'cs-x', '✕');
    close.title = 'Hide (turn off in dashboard Settings)';
    close.addEventListener('click', () => {
      dismissed = current;
      remove();
    });
    const title = el('div', 'cs-sb-title');
    title.append(el('span', null, v.channelName || lite?.title || 'Channel'), close);
    box.replaceChildren(
      title,
      row('Uploaded', v.published ? CS.when(v.published) : '—'),
      row('Views', v.views.toLocaleString()),
      row('Typical views', lite?.medianViews ? `${CS.num(lite.medianViews)}${v.views > lite.medianViews * 3 ? ' · 🔥 outlier' : ''}` : '—', v.views > (lite?.medianViews || Infinity) * 3 ? 'hot' : ''),
      row('Channel uploads', lite?.videoCount != null ? lite.videoCount.toLocaleString() : '—'),
      row('Channel age', lite?.ageDays != null ? (lite.ageDays < 60 ? `${lite.ageDays} days` : lite.ageDays < 730 ? `${Math.round(lite.ageDays / 30.4)} months` : `${(lite.ageDays / 365).toFixed(1)} years`) : '—'),
    );
  }

  CS.onTick(() => {
    if (!CS.features.shorts || CS.page() !== 'shorts') return remove();
    const id = /^\/shorts\/([\w-]{11})/.exec(location.pathname)?.[1];
    if (id && id !== current && id !== dismissed) show(id);
  });
})();
