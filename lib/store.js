/**
 * Library storage. Today it's chrome.storage.local; this module is the only
 * place that knows that, so a hosted/synced backend can replace it later
 * without touching the UI.
 *
 * Shape:
 *   niches:   [{ id, title, color, notes, rpmLow, rpmHigh, pinned, createdAt }]
 *   channels: { [channelId]: { ...youtube data, nicheIds, notes, faceless, tags,
 *                              addedAt, snapshots: [{t, subs, views, videos}], status, error } }
 *
 * Only the background worker writes, and every write goes through `mutate`,
 * which runs one at a time so two quick clicks can't overwrite each other.
 */

const KEYS = ['niches', 'channels', 'settings'];

export async function load() {
  const s = await chrome.storage.local.get(KEYS);
  return {
    niches: s.niches || [],
    channels: s.channels || {},
    settings: { autoRefresh: true, ...(s.settings || {}) },
  };
}

let chain = Promise.resolve();

/** Runs fn(state) exclusively; fn mutates state in place and may return a value. */
export function mutate(fn) {
  const run = chain.then(async () => {
    const state = await load();
    const result = await fn(state);
    await chrome.storage.local.set(state);
    return result;
  });
  chain = run.catch(() => {});
  return run;
}

export const uid = () => crypto.randomUUID();
