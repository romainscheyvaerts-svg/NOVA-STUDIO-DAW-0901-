/**
 * Glissés par note (piano roll pro, « Slide » de FL Studio) dans les fichiers
 * .mid (16/10/2026).
 *
 * Dans NOVA, une note glissée qui commence PENDANT une note tenue (l'« hôte »)
 * ne se rejoue pas : elle fait glisser la hauteur de l'hôte jusqu'à la sienne,
 * pendant sa propre durée (rampe linéaire en demi-tons), et l'hôte garde sa fin.
 *
 * Le MIDI standard n'a pas de « note glissée ». On l'écrit comme le font les
 * DAW et les synthés (FL Studio, Ableton Live, Logic les relisent) :
 *  - en tête de piste, pour chaque canal concerné, la plage du pitch bend
 *    annoncée par le RPN 0 (« Pitch Bend Sensitivity » : CC 101 = 0, CC 100 = 0,
 *    CC 6 = demi-tons, CC 38 = 0, puis RPN nul 127/127) ; ±24 demi-tons par défaut
 *    (élargie par pas de 12 si un glissé va plus loin) ;
 *  - pour chaque glissé, des messages de pitch bend sur le canal de l'hôte :
 *    un point de départ (valeur courante) au début du glissé, puis une rampe
 *    jusqu'à l'écart voulu à la fin du glissé ;
 *  - le pitch bend revient au centre avant la note suivante du canal (ou à la
 *    fin de l'hôte), après un point d'ancrage au même instant.
 *
 * Le pitch bend vaut pour tout le canal : si une autre note sonne sur le canal
 * pendant le glissé (accord, notes qui se chevauchent), l'hôte et ses glissés
 * partent sur un canal libre du fichier (une note par canal, comme le MPE).
 * À la relecture, ce canal est rendu à la piste (même partie dans NOVA).
 *
 * Relecture : une rampe de pitch bend qui finit sur un demi-ton entier pendant
 * une note devient une note glissée (hauteur = note + écart, début et fin de la
 * rampe). Un vibrato ou un bend « expressif » (qui ne finit pas sur un demi-ton
 * entier) est ignoré.
 *
 * Limites (voir le rapport) : un glissé vers la même hauteur ne se voit pas
 * (aucun bend) ; deux glissés qui se chevauchent sur la même note : le premier
 * s'arrête au début du second (comme le Synthé NOVA, qui saute à la hauteur visée) ;
 * la vélocité d'une note glissée (sans effet sur le son) revient à celle de l'hôte.
 */

/** Note d'un fichier .mid (forme de utils/midiFile, sans import circulaire). */
export interface SlideFileNote {
  pitch: number;
  velocity: number;
  startTick: number;
  durationTicks: number;
  channel: number;
  /** Note glissée portée par la note qui sonne (piano roll pro). */
  slide?: boolean;
}

/** Plage du pitch bend écrite par défaut (demi-tons, ±). */
export const SLIDE_BEND_RANGE = 24;
/** Plage General MIDI quand le fichier n'annonce rien (RPN 0 absent). */
export const GM_BEND_RANGE = 2;
const DRUMS = 9;
const CENTER = 8192;

/** Événement de canal à écrire (même forme que l'écrivain de utils/midiFile). */
export interface SlideEvent { tick: number; order: number; status: number; bytes: number[] }

export interface SlideWritePlan {
  /** Notes à écrire par piste (les glissés portés sont devenus des pitch bends). */
  notes: SlideFileNote[][];
  /** Événements de canal (RPN, pitch bends) par piste. */
  events: SlideEvent[][];
  /** Plage annoncée (demi-tons). */
  range: number;
  /** Glissés écrits en pitch bend. */
  written: number;
  /** Notes porteuses parties sur un canal libre (autre note sur le même canal). */
  moved: number;
  /** Notes porteuses restées sur un canal partagé (plus aucun canal libre). */
  shared: number;
}

const endOf = (n: SlideFileNote) => n.startTick + n.durationTicks;

/** Valeur 14 bits d'un écart (demi-tons) pour une plage donnée. */
export const bendValue = (semis: number, range: number): number =>
  Math.max(0, Math.min(16383, Math.round(CENTER + (semis / range) * CENTER)));

/** Écart (demi-tons) d'une valeur 14 bits. */
export const bendSemis = (value: number, range: number): number => ((value - CENTER) / CENTER) * range;

/** Note qui sonne sur le canal à `tick` (strictement après son début), la plus récente ; à départ égal, la première (comme slideOrigins du piano roll). */
function hostAt(notes: SlideFileNote[], ch: number, tick: number): SlideFileNote | null {
  let best: SlideFileNote | null = null;
  for (const h of notes) {
    if (h.channel !== ch || h.slide) continue;
    if (h.startTick < tick && endOf(h) > tick && (!best || h.startTick > best.startTick)) best = h;
  }
  return best;
}

interface Hosted { host: SlideFileNote; slides: SlideFileNote[]; winStart: number; winEnd: number }

/**
 * Prépare l'écriture des glissés : chaque note `slide` portée par une note qui
 * sonne devient une rampe de pitch bend sur le canal de celle-ci.
 * Les notes `slide` sans note qui sonne s'écrivent comme des notes normales.
 */
export function planSlideBends(tracks: { notes: SlideFileNote[] }[], ppq: number, rangeOpt?: number): SlideWritePlan {
  const out: SlideWritePlan = { notes: [], events: [], range: rangeOpt || SLIDE_BEND_RANGE, written: 0, moved: 0, shared: 0 };
  const perTrack: { notes: SlideFileNote[]; hosted: Hosted[] }[] = [];
  let maxAbs = 0;
  for (const tr of tracks) {
    const notes = tr.notes.map(n => ({ ...n }));
    const hostedBy = new Map<SlideFileNote, SlideFileNote[]>();
    const keep: SlideFileNote[] = [];
    // Hôte décidé d'après les notes non glissées (comme utils/pianoRollPro absorbedSlides).
    for (const n of notes) {
      if (!n.slide || (n.channel & 0x0f) === DRUMS) { if (n.slide) delete n.slide; keep.push(n); continue; }
      const h = hostAt(notes, n.channel, n.startTick);
      if (!h) { delete n.slide; keep.push(n); continue; }
      const l = hostedBy.get(h) || [];
      l.push(n);
      hostedBy.set(h, l);
    }
    const hosted: Hosted[] = [];
    hostedBy.forEach((slides, host) => {
      slides.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
      for (const s of slides) maxAbs = Math.max(maxAbs, Math.abs(s.pitch - host.pitch));
      hosted.push({ host, slides, winStart: slides[0].startTick, winEnd: Math.max(endOf(host), ...slides.map(endOf)) });
    });
    hosted.sort((a, b) => a.host.startTick - b.host.startTick);
    perTrack.push({ notes: keep, hosted });
  }
  if (!rangeOpt && maxAbs > SLIDE_BEND_RANGE) out.range = Math.min(120, Math.ceil(maxAbs / 12) * 12);
  const range = out.range;

  // Canaux libres du fichier (pour séparer une note glissée d'un accord).
  const used = new Set<number>();
  perTrack.forEach(t => t.notes.forEach(n => used.add(n.channel & 0x0f)));
  const spare = Array.from({ length: 16 }, (_, i) => i).filter(c => c !== DRUMS && !used.has(c));
  const spareBusy = new Map<number, [number, number][]>();
  const hostSpan = new Map<SlideFileNote, number>();
  perTrack.forEach(t => t.hosted.forEach(h => hostSpan.set(h.host, h.winEnd)));
  const spanEnd = (n: SlideFileNote) => hostSpan.get(n) ?? endOf(n);

  for (const t of perTrack) {
    for (const h of t.hosted) {
      const ch = h.host.channel;
      // Une autre note du canal sonne pendant le glissé, ou la note porteuse sonne pendant le glissé d'une autre.
      const clash = t.notes.some(o => o !== h.host && o.channel === ch && o.startTick < h.winEnd && spanEnd(o) > h.winStart)
        || t.hosted.some(o => o !== h && o.host.channel === ch && h.host.startTick < o.winEnd && h.winEnd > o.winStart);
      if (!clash) continue;
      const free = spare.find(c => !(spareBusy.get(c) || []).some(([a, b]) => h.host.startTick < b && h.winEnd > a));
      if (free === undefined) { out.shared++; continue; }
      spareBusy.set(free, [...(spareBusy.get(free) || []), [h.host.startTick, h.winEnd]]);
      h.host.channel = free;
      h.slides.forEach(s => { s.channel = free; });
      out.moved++;
    }
  }

  const step = Math.max(1, Math.round(ppq / 48));
  for (const t of perTrack) {
    const evs: SlideEvent[] = [];
    const bendChans = new Set<number>();
    for (const h of t.hosted) {
      const ch = h.host.channel & 0x0f;
      bendChans.add(ch);
      const bend = (tick: number, v: number, order: number) => evs.push({ tick, order, status: 0xe0 | ch, bytes: [v & 0x7f, (v >> 7) & 0x7f] });
      let cur = 0;
      h.slides.forEach((s, i) => {
        const next = h.slides[i + 1];
        const start = s.startTick;
        // Glissés qui se chevauchent : le premier s'arrête où le second commence (le Synthé NOVA y saute).
        const end = Math.max(start, next && next.startTick < endOf(s) ? next.startTick : endOf(s));
        const target = Math.max(-range, Math.min(range, s.pitch - h.host.pitch));
        const v0 = bendValue(cur, range), v1 = bendValue(target, range);
        const dur = end - start;
        bend(start, v0, 1.5); // point de départ (ancre) : délimite le glissé à la relecture
        const n = Math.max(1, Math.min(Math.ceil(dur / step), Math.abs(v1 - v0) || 1));
        for (let k = 1; k <= n; k++) bend(start + Math.round((k * dur) / n), Math.round(v0 + ((v1 - v0) * k) / n), 1.5);
        cur = target;
        out.written++;
      });
      // Retour au centre : juste avant la note suivante du canal (la queue de la note garde sa hauteur), sinon à la fin.
      const nextOn = t.notes.filter(o => o.channel === h.host.channel && o.startTick >= h.winEnd).reduce((m, o) => Math.min(m, o.startTick), Infinity);
      const at = Number.isFinite(nextOn) ? nextOn : h.winEnd;
      bend(at, bendValue(cur, range), 2.5);
      bend(at, CENTER, 2.5);
    }
    // RPN 0 : plage du pitch bend, en tête de piste, sur chaque canal qui glisse.
    bendChans.forEach(ch => {
      const cc = (c: number, v: number) => evs.push({ tick: 0, order: 1, status: 0xb0 | ch, bytes: [c, v] });
      cc(101, 0); cc(100, 0); cc(6, range); cc(38, 0); cc(101, 127); cc(100, 127);
    });
    out.notes.push(t.notes);
    out.events.push(evs);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Relecture
// ---------------------------------------------------------------------------

/** Pitch bend lu dans un fichier (valeur 14 bits, plage en vigueur à cet instant). */
export interface ReadBend { tick: number; channel: number; value: number; range: number }

/**
 * Reconstruit les glissés d'une piste lue : rampes de pitch bend qui finissent
 * sur un demi-ton entier pendant une note. Renvoie les notes complétées
 * (glissés ajoutés, canal « une note par canal » rendu à la piste).
 */
export function slidesFromBends(notes: SlideFileNote[], bends: ReadBend[], ppq: number): SlideFileNote[] {
  if (!bends.length || !notes.length) return notes;
  const maxGap = Math.max(1, Math.round(ppq / 2));
  const added: SlideFileNote[] = [];
  const chans = Array.from(new Set(bends.map(b => b.channel))).filter(c => c !== DRUMS);
  for (const ch of chans) {
    const evs = bends.filter(b => b.channel === ch);
    type Ramp = { start: number; end: number; from: number; value: number; range: number; dir: number };
    const ramps: Ramp[] = [];
    let cur = CENTER, prevTick = -Infinity, ramp: Ramp | null = null;
    const close = () => { if (ramp) ramps.push(ramp); ramp = null; };
    for (const e of evs) {
      if (e.value === cur) { close(); prevTick = e.tick; continue; } // ancre : aucune variation
      const dir = Math.sign(e.value - cur);
      if (ramp && ramp.dir === dir && e.tick - ramp.end <= maxGap) { ramp.end = e.tick; ramp.value = e.value; ramp.range = e.range; }
      else { close(); ramp = { start: e.tick - prevTick <= maxGap ? prevTick : e.tick, end: e.tick, from: cur, value: e.value, range: e.range, dir }; }
      cur = e.value; prevTick = e.tick;
    }
    close();
    for (const r of ramps) {
      if (r.end <= r.start) continue; // saut instantané (retour au centre) : pas un glissé
      const host = hostAt(notes, ch, r.start);
      if (!host) continue;
      const semis = bendSemis(r.value, r.range);
      const whole = Math.round(semis);
      const from = bendSemis(r.from, r.range);
      // Un glissé part d'un demi-ton entier et finit sur un demi-ton entier : sinon vibrato ou bend expressif.
      if (Math.abs(semis - whole) > 0.05 || Math.abs(from - Math.round(from)) > 0.05) continue;
      const pitch = host.pitch + whole;
      if (pitch < 0 || pitch > 127) continue;
      added.push({ pitch, velocity: host.velocity, startTick: r.start, durationTicks: r.end - r.start, channel: ch, slide: true });
    }
  }
  if (!added.length) return notes;
  const all = [...notes, ...added];
  // Canal « une note par canal » : rendu au canal principal de la piste quand il n'y en a qu'un.
  const melodic = Array.from(new Set(all.map(n => n.channel))).filter(c => c !== DRUMS);
  const slideOnly = melodic.filter(c => {
    const plain = all.filter(n => n.channel === c && !n.slide);
    return plain.length > 0 && plain.every(h => added.some(s => s.channel === c && s.startTick > h.startTick && s.startTick < endOf(h)));
  });
  const main = melodic.filter(c => !slideOnly.includes(c));
  if (main.length === 1 && slideOnly.length) all.forEach(n => { if (slideOnly.includes(n.channel)) n.channel = main[0]; });
  return all.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
}
