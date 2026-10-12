import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fmtParamValue, writableParams, writeAllToRange, writeParamToRange, writeValueOnRange } from '../utils/automationWriteTo';
import { valueAtPoints } from '../utils/automationWrite';
import { exclusiveSolo, newlySoloed, soloModeStore } from '../utils/soloModes';
import { batchBlocker, batchPlan, batchSummary } from '../utils/batchRender';
import { clipGainWheel, isClipGainWheel, resetClipGainWheel, WHEEL_NOTCH_PX, wheelToDb } from '../utils/clipGainWheel';
import { editSelectionStore } from '../utils/editSelection';
import { registerEditCommands } from '../utils/editCommands';
import { dropModeOf, insertCopyMenuItems, transferInsert, transferSend } from '../utils/insertCopy';
import { KEYMAP } from '../utils/keymap';
import { keymapConflicts as findConflicts, presetById, resolvePreset } from '../utils/keymapStore';
import type { PluginInstance, Track } from '../types';
import { makeClip, makeTrack } from './helpers/fixtures';

const v = (pts: { time: number; value: number }[], t: number) => valueAtPoints(pts as any, t, NaN);

describe('écrire l’automation sur la sélection (Write to Current / All Enabled)', () => {
  it('palier sur la plage, rampes de 10 ms, le reste de la courbe ne bouge pas', () => {
    const before = [{ id: 'a', time: 0, value: 0.5 }, { id: 'b', time: 20, value: 1 }];
    const pts = writeValueOnRange(before, 8, 12, 0.25, 1);
    expect(v(pts, 0)).toBeCloseTo(0.5);
    expect(v(pts, 7.98)).toBeCloseTo(valueAtPoints(before as any, 7.98, 1), 5);
    expect(v(pts, 8)).toBe(0.25);
    expect(v(pts, 10)).toBe(0.25);
    expect(v(pts, 12)).toBe(0.25);
    expect(v(pts, 12.02)).toBeCloseTo(valueAtPoints(before as any, 12.02, 1), 5);
    expect(v(pts, 20)).toBe(1);
  });

  it('volume : la valeur du fader est écrite, la voie est créée et dépliée', () => {
    const t = makeTrack({ volume: 0.5 });
    const r = writeParamToRange(t, 'volume', 4, 6);
    expect(r.params).toEqual(['volume']);
    const lane = r.track.automationLanes.find(l => l.parameterName === 'volume')!;
    expect(lane.isExpanded).toBe(true);
    expect(v(lane.points, 5)).toBe(0.5);
    expect(v(lane.points, 0)).toBe(0.5); // sans courbe avant : le réglage statique
  });

  it('plage vide ou réglage absent : rien n’est écrit', () => {
    const t = makeTrack();
    expect(writeParamToRange(t, 'volume', 3, 3).params).toEqual([]);
    expect(writeParamToRange(t, 'send::inconnu', 0, 2).params).toEqual([]);
  });

  it('tous les réglages : volume + chaque voie qui a déjà une courbe (envoi, pan), à leur valeur actuelle', () => {
    const t = makeTrack({ volume: 0.7, pan: -0.4,
      automationLanes: [
        { id: 'p', parameterName: 'pan', points: [{ id: 'x', time: 0, value: 0.3 }], color: '#fff', isExpanded: false, min: -1, max: 1 },
        { id: 's', parameterName: 'send::send-delay', points: [{ id: 'y', time: 0, value: 0.2 }], color: '#fff', isExpanded: false, min: 0, max: 1.5 },
      ] });
    const r = writeAllToRange(t, 1, 2);
    expect(r.params.sort()).toEqual(['pan', 'send::send-delay', 'volume']);
    const at = (name: string) => v(r.track.automationLanes.find(l => l.parameterName === name)!.points, 1.5);
    expect(at('pan')).toBeCloseTo(-0.4);
    expect(at('send::send-delay')).toBe(0);   // niveau actuel de l'envoi
    expect(at('volume')).toBeCloseTo(0.7);
    expect(writableParams(t).map(p => p.param)).toEqual(['volume', 'pan', 'send::send-verb-short', 'send::send-delay']);
    expect(fmtParamValue('volume', 0.5)).toBe('−6,0 dB');
    expect(fmtParamValue('pan', -0.3)).toBe('G 30');
  });
});

describe('solo X-OR (Options › Mode Solo)', () => {
  it('un nouveau solo annule les précédents ; master et pistes du geste intactes', () => {
    const ts = [makeTrack({ id: 'a', isSolo: true }), makeTrack({ id: 'b', isSolo: true }), makeTrack({ id: 'c' }), makeTrack({ id: 'master', isSolo: true })];
    const r = exclusiveSolo(ts, ['b']);
    expect(r.filter(t => t.isSolo).map(t => t.id)).toEqual(['b', 'master']);
    expect(exclusiveSolo(ts, [])).toBe(ts);
    expect(newlySoloed(ts.map(t => ({ ...t, isSolo: false })), ts)).toEqual(['a', 'b']);
  });

  it('le mode est un réglage du poste (prévient les abonnés), Verrouiller par défaut', () => {
    expect(soloModeStore.get()).toBe('latch');
    let n = 0;
    const off = soloModeStore.subscribe(() => { n++; });
    soloModeStore.set('xor');
    soloModeStore.set('xor');
    expect(soloModeStore.get()).toBe('xor');
    soloModeStore.set('latch');
    off();
    expect(n).toBe(2);
  });
});

describe('Commit / gel en lot', () => {
  const ts = (): Track[] => [
    makeTrack({ id: 'lead', name: 'Lead', clips: [makeClip()] }),
    makeTrack({ id: 'vide', name: 'Vide' }),
    makeTrack({ id: 'gel', name: 'Gelée', isFrozen: true, clips: [makeClip()] }),
    makeTrack({ id: 'bus', name: 'Bus', type: 'BUS' as any }),
    makeTrack({ id: 'master', name: 'Master', type: 'BUS' as any }),
  ];

  it('plan : pistes traitées dans l’ordre de la session, les autres expliquées', () => {
    const p = batchPlan(ts(), ['gel', 'lead', 'vide', 'bus', 'master'], 'freeze');
    expect(p.todo).toEqual(['lead']);
    expect(p.skipped.map(s => `${s.id}:${s.why}`)).toEqual(['vide:piste vide', 'gel:déjà gelée', 'bus:piste vide', 'master:le master']);
    expect(batchPlan(ts(), ['gel', 'lead'], 'unfreeze').todo).toEqual(['gel']);
    expect(batchPlan(ts(), ['lead', 'bus'], 'commit').todo).toEqual(['lead']);
    expect(batchBlocker(ts()[3], 'commit')).toBe('un bus ou le beat');
  });

  it('messages clairs', () => {
    const p = batchPlan(ts(), ['lead', 'vide'], 'commit');
    expect(batchSummary('commit', p, 1, [])).toMatch(/^✅ 1 piste commitée sur 1\..*Restaurer la piste d’origine.*Laissée : « Vide » \(piste vide\)/);
    expect(batchSummary('freeze', batchPlan(ts(), [], 'freeze'), 0, [])).toMatch(/Aucune piste/);
    expect(batchSummary('freeze', batchPlan(ts(), ['lead'], 'freeze'), 0, ['Lead'])).toMatch(/Échec : « Lead »/);
  });
});

describe('gain de clip à la molette (Ctrl+Maj+molette)', () => {
  beforeEach(() => { resetClipGainWheel(); editSelectionStore.set({ clipIds: [], time: null, focusTrackId: null }); });

  it('un cran = 0,5 dB, haut = plus fort ; un pavé tactile s’additionne', () => {
    expect(isClipGainWheel({ ctrlKey: true, shiftKey: true })).toBe(true);
    expect(isClipGainWheel({ ctrlKey: true })).toBe(false);
    expect(wheelToDb(0, { deltaY: -WHEEL_NOTCH_PX })).toEqual({ db: 0.5, rest: 0 });
    expect(wheelToDb(0, { deltaY: 2 * WHEEL_NOTCH_PX })).toEqual({ db: -1, rest: 0 });
    let r = wheelToDb(0, { deltaY: -40 });
    expect(r.db).toBe(0);
    r = wheelToDb(r.rest, { deltaY: -70 });
    expect(r.db).toBe(0.5);
    expect(r.rest).toBeCloseTo(10);
    // Maj : certains navigateurs passent le défilement en deltaX.
    expect(wheelToDb(0, { deltaY: 0, deltaX: -100 }).db).toBe(0.5);
    // Lignes (Firefox).
    expect(wheelToDb(0, { deltaY: -3, deltaMode: 1 }).db).toBe(0.5);
  });

  it('les crans rapprochés font UN réglage, sur le clip sous la souris (sélectionné au passage)', async () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    const off = registerEditCommands({ clipGainNudge: (a?: { db?: number }) => { calls.push(a!.db!); return true; } });
    const clip = { id: 'k', start: 0, duration: 4 };
    for (let i = 0; i < 3; i++) clipGainWheel('lead', clip, { deltaY: -100 });
    expect(editSelectionStore.get().clipIds).toEqual(['k']);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(calls).toEqual([1.5]);
    // Clip dans la plage sélectionnée : la plage reste (le gain s'applique à la plage).
    editSelectionStore.set({ time: { start: 1, end: 2, trackIds: ['lead'] }, clipIds: [] });
    clipGainWheel('lead', clip, { deltaY: 100 });
    vi.advanceTimersByTime(200);
    expect(editSelectionStore.get().time).not.toBeNull();
    expect(calls).toEqual([1.5, -0.5]);
    off();
    vi.useRealTimers();
  });
});

describe('inserts et envois d’une tranche à l’autre (glisser / Alt+glisser)', () => {
  const comp: PluginInstance = { id: 'fx1', type: 'COMPRESSOR' as any, name: 'Comp', isEnabled: true, params: { threshold: -18, ratio: 4 } } as any;
  const ts = (): Track[] => [
    makeTrack({ id: 'lead', plugins: [comp], sends: [{ id: 'send-verb', level: 0.6, isEnabled: true, preFader: true }] }),
    makeTrack({ id: 'back', plugins: [{ ...comp, id: 'fx0', name: 'EQ' }], sends: [{ id: 'send-verb', level: 0, isEnabled: true }] }),
    makeTrack({ id: 'send-verb', type: 'SEND' as any }),
    makeTrack({ id: 'vca', isVca: true }),
  ];

  it('Pro Tools : glisser = déplacer, Alt = copier ; NOVA : copier', () => {
    expect(dropModeOf(false, 'protools')).toBe('move');
    expect(dropModeOf(true, 'protools')).toBe('copy');
    expect(dropModeOf(false, 'nova')).toBe('copy');
  });

  it('copier un insert : nouvel identifiant, réglages recopiés, à la place visée ; déplacer le retire', () => {
    const c = transferInsert(ts(), 'lead', 'fx1', 'back', { index: 0 });
    const back = c.tracks.find(t => t.id === 'back')!;
    expect(back.plugins.map(p => p.name)).toEqual(['Comp', 'EQ']);
    expect(back.plugins[0].id).not.toBe('fx1');
    expect(back.plugins[0].params).toEqual(comp.params);
    expect(back.plugins[0].params).not.toBe(comp.params);
    expect(c.tracks.find(t => t.id === 'lead')!.plugins).toHaveLength(1);
    const m = transferInsert(ts(), 'lead', 'fx1', 'back', { move: true });
    expect(m.tracks.find(t => t.id === 'lead')!.plugins).toHaveLength(0);
    expect(m.tracks.find(t => t.id === 'back')!.plugins.map(p => p.id)).toEqual(['fx0', 'fx1']);
    expect(transferInsert(ts(), 'lead', 'fx1', 'vca').ok).toBe(false);
    expect(transferInsert(ts(), 'lead', 'fx1', 'lead').ok).toBe(false);
  });

  it('copier un envoi : niveau et pré-fader repris ; déplacer remet l’original à zéro ; jamais vers le bus lui-même', () => {
    const c = transferSend(ts(), 'lead', 'send-verb', 'back');
    expect(c.tracks.find(t => t.id === 'back')!.sends[0]).toMatchObject({ id: 'send-verb', level: 0.6, preFader: true });
    const m = transferSend(ts(), 'lead', 'send-verb', 'back', { move: true });
    expect(m.tracks.find(t => t.id === 'lead')!.sends[0].level).toBe(0);
    expect(transferSend(ts(), 'lead', 'send-verb', 'send-verb').ok).toBe(false);
    // Destination sans cet envoi : il est ajouté.
    const n = transferSend([...ts(), makeTrack({ id: 'dbl', sends: [] })], 'lead', 'send-verb', 'dbl');
    expect(n.tracks.find(t => t.id === 'dbl')!.sends).toEqual([{ id: 'send-verb', level: 0.6, isEnabled: true, preFader: true }]);
  });

  it('menu de l’insert (tablette) : « Copier vers … » pour les autres tranches', () => {
    const all = ts();
    const applied: string[] = [];
    const items = insertCopyMenuItems(all[0], comp, all, (fn, label) => { fn(all); applied.push(label); });
    expect(items.map(i => i.label)).toEqual(['Copier vers « Piste »', 'Copier vers « Piste »']);
    items[0].onClick();
    expect(applied[0]).toMatch(/copié/);
  });
});

describe('raccourcis : Pro Tools dans son préréglage, NOVA intact, tout dans Ctrl+K', () => {
  const ids = ['pt.playlistNew', 'pt.playlistDuplicate', 'pt.playlistPrev', 'pt.playlistNext', 'pt.playlistRecent', 'pt.writeCurrent', 'pt.writeAll', 'pt.writePan', 'pt.soloXor', 'pt.soloLatch', 'pt.batchRender', 'pt.freezeSelected', 'pt.unfreezeSelected'];

  it('chaque commande a un libellé français et une commande (donc une entrée de la palette)', () => {
    for (const id of ids) {
      const d = KEYMAP.find(x => x.id === id);
      expect(d, id).toBeTruthy();
      expect(d!.command, id).toBeTruthy();
      expect(d!.label.length, id).toBeGreaterThan(10);
    }
  });

  it('préréglage Pro Tools : Ctrl+\\, Ctrl+Alt+\\, Maj+↑ / ↓ / ←, Ctrl+/ ; aucun conflit', () => {
    const pt = resolvePreset(presetById('protools'));
    const k = (id: string) => pt.find(d => d.id === id)!.keys;
    expect(k('pt.playlistNew')).toEqual(['ctrl+\\']);
    expect(k('pt.playlistDuplicate')).toEqual(['ctrl+alt+\\']);
    expect(k('pt.playlistPrev')).toEqual(['shift+arrowup']);
    expect(k('pt.playlistNext')).toEqual(['shift+arrowdown']);
    expect(k('pt.playlistRecent')).toEqual(['shift+arrowleft']);
    expect(k('pt.writeCurrent')).toEqual(['ctrl+/']);
    expect(k('pt.batchRender')).toEqual(['alt+shift+c']);
    expect(findConflicts(pt)).toEqual([]);
  });

  it('préréglage NOVA : rien d’ancien n’a changé, pas de flèche avec Maj prise par les playlists', () => {
    const nova = resolvePreset(presetById('nova'));
    const k = (id: string) => nova.find(d => d.id === id)!.keys;
    expect(k('pt.playlistRecent')).toEqual([]);
    expect(k('pt.playlistPrev')).toEqual([]);
    expect(k('pt.soloSelected')).toEqual(['shift+s']);
    expect(findConflicts(nova)).toEqual([]);
  });
});
