/**
 * Écriture d'une séance AAF pour Pro Tools (« Séance pour Pro Tools »).
 *
 * Structure (AAF Edit Protocol, comme Pro Tools et Media Composer) :
 *  - une CompositionMob (la séance) : un slot (piste) par canal de piste — piste
 *    stéréo = deux slots « Nom.L » / « Nom.R » (double mono, la convention de Pro Tools) ;
 *  - par slot : Sequence de Filler, SourceClip, OperationGroup « Mono Audio Gain »
 *    (gain de clip, constant ou ligne de gain) et Transition « Mono Audio Dissolve »
 *    (fondus d'entrée et de sortie, forme = interpolation Linear / Power / Log / BSpline) ;
 *    volume et panoramique de piste en OperationGroup au niveau du slot ;
 *  - un MasterMob par son (un slot par canal) → un SourceMob de fichier par canal :
 *    WAVEDescriptor, BWF mono 24 bits horodaté (bext TimeReference) lié dans
 *    « Audio Files/ » ou intégré dans l'AAF (EssenceData).
 *
 * La partie fixe (méta-dictionnaire, dictionnaire) vient de aafTemplate (pyaaf2).
 * Module pur : tests/aafWrite.test.ts.
 */
import type { CrossfadeCurve } from '../../types';
import { asciiOnly, encodeBwf, safeFilePart } from '../bwf';
import { CfbNodeIn, writeCfb } from './cfb';
import {
  auidBytes, concat, encodeUtf16, i16, i64, indirect, mangleName, rational, SF_DATA, SF_DATA_STREAM, SF_STRONG_REF,
  SF_STRONG_REF_SET, SF_STRONG_REF_VECTOR, SF_WEAK_REF, timestamp, TYPE_RATIONAL, u16, u32, u8, weakRef, WObj, WProp, writeObjects,
} from './aafObjects';
import { AAF_FILE_SIGNATURE_4K, CLS, CONTAINERDEF_AAF, DATADEF, INTERPDEF, OPDEF, PARAMDEF, PID, USAGE_TOPLEVEL } from './aafIds';
import { AAF_TEMPLATE_B64 } from './aafTemplate';

export interface AafExportMedia {
  id: string;
  /** Nom de base des fichiers (« Lead_Prise3 »). */
  name: string;
  channels: Float32Array[];
  sampleRate: number;
  /** Position du premier échantillon dans la séance (bext TimeReference). */
  timeReference: number;
}

export interface AafExportFade { length: number; shape: CrossfadeCurve }

export interface AafExportClip {
  name: string;
  /** Échantillons de la séance. */
  position: number;
  length: number;
  mediaId: string;
  /** Décalage dans le média (échantillons). */
  offset: number;
  /** Gain de clip linéaire. */
  gain: number;
  /** Ligne de gain : t en échantillons depuis le début du clip, gain linéaire. */
  gainPoints?: { t: number; gain: number }[];
  fadeIn?: AafExportFade;
  fadeOut?: AafExportFade;
  /**
   * Fondu enchaîné avec le clip précédent de la piste (il chevauche sa fin de `length`
   * échantillons) : une seule Transition entre les deux clips, comme un crossfade Pro Tools.
   */
  crossfadeIn?: AafExportFade;
}

export interface AafExportTrack { name: string; channels: 1 | 2; clips: AafExportClip[]; volume?: number; pan?: number }

export interface AafExportInput {
  name: string;
  sampleRate: number;
  tracks: AafExportTrack[];
  media: AafExportMedia[];
  /** Médias intégrés dans l'AAF (sinon liés dans « Audio Files/ »). */
  embed: boolean;
  /** Volume et panoramique des pistes. */
  trackVolumePan: boolean;
  /** Nom du projet NOVA (iXML des BWF). */
  project?: string;
  date?: Date;
  /** Octets aléatoires (identifiants) : fourni par les tests pour un résultat reproductible. */
  random?: (n: number) => Uint8Array;
}

export interface AafExportFile { path: string; bytes: Uint8Array }

export interface AafExportResult {
  aaf: Uint8Array;
  /** BWF horodatés (dans « Audio Files/ »), toujours livrés à côté de l'AAF. */
  files: AafExportFile[];
  stats: { tracks: number; slots: number; clips: number; fades: number; clipGains: number; mediaFiles: number; shortenedFades: number };
  messages: string[];
}

export const MEDIA_FOLDER = 'Audio Files';

const INTERP_OF: Record<CrossfadeCurve, string> = {
  LINEAR: INTERPDEF.Linear, EQUAL_POWER: INTERPDEF.Power, EXPONENTIAL: INTERPDEF.Log, S_CURVE: INTERPDEF.BSpline,
};

// ── Modèle (partie fixe) ─────────────────────────────────────────────────────────────────
interface Template { table: number[][]; entries: { p: string; c?: string | null; d?: string }[] }
let templateCache: Template | null = null;

const b64ToBytes = (s: string): Uint8Array => {
  if (typeof atob === 'function') { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  return new Uint8Array((globalThis as any).Buffer.from(s, 'base64'));
};

async function inflateRaw(b: Uint8Array): Promise<Uint8Array> {
  const ds = new (globalThis as any).DecompressionStream('deflate-raw');
  const stream = new Blob([b as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function loadTemplate(): Promise<Template> {
  if (templateCache) return templateCache;
  const json = new TextDecoder().decode(await inflateRaw(b64ToBytes(AAF_TEMPLATE_B64)));
  templateCache = JSON.parse(json);
  return templateCache!;
}

// ── Identifiants ─────────────────────────────────────────────────────────────────────────
const defaultRandom = (n: number) => { const b = new Uint8Array(n); (globalThis.crypto || (globalThis as any).msCrypto).getRandomValues(b); return b; };

/** UMID SMPTE (32 octets), comme pyaaf2 : étiquette universelle + matériau aléatoire. */
function newMobId(rand: (n: number) => Uint8Array): Uint8Array {
  const id = new Uint8Array(32);
  id.set([0x06, 0x0a, 0x2b, 0x34, 0x01, 0x01, 0x01, 0x05, 0x01, 0x01, 0x0f, 0x20], 0);
  id[12] = 0x13;
  const m = rand(16);
  m[6] = (m[6] & 0x0f) | 0x40; m[8] = (m[8] & 0x3f) | 0x80; // UUID v4
  id.set(m, 16);
  return id;
}
const newAuid = (rand: (n: number) => Uint8Array): Uint8Array => { const m = rand(16); m[6] = (m[6] & 0x0f) | 0x40; m[8] = (m[8] & 0x3f) | 0x80; return m; };

/** Rationnel exact (ou au millionième) d'un nombre. */
function toRational(v: number): [number, number] {
  if (Number.isInteger(v) && Math.abs(v) < 2 ** 31) return [v, 1];
  const den = 1_000_000;
  return [Math.round(v * den), den];
}

// ── Écriture ─────────────────────────────────────────────────────────────────────────────
const data = (pid: number, d: Uint8Array): WProp => ({ pid, form: SF_DATA, data: d });
const str = (pid: number, s: string): WProp => data(pid, encodeUtf16(s));

export async function writeAaf(inp: AafExportInput): Promise<AafExportResult> {
  const tpl = await loadTemplate();
  const rand = inp.random || defaultRandom;
  const now = inp.date || new Date();
  const sr = inp.sampleRate;
  const messages: string[] = [];
  const stats: AafExportResult['stats'] = { tracks: inp.tracks.length, slots: 0, clips: 0, fades: 0, clipGains: 0, mediaFiles: 0, shortenedFades: 0 };

  // Table des propriétés référencées (références faibles) : celle du modèle + celles de NOVA.
  const table = tpl.table.map(p => [...p]);
  const weakIndex = (path: number[]) => {
    let i = table.findIndex(p => p.length === path.length && p.every((v, k) => v === path[k]));
    if (i < 0) { table.push(path); i = table.length - 1; }
    return i;
  };
  const DICT = [PID.Root_Header, PID.Header_Dictionary];
  const W_DATADEF = weakIndex([...DICT, 0x2605]);
  const W_OPDEF = weakIndex([...DICT, 0x2603]);
  const W_CONTAINER = weakIndex([...DICT, 0x2608]);
  const W_INTERP = weakIndex([...DICT, 0x2609]);
  const soundDef = (): WProp => ({ pid: PID.Component_DataDefinition, form: SF_WEAK_REF, data: weakRef(W_DATADEF, PID.DefinitionObject_Identification, auidBytes(DATADEF.Sound)) });
  const len = (n: number) => data(PID.Component_Length, i64(n));
  const ts = timestamp(now);

  const filler = (n: number): WObj => ({ classId: CLS.Filler, props: [soundDef(), len(n)] });
  const sourceClip = (n: number, mobId: Uint8Array | null, slotId: number, start: number): WObj => ({
    classId: CLS.SourceClip,
    props: [soundDef(), len(n), data(PID.SourceClip_StartTime, i64(start)), data(PID.SourceReference_SourceID, mobId || new Uint8Array(32)), data(PID.SourceReference_SourceMobSlotID, u32(slotId))],
  });
  const opGroup = (opdef: string, n: number, inputs: WObj[], params: WObj[]): WObj => {
    const props: WProp[] = [soundDef(), len(n), { pid: PID.OperationGroup_Operation, form: SF_WEAK_REF, data: weakRef(W_OPDEF, PID.DefinitionObject_Identification, auidBytes(opdef)) }];
    if (inputs.length) props.push({ pid: PID.OperationGroup_InputSegments, form: SF_STRONG_REF_VECTOR, name: mangleName('InputSegments', PID.OperationGroup_InputSegments, 22), objs: inputs });
    if (params.length) props.push({
      pid: PID.OperationGroup_Parameters, form: SF_STRONG_REF_SET, name: mangleName('Parameters', PID.OperationGroup_Parameters, 22), objs: params,
      keyPid: PID.DefinitionObject_Identification, keySize: 16, keyOf: o => (o as any).__key,
    });
    return { classId: CLS.OperationGroup, props };
  };
  const ratValue = (v: number) => { const [n, d] = toRational(v); return indirect(TYPE_RATIONAL, rational(n, d)); };
  const constant = (paramDef: string, v: number): WObj => Object.assign({
    classId: CLS.ConstantValue, props: [data(PID.Parameter_Definition, auidBytes(paramDef)), data(PID.ConstantValue_Value, ratValue(v))],
  }, { __key: auidBytes(paramDef) });
  const varying = (paramDef: string, interp: string, points: { t: number; v: number }[]): WObj => Object.assign({
    classId: CLS.VaryingValue,
    props: [
      data(PID.Parameter_Definition, auidBytes(paramDef)),
      { pid: PID.VaryingValue_Interpolation, form: SF_WEAK_REF, data: weakRef(W_INTERP, PID.DefinitionObject_Identification, auidBytes(interp)) } as WProp,
      {
        pid: PID.VaryingValue_PointList, form: SF_STRONG_REF_VECTOR, name: mangleName('PointList', PID.VaryingValue_PointList, 22),
        objs: points.map(p => {
          const [tn, td] = p.t === 0 || p.t === 1 ? [p.t, 1] : toRational(p.t);
          return { classId: CLS.ControlPoint, props: [data(PID.ControlPoint_Time, rational(tn, td)), data(PID.ControlPoint_Value, ratValue(p.v)), data(PID.ControlPoint_EditHint, u8(1))] };
        }),
      } as WProp,
    ],
  }, { __key: auidBytes(paramDef) });
  const transition = (n: number, shape: CrossfadeCurve): WObj => ({
    classId: CLS.Transition,
    props: [soundDef(), len(n), data(PID.Transition_CutPoint, i64(0)), {
      pid: PID.Transition_OperationGroup, form: SF_STRONG_REF, name: mangleName('OperationGroup', PID.Transition_OperationGroup, 32),
      obj: opGroup(OPDEF.MonoAudioDissolve, n, [], [varying(PARAMDEF.Level, INTERP_OF[shape] || INTERPDEF.Linear, [{ t: 0, v: 0 }, { t: 1, v: 1 }])]),
    }],
  });
  const timelineSlot = (slotId: number, name: string | null, segment: WObj, physical?: number): WObj => ({
    classId: CLS.TimelineMobSlot,
    props: [
      data(PID.MobSlot_SlotID, u32(slotId)),
      ...(name !== null ? [str(PID.MobSlot_SlotName, name)] : []),
      ...(physical ? [data(PID.MobSlot_PhysicalTrackNumber, u32(physical))] : []),
      data(PID.TimelineMobSlot_Origin, i64(0)),
      data(PID.TimelineMobSlot_EditRate, rational(sr, 1)),
      { pid: PID.MobSlot_Segment, form: SF_STRONG_REF, name: mangleName('Segment', PID.MobSlot_Segment, 32), obj: segment },
    ],
  });
  const mob = (classId: string, mobId: Uint8Array, name: string, slots: WObj[], extra: WProp[] = []): WObj => Object.assign({
    classId,
    props: [
      str(PID.Mob_Name, name), data(PID.Mob_MobID, mobId), data(PID.Mob_CreationTime, ts), data(PID.Mob_LastModified, ts),
      { pid: PID.Mob_Slots, form: SF_STRONG_REF_VECTOR, name: mangleName('Slots', PID.Mob_Slots, 22), objs: slots } as WProp,
      ...extra,
    ],
  }, { __key: mobId });

  // ── Médias : un BWF mono par canal, un SourceMob de fichier par BWF, un MasterMob par son ──
  const files: AafExportFile[] = [];
  const mobs: WObj[] = [];
  const essence: WObj[] = [];
  const masters = new Map<string, { mobId: Uint8Array; channels: number }>();
  const usedNames = new Set<string>();
  const fileMobs: WObj[] = [];
  for (const m of inp.media) {
    const base = uniqueName(safeFilePart(asciiOnly(m.name), 'Son'), usedNames);
    const masterId = newMobId(rand);
    const chans = m.channels.slice(0, 2);
    const masterSlots: WObj[] = [];
    chans.forEach((ch, ci) => {
      const suffix = chans.length === 2 ? (ci === 0 ? '.L' : '.R') : '';
      const fileName = `${base}${suffix}.wav`;
      const wav = encodeBwf({ channels: [ch], sampleRate: m.sampleRate, format: '24', timeReference: Math.max(0, Math.round(m.timeReference)), info: { project: inp.project || inp.name, track: `${m.name}${suffix}`, take: 1 }, date: now });
      files.push({ path: `${MEDIA_FOLDER}/${fileName}`, bytes: wav });
      stats.mediaFiles++;
      const fileId = newMobId(rand);
      const summary = wavSummary(wav);
      const descProps: WProp[] = [
        data(PID.FileDescriptor_SampleRate, rational(m.sampleRate, 1)),
        data(PID.FileDescriptor_Length, i64(ch.length)),
        { pid: PID.FileDescriptor_ContainerFormat, form: SF_WEAK_REF, data: weakRef(W_CONTAINER, PID.DefinitionObject_Identification, auidBytes(CONTAINERDEF_AAF)) },
        data(PID.WAVE_Summary, summary),
      ];
      if (!inp.embed) {
        descProps.push({
          pid: PID.EssenceDescriptor_Locator, form: SF_STRONG_REF_VECTOR, name: mangleName('Locator', PID.EssenceDescriptor_Locator, 22),
          objs: [{ classId: CLS.NetworkLocator, props: [str(PID.NetworkLocator_URLString, `${encodeURIComponent(MEDIA_FOLDER)}/${encodeURIComponent(fileName)}`)] }],
        });
      }
      const fileSlot = timelineSlot(1, null, sourceClip(ch.length, null, 0, 0));
      fileMobs.push(mob(CLS.SourceMob, fileId, fileName.replace(/\.wav$/, ''), [fileSlot], [{
        pid: PID.SourceMob_EssenceDescription, form: SF_STRONG_REF, name: mangleName('EssenceDescription', PID.SourceMob_EssenceDescription, 32),
        obj: { classId: CLS.WAVEDescriptor, props: descProps },
      }]));
      if (inp.embed) {
        essence.push(Object.assign({
          classId: CLS.EssenceData,
          props: [data(PID.EssenceData_MobID, fileId), { pid: PID.EssenceData_Data, form: SF_DATA_STREAM, name: mangleName('Data', PID.EssenceData_Data, 32), bytes: wav } as WProp],
        }, { __key: fileId }));
      }
      masterSlots.push(timelineSlot(ci + 1, null, sourceClip(ch.length, fileId, 1, 0)));
    });
    masters.set(m.id, { mobId: masterId, channels: chans.length });
    mobs.push(mob(CLS.MasterMob, masterId, m.name, masterSlots));
  }

  // ── Séance ─────────────────────────────────────────────────────────────────────────────
  const compSlots: WObj[] = [];
  let slotId = 1;
  for (const t of inp.tracks) {
    const sides = t.channels === 2 ? [{ suffix: '.L', ch: 0 }, { suffix: '.R', ch: 1 }] : [{ suffix: '', ch: 0 }];
    for (const side of sides) {
      const comps: WObj[] = [];
      let cur = 0;
      let total = 0; // longueur de la séquence (les transitions chevauchent : déduites)
      const clips = [...t.clips].sort((a, b) => a.position - b.position);
      clips.forEach((c, i) => {
        const master = masters.get(c.mediaId);
        if (!master) return;
        const next = clips[i + 1];
        const xIn = c.crossfadeIn && i > 0 && clips[i - 1].position + clips[i - 1].length - c.position === c.crossfadeIn.length ? c.crossfadeIn.length : 0;
        const xOut = !!(next?.crossfadeIn && c.position + c.length - next.position === next.crossfadeIn.length);
        // Une piste AAF ne superpose pas deux clips (hors fondu enchaîné) : le découpage en couches est fait avant (novaToAaf).
        if (!xIn && c.position < cur) messages.push(`« ${t.name} » : deux clips se chevauchent, le second est décalé de ${cur - c.position} échantillons.`);
        const gap = xIn ? 0 : Math.max(0, c.position - cur);
        // Fondu d'entrée : Filler (trou + fondu) puis Transition, qui chevauche la fin du Filler et le début du clip.
        const fi = xIn ? 0 : c.fadeIn ? Math.max(0, Math.min(c.fadeIn.length, c.length)) : 0;
        // Fondu de sortie : Transition puis Filler (fondu), qui chevauche la fin du clip ; entrée + sortie ≤ longueur.
        const fo = xOut ? 0 : c.fadeOut ? Math.max(0, Math.min(c.fadeOut.length, c.length - fi - xIn)) : 0;
        if (c.fadeOut && !xOut && fo < c.fadeOut.length && side.ch === 0) stats.shortenedFades++;
        if (xIn) { comps.push(transition(xIn, c.crossfadeIn!.shape)); total -= xIn; if (side.ch === 0) stats.fades++; }
        if (gap + fi > 0) { comps.push(filler(gap + fi)); total += gap + fi; }
        if (fi) { comps.push(transition(fi, c.fadeIn!.shape)); total -= fi; if (side.ch === 0) stats.fades++; }
        const channelSlot = Math.min(side.ch, master.channels - 1) + 1;
        let seg = sourceClip(c.length, master.mobId, channelSlot, c.offset);
        const params: WObj[] = [];
        if (c.gainPoints && c.gainPoints.length > 1) {
          params.push(varying(PARAMDEF.Amplitude, INTERPDEF.Linear, c.gainPoints.map(p => ({ t: Math.max(0, Math.min(1, p.t / c.length)), v: p.gain * c.gain }))));
        } else if (Math.abs(c.gain - 1) > 1e-9) params.push(constant(PARAMDEF.Amplitude, c.gain));
        if (params.length) { seg = opGroup(OPDEF.MonoAudioGain, c.length, [seg], params); if (side.ch === 0) stats.clipGains++; }
        comps.push(seg);
        total += c.length;
        cur = c.position + c.length;
        if (fo) {
          comps.push(transition(fo, c.fadeOut!.shape)); total -= fo;
          comps.push(filler(fo)); total += fo;
          if (side.ch === 0) stats.fades++;
        }
      });
      let seg: WObj = { classId: CLS.Sequence, props: [soundDef(), len(total), { pid: PID.Sequence_Components, form: SF_STRONG_REF_VECTOR, name: mangleName('Components', PID.Sequence_Components, 22), objs: comps } as WProp] };
      if (inp.trackVolumePan && t.volume !== undefined && Math.abs(t.volume - 1) > 1e-9) seg = opGroup(OPDEF.MonoAudioGain, total, [seg], [constant(PARAMDEF.Amplitude, t.volume)]);
      if (inp.trackVolumePan && t.pan !== undefined) {
        // Piste stéréo : chaque côté garde son panoramique de base (L à gauche, R à droite) décalé par le pan NOVA.
        const base = sides.length === 2 ? (side.ch === 0 ? -1 : 1) : 0;
        const p = Math.max(-1, Math.min(1, base + t.pan));
        if (sides.length === 2 || Math.abs(t.pan) > 1e-9) seg = opGroup(OPDEF.MonoAudioPan, total, [seg], [constant(PARAMDEF.Pan, (p + 1) / 2)]);
      }
      compSlots.push(timelineSlot(slotId, `${t.name}${side.suffix}`, seg, slotId));
      slotId++;
      stats.slots++;
    }
  }
  stats.clips = inp.tracks.reduce((n, t) => n + t.clips.length, 0);
  const compId = newMobId(rand);
  mobs.unshift(mob(CLS.CompositionMob, compId, inp.name, compSlots, [data(PID.Mob_UsageCode, auidBytes(USAGE_TOPLEVEL))]));
  mobs.push(...fileMobs);

  // ── En-tête, identification, racine ─────────────────────────────────────────────────────
  const content: WObj = {
    classId: CLS.ContentStorage,
    props: [
      { pid: PID.ContentStorage_Mobs, form: SF_STRONG_REF_SET, name: mangleName('Mobs', PID.ContentStorage_Mobs, 22), objs: mobs, keyPid: PID.Mob_MobID, keySize: 32, keyOf: o => (o as any).__key },
      ...(essence.length ? [{ pid: PID.ContentStorage_EssenceData, form: SF_STRONG_REF_SET, name: mangleName('EssenceData', PID.ContentStorage_EssenceData, 22), objs: essence, keyPid: PID.EssenceData_MobID, keySize: 32, keyOf: (o: WObj) => (o as any).__key } as WProp] : []),
    ],
  };
  const ident: WObj = {
    classId: CLS.Identification,
    props: [
      str(PID.Identification_ProductName, 'NOVA'), str(PID.Identification_CompanyName, 'Make Music'), str(PID.Identification_ProductVersionString, '1.0'),
      data(PID.Identification_ProductID, auidBytes('6e4f5641-0000-4d4d-8000-000000000014')), data(PID.Identification_Date, ts),
      str(PID.Identification_Platform, 'NOVA Studio'), data(PID.Identification_GenerationAUID, newAuid(rand)),
    ],
  };
  const header: WObj = {
    classId: CLS.Header,
    props: [
      { pid: PID.Header_Dictionary, form: SF_STRONG_REF, name: mangleName('Dictionary', PID.Header_Dictionary, 32) },
      { pid: PID.Header_Content, form: SF_STRONG_REF, name: mangleName('Content', PID.Header_Content, 32), obj: content },
      data(PID.Header_OperationalPattern, auidBytes('0d011201-0100-0000-060e-2b3404010105')),
      data(PID.Header_ObjectModelVersion, u32(1)),
      data(PID.Header_Version, Uint8Array.of(1, 2)),
      { pid: PID.Header_IdentificationList, form: SF_STRONG_REF_VECTOR, name: mangleName('IdentificationList', PID.Header_IdentificationList, 22), objs: [ident] },
      data(PID.Header_LastModified, ts),
      data(PID.Header_ByteOrder, i16(0x4949)),
    ],
  };
  const root: WObj = {
    classId: CLS.Root,
    props: [
      { pid: PID.Root_MetaDictionary, form: SF_STRONG_REF, name: 'MetaDictionary-1' },
      { pid: PID.Root_Header, form: SF_STRONG_REF, name: 'Header-2', obj: header },
    ],
  };
  const nodes: CfbNodeIn[] = [];
  writeObjects(root, '/', nodes);
  for (const e of tpl.entries) nodes.push(e.d !== undefined ? { path: e.p, data: b64ToBytes(e.d) } : { path: e.p, clsid: e.c || undefined });
  nodes.push({ path: '/referenced properties', data: referencedProperties(table) });
  const aaf = writeCfb(nodes, { rootClsid: CLS.Root, headerClsid: AAF_FILE_SIGNATURE_4K, sectorSize: 4096 });
  if (stats.shortenedFades) messages.push(`${stats.shortenedFades} fondu${stats.shortenedFades > 1 ? 's' : ''} de sortie raccourci${stats.shortenedFades > 1 ? 's' : ''} : les fondus d'entrée et de sortie dépassaient la longueur du clip.`);
  return { aaf, files, stats, messages };
}

/** Résumé WAVEDescriptor : « RIFF » + taille + « WAVE » + chunk fmt (comme pyaaf2 et le SDK). */
function wavSummary(wav: Uint8Array): Uint8Array {
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let at = 12;
  while (at + 8 <= wav.length) {
    const id = String.fromCharCode(...wav.subarray(at, at + 4));
    const size = dv.getUint32(at + 4, true);
    if (id === 'fmt ') return concat(wav.subarray(0, 12), wav.subarray(at, at + 8 + size));
    at += 8 + size + (size & 1);
  }
  return wav.subarray(0, 12);
}

/** Flux « referenced properties » : chemins de pid des références faibles. */
function referencedProperties(table: number[][]): Uint8Array {
  const pidCount = table.reduce((s, p) => s + p.length + 1, 0);
  return concat(u8(0x4c), u16(table.length), u32(pidCount), ...table.map(p => concat(...p.map(u16), u16(0))));
}

function uniqueName(base: string, used: Set<string>): string {
  let n = base, k = 2;
  while (used.has(n.toLowerCase())) n = `${base}_${k++}`;
  used.add(n.toLowerCase());
  return n;
}

