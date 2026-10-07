"""Preuve de la compensation de latence des pistes MIDI (export + lecture).

Export : piste MIDI (synthé) avec un faux plugin à 30 ms, envoyée vers un bus à
20 ms ; un clic audio à 1,000 s sur une piste audio. La note MIDI doit démarrer
au même endroit avec ou sans les plugins (la latence est compensée).
Lecture : on espionne triggerTrackAttack pendant une vraie lecture et on vérifie
que la note est programmée 50 ms plus tôt que sans latence.
"""
import json, sys
from playwright.sync_api import sync_playwright

EXE = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
JS = r"""
async (nova) => {
  const { audioEngine } = await import('/engine/AudioEngine.ts');
  const { TrackType } = await import('/types.ts');
  const SR = 48000;
  const LAT = { 'lat-synth': 0.030, 'lat-bus': 0.020 };
  audioEngine.createPluginNode = (plugin, bpm, ctx) => {
    const c = ctx || audioEngine.ctx;
    const input = c.createGain(), output = c.createGain(), d = c.createDelay(1);
    d.delayTime.value = LAT[plugin.id] || 0; input.connect(d); d.connect(output);
    return { input, output, node: { latency: LAT[plugin.id] || 0 } };
  };
  const fx = id => ({ id, type: 'COMPRESSOR', name: id, isEnabled: true, params: {} });
  const base = (id, type, extra) => ({ id, name: id, type, volume: 1, pan: 0, isMuted: false, isSolo: false, clips: [], plugins: [], sends: [], automationLanes: [], ...extra });
  // --nova : la piste MIDI joue le synthé NOVA (V24) au lieu de l'ancien synthé.
  const novaSynth = nova ? (await import('/utils/novaSynthPresets.ts')).presetSettings('pluck-trap') : undefined;
  const midiClip = { id: 'm1', type: TrackType.MIDI, start: 1.0, duration: 0.5, offset: 0, name: 'm', notes: [{ id: 'n1', pitch: 69, start: 0, duration: 0.3, velocity: 1 }] };
  const scene = withFx => [
    base('synth', TrackType.MIDI, { ...(novaSynth ? { novaSynth } : {}), clips: [midiClip], plugins: withFx ? [fx('lat-synth')] : [], outputTrackId: withFx ? 'bus' : undefined }),
    base('bus', TrackType.BUS, { plugins: [fx('lat-bus')] }),
  ];
  const onset = buf => { const x = buf.getChannelData(0); let pk = 0; for (const v of x) pk = Math.max(pk, Math.abs(v));
    for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > pk * 0.05) return i / SR; return null; };
  const out = {};
  for (const [nom, withFx] of [['sans plugin', false], ['synthé 30 ms → bus 20 ms', true]]) {
    const b = await audioEngine.renderProject(scene(withFx), 2, 0, SR);
    out['export : ' + nom] = Math.round(onset(b) * 1e6) / 1000;
  }
  // Lecture réelle : instants programmés pour l'attaque de la note.
  await audioEngine.init(); await audioEngine.resume();
  const calls = [];
  const orig = audioEngine.triggerTrackAttack.bind(audioEngine);
  audioEngine.triggerTrackAttack = (id, p, v, t) => { calls.push({ id, t }); return orig(id, p, v, t); };
  const live = async withFx => {
    const tr = scene(withFx);
    tr.forEach(t => audioEngine.updateTrack ? audioEngine.updateTrack(t, tr) : null);
    await new Promise(r => setTimeout(r, 300));
    calls.length = 0;
    audioEngine.startPlayback(0, tr);
    const t0 = audioEngine.playbackStartTime;
    await new Promise(r => setTimeout(r, 1600));
    audioEngine.stopAll?.();
    const c = calls.find(x => x.id === 'synth');
    return c ? Math.round((c.t - t0) * 1e6) / 1000 : ('aucune : ' + JSON.stringify(calls.slice(0, 5)) + ' liveTracks=' + (audioEngine.liveTracks ? audioEngine.liveTracks.map(t => t.id + ':' + (t.plugins||[]).length).join(',') : 'aucun') + ' playing=' + audioEngine.isPlaying);
  };
  out['lecture : synthé 30 ms → bus 20 ms'] = await live(true);
  out['lecture : sans plugin (ms après le départ)'] = await live(false);
  out['latence compensée lue par le moteur (ms)'] = Math.round(audioEngine.getTrackLatency('synth') * 1e6) / 1000;
  return out;
}
"""
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, executable_path=EXE, args=["--autoplay-policy=no-user-gesture-required"])
    pg = b.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
    pg.goto(next((a for a in sys.argv[1:] if not a.startswith("--")), "http://localhost:3411/"), wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_timeout(3000)
    res = pg.evaluate(JS, "--nova" in sys.argv)
    print(json.dumps(res, ensure_ascii=False, indent=1))
    print("erreurs page :", errs[:3])
    b.close()
