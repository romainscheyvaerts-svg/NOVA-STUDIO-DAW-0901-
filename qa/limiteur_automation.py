"""Automation du limiteur NOVA (gain d'entrée, plafond, relâchement) : export ET lecture réelle,
sur le VRAI moteur de NOVA dans un Chrome headless (aucune fenêtre).

Défaut cherché : les réglages passaient par port.postMessage ; à l'export (rendu hors ligne)
le message arrive après la reprise du rendu, l'automation était donc ignorée.

Scénarios (export, renderProject) :
 A. gain d'entrée 0 → +12 dB à 2,0 s (sinus 997 Hz à −6 dBFS, plafond −1 dBTP) ;
 B. plafond −1 → −8 dBTP à 2,0 s (sinus à −6 dBFS poussé de +6 dB) ;
 C. plafond en rampe −1 → −9 dBTP de 1 à 3 s (signal fort, +12 dB) : la crête vraie de chaque
    tranche de 50 ms ne doit jamais dépasser le plafond en vigueur sur cette tranche ;
 D. relâchement 2000 → 5 ms à 2,0 s (rafales fortes / faibles) : remontée du gain après une rafale ;
 E. gain d'entrée en paliers +6 / −6 / 0 / +6 dB à 0 / 1 / 2 / 3 s : chaque palier doit s'entendre
    à sa place (instant mesuré de chaque changement).
Les réglages du limiteur sont lus à chaque bloc de 128 échantillons (k-rate) : le plafond « en
vigueur » d'une tranche est celui du début du bloc qui la contient (au plus 2,7 ms plus tôt).
Lecture réelle : scénario A capté à la sortie du master (AudioWorklet témoin).

Usage : NOVA_URL=http://127.0.0.1:3431/ python qa/limiteur_automation.py [etiquette]
Sortie : D:\\1 WORK\\CONTENU\\nova-limiteur-automation\\mesures_<etiquette>.json
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import json, os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-limiteur-automation"))
OUT.mkdir(parents=True, exist_ok=True)
EXE = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
URL = os.environ.get("NOVA_URL", "http://127.0.0.1:3431/")
LABEL = sys.argv[1] if len(sys.argv) > 1 else "mesure"

HELPERS = r"""
const SR = 48000;
const { audioEngine: E } = await import('/engine/AudioEngine.ts');
const { TrackType } = await import('/types.ts');
const { DEFAULT_LIMITER_PARAMS } = await import('/engine/LimiterNode.ts');
const { truePeakOf, samplePeakOf } = await import('/utils/audioMeasure.ts');
const r2 = v => Math.round(v * 100) / 100;
const sine = (sec, amp, sr = SR) => { const n = Math.round(sec * sr), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * 997 * i / sr + 0.7); return x; };
const loud = (sec, level, sr = SR) => {
  const n = Math.round(sec * sr), L = new Float32Array(n);
  let seed = 777, z1 = 0, z2 = 0, z3 = 0;
  const r0 = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  const rnd = () => { const v = r0(); const r = (v + 3 * z1 + 3 * z2 + z3) / 4; z3 = z2; z2 = z1; z1 = v; return r; };
  for (let i = 0; i < n; i++) {
    const t = i / sr, b = t % 0.5, s = t % 0.125;
    const kick = Math.sin(2 * Math.PI * (50 + 120 * Math.exp(-b * 30)) * b) * Math.exp(-b * 8);
    L[i] = level * (kick + 0.6 * Math.sin(2 * Math.PI * 49 * t) + 0.5 * rnd() * Math.exp(-s * 80) + 0.3 * Math.sin(2 * Math.PI * 7350 * t) + 0.25 * Math.sin(2 * Math.PI * 11025.5 * t + 0.3));
  }
  return L;
};
const toBuf = (x, sr = SR) => { const b = new AudioBuffer({ length: x.length, numberOfChannels: 2, sampleRate: sr }); b.getChannelData(0).set(x); b.getChannelData(1).set(x); return b; };
const lane = (key, points) => ({ id: 'l-' + key, parameterName: 'plugin::lim::' + key, color: '#fbbf24', isExpanded: true, min: -30, max: 2000,
  points: points.map(([time, value, curveType], i) => ({ id: key + i, time, value, curveType: curveType || 'HOLD' })) });
const track = (buf, params, lanes) => ({ id: 'beat', name: 'beat', type: TrackType.AUDIO, volume: 1, pan: 0, isMuted: false, isSolo: false, sends: [],
  automationMode: 'read', automationLanes: lanes,
  clips: [{ id: 'c-beat', type: TrackType.AUDIO, start: 0, duration: buf.duration, offset: 0, buffer: buf, gain: 1, name: 'beat' }],
  plugins: [{ id: 'lim', type: 'LIMITER', name: 'Nova Limiter', isEnabled: true, latency: 0, params: { ...DEFAULT_LIMITER_PARAMS, ...params } }] });
const win = (x, sr, a, z) => x.subarray(Math.round(a * sr), Math.round(z * sr));
const peakDb = (x, sr, a, z) => { const w = win(x, sr, a, z); return { crete_echantillon_db: r2(samplePeakOf([w])), crete_vraie_db: r2(truePeakOf([w], 8, 64)) }; };
const rmsDb = (x, sr, a, z) => { const w = win(x, sr, a, z); let s = 0; for (let i = 0; i < w.length; i++) s += w[i] * w[i]; return r2(10 * Math.log10(s / Math.max(1, w.length) + 1e-20)); };
"""

EXPORT_JS = "async () => {" + HELPERS + r"""
const out = {};
// A. Gain d'entrée 0 → +12 dB à 2,0 s.
{ const b = await E.renderProject([track(toBuf(sine(4, 0.5)), { ceiling: -1, inputGain: 0, release: 100, lookahead: 3, oversample: 4 }, [lane('inputGain', [[0, 0], [2.0, 12]])])], 4, 0, SR);
  const x = b.getChannelData(0);
  out.A_gain_entree_0_vers_12dB = { attendu: 'avant −6,02 dB ; après −1 dBTP (limité)', avant_1_0_1_9s: peakDb(x, SR, 1.0, 1.9), apres_2_2_3_8s: peakDb(x, SR, 2.2, 3.8) };
  // Instant du changement : premier échantillon dont |x| dépasse 0,6 (le sinus seul fait 0,5).
  let k = -1; for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 0.6) { k = i; break; }
  out.A_gain_entree_0_vers_12dB.changement_entendu_a_ms = k < 0 ? null : r2(k / SR * 1000);
}
// B. Plafond −1 → −8 dBTP à 2,0 s.
{ const b = await E.renderProject([track(toBuf(sine(4, 0.5)), { ceiling: -1, inputGain: 6, release: 100, lookahead: 3, oversample: 4 }, [lane('ceiling', [[0, -1], [2.0, -8]])])], 4, 0, SR);
  const x = b.getChannelData(0);
  out.B_plafond_1_vers_8dB = { attendu: 'avant −1 dBTP ; après −8 dBTP', avant_1_0_1_9s: peakDb(x, SR, 1.0, 1.9), apres_2_2_3_8s: peakDb(x, SR, 2.2, 3.8) };
}
// C. Plafond en rampe −1 → −9 de 1 à 3 s, signal fort poussé de +12 dB.
{ const pts = [[0, -1, 'LINEAR'], [1.0, -1, 'LINEAR'], [3.0, -9, 'HOLD']];
  const b = await E.renderProject([track(toBuf(loud(4, 0.9)), { ceiling: -1, inputGain: 12, release: 80, lookahead: 3, oversample: 4 }, [lane('ceiling', pts)])], 4, 0, SR);
  const x = b.getChannelData(0), y = b.getChannelData(1);
  const ceilAt = t => t <= 1 ? -1 : t >= 3 ? -9 : -1 - 8 * (t - 1) / 2;
  const rows = []; let worst = -99, worstAt = 0, maxEcart = -99;
  for (let t = 0.2; t < 3.95; t += 0.05) {
    const tp = truePeakOf([win(x, SR, t, t + 0.05), win(y, SR, t, t + 0.05)], 8, 64);
    const lim = ceilAt(t - 128 / SR); // plafond en vigueur le plus haut de la tranche (rampe descendante, k-rate)
    const ecart = tp - lim;
    if (ecart > worst) { worst = ecart; worstAt = t; }
    rows.push([r2(t), r2(lim), r2(tp)]);
  }
  out.C_rampe_plafond = { attendu: 'crête vraie ≤ plafond en vigueur dans chaque tranche de 50 ms', pire_ecart_db: Math.round(worst * 1000) / 1000, pire_tranche_s: r2(worstAt),
    verdict: worst <= 1e-6 ? 'OK' : 'DÉPASSE', tranches_t_plafond_cretevraie: rows.filter((_, i) => i % 4 === 0) };
}
// D. Relâchement 2000 → 5 ms à 2,0 s : rafales de 0,25 s fortes (0 dBFS) / faibles (−20 dBFS), plafond −6.
{ const n = Math.round(4 * SR), s = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / SR; s[i] = ((t % 0.5) < 0.25 ? 1.0 : 0.1) * Math.sin(2 * Math.PI * 997 * t); }
  const b = await E.renderProject([track(toBuf(s), { ceiling: -6, inputGain: 0, release: 2000, lookahead: 3, oversample: 4 }, [lane('release', [[0, 2000], [2.0, 5]])])], 4, 0, SR);
  const x = b.getChannelData(0);
  // Partie faible (−20 dBFS RMS −23) : 50 à 200 ms après la fin d'une rafale.
  out.D_relachement_2000_vers_5ms = { attendu: 'partie faible ≈ −23 dB RMS si le gain est remonté (5 ms) ; plus bas avec 2000 ms',
    faible_avant_1_30_1_45s_db: rmsDb(x, SR, 1.30, 1.45), faible_apres_3_30_3_45s_db: rmsDb(x, SR, 3.30, 3.45) };
}
// E. Paliers du gain d'entrée : +6 / −6 / 0 / +6 dB (sinus −6 dBFS, plafond −1).
{ const b = await E.renderProject([track(toBuf(sine(4, 0.5)), { ceiling: -1, inputGain: 6, release: 100, lookahead: 3, oversample: 4 }, [lane('inputGain', [[0, 6], [1.0, -6], [2.0, 0], [3.0, 6]])])], 4, 0, SR);
  const x = b.getChannelData(0);
  // Début de chaque changement : l'enveloppe (crête sur une période de 997 Hz) quitte le palier précédent de plus de 0,5 dB.
  const env = t => { let m = 0; for (let i = Math.round(t * SR), e = i + 48; i < e; i++) m = Math.max(m, Math.abs(x[i])); return 20 * Math.log10(m + 1e-12); };
  const cross = (a, z) => { const ref = env(a); for (let t = a; t < z; t += 0.0002) if (Math.abs(env(t) - ref) > 0.5) return r2(t * 1000); return null; };
  out.E_paliers_gain_entree = { attendu: '0–1 s −1,1 ; 1–2 s −12 ; 2–3 s −6 ; 3–4 s −1,1 dB, changements dès 1000 / 2000 / 3000 ms',
    palier_0_1s: peakDb(x, SR, 0.3, 0.95).crete_echantillon_db, palier_1_2s: peakDb(x, SR, 1.1, 1.95).crete_echantillon_db,
    palier_2_3s: peakDb(x, SR, 2.1, 2.95).crete_echantillon_db, palier_3_4s: peakDb(x, SR, 3.1, 3.95).crete_echantillon_db,
    debut_des_changements_ms: [cross(0.9, 1.5), cross(1.9, 2.5), cross(2.9, 3.5)] };
}
return out;
}"""

LIVE_JS = "async () => {" + HELPERS + r"""
await E.init(); await E.resume();
const ctx = E.ctx, sr = ctx.sampleRate;
const code = `class Rec extends AudioWorkletProcessor { process(i) { const x = i[0] && i[0][0]; if (x) this.port.postMessage({ f: currentFrame, d: x.slice(0) }); return true; } } registerProcessor('nova-qa-rec-lim', Rec);`;
await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
const rec = new AudioWorkletNode(ctx, 'nova-qa-rec-lim', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
const chunks = []; rec.port.onmessage = e => chunks.push(e.data);
const sink = ctx.createGain(); sink.gain.value = 0; rec.connect(sink); sink.connect(ctx.destination);
E.masterOutput.connect(rec);
const capture = async (tracks, sec) => {
  tracks.forEach(t => E.updateTrack(t, tracks));
  await new Promise(r => setTimeout(r, 900));
  chunks.length = 0;
  E.startPlayback(0, tracks); const t0 = E.playbackStartTime;
  await new Promise(r => setTimeout(r, sec * 1000 + 300)); E.stopAll();
  await new Promise(r => setTimeout(r, 200));
  const o = new Float32Array(Math.round(sec * sr));
  for (const c of chunks) for (let i = 0; i < c.d.length; i++) { const k = Math.round(c.f + i - t0 * sr); if (k >= 0 && k < o.length) o[k] = c.d[i]; }
  tracks.forEach(t => E.disposeTrack(t.id));
  return o;
};
const y = await capture([track(toBuf(sine(4, 0.5, sr), sr), { ceiling: -1, inputGain: 0, release: 100, lookahead: 3, oversample: 4 }, [lane('inputGain', [[0, 0], [2.0, 12]])])], 3.6);
return { sampleRate: sr, A_lecture_gain_entree_0_vers_12dB: { attendu: 'avant −6,02 dB ; après −1 dBTP (limité)', avant_1_0_1_9s: peakDb(y, sr, 1.0, 1.9), apres_2_3_3_4s: peakDb(y, sr, 2.3, 3.4) } };
}"""

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, executable_path=EXE, args=["--autoplay-policy=no-user-gesture-required"])
    pg = b.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:300]))
    pg.goto(URL, wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_timeout(2500)
    res = {"export": pg.evaluate(EXPORT_JS)}
    if os.environ.get("SANS_LECTURE") != "1":
        res["lecture"] = pg.evaluate(LIVE_JS)
    res["erreurs_page"] = errs[:5]
    b.close()

(OUT / f"mesures_{LABEL}.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
print(json.dumps(res, ensure_ascii=False, indent=1))
