"""Melodyne en INSERT sur une piste, dans le VRAI moteur de NOVA (navigateur headless) + VRAI pont
(port 8782) + VRAI hôte NovaARAHost.exe + VRAI Melodyne : ce que l'on entend au master.

  piste « voix » (gauche)  : insert Melodyne (ARA) ; le fichier a un clic à 0,5 s, le clip est posé à
                             1,5 s → le clic du plugin doit sortir à 2,000 s du morceau
  piste « ref »  (droite)  : un clic NOVA à 2,000 s (sans plugin), référence

  1. lecture depuis 0 : clic du plugin et clic de référence au même instant (latence compensée)
  2. lecture depuis 1,0 s (saut) : idem ; 3. boucle 1,5–2,6 s, 3 passages : idem à chaque passage
  4. clip déplacé de +1 s : document ARA à jour, le clic du plugin sort à 3,000 s
  5. réglage global du plugin (Volume) : entendu en direct, sans rendu
  6. export (gel par le pont, comme à la sauvegarde) : clic à la même place que la lecture

Usage (serveur NOVA : npx vite --port 3479 --strictPort) :
  NOVA_URL=http://127.0.0.1:3479/ python qa/ara_insert_lecture.py
"""
import json, os, subprocess, sys, time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-ara\insert"))
OUT.mkdir(parents=True, exist_ok=True)
PORT = int(os.environ.get("NOVA_TEST_PORT", "8782"))
URL = os.environ.get("NOVA_URL", "http://127.0.0.1:3479/")
BRIDGE_PY = Path(os.environ.get("NOVA_BRIDGE_PYTHON", r"D:\1 WORK\CODE\NOVA-STUDIO-DAW-0901-\bridge-python\venv\Scripts\python.exe"))
HOST_EXE = ROOT / "nova-ara-host" / "build" / "NovaARAHost_artefacts" / "Release" / "NovaARAHost.exe"
MEL = r"C:\Program Files\Common Files\VST3\Celemony\Melodyne\Melodyne.vst3"
EXE = os.environ.get("NOVA_CHROME", r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe")

JS = r"""
async ({ mel }) => {
  const { audioEngine: e } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const { TrackType } = await window.__novaAppModule('/types.ts');
  const { novaBridge } = await window.__novaAppModule('/services/NovaBridge.ts');
  const { liveAraInserts } = await window.__novaAppModule('/engine/AraInsertNode.ts');
  const { audioBufferRegistry } = await window.__novaAppModule('/utils/audioBufferRegistry.ts');
  const A = await window.__novaAppModule('/utils/araInsert.ts');
  const { buildTempoMap } = await window.__novaAppModule('/utils/tempoMap.ts');
  const { renderTrackFreeze } = await window.__novaAppModule('/services/VstFreeze.ts');
  const out = {};
  await e.init(); await e.resume();
  if (!(await novaBridge.connect())) return { error: 'pont injoignable' };
  out.pont = { version: novaBridge.getBridgeState().version, araInsert: novaBridge.getBridgeState().araInsert };
  const SR = e.ctx.sampleRate; out.sample_rate = SR;
  // Fichier de la voix : clic à 0,5 s puis quatre « notes » (Melodyne les analyse).
  const src = new AudioBuffer({ length: 4 * SR, numberOfChannels: 1, sampleRate: SR });
  const x = src.getChannelData(0); x[Math.round(0.5 * SR)] = 0.9;
  [220, 247, 262, 294].forEach((f, k) => { const a = Math.round((1.0 + 0.6 * k) * SR), n = Math.round(0.5 * SR);
    for (let i = 0; i < n; i++) x[a + i] = 0.25 * Math.sin(2 * Math.PI * f * i / SR) * Math.min(1, i / 480, (n - i) / 480); });
  audioBufferRegistry.register(src, 'buf-ara');
  const ref = new AudioBuffer({ length: SR, numberOfChannels: 1, sampleRate: SR }); ref.getChannelData(0)[Math.round(0.5 * SR)] = 0.9;
  audioBufferRegistry.register(ref, 'buf-ref');
  const clip = (id, bid, buf, start, dur) => ({ id, type: TrackType.AUDIO, start, duration: dur, offset: 0, buffer: buf, bufferId: bid, gain: 1, name: id, fadeIn: 0, fadeOut: 0, color: '#fff' });
  const base = (id, extra) => ({ id, name: id, type: TrackType.AUDIO, volume: 1, pan: 0, isMuted: false, isSolo: false, clips: [], plugins: [], sends: [], automationLanes: [], outputTrackId: 'master', ...extra });
  const ins = { id: 'ins-mel', name: 'Melodyne', type: 'VST3', isEnabled: true, latency: 0, params: { name: 'Melodyne', localPath: mel, ara: 'melodyne' } };
  // Les deux pistes au centre ; le clic de référence est à 1,000 s, celui du plugin à 2,000 s :
  // l'écart mesuré au master doit faire 1,000 s pile (compensation de latence).
  let voix = base('voix', { clips: [clip('c-voix', 'buf-ara', src, 1.5, 4)], plugins: [ins] });
  const refT = base('ref', { clips: [clip('c-ref', 'buf-ref', ref, 0.5, 1)] });
  let tracks = [voix, refT];
  tracks.forEach(t => e.updateTrack(t, tracks));
  const wait = async (fn, ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 20)); } return false; };
  const t0 = performance.now();
  await wait(() => liveAraInserts.get('ins-mel')?.getSlotId(), 240000);
  const node = liveAraInserts.get('ins-mel');
  if (!node?.getSlotId()) return { ...out, error: 'insert pas chargé', info: node?.getInfo() };
  out.chargement_s = Math.round(performance.now() - t0) / 1000;
  out.latence_insert_ms = Math.round(node.latency * 1e5) / 100;
  out.latence_piste_ms = Math.round(e.getTrackLatency('voix') * 1e5) / 100;
  const music = A.araMusicFor(buildTempoMap(95, { numerator: 4, denominator: 4 }));
  const sync = async (tr) => { node.setDocument(A.araDocumentFor(tr, id => audioBufferRegistry.get(id)?.duration ?? null), music); return node.whenSynced(120000); };
  out.document_envoye = await sync(voix);
  out.etat_plugin = await novaBridge.araInsertState(node.getSlotId(), { waitAnalysisS: 60 }).then(s => s.regions.map(r => ({ id: r.id, start: r.start, notes: r.notes.length, premiere_note_s: r.notes[0]?.[3] }))).catch(err => String(err));

  // Enregistreur au master (après la compensation de latence) : AudioWorklet, horodaté à
  // l'échantillon près (currentFrame), dans le même fil que le rendu.
  const recSrc = `class R extends AudioWorkletProcessor { constructor() { super(); this.on = false; this.port.onmessage = (e) => { this.on = !!e.data; }; }
    process(inputs) { const i = inputs[0]; if (this.on && i && i[0]) this.port.postMessage([currentFrame, i[0].slice()]); return true; } }
    registerProcessor('nova-qa-rec', R);`;
  await e.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([recSrc], { type: 'application/javascript' })));
  const recNode = new AudioWorkletNode(e.ctx, 'nova-qa-rec', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
  const tap = e.getMasterMeterInput();
  const mute = e.ctx.createGain(); mute.gain.value = 0;
  tap.connect(recNode); recNode.connect(mute); mute.connect(e.ctx.destination);
  let rec = null;
  recNode.port.onmessage = (ev) => { if (rec) rec.push([ev.data[0] / SR, ev.data[1]]); };
  const play = async (from, secs) => {
    rec = []; recNode.port.postMessage(true); e.startPlayback(from, tracks); const origin = e.playbackStartTime;
    const c0 = e.ctx.currentTime; await wait(() => e.ctx.currentTime - c0 > secs, 60000); e.stopAll();
    await new Promise(r => setTimeout(r, 250));   // la fin de la prise passe avant la suivante
    recNode.port.postMessage(false);
    const blocks = rec; rec = null;
    const clicks = []; let last = -1;
    for (const bl of blocks) { const d = bl[1]; for (let i = 1; i < d.length - 1; i++) {
      // clic = un seul échantillon fort entouré de presque rien (les notes sont des sinus)
      if (Math.abs(d[i]) > 0.2 && Math.abs(d[i - 1]) < 0.05 && Math.abs(d[i + 1]) < 0.05) {
        const s = bl[0] + i / SR - origin; if (s - last > 0.2) clicks.push({ t: Math.round(s * 1e6) / 1e6, v: Math.round(Math.abs(d[i]) * 1000) / 1000 }); last = s; } } }
    return clicks;
  };
  const gap = (c, k = 1) => (c.length > k ? Math.round((c[k].t - c[0].t) * 1e6) / 1000 : null);   // ms
  await play(0, 0.5);   // amorce (premier passage dans le plugin)
  const c1 = await play(0, 2.6);
  out.lecture_depuis_0 = { clics: c1, ecart_ref_plugin_ms: gap(c1), attendu_ms: 1000 };
  const c2 = await play(0.8, 1.8);
  out.saut_depuis_0_8s = { clics: c2, ecart_ref_plugin_ms: gap(c2), attendu_ms: 1000 };
  e.setLoop(true, 0.8, 2.4);
  const c3 = await play(0.8, 4.4);
  e.setLoop(false, 0, 0);
  out.boucle_0_8_2_4 = { clics: c3, ecarts_ms: c3.slice(1).map((c, i) => Math.round((c.t - c3[i].t) * 1e6) / 1000), attendus_ms: '1000 puis 600 / 1000 à chaque passage (boucle de 1,6 s)' };
  // Édition NOVA : clip déplacé de +1 s → document ARA à jour, le clic du plugin sort à 3,000 s.
  voix = { ...voix, clips: [{ ...voix.clips[0], start: 2.5 }] };
  tracks = [voix, refT]; tracks.forEach(t => e.updateTrack(t, tracks));
  out.document_apres_deplacement = await sync(voix);
  out.etat_plugin_apres = await novaBridge.araInsertState(node.getSlotId()).then(s => s.regions.map(r => ({ id: r.id, start: r.start, premiere_note_s: r.notes[0]?.[3] })));
  const c4 = await play(0, 3.6);
  out.lecture_apres_deplacement = { clics: c4, ecart_ref_plugin_ms: gap(c4), attendu_ms: 2000 };
  // Réglage global du plugin (Volume) entendu en direct, sans rendu.
  out.reglage = await novaBridge.araInsertParam(node.getSlotId(), { title: 'Volume', value: 0.2 });
  await new Promise(r => setTimeout(r, 400));
  const c5 = await play(0, 3.6);
  out.lecture_volume_reduit = { clics: c5 };
  if (c4.length > 1 && c5.length > 1) out.volume_ecart_db = Math.round(2000 * Math.log10(c5[1].v / c4[1].v)) / 100;
  // Export : gel par le pont (comme à la sauvegarde / l'export), même plage que la lecture.
  const fr = await renderTrackFreeze(voix, 0);
  const d = fr && audioBufferRegistry.get(fr.clip.bufferId).getChannelData(0);
  let at = null; for (let i = 0; d && i < d.length; i++) if (Math.abs(d[i]) > 0.1) { at = i / SR; break; }
  out.export_clic_s = at === null ? null : Math.round(at * 1e6) / 1e6;
  out.export_pic = d ? Math.round(d.reduce((m, v) => Math.max(m, Math.abs(v)), 0) * 1000) / 1000 : null;
  out.info_insert = node.getAraInfo();
  return out;
}
"""


def main():
    env = dict(os.environ, NOVA_BRIDGE_PORT=str(PORT), NOVA_ARA_HOST=str(HOST_EXE), PYTHONIOENCODING="utf-8")
    log = open(OUT / f"pont-lecture-{PORT}.log", "w", encoding="utf-8")
    br = subprocess.Popen([str(BRIDGE_PY), "nova_bridge_server.py"], cwd=str(ROOT / "bridge-python"), env=env,
                          stdout=log, stderr=subprocess.STDOUT, creationflags=0x08000000)
    rep = {}
    try:
        import socket
        for _ in range(240):
            try:
                socket.create_connection(("127.0.0.1", PORT), 0.5).close()
                break
            except OSError:
                time.sleep(0.5)
        with sync_playwright() as p:
            b = p.chromium.launch(headless=True, executable_path=EXE, args=["--autoplay-policy=no-user-gesture-required"])
            pg = b.new_page()
            errs = []
            pg.on("pageerror", lambda x: errs.append(str(x)[:300]))
            sys.path.insert(0, str(Path(__file__).parent))
            from qalib import APP_MODULE_INIT
            pg.add_init_script(APP_MODULE_INIT)
            pg.add_init_script(f"try {{ localStorage.setItem('nova.bridge.url', 'ws://127.0.0.1:{PORT}'); localStorage.setItem('nova_welcome_seen', '1'); }} catch (e) {{}} window.__araDiag = {1 if os.environ.get('ARA_DIAG') else 0};")
            pg.goto(URL, wait_until="domcontentloaded")
            pg.wait_for_timeout(3000)
            pg.set_default_timeout(900000)
            rep = pg.evaluate(JS, {"mel": MEL})
            rep["erreurs_page"] = errs[:5]
            b.close()
    finally:
        subprocess.run(["taskkill", "/PID", str(br.pid), "/T", "/F"], capture_output=True, creationflags=0x08000000)
        (OUT / "ara_insert_lecture.json").write_text(json.dumps(rep, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
        print(json.dumps(rep, ensure_ascii=False, indent=1, default=str)[:9000])


if __name__ == "__main__":
    main()
