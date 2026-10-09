/**
 * Share card: a clean picture of a video (thumbnail, title, channel, views)
 * on a background colour of your choice, to download or copy into Discord,
 * X, a doc… Opened from the video page tools or the 📸 on any video tile.
 */
(() => {
  const CS = window.CS;
  const { el } = CS;
  let panel = null;

  const loadImg = (src) => new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = src;
  });

  // Rounded rectangle path.
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function wrap(ctx, text, maxWidth, maxLines) {
    const words = String(text || '').split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = w;
        if (lines.length === maxLines) break;
      } else line = test;
    }
    if (lines.length < maxLines && line) lines.push(line);
    if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
      let last = lines[maxLines - 1];
      while (ctx.measureText(`${last}…`).width > maxWidth && last.length) last = last.slice(0, -1);
      lines[maxLines - 1] = `${last}…`;
    }
    return lines;
  }

  /** Draws the card; bg is a CSS colour or "transparent". */
  async function draw(v, bg, thumbUrl, avatarUrl) {
    const W = 1280;
    const P = bg === 'transparent' ? 0 : 64;
    const TW = W - P * 2;
    const TH = Math.round((TW * 9) / 16);
    const c = el('canvas');
    c.width = W;
    c.height = P + TH + 200 + P;
    const ctx = c.getContext('2d');
    const dark = bg === 'transparent' ? false : isDark(bg);
    if (bg !== 'transparent') {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, c.width, c.height);
    }
    // Card body for transparent backgrounds so the text stays readable anywhere.
    if (bg === 'transparent') {
      ctx.fillStyle = '#ffffff';
      rr(ctx, 0, 0, c.width, c.height, 32);
      ctx.fill();
    }
    const thumb = await loadImg(thumbUrl);
    ctx.save();
    rr(ctx, P, P, TW, TH, 28);
    ctx.clip();
    ctx.drawImage(thumb, P, P, TW, TH);
    ctx.restore();
    if (v.duration) {
      const t = CS.mmss(v.duration);
      ctx.font = '600 30px Roboto, Arial, sans-serif';
      const w = ctx.measureText(t).width + 24;
      ctx.fillStyle = 'rgba(0,0,0,.8)';
      rr(ctx, P + TW - w - 18, P + TH - 58, w, 42, 8);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(t, P + TW - w - 6, P + TH - 26);
    }
    const fg = dark ? '#ffffff' : '#0f0f0f';
    const mut = dark ? 'rgba(255,255,255,.72)' : 'rgba(15,15,15,.62)';
    const top = P + TH + 36;
    let x = P + (bg === 'transparent' ? 24 : 0);
    if (avatarUrl) {
      try {
        const av = await loadImg(avatarUrl);
        ctx.save();
        ctx.beginPath();
        ctx.arc(x + 36, top + 36, 36, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(av, x, top, 72, 72);
        ctx.restore();
        x += 96;
      } catch {
        /* no avatar */
      }
    }
    ctx.fillStyle = fg;
    ctx.font = '600 40px Roboto, Arial, sans-serif';
    const lines = wrap(ctx, v.title, W - x - P - 24, 2);
    lines.forEach((l, i) => ctx.fillText(l, x, top + 36 + i * 50));
    ctx.fillStyle = mut;
    ctx.font = '400 30px Roboto, Arial, sans-serif';
    const sub = [v.channelName, v.views != null ? `${CS.num(v.views)} views` : '', v.ageText].filter(Boolean).join(' • ');
    ctx.fillText(sub, x, top + 36 + lines.length * 50 + 10);
    return c;
  }

  function isDark(color) {
    const probe = el('canvas').getContext('2d');
    probe.fillStyle = color;
    const hex = probe.fillStyle; // normalised "#rrggbb"
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return 0.299 * r + 0.587 * g + 0.114 * b < 140;
  }

  /**
   * v: { id, title, channelName, views, ageText, duration, avatar }
   */
  CS.shareCard = async (v) => {
    CS.closePanels();
    panel = el('aside', 'cs-panel');
    const head = el('div', 'cs-panel-head');
    const close = el('button', 'cs-x', '✕');
    close.addEventListener('click', () => {
      panel?.remove();
      panel = null;
    });
    head.append(el('b', null, 'Share card'), close);
    const preview = el('div', 'cs-share-preview', 'Making the card…');
    const swatches = el('div', 'cs-swatches');
    const colors = [['#ffffff', 'White'], ['#0f0f0f', 'Black'], ['transparent', 'Transparent'], ['#7c3aed', 'Purple'], ['#f1f5f9', 'Grey'], ['#fde68a', 'Yellow']];
    let bg = '#ffffff';
    const custom = el('input');
    custom.type = 'color';
    custom.value = '#2563eb';
    custom.title = 'Any colour';
    let canvas = null;
    let thumbUrl = null;
    let avatarUrl = v.avatar || null;

    async function paint() {
      try {
        if (!thumbUrl) {
          const sizes = ['maxresdefault', 'sddefault', 'hqdefault'].map((s) => `https://i.ytimg.com/vi/${v.id}/${s}.jpg`);
          thumbUrl = (await CS.send('fetchImage', { urls: sizes })).dataUrl;
          if (avatarUrl) avatarUrl = (await CS.send('fetchImage', { urls: [avatarUrl] }).catch(() => null))?.dataUrl || null;
        }
        canvas = await draw(v, bg, thumbUrl, avatarUrl);
        canvas.className = `cs-share-canvas${bg === 'transparent' ? ' checker' : ''}`;
        preview.replaceChildren(canvas);
      } catch (e) {
        preview.textContent = e.message || 'Could not make the card';
      }
    }
    for (const [c, name] of colors) {
      const b = el('button', 'cs-swatch');
      b.title = name;
      b.style.background = c === 'transparent' ? 'repeating-conic-gradient(#ccc 0 25%, #fff 0 50%) 0 0/12px 12px' : c;
      b.addEventListener('click', () => {
        bg = c;
        swatches.querySelectorAll('.cs-swatch').forEach((s) => s.classList.toggle('on', s === b));
        paint();
      });
      if (c === bg) b.classList.add('on');
      swatches.append(b);
    }
    custom.addEventListener('input', () => {
      bg = custom.value;
      swatches.querySelectorAll('.cs-swatch').forEach((s) => s.classList.remove('on'));
      paint();
    });
    swatches.append(custom);
    const blob = () => new Promise((r) => canvas.toBlob(r, 'image/png'));
    const dl = el('button', 'cs-btn-p', '⤓ Download PNG');
    dl.addEventListener('click', async () => {
      if (!canvas) return;
      const url = URL.createObjectURL(await blob());
      const a = el('a');
      a.href = url;
      a.download = `${String(v.title || 'video').replace(/[\\/:*?"<>|]+/g, '').slice(0, 60)}-card.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      CS.toast('Card downloaded');
    });
    const cp = el('button', 'cs-btn-s', '⧉ Copy');
    cp.addEventListener('click', async () => {
      if (!canvas) return;
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': await blob() })]);
        CS.toast('Card copied');
      } catch (e) {
        CS.toast(e.message, true);
      }
    });
    const actions = el('div', 'cs-row-actions');
    actions.append(dl, cp);
    const body = el('div', 'cs-form');
    body.append(el('div', 'cs-label', 'Background'), swatches, preview, actions);
    panel.append(head, body);
    document.body.appendChild(panel);
    paint();
  };
})();
