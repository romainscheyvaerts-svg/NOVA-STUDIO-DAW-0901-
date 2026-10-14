import { describe, expect, it } from 'vitest';
import { allPaletteActions, keymapActions, type PaletteAction } from '../utils/commandPalette';
import {
  buildChatCatalog, catalogText, summarizeStateForChat, planChatCalls, compactHistory, numberedTracks,
  CHAT_LIMITS, KNOWN_ACTIONS, type ChatCheckContext,
} from '../utils/chatTools';
import { recordChange, openUndoGroup, closeUndoGroup, type UndoHistory } from '../utils/undoHistory';
import { parseLocalCommand } from '../utils/novaCommands';
import { buildUserContent } from '../api/chat';
import { DAWState, TrackType } from '../types';
import { makeClip, makeState, makeTrack } from './helpers/fixtures';

/**
 * Nova, ingé son du chat : catalogue construit depuis la palette, état résumé et borné,
 * validation des appels d'outils, confirmation des actions sensibles, annulation groupée.
 */

const noop = () => {};
const pa = (id: string, label: string, group: string, extra: Partial<PaletteAction> = {}): PaletteAction => ({ id, label, group, run: noop, ...extra });

/** Extrait des actions du studio (App.tsx, buildPaletteActions) : même forme, mêmes ids. */
const STUDIO_ACTIONS: PaletteAction[] = [
  pa('nova.export', 'Exporter : mix, stems par piste ou par bus, voix seule', 'Fichier', { keywords: 'bounce export stems wav mp3' }),
  pa('nova.save', 'Sauvegarder le projet', 'Fichier'),
  pa('pal.bus', 'Nouveau bus (groupe de pistes)', 'Pistes', { keywords: 'bus aux sous-groupe' }),
  pa('pal.reverbReturn', 'Nouvelle piste de retour réverbe', 'Pistes', { keywords: 'retour reverb réverbe envoi send aux' }),
  pa('pal.pitch', 'Justesse note par note du clip', 'Voix', { disabledReason: 'Sélectionne d’abord un clip (clic dessus).' }),
  pa('pal.collab', 'Collaborer à distance (artiste, ingé, beatmaker)', 'Vues'),
  pa('pal.sendStudio', 'Envoyer au studio Make Music (projet, stems, notes, réservation)', 'Fichier'),
  pa('pal.loudness', 'Loudness du master (LUFS, true peak)', 'Mix', { keywords: 'lufs loudness true peak' }),
  pa('view.mixer', 'Console de mixage', 'Vues'),
  pa('pal.payExport', 'Payer l’export de ce projet', 'Fichier'),
];

function studio(over: Partial<DAWState> = {}): DAWState {
  const beat = makeTrack({ id: 'instrumental', name: 'Beat', instrumentId: 'cat-1', volume: 1 });
  const lead = makeTrack({ id: 'track-rec-main', name: 'Lead', volume: 0.8, clips: [makeClip({ id: 'c1' })] });
  const lead2 = makeTrack({ id: 'track-lead-2', name: 'Lead 2', volume: 0.8 });
  const backs = makeTrack({ id: 'track-backs', name: 'Backs', volume: 0.5 });
  const adlib = makeTrack({ id: 'track-adlib', name: 'Ad-libs', volume: 0.4 });
  const bus = makeTrack({ id: 'bus-voix', name: 'BUS VOIX', type: TrackType.BUS, sends: [] });
  const verb = makeTrack({ id: 'send-verb-short', name: 'REVERB', type: TrackType.SEND, sends: [] });
  return makeState([beat, lead, lead2, backs, adlib, bus, verb], over);
}

const ctx = (st = studio()): ChatCheckContext => ({ state: st, commands: buildChatCatalog(allPaletteActions(STUDIO_ACTIONS)) });

describe('catalogue des commandes : construit depuis la palette Ctrl+K', () => {
  const all = allPaletteActions(STUDIO_ACTIONS);
  const cat = buildChatCatalog(all);

  it('contient les actions du studio ET tous les raccourcis de la table (aucune liste en double)', () => {
    const keymap = keymapActions(new Set(STUDIO_ACTIONS.map(a => a.id)));
    expect(keymap.length).toBeGreaterThan(50);
    // (sauf la palette elle-même : l'ouvrir depuis le chat n'a pas de sens)
    for (const k of keymap) if (k.id !== 'nova.palette') expect(cat.some(c => c.id === k.id)).toBe(true);
    for (const s of STUDIO_ACTIONS) expect(cat.some(c => c.id === s.id)).toBe(true);
    // Pas de doublon : une action du studio masque le raccourci de même id.
    expect(new Set(cat.map(c => c.id)).size).toBe(cat.length);
  });

  it('une action ajoutée à la palette est aussitôt vue par Nova', () => {
    const plus = buildChatCatalog(allPaletteActions([...STUDIO_ACTIONS, pa('pal.nouveau', 'Gadget ajouté demain', 'Mix')]));
    expect(plus.find(c => c.id === 'pal.nouveau')).toMatchObject({ label: 'Gadget ajouté demain', ok: true });
  });

  it('dit si une action est disponible, et pourquoi sinon', () => {
    expect(cat.find(c => c.id === 'pal.pitch')).toMatchObject({ ok: false, why: 'Sélectionne d’abord un clip (clic dessus).' });
    expect(cat.find(c => c.id === 'pal.bus')).toMatchObject({ ok: true });
  });

  it('marque les actions sensibles (export, collaboration, envoi) et bloque le paiement', () => {
    const s = (id: string) => cat.find(c => c.id === id)!;
    expect(s('nova.export').sensitive).toBe(true);
    expect(s('pal.collab').sensitive).toBe(true);
    expect(s('pal.sendStudio').sensitive).toBe(true);
    expect(s('pal.bus').sensitive).toBe(false);
    expect(s('view.mixer').sensitive).toBe(false);
    expect(s('pal.payExport').blocked).toBe(true);
    // Lecture, annuler, zoom : jamais de confirmation.
    for (const id of ['nova.play', 'nova.undo', 'nova.redo']) if (cat.find(c => c.id === id)) expect(s(id).sensitive).toBe(false);
  });

  it('extrait compact pour le modèle : le plus pertinent d’abord, borné, jamais le paiement', () => {
    const txt = catalogText(cat, 'ouvre la loudness du master en lufs', 1200);
    expect(txt.length).toBeLessThanOrEqual(1200);
    expect(txt.split('\n')[0]).toMatch(/^pal\.loudness \| Loudness du master/);
    expect(txt).toMatch(/autres commandes non listées/);
    expect(txt).not.toMatch(/pal\.payExport/);
    expect(catalogText(cat, 'justesse')).toMatch(/pal\.pitch \| .* \| ✗ Sélectionne d’abord un clip/);
    expect(catalogText(cat, 'exporter')).toMatch(/nova\.export .*⚠ confirmation/);
    expect(catalogText(cat, 'x', CHAT_LIMITS.catalogChars).length).toBeLessThanOrEqual(CHAT_LIMITS.catalogChars);
  });
});

describe('état du projet résumé et borné', () => {
  it('pistes avec type, rôle, volume en dB, pan, envois et réglages principaux des effets', () => {
    const st = studio({ selectedTrackId: 'track-rec-main', bpm: 140, projectKey: 9, projectScale: 'MINOR' });
    st.tracks[1].plugins = [
      { id: 'c', name: 'C', type: 'COMPRESSOR', isEnabled: true, latency: 0, params: { ratio: 2, threshold: -18, attack: 0.01, release: 0.12, makeupGain: 1 } },
      { id: 'e', name: 'E', type: 'PROEQ12', isEnabled: true, latency: 0, params: { bands: [{ type: 'highpass', frequency: 80, gain: 0, isEnabled: true }, { type: 'peaking', frequency: 300, gain: -3, isEnabled: true }, { type: 'lowpass', frequency: 18000, isEnabled: false }] } },
    ];
    st.tracks[1].pan = 0;
    st.tracks[3].pan = -0.4;
    const o = summarizeStateForChat(st, { currentTime: 12.345, mode: 'avancé' });
    expect(o).toMatchObject({ bpm: 140, key: { root: 9, scale: 'MINOR' }, selectedTrackId: 'track-rec-main', time: 12.35, mode: 'avancé' });
    const lead = o.tracks.find((t: any) => t.id === 'track-rec-main');
    expect(lead).toMatchObject({ n: 2, name: 'Lead', type: 'AUDIO', role: 'lead', volDb: -1.9 });
    expect(lead.fx[0]).toMatchObject({ type: 'COMPRESSOR', ratio: 2, thrDb: -18, attMs: 10, relMs: 120 });
    expect(lead.fx[1]).toMatchObject({ type: 'PROEQ12', hpfHz: 80, bells: ['300Hz -3dB'] });
    expect(lead.fx[1].lpfHz).toBeUndefined();
    expect(o.tracks.find((t: any) => t.id === 'track-backs')).toMatchObject({ role: 'back', pan: -0.4 });
    expect(lead.sends).toEqual([{ id: 'send-verb-short', lvl: 0.1 }, { id: 'send-delay', lvl: 0 }]);
    // Numéros « à l'écran » : sans les retours d'effets.
    expect(numberedTracks(st).map(t => t.id)).not.toContain('send-verb-short');
  });

  it('grosse séance (64 pistes et plus) : résumée et sous la limite', () => {
    const tracks = [
      makeTrack({ id: 'track-rec-main', name: 'Lead' }),
      ...Array.from({ length: 90 }, (_, i) => makeTrack({ id: `inst-${i}`, name: `Synthé ${i}`, type: TrackType.MIDI,
        plugins: [{ id: `p${i}`, name: 'C', type: 'COMPRESSOR', isEnabled: true, latency: 0, params: { ratio: 4, threshold: -20 } }] })),
    ];
    const o = summarizeStateForChat(makeState(tracks), {}, CHAT_LIMITS.stateChars);
    expect(JSON.stringify(o).length).toBeLessThanOrEqual(CHAT_LIMITS.stateChars);
    expect(o.summarized).toBe(true);
    expect(o.trackCount).toBe(91);
    expect(o.tracks.map((t: any) => t.id)).toContain('track-rec-main');
    expect(o.otherTracks.length).toBeGreaterThan(10);
  });

  it('même un projet énorme tient dans la limite (troncature annoncée)', () => {
    const tracks = Array.from({ length: 300 }, (_, i) => makeTrack({ id: `voix-${i}`, name: `Voix numéro ${i} très longue`, clips: [makeClip()] }));
    const o = summarizeStateForChat(makeState(tracks), {}, 3000);
    expect(JSON.stringify(o).length).toBeLessThanOrEqual(3000);
    expect(o.truncated).toBe(true);
  });
});

describe('validation des appels d’outils', () => {
  it('action inconnue, commande inconnue, piste introuvable : refusées avec la raison', () => {
    const plan = planChatCalls([
      { action: 'FORMAT_DISK', payload: {} },
      { action: 'RUN_COMMAND', payload: { id: 'pal.nexistepas' } },
      { action: 'SET_VOLUME', payload: { trackId: 'piste-fantome', volume: 0.5 } },
      { action: 'UPDATE_PLUGIN', payload: { trackId: 'Lead', pluginType: 'SSL_BUS_COMP', params: {} } },
      { action: 'SET_SEND_LEVEL', payload: { trackId: 'track-rec-main', sendId: 'send-inconnu', level: 0.3 } },
      { action: 'DELETE_CLIP', payload: { trackId: 'track-rec-main', clipId: 'zzz' } },
    ], ctx());
    expect(plan.run).toHaveLength(0);
    expect(plan.ask).toHaveLength(0);
    expect(plan.rejected.map(r => r.reason)).toEqual([
      'action « FORMAT_DISK » inconnue de NOVA',
      'commande « pal.nexistepas » inconnue (elle n\'est pas dans la palette Ctrl+K)',
      'piste « piste-fantome » introuvable',
      'effet « SSL_BUS_COMP » inconnu de NOVA',
      'pas d\'envoi « send-inconnu » sur Lead',
      'clip « zzz » introuvable sur Lead',
    ]);
  });

  it('commande indisponible : refusée avec la raison de la palette', () => {
    const plan = planChatCalls([{ action: 'RUN_COMMAND', payload: { id: 'pal.pitch' } }], ctx());
    expect(plan.rejected[0]).toMatchObject({ label: 'Justesse note par note du clip', reason: 'Sélectionne d’abord un clip (clic dessus).' });
  });

  it('le chat ne paie jamais', () => {
    const plan = planChatCalls([{ action: 'RUN_COMMAND', payload: { id: 'pal.payExport' } }, { action: 'PAY_EXPORT', payload: {} }], ctx(), { confirmed: true });
    expect(plan.run).toHaveLength(0);
    expect(plan.rejected.every(r => /jamais de paiement/.test(r.reason))).toBe(true);
  });

  it('valeurs bornées (volume, pan, envoi, tempo, effets) et unités d’ingé traduites', () => {
    const plan = planChatCalls([
      { action: 'SET_VOLUME', payload: { trackId: 'Lead', volume: 9 } },
      { action: 'SET_VOLUME', payload: { trackId: 'track-backs', volumeDb: -6 } },
      { action: 'SET_PAN', payload: { trackId: '4', pan: -3 } },
      { action: 'SET_SEND_LEVEL', payload: { trackId: 'track-adlib', sendId: 'send-delay', level: 2 } },
      { action: 'SET_BPM', payload: { bpm: 999 } },
      { action: 'UPDATE_PLUGIN', payload: { trackId: 'track-backs', pluginType: 'COMPRESSOR', params: { threshold: -200, attackMs: 10, makeupDb: 6, inventé: 3 } } },
    ], ctx());
    expect(plan.rejected).toHaveLength(0);
    const p = plan.run.map(c => c.action.payload);
    expect(p[0].volume).toBe(1.5);
    expect(p[1].volume).toBeCloseTo(0.5, 2);
    expect(p[2]).toMatchObject({ trackId: 'track-backs', pan: -1 });
    expect(p[3].level).toBe(1);
    expect(p[4].bpm).toBe(300);
    expect(p[5].params).toMatchObject({ threshold: -60, attack: 0.01 });
    expect(p[5].params.makeupGain).toBeCloseTo(2, 2);
    expect(p[5].params.inventé).toBeUndefined();
    expect(plan.run[5].notes.join(' ')).toMatch(/inventé.*inconnu/);
    expect(plan.run[1].label).toBe('Volume de Backs : −6 dB');
    expect(plan.run[2].label).toBe('Pan de Backs : 100 % G');
  });

  it('règle maison : compresseur voix en 2:1 (même si le modèle demande 4:1), compte rendu lisible', () => {
    const plan = planChatCalls([{ action: 'UPDATE_PLUGIN', payload: { trackId: 'track-rec-main', pluginType: 'COMPRESSOR', params: { ratio: 4, threshold: -18 } } }], ctx());
    expect(plan.run[0].action.payload.params.ratio).toBe(2);
    expect(plan.run[0].label).toBe('Compresseur ajouté sur Lead : 2:1, seuil −18 dB');
    expect(plan.run[0].notes[0]).toMatch(/règle maison/);
    // Sur un bus, le ratio demandé reste (FET 76 bus voix en 4:1).
    const bus = planChatCalls([{ action: 'UPDATE_PLUGIN', payload: { trackId: 'bus-voix', pluginType: 'FET76', params: { ratio: 4 } } }], ctx());
    expect(bus.run[0].action.payload.params.ratio).toBe(4);
  });

  it('EQ : « coupe-bas 200 + coupe-haut 15 kHz » traduits en bandes, le reste de l’EQ gardé', () => {
    const plan = planChatCalls([{ action: 'UPDATE_PLUGIN', payload: { trackId: 'track-backs', pluginType: 'PROEQ12', params: { hpf: 200, lpf: 15000, bells: [{ freq: 320, gain: -3, q: 1.4 }] } } }], ctx());
    const bands = plan.run[0].action.payload.params.bands;
    expect(bands).toHaveLength(12);
    expect(bands[0]).toMatchObject({ type: 'highpass', frequency: 200, isEnabled: true });
    expect(bands[11]).toMatchObject({ type: 'lowpass', frequency: 15000, isEnabled: true });
    expect(bands.find((b: any) => b.frequency === 320)).toMatchObject({ gain: -3, q: 1.4, type: 'peaking' });
    expect(plan.run[0].label).toBe('EQ ajouté sur Backs : coupe-bas 200 Hz, coupe-haut 15 kHz, 320 Hz −3 dB');
  });

  it('réverbe demandée sur une voix : annoncée en envoi', () => {
    const plan = planChatCalls([{ action: 'UPDATE_PLUGIN', payload: { trackId: 'track-rec-main', pluginType: 'REVERB', params: { decay: 1.4, mix: 0.2 } } }], ctx());
    expect(plan.run[0].label).toBe('Réverbe en envoi sur Lead : 1,4 s, mix 20 %');
  });

  it('16 appels au plus par message', () => {
    const many = Array.from({ length: 20 }, () => ({ action: 'PLAY', payload: {} }));
    const plan = planChatCalls(many, ctx());
    expect(plan.run).toHaveLength(CHAT_LIMITS.maxCalls);
    expect(plan.rejected[0].reason).toMatch(/16 actions au plus/);
  });

  it('toutes les actions de l’ancien catalogue restent connues (alignement avec App.tsx)', () => {
    for (const a of ['SET_VOLUME', 'UPDATE_PLUGIN', 'APPLY_MIX_STYLE', 'PREPARE_PART', 'ANALYZE_MIX', 'VST_MIX', 'SET_AUTOMATION', 'GOTO_SECTION', 'HIGHLIGHT'])
      expect(KNOWN_ACTIONS.has(a)).toBe(true);
  });
});

describe('confirmation obligatoire des actions sensibles', () => {
  const sensibles = [
    { action: 'DELETE_TRACK', payload: { trackId: '3' } },
    { action: 'DELETE_CLIP', payload: { trackId: 'track-rec-main', clipId: 'c1' } },
    { action: 'RESET_FX', payload: {} },
    { action: 'OPEN_EXPORT', payload: { format: 'mp3' } },
    { action: 'OPEN_SHARE', payload: {} },
    { action: 'OPEN_STUDIO_OFFER', payload: { offer: 'beat' } },
    { action: 'RUN_COMMAND', payload: { id: 'nova.export' } },
    { action: 'RUN_COMMAND', payload: { id: 'pal.collab' } },
    { action: 'RUN_COMMAND', payload: { id: 'pal.sendStudio' } },
  ];

  it('sans « Oui, fais-le » : rien n’est exécuté, tout attend', () => {
    const plan = planChatCalls(sensibles, ctx());
    expect(plan.run).toHaveLength(0);
    expect(plan.rejected).toHaveLength(0);
    expect(plan.ask).toHaveLength(sensibles.length);
    expect(plan.ask[0].label).toBe('Piste Lead 2 supprimée');
    expect(plan.ask[0].confirm).toBe('supprime la piste Lead 2');
    expect(plan.ask[0].action.payload.trackId).toBe('track-lead-2');
  });

  it('après « Oui, fais-le » : exécuté', () => {
    const plan = planChatCalls(sensibles, ctx(), { confirmed: true });
    expect(plan.run).toHaveLength(sensibles.length);
    expect(plan.ask).toHaveLength(0);
  });

  it('les gestes de mix courants ne demandent rien', () => {
    const plan = planChatCalls([
      { action: 'SET_VOLUME', payload: { trackId: 'Lead', volumeDb: -3 } },
      { action: 'UPDATE_PLUGIN', payload: { trackId: 'Lead', pluginType: 'DEESSER', params: { frequency: 8000 } } },
      { action: 'RUN_COMMAND', payload: { id: 'pal.bus' } },
      { action: 'SELECT_TRACK', payload: { trackId: 'Backs' } },
      { action: 'PLAY', payload: {} },
    ], ctx());
    expect(plan.ask).toHaveLength(0);
    expect(plan.run).toHaveLength(5);
  });

  it('un mélange : le sûr part tout de suite, le sensible attend', () => {
    const plan = planChatCalls([{ action: 'SET_PAN', payload: { trackId: 'Backs', pan: 0.3 } }, { action: 'DELETE_TRACK', payload: { trackId: 'Ad-libs' } }], ctx());
    expect(plan.run.map(c => c.action.action)).toEqual(['SET_PAN']);
    expect(plan.ask.map(c => c.action.action)).toEqual(['DELETE_TRACK']);
  });
});

describe('annulation groupée par message', () => {
  const opts = { debounceMs: 300, limit: 256, clean: (s: number) => s };

  it('sans groupe : des gestes espacés font chacun une étape', () => {
    let h: UndoHistory<number> = { past: [], present: 0, future: [] };
    for (let i = 1; i <= 4; i++) h = recordChange(h, i, i * 1000, opts);
    expect(h.past).toEqual([0, 1, 2, 3]);
  });

  it('avec groupe : tout ce que Nova fait pour un message = UNE étape (un Ctrl+Z revient avant le message)', () => {
    let h: UndoHistory<number> = { past: [], present: 0, future: [] };
    h = recordChange(h, 1, 1000, opts); // geste de l'artiste avant le message
    h = openUndoGroup(h);
    for (let i = 2; i <= 6; i++) h = recordChange(h, i, 1000 + i * 2000, opts); // 5 actions de Nova, espacées
    h = closeUndoGroup(h);
    expect(h.past).toEqual([0, 1]);
    expect(h.present).toBe(6);
    // Un seul « annuler » ramène l'état d'avant le message.
    expect(h.past[h.past.length - 1]).toBe(1);
    // Le geste suivant repart sur une nouvelle étape (même tout de suite après).
    h = recordChange(h, 7, 13001, opts);
    expect(h.past).toEqual([0, 1, 6]);
  });

  it('groupe sans aucune modification : aucune étape vide', () => {
    let h: UndoHistory<number> = { past: [5], present: 6, future: [] };
    h = closeUndoGroup(openUndoGroup(h));
    expect(h.past).toEqual([5]);
  });
});

describe('gestes d’ingé compris sans l’IA', () => {
  const st = studio();
  it('« coupe-bas à 80 sur les leads » : EQ sur toutes les leads', () => {
    const r = parseLocalCommand('coupe-bas à 80 sur les leads', st)!;
    expect(r.actions.map(a => a.payload.trackId)).toEqual(['track-rec-main', 'track-lead-2']);
    expect(r.actions[0]).toMatchObject({ action: 'UPDATE_PLUGIN', payload: { pluginType: 'PROEQ12', params: { hpf: 80 } } });
  });
  it('« coupe-bas à 200 et coupe-haut à 15k sur les backs »', () => {
    const r = parseLocalCommand('coupe-bas à 200 et coupe-haut à 15k sur les backs', st)!;
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0].payload).toMatchObject({ trackId: 'track-backs', params: { hpf: 200, lpf: 15000 } });
  });
  it('« supprime la piste 3 » : numéro à l’écran, confirmation ensuite', () => {
    const r = parseLocalCommand('supprime la piste 3', st)!;
    expect(r.actions[0]).toMatchObject({ action: 'DELETE_TRACK', payload: { trackId: 'track-lead-2' } });
    expect(planChatCalls(r.actions, ctx(st)).ask).toHaveLength(1);
    expect(parseLocalCommand('supprime la piste 42', st)!.actions).toHaveLength(0);
  });
  it('« exporte en MP3 » : ouvre l’export après confirmation, jamais de paiement', () => {
    const r = parseLocalCommand('exporte en MP3', st)!;
    expect(r.actions[0]).toMatchObject({ action: 'OPEN_EXPORT', payload: { format: 'mp3' } });
    expect(r.text).toMatch(/c'est toi qui valides le paiement/);
    expect(planChatCalls(r.actions, ctx(st)).ask).toHaveLength(1);
  });
  it('« mets un compresseur 2:1 sur la voix lead » part à l’IA (réglage d’ingé)', () => {
    expect(parseLocalCommand('mets un compresseur 2:1 sur la voix lead', st)).toBeNull();
  });
});

describe('contexte envoyé au modèle (paliers gratuits)', () => {
  it('borné : état, catalogue et échanges tronqués', () => {
    const big = { message: 'mets un compresseur', state: { x: 'a'.repeat(50000) }, catalog: 'b'.repeat(20000),
      history: Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'c'.repeat(300) })) };
    const u = buildUserContent(big);
    expect(u.length).toBeLessThan(8000 + 4000 + 1600 + 600);
    expect(u).toMatch(/tronqué/);
    expect(u).toMatch(/Demande de l'artiste : mets un compresseur$/);
  });
  it('historique compacté côté client', () => {
    const h = compactHistory(Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i} `.repeat(30) })));
    expect(h.length).toBeLessThanOrEqual(8);
    expect(h.reduce((n, m) => n + m.text.length, 0)).toBeLessThanOrEqual(CHAT_LIMITS.historyChars);
    expect(h[h.length - 1].text).toMatch(/^message 19/);
  });
});
