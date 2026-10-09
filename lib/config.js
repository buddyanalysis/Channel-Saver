/**
 * Where Channel Saver looks for new versions.
 *
 * Point this at a small JSON file you host (a GitHub repo works well — use the
 * "Raw" link), shaped like:
 *   { "version": "1.2.0", "download": "https://…/channel-saver.zip", "notes": "What changed" }
 *
 * When "version" is higher than the installed one, the dashboard shows an
 * "Update available" banner with the download link. Leave it empty to turn
 * update checks off.
 *
 * Once the extension is on the Chrome Web Store, Chrome updates it by itself
 * and this check is no longer needed.
 */
export const UPDATE_URL = 'https://raw.githubusercontent.com/buddyanalysis/Channel-Saver/main/version.json';

/** "1.10.0" > "1.9.3" */
export function isNewer(remote, local) {
  const a = String(remote).split('.').map(Number);
  const b = String(local).split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}
