/**
 * Computer fingerprint ("fp") for activation: lets letrestart.com recognise the same
 * computer even after the extension is reinstalled (the install id changes then).
 * fp = SHA-256 of: WebGL renderer, CPU cores, device memory, screen size, colour depth,
 * timezone and platform. The readable details ("info") are sent too, so the admin panel
 * can show which computer a key is used on — only these, never browsing or YouTube activity.
 * Needs a page (WebGL) — the dashboard or the offscreen document; the service worker can't
 * run it. Nothing here is sent anywhere by itself.
 */
function gpu() {
  try {
    const gl = document.createElement('canvas').getContext('webgl') || document.createElement('canvas').getContext('experimental-webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '') : String(gl?.getParameter(gl.RENDERER) || '');
  } catch {
    return '';
  }
}

/** "Windows 11", "Windows 10", "macOS 14", … from navigator.userAgentData (falls back to the user agent). */
async function osName() {
  const uad = navigator.userAgentData;
  try {
    if (uad?.getHighEntropyValues) {
      const { platform, platformVersion } = await uad.getHighEntropyValues(['platformVersion']);
      const major = parseInt(platformVersion, 10);
      if (platform === 'Windows') return major >= 13 ? 'Windows 11' : major > 0 ? 'Windows 10' : 'Windows';
      if (platform === 'macOS') return `macOS ${String(platformVersion || '').split('.').slice(0, 2).join('.')}`.trim();
      return [platform, platformVersion].filter(Boolean).join(' ');
    }
  } catch {
    /* fall back below */
  }
  const ua = navigator.userAgent;
  if (/Windows/.test(ua)) return 'Windows';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Linux/.test(ua)) return 'Linux';
  return navigator.platform || '';
}

/** { fp, info } — fp is the hash; info the readable details for the admin panel. */
export async function collectDevice() {
  const renderer = gpu();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  const raw = [
    renderer,
    navigator.hardwareConcurrency || '',
    navigator.deviceMemory || '',
    `${screen.width}x${screen.height}`,
    screen.colorDepth || '',
    timezone,
    navigator.platform || '',
  ];
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw.join('|'))));
  const fp = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const info = {
    os: await osName(),
    gpu: renderer,
    cores: navigator.hardwareConcurrency || null,
    memory: navigator.deviceMemory || null,
    screen: `${screen.width}x${screen.height}`,
    language: navigator.language || '',
    timezone,
  };
  return { fp, info };
}

export async function computeFingerprint() {
  return (await collectDevice()).fp;
}
