"""VST3 dans un projet en 48 kHz (ou PROJET_SR) : VRAI pont de ce dépôt (port 8786), VRAI hôte natif
NovaVSTHost.exe, VRAI FabFilter Pro-C 3 (comme qa/vst_native_parite.py). Navigateur headless, aucune
fenêtre (pas d'éditeur ouvert ; une fenêtre de licence serait fermée par « Quitter » côté pont).

  1. moteur de NOVA à la fréquence du projet ; le pont charge Pro-C 3 à cette fréquence
     (LOAD_PLUGIN sample_rate, relu dans le journal du pont : setupProcessing de l'hôte) ;
  2. Pro-C 3 réglé (2:1, seuil −24 dB, attaque 5 ms, relâchement 80 ms) sur une piste voix ;
  3. lecture (temps réel, enregistrée au master à l'échantillon près) = export (vrai pipeline :
     VST rendus par le pont, puis WAV 32 bits flottants) ;
  4. latence du plugin compensée : clic à la même place.

Usage : NOVA_URL=http://127.0.0.1:3492/ python qa/frequence_vst.py
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import json, os, re, socket, subprocess, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright
from qalib import APP_MODULE_INIT, CHROME  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
ROOT = Path(__file__).resolve().parents[1]
URL = os.environ.get("NOVA_URL", "http://127.0.0.1:3492/")
OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-frequence"))
OUT.mkdir(parents=True, exist_ok=True)
PORT = int(os.environ.get("NOVA_TEST_PORT", "8786"))
SR = int(os.environ.get("PROJET_SR", "48000"))
BRIDGE_PY = Path(os.environ.get("NOVA_BRIDGE_PYTHON", r"D:\1 WORK\CODE\NOVA-STUDIO-DAW-0901-\bridge-python\venv\Scripts\python.exe"))
PROC3 = r"C:\Program Files\Common Files\VST3\FabFilter\FabFilter Pro-C 3.vst3"

JS = r"""
async ({ path, SR }) => {
  const M = p => window.__novaAppModule(p);
  const { audioEngine: e } = await M('/engine/AudioEngine.ts');
  const { TrackType } = await M('/types.ts');
  const { novaBridge } = await M('/services/NovaBridge.ts');
  const { liveVstNodes } = await M('/engine/VSTPluginNode.ts');
  const X = await M('/services/ExportPipeline.ts');
  const { prepareTracksForOffline } = await M('/services/VstFreeze.ts');
  const AF = await M('/utils/audioFormats.ts');
  const out = {};
  await e.setSampleRate(SR); await e.init(); await e.resume();
  out.contexte = e.ctx.sampleRate;
  e.setSafetyLimiter(false);
  if (!(await novaBridge.connect())) return { ...out, erreur: 'pont injoignable' };
  out.pont = novaBridge.getBridgeState().version;
  // Signal : clic à 0,05 s puis rafales (sinus 220 + 3 kHz) qui font travailler le compresseur.
  const LEN = 3;
  const v = new AudioBuffer({ length: LEN * SR, numberOfChannels: 1, sampleRate: SR });
  { const x = v.getChannelData(0); x[Math.round(0.05 * SR)] = 0.7;
    for (let k = 0; k < 5; k++) { const a = Math.round((0.3 + 0.5 * k) * SR), n = Math.round(0.35 * SR);
      for (let i = 0; i < n; i++) { const t = i / SR; x[a + i] = (0.35 + 0.1 * k) * Math.min(1, i / 240, (n - i) / 240) * (Math.sin(2 * Math.PI * 220 * t) + 0.4 * Math.sin(2 * Math.PI * 3000 * t)); } } }
  const { audioBufferRegistry } = await M('/utils/audioBufferRegistry.ts');
  audioBufferRegistry.register(v, 'buf-voix-vst');   // le gel / l'export relisent le son par son identifiant
  const mkTracks = (pl) => [{ id: 'voix', name: 'voix', type: TrackType.AUDIO, volume: 1, pan: 0, isMuted: false, isSolo: false, outputTrackId: 'master',
    clips: [{ id: 'c-voix', type: TrackType.AUDIO, start: 0.5, duration: LEN, offset: 0, buffer: v, bufferId: 'buf-voix-vst', gain: 1, name: 'v', fadeIn: 0, fadeOut: 0, color: '#fff' }],
    plugins: [pl], sends: [], automationLanes: [] }];
  const wait = async (fn, ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
  const play = async (tracks, secs) => { e.startPlayback(0, tracks); const c0 = e.ctx.currentTime; while (e.ctx.currentTime - c0 < secs) await new Promise(r => setTimeout(r, 50)); e.stopAll(); await new Promise(r => setTimeout(r, 300)); };
  // 1. Réglage de Pro-C 3 (2:1, −24 dB, 5 ms, 80 ms), puis son état complet relu (comme un projet sauvegardé).
  let tracks = mkTracks({ id: 'proc3', name: 'FabFilter Pro-C 3', type: 'VST3', isEnabled: true, latency: 0, params: { name: 'FabFilter Pro-C 3', localPath: path } });
  tracks.forEach(t => e.updateTrack(t, tracks));
  const t0 = performance.now();
  await wait(() => liveVstNodes.get('proc3')?.getSlotId(), 240000);
  let node = liveVstNodes.get('proc3');
  if (!node?.getSlotId()) return { ...out, erreur: 'Pro-C 3 pas chargé', etat: node && node.status };
  out.chargement_s = Math.round(performance.now() - t0) / 1000;
  const set = await novaBridge.setParams(node.getSlotId(), [{ name: 'ratio', text: '2:1' }, { name: 'threshold', real: -24 }, { name: 'attack', real: 5 }, { name: 'release', real: 80 }]);
  out.reglages = (set.results || []).map(r => ({ nom: r.name, texte: r.text ?? r.text_after ?? null }));
  // L'hôte natif n'applique un réglage reçu (SET_PARAMS) au processeur qu'au bloc audio suivant :
  // une écoute d'abord, sinon l'état relu serait l'ancien (constat noté, sans lien avec la fréquence).
  await play(tracks, LEN + 1.5);
  const state = await novaBridge.getPluginState(node.getSlotId());
  out.etat_relu_octets = state ? state.length : 0;
  e.disposeTrack('voix');
  // 2. Projet rouvert : Pro-C 3 rechargé depuis cet état (instance NEUVE, comme à l'ouverture d'un projet).
  tracks = mkTracks({ id: 'proc3b', name: 'FabFilter Pro-C 3', type: 'VST3', isEnabled: true, latency: 0, params: { name: 'FabFilter Pro-C 3', localPath: path, stateB64: state } });
  tracks.forEach(t => e.updateTrack(t, tracks));
  await wait(() => liveVstNodes.get('proc3b')?.getSlotId(), 240000);
  node = liveVstNodes.get('proc3b');
  if (!node?.getSlotId()) return { ...out, erreur: 'Pro-C 3 (état) pas rechargé' };
  await new Promise(r => setTimeout(r, 800));
  out.latence_plugin_ms = Math.round((node.latency || 0) * 1e5) / 100;
  out.latence_piste_ms = Math.round(e.getTrackLatency('voix') * 1e5) / 100;
  const DUR = 4, n = DUR * SR;
  // 3. Lecture enregistrée au master (1re écoute de l'instance neuve).
  const recSrc = `class R extends AudioWorkletProcessor { constructor() { super(); this.on = false; this.port.onmessage = (e) => { this.on = !!e.data; }; }
    process(inputs) { const i = inputs[0]; if (this.on && i && i.length) this.port.postMessage([currentFrame, i[0].slice(), (i[1] || i[0]).slice()]); return true; } }
    registerProcessor('nova-qa-rec-vst', R);`;
  await e.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([recSrc], { type: 'application/javascript' })));
  const capture = async () => {
    const rec = new AudioWorkletNode(e.ctx, 'nova-qa-rec-vst', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
    const tap = e.getMasterMeterInput(); const mute = e.ctx.createGain(); mute.gain.value = 0;
    tap.connect(rec); rec.connect(mute); mute.connect(e.ctx.destination);
    const blocks = []; rec.port.onmessage = ev => blocks.push(ev.data); rec.port.postMessage(true);
    const at = Math.ceil((e.ctx.currentTime + 0.4) * SR) / SR;
    e.startPlayback(0, tracks, { at }); const origin = e.playbackStartTime;
    const c0 = e.ctx.currentTime, w0 = performance.now();
    while (e.ctx.currentTime - c0 < DUR + 0.8 && performance.now() - w0 < 60000) await new Promise(r => setTimeout(r, 50));
    e.stopAll(); await new Promise(r => setTimeout(r, 200)); rec.port.postMessage(false);
    try { tap.disconnect(rec); rec.disconnect(); mute.disconnect(); } catch (err) {}
    const L = new Float32Array(n), R = new Float32Array(n), f0 = Math.round(origin * SR);
    for (const [fr, a, b] of blocks) for (let i = 0; i < a.length; i++) { const k = fr + i - f0; if (k >= 0 && k < n) { L[k] = a[i]; R[k] = b[i]; } }
    return [L, R];
  };
  const lecture1 = await capture();
  // 4. Export par le vrai pipeline (VST rendus par le pont, WAV 32 bits flottants).
  const prep = await prepareTracksForOffline(tracks);
  let exp;
  try {
    exp = await X.runExport(prep.tracks, { source: 'MASTER', start: 0, end: DUR, tail: { mode: 'off', seconds: 0 }, format: 'WAV', bits: 32, mp3Kbps: 320,
      sampleRate: SR, layout: 'stereo', dither: false, normalize: 'off', meta: { title: 'VST' }, naming: { title: 'VST' }, baseName: 'vst' });
  } finally { prep.cleanup?.(); }
  out.export_par_le_pont = prep.tracks[0].isFrozen === true;
  const d = AF.decodeWav(new Uint8Array(await exp.download.blob.arrayBuffer()));
  out.export_frequence_fichier = d.sampleRate;
  const EL = d.floats[0], ER = d.floats[1];
  const compare = ([L, R]) => {
    const first = x => { for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 0.05) return i; return -1; };
    let maxd = 0, at_ = -1, peak = 0;
    for (let i = 0; i < n; i++) { const dd = Math.max(Math.abs(L[i] - EL[i]), Math.abs(R[i] - ER[i])); if (dd > maxd) { maxd = dd; at_ = i; } peak = Math.max(peak, Math.abs(EL[i])); }
    const prof = []; const W = Math.round(0.25 * SR);
    for (let a = 0; a < n; a += W) { let m = 0; for (let i = a; i < Math.min(n, a + W); i++) m = Math.max(m, Math.abs(L[i] - EL[i])); prof.push(+(20 * Math.log10(m + 1e-30)).toFixed(0)); }
    return { clic_lecture_ech: first(L), clic_export_ech: first(EL), ecart_max: maxd, ecart_max_lsb16: +(maxd * 32768).toFixed(3), ecart_max_dbfs: +(20 * Math.log10(maxd + 1e-30)).toFixed(1),
      a_l_echantillon: at_, crete_export: +peak.toFixed(4), profil_dbfs: prof };
  };
  const essais = [compare(lecture1)];
  // 2e écoute (instance qui a déjà joué) : relevée aussi.
  essais.push(compare(await capture()));
  out.lecture_vs_export = essais[0];
  out.lecture_vs_export.ecarts_lsb16_1re_et_2e_ecoute = essais.map(x => x.ecart_max_lsb16);
  out.deuxieme_ecoute_profil_dbfs = essais[1].profil_dbfs;
  // Réduction de gain : le compresseur travaille (sinon la comparaison ne prouverait rien).
  let pin = 0, pout = 0; { const x = v.getChannelData(0); for (let i = Math.round(2.3 * SR); i < Math.round(2.6 * SR); i++) pin = Math.max(pin, Math.abs(x[i])); for (let i = Math.round(2.8 * SR); i < Math.round(3.1 * SR); i++) pout = Math.max(pout, Math.abs(EL[i])); }
  out.reduction_derniere_rafale_db = +(20 * Math.log10(pin / Math.max(pout, 1e-9))).toFixed(2);
  e.disposeTrack('voix');
  return out;
}
"""


def main():
    env = dict(os.environ, NOVA_BRIDGE_PORT=str(PORT), PYTHONIOENCODING="utf-8")
    logp = OUT / f"pont-vst-{SR}.log"
    log = open(logp, "w", encoding="utf-8")
    br = subprocess.Popen([str(BRIDGE_PY), "nova_bridge_server.py"], cwd=str(ROOT / "bridge-python"), env=env,
                          stdout=log, stderr=subprocess.STDOUT, creationflags=0x08000000)
    rep = {"projet": SR, "port_pont": PORT}
    try:
        for _ in range(240):
            try:
                socket.create_connection(("127.0.0.1", PORT), 0.5).close()
                break
            except OSError:
                time.sleep(0.5)
        with sync_playwright() as p:
            b = p.chromium.launch(headless=True, executable_path=CHROME, args=["--autoplay-policy=no-user-gesture-required"])
            pg = b.new_page()
            errs = []
            pg.on("pageerror", lambda x: errs.append(str(x)[:300]))
            pg.add_init_script(APP_MODULE_INIT)
            pg.add_init_script(f"try {{ localStorage.setItem('nova.bridge.url', 'ws://127.0.0.1:{PORT}'); localStorage.setItem('nova_welcome_seen', '1'); }} catch (e) {{}}")
            pg.goto(URL, wait_until="domcontentloaded", timeout=120000)
            pg.wait_for_timeout(3000)
            pg.set_default_timeout(900000)
            rep.update(pg.evaluate(JS, {"path": PROC3, "SR": SR}))
            rep["erreurs_page"] = errs[:5]
            b.close()
    finally:
        subprocess.run(["taskkill", "/PID", str(br.pid), "/T", "/F"], capture_output=True, creationflags=0x08000000)
        log.close()
    txt = logp.read_text(encoding="utf-8", errors="replace")
    rep["journal_pont_frequences"] = sorted(set(re.findall(r"(?:sample_rate|sr|Hz)[^\n]{0,40}?\b(44100|48000|88200|96000)\b", txt)))[:10]
    lv = rep.get("lecture_vs_export") or {}
    rep["verifications"] = {
        "moteur à la fréquence du projet": rep.get("contexte") == SR,
        "fichier exporté à la fréquence du projet": rep.get("export_frequence_fichier") == SR,
        "Pro-C 3 compresse (≥ 1 dB sur la dernière rafale)": (rep.get("reduction_derniere_rafale_db") or 0) >= 1,
        "lecture = export (≤ 1 LSB 16 bits)": (lv.get("ecart_max_lsb16") if lv.get("ecart_max_lsb16") is not None else 99) <= 1.0,
        "latence compensée (clic au même échantillon)": lv.get("clic_lecture_ech") == lv.get("clic_export_ech") and lv.get("clic_export_ech", -1) >= 0,
    }
    rep["ok"] = all(rep["verifications"].values())
    (OUT / f"frequence_vst_{SR}.json").write_text(json.dumps(rep, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print(json.dumps(rep, ensure_ascii=False, indent=1, default=str)[:5000])
    return 0 if rep["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
