"""Preuve audio de la compensation de latence (PDC) de NOVA, sur l'export réel ET en lecture,
à chaque fréquence de projet (44,1 / 48 / 96 kHz par défaut ; PDC_RATES=44100,48000 pour choisir).

Faux plugins à latence exacte (DelayNode, comme un VST qui annonce sa latence) :
  voix (insert 10 ms) → bus voix (insert 30 ms) → master
  voix → envoi → reverb (insert 50 ms) → master
  beat → master (sans effet)
Un clic à 1,000 s sur la voix et sur le beat : chaque chemin doit tomber à 1,000 s, à l'export
(rendu hors ligne) comme en lecture (enregistrée au master, à l'échantillon près).
Le moteur est réglé sur la fréquence du projet (contexte audio recréé à chaque changement).
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import json, os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

EXE = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
RATES = [int(x) for x in os.environ.get("PDC_RATES", "44100,48000,96000").split(",")]
OUT = os.environ.get("QA_OUT")
JS = r"""
async ({ SR }) => {
  const { audioEngine } = await import('/engine/AudioEngine.ts');
  const { TrackType } = await import('/types.ts');
  await audioEngine.setSampleRate(SR);
  await audioEngine.init(); await audioEngine.resume();
  audioEngine.setSafetyLimiter(false);
  const LAT = { 'lat-voix': 0.010, 'lat-bus': 0.030, 'lat-verb': 0.050 };
  // Faux plugin : retard exact + latence annoncée (comme un VST3 via le pont).
  audioEngine.createPluginNode = (plugin, bpm, ctx) => {
    const c = ctx || audioEngine.ctx;
    const input = c.createGain(), output = c.createGain(), d = c.createDelay(1);
    d.delayTime.value = LAT[plugin.id]; input.connect(d); d.connect(output);
    return { input, output, node: { latency: LAT[plugin.id] } };
  };
  const click = (() => { const b = new AudioBuffer({ length: Math.round(SR / 10), numberOfChannels: 2, sampleRate: SR });
    for (let ch = 0; ch < 2; ch++) { const x = b.getChannelData(ch); x[0] = 1; } return b; })();
  const clip = id => ({ id, type: TrackType.AUDIO, start: 1.0, duration: 0.1, offset: 0, buffer: click, gain: 1, name: id });
  const fx = id => ({ id, type: 'COMPRESSOR', name: id, isEnabled: true, params: {} });
  const base = (id, type, extra) => ({ id, name: id, type, volume: 1, pan: 0, isMuted: false, isSolo: false, clips: [], plugins: [], sends: [], automationLanes: [], ...extra });
  const scene = (voiceMain, voiceSend, beatOn) => [
    base('voix', TrackType.AUDIO, { clips: [clip('c-voix')], plugins: [fx('lat-voix')], outputTrackId: 'busvoix',
      sends: [{ id: 'verb', level: voiceSend ? 1 : 0, isEnabled: voiceSend }] }),
    base('busvoix', TrackType.BUS, { plugins: [fx('lat-bus')], volume: voiceMain ? 1 : 0 }),
    base('verb', TrackType.SEND, { plugins: [fx('lat-verb')] }),
    base('beat', TrackType.AUDIO, { clips: [clip('c-beat')], isMuted: !beatOn }),
  ];
  const onset = x => { for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 0.05) return i / SR; return null; };
  // Lecture : enregistreur au master, horodaté à l'échantillon (currentFrame).
  const recSrc = `class R extends AudioWorkletProcessor { constructor() { super(); this.on = false; this.port.onmessage = (e) => { this.on = !!e.data; }; }
    process(inputs) { const i = inputs[0]; if (this.on && i && i[0]) this.port.postMessage([currentFrame, i[0].slice()]); return true; } }
    registerProcessor('nova-qa-pdc', R);`;
  await audioEngine.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([recSrc], { type: 'application/javascript' })));
  const live = async (tracks) => {
    tracks.forEach(t => audioEngine.updateTrack(t, tracks));
    await new Promise(r => setTimeout(r, 400));
    const rec = new AudioWorkletNode(audioEngine.ctx, 'nova-qa-pdc', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
    const tap = audioEngine.getMasterMeterInput(); const mute = audioEngine.ctx.createGain(); mute.gain.value = 0;
    tap.connect(rec); rec.connect(mute); mute.connect(audioEngine.ctx.destination);
    const blocks = []; rec.port.onmessage = ev => blocks.push(ev.data); rec.port.postMessage(true);
    const at = Math.ceil((audioEngine.ctx.currentTime + 0.3) * SR) / SR;
    audioEngine.startPlayback(0, tracks, { at }); const origin = audioEngine.playbackStartTime;
    const c0 = audioEngine.ctx.currentTime, w0 = performance.now();
    while (audioEngine.ctx.currentTime - c0 < 1.4 && performance.now() - w0 < 20000) await new Promise(r => setTimeout(r, 50));
    audioEngine.stopAll(); rec.port.postMessage(false);
    try { tap.disconnect(rec); rec.disconnect(); mute.disconnect(); } catch (e) {}
    const f0 = Math.round(origin * SR);
    for (const [fr, a] of blocks) for (let i = 0; i < a.length; i++) if (Math.abs(a[i]) > 0.05) return (fr + i - f0) / SR;
    return null;
  };
  const out = { contexte: audioEngine.ctx.sampleRate, export: {}, lecture: {} };
  for (const [nom, sc] of [['beat seul', scene(false, false, true)], ['voix → bus voix (10+30 ms)', scene(true, false, false)],
                           ['voix → envoi reverb (10+50 ms)', scene(false, true, false)]]) {
    const b = await audioEngine.renderProject(sc, 2, 0, SR);
    out.frequence_export = b.sampleRate;
    const t = onset(b.getChannelData(0));
    out.export[nom] = t === null ? null : Math.round(t * 1e6) / 1000;   // ms
    const tl = await live(sc);
    out.lecture[nom] = tl === null ? null : Math.round(tl * 1e6) / 1000;
    sc.forEach(t => audioEngine.disposeTrack(t.id));
  }
  return out;
}
"""
res = {}
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, executable_path=EXE, args=["--autoplay-policy=no-user-gesture-required"])
    pg = b.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
    pg.goto(os.environ.get("NOVA_URL", "http://localhost:3411/"), wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_timeout(2500)
    ok = True
    for sr in RATES:
        r = pg.evaluate(JS, {"SR": sr})
        vals = list(r["export"].values()) + list(r["lecture"].values())
        r["aligne_1000_ms"] = all(v is not None and abs(v - 1000.0) < 0.05 for v in vals) and r["contexte"] == sr and r["frequence_export"] == sr
        ok = ok and r["aligne_1000_ms"]
        res[str(sr)] = r
        print(sr, json.dumps(r, ensure_ascii=False))
    res["erreurs_page"] = errs[:3]
    print("ALIGNÉ À 1000,00 ms PARTOUT (export et lecture, toutes fréquences)" if ok else "DÉCALAGE", "| erreurs page :", errs[:2])
    b.close()
if OUT:
    Path(OUT).mkdir(parents=True, exist_ok=True)
    (Path(OUT) / "pdc_preuve.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
sys.exit(0 if ok else 1)
