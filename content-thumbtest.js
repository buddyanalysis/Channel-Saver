/**
 * Thumbnail test on the real YouTube page: while a test is running (started
 * from the dashboard's Thumbnail tester), one video tile on Home, Search or
 * Subscriptions shows your thumbnail and title instead, so you see it in your
 * own feed. A small bar lets you move it or stop. Nothing leaves your browser.
 */
(() => {
  const CS = window.CS;
  const { el } = CS;
  let test = null; // { active, image, title, channel, position: 'first'|'random', seed }
  let bar = null;
  let target = null; // the tile currently showing the test
  const PAGES = ['home', 'search', 'subscriptions'];

  chrome.storage.local.get('thumbTest').then(({ thumbTest }) => {
    test = thumbTest || null;
    CS.schedule();
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !ch.thumbTest) return;
    test = ch.thumbTest.newValue || null;
    restore();
    CS.schedule();
  });

  const TILE = 'ytd-rich-item-renderer, ytd-video-renderer';

  function candidates() {
    return [...document.querySelectorAll(TILE)].filter((t) => CS.visible(t) && t.querySelector('a[href*="/watch?v="]') && !t.querySelector('ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer'));
  }

  function restore() {
    if (!target) return;
    for (const [node, prop, value] of target._csOriginal || []) node[prop] = value;
    target.querySelectorAll('.cs-tt-img').forEach((n) => n.remove());
    target.classList.remove('cs-tt-target');
    delete target._csOriginal;
    target = null;
  }

  function apply(tile) {
    const original = [];
    const remember = (node, prop) => node && original.push([node, prop, node[prop]]);
    // Thumbnail: overlay our image on top of YouTube's (its img element is recycled).
    const thumbBox = tile.querySelector('yt-thumbnail-view-model, ytd-thumbnail, a#thumbnail, .yt-lockup-view-model__content-image');
    if (thumbBox) {
      const img = el('img', 'cs-tt-img');
      img.src = test.image;
      img.alt = '';
      if (getComputedStyle(thumbBox).position === 'static') {
        remember(thumbBox.style, 'position');
        thumbBox.style.position = 'relative';
      }
      thumbBox.appendChild(img);
    }
    const titleEl = tile.querySelector('#video-title yt-formatted-string, #video-title, .yt-lockup-metadata-view-model__title span, .yt-lockup-metadata-view-model__title, h3 a');
    if (titleEl) {
      remember(titleEl, 'textContent');
      titleEl.textContent = test.title || 'Your title here';
    }
    const chEl = tile.querySelector('ytd-channel-name #text a, ytd-channel-name #text, .yt-content-metadata-view-model__metadata-text');
    if (chEl && test.channel) {
      remember(chEl, 'textContent');
      chEl.textContent = test.channel;
    }
    tile.classList.add('cs-tt-target');
    tile._csOriginal = original;
    target = tile;
  }

  function ensureBar() {
    if (bar) return;
    bar = el('div', 'cs-tt-bar');
    const label = el('span', null, '🖼 Testing your thumbnail on this page');
    const move = el('button', null, '⟳ Move it');
    move.addEventListener('click', () => {
      chrome.storage.local.set({ thumbTest: { ...test, position: 'random', seed: Math.random() } });
    });
    const first = el('button', null, '⤒ First spot');
    first.addEventListener('click', () => chrome.storage.local.set({ thumbTest: { ...test, position: 'first' } }));
    const mark = el('button', null, 'Show which');
    mark.addEventListener('click', () => {
      target?.classList.add('cs-tt-flash');
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => target?.classList.remove('cs-tt-flash'), 1800);
    });
    const stop = el('button', 'stop', '✕ Stop test');
    stop.addEventListener('click', () => chrome.storage.local.set({ thumbTest: { ...test, active: false } }));
    bar.append(label, move, first, mark, stop);
    document.body.appendChild(bar);
  }

  CS.onTick(() => {
    const on = test?.active && test.image && PAGES.includes(CS.page());
    if (!on) {
      restore();
      bar?.remove();
      bar = null;
      return;
    }
    ensureBar();
    if (target?.isConnected && target.querySelector('.cs-tt-img')) return;
    restore();
    const list = candidates().slice(0, 16);
    if (!list.length) return;
    const pick = test.position === 'random' ? list[Math.floor((test.seed ?? Math.random()) * list.length)] : list[0];
    apply(pick);
  });
})();
