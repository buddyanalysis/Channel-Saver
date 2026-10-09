/**
 * The "Loading…" pill in the bottom-right corner, shown while Channel Saver is
 * searching or working. Shared by the dashboard and the YouTube pages: every
 * request to the background goes through CSBusy.track(), and long jobs that
 * keep running after their request returned (similar-channel searches) are
 * followed through storage. Quick requests (< 350 ms) never flash it.
 */
(() => {
  if (globalThis.CSBusy) return;

  const LABELS = {
    findSimilar: 'Searching similar channels…',
    searchVideos: 'Searching…',
    add: 'Saving channel…',
    saveVideoToNiche: 'Saving video…',
    saveSwipe: 'Saving…',
    refresh: 'Refreshing…',
    lookup: 'Loading…',
    videoLookup: 'Loading…',
    channelLite: 'Loading stats…',
    channelPopular: 'Loading videos…',
    videoInfo: 'Loading video…',
    fetchImage: 'Loading images…',
    pollCompetitors: 'Checking new uploads…',
    backupNow: 'Backing up…',
    importData: 'Restoring…',
    checkUpdate: 'Checking for updates…',
    ai: 'AI is thinking…',
    aiTest: 'Testing AI key…',
  };
  // Instant bookkeeping requests: never worth a spinner.
  const QUIET = new Set(['saveSettings', 'openDashboard', 'forgetSimilar', 'updateSwipe', 'deleteSwipe', 'setNiche', 'updateChannel', 'createNiche', 'updateNiche', 'deleteNiche', 'restart']);

  const CSS = `
.csb-pill {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
  display: inline-flex; align-items: center; gap: 10px;
  padding: 9px 18px 9px 12px; border-radius: 999px;
  background: #5b3f9e; border: 2px solid #17121f; color: #d9cff5;
  font: 500 15px/1.2 Roboto, "Segoe UI", system-ui, sans-serif; letter-spacing: .2px;
  box-shadow: 0 6px 22px rgba(0, 0, 0, .35);
  opacity: 0; transform: translateY(12px); pointer-events: none;
  transition: opacity .18s ease, transform .18s ease;
}
.csb-pill.on { opacity: 1; transform: none; }
/* Keep clear of the side panel's bottom buttons. */
body:has(.cs-panel) .csb-pill { bottom: 70px; }
.csb-spin {
  width: 18px; height: 18px; border-radius: 50%; flex-shrink: 0;
  background: conic-gradient(#e6defc 0 22%, rgba(230, 222, 252, .38) 22% 100%);
  animation: csb-rot .9s linear infinite;
}
@keyframes csb-rot { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .csb-spin { animation-duration: 2.4s; } }
`;

  const jobs = new Map();
  let seq = 0;
  let pill = null;
  let timer = 0;
  let shown = false;

  function ensure() {
    if (pill?.isConnected) return pill;
    const style = document.createElement('style');
    style.textContent = CSS;
    (document.head || document.documentElement).append(style);
    pill = document.createElement('div');
    pill.className = 'csb-pill';
    pill.setAttribute('role', 'status');
    pill.setAttribute('aria-live', 'polite');
    const spin = document.createElement('span');
    spin.className = 'csb-spin';
    const txt = document.createElement('span');
    txt.className = 'csb-txt';
    pill.append(spin, txt);
    (document.body || document.documentElement).append(pill);
    return pill;
  }

  function paint() {
    clearTimeout(timer);
    if (!jobs.size) {
      pill?.classList.remove('on');
      shown = false;
      return;
    }
    const show = () => {
      if (!jobs.size) return;
      ensure().lastChild.textContent = [...jobs.values()].pop();
      pill.classList.add('on');
      shown = true;
    };
    if (shown) show();
    else timer = setTimeout(show, 350);
  }

  /** Marks work as started; call the returned function when it ends. */
  function start(label = 'Loading…') {
    const id = ++seq;
    jobs.set(id, label);
    paint();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      jobs.delete(id);
      paint();
    };
  }

  /** Shows the pill while a background request is pending. */
  function track(type, promise) {
    if (QUIET.has(type)) return promise;
    const end = start(LABELS[type] || 'Loading…');
    promise.then(end, end);
    return promise;
  }

  // Similar-channel searches keep running in the background after findSimilar returns.
  let simEnd = null;
  function watchSimilar(all) {
    const running = Object.values(all || {}).some((s) => s?.status === 'running' && Date.now() - (s.at || 0) < 15 * 60000);
    if (running && !simEnd) simEnd = start('Searching similar channels…');
    if (!running && simEnd) {
      simEnd();
      simEnd = null;
    }
  }
  try {
    chrome.storage.local.get('similar').then((r) => watchSimilar(r.similar)).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.similar) watchSimilar(changes.similar.newValue);
    });
  } catch {
    /* extension context gone (updated) */
  }

  globalThis.CSBusy = { start, track };
})();
