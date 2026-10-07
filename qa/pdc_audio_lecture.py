"""Lecture réelle : instant de départ des clips audio (voix → bus voix + envoi reverb)."""
import json
from playwright.sync_api import sync_playwright
EXE = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
JS = r"""
async () => {
  const { audioEngine: e } = await import('/engine/AudioEngine.ts');
  const { TrackType } = await import('/types.ts');
  await e.init(); await e.resume();
  const LAT = { 'lat-voix': 0.010, 'lat-bus': 0.030, 'lat-verb': 0.050 };
  e.createPluginNode = (pl, bpm, ctx) => { const c = ctx || e.ctx; const i = c.createGain(), o = c.createGain(), d = c.createDelay(1); d.delayTime.value = LAT[pl.id] || 0; i.connect(d); d.connect(o); return { input: i, output: o, node: { latency: LAT[pl.id] || 0 } }; };
  const SR = e.ctx.sampleRate;
  const buf = new AudioBuffer({ length: SR / 10, numberOfChannels: 2, sampleRate: SR });
  const clip = id => ({ id, type: TrackType.AUDIO, start: 1.0, duration: 0.1, offset: 0, buffer: buf, gain: 1, name: id });
  const fx = id => ({ id, type: 'COMPRESSOR', name: id, isEnabled: true, params: {} });
  const base = (id, type, extra) => ({ id, name: id, type, volume: 1, pan: 0, isMuted: false, isSolo: false, clips: [], plugins: [], sends: [], automationLanes: [], ...extra });
  const tr = [
    base('voix', TrackType.AUDIO, { clips: [clip('c-voix')], plugins: [fx('lat-voix')], outputTrackId: 'busvoix', sends: [{ id: 'verb', level: 0.5, isEnabled: true }] }),
    base('busvoix', TrackType.BUS, { plugins: [fx('lat-bus')] }),
    base('verb', TrackType.SEND, { plugins: [fx('lat-verb')] }),
    base('beat', TrackType.AUDIO, { clips: [clip('c-beat')] }),
  ];
  tr.forEach(t => e.updateTrack(t, tr));
  await new Promise(r => setTimeout(r, 300));
  const starts = []; const orig = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when, off, dur) { if (this.buffer === buf) starts.push([when, off || 0]); return orig.call(this, when, off, dur); };
  e.startPlayback(0, tr); const t0 = e.playbackStartTime;
  await new Promise(r => setTimeout(r, 1500)); e.stopAll();
  AudioBufferSourceNode.prototype.start = orig;
  const ms = x => Math.round((x[0] - t0) * 1e6) / 1000;
  // Retards appliqués aux sorties : arrivée au master = départ + latences du chemin + retard PDC.
  const d = e.tracksDSP.get('voix');
  return { departs_ms: starts.map(ms), latence_voix_ms: e.getTrackLatency('voix') * 1000, retard_sortie_vers_bus_ms: d.outDelay.delayTime.value * 1000,
           retard_envoi_reverb_ms: d.sendDelays.get('verb').delayTime.value * 1000,
           arrivee_par_bus_ms: ms(starts[0]) + 10 + d.outDelay.delayTime.value * 1000 + 30,
           arrivee_par_reverb_ms: ms(starts[0]) + 10 + d.sendDelays.get('verb').delayTime.value * 1000 + 50 };
}
"""
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, executable_path=EXE, args=["--autoplay-policy=no-user-gesture-required"]); pg = b.new_page()
    errs = []; pg.on("pageerror", lambda x: errs.append(str(x)[:200]))
    pg.goto("http://localhost:3411/", wait_until="domcontentloaded"); pg.wait_for_timeout(2500)
    print(json.dumps(pg.evaluate(JS), ensure_ascii=False, indent=1)); print("erreurs :", errs[:2]); b.close()
