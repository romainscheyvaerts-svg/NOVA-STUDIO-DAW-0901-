"""Preuves audio du « Gate rythmique » (V21) sur le VRAI moteur de NOVA, navigateur headless.

- Export (renderProject) : un son tenu passe dans le gate (motif Trance 1/16) ; chaque pas
  mesuré (ouvert / fermé) doit suivre le motif SUR LA GRILLE DU MORCEAU, y compris quand
  l'export commence au milieu d'un pas (départ 1,03 s) et quand un effet à latence suit le
  gate (Voix grave / aiguë : PDC).
- Lecture réelle : même mesure sur la sortie du master ; écart des fronts avec l'export.
Sorties : D:\\1 WORK\\CONTENU\\nova-finitions\\gate_preuves.json + WAV.

Usage : serveur `npx vite --port 3435 --strictPort`, puis python qa/gate_preuve.py
"""
import base64, json, os, re, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(r"D:\1 WORK\CONTENU\nova-finitions")
OUT.mkdir(parents=True, exist_ok=True)
EXE = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
URL = os.environ.get("NOVA_URL", "http://127.0.0.1:3435/")
SRC = (Path(__file__).parent / "v21_preuves.py").read_text(encoding="utf-8")
HELPERS = re.search(r'HELPERS = r"""(.*?)"""', SRC, re.S).group(1)

COMMON = HELPERS + r"""
const { gatePattern, V21_PRESETS } = await import('/engine/v21Params.ts');
const PAT = [1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 1];
const trance = () => ({ ...V21_PRESETS.GATEFX.find(p => p.id === 'trance-16').params });
const tone = (sec, sr) => { const n = Math.round(sec * sr), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * 220 * i / sr); return x; };
// Pas à 120 BPM, 1/16 : 125 ms (le clip du son commence à 0,5 s). Ouvert : rms ≈ 0,35 ; fermé : rms < 0,1 (relâchement de 20 ms compris). `t0` = instant du morceau du 1er échantillon de `y`.
const steps = (y, sr, t0, from, to) => {
  const out = [];
  for (let k = Math.ceil(from / 0.125); (k + 1) * 0.125 <= to; k++) {
    const a = Math.round((k * 0.125 + 0.03 - t0) * sr), b = Math.round((k * 0.125 + 0.095 - t0) * sr);
    let s = 0; for (let i = a; i < b; i++) s += y[i] * y[i];
    const r = Math.sqrt(s / Math.max(1, b - a));
    out.push({ pas: k, attendu: PAT[k % 16], mesure: r > 0.2 ? 1 : r < 0.1 ? 0 : 0.5, rms: Math.round(r * 1000) / 1000 });
  }
  return out;
};
// Fronts descendants (fermeture) : instant (s du morceau) où l'enveloppe passe sous la moitié.
const edges = (y, sr, t0, from, to) => {
  const w = Math.round(0.002 * sr), res = [];
  let prev = null;
  for (let i = Math.round((from - t0) * sr); i < Math.round((to - t0) * sr); i += w) {
    let m = 0; for (let j = i; j < i + w; j++) m = Math.max(m, Math.abs(y[j] || 0));
    if (prev !== null && prev >= 0.25 && m < 0.25) res.push(Math.round((i / sr + t0) * 1e4) / 1e4);
    prev = m;
  }
  return res;
};
"""

EXPORT_JS = "async () => {" + COMMON + r"""
const res = {};
const sec = 4;
const tb = toBuf(tone(sec + 2, SR));
// 1. Gate seul, export depuis 0.
{ const t = track('voix', tb, [plugin('GATEFX', trance(), 'g1')]);
  const b = await E.renderProject([t], sec, 0, SR); const y = b.getChannelData(0);
  const st = steps(y, SR, 0, 0.5, sec); res.export_depuis_0 = { pas_justes: st.filter(s => s.mesure === s.attendu).length, pas: st.length, fronts: edges(y, SR, 0, 0.5, 2), detail: st.slice(0, 16).map(s => `${s.pas}:${s.attendu}/${s.rms}`).join(" ") };
  res.wav = { gate_export: wav(b) }; }
// 2. Export qui commence au milieu d'un pas (1,03 s) : le motif reste sur la grille du morceau.
{ const t = track('voix', tb, [plugin('GATEFX', trance(), 'g2')]);
  const b = await E.renderProject([t], 2, 1.03, SR); const y = b.getChannelData(0);
  const st = steps(y, SR, 1.03, 1.125, 3.0); res.export_depuis_1_03 = { pas_justes: st.filter(s => s.mesure === s.attendu).length, pas: st.length }; }
// 3. Effet à latence APRÈS le gate (Voix grave / aiguë, PDC) : sortie toujours sur la grille.
{ const t = track('voix', tb, [plugin('GATEFX', trance(), 'g3'), plugin('VOICESHIFT', { pitch: 0, formant: 0, mix: 1, output: 0 }, 'vs3')]);
  const b = await E.renderProject([t], sec, 0, SR); const y = b.getChannelData(0);
  const st = steps(y, SR, 0, 0.5, sec); res.export_avec_latence_apres = { latence_ms: Math.round(psolaLatencySamples(SR) / SR * 1e5) / 100, pas_justes: st.filter(s => s.mesure === s.attendu).length, pas: st.length, fronts: edges(y, SR, 0, 0.5, 2) };
  res.wav.gate_puis_voix = wav(b); }
return res;
}"""

LIVE_JS = "async () => {" + COMMON + r"""
await E.init(); await E.resume();
const ctx = E.ctx, sr = ctx.sampleRate;
const code = `class Rec extends AudioWorkletProcessor { process(i) { const x = i[0] && i[0][0]; if (x) this.port.postMessage({ f: currentFrame, d: x.slice(0) }); return true; } } registerProcessor('nova-qa-rec-gate', Rec);`;
await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
const rec = new AudioWorkletNode(ctx, 'nova-qa-rec-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
const chunks = []; rec.port.onmessage = e => chunks.push(e.data);
const sink = ctx.createGain(); sink.gain.value = 0; rec.connect(sink); sink.connect(ctx.destination);
E.masterOutput.connect(rec);
const capture = async (tracks, from, sec) => {
  tracks.forEach(t => E.updateTrack(t, tracks));
  await new Promise(r => setTimeout(r, 900));
  chunks.length = 0;
  E.startPlayback(from, tracks); const t0 = E.playbackStartTime;
  await new Promise(r => setTimeout(r, sec * 1000 + 300)); E.stopAll();
  await new Promise(r => setTimeout(r, 200));
  const out = new Float32Array(Math.round((from + sec) * sr));
  for (const c of chunks) for (let i = 0; i < c.d.length; i++) { const k = Math.round(c.f + i - t0 * sr); if (k >= 0 && k < out.length) out[k] = c.d[i]; }
  tracks.forEach(t => E.disposeTrack(t.id));
  return out;
};
const tb = (x) => { const b = new AudioBuffer({ length: x.length, numberOfChannels: 2, sampleRate: sr }); b.getChannelData(0).set(x); b.getChannelData(1).set(x); return b; };
const res = { sampleRate: sr };
{ const y = await capture([track('voix', tb(tone(6, sr)), [plugin('GATEFX', trance(), 'lg1')])], 0, 2.5);
  const st = steps(y, sr, 0, 0.5, 2.4); res.lecture_depuis_0 = { pas_justes: st.filter(s => s.mesure === s.attendu).length, pas: st.length, fronts: edges(y, sr, 0, 0.5, 2) }; }
{ const y = await capture([track('voix', tb(tone(6, sr)), [plugin('GATEFX', trance(), 'lg2')])], 1.03, 2);
  const st = steps(y, sr, 0, 1.25, 2.9); res.lecture_depuis_1_03 = { pas_justes: st.filter(s => s.mesure === s.attendu).length, pas: st.length }; }
{ const y = await capture([track('voix', tb(tone(6, sr)), [plugin('GATEFX', trance(), 'lg3'), plugin('VOICESHIFT', { pitch: 0, formant: 0, mix: 1, output: 0 }, 'lvs3')])], 0, 2.5);
  const st = steps(y, sr, 0, 0.5, 2.4); res.lecture_avec_latence_apres = { pas_justes: st.filter(s => s.mesure === s.attendu).length, pas: st.length, fronts: edges(y, sr, 0, 0.5, 2) }; }
return res;
}"""

with sync_playwright() as p:
    b = p.chromium.launch(headless=True, executable_path=EXE, args=["--autoplay-policy=no-user-gesture-required"])
    pg = b.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:300]))
    pg.goto(URL, wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_timeout(2500)
    res = {"export": pg.evaluate(EXPORT_JS)}
    for name, b64 in (res["export"].pop("wav", {}) or {}).items():
        (OUT / f"gate_{name}.wav").write_bytes(base64.b64decode(b64))
    res["lecture"] = pg.evaluate(LIVE_JS)
    ex, lv = res["export"], res["lecture"]
    # Écart des fronts lecture / export (mêmes instants du morceau attendus).
    def gap(a, b):
        d = [abs(x - y) * 1000 for x in a for y in b if abs(x - y) < 0.03]
        return round(max(d), 2) if d else None
    res["ecart_fronts_lecture_export_ms"] = gap(ex["export_depuis_0"]["fronts"], lv["lecture_depuis_0"]["fronts"])
    res["ecart_fronts_avec_latence_ms"] = gap(ex["export_avec_latence_apres"]["fronts"], lv["lecture_avec_latence_apres"]["fronts"])
    res["erreurs_page"] = errs[:5]
    allok = all(v["pas_justes"] == v["pas"] for d in (ex, lv) for k, v in d.items() if isinstance(v, dict) and "pas" in v)
    res["ok"] = allok and (res["ecart_fronts_lecture_export_ms"] or 99) < 3 and (res["ecart_fronts_avec_latence_ms"] or 99) < 3
    b.close()

(OUT / "gate_preuves.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
print(json.dumps(res, ensure_ascii=False, indent=1)[:5000])
