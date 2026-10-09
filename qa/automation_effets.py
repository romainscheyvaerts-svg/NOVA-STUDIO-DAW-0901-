"""Preuve : l'automation d'un paramètre d'effet est rejouée à l'export (V6).

Faux effet natif (gain piloté par updateParams({ level })), comme un effet
Nova. Voie « plugin::fx::level » : 1 jusqu'à 1 s, puis 0,25 à partir de 2 s.
L'export doit passer de 0 dB à -12 dB. En mode Off, la voie est ignorée.

Usage : NOVA_URL=http://localhost:3412/ python qa/automation_effets.py
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import json, os
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = os.environ.get("NOVA_URL", "http://localhost:3412/")
OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-protools\automation"))
EXE = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
JS = r"""
async () => {
  const { audioEngine } = await import('/engine/AudioEngine.ts');
  const { TrackType } = await import('/types.ts');
  const SR = 48000;
  audioEngine.createPluginNode = (plugin, bpm, ctx) => {
    const c = ctx || audioEngine.ctx;
    const g = c.createGain();
    const node = { latency: 0, updateParams: p => { if (typeof p.level === 'number') g.gain.setValueAtTime(p.level, c.currentTime); } };
    return { input: g, output: g, node };
  };
  const tone = new AudioBuffer({ length: SR * 4, numberOfChannels: 1, sampleRate: SR });
  const x = tone.getChannelData(0); for (let i = 0; i < x.length; i++) x[i] = 0.25 * Math.sin(2 * Math.PI * 440 * i / SR);
  const lane = { id: 'l', parameterName: 'plugin::fx::level', color: '', isExpanded: true, min: 0, max: 1,
    points: [{ id: 'a', time: 0, value: 1 }, { id: 'b', time: 1, value: 1 }, { id: 'c', time: 2, value: 0.25 }] };
  const track = mode => [{ id: 'v', name: 'v', type: TrackType.AUDIO, volume: 1, pan: 0, isMuted: false, isSolo: false, sends: [], automationMode: mode,
    plugins: [{ id: 'fx', type: 'COMPRESSOR', name: 'fx', isEnabled: true, params: { level: 1 } }],
    clips: [{ id: 'c', type: TrackType.AUDIO, start: 0, duration: 4, offset: 0, buffer: tone, gain: 1, name: 'c' }], automationLanes: [lane] }];
  const rms = (b, a, z) => { const d = b.getChannelData(0); let s = 0, n = 0; for (let i = Math.floor(a * SR); i < Math.floor(z * SR); i++) { s += d[i] * d[i]; n++; } return 10 * Math.log10(s / n); };
  const out = {};
  for (const mode of ['read', 'off']) {
    const b = await audioEngine.renderProject(track(mode), 4, 0, SR);
    const ref = rms(b, 0.1, 0.9);
    out[mode] = { '0.1-0.9 s': 0, '1.4-1.6 s': +(rms(b, 1.4, 1.6) - ref).toFixed(2), '2.2-3.8 s': +(rms(b, 2.2, 3.8) - ref).toFixed(2) };
  }
  return out;
}
"""
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, executable_path=EXE, args=["--autoplay-policy=no-user-gesture-required"])
    pg = b.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
    pg.goto(URL, wait_until="domcontentloaded", timeout=60000)
    res = pg.evaluate(JS)
    ok = abs(res["read"]["2.2-3.8 s"] + 12.04) < 0.5 and abs(res["read"]["1.4-1.6 s"] + 4.4) < 1.5 and abs(res["off"]["2.2-3.8 s"]) < 0.3
    res["ok"] = ok
    res["erreurs_page"] = errs[:3]
    print(json.dumps(res, ensure_ascii=False, indent=1))
    (OUT / "automation_effets_resultats.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    b.close()
