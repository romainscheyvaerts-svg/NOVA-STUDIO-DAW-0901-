"""Preuve audio de la compensation de latence (PDC) de NOVA, sur l'export réel.

Faux plugins à latence exacte (DelayNode, comme un VST qui annonce sa latence) :
  voix (insert 10 ms) → bus voix (insert 30 ms) → master
  voix → envoi → reverb (insert 50 ms) → master
  beat → master (sans effet)
Un clic à 1,000 s sur la voix et sur le beat : chaque chemin doit tomber à 1,000 s.
"""
import json
from playwright.sync_api import sync_playwright

EXE = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
JS = r"""
async () => {
  const { audioEngine } = await import('/engine/AudioEngine.ts');
  const { TrackType } = await import('/types.ts');
  const SR = 48000;
  const LAT = { 'lat-voix': 0.010, 'lat-bus': 0.030, 'lat-verb': 0.050 };
  // Faux plugin : retard exact + latence annoncée (comme un VST3 via le pont).
  audioEngine.createPluginNode = (plugin, bpm, ctx) => {
    const c = ctx || audioEngine.ctx;
    const input = c.createGain(), output = c.createGain(), d = c.createDelay(1);
    d.delayTime.value = LAT[plugin.id]; input.connect(d); d.connect(output);
    return { input, output, node: { latency: LAT[plugin.id] } };
  };
  const click = (() => { const b = new AudioBuffer({ length: 4800, numberOfChannels: 2, sampleRate: SR });
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
  const onset = buf => { const x = buf.getChannelData(0); for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 0.05) return i / SR; return null; };
  const out = {};
  for (const [nom, sc] of [['beat seul', scene(false, false, true)], ['voix → bus voix (10+30 ms)', scene(true, false, false)],
                           ['voix → envoi reverb (10+50 ms)', scene(false, true, false)]]) {
    const b = await audioEngine.renderProject(sc, 2, 0, SR);
    const t = onset(b);
    out[nom] = t === null ? null : Math.round(t * 1e6) / 1000;   // ms
  }
  return out;
}
"""
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, executable_path=EXE, args=["--autoplay-policy=no-user-gesture-required"])
    pg = b.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
    pg.goto("http://localhost:3411/", wait_until="domcontentloaded", timeout=60000)
    res = pg.evaluate(JS)
    print(json.dumps(res, ensure_ascii=False, indent=1))
    ok = all(v is not None and abs(v - 1000.0) < 0.05 for v in res.values())
    print("ALIGNÉ À 1000,00 ms PARTOUT" if ok else "DÉCALAGE", "| erreurs page :", errs[:2])
    b.close()
