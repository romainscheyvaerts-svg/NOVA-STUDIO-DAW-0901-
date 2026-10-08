"""R7 · Side-chain natif : preuves audio sur le VRAI moteur de NOVA, dans un Chrome headless
(aucune fenêtre). Export (renderProject) ET lecture réelle (sortie du master captée par un
AudioWorklet témoin).

« 808 sous le kick » (préréglage NOVA) : la 808 porte le Compresseur, sa clé = le kick (prise
avant fader, kick muet : on n'entend que la 808). La « 808 » de mesure est un sinus connu :
gain appliqué g(t) = sortie / entrée, échantillon par échantillon. Pour chaque kick (toutes
les 500 ms), on relève l'instant où la réduction de gain commence (g < −0,1 dB) et la
réduction maximale. Attendu : début aligné sur le kick à ±1 ms, en lecture comme à l'export,
dans quatre cas de latence :
  1. aucune latence ;
  2. limiteur (anticipation 5 ms) sur la piste du KICK (latence en amont de la clé) ;
  3. limiteur AVANT le compresseur sur la 808 (latence en amont du son traité) ;
  4. limiteur APRÈS le compresseur sur la 808 (le kick doit partir plus tôt).
Puis « Voix qui creuse le beat » (le beat baisse de 1 à 3 dB quand la voix est là), « Pompe »
(profondeur), Gate « Haché par les charleys », le de-esser en écoute externe, et un compresseur
analogique du labo (FET 76) avec la même clé (fet) comparé au même sans clé (fetSeul).

Usage : serveur `npx vite --port 3447 --strictPort`, puis
  set NOVA_URL=http://127.0.0.1:3447/ && python qa/r7_sidechain.py
Sortie : D:\\1 WORK\\CONTENU\\nova-r7-r8\\r7_sidechain.json
"""
import json, os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-r7-r8"))
OUT.mkdir(parents=True, exist_ok=True)
EXE = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
URL = os.environ.get("NOVA_URL", "http://127.0.0.1:3447/")

HELPERS = r"""
const { audioEngine: E } = await import('/engine/AudioEngine.ts');
const { TrackType } = await import('/types.ts');
const { DEFAULT_LIMITER_PARAMS } = await import('/engine/LimiterNode.ts');
const { SIDECHAIN_PRESETS } = await import('/engine/sidechain.ts');
const preset = id => ({ ...SIDECHAIN_PRESETS.find(p => p.id === id).params });
const r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000;
const toBuf = (x, sr) => { const b = new AudioBuffer({ length: x.length, numberOfChannels: 2, sampleRate: sr }); b.getChannelData(0).set(x); b.getChannelData(1).set(x); return b; };
const KICKS = [0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25];
const kickSig = (sec, sr) => { const x = new Float32Array(Math.round(sec * sr)); for (const k of KICKS) { const i0 = Math.round(k * sr); for (let i = 0; i < 0.15 * sr && i0 + i < x.length; i++) { const t = i / sr; x[i0 + i] += 0.9 * Math.sin(2 * Math.PI * (50 * t + 400 * (1 - Math.exp(-t * 30)) / 30)) * Math.exp(-t * 18); } } return x; };
const sine = (sec, amp, f, sr) => { const n = Math.round(sec * sr), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / sr + 0.4); return x; };
const noiseBurst = (sec, amp, a, z, sr) => { const n = Math.round(sec * sr), x = new Float32Array(n); let s = 99; for (let i = Math.round(a * sr); i < Math.round(z * sr) && i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; x[i] = amp * (s / 4294967296 * 2 - 1) * Math.sin(2 * Math.PI * 5 * (i / sr - a)) ** 2; } return x; };
const pl = (id, type, params, extra = {}) => ({ id, type, name: type, isEnabled: true, latency: 0, params, ...extra });
const trk = (id, buf, plugins, extra = {}) => ({ id, name: id, type: TrackType.AUDIO, volume: 1, pan: 0, isMuted: false, isSolo: false, sends: [], outputTrackId: 'master',
  automationMode: 'read', automationLanes: [], plugins, clips: buf ? [{ id: 'c-' + id, type: TrackType.AUDIO, start: 0, duration: buf.duration, offset: 0, buffer: buf, gain: 1, name: id }] : [], ...extra });
const LIM = (id) => pl(id, 'LIMITER', { ...DEFAULT_LIMITER_PARAMS, ceiling: 0, inputGain: 0, lookahead: 5 });
// Gain appliqué (dB) au sinus connu x : rapport des crêtes sur des demi-périodes, interpolé (résolution ≈ 1 période de 2 kHz = 0,5 ms).
const gainTrack = (y, x, sr, step = 0.00025) => { const out = []; const w = Math.round(0.00025 * sr); for (let t = 0.05; t < x.length / sr - 0.05; t += step) { const i0 = Math.round(t * sr); let my = 0, mx = 0; for (let i = i0; i < i0 + w; i++) { my = Math.max(my, Math.abs(y[i])); mx = Math.max(mx, Math.abs(x[i])); } out.push([t, 20 * Math.log10((my + 1e-12) / (mx + 1e-12))]); } return out; };
const perKick = (g, kicks, thr = -0.5) => kicks.map(k => {
  const ref = g.filter(([t]) => t > k - 0.06 && t < k - 0.01).reduce((a, [, v]) => a + v, 0) / Math.max(1, g.filter(([t]) => t > k - 0.06 && t < k - 0.01).length);
  let start = null, min = 0;
  for (const [t, v] of g) { if (t < k - 0.02 || t > k + 0.2) continue; if (start === null && v < ref + thr) start = t; if (v - ref < min) min = v - ref; }
  return { kick_ms: r2(k * 1000), debut_reduction_ms: start === null ? null : r2(start * 1000), ecart_ms: start === null ? null : r2((start - k) * 1000), reduction_max_db: r2(min) };
});
"""

SCEN = r"""
const SC = (sr, cas) => {
  const sec = 3.6;
  const ref = sine(sec, 0.5, 2000, sr);   // « 808 » de mesure : sinus connu (gain lu échantillon par échantillon)
  const kick = trk('kick', toBuf(kickSig(sec, sr), sr), cas === 2 ? [LIM('limk')] : [], { isMuted: true });
  const comp = pl('comp808', 'COMPRESSOR', preset('808-sous-kick'), { sidechainSourceId: 'kick' });
  const p808 = cas === 3 ? [LIM('lim808'), comp] : cas === 4 ? [comp, LIM('lim808')] : [comp];
  return { sec, ref, tracks: [kick, trk('808', toBuf(ref, sr), p808)] };
};
const RUNMEAS = (y, sr, sc) => {
  // Le limiteur à plafond 0 dBFS ne touche pas un sinus à −6 dBFS : seul le compresseur agit.
  const g = gainTrack(y, sc.ref, sr);
  const rows = perKick(g, KICKS);
  const ecarts = rows.map(r => r.ecart_ms).filter(v => v !== null);
  return { par_kick: rows, ecart_max_ms: ecarts.length ? r2(Math.max(...ecarts.map(Math.abs))) : null, reduction_moyenne_db: r2(rows.reduce((a, r) => a + r.reduction_max_db, 0) / rows.length), _g: g };
};
const EXTRA = (sr) => {
  const sec = 3;
  const beat = sine(sec, 0.3, 1000, sr);
  const voix = noiseBurst(sec, 0.5, 1.0, 2.0, sr);
  const v = { sec, ref: beat, tracks: [trk('voix', toBuf(voix, sr), [], { isMuted: true }), trk('beat', toBuf(beat, sr), [pl('compb', 'COMPRESSOR', preset('voix-creuse-beat'), { sidechainSourceId: 'voix' })])] };
  const pompeRef = sine(3.6, 0.5, 2000, sr);
  const pompe = { sec: 3.6, ref: pompeRef, tracks: [trk('kick', toBuf(kickSig(3.6, sr), sr), [], { isMuted: true }), trk('pads', toBuf(pompeRef, sr), [pl('compp', 'COMPRESSOR', preset('pompe'), { sidechainSourceId: 'kick' })])] };
  // Gate « haché par les charleys » : charleys = impulsions de bruit aigu toutes les 250 ms.
  const hats = new Float32Array(Math.round(3 * sr)); { let s = 7; for (let k = 0; k < 12; k++) { const i0 = Math.round((0.1 + k * 0.25) * sr); for (let i = 0; i < 0.03 * sr; i++) { s = (s * 1664525 + 1013904223) >>> 0; hats[i0 + i] = 0.6 * (s / 4294967296 * 2 - 1) * Math.exp(-i / sr * 120); } } }
  const padRef = sine(3, 0.4, 1000, sr);
  const gate = { sec: 3, ref: padRef, tracks: [trk('hats', toBuf(hats, sr), [], { isMuted: true }), trk('pad', toBuf(padRef, sr), [pl('gate', 'GATE', preset('gate-cle-hats'), { sidechainSourceId: 'hats' })])] };
  // Compresseur analogique du labo (FET 76, réglages d'usine) avec la même clé : il ne doit
  // compresser QUE sous le kick (kick fantôme muet) ; sans clé, il écrase le sinus en continu.
  const fetRef = sine(3.6, 0.7, 2000, sr);
  const fet = { sec: 3.6, ref: fetRef, tracks: [trk('kick', toBuf(kickSig(3.6, sr), sr), [], { isMuted: true }), trk('basse', toBuf(fetRef, sr), [pl('fet', 'FET76', {}, { sidechainSourceId: 'kick' })])] };
  const fetSeul = { sec: 3.6, ref: fetRef, tracks: [trk('basse', toBuf(fetRef, sr), [pl('fet', 'FET76', {})])] };
  return { v, pompe, gate, fet, fetSeul };
};
const EXTRAMEAS = (k, y, sr, sc) => {
  const g = gainTrack(y, sc.ref, sr, 0.002);
  const avg = (a, z) => r2(g.filter(([t]) => t >= a && t < z).reduce((s, [, v]) => s + v, 0) / Math.max(1, g.filter(([t]) => t >= a && t < z).length));
  if (k === 'v') return { attendu: 'beat à 0 dB hors de la voix ; baisse de 1 à 3 dB pendant la voix (1,0–2,0 s)', avant_db: avg(0.3, 0.9), pendant_db: avg(1.2, 1.9), apres_db: avg(2.6, 2.95) };
  if (k === 'pompe') { const rows = perKick(g, KICKS); return { attendu: 'grosse pompe : ≥ 10 dB à chaque kick', reduction_par_kick_db: rows.map(r => r.reduction_max_db), debut_ms: rows.map(r => r.ecart_ms) }; }
  if (k === 'fet' || k === 'fetSeul') {
    const rows = perKick(g, KICKS);
    return { attendu: k === 'fet' ? 'clé = kick : réduction sur chaque kick, aucune avant le 1er kick (0,05–0,2 s)' : 'sans clé : le sinus fort est compressé dès le début',
      avant_premier_kick_db: avg(0.05, 0.2), reduction_par_kick_db: rows.map(r => r.reduction_max_db), debut_ms: rows.map(r => r.ecart_ms) };
  }
  if (k === 'gate') {
    let open = 0, closed = 0, no = 0, nc = 0;
    for (const [t, v] of g) { const ph = ((t - 0.1) % 0.25 + 0.25) % 0.25; if (t < 0.1) continue; if (ph > 0.005 && ph < 0.025) { open += v; no++; } else if (ph > 0.12 && ph < 0.22) { closed += v; nc++; } }
    return { attendu: 'pad ouvert sur chaque charley (≈ 0 dB), fermé entre (≈ −80 dB)', ouvert_db: r2(open / Math.max(1, no)), ferme_db: r2(closed / Math.max(1, nc)) };
  }
};
"""

EXPORT_JS = "async () => {" + HELPERS + SCEN + r"""
const sr = 48000, out = {}, curves = {};
for (const cas of [1, 2, 3, 4]) {
  const sc = SC(sr, cas);
  const b = await E.renderProject(sc.tracks, sc.sec, 0, sr);
  const m = RUNMEAS(b.getChannelData(0), sr, sc);
  curves['cas' + cas] = m._g.filter((_, i) => i % 4 === 0).map(([t, v]) => [r3(t), r2(v)]); delete m._g;
  out['cas' + cas] = m;
}
const ex = EXTRA(sr);
for (const k of Object.keys(ex)) { const b = await E.renderProject(ex[k].tracks, ex[k].sec, 0, sr); out[k] = EXTRAMEAS(k, b.getChannelData(0), sr, ex[k]); }
return { out, curves };
}"""

LIVE_JS = "async () => {" + HELPERS + SCEN + r"""
await E.init(); await E.resume();
const ctx = E.ctx, sr = ctx.sampleRate;
const code = `class Rec extends AudioWorkletProcessor { process(i) { const x = i[0] && i[0][0]; if (x) this.port.postMessage({ f: currentFrame, d: x.slice(0) }); return true; } } registerProcessor('nova-qa-rec-r7', Rec);`;
await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
const rec = new AudioWorkletNode(ctx, 'nova-qa-rec-r7', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
const chunks = []; rec.port.onmessage = e => chunks.push(e.data);
const sink = ctx.createGain(); sink.gain.value = 0; rec.connect(sink); sink.connect(ctx.destination);
E.masterOutput.connect(rec);
const capture = async (tracks, sec) => {
  E.setLiveTracks(tracks);
  tracks.forEach(t => E.updateTrack(t, tracks));
  await new Promise(r => setTimeout(r, 1500));
  tracks.forEach(t => E.updateTrack(t, tracks));
  await new Promise(r => setTimeout(r, 300));
  chunks.length = 0;
  E.startPlayback(0, tracks); const t0 = E.playbackStartTime;
  await new Promise(r => setTimeout(r, sec * 1000 + 300)); E.stopAll();
  await new Promise(r => setTimeout(r, 200));
  const o = new Float32Array(Math.round(sec * sr));
  for (const c of chunks) for (let i = 0; i < c.d.length; i++) { const k = Math.round(c.f + i - t0 * sr); if (k >= 0 && k < o.length) o[k] = c.d[i]; }
  tracks.forEach(t => E.disposeTrack(t.id));
  return o;
};
const out = { sampleRate: sr }, curves = {};
for (const cas of [1, 2, 3, 4]) {
  const sc = SC(sr, cas);
  const m = RUNMEAS(await capture(sc.tracks, sc.sec), sr, sc);
  curves['cas' + cas] = m._g.filter((_, i) => i % 4 === 0).map(([t, v]) => [r3(t), r2(v)]); delete m._g;
  out['cas' + cas] = m;
}
const ex = EXTRA(sr);
for (const k of Object.keys(ex)) out[k] = EXTRAMEAS(k, await capture(ex[k].tracks, ex[k].sec), sr, ex[k]);
return { out, curves };
}"""

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, executable_path=EXE, args=["--autoplay-policy=no-user-gesture-required"])
    pg = b.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:300]))
    pg.goto(URL, wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_timeout(2500)
    ex = pg.evaluate(EXPORT_JS)
    res = {"export": ex["out"]}
    # Décalage dû à la latence : début de réduction de chaque cas comparé au cas sans latence (même kick).
    def vs_cas1(r):
        base = [x["debut_reduction_ms"] for x in r["cas1"]["par_kick"]]
        for cas in ["cas2", "cas3", "cas4"]:
            d = [round(x["debut_reduction_ms"] - b, 2) for x, b in zip(r[cas]["par_kick"], base) if x["debut_reduction_ms"] is not None and b is not None]
            r[cas]["decalage_vs_sans_latence_ms"] = max([abs(v) for v in d]) if d else None
    vs_cas1(res["export"])
    curves = {"export": ex["curves"]}
    if "--export-only" not in sys.argv:
        lv = pg.evaluate(LIVE_JS)
        res["lecture"] = lv["out"]
        vs_cas1(res["lecture"])
        curves["lecture"] = lv["curves"]
        # Lecture vs export : écart des débuts de réduction, kick par kick.
        cmp = {}
        for cas in ["cas1", "cas2", "cas3", "cas4"]:
            a = [r["debut_reduction_ms"] for r in res["export"][cas]["par_kick"]]
            l = [r["debut_reduction_ms"] for r in res["lecture"][cas]["par_kick"]]
            d = [round(x - y, 2) for x, y in zip(a, l) if x is not None and y is not None]
            cmp[cas] = {"ecart_max_lecture_export_ms": max([abs(v) for v in d]) if d else None}
        res["lecture_vs_export"] = cmp
    res["erreurs_page"] = errs
    b.close()

(OUT / "r7_sidechain.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
(OUT / "r7_sidechain_courbes.json").write_text(json.dumps(curves), encoding="utf-8")
print(json.dumps(res, ensure_ascii=False, indent=1))
