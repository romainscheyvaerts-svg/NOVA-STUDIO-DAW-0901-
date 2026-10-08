// Audit UX d'un écran (évalué par qa/parcours_utilisateurs.py dans la page) : cibles tactiles < 40 px
// (zone .nova-hit comprise), textes coupés / hors écran, mots anglais, contrastes WCAG rendus (fond composé).
// Fonction anonyme : page.evaluate(code, { touch, root }) ; root (sélecteur CSS, facultatif) limite l'audit à une zone.
(opts) => {
  const vw = innerWidth, vh = innerHeight, touch = !!opts.touch;
  const root = (opts.root && document.querySelector(opts.root)) || document.body;
  const out = { petits: [], debordements: [], anglais: [], contraste: [] };
  const vis = el => { if (!el.getClientRects().length) return false; const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || +cs.opacity === 0) return false; const r = el.getBoundingClientRect(); return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw && r.width > 1 && r.height > 1; };
  const top = el => { const r = el.getBoundingClientRect(); const x = Math.min(vw - 1, Math.max(0, r.left + r.width / 2)), y = Math.min(vh - 1, Math.max(0, r.top + r.height / 2)); const e = document.elementFromPoint(x, y); return !!e && (e === el || el.contains(e) || e.contains(el)); };
  const lab = el => (el.getAttribute('aria-label') || el.innerText || el.title || el.getAttribute('placeholder') || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 50);
  if (touch) {
    for (const b of root.querySelectorAll('button, [role=button], a[href], select, [role=radio], [role=tab], [role=switch], [role=checkbox], input[type=checkbox]')) {
      if (!vis(b) || !top(b) || b.disabled) continue;
      const tgt = (b.matches('input[type=checkbox], input[type=radio]') && b.closest('label')) || b;
      const r = tgt.getBoundingClientRect(); let w = r.width, h = r.height;
      const a = getComputedStyle(tgt, '::after');
      if (a.content !== 'none' && a.position === 'absolute') {
        const px = v => Math.min(0, parseFloat(v) || 0);
        w -= px(a.left) + px(a.right); h -= px(a.top) + px(a.bottom);
      }
      if (w < 39.5 || h < 39.5) out.petits.push({ t: lab(b), w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) });
    }
  }
  const EN = /(?<![\wÀ-ÿ])(Settings|Loading|Save|Cancel|Delete|Remove|Upload|Download|Browse|Search|Sign in|Sign up|Log ?in|Log ?out|Share|Invite|Join|Guest|Untitled|Error|Failed|Warning|Select|Choose|Empty|Clear|Random|Copy|Paste|Undo|Redo|Record|Steps|Velocity|Edit|Add|New|Open|Close|Apply|Reset|Default|Tracks|Length|Bypass|Threshold|Release|Output|Input|Click|Drag|Drop|Enabled|Disabled|None|Track|Pitch|Shuffle|Grid|Spot|Slip|Send|Sends|Insert|Inserts|Bus|Group|Playlist|Takes?|Comp|Export|Import|Preview|Play|Stop|Pause|Next|Previous|Back|Done|Ok|Yes|No|Free|Upgrade|Subscribe|Welcome|Start|Online|Offline|Connected|Disconnected|Host|Session|Room|Waiting|Sync|Synced|Pending)(?![\wÀ-ÿ])/;
  const OK_FR = /^(Export|Import|Solo|Mix|Master|Clip|Gain|Pan|Bus|BPM|REC|FX|MIDI|Nova|Pro|Sync|Spot|Slip|Grid|Shuffle|Comp|Insert|Inserts|Playlist|Session)$/i;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const seenEn = new Set(), seenC = new Set();
  const parse = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const over = (fg, bg) => [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
  const bgOf = el => { const layers = []; let e = el; let op = 1; while (e && e.nodeType === 1) { const cs = getComputedStyle(e); op *= +cs.opacity; if (cs.backgroundImage && cs.backgroundImage !== 'none' && !/url\(/.test(cs.backgroundImage)) { const m = cs.backgroundImage.match(/rgba?\([^)]+\)/g); if (m) { const cols = m.map(parse); const avg = [0, 1, 2].map(i => cols.reduce((s, c) => s + c[i], 0) / cols.length).concat(cols.reduce((s, c) => s + c[3], 0) / cols.length); layers.push(avg); if (avg[3] >= 0.99) break; } } const c = parse(cs.backgroundColor); if (c && c[3] > 0) { layers.push(c); if (c[3] >= 0.99) break; } e = e.parentElement; } let base = document.documentElement.getAttribute('data-theme') === 'light' ? [255, 255, 255, 1] : [0, 0, 0, 1]; for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base); return { bg: base, op }; };
  let n;
  while ((n = walker.nextNode())) {
    const txt = n.textContent.trim(); if (!txt || txt.length < 2) continue;
    const el = n.parentElement; if (!el || !vis(el)) continue;
    if (el.closest('svg, canvas, script, style, [aria-hidden=true]')) continue;
    const m = txt.match(EN);
    if (m && !OK_FR.test(m[1]) && !seenEn.has(txt)) { seenEn.add(txt); out.anglais.push(txt.slice(0, 60)); }
    if (seenC.has(el)) continue; seenC.add(el);
    const cs = getComputedStyle(el); const fg = parse(cs.color); if (!fg) continue;
    if (el.closest('button:disabled, [aria-disabled=true], input:disabled')) continue;
    const { bg, op } = bgOf(el);
    const fgc = over([fg[0], fg[1], fg[2], fg[3] * op], bg);
    const L1 = lum(fgc), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700; const large = size >= 24 || (bold && size >= 18.66);
    const need = large ? 3 : 4.5;
    if (ratio < need) out.contraste.push({ t: txt.slice(0, 40), ratio: Math.round(ratio * 100) / 100, taille: size, couleur: cs.color, fond: `rgb(${bg.slice(0, 3).map(Math.round).join(',')})` });
  }
  if (document.documentElement.scrollWidth > vw + 1) out.debordements.push({ kind: 'page-hscroll', w: document.documentElement.scrollWidth });
  for (const el of root.querySelectorAll('button, h1, h2, h3, p, span, label, div')) {
    if (el.children.length || !vis(el)) continue;
    const txt = (el.innerText || '').trim(); if (!txt) continue;
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    if (r.right > vw + 2 && r.left < vw) out.debordements.push({ kind: 'hors-ecran', t: txt.slice(0, 40) });
    else if (el.scrollWidth > el.clientWidth + 2 && (cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.textOverflow === 'ellipsis')) out.debordements.push({ kind: 'coupe', t: txt.slice(0, 40), sw: el.scrollWidth, cw: el.clientWidth });
  }
  out.petits = out.petits.slice(0, 40); out.contraste.sort((a, b) => a.ratio - b.ratio); out.contraste = out.contraste.slice(0, 40); out.debordements = out.debordements.slice(0, 30); out.anglais = out.anglais.slice(0, 40);
  return out;
}
