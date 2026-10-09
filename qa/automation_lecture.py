"""Précision de l'automation des effets EN LECTURE (moteur réel, Chrome headless, aucune fenêtre).

Un sinus à −20 dBFS passe dans un effet dont un réglage de niveau est automatisé en paliers
(+12 / 0 dB toutes les 0,6 s, 6 changements) ; la sortie du master est enregistrée
(AudioWorklet témoin) et l'instant de chaque changement est mesuré, comparé à l'instant voulu.
  - Limiteur : gain d'entrée (avec 3 ms d'anticipation, compensée par le PDC) ;
  - Filtre DJ (V21) : sortie (AudioParam du processeur).
Chaque mesure est refaite 3 fois. L'export (renderProject) sert de référence.

Usage : serveur `npx vite --port 3435 --strictPort`, puis python qa/automation_lecture.py <etiquette>
Sortie : D:\\1 WORK\\CONTENU\\nova-finitions\\automation_lecture_<etiquette>.json
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import json, os, re, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(r"D:\1 WORK\CONTENU\nova-finitions")
OUT.mkdir(parents=True, exist_ok=True)
EXE = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
URL = os.environ.get("NOVA_URL", "http://127.0.0.1:3435/")
LABEL = sys.argv[1] if len(sys.argv) > 1 else "mesure"
SRC = (Path(__file__).parent / "limiteur_automation.py").read_text(encoding="utf-8")
HELPERS = re.search(r'HELPERS = r"""(.*?)"""', SRC, re.S).group(1)

COMMON = HELPERS + r"""
const { V21_DEFAULTS } = await import('/engine/v21Params.ts');
const CHANGES = [0.7, 1.3, 1.9, 2.5, 3.1, 3.7];
const steps = (key) => [[0, 0], ...CHANGES.map((t, i) => [t, i % 2 === 0 ? 12 : 0])].map(([time, value], i) => ({ id: key + i, time, value, curveType: 'HOLD' }));
const mkTrack = (buf, kind) => {
  const plugin = kind === 'lim'
    ? { id: 'fx', type: 'LIMITER', name: 'Nova Limiter', isEnabled: true, latency: 0, params: { ...DEFAULT_LIMITER_PARAMS, ceiling: -1, inputGain: 0, release: 100, lookahead: 3, oversample: 4 } }
    : { id: 'fx', type: 'DJFILTER', name: 'DJFILTER', isEnabled: true, latency: 0, params: { ...V21_DEFAULTS.DJFILTER(), filter: 0, output: 0 } };
  const key = kind === 'lim' ? 'inputGain' : 'output';
  return { id: 'beat', name: 'beat', type: TrackType.AUDIO, volume: 1, pan: 0, isMuted: false, isSolo: false, sends: [], automationMode: 'read',
    automationLanes: [{ id: 'l', parameterName: 'plugin::fx::' + key, color: '#fbbf24', isExpanded: true, min: -24, max: 12, points: steps(key) }],
    clips: [{ id: 'c-beat', type: TrackType.AUDIO, start: 0, duration: buf.duration, offset: 0, buffer: buf, gain: 1, name: 'beat' }], plugins: [plugin] };
};
// Instant de chaque changement : enveloppe de crête sur 1 ms, passage du seuil à mi-chemin (0,1 → 0,4).
const changes = (y, sr) => CHANGES.map((t, i) => {
  const up = i % 2 === 0, w = Math.round(0.001 * sr);
  for (let a = Math.round((t - 0.08) * sr); a < Math.round((t + 0.08) * sr); a += 1) {
    let m = 0; for (let j = a; j < a + w; j++) m = Math.max(m, Math.abs(y[j] || 0));
    // (Un trou de la capture — zéros — n'est pas un changement : le niveau bas vaut 0,1.)
    if (up ? m > 0.25 : m < 0.25 && m > 0.05) return Math.round(((up ? a + w : a + w) / sr - t) * 1e5) / 100; // ms d'écart
  }
  return null;
});
const stats = (arr) => { const v = arr.flat().filter(x => x !== null); const abs = v.map(Math.abs); return { ecarts_ms: v, moyen_ms: Math.round(v.reduce((s, x) => s + x, 0) / Math.max(1, v.length) * 100) / 100, pire_ms: Math.round(Math.max(...abs) * 100) / 100, dispersion_ms: Math.round((Math.max(...v) - Math.min(...v)) * 100) / 100 }; };
"""

JS = "async () => {" + COMMON + r"""
await E.init(); await E.resume();
const ctx = E.ctx, sr = ctx.sampleRate;
const res = { sampleRate: sr };
for (const kind of ['lim', 'dj']) {
  const b = await E.renderProject([mkTrack(toBuf(sine(4.2, 0.1)), kind)], 4.2, 0, SR);
  res[kind + '_export'] = stats([changes(b.getChannelData(0), SR)]);
}
const code = `class Rec extends AudioWorkletProcessor { process(i) { const x = i[0] && i[0][0]; if (x) this.port.postMessage({ f: currentFrame, d: x.slice(0) }); return true; } } registerProcessor('nova-qa-rec-auto', Rec);`;
await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
const rec = new AudioWorkletNode(ctx, 'nova-qa-rec-auto', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
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
for (const kind of ['lim', 'dj']) {
  const runs = [];
  for (let r = 0; r < 3; r++) runs.push(changes(await capture([mkTrack(toBuf(sine(4.2, 0.1, sr), sr), kind)], 4.0), sr));
  res[kind + '_lecture'] = stats(runs);
}
return res;
}"""

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, executable_path=EXE, args=["--autoplay-policy=no-user-gesture-required"])
    pg = b.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:300]))
    pg.goto(URL, wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_timeout(2500)
    res = pg.evaluate(JS)
    res["erreurs_page"] = errs[:5]
    b.close()

(OUT / f"automation_lecture_{LABEL}.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
print(json.dumps({k: ({kk: vv for kk, vv in v.items() if kk != 'ecarts_ms'} if isinstance(v, dict) else v) for k, v in res.items()}, ensure_ascii=False, indent=1))
