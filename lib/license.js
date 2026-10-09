/**
 * Activation keys, checked by letrestart.com. The admin makes keys on the
 * website (LR-XXXX-XXXX-XXXX-XXXX). A key works on one device only and its
 * time starts on the day it is activated.
 *
 *   POST https://letrestart.com/?cc=activate  { key, device, fp }  (first time, and on every start / update)
 *   POST https://letrestart.com/?cc=check     { key, device, fp }  (regularly)
 * Body: { key, device, fp, version, info }. device = install id (random, per install); fp = computer
 * fingerprint; version = extension version; info = { os, gpu, cores, memory, screen, language, timezone }
 * for the admin panel (lib/fingerprint.js). Never browsing or YouTube activity.
 *   → { ok: true, name, activatedAt, expiresAt, lifetime }  (unix seconds; expiresAt 0 = lifetime)
 *   → { ok: false, error }   (sent with an HTTP error status, so the body is read regardless)
 *
 * No chrome.* here, so the future website / other tools can reuse it.
 */

export const LICENSE_API = 'https://letrestart.com/';

/** "lr-ab12 cd34-…" → "LR-AB12-CD34-…"; null when it can't be a key. */
export function normalizeKey(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s.startsWith('LR') || s.length < 6) return null;
  const body = s.slice(2);
  return `LR-${body.match(/.{1,4}/g).join('-')}`;
}

const toMs = (t) => (!t ? 0 : t > 1e12 ? t : t * 1000);

function friendly(error) {
  const e = String(error || 'The key was not accepted.');
  if (/another device/i.test(e)) return `${e} One key works on one computer only — ask your admin to reset it if you changed computer.`;
  if (/expired/i.test(e)) return `${e} Ask your admin for a new key.`;
  if (/turned off|disabled|revoked/i.test(e)) return `${e} Contact your admin.`;
  if (/not exist|invalid|not found/i.test(e)) return `${e} Check you copied the whole key (LR-XXXX-XXXX-XXXX-XXXX).`;
  return e;
}

/**
 * Calls the website. Returns { ok, name, activatedAt, expiresAt, lifetime, error }
 * with times in ms, or throws { offline: true } when the site can't be reached.
 */
export async function callLicense(action, key, device, { fp = '', info = null, version = '' } = {}, fetchImpl = fetch) {
  let r;
  try {
    r = await fetchImpl(`${LICENSE_API}?cc=${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, device, fp, version, info }),
      cache: 'no-store',
      credentials: 'omit',
    });
  } catch (err) {
    const e = new Error(`Could not reach letrestart.com: ${err?.message || 'network error'}. Check your internet connection and try again.`);
    e.offline = true;
    throw e;
  }
  const data = await r.json().catch(() => null);
  if (!data || typeof data.ok !== 'boolean') {
    const e = new Error(`letrestart.com answered ${r.status}. Try again in a minute.`);
    e.offline = true; // server trouble, not a verdict on the key
    throw e;
  }
  if (!data.ok) return { ok: false, error: friendly(data.error) };
  return {
    ok: true,
    name: String(data.name || ''),
    activatedAt: toMs(data.activatedAt),
    expiresAt: data.lifetime ? 0 : toMs(data.expiresAt),
    lifetime: !!data.lifetime || !data.expiresAt,
    // Free promo key shared by many people; the server alone decides who may use it.
    promo: data.promo === true,
  };
}

/** Local expiry check between server checks. */
export const isExpired = (lic, now = Date.now()) => !!(lic && !lic.lifetime && lic.expiresAt && now > lic.expiresAt);
