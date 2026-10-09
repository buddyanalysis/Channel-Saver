// Loaded in <head> before the stylesheet paints, so a saved theme never flashes.
// Modes: 'auto' follows Windows/Chrome, 'light' and 'dark' force it.
(() => {
  const MODES = ['auto', 'light', 'dark'];
  const ICON = { auto: '◐', light: '☀', dark: '☾' };
  const LABEL = { auto: 'Theme: Auto (follows your computer)', light: 'Theme: Light', dark: 'Theme: Dark' };

  const read = () => {
    try {
      const m = localStorage.getItem('cs-theme');
      return MODES.includes(m) ? m : 'auto';
    } catch {
      return 'auto';
    }
  };

  const apply = (mode) => {
    if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    const btn = document.getElementById('themeBtn');
    if (btn) {
      btn.textContent = ICON[mode];
      btn.title = `${LABEL[mode]} — click to change`;
      btn.setAttribute('aria-label', LABEL[mode]);
    }
  };

  apply(read());

  document.addEventListener('DOMContentLoaded', () => {
    apply(read());
    document.getElementById('themeBtn')?.addEventListener('click', () => {
      const next = MODES[(MODES.indexOf(read()) + 1) % MODES.length];
      try {
        localStorage.setItem('cs-theme', next);
      } catch {}
      apply(next);
    });
  });
})();
