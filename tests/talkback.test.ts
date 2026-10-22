import { readFileSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TALKBACK, TALKBACK_DEFAULT_KEY, TALKBACK_HOLD_MS, TalkbackLatch, dbToGain, talkbackMicError, talkbackPlan,
  talkbackSettingsStore, talkbackTitle, talkingLabel,
} from '../utils/talkback';
import { KEYMAP, MIDI_KEYBOARD_SHORTCUTS, chordFromEvent, findConflicts, isShortcut, keysOf, shortcutHint } from '../utils/keymap';
import { KEYMAP_PRESETS, __resetKeymapForTests, keymapConflicts, keymapStore, resolvePreset } from '../utils/keymapStore';
import { isComputerKeyboardCode } from '../utils/computerKeyboard';
import { CueMixEngine } from '../engine/CueMixEngine';
import type { CueMix } from '../types';

/**
 * Talkback (bouton de la barre, touche N, collaboration en direct, casque au studio) :
 * comportement de console (appui court / maintenu), touche sans conflit, routage local
 * vers les casques SEULEMENT (ni master, ni écoute de la régie, ni export), dim.
 */

// ---------------------------------------------------------------------------------------
describe('appui court / maintenu, comme une console', () => {
  const make = () => {
    const log: [boolean, boolean][] = [];
    const l = new TalkbackLatch((o, la) => log.push([o, la]));
    return { l, log };
  };

  it('appui court (< 300 ms) : ouvert tout de suite, reste ouvert (verrouillé) ; un 2e appui coupe aussitôt', () => {
    const { l, log } = make();
    l.press('key', 1000);
    expect(l.open).toBe(true);                // on entend dès l'appui (pas de premier mot perdu)
    l.release('key', 1000 + TALKBACK_HOLD_MS - 50);
    expect(l.open).toBe(true);
    expect(l.latched).toBe(true);
    l.press('key', 3000);                     // 2e appui : coupé à l'appui
    expect(l.open).toBe(false);
    l.release('key', 3100);                   // son relâchement ne rouvre rien
    expect(l.open).toBe(false);
    expect(log).toEqual([[true, false], [true, true], [false, false]]);
  });

  it('appui maintenu (≥ 300 ms) : ouvert tant qu’on tient, relâcher coupe', () => {
    const { l } = make();
    l.press('key', 0);
    expect(l.open).toBe(true);
    expect(l.latched).toBe(false);
    l.release('key', TALKBACK_HOLD_MS + 1);
    expect(l.open).toBe(false);
    // Long maintien (une phrase entière) : pareil.
    l.press('button', 10_000); l.release('button', 18_000);
    expect(l.open).toBe(false);
  });

  it('pile 300 ms = maintenu ; 299 ms = court', () => {
    const a = make().l; a.press('key', 0); a.release('key', 299); expect(a.open).toBe(true);
    const b = make().l; b.press('key', 0); b.release('key', 300); expect(b.open).toBe(false);
  });

  it('répétitions du clavier et 2e source ignorées pendant l’appui ; relâcher la mauvaise source ne fait rien', () => {
    const { l, log } = make();
    l.press('key', 0);
    for (let t = 30; t < 1000; t += 30) l.press('key', t);   // auto-répétition (si elle passait)
    l.press('button', 200);
    l.release('button', 250);
    expect(l.open).toBe(true);
    l.release('key', 1200);
    expect(l.open).toBe(false);
    expect(log).toEqual([[true, false], [false, false]]);
  });

  it('verrouillé au clavier, coupé au bouton (et l’inverse)', () => {
    const { l } = make();
    l.press('key', 0); l.release('key', 80);
    expect(l.latched).toBe(true);
    l.press('button', 500);
    expect(l.open).toBe(false);
    l.release('button', 600);
    expect(l.open).toBe(false);
  });

  it('prise qui commence / micro refusé (forceClose) pendant l’appui : le relâchement ne rouvre pas', () => {
    const { l } = make();
    l.press('key', 0);
    l.forceClose();
    expect(l.open).toBe(false);
    l.release('key', 100);                    // aurait verrouillé : non
    expect(l.open).toBe(false);
    expect(l.latched).toBe(false);
    l.press('key', 500);                      // l'appui suivant rouvre normalement
    expect(l.open).toBe(true);
  });

  it('palette / chat (toggle) : ouvre verrouillé, puis coupe', () => {
    const { l } = make();
    l.toggle();
    expect([l.open, l.latched]).toEqual([true, true]);
    l.toggle();
    expect([l.open, l.latched]).toEqual([false, false]);
  });
});

// ---------------------------------------------------------------------------------------
describe('touche par défaut : N, libre partout, réglable', () => {
  beforeEach(() => __resetKeymapForTests());

  it('N par défaut, dans la catégorie Transport, réglable (pas « fixe »)', () => {
    const d = KEYMAP.find(s => s.id === 'nova.talkback')!;
    expect(d).toBeTruthy();
    expect(d.keys).toEqual([TALKBACK_DEFAULT_KEY]);
    expect(TALKBACK_DEFAULT_KEY).toBe('n');
    expect(d.fixed).toBeFalsy();
    expect(d.category).toBe('Transport');
    expect(shortcutHint('nova.talkback')).toBe('N');
  });

  it('aucun conflit dans la table d’origine, et N n’est utilisé par AUCUNE autre commande (tous contextes)', () => {
    expect(findConflicts(KEYMAP)).toEqual([]);
    const others = KEYMAP.filter(s => s.id !== 'nova.talkback' && s.keys.includes('n'));
    expect(others.map(s => `${s.context}:${s.id}`)).toEqual([]);
  });

  it('clavier MIDI de l’ordinateur : la touche N n’y joue aucune note', () => {
    expect(isComputerKeyboardCode('KeyN')).toBe(false);
    expect(MIDI_KEYBOARD_SHORTCUTS.flatMap(s => s.keys)).not.toContain('n');
  });

  it('chaque préréglage (NOVA, Studio pro, FL Studio, Ableton Live) garde N au talkback, sans conflit', () => {
    for (const p of KEYMAP_PRESETS) {
      const map = resolvePreset(p);
      expect(map.find(s => s.id === 'nova.talkback')!.keys, p.id).toEqual(['n']);
      expect(map.filter(s => s.id !== 'nova.talkback' && (s.context === 'global' || s.context === 'focus') && s.keys.includes('n')).map(s => s.id), p.id).toEqual([]);
      expect(keymapConflicts(map).filter(c => c.chord === 'n'), p.id).toEqual([]);
    }
  });

  it('AZERTY et QWERTY (même touche physique), positions US : N déclenche le talkback ; Maj+N, Ctrl+N non', () => {
    expect(isShortcut({ key: 'n', code: 'KeyN' }, 'nova.talkback')).toBe(true);
    expect(isShortcut({ key: 'N', code: 'KeyN', shiftKey: true }, 'nova.talkback')).toBe(false);
    expect(isShortcut({ key: 'n', code: 'KeyN', ctrlKey: true }, 'nova.talkback')).toBe(false); // Ctrl+N : nouvelle fenêtre du navigateur
    expect(chordFromEvent({ key: 'n', code: 'KeyN' }, true)).toBe('n');
    keymapStore.setPreset('protools'); // positions US
    expect(isShortcut({ key: 'n', code: 'KeyN' }, 'nova.talkback')).toBe(true);
  });

  it('modifiable dans « Personnaliser les raccourcis » (ex. Alt+T), conflit signalé, remis par défaut', () => {
    keymapStore.assign('nova.talkback', 'alt+t', { replaceIndex: 0 });
    expect(keysOf('nova.talkback')).toEqual(['alt+t']);
    expect(isShortcut({ key: 't', code: 'KeyT', altKey: true }, 'nova.talkback')).toBe(true);
    expect(isShortcut({ key: 'n', code: 'KeyN' }, 'nova.talkback')).toBe(false);
    expect(shortcutHint('nova.talkback')).toBe('Alt + T');
    // Prendre la touche d'une autre commande signale le conflit (et peut la lui retirer).
    keymapStore.resetCommand('nova.talkback');
    expect(keysOf('nova.talkback')).toEqual(['n']);
    const touched = keymapStore.assign('nova.talkback', 'k', { replaceIndex: 0, resolve: 'steal' });
    expect(touched).toEqual(['nova.marker']);
    expect(keysOf('nova.marker')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
describe('talkback local : plan (voix, dim) et réglages', () => {
  it('ouvert : voix au niveau réglé, musique baissée du dim (−15 dB par défaut)', () => {
    const p = talkbackPlan({ open: true, recording: false, cueMixCount: 2, dimDb: DEFAULT_TALKBACK.dimDb, levelDb: 0 });
    expect(p.route).toBe('cue');
    expect(p.talkGain).toBe(1);
    expect(DEFAULT_TALKBACK.dimDb).toBe(-15);
    expect(20 * Math.log10(p.musicGain)).toBeCloseTo(-15, 6);
  });

  it('coupé : voix à 0, musique normale (rien ne change dans le casque)', () => {
    expect(talkbackPlan({ open: false, recording: false, cueMixCount: 1, dimDb: -15, levelDb: 6 })).toEqual({ route: 'cue', talkGain: 0, musicGain: 1 });
  });

  it('pendant une prise : jamais de voix du talkback (même ouvert), musique normale', () => {
    expect(talkbackPlan({ open: true, recording: true, cueMixCount: 1, dimDb: -15, levelDb: 0 })).toEqual({ route: 'cue', talkGain: 0, musicGain: 1 });
  });

  it('sans mix casque : la voix part sur la sortie d’écoute', () => {
    expect(talkbackPlan({ open: true, recording: false, cueMixCount: 0, dimDb: -15, levelDb: 0 }).route).toBe('main');
  });

  it('bornes : dim −60…0 dB, niveau −24…+12 dB, valeurs absurdes ramenées', () => {
    expect(talkbackPlan({ open: true, recording: false, cueMixCount: 0, dimDb: 20, levelDb: 0 }).musicGain).toBe(1);
    expect(talkbackPlan({ open: true, recording: false, cueMixCount: 0, dimDb: -100, levelDb: 0 }).musicGain).toBe(0);
    expect(talkbackPlan({ open: true, recording: false, cueMixCount: 0, dimDb: NaN, levelDb: 99 }).talkGain).toBeCloseTo(dbToGain(12), 9);
  });

  it('réglages gardés (micro, dim, niveau) et nettoyés', () => {
    talkbackSettingsStore.set({ deviceId: 'abc', dimDb: -20, levelDb: 3 });
    expect(talkbackSettingsStore.get()).toEqual({ deviceId: 'abc', dimDb: -20, levelDb: 3 });
    talkbackSettingsStore.set({ dimDb: 50 as number, levelDb: -99 });
    expect(talkbackSettingsStore.get().dimDb).toBe(0);
    expect(talkbackSettingsStore.get().levelDb).toBe(-24);
    talkbackSettingsStore.reset();
    expect(talkbackSettingsStore.get()).toEqual(DEFAULT_TALKBACK);
  });

  it('messages clairs (micro refusé, absent, pris) et infobulle avec la touche', () => {
    expect(talkbackMicError({ name: 'NotAllowedError' })).toMatch(/refusé.*Autorise/);
    expect(talkbackMicError({ name: 'NotFoundError' })).toMatch(/aucun micro/);
    expect(talkbackMicError({ name: 'NotReadableError' })).toMatch(/autre appli/);
    expect(talkbackTitle('N', false)).toMatch(/touche N.*appui court.*maintenu.*casque.*jamais dans le mix, l’export ni les prises/);
    expect(talkbackTitle('N', true)).toMatch(/en direct/);
    expect(talkingLabel(['Nina'])).toBe('🎙️ Nina te parle');
    expect(talkingLabel(['Nina', 'Max'])).toBe('🎙️ Nina, Max te parlent');
  });
});

// ---------------------------------------------------------------------------------------
// Graphe audio minimal (connexions + gains) pour suivre où va le son.
class FakeParam {
  private v = 1;
  /** Piloté par un signal (pan à la loi : table → gain de la matrice) : compté comme un gain positif. */
  driven = false;
  get value() { return this.driven ? 0.5 + this.v : this.v; }
  set value(x: number) { this.v = x; }
  setTargetAtTime(v: number) { this.v = v; }
  setValueAtTime(v: number) { this.v = v; }
}
class FakeNode {
  out = new Set<FakeNode>();
  gain = new FakeParam();
  pan = new FakeParam();
  offset = new FakeParam();
  curve: Float32Array | null = null;
  channelCount = 2; channelCountMode = 'max'; channelInterpretation = 'speakers';
  constructor(public name: string) {}
  connect(n: FakeNode | FakeParam) { if (n instanceof FakeParam) { n.driven = true; return n; } this.out.add(n); return n; }
  disconnect(n?: FakeNode | FakeParam) { if (n instanceof FakeParam) return; if (n) { if (!this.out.delete(n)) throw new Error('pas branché'); } else this.out.clear(); }
  start() { /* */ }
  stop() { /* */ }
}
class FakeCtx {
  currentTime = 0;
  nodes: FakeNode[] = [];
  private mk(kind: string) { const n = new FakeNode(`${kind}${this.nodes.length}`); this.nodes.push(n); return n; }
  createGain() { return this.mk('gain'); }
  createStereoPanner() { return this.mk('pan'); }
  // Pan à la loi (engine/panNode) : séparateur, matrice de gains, sources constantes, tables.
  createChannelSplitter() { return this.mk('split'); }
  createChannelMerger() { return this.mk('merge'); }
  createConstantSource() { return this.mk('const'); }
  createWaveShaper() { return this.mk('shaper'); }
}
/** Gain du chemin de `from` vers `to` (somme des chemins, produit des gains traversés ; 0 = pas relié). */
function pathGain(from: FakeNode, to: FakeNode, seen = new Set<FakeNode>()): number {
  if (from === to) return 1;
  if (seen.has(from)) return 0;
  seen.add(from);
  let g = 0;
  for (const n of from.out) g += n.gain.value * pathGain(n, to, new Set(seen));
  return g;
}

describe('routage du talkback local (engine/CueMixEngine) : casques seulement', () => {
  const mix = (id: string): CueMix => ({ id, name: id, levels: {}, master: 1, click: 0 } as unknown as CueMix);
  const setup = () => {
    const ctx = new FakeCtx();
    const eng = new CueMixEngine(ctx as unknown as AudioContext);
    const track = new FakeNode('voix-prefader');
    eng.sync([mix('a'), mix('b')], [{ id: 't1', volume: 1, pan: 0 } as any], () => track as unknown as AudioNode);
    return { ctx, eng, track, talk: eng.talkIn as unknown as FakeNode, listen: eng.listenOut as unknown as FakeNode };
  };

  it('la voix du talkback arrive dans CHAQUE mix casque', () => {
    const { eng, talk } = setup();
    talk.gain.value = 1;
    for (const id of ['a', 'b']) expect(pathGain(talk, eng.outputOf(id) as unknown as FakeNode)).toBeCloseTo(1, 9);
  });

  it('l’écoute d’un mix sur la sortie principale (régie) prend le mix AVANT la voix : pas de larsen', () => {
    const { eng, talk, listen, track } = setup();
    eng.setListen('a');
    expect(pathGain(talk, listen)).toBe(0);
    expect(pathGain(track, listen)).toBeGreaterThan(0);   // la musique, elle, s'y entend
  });

  it('dim : la musique du casque baisse de −15 dB pendant qu’on parle, la voix non ; retour à 1 après', () => {
    const { eng, talk, track } = setup();
    talk.gain.value = 1;
    const out = eng.outputOf('a') as unknown as FakeNode;
    const before = pathGain(track, out);
    eng.setDim(dbToGain(-15));
    expect(20 * Math.log10(pathGain(track, out) / before)).toBeCloseTo(-15, 6);
    expect(pathGain(talk, out)).toBeCloseTo(1, 9);
    eng.setDim(1);
    expect(pathGain(track, out)).toBeCloseTo(before, 9);
  });

  it('un mix ajouté après coup reçoit la voix et le dim en cours ; un mix retiré est débranché', () => {
    const { eng, talk, track } = setup();
    eng.setDim(0.5);
    eng.sync([mix('a'), mix('b'), mix('c')], [{ id: 't1', volume: 1, pan: 0 } as any], () => track as unknown as AudioNode);
    const c = eng.outputOf('c') as unknown as FakeNode;
    expect(pathGain(talk, c)).toBeGreaterThan(0);
    expect(eng.getDim()).toBe(0.5);
    const bOut = eng.outputOf('b') as unknown as FakeNode;
    eng.sync([mix('a')], [{ id: 't1', volume: 1, pan: 0 } as any], () => track as unknown as AudioNode);
    expect(eng.outputOf('b')).toBeNull();
    expect(talk.out.has(bOut)).toBe(false);
  });

  it('le moteur ne branche la voix que vers les casques ou la sortie d’écoute — jamais vers le master (export, mix diffusé)', () => {
    const src = readFileSync(path.resolve(__dirname, '../engine/AudioEngine.ts'), 'utf-8');
    const targets = Array.from(src.matchAll(/this\.talkIn\.connect\(([^;]+)\);/g)).map(m => m[1].trim());
    expect(targets).toEqual(["want === 'cue' ? this.cueEngine!.talkIn : this.mainOut"]);
    // Le mix diffusé en collaboration et le master sont pris AVANT mainOut : la voix n'y passe pas.
    expect(src).toMatch(/this\.masterAnalyzer\.connect\(this\.collabMixDest\)/);
    expect(src).toMatch(/this\.masterAnalyzer\.connect\(this\.mainSel\);\s*this\.mainSel\.connect\(this\.mainDim\);\s*this\.mainDim\.connect\(this\.mainOut\);/);
  });
});
