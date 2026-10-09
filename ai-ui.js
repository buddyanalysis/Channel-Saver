/**
 * Dashboard side of the optional AI: the Settings → AI section and the
 * "🤖 AI" blocks (channel and niche analysis, thumbnail review). The calls
 * themselves run in the background (lib/ai.js) with the user's own key, kept
 * in storage.local.ai — never in backups or exports.
 * Answers are kept in storage.local.aiResults so they survive a reload.
 */
import { PROVIDERS } from './lib/ai.js';

let ctx; // { h, send, toast, fmtNum, fmtAge, fmtDuration, rerender, openSettings }
let cfg = null; // { provider, key, model }
let results = {}; // id → { at, data } | { at, error }
const running = new Set();

export async function initAi(c) {
  ctx = c;
  try {
    const s = await chrome.storage.local.get(['ai', 'aiResults']);
    cfg = s.ai?.key ? s.ai : null;
    results = s.aiResults || {};
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      if (ch.ai) cfg = ch.ai.newValue?.key ? ch.ai.newValue : null;
      if (ch.aiResults) results = ch.aiResults.newValue || {};
    });
  } catch {
    /* no storage (tests) */
  }
}

export const aiReady = () => !!cfg;

function persist() {
  // Keep the newest 60 answers.
  const ids = Object.keys(results).sort((a, b) => (results[b].at || 0) - (results[a].at || 0));
  for (const id of ids.slice(60)) delete results[id];
  chrome.storage.local.set({ aiResults: results }).catch(() => {});
}

async function run(id, task, input) {
  if (running.has(id)) return;
  running.add(id);
  ctx.rerender();
  try {
    // input may be a promise (the thumbnail is shrunk first).
    const data = await ctx.send('ai', { task, input: await input });
    results[id] = { at: Date.now(), data, provider: cfg?.provider };
  } catch (e) {
    results[id] = { at: Date.now(), error: e.message };
  } finally {
    running.delete(id);
    persist();
    ctx.rerender();
  }
}

const copyBtn = (text) => ctx.h('button.icon-btn.ai-copy', { title: 'Copy', onclick: (e) => { e.stopPropagation(); navigator.clipboard.writeText(text).then(() => ctx.toast('Copied')); } }, '⧉');

/** The shared frame: "Add key" hint / button / thinking / answer / error. */
function block({ id, title, intro, button, task, input, view, cls = '' }) {
  const { h } = ctx;
  const r = results[id];
  const go = h('button.btn.ai-go', { onclick: () => run(id, task, typeof input === 'function' ? input() : input) }, button);
  let body;
  if (!cfg) {
    body = h('div.ai-nokey', h('span', '🔑 Add your own AI key to use this — Google Gemini has a free tier. '), h('button.btn.small', { onclick: () => ctx.openSettings('ai') }, 'Settings → AI'));
  } else if (running.has(id)) {
    body = h('div.ai-thinking', h('span.ai-spark', '✨'), h('span', 'AI is thinking… this takes 10–40 seconds.'));
  } else if (r?.data) {
    body = h('div',
      view(r.data),
      h('div.ai-foot', h('span.vm', `${PROVIDERS[r.provider]?.name || 'AI'} · ${ctx.fmtAge((Date.now() - r.at) / 86400000) || 'just now'} · AI can be wrong, use your judgement`),
        h('button.btn.small', { onclick: () => run(id, task, typeof input === 'function' ? input() : input) }, '⟳ Ask again')));
  } else {
    body = h('div', intro ? h('p.vm', intro) : null, r?.error ? h('div.ai-err', r.error) : null, go);
  }
  return h(`div.section.ai-block${cls}`, h('h4', title), body);
}

const list = (items, cls = 'ul.ai-list') => ctx.h(cls, (items || []).map((t) => ctx.h('li', t)));

/* ---------- channel / niche analysis ---------- */

function analysisView(d) {
  const { h } = ctx;
  return h('div.ai-out',
    d.summary ? h('p.ai-lead', d.summary) : null,
    d.format ? h('div.ai-kv', h('b', 'Format'), h('span', d.format)) : null,
    d.difficulty ? h('div.ai-kv', h('b', 'Difficulty'), h('span', d.difficulty)) : null,
    d.topics?.length ? h('div', h('div.ai-sub', 'Topics'), h('div.ai-topics', d.topics.map((t) => h(`span.ai-topic.${/strong/i.test(t.performance) ? 'good' : /weak/i.test(t.performance) ? 'bad' : 'mid'}`, { title: t.evidence || '' }, t.topic)))) : null,
    d.whatWorks?.length ? h('div', h('div.ai-sub', '✅ What works'), list(d.whatWorks)) : null,
    d.gaps?.length ? h('div', h('div.ai-sub', '🕳 Content gaps'), list(d.gaps)) : null,
    d.videoIdeas?.length ? h('div', h('div.ai-sub', '💡 Video ideas'), h('ol.ai-ideas', d.videoIdeas.map((v) => h('li', h('div', h('b', v.title), copyBtn(v.title)), v.why ? h('div.vm', v.why) : null)))) : null);
}

const videoRow = (v, channel) => ({ title: v.title, views: v.views || 0, age: v.ageText || (v.ageDays != null ? `${Math.round(v.ageDays)} days ago` : ''), duration: ctx.fmtDuration(v.duration) || '', outlier: v.x || null, channel });

/** Drawer block for one channel. m = computeMetrics(ch). */
export function aiChannelSection(ch, m) {
  return block({
    id: `ch:${ch.channelId}`,
    title: '🤖 AI niche analysis',
    intro: 'Reads this channel’s videos and explains the format, which topics work, content gaps and 10 video ideas.',
    button: '✨ Analyse with AI',
    task: 'niche',
    input: () => {
      const seen = new Set();
      const vids = [...(m.outliers || []), ...(m.top || []), ...(ch.videos || [])].filter((v) => v.id && !seen.has(v.id) && seen.add(v.id));
      return { name: ch.title, channels: [{ title: ch.title, subs: ctx.fmtNum(ch.subs) }], videos: vids.slice(0, 50).map((v) => videoRow(v)) };
    },
    view: analysisView,
  });
}

/** Niche view block: all channels saved in the niche. */
export function aiNicheSection(niche, channels, metricsOf) {
  return block({
    id: `niche:${niche.id}`,
    title: `🤖 AI analysis of “${niche.title}”`,
    intro: `Looks at the best videos of the ${channels.length} channel${channels.length === 1 ? '' : 's'} in this niche: what works, gaps and video ideas.`,
    button: '✨ Analyse niche with AI',
    task: 'niche',
    cls: '.ai-niche',
    input: () => {
      const per = Math.max(4, Math.floor(56 / Math.max(1, channels.length)));
      const vids = channels.flatMap((ch) => {
        const m = metricsOf(ch);
        const seen = new Set();
        return [...(m.outliers || []), ...(m.top || [])].filter((v) => v.id && !seen.has(v.id) && seen.add(v.id)).slice(0, per).map((v) => videoRow(v, ch.title));
      });
      return { name: niche.title, channels: channels.slice(0, 20).map((c) => ({ title: c.title, subs: ctx.fmtNum(c.subs) })), videos: vids };
    },
    view: analysisView,
  });
}

/* ---------- CTR Tester: AI thumbnail review ---------- */

function thumbView(d) {
  const { h } = ctx;
  const yn = (b) => (b ? '✓' : '✕');
  return h('div.ai-out',
    h('div.ai-score', h('b', `${d.ctrGuess ?? '–'}/10`), h('span', d.why || '')),
    d.firstImpression ? h('p.ai-lead', `👀 ${d.firstImpression}`) : null,
    h('div.ai-kv', h('b', 'Face'), h('span', d.face ? `${yn(d.face.present)} ${d.face.emotion || ''} — ${d.face.comment || ''}` : '—')),
    h('div.ai-kv', h('b', 'Text'), h('span', d.text ? `${d.text.words ? `“${d.text.words}” · ` : ''}${d.text.readableOnPhone ? 'readable on phone' : 'hard to read on phone'} — ${d.text.comment || ''}` : '—')),
    d.subject ? h('div.ai-kv', h('b', 'Subject'), h('span', d.subject)) : null,
    d.curiosity ? h('div.ai-kv', h('b', 'Curiosity'), h('span', d.curiosity)) : null,
    d.titleMatch ? h('div.ai-kv', h('b', 'With title'), h('span', d.titleMatch)) : null,
    d.fixes?.length ? h('div', h('div.ai-sub', '🛠 Fix this first'), list(d.fixes, 'ol.ai-list')) : null,
    d.titleIdeas?.length ? h('div', h('div.ai-sub', '✍ Better titles'), h('ul.ai-titles', d.titleIdeas.map((t) => h('li', h('span', t), copyBtn(t))))) : null);
}

/** Shrinks a thumbnail to 768 px wide before sending: same verdict, a fraction of the cost. */
async function small(dataUrl) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = 768;
  c.height = 432;
  c.getContext('2d').drawImage(img, 0, 0, 768, 432);
  return c.toDataURL('image/jpeg', 0.85);
}

const thumbId = (variant) => `thumb:${variant.image.length}:${variant.image.slice(-40)}:${variant.title || ''}`;

/** The AI review already done for this thumbnail, if any (for “Copy instructions”). */
export const aiThumbAnswer = (variant) => results[thumbId(variant)]?.data || null;

export function aiThumbSection(i, variant, { channel, competitorTitles }) {
  const id = thumbId(variant);
  const b = block({
    id,
    title: '🤖 AI review',
    intro: 'The AI looks at your thumbnail like a viewer: face and emotion, whether the text can be read on a phone, curiosity, and gives better titles.',
    button: '✨ Review with AI',
    task: 'thumbnail',
    input: async () => ({ image: await small(variant.image).catch(() => variant.image), title: variant.title, channel, competitorTitles }),
    view: thumbView,
    cls: '.ai-thumb',
  });
  return b;
}

/* ---------- Settings → AI ---------- */

export function aiSettingsSection(current) {
  const { h } = ctx;
  const c = { provider: 'gemini', key: '', model: '', ...(current || {}) };
  const provider = h('select.input', Object.entries(PROVIDERS).map(([k, p]) => h('option', { value: k }, p.name)));
  provider.value = c.provider;
  const key = h('input.input', { type: 'password', placeholder: 'Paste your API key', autocomplete: 'off', spellcheck: 'false' });
  key.value = c.key;
  const show = h('button.btn.small', { type: 'button', onclick: () => { key.type = key.type === 'password' ? 'text' : 'password'; } }, '👁');
  const model = h('input.input', { placeholder: PROVIDERS[c.provider].model });
  model.value = c.model;
  const link = h('a', { target: '_blank', rel: 'noopener' });
  const note = h('span.vm');
  const status = h('div.ai-test-status');
  const sync = () => {
    const p = PROVIDERS[provider.value];
    model.placeholder = `${p.model} (default)`;
    link.href = p.keyUrl;
    link.textContent = `Get a ${p.name} key ↗`;
    note.textContent = ` ${p.note}`;
  };
  provider.addEventListener('change', sync);
  sync();
  const read = () => ({ provider: provider.value, key: key.value.trim(), model: model.value.trim() });
  const test = h('button.btn.small', { type: 'button', onclick: async () => {
    if (!key.value.trim()) return (status.textContent = 'Paste a key first.');
    status.textContent = 'Testing…';
    status.className = 'ai-test-status';
    try {
      await ctx.send('aiTest', { cfg: read() });
      status.textContent = '✓ Key works';
      status.className = 'ai-test-status ok';
    } catch (e) {
      status.textContent = e.message;
      status.className = 'ai-test-status bad';
    }
  } }, 'Test key');
  const el = h('div.set-group.ai-settings', { id: 'aiSettings' },
    h('div.set-h', '🤖 AI (optional)'),
    h('p.vm', 'Smarter thumbnail reviews, title ideas, niche analysis and reply drafts. Uses your own key: you pay the provider directly (Gemini has a free tier). The key stays on this computer and is never put in backups.'),
    h('label.field', 'Provider', provider),
    h('div.field', h('span', 'API key'), h('div.ai-keyrow', key, show, test)),
    h('div', link, note),
    status,
    h('label.field', 'Model (leave empty for the default)', model),
    current?.key ? h('button.btn.small.danger', { type: 'button', onclick: () => { key.value = ''; status.textContent = 'Key will be removed when you press Save.'; } }, 'Remove key') : null);
  return { el, read };
}
