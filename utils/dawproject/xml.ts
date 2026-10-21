/**
 * XML minimal pour le format DAWproject (lecture et écriture), sans DOM : il tourne
 * pareil dans le navigateur, dans l'appli Windows et dans les tests (Node).
 *
 * Lecture : éléments, attributs, texte, entités, commentaires, CDATA, déclaration,
 * DOCTYPE ignoré. Les préfixes d'espace de noms sont gardés dans `name` ; `local()`
 * les retire pour comparer.
 */
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text?: string;
}

export const el = (name: string, attrs: Record<string, string | number | boolean | undefined | null> = {}, children: (XmlNode | null | undefined | false)[] = []): XmlNode => {
  const a: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) a[k] = typeof v === 'number' ? fmtNum(v) : String(v);
  return { name, attrs: a, children: children.filter(Boolean) as XmlNode[] };
};

/** Nombre écrit sans perte (relu à l'identique) et sans notation exotique pour les petites valeurs. */
export function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return '0';
  if (Number.isInteger(v)) return String(v);
  const s = String(v);
  if (!/e/i.test(s)) return s;
  // 1e-7 → 0.0000001 (certains lecteurs n'aiment pas l'exposant).
  const fixed = v.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
  return Number(fixed) === v ? fixed : s;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;');

export function writeXml(root: XmlNode): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'];
  const walk = (n: XmlNode, depth: number) => {
    const pad = '  '.repeat(depth);
    const attrs = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
    if (!n.children.length && n.text === undefined) { out.push(`${pad}<${n.name}${attrs}/>`); return; }
    if (!n.children.length) { out.push(`${pad}<${n.name}${attrs}>${esc(n.text || '')}</${n.name}>`); return; }
    out.push(`${pad}<${n.name}${attrs}>`);
    n.children.forEach(c => walk(c, depth + 1));
    out.push(`${pad}</${n.name}>`);
  };
  walk(root, 0);
  return out.join('\n') + '\n';
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unesc = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === '#') { const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(cp) ? String.fromCodePoint(cp) : m; }
  return ENT[e] ?? m;
});

/** Lit un document XML et rend son élément racine. Lève une erreur claire si le fichier n'est pas du XML. */
export function parseXml(src: string): XmlNode {
  let i = 0;
  const n = src.length;
  if (src.charCodeAt(0) === 0xfeff) i = 1;
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  const fail = (msg: string) => { throw new Error(`XML illisible (${msg}, caractère ${i})`); };
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i && stack.length) {
      const t = src.slice(i, lt);
      if (t.trim()) { const top = stack[stack.length - 1]; top.text = (top.text || '') + unesc(t); }
    }
    i = lt;
    if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i + 4); if (e < 0) fail('commentaire non fermé'); i = e + 3; continue; }
    if (src.startsWith('<![CDATA[', i)) {
      const e = src.indexOf(']]>', i + 9); if (e < 0) fail('CDATA non fermé');
      if (stack.length) { const top = stack[stack.length - 1]; top.text = (top.text || '') + src.slice(i + 9, e); }
      i = e + 3; continue;
    }
    if (src.startsWith('<?', i)) { const e = src.indexOf('?>', i + 2); if (e < 0) fail('déclaration non fermée'); i = e + 2; continue; }
    if (src.startsWith('<!', i)) {
      // DOCTYPE (éventuellement avec [ ... ]).
      let depth = 0, j = i + 2;
      for (; j < n; j++) { const c = src[j]; if (c === '[') depth++; else if (c === ']') depth--; else if (c === '>' && depth <= 0) break; }
      i = j + 1; continue;
    }
    if (src[i + 1] === '/') {
      const e = src.indexOf('>', i); if (e < 0) fail('balise fermante');
      const name = src.slice(i + 2, e).trim();
      const top = stack.pop();
      if (!top || top.name !== name) fail(`</${name}> inattendu`);
      i = e + 1;
      if (!stack.length) root = top!;
      continue;
    }
    // Balise ouvrante.
    let j = i + 1;
    while (j < n && !/[\s/>]/.test(src[j])) j++;
    const node: XmlNode = { name: src.slice(i + 1, j), attrs: {}, children: [] };
    if (!node.name) fail('balise sans nom');
    for (;;) {
      while (j < n && /\s/.test(src[j])) j++;
      if (j >= n) fail('balise non fermée');
      if (src[j] === '>') { j++; stack.length ? stack[stack.length - 1].children.push(node) : null; stack.push(node); break; }
      if (src[j] === '/' && src[j + 1] === '>') {
        j += 2;
        if (stack.length) stack[stack.length - 1].children.push(node); else root = node;
        break;
      }
      let k = j;
      while (k < n && !/[\s=/>]/.test(src[k])) k++;
      const an = src.slice(j, k);
      while (k < n && /\s/.test(src[k])) k++;
      if (src[k] !== '=') { node.attrs[an] = ''; j = k; continue; }
      k++;
      while (k < n && /\s/.test(src[k])) k++;
      const q = src[k];
      if (q !== '"' && q !== "'") fail(`attribut ${an} sans guillemets`);
      const e = src.indexOf(q, k + 1);
      if (e < 0) fail(`attribut ${an} non fermé`);
      node.attrs[an] = unesc(src.slice(k + 1, e));
      j = e + 1;
    }
    i = j;
    if (root) break;
  }
  if (!root) {
    if (stack.length) fail(`<${stack[stack.length - 1].name}> non fermé`);
    fail('aucun élément');
  }
  return root!;
}

/** Nom sans préfixe d'espace de noms (« nova:gain » → « gain »). */
export const local = (name: string) => { const k = name.indexOf(':'); return k < 0 ? name : name.slice(k + 1); };
export const kids = (n: XmlNode | null | undefined, name?: string): XmlNode[] => (n ? (name ? n.children.filter(c => local(c.name) === name) : n.children) : []);
export const kid = (n: XmlNode | null | undefined, name: string): XmlNode | null => kids(n, name)[0] || null;
export const num = (n: XmlNode | null | undefined, attr: string, def: number): number => {
  const v = n?.attrs[attr];
  if (v === undefined || v === '') return def;
  const x = Number(v);
  return Number.isFinite(x) ? x : def;
};
export const bool = (n: XmlNode | null | undefined, attr: string, def: boolean): boolean => {
  const v = n?.attrs[attr];
  return v === undefined ? def : v === 'true' || v === '1';
};
