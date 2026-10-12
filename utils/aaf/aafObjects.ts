/**
 * Objets AAF dans le conteneur CFB (« AAF Low-Level Container Specification ») :
 * chaque objet est un stockage dont la classe est le CLSID de l'entrée et dont les
 * propriétés sont dans le flux « properties » :
 *   octet d'ordre (0x4c, petit-boutiste), version, nombre d'entrées (u16),
 *   puis (pid u16, forme u16, taille u16) × n, puis les valeurs.
 * Formes de stockage : donnée, flux, référence forte (stockage enfant), vecteur et
 * ensemble de références fortes (flux « <nom> index » + stockages « <nom>{n} »),
 * références faibles (clé de l'objet visé).
 *
 * Lecture : AafObject (paresseux). Écriture : WObj → nœuds CFB (writeObjects).
 * Module pur : tests/aafRead.test.ts, tests/aafWrite.test.ts.
 */
import { bytesToGuid, CfbEntry, CfbNodeIn, CfbReader, guidToBytes } from './cfb';

export const SF_DATA = 0x82;
export const SF_DATA_STREAM = 0x42;
export const SF_STRONG_REF = 0x22;
export const SF_STRONG_REF_VECTOR = 0x32;
export const SF_STRONG_REF_SET = 0x3a;
export const SF_WEAK_REF = 0x02;
export const SF_WEAK_REF_VECTOR = 0x12;
export const SF_WEAK_REF_SET = 0x1a;

export interface RawProp { pid: number; form: number; data: Uint8Array }

// ── Valeurs ──────────────────────────────────────────────────────────────────────────────
const dvOf = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

export function utf16(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) {
    const c = b[i] | (b[i + 1] << 8);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

export function encodeUtf16(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2 + 2);
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out[i * 2] = c & 0xff; out[i * 2 + 1] = c >> 8; }
  return out;
}

export const hex = (b: Uint8Array): string => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

export function readInt(b: Uint8Array): number {
  const dv = dvOf(b);
  switch (b.length) {
    case 1: return dv.getInt8(0);
    case 2: return dv.getInt16(0, true);
    case 4: return dv.getInt32(0, true);
    case 8: return Number(dv.getBigInt64(0, true));
    default: return 0;
  }
}
export function readUint(b: Uint8Array): number {
  const dv = dvOf(b);
  switch (b.length) {
    case 1: return dv.getUint8(0);
    case 2: return dv.getUint16(0, true);
    case 4: return dv.getUint32(0, true);
    case 8: return Number(dv.getBigUint64(0, true));
    default: return 0;
  }
}

export interface Rational { num: number; den: number }
export const readRational = (b: Uint8Array, at = 0): Rational => {
  const dv = dvOf(b);
  return { num: dv.getInt32(at, true), den: dv.getInt32(at + 4, true) };
};
export const ratValue = (r: Rational): number => (r.den ? r.num / r.den : 0);

/** Valeur indirecte : ordre (0x4c) + AUID du type + valeur. */
export interface IndirectValue { type: string; bytes: Uint8Array }
export const readIndirect = (b: Uint8Array): IndirectValue | null =>
  b.length >= 17 ? { type: bytesToGuid(b, 1), bytes: b.subarray(17) } : null;

// Types courants des valeurs indirectes.
export const TYPE_RATIONAL = '03010100-0000-0000-060e-2b3401040101';
export const TYPE_INT32 = '01010700-0000-0000-060e-2b3401040101';
export const TYPE_UINT32 = '01010300-0000-0000-060e-2b3401040101';
export const TYPE_INT64 = '01010800-0000-0000-060e-2b3401040101';
export const TYPE_INT16 = '01010600-0000-0000-060e-2b3401040101';
export const TYPE_STRING = '01100200-0000-0000-060e-2b3401040101';

/** Nombre porté par une valeur indirecte (rationnel, entier…). */
export function indirectNumber(v: IndirectValue | null): number | null {
  if (!v) return null;
  if (v.type === TYPE_RATIONAL && v.bytes.length >= 8) return ratValue(readRational(v.bytes));
  if ((v.type === TYPE_INT32 || v.type === TYPE_INT16 || v.type === TYPE_INT64) && v.bytes.length) return readInt(v.bytes);
  if (v.type === TYPE_UINT32 && v.bytes.length) return readUint(v.bytes);
  return null;
}

// ── Lecture des objets ───────────────────────────────────────────────────────────────────
export class AafFile {
  private cache = new Map<string, AafObject>();
  constructor(readonly cfb: CfbReader) {}

  object(entry: CfbEntry): AafObject {
    let o = this.cache.get(entry.path);
    if (!o) { o = new AafObject(this, entry); this.cache.set(entry.path, o); }
    return o;
  }

  root(): AafObject { return this.object(this.cfb.root); }
}

export class AafObject {
  readonly classId: string;
  readonly props = new Map<number, RawProp>();

  constructor(readonly file: AafFile, readonly entry: CfbEntry) {
    this.classId = entry.clsid;
    const ps = entry.children.get('properties');
    if (!ps) return;
    const b = file.cfb.read(ps);
    if (b.length < 4 || b[0] !== 0x4c) return;
    const dv = dvOf(b);
    const n = dv.getUint16(2, true);
    let at = 4 + n * 6;
    for (let i = 0; i < n; i++) {
      const pid = dv.getUint16(4 + i * 6, true);
      const form = dv.getUint16(6 + i * 6, true);
      const size = dv.getUint16(8 + i * 6, true);
      this.props.set(pid, { pid, form, data: b.subarray(at, at + size) });
      at += size;
    }
  }

  has(pid: number): boolean { return this.props.has(pid); }
  data(pid: number): Uint8Array | null { return this.props.get(pid)?.data ?? null; }
  int(pid: number, dflt = 0): number { const d = this.data(pid); return d && d.length ? readInt(d) : dflt; }
  uint(pid: number, dflt = 0): number { const d = this.data(pid); return d && d.length ? readUint(d) : dflt; }
  string(pid: number): string | null { const d = this.data(pid); return d ? utf16(d) : null; }
  rational(pid: number): Rational | null { const d = this.data(pid); return d && d.length >= 8 ? readRational(d) : null; }
  auid(pid: number): string | null { const d = this.data(pid); return d && d.length >= 16 ? bytesToGuid(d) : null; }
  /** Identifiant de mob (UMID, 32 octets), en hexadécimal. */
  mobId(pid: number): string | null { const d = this.data(pid); return d && d.length >= 32 ? hex(d.subarray(0, 32)) : null; }
  indirect(pid: number): IndirectValue | null { const d = this.data(pid); return d ? readIndirect(d) : null; }

  private child(name: string): AafObject | null {
    const e = this.entry.children.get(name);
    return e && e.type === 'storage' ? this.file.object(e) : null;
  }

  strongRef(pid: number): AafObject | null {
    const p = this.props.get(pid);
    if (!p || p.form !== SF_STRONG_REF) return null;
    return this.child(utf16(p.data));
  }

  /** Vecteur ou ensemble de références fortes, dans l'ordre de l'index. */
  strongRefs(pid: number): AafObject[] {
    const p = this.props.get(pid);
    if (!p || (p.form !== SF_STRONG_REF_VECTOR && p.form !== SF_STRONG_REF_SET)) return [];
    const name = utf16(p.data);
    const idx = this.entry.children.get(`${name} index`);
    if (!idx) return [];
    const b = this.file.cfb.read(idx);
    const dv = dvOf(b);
    const count = dv.getUint32(0, true);
    const out: AafObject[] = [];
    if (p.form === SF_STRONG_REF_VECTOR) {
      for (let i = 0; i < count && 12 + i * 4 + 4 <= b.length; i++) {
        const o = this.child(`${name}{${dv.getUint32(12 + i * 4, true).toString(16)}}`);
        if (o) out.push(o);
      }
    } else {
      const keySize = b[14];
      const stride = 8 + keySize;
      for (let i = 0; i < count && 15 + i * stride + 4 <= b.length; i++) {
        const o = this.child(`${name}{${dv.getUint32(15 + i * stride, true).toString(16)}}`);
        if (o) out.push(o);
      }
    }
    return out;
  }

  /** Clé de l'objet visé par une référence faible (AUID ou UMID). */
  weakRefKey(pid: number): string | null {
    const p = this.props.get(pid);
    if (!p || p.data.length < 5) return null;
    const size = p.data[4];
    const key = p.data.subarray(5, 5 + size);
    return size === 16 ? bytesToGuid(key) : hex(key);
  }

  /** Flux de données (essence intégrée…). */
  stream(pid: number): Uint8Array | null {
    const p = this.props.get(pid);
    if (!p || p.form !== SF_DATA_STREAM || p.data.length < 3) return null;
    const e = this.entry.children.get(utf16(p.data.subarray(1)));
    return e && e.type === 'stream' ? this.file.cfb.read(e) : null;
  }
}

// ── Écriture des objets ──────────────────────────────────────────────────────────────────
export type WProp =
  | { pid: number; form: typeof SF_DATA; data: Uint8Array }
  /** obj absent : stockage écrit à part (partie fixe du modèle). */
  | { pid: number; form: typeof SF_STRONG_REF; name: string; obj?: WObj }
  | { pid: number; form: typeof SF_STRONG_REF_VECTOR; name: string; objs: WObj[] }
  | { pid: number; form: typeof SF_STRONG_REF_SET; name: string; objs: WObj[]; keyPid: number; keySize: 16 | 32; keyOf: (o: WObj) => Uint8Array }
  | { pid: number; form: typeof SF_WEAK_REF; data: Uint8Array }
  | { pid: number; form: typeof SF_WEAK_REF_VECTOR | typeof SF_WEAK_REF_SET; name: string; weakIndex: number; keyPid: number; keySize: 16 | 32; keys: Uint8Array[] }
  | { pid: number; form: typeof SF_DATA_STREAM; name: string; bytes: Uint8Array };

export interface WObj { classId: string; props: WProp[] }

/** Nom de stockage d'une propriété (« Mobs-1901 »), comme le SDK AAF et pyaaf2. */
export function mangleName(name: string, pid: number, size: number): string {
  const p = pid.toString(16);
  const max = size - p.length - 2;
  let n = name;
  if (n.length > max) {
    const half = max >> 1;
    let s = '';
    for (let i = 0; i < max; i++) s += i < half ? n[i] : i === half ? '-' : n[n.length - (max - i)];
    n = s;
  }
  return `${n}-${p}`;
}

export const u8 = (v: number) => Uint8Array.of(v & 0xff);
export const u16 = (v: number) => { const b = new Uint8Array(2); dvOf(b).setUint16(0, v, true); return b; };
export const i16 = (v: number) => { const b = new Uint8Array(2); dvOf(b).setInt16(0, v, true); return b; };
export const u32 = (v: number) => { const b = new Uint8Array(4); dvOf(b).setUint32(0, v >>> 0, true); return b; };
export const i32 = (v: number) => { const b = new Uint8Array(4); dvOf(b).setInt32(0, v, true); return b; };
export const i64 = (v: number) => { const b = new Uint8Array(8); dvOf(b).setBigInt64(0, BigInt(Math.round(v)), true); return b; };
export const rational = (num: number, den: number) => { const b = new Uint8Array(8); const dv = dvOf(b); dv.setInt32(0, num, true); dv.setInt32(4, den, true); return b; };
export const auidBytes = (g: string) => guidToBytes(g);
export const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
/** Valeur indirecte : 0x4c + AUID du type + valeur. */
export const indirect = (type: string, value: Uint8Array) => concat(u8(0x4c), guidToBytes(type), value);
/** Horodatage AAF (date + heure, 8 octets). */
export const timestamp = (d: Date) => concat(i16(d.getFullYear()), u8(d.getMonth() + 1), u8(d.getDate()), u8(d.getHours()), u8(d.getMinutes()), u8(d.getSeconds()), u8(0));
/** Référence faible : index de la table des propriétés référencées, pid de la clé, clé. */
export const weakRef = (weakIndex: number, keyPid: number, key: Uint8Array) => concat(u16(weakIndex), u16(keyPid), u8(key.length), key);

/** Flux « properties » d'un objet. */
function propertiesStream(o: WObj): Uint8Array {
  const vals = o.props.map(p => {
    switch (p.form) {
      case SF_DATA: case SF_WEAK_REF: return p.data;
      case SF_STRONG_REF: case SF_STRONG_REF_VECTOR: case SF_STRONG_REF_SET: case SF_WEAK_REF_VECTOR: case SF_WEAK_REF_SET: return encodeUtf16(p.name);
      case SF_DATA_STREAM: return concat(u8(0x55), encodeUtf16(p.name));
    }
  });
  const head = new Uint8Array(4 + o.props.length * 6);
  const dv = dvOf(head);
  head[0] = 0x4c; head[1] = 32;
  dv.setUint16(2, o.props.length, true);
  o.props.forEach((p, i) => {
    if (vals[i].length > 0xffff) throw new Error('Propriété AAF trop grande.');
    dv.setUint16(4 + i * 6, p.pid, true);
    dv.setUint16(6 + i * 6, p.form, true);
    dv.setUint16(8 + i * 6, vals[i].length, true);
  });
  return concat(head, ...vals);
}

/** Objets → nœuds CFB (stockages, flux « properties », index, flux de données). */
export function writeObjects(o: WObj, path: string, out: CfbNodeIn[]): void {
  out.push({ path, clsid: o.classId });
  const base = path === '/' ? '' : path;
  out.push({ path: `${base}/properties`, data: propertiesStream(o) });
  for (const p of o.props) {
    if (p.form === SF_STRONG_REF) { if (p.obj) writeObjects(p.obj, `${base}/${p.name}`, out); }
    else if (p.form === SF_STRONG_REF_VECTOR) {
      out.push({ path: `${base}/${p.name} index`, data: concat(u32(p.objs.length), u32(p.objs.length), u32(0xffffffff), ...p.objs.map((_, i) => u32(i))) });
      p.objs.forEach((c, i) => writeObjects(c, `${base}/${p.name}{${i.toString(16)}}`, out));
    } else if (p.form === SF_STRONG_REF_SET) {
      out.push({ path: `${base}/${p.name} index`, data: concat(u32(p.objs.length), u32(p.objs.length), u32(0xffffffff), u16(p.keyPid), u8(p.keySize),
        ...p.objs.map((c, i) => concat(u32(i), u32(1), p.keyOf(c)))) });
      p.objs.forEach((c, i) => writeObjects(c, `${base}/${p.name}{${i.toString(16)}}`, out));
    } else if (p.form === SF_WEAK_REF_VECTOR || p.form === SF_WEAK_REF_SET) {
      out.push({ path: `${base}/${p.name} index`, data: concat(u32(p.keys.length), u16(p.weakIndex), u16(p.keyPid), u8(p.keySize), ...p.keys) });
    } else if (p.form === SF_DATA_STREAM) {
      out.push({ path: `${base}/${p.name}`, data: p.bytes });
    }
  }
}
