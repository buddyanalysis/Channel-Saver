/**
 * Optional AI. One provider-agnostic entry point (askJson) plus the four
 * tasks the extension uses. No chrome.* in here, so the future web version
 * can reuse it as is; a "server" provider (the website backend holding the
 * key) can be added next to the three vendor APIs without touching callers.
 *
 * Today every user brings their own key (Settings → AI). Nothing is sent
 * anywhere except to the provider the user picked.
 */

export const PROVIDERS = {
  gemini: {
    name: 'Google Gemini',
    model: 'gemini-2.5-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
    note: 'Has a free tier — the easiest way to start.',
    host: 'https://generativelanguage.googleapis.com/*',
  },
  anthropic: {
    name: 'Anthropic Claude',
    model: 'claude-haiku-5-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    note: 'Paid, billed by Anthropic.',
    host: 'https://api.anthropic.com/*',
  },
  openai: {
    name: 'OpenAI',
    model: 'gpt-4.1-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    note: 'Paid, billed by OpenAI.',
    host: 'https://api.openai.com/*',
  },
};

const splitDataUrl = (url) => {
  const m = /^data:([^;]+);base64,(.*)$/.exec(url || '');
  return m ? { mime: m[1], data: m[2] } : null;
};

function friendly(status, body, provider) {
  const msg = body?.error?.message || body?.error?.type || (typeof body?.error === 'string' ? body.error : '') || '';
  if (status === 400 && /api key|API_KEY/i.test(msg)) return 'Your AI key was not accepted. Check it in Settings → AI.';
  if (status === 401 || status === 403) return 'Your AI key was not accepted. Check it in Settings → AI.';
  if (status === 404) return `Model not found at ${PROVIDERS[provider].name}. Change the model name in Settings → AI.`;
  if (status === 429) return 'AI limit reached (free tier or credit). Wait a minute and try again.';
  if (status >= 500) return `${PROVIDERS[provider].name} is busy right now. Try again shortly.`;
  return msg ? `AI error: ${msg.slice(0, 200)}` : `AI error (${status})`;
}

/** Pulls the first JSON object out of a model reply (some wrap it in ``` fences). */
export function parseJson(text) {
  const s = String(text || '');
  try {
    return JSON.parse(s);
  } catch {
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(s.slice(a, b + 1));
      } catch {
        /* fall through */
      }
    }
  }
  throw new Error('The AI answer could not be read. Try again.');
}

/**
 * Sends one prompt (+ optional images as data: URLs) and returns parsed JSON.
 * cfg = { provider, key, model }.
 */
export async function askJson(cfg, { system, prompt, images = [], maxTokens = 1800, fetchImpl = fetch }) {
  const provider = cfg?.provider;
  const p = PROVIDERS[provider];
  if (!p || !cfg.key) throw new Error('Add your AI key first: dashboard → Settings → AI.');
  const model = (cfg.model || '').trim() || p.model;
  const imgs = images.map(splitDataUrl).filter(Boolean);
  let url;
  let headers;
  let body;
  if (provider === 'gemini') {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    headers = { 'content-type': 'application/json', 'x-goog-api-key': cfg.key };
    body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [...imgs.map((i) => ({ inline_data: { mime_type: i.mime, data: i.data } })), { text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.7, maxOutputTokens: maxTokens },
    };
  } else if (provider === 'anthropic') {
    url = 'https://api.anthropic.com/v1/messages';
    headers = {
      'content-type': 'application/json',
      'x-api-key': cfg.key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    body = {
      model,
      max_tokens: maxTokens,
      system: `${system}\nReply with one JSON object only, no other text.`,
      messages: [{ role: 'user', content: [...imgs.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })), { type: 'text', text: prompt }] }],
    };
  } else {
    url = 'https://api.openai.com/v1/chat/completions';
    headers = { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` };
    body = {
      model,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `${system}\nReply with one JSON object only.` },
        { role: 'user', content: [...images.filter((u) => splitDataUrl(u)).map((u) => ({ type: 'image_url', image_url: { url: u } })), { type: 'text', text: prompt }] },
      ],
    };
  }
  let r;
  try {
    r = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch {
    throw new Error(`Could not reach ${p.name}. Check your internet connection.`);
  }
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(friendly(r.status, data, provider));
  let text = '';
  if (provider === 'gemini') text = (data?.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('');
  else if (provider === 'anthropic') text = (data?.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('');
  else text = data?.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('The AI returned an empty answer. Try again.');
  return parseJson(text);
}

/* ---------- the four tasks ---------- */

const SYS = 'You are a senior YouTube strategist who has grown many channels. You give specific, practical advice a creator can act on today. No fluff, no generic tips. Never invent numbers you were not given.';

/** CTR Tester: look at the thumbnail like a viewer would. */
export function thumbnailReview(cfg, { image, title, channel, competitorTitles = [] }) {
  return askJson(cfg, {
    system: SYS,
    images: [image],
    prompt: `Review this YouTube thumbnail for click-through rate.
Planned title: ${title ? `"${title}"` : '(none given)'}
Channel: ${channel || 'unknown'}
It will compete with videos titled:
${competitorTitles.slice(0, 15).map((t) => `- ${t}`).join('\n') || '- (none loaded)'}

Return JSON:
{
 "firstImpression": "what a viewer understands in the first second (1 sentence)",
 "face": { "present": true|false, "emotion": "e.g. shocked / happy / none", "comment": "is it strong enough?" },
 "text": { "words": "the text you can read on the thumbnail, or empty", "readableOnPhone": true|false, "comment": "size / contrast / word count" },
 "subject": "main subject and whether it is clear",
 "curiosity": "does thumbnail + title create a curiosity gap? (1 sentence)",
 "titleMatch": "do thumbnail and title work together without repeating each other?",
 "fixes": ["3 to 5 specific changes, most important first"],
 "ctrGuess": 1-10,
 "why": "one sentence for the score",
 "titleIdeas": ["5 better titles for this same video, max 60 characters each"]
}`,
  });
}

/** Title ideas for a video (on YouTube video pages and in the CTR Tester). */
export function titleIdeas(cfg, { title, channel, views, topTitles = [], description = '' }) {
  return askJson(cfg, {
    system: SYS,
    maxTokens: 1200,
    prompt: `Write title ideas for a NEW video on the same topic as this one (for my own channel, not a copy).
Original title: "${title}"
Original channel: ${channel || 'unknown'}${views ? `, ${views} views` : ''}
${description ? `Description start: ${description.slice(0, 400)}\n` : ''}Best performing titles in this niche:
${topTitles.slice(0, 12).map((t) => `- ${t}`).join('\n') || '- (none)'}

Return JSON:
{ "ideas": [ { "title": "max 60 characters", "angle": "curiosity / number / story / contrast / how-to ... (2-4 words)" } ],
  "thumbnailText": ["3 short thumbnail texts (2-4 words) that pair with the ideas"],
  "tip": "one sentence on what makes titles in this niche get clicks" }
Give 8 ideas, all different angles, in the same language as the original title.`,
  });
}

/** Niche analysis from a channel's (or a niche's) videos. */
export function nicheAnalysis(cfg, { name, channels = [], videos = [] }) {
  const rows = videos.slice(0, 60).map((v) => `- "${v.title}" | ${v.views} views | ${v.age || '?'} | ${v.duration || '?'}${v.outlier ? ` | ${v.outlier.toFixed(1)}x typical` : ''}${v.channel ? ` | ${v.channel}` : ''}`);
  return askJson(cfg, {
    system: SYS,
    maxTokens: 2600,
    prompt: `Analyse this YouTube ${channels.length > 1 ? 'niche' : 'channel'}: ${name}
${channels.length ? `Channels: ${channels.map((c) => `${c.title} (${c.subs} subs)`).join(', ')}\n` : ''}Recent and popular videos (title | views | age | length | outlier | channel):
${rows.join('\n')}

Return JSON:
{
 "summary": "2 sentences: what this is and who watches",
 "format": "the video format/style that is used (length, narration, visuals)",
 "topics": [ { "topic": "...", "performance": "strong / average / weak", "evidence": "which videos show it" } ],
 "whatWorks": ["4-6 patterns in titles, topics or packaging that get views here"],
 "gaps": ["4-6 content gaps: topics or angles with demand that are missing or under-served"],
 "videoIdeas": [ { "title": "max 60 characters", "why": "short reason based on the data" } ],
 "difficulty": "easy / medium / hard to enter, with one reason"
}
Give 10 videoIdeas. Base everything on the videos above.`,
  });
}

/** Assisted reply: a draft the creator reviews and posts themselves. */
export function replyDraft(cfg, { comment, author, videoTitle, channel, tone = 'friendly' }) {
  return askJson(cfg, {
    system: 'You write replies to YouTube comments on behalf of the channel owner. Warm, human, short (1-2 sentences), no hashtags, no links, no emojis spam (max one). Reply in the same language and script as the comment. Never promise things. If the comment is spam or abusive, return an empty reply.',
    maxTokens: 300,
    prompt: `Video: "${videoTitle || ''}"${channel ? ` on ${channel}` : ''}
Comment by ${author || 'a viewer'}: "${comment}"
Tone: ${tone}
Return JSON: { "reply": "..." }`,
  });
}
