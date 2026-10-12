/**
 * Compound File Binary (Microsoft Structured Storage, [MS-CFB]) : le conteneur
 * des fichiers AAF. Lecture (secteurs de 512 ou 4096 octets, mini-flux, DIFAT)
 * et écriture (secteurs de 4096 octets par défaut, comme le SDK AAF et Pro Tools).
 *
 * Module pur, sans dépendance : tests/aafCfb.test.ts.
 */

export const FREESECT = 0xffffffff;
export const ENDOFCHAIN = 0xfffffffe;
export const FATSECT = 0xfffffffd;
export const DIFSECT = 0xfffffffc;
export const NOSTREAM = 0xffffffff;

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const MINI_CUTOFF = 4096;
const MINI_SECTOR = 64;

export type CfbEntryType = 'root' | 'storage' | 'stream';

export interface CfbEntry {
  id: number;
  name: string;
  type: CfbEntryType;
  /** CLSID (GUID) au format texte, minuscules (« 0d010101-0101-2f00-060e-2b3402060101 »). */
  clsid: string;
  start: number;
  size: number;
  left: number;
  right: number;
  child: number;
  /** Chemin complet (« /Header-2/Content-3b03 »), racine « / ». */
  path: string;
  /** Enfants (stockages et flux), par nom. */
  children: Map<string, CfbEntry>;
}

export class CfbError extends Error {}

// ── GUID <-> octets (ordre « bytes_le » : 3 premiers champs en petit-boutiste) ──────────
export function guidToBytes(guid: string, out: Uint8Array = new Uint8Array(16), at = 0): Uint8Array {
  const h = guid.replace(/[{}-]/g, '');
  if (h.length !== 32) throw new CfbError(`GUID invalide : ${guid}`);
  const b = (i: number) => parseInt(h.substr(i * 2, 2), 16);
  const order = [3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15];
  for (let i = 0; i < 16; i++) out[at + i] = b(order[i]);
  return out;
}

export function bytesToGuid(bytes: Uint8Array, at = 0): string {
  const order = [3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15];
  const hx = order.map(i => bytes[at + i].toString(16).padStart(2, '0'));
  return `${hx.slice(0, 4).join('')}-${hx.slice(4, 6).join('')}-${hx.slice(6, 8).join('')}-${hx.slice(8, 10).join('')}-${hx.slice(10, 16).join('')}`;
}

const ZERO_GUID = '00000000-0000-0000-0000-000000000000';

/** Ordre des noms d'un même stockage : longueur d'abord, puis majuscules (MS-CFB 2.6.4). */
export function compareNames(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  const A = a.toUpperCase(), B = b.toUpperCase();
  for (let i = 0; i < A.length; i++) {
    const d = A.charCodeAt(i) - B.charCodeAt(i);
    if (d) return d;
  }
  return 0;
}

// ── Lecture ──────────────────────────────────────────────────────────────────────────────
export class CfbReader {
  readonly sectorSize: number;
  /** CLSID de l'en-tête (signature AAF). */
  readonly headerClsid: string;
  readonly entries: CfbEntry[] = [];
  readonly root: CfbEntry;
  private readonly dv: DataView;
  private readonly fat: Uint32Array;
  private miniFat: Uint32Array = new Uint32Array(0);
  private miniStream: Uint8Array = new Uint8Array(0);

  constructor(readonly bytes: Uint8Array) {
    if (bytes.length < 512 || SIGNATURE.some((v, i) => bytes[i] !== v)) {
      throw new CfbError('Ce fichier n’est pas un AAF (conteneur Structured Storage introuvable).');
    }
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const shift = this.dv.getUint16(30, true);
    if (shift !== 9 && shift !== 12) throw new CfbError(`Taille de secteur inattendue (2^${shift}).`);
    this.sectorSize = 1 << shift;
    this.headerClsid = bytesToGuid(bytes, 8);
    const nFat = this.dv.getUint32(44, true);
    const firstDir = this.dv.getUint32(48, true);
    const firstMiniFat = this.dv.getUint32(60, true);
    const nMiniFat = this.dv.getUint32(64, true);
    let difatSector = this.dv.getUint32(68, true);
    const nDifat = this.dv.getUint32(72, true);

    // DIFAT : 109 entrées dans l'en-tête, puis la chaîne DIFAT.
    const fatSectors: number[] = [];
    for (let i = 0; i < 109 && fatSectors.length < nFat; i++) {
      const s = this.dv.getUint32(76 + i * 4, true);
      if (s !== FREESECT) fatSectors.push(s);
    }
    const per = this.sectorSize / 4;
    for (let n = 0; n < nDifat && difatSector < ENDOFCHAIN && fatSectors.length < nFat; n++) {
      const off = this.offsetOf(difatSector);
      for (let i = 0; i < per - 1 && fatSectors.length < nFat; i++) {
        const s = this.dv.getUint32(off + i * 4, true);
        if (s !== FREESECT) fatSectors.push(s);
      }
      difatSector = this.dv.getUint32(off + (per - 1) * 4, true);
    }
    this.fat = new Uint32Array(fatSectors.length * per);
    fatSectors.forEach((s, k) => {
      const off = this.offsetOf(s);
      for (let i = 0; i < per; i++) this.fat[k * per + i] = off + i * 4 + 4 <= bytes.length ? this.dv.getUint32(off + i * 4, true) : FREESECT;
    });

    // Répertoire
    const dir = this.readChain(firstDir, -1);
    const n = Math.floor(dir.length / 128);
    const ddv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
    for (let i = 0; i < n; i++) {
      const o = i * 128;
      const t = dir[o + 66];
      const nameLen = ddv.getUint16(o + 64, true);
      let name = '';
      for (let k = 0; k + 2 < nameLen && k < 64; k += 2) name += String.fromCharCode(ddv.getUint16(o + k, true));
      const type: CfbEntryType | null = t === 5 ? 'root' : t === 1 ? 'storage' : t === 2 ? 'stream' : null;
      const lo = ddv.getUint32(o + 120, true);
      const hi = this.sectorSize === 512 ? 0 : ddv.getUint32(o + 124, true);
      this.entries.push({
        id: i, name, type: type || 'stream', clsid: bytesToGuid(dir, o + 80), start: ddv.getUint32(o + 116, true),
        size: hi * 4294967296 + lo, left: ddv.getUint32(o + 68, true), right: ddv.getUint32(o + 72, true), child: ddv.getUint32(o + 76, true),
        path: '', children: new Map(),
      });
      if (!type) this.entries[i].type = 'stream', (this.entries[i] as any).unused = true;
    }
    if (!this.entries.length || this.entries[0].type !== 'root') throw new CfbError('Répertoire du fichier AAF illisible.');
    this.root = this.entries[0];
    this.root.path = '/';

    // Mini-flux (dans le flux de l'entrée racine) et mini-FAT
    if (this.root.size > 0 && this.root.start < ENDOFCHAIN) this.miniStream = this.readChain(this.root.start, this.root.size);
    if (nMiniFat > 0 && firstMiniFat < ENDOFCHAIN) {
      const mf = this.readChain(firstMiniFat, -1);
      this.miniFat = new Uint32Array(mf.length / 4);
      const mdv = new DataView(mf.buffer, mf.byteOffset, mf.byteLength);
      for (let i = 0; i < this.miniFat.length; i++) this.miniFat[i] = mdv.getUint32(i * 4, true);
    }

    // Arborescence : chaque stockage range ses enfants dans un arbre (gauche / droite).
    const seen = new Set<number>();
    const walk = (parent: CfbEntry) => {
      const stack = parent.child !== NOSTREAM ? [parent.child] : [];
      while (stack.length) {
        const id = stack.pop()!;
        if (id === NOSTREAM || id >= this.entries.length || seen.has(id)) continue;
        seen.add(id);
        const e = this.entries[id];
        if ((e as any).unused) continue;
        e.path = parent.path === '/' ? `/${e.name}` : `${parent.path}/${e.name}`;
        parent.children.set(e.name, e);
        stack.push(e.left, e.right);
        if (e.type === 'storage') walk(e);
      }
    };
    seen.add(0);
    walk(this.root);
  }

  private offsetOf(sector: number): number {
    return (sector + 1) * this.sectorSize;
  }

  /** Chaîne de secteurs (FAT). `size` < 0 : toute la chaîne. */
  private readChain(start: number, size: number): Uint8Array {
    const parts: number[] = [];
    let s = start;
    const max = this.fat.length + 1;
    while (s < ENDOFCHAIN && parts.length < max) {
      parts.push(s);
      if (s >= this.fat.length) break;
      s = this.fat[s];
    }
    const total = size >= 0 ? size : parts.length * this.sectorSize;
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      if (at >= total) break;
      const off = this.offsetOf(p);
      const n = Math.min(this.sectorSize, total - at, Math.max(0, this.bytes.length - off));
      out.set(this.bytes.subarray(off, off + n), at);
      at += this.sectorSize;
    }
    if (size >= 0 && at < size) throw new CfbError('Fichier AAF tronqué : un flux dépasse la fin du fichier.');
    return out;
  }

  private readMini(start: number, size: number): Uint8Array {
    const out = new Uint8Array(size);
    let s = start, at = 0, guard = 0;
    while (at < size && s < ENDOFCHAIN && guard++ <= this.miniFat.length) {
      const off = s * MINI_SECTOR;
      const n = Math.min(MINI_SECTOR, size - at);
      out.set(this.miniStream.subarray(off, off + n), at);
      at += n;
      s = this.miniFat[s];
    }
    if (at < size) throw new CfbError('Fichier AAF abîmé : mini-flux incomplet.');
    return out;
  }

  /** Contenu d'un flux. */
  read(e: CfbEntry): Uint8Array {
    if (e.type !== 'stream') throw new CfbError(`« ${e.path} » n'est pas un flux.`);
    if (e.size === 0) return new Uint8Array(0);
    return e.size < MINI_CUTOFF ? this.readMini(e.start, e.size) : this.readChain(e.start, e.size);
  }

  find(path: string): CfbEntry | null {
    if (path === '/' || path === '') return this.root;
    let cur: CfbEntry | undefined = this.root;
    for (const part of path.split('/').filter(Boolean)) {
      cur = cur.children.get(part);
      if (!cur) return null;
    }
    return cur;
  }
}

// ── Écriture ─────────────────────────────────────────────────────────────────────────────
export interface CfbNodeIn {
  /** Chemin (« /Header-2/properties »). Les stockages intermédiaires sont créés au besoin. */
  path: string;
  /** Flux : son contenu. Absent : stockage. */
  data?: Uint8Array;
  clsid?: string;
}

interface WNode {
  name: string;
  type: CfbEntryType;
  clsid: string;
  data: Uint8Array | null;
  children: WNode[];
  id: number;
  left: number;
  right: number;
  child: number;
  red: boolean;
  start: number;
}

/**
 * Écrit un fichier CFB. `rootClsid` : CLSID de l'entrée racine (classe Root de l'AAF) ;
 * `headerClsid` : CLSID de l'en-tête (signature du type de fichier AAF).
 * `sectorSize` : 4096 (version 4, comme le SDK AAF) ou 512 (version 3).
 */
export function writeCfb(nodes: CfbNodeIn[], opts: { rootClsid?: string; headerClsid?: string; sectorSize?: 512 | 4096 } = {}): Uint8Array {
  const ss = opts.sectorSize ?? 4096;
  const root: WNode = { name: 'Root Entry', type: 'root', clsid: opts.rootClsid || ZERO_GUID, data: null, children: [], id: 0, left: NOSTREAM, right: NOSTREAM, child: NOSTREAM, red: false, start: ENDOFCHAIN };
  const byPath = new Map<string, WNode>([['/', root]]);
  const ensure = (path: string): WNode => {
    const got = byPath.get(path);
    if (got) return got;
    const i = path.lastIndexOf('/');
    const parent = ensure(i <= 0 ? '/' : path.slice(0, i));
    const name = path.slice(i + 1);
    if (name.length > 31) throw new CfbError(`Nom trop long dans le fichier AAF : ${name}`);
    const n: WNode = { name, type: 'storage', clsid: ZERO_GUID, data: null, children: [], id: -1, left: NOSTREAM, right: NOSTREAM, child: NOSTREAM, red: false, start: ENDOFCHAIN };
    parent.children.push(n);
    byPath.set(path, n);
    return n;
  };
  for (const nd of nodes) {
    const n = ensure(nd.path === '/' ? '/' : nd.path.replace(/\/+$/, ''));
    if (nd.data) { n.type = n === root ? 'root' : 'stream'; n.data = nd.data; }
    if (nd.clsid) n.clsid = nd.clsid;
  }
  if (nodes.find(n => n.path === '/')?.clsid) root.clsid = nodes.find(n => n.path === '/')!.clsid!;

  // Identifiants (parcours en largeur) et arbres équilibrés rouge-noir par stockage.
  const all: WNode[] = [root];
  for (let i = 0; i < all.length; i++) {
    const n = all[i];
    n.id = i;
    n.children.sort((a, b) => compareNames(a.name, b.name));
    for (let k = 1; k < n.children.length; k++) {
      if (compareNames(n.children[k - 1].name, n.children[k].name) === 0) throw new CfbError(`Nom en double : ${n.children[k].name}`);
    }
    all.push(...n.children);
  }
  for (const n of all) {
    if (!n.children.length) continue;
    const kids = n.children;
    let maxDepth = 0;
    const build = (lo: number, hi: number, depth: number): number => {
      if (lo > hi) return NOSTREAM;
      const mid = (lo + hi) >> 1;
      const k = kids[mid];
      maxDepth = Math.max(maxDepth, depth);
      (k as any).depth = depth;
      k.left = build(lo, mid - 1, depth + 1);
      k.right = build(mid + 1, hi, depth + 1);
      return k.id;
    };
    n.child = build(0, kids.length - 1, 0);
    // Dernier niveau incomplet en rouge, le reste en noir : arbre rouge-noir valide.
    const full = ((kids.length + 1) & kids.length) === 0;
    for (const k of kids) k.red = !full && (k as any).depth === maxDepth;
  }

  // Flux : petits (< 4096) dans le mini-flux, les autres en secteurs normaux.
  const streams = all.filter(n => n.type === 'stream');
  const small = streams.filter(n => n.data!.length > 0 && n.data!.length < MINI_CUTOFF);
  const big = streams.filter(n => n.data!.length >= MINI_CUTOFF);
  let miniLen = 0;
  const miniChain: number[] = [];
  for (const n of small) {
    const cnt = Math.ceil(n.data!.length / MINI_SECTOR);
    n.start = miniLen / MINI_SECTOR;
    for (let i = 0; i < cnt; i++) miniChain.push(i === cnt - 1 ? ENDOFCHAIN : n.start + i + 1);
    miniLen += cnt * MINI_SECTOR;
  }
  const secs = (len: number) => Math.ceil(len / ss);
  const per = ss / 4;
  let next = 0;
  const fatEntries: number[] = [];
  const alloc = (count: number): number => {
    if (!count) return ENDOFCHAIN;
    const start = next;
    for (let i = 0; i < count; i++) fatEntries.push(i === count - 1 ? ENDOFCHAIN : start + i + 1);
    next += count;
    return start;
  };
  for (const n of big) n.start = alloc(secs(n.data!.length));
  root.start = alloc(secs(miniLen));
  const miniFatSecs = secs(miniChain.length * 4);
  const miniFatStart = alloc(miniFatSecs);
  const dirSecs = secs(all.length * 128);
  const dirStart = alloc(dirSecs);
  // FAT et DIFAT : se couvrent elles-mêmes, on itère jusqu'à stabilité.
  let nFat = 0, nDifat = 0;
  for (;;) {
    const total = next + nFat + nDifat;
    const f = Math.ceil(total / per);
    const d = f > 109 ? Math.ceil((f - 109) / (per - 1)) : 0;
    if (f === nFat && d === nDifat) break;
    nFat = f; nDifat = d;
  }
  const fatStart = next;
  for (let i = 0; i < nFat; i++) fatEntries.push(FATSECT);
  const difatStart = next + nFat;
  for (let i = 0; i < nDifat; i++) fatEntries.push(DIFSECT);
  const totalSecs = next + nFat + nDifat;
  while (fatEntries.length < nFat * per) fatEntries.push(FREESECT);

  const out = new Uint8Array((totalSecs + 1) * ss);
  const dv = new DataView(out.buffer);
  const sec = (s: number) => (s + 1) * ss;
  // En-tête
  SIGNATURE.forEach((v, i) => (out[i] = v));
  if (opts.headerClsid) guidToBytes(opts.headerClsid, out, 8);
  dv.setUint16(24, 0x003e, true);
  dv.setUint16(26, ss === 4096 ? 4 : 3, true);
  dv.setUint16(28, 0xfffe, true);
  dv.setUint16(30, ss === 4096 ? 12 : 9, true);
  dv.setUint16(32, 6, true);
  dv.setUint32(40, ss === 4096 ? dirSecs : 0, true);
  dv.setUint32(44, nFat, true);
  dv.setUint32(48, dirStart, true);
  dv.setUint32(56, MINI_CUTOFF, true);
  dv.setUint32(60, miniFatSecs ? miniFatStart : ENDOFCHAIN, true);
  dv.setUint32(64, miniFatSecs, true);
  dv.setUint32(68, nDifat ? difatStart : ENDOFCHAIN, true);
  dv.setUint32(72, nDifat, true);
  for (let i = 0; i < 109; i++) dv.setUint32(76 + i * 4, i < nFat ? fatStart + i : FREESECT, true);
  // DIFAT
  for (let d = 0; d < nDifat; d++) {
    const off = sec(difatStart + d);
    for (let i = 0; i < per - 1; i++) {
      const k = 109 + d * (per - 1) + i;
      dv.setUint32(off + i * 4, k < nFat ? fatStart + k : FREESECT, true);
    }
    dv.setUint32(off + (per - 1) * 4, d === nDifat - 1 ? ENDOFCHAIN : difatStart + d + 1, true);
  }
  // FAT
  for (let i = 0; i < fatEntries.length; i++) dv.setUint32(sec(fatStart) + i * 4, fatEntries[i], true);
  // Flux
  for (const n of big) out.set(n.data!, sec(n.start));
  if (miniLen) {
    const ms = new Uint8Array(miniLen);
    for (const n of small) ms.set(n.data!, n.start * MINI_SECTOR);
    out.set(ms, sec(root.start));
  }
  for (let i = 0; i < miniChain.length; i++) dv.setUint32(sec(miniFatStart) + i * 4, miniChain[i], true);
  for (let i = miniChain.length; i < miniFatSecs * per; i++) dv.setUint32(sec(miniFatStart) + i * 4, FREESECT, true);
  // Répertoire (entrées libres complétées à la fin du dernier secteur)
  const dirOff = sec(dirStart);
  for (let i = 0; i < dirSecs * (ss / 128); i++) {
    const o = dirOff + i * 128;
    const n = all[i];
    if (!n) {
      dv.setUint32(o + 68, NOSTREAM, true); dv.setUint32(o + 72, NOSTREAM, true); dv.setUint32(o + 76, NOSTREAM, true);
      continue;
    }
    for (let k = 0; k < n.name.length; k++) dv.setUint16(o + k * 2, n.name.charCodeAt(k), true);
    dv.setUint16(o + 64, (n.name.length + 1) * 2, true);
    out[o + 66] = n.type === 'root' ? 5 : n.type === 'storage' ? 1 : 2;
    out[o + 67] = n.red ? 0 : 1;
    dv.setUint32(o + 68, n.left, true);
    dv.setUint32(o + 72, n.right, true);
    dv.setUint32(o + 76, n.child, true);
    if (n.type !== 'stream') guidToBytes(n.clsid, out, o + 80);
    const size = n.type === 'root' ? miniLen : n.type === 'stream' ? n.data!.length : 0;
    const start = n.type === 'storage' || size === 0 ? (n.type === 'storage' ? 0 : ENDOFCHAIN) : n.start;
    dv.setUint32(o + 116, start, true);
    dv.setUint32(o + 120, size % 4294967296, true);
    dv.setUint32(o + 124, Math.floor(size / 4294967296), true);
  }
  return out;
}
