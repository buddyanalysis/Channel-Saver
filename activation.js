/**
 * The activation screen. Until a valid key is entered it covers the whole
 * dashboard (the background refuses requests too, and the YouTube tools stay
 * off). Saved data is never touched: it shows up again the moment a key works.
 */

let state = { ok: false };

export const licenseInfo = () => state;

function overlay(send) {
  document.getElementById('lock')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'lock';
  wrap.innerHTML = `
    <div class="lock-card" role="dialog" aria-labelledby="lockTitle">
      <img src="icons/logo512.png" alt="" width="84" height="84">
      <h1 id="lockTitle">Activate Channel Saver</h1>
      <p class="lock-sub">Enter the activation key you got from your admin.</p>
      <input id="lockKey" class="lock-input" placeholder="LR-XXXX-XXXX-XXXX-XXXX" spellcheck="false" autocomplete="off" maxlength="40">
      <button id="lockGo" class="btn primary">Activate</button>
      <div id="lockMsg" class="lock-msg" role="alert"></div>
      <p class="lock-note">Don’t have a key? Ask the person who gave you Channel Saver.<br>One key works on one computer. Your saved channels and niches are safe — they appear as soon as you activate.</p>
    </div>`;
  document.body.append(wrap);
  const key = wrap.querySelector('#lockKey');
  const go = wrap.querySelector('#lockGo');
  const msg = wrap.querySelector('#lockMsg');
  // Locked after having a key (expired, turned off, other device…): say why.
  if (state.error && state.key) msg.textContent = state.error;
  const activate = async () => {
    if (!key.value.trim()) {
      msg.textContent = 'Paste your key first.';
      key.focus();
      return;
    }
    go.disabled = true;
    go.textContent = 'Checking with letrestart.com…';
    wrap.classList.add('lock-done'); // this screen handles the reload itself
    msg.textContent = '';
    try {
      state = await send('activate', { key: key.value });
      msg.className = 'lock-msg ok';
      msg.textContent = `✓ Activated${state.name ? ` for ${state.name}` : ''}. Loading…`;
      setTimeout(() => location.reload(), 700);
    } catch (e) {
      wrap.classList.remove('lock-done');
      msg.textContent = e.message;
      go.disabled = false;
      go.textContent = 'Activate';
    }
  };
  go.addEventListener('click', activate);
  key.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      activate();
    }
  });
  setTimeout(() => key.focus(), 50);
}

/** Shows the lock screen when not activated. Returns true when activated. */
export async function gate(send) {
  try {
    state = await send('licenseStatus');
  } catch {
    state = { ok: false };
  }
  if (!state.ok) overlay(send);
  // Locks again on its own if the admin switches the key off while the page is open.
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !ch.license) return;
    // Activated from this screen: it shows "✓ Activated" and reloads itself.
    if (document.getElementById('lock')?.classList.contains('lock-done')) return;
    const ok = !!ch.license.newValue?.ok;
    if (ok !== state.ok) location.reload();
  });
  return state.ok;
}
