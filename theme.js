// Loaded in <head> before the stylesheet paints, so a saved theme never flashes.
// Until the button is used the page follows Windows/Chrome ('auto'); one click
// always switches to the opposite of what is on screen (light ⇄ dark).
(() => {
  const MODES = ['auto', 'light', 'dark'];
  const systemDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches;

  const read = () => {
    try {
      const m = localStorage.getItem('cs-theme');
      return MODES.includes(m) ? m : 'auto';
    } catch {
      return 'auto';
    }
  };
  const shown = (mode) => (mode === 'auto' ? (systemDark() ? 'dark' : 'light') : mode);

  const apply = (mode) => {
    if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
    const btn = document.getElementById('themeBtn');
    if (btn) {
      const now = shown(mode);
      btn.textContent = now === 'dark' ? '☀' : '☾';
      const label = now === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
      btn.title = label;
      btn.setAttribute('aria-label', label);
    }
  };

  apply(read());

  document.addEventListener('DOMContentLoaded', () => {
    apply(read());
    document.getElementById('themeBtn')?.addEventListener('click', () => {
      const next = shown(read()) === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem('cs-theme', next);
      } catch {}
      apply(next);
    });
    // While on 'auto', keep the icon right if Windows switches theme.
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => apply(read()));
  });
})();
