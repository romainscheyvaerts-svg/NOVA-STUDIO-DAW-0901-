"""Preuves audio de la structure Pro Tools, sur l'export RÉEL du moteur (navigateur headless).

  1. Effet en BYPASS : le son passe sans traitement, sa latence reste compensée (1000 ms) ;
     effet INACTIF : retiré du son, aucune latence (1000 ms aussi, sans retard ajouté).
  2. Piste INACTIVE : ignorée à l'export ; réactivée : elle rejoue.
  3. Dossier de ROUTAGE : les enfants y sont mixés, son fader agit (mesuré).
  4. VCA à -6 dB : les membres baissent de 6 dB.
  5. Envoi avec pan propre (tout à gauche) et envoi muet.

NOVA_URL=http://127.0.0.1:3438/ PYTHONIOENCODING=utf-8 python qa/structure_preuve.py
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import json, os
from playwright.sync_api import sync_playwright

EXE = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
JS = r"""
async () => {
  const { audioEngine } = await import('/engine/AudioEngine.ts');
  const { TrackType } = await import('/types.ts');
  const S = await import('/utils/trackStructure.ts');
  const SR = 48000;
  // Faux effet à latence exacte (comme un VST qui annonce sa latence) ; il divise le son par 2 (preuve du traitement).
  const LAT = 0.040;
  audioEngine.createPluginNode = (plugin, bpm, ctx) => {
    const c = ctx || audioEngine.ctx;
    const input = c.createGain(), output = c.createGain(), d = c.createDelay(1);
    d.delayTime.value = LAT; input.connect(d); d.connect(output); output.gain.value = 0.5;
    return { input, output, node: { latency: LAT, dispose() {} } };
  };
  const click = (() => { const b = new AudioBuffer({ length: 4800, numberOfChannels: 2, sampleRate: SR });
    for (let ch = 0; ch < 2; ch++) { b.getChannelData(ch)[0] = 1; } return b; })();
  const clip = (id, start = 1.0) => ({ id, type: TrackType.AUDIO, start, duration: 0.1, offset: 0, buffer: click, gain: 1, name: id });
  const fx = (id, extra = {}) => ({ id, type: 'COMPRESSOR', name: id, isEnabled: true, params: {}, latency: 0, ...extra });
  const base = (id, type, extra) => ({ id, name: id, type, volume: 1, pan: 0, isMuted: false, isSolo: false, clips: [], plugins: [], sends: [], automationLanes: [], outputTrackId: 'master', ...extra });
  const master = () => base('master', TrackType.BUS, { outputTrackId: '' });
  const render = tr => audioEngine.renderProject(tr, 2.5, 0, SR);
  const onsetMs = (buf, ch = 0, from = 0) => { const x = buf.getChannelData(ch); for (let i = Math.floor(from * SR); i < x.length; i++) if (Math.abs(x[i]) > 0.02) return Math.round(i / SR * 1e6) / 1000; return null; };
  const peak = (buf, ch = 0, a = 0, b = 2.5) => { const x = buf.getChannelData(ch); let m = 0; for (let i = Math.floor(a * SR); i < Math.min(x.length, b * SR); i++) m = Math.max(m, Math.abs(x[i])); return Math.round(m * 10000) / 10000; };
  const out = {};

  // 1. Bypass ≠ inactif (voix avec l'effet, beat sans effet : les deux clics doivent tomber à 1000 ms).
  for (const [nom, extra] of [['actif', {}], ['bypass', { isEnabled: false }], ['inactif', { isInactive: true }]]) {
    const voix = [base('voix', TrackType.AUDIO, { clips: [clip('v')], plugins: [fx('lat', extra)] }), master()];
    const beat = [base('voix', TrackType.AUDIO, { plugins: [fx('lat', extra)] }), base('beat', TrackType.AUDIO, { clips: [clip('b')] }), master()];
    const bv = await render(voix), bb = await render(beat);
    out[`effet ${nom} : voix (ms)`] = onsetMs(bv);
    out[`effet ${nom} : niveau de la voix`] = peak(bv);
    out[`effet ${nom} : beat à côté (ms)`] = onsetMs(bb);
  }
  // Latence compensée lue par le moteur en lecture (PDC) : bypass = 40 ms, inactif = 0.
  await audioEngine.init();
  for (const [nom, extra] of [['bypass', { isEnabled: false }], ['inactif', { isInactive: true }]]) {
    const tr = [base('pdc', TrackType.AUDIO, { plugins: [fx('lat2', extra)] }), master()];
    tr.forEach(t => audioEngine.updateTrack(t, tr));
    out[`lecture : latence compensée, effet ${nom} (ms)`] = Math.round(audioEngine.getTrackLatency('pdc') * 1e6) / 1000;
  }

  // 2. Piste inactive ignorée à l'export (BACK B : clic à 1,5 s).
  const scene2 = inactive => [base('lead', TrackType.AUDIO, { clips: [clip('l')] }),
    base('backb', TrackType.AUDIO, { clips: [clip('bb', 1.5)], isInactive: inactive, isHidden: inactive }), master()];
  out['BACK B inactive : niveau à 1,5 s'] = peak(await render(scene2(true)), 0, 1.45, 1.6);
  out['BACK B activée en un clic : niveau à 1,5 s'] = peak(await render(S.showAndActivate(scene2(true), 'backb')), 0, 1.45, 1.6);

  // 3. Dossier de routage VOX (fader 0,5) : LEAD (1) + DOUBLE (0,5).
  let vox = [base('lead', TrackType.AUDIO, { clips: [clip('l')] }), base('double', TrackType.AUDIO, { clips: [clip('d')], volume: 0.5 }), master()];
  vox = S.createFolder(vox, { id: 'vox', name: 'VOX', kind: 'routing', childIds: ['lead', 'double'] }).map(t => t.id === 'vox' ? { ...t, volume: 0.5 } : t);
  out['dossier de routage VOX : niveau (attendu 0,75)'] = peak(await render(vox));
  out['dossier VOX muet : niveau (attendu 0)'] = peak(await render(vox.map(t => t.id === 'vox' ? { ...t, isMuted: true } : t)));

  // 4. VCA à -6 dB sur LEAD (niveau 1 → 0,501).
  const vca = S.createVca([base('lead', TrackType.AUDIO, { clips: [clip('l')] }), master()], { id: 'vca', name: 'PRE ALL VOX', memberIds: ['lead'] })
    .map(t => t.id === 'vca' ? { ...t, volume: S.dbToGain(-6) } : t);
  const pv = peak(await render(vca));
  out['VCA -6 dB : niveau (attendu 0,5012)'] = pv;
  out['VCA -6 dB : écart mesuré (dB)'] = Math.round(20 * Math.log10(pv) * 100) / 100;

  // 5. Envoi pan tout à gauche vers RV (retour seul au master) ; envoi muet.
  const sendScene = s => [base('lead', TrackType.AUDIO, { clips: [clip('l')], volume: 0, sends: [{ id: 'rv', level: 1, isEnabled: true, preFader: true, ...s }] }),
    base('rv', TrackType.SEND, {}), master()];
  const bs = await render(sendScene({ pan: -1 }));
  out['envoi pan G : gauche / droite'] = [peak(bs, 0), peak(bs, 1)];
  const bm = await render(sendScene({ isMuted: true }));
  out['envoi muet : niveau'] = peak(bm, 0);
  return out;
}
"""
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, executable_path=EXE, args=["--autoplay-policy=no-user-gesture-required"])
    pg = b.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
    pg.goto(os.environ.get("NOVA_URL", "http://127.0.0.1:3438/"), wait_until="domcontentloaded", timeout=60000)
    pg.wait_for_timeout(2000)
    res = pg.evaluate(JS)
    print(json.dumps(res, ensure_ascii=False, indent=1))
    ok = all(abs(res[f"effet {n} : voix (ms)"] - 1000) < 0.05 and abs(res[f"effet {n} : beat à côté (ms)"] - 1000) < 0.05 for n in ("actif", "bypass", "inactif"))
    ok = ok and abs(res["effet actif : niveau de la voix"] - 0.5) < 0.01 and abs(res["effet bypass : niveau de la voix"] - 1) < 0.01 and abs(res["effet inactif : niveau de la voix"] - 1) < 0.01
    ok = ok and abs(res["lecture : latence compensée, effet bypass (ms)"] - 40) < 0.01 and res["lecture : latence compensée, effet inactif (ms)"] == 0
    ok = ok and res["BACK B inactive : niveau à 1,5 s"] == 0 and res["BACK B activée en un clic : niveau à 1,5 s"] > 0.9
    ok = ok and abs(res["dossier de routage VOX : niveau (attendu 0,75)"] - 0.75) < 0.005 and res["dossier VOX muet : niveau (attendu 0)"] == 0
    ok = ok and abs(res["VCA -6 dB : écart mesuré (dB)"] + 6) < 0.05
    ok = ok and res["envoi pan G : gauche / droite"][1] < 0.001 and res["envoi pan G : gauche / droite"][0] > 0.9 and res["envoi muet : niveau"] == 0
    print("TOUT EST BON" if ok else "ÉCART", "| erreurs page :", errs[:3])
    b.close()
