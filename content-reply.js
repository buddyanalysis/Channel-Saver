/**
 * Assisted reply: walks you through comments one by one, opens YouTube's own
 * reply box and writes a personalised reply from your templates. YOU press
 * YouTube's Reply button — the extension never posts anything itself, so
 * every reply is a normal reply sent by you.
 *
 * Works on YouTube Studio's Comments page and on the comments under a video.
 */
(() => {
  const CS = window.CS;
  if (!CS) return;
  const { el } = CS;
  const STUDIO = location.hostname === 'studio.youtube.com';

  // Selectors for both UIs; several per item because YouTube renames things.
  const SEL = STUDIO
    ? {
      thread: 'ytcp-comment-thread',
      comment: 'ytcp-comment',
      author: '#author-text, #author-name, .author-name',
      text: '#content-text, #comment-content, .comment-text',
      reply: 'ytcp-comment-button#reply-button, #reply-button, ytcp-button#reply-button, button[aria-label^="Reply"]',
      heart: '#creator-heart-button, ytcp-comment-creator-heart, [aria-label*="heart" i]',
      like: '#like-button, ytcp-comment-toggle-button#like-button, [aria-label^="Like" i]',
      box: 'ytcp-commentbox, ytcp-comment-box',
      input: 'textarea#textarea, tp-yt-iron-autogrow-textarea textarea, #contenteditable-textarea, [contenteditable="true"], textarea',
      submit: 'ytcp-button#submit-button, #submit-button, button[aria-label="Reply"]',
    }
    : {
      thread: 'ytd-comment-thread-renderer',
      comment: 'ytd-comment-view-model, ytd-comment-renderer',
      author: '#author-text, #author-text span, h3 a',
      text: '#content-text',
      reply: '#reply-button-end button, #reply-button-end ytd-button-renderer, ytd-button-renderer#reply-button-end',
      heart: '#creator-heart-button button, #creator-heart-button',
      like: '#like-button button, #like-button',
      box: 'ytd-commentbox',
      input: '#contenteditable-root, [contenteditable="true"]',
      submit: '#submit-button button, #submit-button',
    };

  const pageOn = () => {
    if (CS.features.assistedReply === false) return false;
    if (STUDIO) return /\/comments/.test(location.pathname);
    return CS.page() === 'watch';
  };

  let fab = null;
  let panel = null;
  let queue = []; // threads still to do
  let current = null;
  let done = 0;
  let skipped = 0;
  let watching = null; // interval that waits for YOU to send the reply
  const handled = new WeakSet();
  let cfg = { templates: 'Thank you so much {name}! 🙏\nThanks for watching, {name} ❤️\nGlad you enjoyed it {name}! More coming soon.', heart: true, like: false, auto: true };

  chrome.storage.local.get('replyAssist').then(({ replyAssist }) => {
    if (replyAssist) cfg = { ...cfg, ...replyAssist };
  });
  const saveCfg = () => chrome.storage.local.set({ replyAssist: cfg });

  /* ---------- reading comments ---------- */

  const own = (thread) => thread.querySelector(SEL.comment) || thread;

  function info(thread) {
    const c = own(thread);
    const author = (c.querySelector(SEL.author)?.textContent || '').trim();
    const text = (c.querySelector(SEL.text)?.textContent || '').trim();
    return { author, text };
  }

  /** "@Ali.Khan-92" → "Ali" ; "Sara Ahmed" → "Sara". */
  function firstName(author) {
    const clean = author.replace(/^@/, '').replace(/[-_.\d]+/g, ' ').trim();
    const word = clean.split(/\s+/)[0] || '';
    if (!word || word.length < 2) return 'friend';
    return word.charAt(0).toUpperCase() + word.slice(1);
  }

  function templates() {
    return cfg.templates.split('\n').map((t) => t.trim()).filter(Boolean);
  }

  // Different template than last time, so replies aren't all identical.
  let lastTpl = -1;
  function makeReply(thread) {
    const list = templates();
    if (!list.length) return '';
    let i = Math.floor(Math.random() * list.length);
    if (list.length > 1 && i === lastTpl) i = (i + 1) % list.length;
    lastTpl = i;
    const { author } = info(thread);
    return list[i].replace(/\{name\}/gi, firstName(author));
  }

  function collect() {
    queue = [...document.querySelectorAll(SEL.thread)].filter((t) => !handled.has(t) && CS.visible(t) && info(t).text);
  }

  /* ---------- writing into YouTube's reply box ---------- */

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, ms = 4000) {
    const t = Date.now();
    while (Date.now() - t < ms) {
      const v = fn();
      if (v) return v;
      await wait(120);
    }
    return null;
  }

  function clickable(root, sel) {
    const n = root.querySelector(sel);
    if (!n) return null;
    return n.matches('button') ? n : n.querySelector('button') || n;
  }

  function writeInto(input, text) {
    input.focus();
    if (input.isContentEditable) {
      // insertText goes through the editor's own input handling.
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, text);
      if (!input.textContent.includes(text.slice(0, 5))) {
        input.textContent = text;
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      }
    } else {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  async function fill(thread, text) {
    thread.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await wait(350);
    let box = thread.querySelector(SEL.box);
    if (!box || !CS.visible(box)) {
      const btn = clickable(own(thread), SEL.reply);
      if (!btn) throw new Error('Could not find this comment’s Reply button.');
      btn.click();
      box = await waitFor(() => [...thread.querySelectorAll(SEL.box)].find(CS.visible));
    }
    if (!box) throw new Error('The reply box did not open. Click Reply on the comment yourself, then press “Write reply” again.');
    const input = await waitFor(() => [...box.querySelectorAll(SEL.input)].find((n) => CS.visible(n) || n.isContentEditable));
    if (!input) throw new Error('Could not find the reply text box.');
    writeInto(input, text);
    if (cfg.heart) {
      // Only add a heart; clicking an existing one would remove it.
      const heart = clickable(own(thread), SEL.heart);
      if (heart && heart.getAttribute('aria-pressed') !== 'true' && !own(thread).querySelector('#creator-heart #hearted, [aria-label*="Remove heart" i]')) heart.click();
    }
    if (cfg.like) {
      const like = clickable(own(thread), SEL.like);
      if (like && like.getAttribute('aria-pressed') !== 'true') like.click();
    }
    thread.classList.add('cs-reply-current');
    return box;
  }

  /** Waits for you to press YouTube's Reply: the box empties or closes. */
  function watchForSend(thread, box) {
    clearInterval(watching);
    const started = Date.now();
    // Counts as sent only when YOU press Reply (or the box closes after it),
    // not when you just clear the text.
    let pressed = false;
    box.addEventListener('click', (e) => { if (e.target.closest(SEL.submit)) pressed = true; }, true);
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) pressed = true; }, true);
    watching = setInterval(() => {
      const input = box.querySelector(SEL.input);
      const gone = !box.isConnected || !CS.visible(box);
      const empty = input && (input.value === '' || (input.isContentEditable && !input.textContent.trim()));
      if (Date.now() - started > 800 && pressed && (gone || empty)) {
        clearInterval(watching);
        thread.classList.remove('cs-reply-current');
        thread.classList.add('cs-reply-done');
        handled.add(thread);
        done++;
        current = null;
        if (cfg.auto) setTimeout(next, 900);
        else paint();
      }
    }, 400);
  }

  /* ---------- the flow ---------- */

  async function next() {
    clearInterval(watching);
    collect();
    current = queue[0] || null;
    if (current) current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    paint();
    if (current && cfg.auto && panel) await write();
  }

  async function write() {
    if (!current) return;
    const textBox = panel?.querySelector('.cs-ar-reply');
    const text = textBox?.value?.trim() || makeReply(current);
    try {
      const box = await fill(current, text);
      setStatus('✍ Reply written — check it and press YouTube’s Reply button. The next comment opens after you send.');
      watchForSend(current, box);
    } catch (e) {
      setStatus(e.message, true);
    }
  }

  function skip() {
    if (!current) return;
    handled.add(current);
    current.classList.remove('cs-reply-current');
    skipped++;
    next();
  }

  function setStatus(msg, bad) {
    const s = panel?.querySelector('.cs-ar-status');
    if (s) {
      s.textContent = msg;
      s.classList.toggle('bad', !!bad);
    }
  }

  /* ---------- panel ---------- */

  function openPanel() {
    CS.closePanels();
    panel = el('aside', 'cs-panel cs-ar');
    document.body.appendChild(panel);
    next();
  }

  function closePanel() {
    clearInterval(watching);
    current?.classList.remove('cs-reply-current');
    panel?.remove();
    panel = null;
  }

  function paint() {
    if (!panel?.isConnected) return;
    const head = el('div', 'cs-panel-head');
    const x = el('button', 'cs-x', '✕');
    x.addEventListener('click', closePanel);
    head.append(el('b', null, '💬 Assisted reply'), x);

    const tpl = el('textarea');
    tpl.rows = 4;
    tpl.value = cfg.templates;
    tpl.addEventListener('change', () => {
      cfg.templates = tpl.value;
      saveCfg();
    });
    const opt = (key, label) => {
      const l = el('label', 'cs-ar-opt');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = !!cfg[key];
      cb.addEventListener('change', () => {
        cfg[key] = cb.checked;
        saveCfg();
      });
      l.append(cb, el('span', null, label));
      return l;
    };
    const tplWrap = el('label', 'cs-f');
    tplWrap.append(el('span', null, 'Reply templates — one per line, {name} = commenter’s first name'), tpl);

    const card = el('div', 'cs-ar-card');
    if (current) {
      const { author, text } = info(current);
      const reply = el('textarea', 'cs-ar-reply');
      reply.rows = 3;
      reply.value = makeReply(current);
      const shuffle = el('button', 'cs-btn-s', '🔀 Other text');
      shuffle.addEventListener('click', () => { reply.value = makeReply(current); });
      const writeBtn = el('button', 'cs-btn-p', '✍ Write reply');
      writeBtn.addEventListener('click', write);
      const skipBtn = el('button', 'cs-btn-s', 'Skip ⏭');
      skipBtn.addEventListener('click', skip);
      const btns = el('div', 'cs-row-actions');
      btns.append(writeBtn, shuffle, skipBtn);
      card.append(el('div', 'cs-ar-author', author || 'Comment'), el('div', 'cs-ar-text', text), el('div', 'cs-label', 'Your reply (edit if you like)'), reply, btns);
    } else {
      card.append(el('div', 'cs-ar-text', queue.length ? '' : 'No more loaded comments to reply to. Scroll down to load more, then press “Find comments”.'));
      const again = el('button', 'cs-btn-s', '🔄 Find comments');
      again.addEventListener('click', next);
      card.append(again);
    }

    const info2 = el('div', 'cs-panel-info', `${done} replied · ${skipped} skipped · ${Math.max(0, queue.length - (current ? 1 : 0))} more loaded${STUDIO ? ' · Tip: use Studio’s filter “I haven’t responded”.' : ''}`);
    const status = el('div', 'cs-ar-status', 'You press YouTube’s own Reply button for every reply — nothing is sent automatically. Keep replies personal and varied.');
    const form = el('div', 'cs-form');
    form.append(tplWrap, opt('heart', 'Also give the comment a ❤️ heart'), opt('like', 'Also like the comment 👍'), opt('auto', 'After I send, open the next comment and write its reply'), card, status, info2);
    panel.replaceChildren(head, form);
  }

  function ensureFab() {
    if (!pageOn()) {
      fab?.remove();
      fab = null;
      if (panel) closePanel();
      return;
    }
    if (!document.querySelector(SEL.thread)) {
      fab?.remove();
      fab = null;
      return;
    }
    if (!fab) {
      fab = el('button', 'cs-fab cs-fab-reply', '💬 Assisted reply');
      fab.type = 'button';
      fab.addEventListener('click', () => (panel?.isConnected ? closePanel() : openPanel()));
      document.body.appendChild(fab);
    }
  }

  CS.onTick(ensureFab);
})();
