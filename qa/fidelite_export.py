"""« Ce que j'entends = ce que j'exporte », au bit près : balayage de TOUS les effets NOVA.

Navigateur headless (aucune fenêtre), QA 100 % hors production (qa_hors_prod importé AVANT le
lancement du navigateur). Pour chaque fréquence (44,1 et 48 kHz par défaut) et chaque
configuration :

  - chaque effet du registre (engine/pluginRegistry.ts) et chaque effet intégré de la fabrique
    du moteur (EQ 12 bandes, compresseur, reverb avec modulation, délai, chorus, flanger,
    doubleur, élargisseur, de-esser, débruiteur, saturation, Auto-Tune NOVA, MasterSync),
    SEUL en insert sur une piste voix ;
  - une chaîne type voix : EQ → compresseur → de-esser → saturation, envois reverb et délai,
    bus voix (Leveler 2A), master (limiteur NOVA), plus un beat panoramiqué ;
  - « sec » (aucun effet) comme témoin.

Mesure : lecture en temps réel enregistrée au master, à l'échantillon près (currentFrame),
contre le rendu hors ligne `renderProject` sur la même plage (32 bits flottants, rien n'est
arrondi), en partant de 0 PUIS d'un point au milieu du clip. Écart maximal en LSB 16 bits.
Machine partagée : une lecture dérangée (> 1 LSB) est refaite jusqu'à 3 fois ; la meilleure
est retenue, toutes sont gardées.

Usage : NOVA_URL=http://127.0.0.1:3495/ FIDEL_LABEL=apres python qa/fidelite_export.py
        FIDEL_RATES=44100,48000  FIDEL_ONLY=PROEQ12,REVERB (optionnel : sous-ensemble)
Sortie : D:\\1 WORK\\CONTENU\\nova-fidelite\\fidelite_<label>.json
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import json, os, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright
from qalib import APP_MODULE_INIT, CHROME  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
URL = os.environ.get("NOVA_URL", "http://127.0.0.1:3495/")
OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-fidelite"))
OUT.mkdir(parents=True, exist_ok=True)
LABEL = os.environ.get("FIDEL_LABEL", "apres")
RATES = [int(x) for x in os.environ.get("FIDEL_RATES", "44100,48000").split(",")]
ONLY = [x for x in os.environ.get("FIDEL_ONLY", "").split(",") if x]
SEUIL = 1.0   # LSB 16 bits

# (nom, type, réglages modifiés). Les effets du registre partent de leurs réglages par défaut.
BUILTINS = [
    ("PROEQ12", "PROEQ12", "eq"),
    ("COMPRESSOR", "COMPRESSOR", {"threshold": -24, "ratio": 3}),
    ("REVERB (modulation)", "REVERB", {}),
    ("REVERB sans modulation", "REVERB", {"modDepth": 0}),
    ("DELAY", "DELAY", {}),
    ("CHORUS", "CHORUS", {}),
    ("FLANGER", "FLANGER", {}),
    ("DOUBLER", "DOUBLER", {}),
    ("STEREOSPREADER", "STEREOSPREADER", {}),
    ("DEESSER", "DEESSER", {}),
    ("DENOISER", "DENOISER", {}),
    ("VOCALSATURATOR", "VOCALSATURATOR", {}),
    ("MASTERSYNC", "MASTERSYNC", {}),
    ("AUTOTUNE", "AUTOTUNE", {}),
]
REGISTRY_OVERRIDES = {"DJFILTER": {"filter": -0.5}, "TIMEFX": {"half": 1},
                      # Effets de mix (21/10/2026) : défauts neutres, réglés ici pour travailler sur la voix d'essai.
                      "MBCOMP": {"bands": 4, "x1": 150, "x2": 1500, "x3": 6000, "b1Thr": -30, "b1Ratio": 4, "b2Thr": -30, "b2Ratio": 4,
                                 "b3Thr": -36, "b3Ratio": 6, "b4Thr": -40, "b4Ratio": 3},
                      "DYNEQ": {"d1Range": -6, "d1Thr": -40, "d2Range": -8, "d2Thr": -40, "d2Freq": 1760, "d2Q": 4, "d3Range": -6, "d3Thr": -45,
                                "d3Freq": 7040, "d4Range": 4, "d4Thr": -50, "d4Freq": 15000}}

JS = r"""
async ({ rate, cfg }) => {
  const M = p => window.__novaAppModule(p);
  const { audioEngine: e } = await M('/engine/AudioEngine.ts');
  const { TrackType } = await M('/types.ts');
  const { builtinPlugin } = await M('/utils/sessionTemplate.ts');
  const REG = await M('/engine/pluginRegistry.ts');
  if (cfg.list) return REG.PLUGIN_REGISTRY.map(p => p.type);
  if (!e.ctx || e.ctx.sampleRate !== rate) { await e.setSampleRate(rate); }
  await e.init(); await e.resume();
  const SR = e.ctx.sampleRate;
  e.setSafetyLimiter(false);   // l'export n'a pas ce limiteur de sécurité (écoute seulement)

  // --- sons, à la fréquence du projet (graine fixe) ---
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const LEN = 2.5;
  const voice = new AudioBuffer({ length: Math.round(LEN * SR), numberOfChannels: 1, sampleRate: SR });
  { const x = voice.getChannelData(0); x[Math.round(0.05 * SR)] = 0.6;
    for (let i = 0; i < x.length; i++) { const t = i / SR, env = Math.min(1, t / 0.02, (LEN - t) / 0.05);
      const syl = 0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t);   // syllabes : le compresseur et le gate travaillent
      x[i] += env * syl * (0.12 * Math.sin(2 * Math.PI * 220 * t) + 0.06 * Math.sin(2 * Math.PI * 1760 * t) + 0.03 * Math.sin(2 * Math.PI * 7040 * t) + 0.02 * Math.sin(2 * Math.PI * 15000 * t));
      if ((t > 0.8 && t < 0.95) || (t > 1.7 && t < 1.82)) x[i] += 0.08 * rnd();   // « s » : le de-esser travaille
    } }
  const beat = new AudioBuffer({ length: Math.round(LEN * SR), numberOfChannels: 2, sampleRate: SR });
  for (let c = 0; c < 2; c++) { const x = beat.getChannelData(c); for (let k = 0; k < 5; k++) { const a = Math.round((0.1 + 0.5 * k) * SR);
    for (let i = 0; i < Math.round(0.12 * SR); i++) x[a + i] = 0.3 * rnd() * Math.exp(-i / (0.03 * SR)) + 0.25 * Math.sin(2 * Math.PI * 55 * i / SR) * Math.exp(-i / (0.08 * SR)); } }
  const clip = (id, buf, start) => ({ id, type: TrackType.AUDIO, start, duration: buf.duration, offset: 0, buffer: buf, gain: 1, name: id, fadeIn: 0, fadeOut: 0, color: '#fff' });
  const base = (id, type, extra) => ({ id, name: id, type, volume: 1, pan: 0, isMuted: false, isSolo: false, clips: [], plugins: [], sends: [], automationLanes: [], outputTrackId: 'master', ...extra });
  const eqVoix = () => { const p = builtinPlugin('PROEQ12', {}, 'fx-eq');
    p.params.bands[3] = { ...p.params.bands[3], gain: 4, frequency: 1800, q: 1.2 };
    p.params.bands[9] = { ...p.params.bands[9], gain: -3, frequency: 9000, q: 0.8 }; return p; };
  const fx = (type, over, id) => {
    if (over === 'eq') return eqVoix();
    const reg = REG.getRegisteredPlugin(type);
    if (reg) return { id, name: type, type, isEnabled: true, latency: 0, params: { ...reg.defaultParams(), ...(over || {}) } };
    return builtinPlugin(type, over || {}, id);
  };
  let tracks;
  const master = base('master', TrackType.BUS, { outputTrackId: '' });
  if (cfg.kind === 'chaine') {
    tracks = [
      base('voix', TrackType.AUDIO, { clips: [clip('c-voix', voice, 0.5)], outputTrackId: 'bus',
        plugins: [eqVoix(), fx('COMPRESSOR', { threshold: -24, ratio: 3 }, 'fx-comp'), fx('DEESSER', {}, 'fx-dess'), fx('VOCALSATURATOR', {}, 'fx-sat')],
        sends: [{ id: 'verb', level: 0.3, isEnabled: true }, { id: 'dly', level: 0.2, isEnabled: true }] }),
      base('bus', TrackType.BUS, { volume: 0.85, plugins: [fx('LEVELER2A', {}, 'fx-la2a')] }),
      base('verb', TrackType.SEND, { plugins: [fx('REVERB', {}, 'fx-rev')] }),
      base('dly', TrackType.SEND, { plugins: [fx('DELAY', {}, 'fx-dly')] }),
      base('beat', TrackType.AUDIO, { clips: [clip('c-beat', beat, 0.25)], pan: 0.3, volume: 0.7 }),
      { ...master, plugins: [fx('LIMITER', {}, 'fx-lim')] },
    ];
  } else {
    tracks = [
      base('voix', TrackType.AUDIO, { clips: [clip('c-voix', voice, 0.5)], plugins: cfg.type ? [fx(cfg.type, cfg.over, 'fx-1')] : [] }),
      ...(cfg.master ? [master] : []),
    ];
  }
  // Deux passes, comme l'appli au chargement d'un projet : chaque piste trouve sa destination (bus, master).
  tracks.forEach(t => e.updateTrack(t, tracks));
  tracks.forEach(t => e.updateTrack(t, tracks));
  // La piste master sans limiteur à crête vraie remet le limiteur de sécurité de l'écoute
  // (DynamicsCompressor : 6 ms d'anticipation, jamais dans un export) : coupé pour la mesure.
  e.setSafetyLimiter(false);
  await new Promise(r => setTimeout(r, 1500));   // worklets chargés, IR de la reverb prête

  // Horloge de l'enregistreur : jamais en arrière. Sous charge, Chrome livre parfois plusieurs blocs
  // avec le même currentFrame (en retard de 128 ou 256) : placé tel quel, un bloc en écrasait un autre
  // et laissait un trou de 128 (écart de milliers de LSB, 100 % des échantillons « reçus »). Voir engine/blockClock.ts.
  const recSrc = `class R extends AudioWorkletProcessor { constructor() { super(); this.on = false; this.next = -1; this.port.onmessage = (e) => { this.on = !!e.data; }; }
    process(inputs) { const late = this.next >= 0 && currentFrame < this.next; const f = late ? this.next : currentFrame; this.next = f + 128; const i = inputs[0]; if (this.on && i && i.length) this.port.postMessage([f, i[0].slice(), (i[1] || i[0]).slice(), late ? 1 : 0]); return true; } }
    registerProcessor('nova-qa-rec-fidel', R);`;
  if (window.__qaRecFidel !== e.ctx) { await e.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([recSrc], { type: 'application/javascript' }))); window.__qaRecFidel = e.ctx; }

  const measure = async (from, dur) => {
    const n = Math.round(dur * SR);
    const ex = await e.renderProject(tracks, dur, from, SR);
    const EL = ex.getChannelData(0), ER = ex.getChannelData(1);
    const capture = async () => {
      const recNode = new AudioWorkletNode(e.ctx, 'nova-qa-rec-fidel', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
      const tap = e.getMasterMeterInput();
      const mute = e.ctx.createGain(); mute.gain.value = 0;
      tap.connect(recNode); recNode.connect(mute); mute.connect(e.ctx.destination);
      const blocks = [];
      recNode.port.onmessage = ev => blocks.push(ev.data);
      recNode.port.postMessage(true);
      // Départ depuis l'arrêt, une fois les queues de l'écoute précédente éteintes (usage normal :
      // on relance la lecture après un silence ; une relance PENDANT une queue de reverb ou de
      // délai la fait entendre, comme dans tout DAW — l'export, lui, n'a pas de passé).
      const an = e.ctx.createAnalyser(); an.fftSize = 2048; tap.connect(an);
      const buf = new Float32Array(2048); let calm = 0; const q0 = performance.now();
      while (calm < 6 && performance.now() - q0 < 15000) { await new Promise(r => setTimeout(r, 50)); an.getFloatTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v)); calm = m < 1e-7 ? calm + 1 : 0; }
      try { tap.disconnect(an); } catch (err) {}
      const attente_silence_ms = Math.round(performance.now() - q0);
      const at = Math.ceil((e.ctx.currentTime + 0.3) * SR) / SR;   // départ sur un échantillon entier
      e.startPlayback(from, tracks, { at });
      // Le moteur cale le départ sur un bloc de rendu (≤ 2,9 ms plus tard) : origine relue.
      const origin = e.playbackStartTime + from;
      const c0 = e.ctx.currentTime, w0 = performance.now();
      while (e.ctx.currentTime - c0 < dur + 0.6 && performance.now() - w0 < 60000) await new Promise(r => setTimeout(r, 50));
      e.stopAll();
      await new Promise(r => setTimeout(r, 200));
      recNode.port.postMessage(false);
      try { tap.disconnect(recNode); recNode.disconnect(); mute.disconnect(); } catch (err) {}
      const L = new Float32Array(n), Rr = new Float32Array(n);
      const f0 = Math.round(origin * SR);
      let got = 0;
      for (const [fr, a, b] of blocks) for (let i = 0; i < a.length; i++) { const k = fr + i - f0; if (k >= 0 && k < n) { L[k] = a[i]; Rr[k] = b[i]; got++; } }
      let maxd = 0, peak = 0, at_ = -1, peakL = 0;
      for (let i = 0; i < n; i++) { const d = Math.max(Math.abs(L[i] - EL[i]), Math.abs(Rr[i] - ER[i])); if (d > maxd) { maxd = d; at_ = i; } peak = Math.max(peak, Math.abs(EL[i]), Math.abs(ER[i])); peakL = Math.max(peakL, Math.abs(L[i]), Math.abs(Rr[i])); }
      const first = x => { for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 0.3) return i; return -1; };
      const decal = first(L) >= 0 && first(EL) >= 0 ? first(L) - first(EL) : null;
      const prof = []; const W = Math.round(0.25 * SR);
      for (let a = 0; a < n; a += W) { let m = 0; for (let i = a; i < Math.min(n, a + W); i++) m = Math.max(m, Math.abs(L[i] - EL[i]), Math.abs(Rr[i] - ER[i])); prof.push(+(20 * Math.log10(m + 1e-30)).toFixed(0)); }
      return { attente_silence_ms, echantillons: got, attendus: n, ecart_max_lsb16: +(maxd * 32768).toFixed(4), ecart_max_dbfs: +(20 * Math.log10(maxd + 1e-30)).toFixed(1),
        a_s: +(from + at_ / SR).toFixed(4), crete: +peak.toFixed(4), crete_lecture: +peakL.toFixed(4), decalage_clic_ech: decal, etiquettes_en_retard: blocks.reduce((s, b) => s + (b[3] || 0), 0), profil_dbfs_par_quart_de_seconde: prof };
    };
    const essais = [];
    for (let k = 0; k < 3; k++) { const c = await capture(); essais.push(c); if (c.ecart_max_lsb16 <= 1 && c.echantillons >= c.attendus * 0.999) break; }
    const best = essais.filter(x => x.echantillons >= x.attendus * 0.999).reduce((a, b) => (!a || b.ecart_max_lsb16 < a.ecart_max_lsb16 ? b : a), null) || essais[essais.length - 1];
    return { ...best, tentatives: essais.length, lsb16_par_tentative: essais.map(x => x.ecart_max_lsb16) };
  };
  const out = { frequence: SR, pistes: tracks.map(t => `${t.id}: ${(t.plugins || []).map(p => p.type).join(' > ') || '-'}`) };
  out.depuis_0 = await measure(0, 4.0);
  out.depuis_milieu = await measure(1.3, 2.7);
  tracks.forEach(t => e.disposeTrack(t.id));
  return out;
}
"""


def running_qa() -> int:
    """Scénarios qa/*.py en cours sur la machine (machine partagée : on attend s'il y en a 2 ou plus)."""
    import subprocess
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-Command",
                            "(Get-CimInstance Win32_Process -Filter \"name='python.exe'\" | Where-Object { $_.CommandLine -match 'qa[\\\\/][a-z0-9_]+\\.py' }).Count"],
                           capture_output=True, text=True, timeout=60, creationflags=0x08000000)
        return max(0, int((r.stdout or "0").strip() or 0) - 1)   # moins ce scénario-ci
    except Exception:
        return 0


def main():
    res = {"url": URL, "label": LABEL, "seuil_lsb16": SEUIL, "configs": {}, "ok": True}
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, executable_path=CHROME, args=["--autoplay-policy=no-user-gesture-required"])
        pg = b.new_page()
        errs = []
        pg.on("pageerror", lambda x: errs.append(str(x)[:300]))
        pg.add_init_script(APP_MODULE_INIT)
        pg.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
        pg.goto(URL, wait_until="domcontentloaded", timeout=120000)
        pg.wait_for_timeout(4000)
        pg.set_default_timeout(900000)
        registry = pg.evaluate(JS, {"rate": RATES[0], "cfg": {"list": True}})
        configs = [("sec", {"kind": "seul", "type": None, "over": {}}),
                   ("sec + master", {"kind": "seul", "type": None, "over": {}, "master": True})]
        configs += [(name, {"kind": "seul", "type": t, "over": over}) for name, t, over in BUILTINS]
        configs += [(t, {"kind": "seul", "type": t, "over": REGISTRY_OVERRIDES.get(t, {})}) for t in registry]
        configs += [("chaine voix", {"kind": "chaine"})]
        if ONLY:
            configs = [c for c in configs if c[0] in ONLY or (c[1].get("type") in ONLY)]
        for rate in RATES:
            for name, cfg in configs:
                while running_qa() >= 2:
                    time.sleep(20)
                t0 = time.time()
                try:
                    r = pg.evaluate(JS, {"rate": rate, "cfg": cfg})
                except Exception as ex:
                    r = {"erreur": str(ex)[:300]}
                worst = max((r.get(k) or {}).get("ecart_max_lsb16", 99) for k in ("depuis_0", "depuis_milieu"))
                r["pire_lsb16"] = worst
                r["ok"] = worst <= SEUIL
                r["secondes"] = round(time.time() - t0, 1)
                res["ok"] = res["ok"] and r["ok"]
                res["configs"].setdefault(name, {})[str(rate)] = r
                print(f"{rate} {name:24s} 0: {(r.get('depuis_0') or {}).get('ecart_max_lsb16')}  milieu: {(r.get('depuis_milieu') or {}).get('ecart_max_lsb16')}  {'OK' if r['ok'] else 'ÉCART'}", flush=True)
                (OUT / f"fidelite_{LABEL}.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
        res["erreurs_page"] = errs[:10]
        b.close()
    (OUT / f"fidelite_{LABEL}.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print("OK" if res["ok"] else "ÉCARTS", "| erreurs page :", errs[:3])
    return 0 if res["ok"] else 1


# ─── VST3 par le VRAI pont de ce dépôt (port 8786) et le VRAI NovaVSTHost.exe (FIDEL_VST=1) ───
VST_PORT = int(os.environ.get("NOVA_TEST_PORT", "8786"))
BRIDGE_PY = Path(os.environ.get("NOVA_BRIDGE_PYTHON", r"D:\1 WORK\CODE\NOVA-STUDIO-DAW-0901-\bridge-python\venv\Scripts\python.exe"))
VST3 = r"C:\Program Files\Common Files\VST3"
VST_PLUGINS = [
    ("FabFilter Pro-C 3", VST3 + r"\FabFilter\FabFilter Pro-C 3.vst3",
     [{"name": "ratio", "text": "2.00:1"}, {"name": "threshold", "real": -24}, {"name": "attack", "real": 5}, {"name": "release", "real": 80}],
     [{"name": "threshold", "real": -30}]),
    ("Tube-Tech CL 1B mk II", VST3 + r"\Tube-Tech CL 1B mk II.vst3",
     [{"name": "ratio", "text": "4:1"}, {"name": "threshold_db", "text": "-10.0"}, {"name": "attack", "real": 2.0}],
     [{"name": "threshold_db", "text": "-14.0"}]),
]

VST_JS = r"""
async ({ path, SR, name, sets, change }) => {
  const M = p => window.__novaAppModule(p);
  const { audioEngine: e } = await M('/engine/AudioEngine.ts');
  const { TrackType } = await M('/types.ts');
  const { novaBridge } = await M('/services/NovaBridge.ts');
  const { liveVstNodes } = await M('/engine/VSTPluginNode.ts');
  const { prepareTracksForOffline } = await M('/services/VstFreeze.ts');
  const out = { plugin: name };
  if (!e.ctx || e.ctx.sampleRate !== SR) await e.setSampleRate(SR);
  await e.init(); await e.resume();
  e.setSafetyLimiter(false);
  if (!(await novaBridge.connect())) return { ...out, erreur: 'pont injoignable' };
  out.pont = novaBridge.getBridgeState().version;
  const LEN = 3;
  const v = new AudioBuffer({ length: LEN * SR, numberOfChannels: 1, sampleRate: SR });
  { const x = v.getChannelData(0); x[Math.round(0.05 * SR)] = 0.7;
    for (let k = 0; k < 5; k++) { const a = Math.round((0.3 + 0.5 * k) * SR), n = Math.round(0.35 * SR);
      for (let i = 0; i < n; i++) { const t = i / SR; x[a + i] = (0.35 + 0.1 * k) * Math.min(1, i / 240, (n - i) / 240) * (Math.sin(2 * Math.PI * 220 * t) + 0.4 * Math.sin(2 * Math.PI * 3000 * t)); } } }
  const { audioBufferRegistry } = await M('/utils/audioBufferRegistry.ts');
  audioBufferRegistry.register(v, 'buf-voix-fidel');
  const id = 'vst-' + Math.random().toString(36).slice(2, 7);
  const tracks = [{ id: 'voix', name: 'voix', type: TrackType.AUDIO, volume: 1, pan: 0, isMuted: false, isSolo: false, outputTrackId: 'master',
    clips: [{ id: 'c-voix', type: TrackType.AUDIO, start: 0.5, duration: LEN, offset: 0, buffer: v, bufferId: 'buf-voix-fidel', gain: 1, name: 'v', fadeIn: 0, fadeOut: 0, color: '#fff' }],
    plugins: [{ id, name, type: 'VST3', isEnabled: true, latency: 0, params: { name, localPath: path } }], sends: [], automationLanes: [] }];
  tracks.forEach(t => e.updateTrack(t, tracks));
  const t0 = performance.now();
  while (!liveVstNodes.get(id)?.getSlotId() && performance.now() - t0 < 240000) await new Promise(r => setTimeout(r, 100));
  const node = liveVstNodes.get(id);
  if (!node?.getSlotId()) return { ...out, erreur: 'plugin pas chargé' };
  const r1 = await novaBridge.setParams(node.getSlotId(), sets);
  out.reglages = (r1.results || []).map(r => ({ nom: r.name, texte: r.text ?? null, ok: r.ok }));
  await new Promise(r => setTimeout(r, 800));
  out.latence_ms = Math.round((node.latency || 0) * 1e5) / 100;
  const DUR = 4, n = DUR * SR;
  const exportNow = async () => {
    const st = await novaBridge.getPluginState(node.getSlotId());
    const tr = tracks.map(t => ({ ...t, plugins: t.plugins.map(p => ({ ...p, params: { ...p.params, stateB64: st } })) }));
    const prep = await prepareTracksForOffline(tr);
    try { const b = await e.renderProject(prep.tracks, DUR, 0, SR); return [b.getChannelData(0).slice(), b.getChannelData(1).slice()]; }
    finally { prep.cleanup?.(); }
  };
  // Horloge de l'enregistreur : jamais en arrière. Sous charge, Chrome livre parfois plusieurs blocs
  // avec le même currentFrame (en retard de 128 ou 256) : placé tel quel, un bloc en écrasait un autre
  // et laissait un trou de 128 (écart de milliers de LSB, 100 % des échantillons « reçus »). Voir engine/blockClock.ts.
  const recSrc = `class R extends AudioWorkletProcessor { constructor() { super(); this.on = false; this.next = -1; this.port.onmessage = (e) => { this.on = !!e.data; }; }
    process(inputs) { const late = this.next >= 0 && currentFrame < this.next; const f = late ? this.next : currentFrame; this.next = f + 128; const i = inputs[0]; if (this.on && i && i.length) this.port.postMessage([f, i[0].slice(), (i[1] || i[0]).slice(), late ? 1 : 0]); return true; } }
    registerProcessor('nova-qa-rec-fidel-vst', R);`;
  if (window.__qaRecFidelVst !== e.ctx) { await e.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([recSrc], { type: 'application/javascript' }))); window.__qaRecFidelVst = e.ctx; }
  const capture = async () => {
    const rec = new AudioWorkletNode(e.ctx, 'nova-qa-rec-fidel-vst', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
    const tap = e.getMasterMeterInput(); const mute = e.ctx.createGain(); mute.gain.value = 0;
    tap.connect(rec); rec.connect(mute); mute.connect(e.ctx.destination);
    const blocks = []; rec.port.onmessage = ev => blocks.push(ev.data); rec.port.postMessage(true);
    e.startPlayback(0, tracks, { at: e.ctx.currentTime + 0.4 }); const origin = e.playbackStartTime;
    const c0 = e.ctx.currentTime, w0 = performance.now();
    while (e.ctx.currentTime - c0 < DUR + 0.8 && performance.now() - w0 < 60000) await new Promise(r => setTimeout(r, 50));
    e.stopAll(); await new Promise(r => setTimeout(r, 200)); rec.port.postMessage(false);
    try { tap.disconnect(rec); rec.disconnect(); mute.disconnect(); } catch (err) {}
    const L = new Float32Array(n), R = new Float32Array(n), f0 = Math.round(origin * SR);
    for (const [fr, a, b] of blocks) for (let i = 0; i < a.length; i++) { const k = fr + i - f0; if (k >= 0 && k < n) { L[k] = a[i]; R[k] = b[i]; } }
    return [L, R];
  };
  const cmp = ([L, R], [EL, ER]) => { let m = 0, at = -1; for (let i = 0; i < n; i++) { const d = Math.max(Math.abs(L[i] - EL[i]), Math.abs(R[i] - ER[i])); if (d > m) { m = d; at = i; } } return { lsb16: +(m * 32768).toFixed(4), dbfs: +(20 * Math.log10(m + 1e-30)).toFixed(1), a_s: +(at / SR).toFixed(4) }; };
  // 1) Écoutes successives (même instance) contre l'export.
  const exp1 = await exportNow();
  const ecoutes = [];
  // Machine partagée : une écoute dérangée (bloc du pont en retard : silence) est refaite, 2 fois au plus ;
  // toutes les tentatives sont gardées (une vraie mémoire du plugin, elle, se reproduirait à chaque fois).
  const tentatives = [];
  for (let k = 0; k < 3; k++) {
    let c = cmp(await capture(), exp1); const essais = [c.lsb16];
    for (let r = 0; r < 2 && c.lsb16 > 1; r++) { c = cmp(await capture(), exp1); essais.push(c.lsb16); }
    ecoutes.push(c); tentatives.push(essais);
  }
  out.ecoutes_vs_export = ecoutes;
  out.ecoutes_tentatives_lsb16 = tentatives;
  // 2) Réglage posé à l'arrêt puis export TOUT DE SUITE : l'export doit l'entendre.
  await novaBridge.setParams(node.getSlotId(), change);
  const expTout = await exportNow();
  await new Promise(r => setTimeout(r, 300));
  const ecouteApres = await capture();
  const expApres = await exportNow();
  out.export_juste_apres_reglage_vs_export_apres_ecoute = cmp(expTout, expApres);
  out.ecoute_apres_reglage_vs_export_juste_apres = cmp(ecouteApres, expTout);
  out.ecart_export_avant_apres_reglage = cmp(expTout, exp1);
  out.reglage_entendu_a_l_export = out.ecart_export_avant_apres_reglage.lsb16 > 10;
  let pk = 0; for (const x of exp1[0]) pk = Math.max(pk, Math.abs(x)); out.crete_export = +pk.toFixed(4);
  e.disposeTrack('voix');
  return out;
}
"""


def main_vst():
    import socket, subprocess
    env = dict(os.environ, NOVA_BRIDGE_PORT=str(VST_PORT), PYTHONIOENCODING="utf-8")
    env.setdefault("NOVA_VST_HOST_EXE", str(Path(__file__).resolve().parents[1] / "native-host" / "build" / "NovaVSTHost_artefacts" / "Release" / "NovaVSTHost.exe"))
    res = {"url": URL, "label": LABEL, "exe": env["NOVA_VST_HOST_EXE"], "port_pont": VST_PORT, "mesures": {}, "ok": True}
    logp = OUT / f"pont-fidelite-{LABEL}.log"
    log = open(logp, "w", encoding="utf-8")
    br = subprocess.Popen([str(BRIDGE_PY), "nova_bridge_server.py"], cwd=str(Path(__file__).resolve().parents[1] / "bridge-python"), env=env,
                          stdout=log, stderr=subprocess.STDOUT, creationflags=0x08000000)
    try:
        for _ in range(240):
            try:
                socket.create_connection(("127.0.0.1", VST_PORT), 0.5).close()
                break
            except OSError:
                time.sleep(0.5)
        with sync_playwright() as p:
            b = p.chromium.launch(headless=True, executable_path=CHROME, args=["--autoplay-policy=no-user-gesture-required"])
            pg = b.new_page()
            errs = []
            pg.on("pageerror", lambda x: errs.append(str(x)[:300]))
            pg.add_init_script(APP_MODULE_INIT)
            pg.add_init_script(f"try {{ localStorage.setItem('nova.bridge.url', 'ws://127.0.0.1:{VST_PORT}'); localStorage.setItem('nova_welcome_seen', '1'); }} catch (e) {{}}")
            pg.goto(URL, wait_until="domcontentloaded", timeout=120000)
            pg.wait_for_timeout(3000)
            pg.set_default_timeout(900000)
            for rate in RATES:
                for name, path, sets, change in VST_PLUGINS:
                    while running_qa() >= 2:
                        time.sleep(20)
                    try:
                        r = pg.evaluate(VST_JS, {"path": path, "SR": rate, "name": name, "sets": sets, "change": change})
                    except Exception as ex:
                        r = {"erreur": str(ex)[:300]}
                    ec = r.get("ecoutes_vs_export") or []
                    r["verifications"] = {
                        "chaque écoute = export (≤ 1 LSB16)": bool(ec) and all(x["lsb16"] <= 1 for x in ec),
                        "réglage posé à l'arrêt entendu par l'export lancé juste après": bool(r.get("reglage_entendu_a_l_export"))
                            and (r.get("export_juste_apres_reglage_vs_export_apres_ecoute") or {}).get("lsb16", 99) <= 1,
                    }
                    r["ok"] = all(r["verifications"].values())
                    res["ok"] = res["ok"] and r["ok"]
                    res["mesures"][f"{name} {rate}"] = r
                    print(json.dumps({f"{name} {rate}": {k: r.get(k) for k in ("ecoutes_vs_export", "export_juste_apres_reglage_vs_export_apres_ecoute", "reglage_entendu_a_l_export", "erreur", "ok")}}, ensure_ascii=False), flush=True)
                    (OUT / f"fidelite_vst_{LABEL}.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
            res["erreurs_page"] = errs[:10]
            b.close()
    finally:
        subprocess.run(["taskkill", "/PID", str(br.pid), "/T", "/F"], capture_output=True, creationflags=0x08000000)
        log.close()
    (OUT / f"fidelite_vst_{LABEL}.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print("OK" if res["ok"] else "ÉCARTS")
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main_vst() if os.environ.get("FIDEL_VST") == "1" else main())
