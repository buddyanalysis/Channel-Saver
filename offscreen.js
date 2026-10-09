// Computes the computer fingerprint (+ readable device details) and hands them to the
// background (offscreen pages only have chrome.runtime, not chrome.storage).
import { collectDevice } from './lib/fingerprint.js';

collectDevice()
  .then(({ fp, info }) => chrome.runtime.sendMessage({ type: 'fpResult', fp, info }))
  .catch(() => chrome.runtime.sendMessage({ type: 'fpResult', fp: '' }));
