"""R9 · Automation des VST du PC : preuves sur le VRAI moteur de NOVA (Chrome headless, aucune
fenêtre) avec le VRAI pont de ce dépôt et les vrais plugins (FabFilter), à 48 kHz.

 A. Pro-C 3 : seuil automatisé 0 dB → −30 dB à 2,000 s (palier), sinus 997 Hz à −6 dBFS.
 B. Pro-Q 4 : fréquence de la bande 1 (cloche +12 dB, Q 4) 500 Hz → 4 kHz à 2,000 s, sinus 4 kHz.
Pour chacun :
  - export : chaîne d'export de NOVA (prepareTracksForOffline → rendu du VST par le pont avec
    son automation → renderProject) ; instant où le changement est ENTENDU ;
  - lecture : le VST joue en temps réel par le pont (worklet + pré-tampon + PDC), sortie du
    master captée par un AudioWorklet témoin ; même mesure ;
  - export = lecture : écart entre les deux sorties (alignées sur le temps du morceau).
 C. Écriture Touch simulée : piste en Touch, lecture ; un geste « dans la fenêtre » de Pro-C 3
    (DEBUG_EDITOR_SET du pont, aucune fenêtre) à ~1 s ; le pont le signale, NOVA l'écrit dans la
    voie (enregistreur d'automation) ; relâché ~0,7 s plus tard, la voie revient à la courbe.
    Puis la voie écrite est relue en lecture : la compression suit le geste.
 D. Charge en lecture : 20 réglages de Pro-Q 4 automatisés (rampes) → valeurs envoyées au pont,
    coupures (underruns) du worklet.

Usage (serveur `npx vite --port 3460 --strictPort`) :
  set NOVA_URL=http://127.0.0.1:3460/ && python qa/r9_automation_vst.py
Sortie : D:\\1 WORK\\CONTENU\\nova-r9-r10\\r9_automation_vst.json
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import json
import os
import sys
import traceback

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from r9r10_lib import OUT, pick_port, start_bridge, stop_bridge  # noqa: E402

EXE = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
URL = os.environ.get("NOVA_URL", "http://127.0.0.1:3460/")

HELPERS = r"""
const mod = p => (window.__novaAppModule ? window.__novaAppModule(p) : import(p));
const { audioEngine: E } = await import('/engine/AudioEngine.ts');
const { TrackType } = await import('/types.ts');
const { novaBridge } = await import('/services/NovaBridge.ts');
const VF = await import('/services/VstFreeze.ts');
const VN = await import('/engine/VSTPluginNode.ts');
const { automationRecorder } = await import('/services/AutomationManager.ts');
const r2 = v => Math.round(v * 100) / 100;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sine = (sec, amp, f, sr) => { const n = Math.round(sec * sr), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / sr + 0.3); return x; };
const { audioBufferRegistry } = await import('/utils/audioBufferRegistry.ts');
let bufN = 0;
const toBuf = (x, sr) => { const b = new AudioBuffer({ length: x.length, numberOfChannels: 2, sampleRate: sr }); b.getChannelData(0).set(x); b.getChannelData(1).set(x); b.__id = 'qa-r9-buf-' + (bufN++); audioBufferRegistry.register(b, b.__id); return b; };
const env = (x, sr, t, w = 0.004) => { let m = 0; for (let i = Math.round(t * sr), e = i + Math.round(w * sr); i < e && i < x.length; i++) m = Math.max(m, Math.abs(x[i])); return m; };
const peakDb = (x, sr, a, z) => { let m = 0; for (let i = Math.round(a * sr); i < Math.round(z * sr); i++) m = Math.max(m, Math.abs(x[i])); return r2(20 * Math.log10(m + 1e-12)); };
// Premier instant (ms) où l'enveloppe (crête sur 1 ms, fenêtre qui FINIT à t) s'écarte de plus de `db` du niveau d'avant.
const onset = (x, sr, from, to, db = 1) => {
  const w = 0.001; const ref = 20 * Math.log10(env(x, sr, from - 0.05, 0.04) + 1e-12);
  for (let t = from - 0.02; t < to; t += 1 / sr) { const v = 20 * Math.log10(env(x, sr, t - w, w) + 1e-12); if (Math.abs(v - ref) > db) return r2(t * 1000); }
  return null;
};
const pts = (key, list) => list.map(([time, value, curveType], i) => ({ id: key + i, time, value, curveType: curveType || 'HOLD' }));
const laneP = (pid, key, list) => ({ id: 'l-' + pid + key, parameterName: 'plugin::' + pid + '::' + key, color: '#0ff', isExpanded: true, min: 0, max: 1, points: pts(key, list) });
const audioTrack = (id, buf, plugins, lanes, extra = {}) => ({ id, name: id, type: TrackType.AUDIO, color: '#0ff', volume: 1, pan: 0, isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, sends: [], outputTrackId: 'master',
  automationMode: 'read', automationLanes: lanes, plugins, totalLatency: 0,
  clips: [{ id: 'c-' + id, type: TrackType.AUDIO, start: 0, duration: buf.duration, offset: 0, buffer: buf, bufferId: buf.__id, gain: 1, name: id, fadeIn: 0, fadeOut: 0, color: '#0ff' }], ...extra });
const ensureBridge = async () => {
  await novaBridge.connect();
  for (let i = 0; i < 150 && !novaBridge.isConnected(); i++) await sleep(200);
  if (!novaBridge.isConnected()) throw new Error('pont injoignable');
  let list = novaBridge.getCachedPlugins(); if (!list.length) list = await novaBridge.listPlugins();
  return list;
};
// Prépare un VST : réglages posés par le pont, valeurs brutes relues, état enregistré (comme un projet).
const prepareVst = async (list, re, settings, probes) => {
  const c = list.find(p => re.test(p.name || ''));
  if (!c) throw new Error('absent du PC : ' + re);
  const slot = novaBridge.claimSlot('qa-prep-' + Date.now());
  const r = await novaBridge.loadPlugin({ slotId: slot, path: c.path, pluginName: c.pluginName ?? null, sampleRate: E.ctx ? E.ctx.sampleRate : 48000, quiet: true });
  const rb = await novaBridge.setParams(slot, settings);
  const raw = {};
  for (const [k, item] of Object.entries(probes)) { const x = await novaBridge.setParams(slot, [item]); raw[k] = x.results[0].value; }
  await novaBridge.setParams(slot, settings.filter(s => Object.values(probes).some(p => p.name === s.name)));
  const stateB64 = await novaBridge.getPluginState(slot);
  novaBridge.unloadPlugin(slot); novaBridge.releaseSlot(slot);
  return { name: r.name, path: c.path, pluginName: c.pluginName ?? null, stateB64, raw, relu: rb.results.map(x => [x.name, x.text]) };
};
const vstPlugin = (id, v) => ({ id, type: 'VST3', name: v.name, isEnabled: true, latency: 0, params: { name: v.name, localPath: v.path, pluginName: v.pluginName, stateB64: v.stateB64 } });
let rec = null; const chunks = [];
const setupCapture = async () => {
  await E.init(); await E.resume();
  const ctx = E.ctx;
  if (rec) return;
  const code = `class Rec extends AudioWorkletProcessor { process(i) { const x = i[0] && i[0][0]; if (x) this.port.postMessage({ f: currentFrame, d: x.slice(0) }); return true; } } registerProcessor('nova-qa-rec-r9', Rec);`;
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
  rec = new AudioWorkletNode(ctx, 'nova-qa-rec-r9', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  rec.port.onmessage = e => chunks.push(e.data);
  const sink = ctx.createGain(); sink.gain.value = 0; rec.connect(sink); sink.connect(ctx.destination);
  E.masterOutput.connect(rec);
};
const loadLive = async (tracks) => {
  E.setLiveTracks(tracks);
  tracks.forEach(t => E.updateTrack(t, tracks));
  const ids = tracks.flatMap(t => t.plugins.filter(p => p.type === 'VST3').map(p => p.id));
  for (let i = 0; i < 300; i++) {
    if (ids.every(id => VN.liveVstNodes.get(id)?.getInfo().status === 'active')) break;
    await sleep(200);
  }
  await sleep(1500);
  return ids.map(id => VN.liveVstNodes.get(id)?.getInfo());
};
const capture = async (tracks, sec, during) => {
  const sr = E.ctx.sampleRate;
  chunks.length = 0;
  E.startPlayback(0, tracks); const t0 = E.playbackStartTime;
  if (during) await during();
  const left = sec * 1000 + 600 - (during ? 0 : 0);
  await sleep(left);
  E.stopAll();
  await sleep(250);
  const o = new Float32Array(Math.round(sec * sr));
  for (const c of chunks) for (let i = 0; i < c.d.length; i++) { const k = Math.round(c.f + i - t0 * sr); if (k >= 0 && k < o.length) o[k] = c.d[i]; }
  return o;
};
const residual = (a, b, sr, from, to) => { let e = 0, s = 0; for (let i = Math.round(from * sr); i < Math.round(to * sr); i++) { e += (a[i] - b[i]) ** 2; s += b[i] ** 2; } return r2(10 * Math.log10((e + 1e-20) / (s + 1e-20))); };
"""

MAIN = r"""
const out = { erreurs: [] };
const list = await ensureBridge();
await E.init();
// Fréquence du contexte de l'appareil (44,1 ou 48 kHz) : tout est fait à cette fréquence.
const sr = E.ctx.sampleRate;
out.pont = { version: novaBridge.getBridgeState().version, automation: !!novaBridge.getBridgeState().automation };
await setupCapture();
out.sampleRate = E.ctx.sampleRate;

// ── A. Pro-C 3 : seuil ─────────────────────────────────────────────────────────
const pc = await prepareVst(list, /^FabFilter Pro-C 3$/,
  [{ name: 'auto_gain', text: 'Off' }, { name: 'ratio', real: 20 }, { name: 'knee', real: 0 }, { name: 'attack', value: 0 },
   { name: 'release', real: 50 }, { name: 'lookahead', real: 0 }, { name: 'range', real: 60 }, { name: 'threshold', real: 0 }],
  { t0: { name: 'threshold', real: 0 }, t30: { name: 'threshold', real: -30 } });
out.A = { plugin: pc.name, seuil_brut: pc.raw, reglages: pc.relu };
const mkA = () => [audioTrack('voix', toBuf(sine(4, 0.5, 997, sr), sr), [vstPlugin('proc3', pc)], [laneP('proc3', 'threshold', [[0, pc.raw.t0], [2.0, pc.raw.t30]])])];
{
  const prep = await VF.prepareTracksForOffline(mkA());
  out.A.export_rendu_par_le_pont = prep.tracks.map(t => !!t.isFrozen);
  const b = await E.renderProject(prep.tracks, 4, 0, sr);
  prep.cleanup();
  const y = b.getChannelData(0);
  out.A.export = { vst_manquants: prep.missingVst, avant_db: peakDb(y, sr, 1.0, 1.9), apres_db: peakDb(y, sr, 2.5, 3.5), changement_entendu_ms: onset(y, sr, 2.0, 2.2, 1) };
  out.A._exp = y;
}
{
  const tracks = mkA();
  const info = await loadLive(tracks);
  const y = await capture(tracks, 4);
  const node = VN.liveVstNodes.get('proc3');
  const stats = node ? node.getParamStats() : null;
  const slot = node?.getSlotId();
  const bst = slot ? await novaBridge.automationStats(slot) : null;
  out.A.lecture = { vst: info, avant_db: peakDb(y, sr, 1.0, 1.9), apres_db: peakDb(y, sr, 2.5, 3.5), changement_entendu_ms: onset(y, sr, 2.0, 2.2, 1),
    valeurs_envoyees_par_le_worklet: stats, valeurs_posees_par_le_pont: bst };
  out.A.export_vs_lecture_residu_db = residual(y, out.A._exp, sr, 0.3, 3.7);
  out.A.export_vs_lecture_residu_autour_du_palier_db = residual(y, out.A._exp, sr, 1.9, 2.3);
  tracks.forEach(t => E.disposeTrack(t.id));
  delete out.A._exp;
}

// ── B. Pro-Q 4 : fréquence de la bande 1 ──────────────────────────────────────
const pq = await prepareVst(list, /^FabFilter Pro-Q 4$/,
  [{ name: 'band_1_used', text: 'Used' }, { name: 'band_1_enabled', text: 'Enabled' }, { name: 'band_1_shape', text: 'Bell' },
   { name: 'band_1_gain', real: 12 }, { name: 'band_1_q', real: 4 }, { name: 'band_1_frequency', real: 500 }],
  { f500: { name: 'band_1_frequency', real: 500 }, f4k: { name: 'band_1_frequency', real: 4000 } });
out.B = { plugin: pq.name, frequence_brute: pq.raw };
const mkB = () => [audioTrack('synth', toBuf(sine(4, 0.1, 4000, sr), sr), [vstPlugin('proq4', pq)], [laneP('proq4', 'band_1_frequency', [[0, pq.raw.f500], [2.0, pq.raw.f4k]])])];
{
  const prep = await VF.prepareTracksForOffline(mkB());
  const b = await E.renderProject(prep.tracks, 4, 0, sr);
  prep.cleanup();
  const y = b.getChannelData(0);
  out.B.export = { avant_db: peakDb(y, sr, 1.0, 1.9), apres_db: peakDb(y, sr, 2.5, 3.5), changement_entendu_ms: onset(y, sr, 2.0, 2.2, 1) };
  out.B._exp = y;
}
{
  const tracks = mkB();
  const info = await loadLive(tracks);
  const y = await capture(tracks, 4);
  out.B.lecture = { vst: info, avant_db: peakDb(y, sr, 1.0, 1.9), apres_db: peakDb(y, sr, 2.5, 3.5), changement_entendu_ms: onset(y, sr, 2.0, 2.2, 1) };
  out.B.export_vs_lecture_residu_db = residual(y, out.B._exp, sr, 0.3, 3.7);
  tracks.forEach(t => E.disposeTrack(t.id));
  delete out.B._exp;
}

// ── C. Écriture Touch simulée (Pro-C 3) ──────────────────────────────────────
{
  let tracks = [audioTrack('voix', toBuf(sine(4, 0.5, 997, sr), sr), [vstPlugin('proc3', pc)], [], { automationMode: 'touch' })];
  const commits = [];
  automationRecorder.configure({
    getTracks: () => tracks, getTime: () => E.getCurrentTime(), isPlaying: () => E.getIsPlaying(),
    setOverride: (tid, p, v, ptsx) => E.setAutomationOverride(tid, p, v, ptsx), beginUndoStep: () => {},
    commit: (c) => { commits.push(c); tracks = tracks.map(t => t.id !== c.trackId ? t : { ...t, automationLanes: [...t.automationLanes.filter(l => l.parameterName !== c.param), { id: 'w', parameterName: c.param, color: '#0ff', isExpanded: true, min: c.spec.min, max: c.spec.max, points: c.points }] }); },
    setTrackMode: () => {}, wallClock: () => performance.now(),
  });
  // Le même branchement que l'application (App.tsx : vstParamEvents → capturePluginParams).
  const off = VN.vstParamEvents.on(({ pluginId, changes }) => {
    const tr = tracks.find(t => t.plugins.some(p => p.id === pluginId));
    if (!tr || !automationRecorder.canWrite(tr.id)) return;
    const params = {}, before = {};
    changes.forEach(c => { params[c.name] = c.value; if (typeof c.from === 'number') before[c.name] = c.from; });
    if (automationRecorder.capturePluginParams(tr.id, pluginId, params, before)) {
      tracks = tracks.map(t => t.id !== tr.id ? t : { ...t, plugins: t.plugins.map(p => p.id === pluginId ? { ...p, params: { ...p.params, ...params } } : p) });
    }
  });
  await loadLive(tracks);
  const node = VN.liveVstNodes.get('proc3');
  const ticker = setInterval(() => automationRecorder.tick(), 16);
  let gestureAt = null;
  const y = await capture(tracks, 3.5, async () => {
    queueMicrotask(() => automationRecorder.onPlay());
    await sleep(1000);
    gestureAt = E.getCurrentTime();
    await novaBridge.request({ action: 'DEBUG_EDITOR_SET', slot_id: node.getSlotId(), name: 'threshold', value: pc.raw.t30 });
  });
  automationRecorder.onStop(E.getCurrentTime());
  clearInterval(ticker); off();
  const c = commits.find(x => x.param === 'plugin::proc3::threshold');
  const sorted = c ? [...c.points].sort((a, b) => a.time - b.time) : [];
  const firstLow = sorted.find(p => Math.abs(p.value - pc.raw.t30) < 1e-3);
  const lastLow = [...sorted].reverse().find(p => Math.abs(p.value - pc.raw.t30) < 1e-3);
  out.C = {
    geste_a_s: gestureAt && r2(gestureAt), voie_ecrite: !!c, points: sorted.map(p => [r2(p.time * 1000) / 1000, Math.round(p.value * 1000) / 1000]),
    ecrit_de_s: firstLow ? r2(firstLow.time) : null, ecrit_jusqu_a_s: lastLow ? r2(lastLow.time) : null,
    retard_ecriture_ms: firstLow && gestureAt ? r2((firstLow.time - gestureAt) * 1000) : null,
    pendant_l_ecriture_db: peakDb(y, sr, (firstLow?.time || 1.2) + 0.05, (firstLow?.time || 1.2) + 0.3), avant_db: peakDb(y, sr, 0.3, 0.9),
  };
  // Relecture de la voie écrite (piste en Read) : la compression suit le geste.
  tracks = tracks.map(t => ({ ...t, automationMode: 'read' }));
  E.setLiveTracks(tracks); tracks.forEach(t => E.updateTrack(t, tracks));
  await sleep(500);
  const y2 = await capture(tracks, 3.5);
  out.C.relecture = { avant_db: peakDb(y2, sr, 0.3, 0.9), pendant_db: firstLow ? peakDb(y2, sr, firstLow.time + 0.05, Math.max(firstLow.time + 0.1, (lastLow?.time || 1.6) - 0.05)) : null,
    apres_db: peakDb(y2, sr, (lastLow?.time || 2) + 0.3, 3.3), changement_entendu_ms: firstLow ? onset(y2, sr, firstLow.time, firstLow.time + 0.2, 1) : null };
  automationRecorder.configure(null);
  tracks.forEach(t => E.disposeTrack(t.id));
}

// ── D. Charge en lecture : 20 réglages de Pro-Q 4 en rampe ───────────────────
{
  const names = []; for (let b = 1; b <= 10; b++) { names.push(`band_${b}_gain`); names.push(`band_${b}_frequency`); }
  const lanes = names.map((n, i) => laneP('proq4', n, [[0, 0.3, 'LINEAR'], [4, 0.7 - (i % 5) * 0.05, 'LINEAR'], [8, 0.4]]));
  const noise = new Float32Array(8 * sr); let s = 7; for (let i = 0; i < noise.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; noise[i] = 0.05 * (s / 4294967296 * 2 - 1); }
  // Témoin : même son, même plugin, sans automation (coupures dues à la machine seule).
  {
    const t0s = [audioTrack('bus', toBuf(noise, sr), [vstPlugin('proq4', pq)], [])];
    await loadLive(t0s);
    const n0 = VN.liveVstNodes.get('proq4');
    const u00 = n0.getInfo().underruns;
    await novaBridge.request({ action: 'AUTOMATION_STATS', slot_id: n0.getSlotId(), reset: true });
    await capture(t0s, 8);
    const b0 = await novaBridge.request({ action: 'AUTOMATION_STATS', slot_id: n0.getSlotId() });
    out.D0 = { reglages: 0, us_par_bloc_dans_le_plugin: b0.avg_block_us, coupures: n0.getInfo().underruns - u00 };
    t0s.forEach(t => E.disposeTrack(t.id));
  }
  const tracks = [audioTrack('bus', toBuf(noise, sr), [vstPlugin('proq4', pq)], lanes)];
  await loadLive(tracks);
  const node = VN.liveVstNodes.get('proq4');
  await novaBridge.automationStats(node.getSlotId()).catch(() => null);
  await novaBridge.request({ action: 'AUTOMATION_STATS', slot_id: node.getSlotId(), reset: true });
  const u0 = node.getInfo().underruns;
  const t0 = performance.now();
  await capture(tracks, 8);
  const st = await novaBridge.automationStats(node.getSlotId());
  const b2 = await novaBridge.request({ action: 'AUTOMATION_STATS', slot_id: node.getSlotId() });
  out.D = { reglages: 20, duree_s: 8, valeurs_envoyees_par_le_worklet: node.getParamStats(), valeurs_posees_par_le_pont: st.applied,
    us_par_bloc_dans_le_plugin: b2.avg_block_us, budget_bloc_us: r2(128 / sr * 1e6), coupures: node.getInfo().underruns - u0 };
  tracks.forEach(t => E.disposeTrack(t.id));
}
return out;
"""


def main():
    port = pick_port()
    proc = start_bridge(port)
    res = {"port": port}
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(headless=True, executable_path=EXE, args=["--autoplay-policy=no-user-gesture-required"])
            pg = b.new_page()
            errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)[:300]))
            pg.on("console", lambda m: errs.append(m.text[:300]) if m.type == "error" else None)
            pg.add_init_script(f"try {{ localStorage.setItem('nova.bridge.url', 'ws://127.0.0.1:{port}'); }} catch (e) {{}}")
            pg.goto(URL, wait_until="domcontentloaded", timeout=120000)
            pg.wait_for_timeout(4000)
            pg.set_default_timeout(900000)
            res.update(pg.evaluate("async () => {" + HELPERS + MAIN + "}"))
            res["erreurs_page"] = errs[:30]
            b.close()
    except Exception as e:
        res["erreur"] = f"{e}\n{traceback.format_exc()}"[:3000]
    finally:
        stop_bridge(proc)
    (OUT / "r9_automation_vst.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    sys.stdout.buffer.write(json.dumps(res, ensure_ascii=False, indent=1).encode("utf-8") + b"\n")


if __name__ == "__main__":
    main()
