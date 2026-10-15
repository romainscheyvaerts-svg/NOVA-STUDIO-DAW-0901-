"""C6 — « Silence du pont VST » : alerte et tampon adaptatif, preuve par la mesure.

Navigateur headless (aucune fenêtre), QA 100 % hors production (qa_hors_prod importé AVANT
le navigateur). Le VRAI pont de ce dépôt (bridge-python) et le VRAI NovaVSTHost.exe, lancés
cachés sur un port de test (8797, sinon 8798 ; jamais 8765), avec NOVA_BRIDGE_DEBUG=1 : l'action
DEBUG_SLOW ralentit le pont À LA DEMANDE (option de test : chaque bloc traité repart 70 ms
plus tard + gigue 0–30 ms ; jamais active par défaut).

Session : projet vierge NOVA (l'interface tourne : alerte et pastille visibles), deux pistes
calées sur le même son (sinus continu + salves de bruit toutes les 0,5 s) :
  - « Voix (VST) » : FabFilter Pro-C 3 (VST3 du PC, par le pont), panoramique à GAUCHE ;
  - « Référence » : même clip, sans effet, panoramique à DROITE.
La sortie master est enregistrée à l'échantillon près (currentFrame).

Mesures, par phase :
  - trous : suites ≥ 64 échantillons de silence numérique sur le canal gauche (piste VST),
    nombre, durée totale, instant du dernier ; « après 2 s » = plus de 2 s après le début du son ;
  - calage entre pistes : décalage (échantillons) gauche/droite à chaque salve, par corrélation ;
  - lecture contre export (rendu hors ligne, même plage) : écart max en LSB 16 bits ; quand le
    tampon a grandi PENDANT l'écoute, la musique entière a attendu K (transport décalé) :
    on compare la lecture à l'export décalé de K, après l'agrandissement.

Phases : 0 pont normal · A pont ralenti, tampon FIXE (comportement d'avant) · B pont ralenti,
tampon ADAPTATIF (1re écoute : agrandissement) · B2 2e écoute (tampon déjà grand) · C pont
redevenu normal, 17 s d'écoute puis arrêt : le tampon redescend · D pont normal.

Usage : NOVA_URL=http://127.0.0.1:3434/ SILENCE_LABEL=run1 python qa/silence_pont_vst.py
Sortie : D:\\1 WORK\\CONTENU\\nova-silence-vst\\silence_<label>.json (+ captures d'écran)
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production
import json, os, socket, subprocess, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright
from qalib import APP_MODULE_INIT, CHROME  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

URL = os.environ.get("NOVA_URL", "http://127.0.0.1:3434/")
OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-silence-vst"))
OUT.mkdir(parents=True, exist_ok=True)
LABEL = os.environ.get("SILENCE_LABEL", "run")
ROOT = Path(__file__).resolve().parents[1]
BRIDGE_PY = Path(os.environ.get("NOVA_BRIDGE_PYTHON", r"D:\1 WORK\CODE\NOVA-STUDIO-DAW-0901-\bridge-python\venv\Scripts\python.exe"))
EXE = os.environ.get("NOVA_VST_HOST_EXE", str(ROOT / "native-host" / "build" / "NovaVSTHost_artefacts" / "Release" / "NovaVSTHost.exe"))
PLUGIN = ("FabFilter Pro-C 3", r"C:\Program Files\Common Files\VST3\FabFilter\FabFilter Pro-C 3.vst3",
          [{"name": "ratio", "text": "2.00:1"}, {"name": "threshold", "real": -24}, {"name": "attack", "real": 5}, {"name": "release", "real": 80}])
SLOW = {"ms": 70, "jitter_ms": 30, "seed": 7}
SR = 48000

SETUP_JS = r"""
async ({ SR, path, name, sets }) => {
  const M = p => window.__novaAppModule(p);
  const { audioEngine: e } = await M('/engine/AudioEngine.ts');
  const { TrackType } = await M('/types.ts');
  const { novaBridge } = await M('/services/NovaBridge.ts');
  const { liveVstNodes } = await M('/engine/VSTPluginNode.ts');
  const AB = await M('/utils/vstAdaptiveBuffer.ts');
  const { prepareTracksForOffline } = await M('/services/VstFreeze.ts');
  const { audioBufferRegistry } = await M('/utils/audioBufferRegistry.ts');
  await e.init(); await e.resume();
  if (e.ctx.sampleRate !== SR) return { erreur: 'fréquence ' + e.ctx.sampleRate };
  if (!(await novaBridge.connect())) return { erreur: 'pont injoignable' };
  // --- son : sinus 330 Hz continu + salve de bruit (10 ms) toutes les 0,5 s ---
  const LEN = 24;
  const buf = new AudioBuffer({ length: LEN * SR, numberOfChannels: 1, sampleRate: SR });
  let seed = 11; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  { const x = buf.getChannelData(0);
    for (let i = 0; i < x.length; i++) { const t = i / SR; x[i] = 0.12 * Math.sin(2 * Math.PI * 330 * t) * Math.min(1, t / 0.005, (LEN - t) / 0.005); }
    for (let k = 0; 0.25 + 0.5 * k < LEN - 0.1; k++) { const a = Math.round((0.25 + 0.5 * k) * SR); for (let i = 0; i < Math.round(0.01 * SR); i++) x[a + i] += 1.2 * rnd(); } }
  audioBufferRegistry.register(buf, 'buf-silence-vst');
  const CLIP0 = 0.5;
  const S = window.__silence = { SR, CLIP0, plugId: null, trackIds: ['silence-vst', 'silence-ref'] };
  const clip = (id) => ({ id, type: TrackType.AUDIO, start: CLIP0, duration: LEN, offset: 0, buffer: buf, bufferId: 'buf-silence-vst', gain: 1, name: id, fadeIn: 0, fadeOut: 0, color: '#fff' });
  const base = (id, nm, extra) => ({ id, name: nm, type: TrackType.AUDIO, volume: 0.8, pan: 0, isMuted: false, isSolo: false, clips: [], plugins: [], sends: [], automationLanes: [], outputTrackId: 'master', ...extra });
  S.tracks = () => window.__novaTest.getState().tracks;
  S.node = () => liveVstNodes.get(S.plugId);
  // Pistes posées dans l'état de l'appli (même chemin que l'interface) : l'alerte retrouve la piste.
  S.build = async (adaptive) => {
    AB.setVstAdaptiveEnabled(adaptive);
    S.plugId = 'vst-silence-' + Math.random().toString(36).slice(2, 7);
    const v = base('silence-vst', 'Voix (VST)', { pan: -1, clips: [clip('c-silence-vst')], plugins: [{ id: S.plugId, name, type: 'VST3', isEnabled: true, latency: 0, params: { name, localPath: path } }] });
    const r = base('silence-ref', 'Référence', { pan: 1, clips: [clip('c-silence-ref')] });
    window.__novaTest.update(d => {
      const m = d.tracks.find(t => t.id === 'master');
      d.tracks = [v, r, ...(m ? [{ ...m, plugins: [], sends: [] }] : [])];
    });
    const t0 = performance.now();
    // Attente du chargement ; un échec du pont (hôte natif absent, licence…) arrête tout de suite.
    while (!S.node()?.getSlotId() && S.node()?.getInfo().status !== 'error' && performance.now() - t0 < 240000) await new Promise(r => setTimeout(r, 100));
    if (!S.node()?.getSlotId()) {
      const i = S.node()?.getInfo();
      return { erreur: 'plugin pas chargé sur le pont' + (i ? ` (état ${i.status}${i.error ? ' : ' + i.error : ''})` : ' (aucun nœud VST)') };
    }
    const r1 = await novaBridge.setParams(S.node().getSlotId(), sets);
    await new Promise(r => setTimeout(r, 1500));
    return { reglages: (r1.results || []).map(x => ({ nom: x.name, texte: x.text ?? null, ok: x.ok })), latence_ms: Math.round(S.node().latency * 1e5) / 100, adaptatif: adaptive };
  };
  S.slow = async (o) => novaBridge.request({ action: 'DEBUG_SLOW', ...o });
  S.info = () => { const i = S.node()?.getInfo(); return i && { ...i, tampon_echantillons: S.node().getPrebufferFrames(), latence_s: S.node().latency }; };
  // Enregistreur du master, à l'échantillon près.
  const recSrc = `class R extends AudioWorkletProcessor { constructor() { super(); this.on = false; this.port.onmessage = (e) => { this.on = !!e.data; }; }
    process(inputs) { const i = inputs[0]; if (this.on && i && i.length) this.port.postMessage([currentFrame, i[0].slice(), (i[1] || i[0]).slice()]); return true; } }
    registerProcessor('nova-qa-rec-silence', R);`;
  await e.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([recSrc], { type: 'application/javascript' })));
  // Écoute de `dur` s depuis 0 (lancée sans attendre : l'écran peut être photographié pendant).
  S.capture = (dur) => {
    S.pending = (async () => {
      e.setSafetyLimiter(false);
      const rec = new AudioWorkletNode(e.ctx, 'nova-qa-rec-silence', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
      const tap = e.getMasterMeterInput(); const mute = e.ctx.createGain(); mute.gain.value = 0;
      tap.connect(rec); rec.connect(mute); mute.connect(e.ctx.destination);
      const blocks = []; rec.port.onmessage = ev => blocks.push(ev.data); rec.port.postMessage(true);
      const hold0 = e.transportHoldTotal || 0;
      const late0 = e.schedulerLateTicks || 0;
      const before = S.info();
      e.startPlayback(0, S.tracks(), { at: e.ctx.currentTime + 0.4 });
      const origin = e.playbackStartTime;
      const c0 = e.ctx.currentTime, w0 = performance.now();
      while (e.ctx.currentTime - c0 < dur + 0.8 && performance.now() - w0 < 120000) await new Promise(r => setTimeout(r, 50));
      const during = S.info();
      e.stopAll(); await new Promise(r => setTimeout(r, 300)); rec.port.postMessage(false);
      try { tap.disconnect(rec); rec.disconnect(); mute.disconnect(); } catch (err) {}
      const n = Math.round(dur * SR), L = new Float32Array(n), R = new Float32Array(n), got = new Uint8Array(n), f0 = Math.round(origin * SR);
      for (const [fr, a, b] of blocks) for (let i = 0; i < a.length; i++) { const k = fr + i - f0; if (k >= 0 && k < n) { L[k] = a[i]; R[k] = b[i]; got[k] = 1; } }
      S.last = { L, R, got, n, dur, holdK: Math.round(((e.transportHoldTotal || 0) - hold0) * SR), lateTicks: (e.schedulerLateTicks || 0) - late0 };
      return { avant: before, pendant: during, apres_arret: S.info(), attente_transport_ech: S.last.holdK };
    })();
    return true;
  };
  // Analyse de la dernière écoute.
  S.analyse = async (withExport) => {
    const { L, R, got, n, holdK } = S.last;
    const clipStart = Math.round(CLIP0 * SR);
    // Trous : ≥ 64 échantillons de silence numérique pendant le son. Gauche = piste VST ;
    // droite = piste de référence (sa pause volontaire quand le transport attend).
    // Un bloc que l'ENREGISTREUR n'a pas reçu (raté de la machine, pas du pont : la piste de
    // référence ne passe pas par le pont) n'est pas un trou du pont ; il est compté à part.
    const missed = []; { let run = 0; for (let i = clipStart; i < n; i++) { if (!got[i]) run++; else { if (run) missed.push({ debut_s: +((i - run) / SR).toFixed(4), duree_ms: +(run / SR * 1000).toFixed(2) }); run = 0; } } if (run) missed.push({ debut_s: +((n - run) / SR).toFixed(4), duree_ms: +(run / SR * 1000).toFixed(2) }); }
    const holesOf = (x) => { const h = []; let run = 0, cap = 0;
      const close = (end) => { if (run >= 64 && cap < run) h.push({ debut_s: +((end - run) / SR).toFixed(4), duree_ms: +(run / SR * 1000).toFixed(2) }); run = 0; cap = 0; };
      for (let i = clipStart + 48; i < n - 2400; i++) {
        if (Math.abs(x[i]) < 1e-7) { run++; if (!got[i]) cap++; }
        else close(i);
      }
      close(n - 2400);
      return h; };
    const holes = holesOf(L), holesR = holesOf(R);
    const after2 = [...holes, ...holesR].filter(h => h.debut_s >= CLIP0 + 2);
    const lastEnd = [...holes, ...holesR].reduce((m, h) => Math.max(m, h.debut_s + h.duree_ms / 1000), 0);
    // Calage : salves repérées sur la référence (droite), décalage gauche/droite par corrélation.
    const lags = [];
    const env = (x, i) => Math.abs(x[i]);
    for (let i = clipStart; i < n - 4800; i++) {
      if (env(R, i) > 0.35 && (lags.length === 0 || i - lags[lags.length - 1].ech > 0.3 * SR)) {
        const at = i; let best = -Infinity, lag = 0;
        if (at / SR <= lastEnd + 0.05) { lags.push({ ech: at, t: +(at / SR).toFixed(3), decalage: null }); i += 0.3 * SR; continue; }
        for (let d = -600; d <= 600; d++) { let s = 0; for (let k = at - 120; k < at + 600; k++) s += L[k + d] * R[k]; if (s > best) { best = s; lag = d; } }
        lags.push({ ech: at, t: +(at / SR).toFixed(3), decalage: lag });
        i += 0.3 * SR;
      }
    }
    const measured = lags.filter(x => x.decalage !== null).map(x => x.decalage);
    const out = {
      trous: holes.length, trous_ms_total: +holes.reduce((s, h) => s + h.duree_ms, 0).toFixed(1),
      silence_pct: +(100 * holes.reduce((s, h) => s + h.duree_ms, 0) / 1000 / ((n - clipStart) / SR)).toFixed(1),
      ordonnanceur_en_retard: S.last.lateTicks, blocs_non_captures: missed.length, blocs_non_captures_detail: missed.slice(0, 8),
      trous_reference: holesR.length, trous_reference_ms_total: +holesR.reduce((s, h) => s + h.duree_ms, 0).toFixed(1),
      trous_apres_2s: after2.length, dernier_trou_fin_s: +lastEnd.toFixed(3), premiers_trous: holes.slice(0, 8), trous_reference_detail: holesR.slice(0, 8),
      salves_mesurees: measured.length, decalages_gauche_droite: [...new Set(measured)], attente_transport_ech: holdK,
    };
    if (withExport) {
      const { prepareTracksForOffline } = await M('/services/VstFreeze.ts');
      const slot = S.node()?.getSlotId();
      if (!slot) throw new Error('export : plugin plus chargé sur le pont (' + JSON.stringify(S.info()) + ')');
      const st = await novaBridge.getPluginState(slot);
      const tr = S.tracks().map(t => ({ ...t, plugins: (t.plugins || []).map(p => p.id === S.plugId ? { ...p, params: { ...p.params, stateB64: st } } : p) }));
      const prep = await prepareTracksForOffline(tr);
      let ex;
      try { ex = await e.renderProject(prep.tracks, S.last.dur, 0, SR); } finally { prep.cleanup?.(); }
      const EL = ex.getChannelData(0), ER = ex.getChannelData(1);
      // Après l'agrandissement (dernier trou + 0,3 s), lecture[t] = export[t − K].
      const from = Math.max(clipStart, Math.round((lastEnd + 0.3) * SR));
      let m = 0, at = -1;
      for (let i = from; i < n - 1200; i++) { const j = i - holdK; if (j < 0 || !got[i]) continue; const d = Math.max(Math.abs(L[i] - EL[j]), Math.abs(R[i] - ER[j])); if (d > m) { m = d; at = i; } }
      out.lecture_vs_export = { depuis_s: +(from / SR).toFixed(3), decalage_K_ech: holdK, ecart_max_lsb16: +(m * 32768).toFixed(4), a_s: +(at / SR).toFixed(4) };
    }
    return out;
  };
  return { ok: true, pont: novaBridge.getBridgeState().version };
}
"""


def running_qa() -> int:
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-Command",
                            "(Get-CimInstance Win32_Process -Filter \"name='python.exe'\" | Where-Object { $_.CommandLine -match 'qa[\\\\/][a-z0-9_]+\\.py' }).Count"],
                           capture_output=True, text=True, timeout=60, creationflags=0x08000000)
        return max(0, int((r.stdout or "0").strip() or 0) - 1)
    except Exception:
        return 0


def port_free(port):
    try:
        socket.create_connection(("127.0.0.1", port), 0.3).close()
        return False
    except OSError:
        return True


def built(key, r):
    """Mise en place d'une phase : son erreur (plugin pas chargé…) arrête le scénario, avec sa cause."""
    if isinstance(r, dict) and r.get("erreur"):
        raise RuntimeError(f"installation {key} : {r['erreur']}")
    return r


def main():
    # Hôte natif absent (les exes ne sont pas suivis par git) : le pont démarrerait sans moteur VST
    # (« moteur VST : none ») et rien ne se chargerait. On le dit tout de suite.
    if not os.path.isfile(EXE):
        print(f"ÉCHEC : hôte VST natif absent : {EXE}\n"
              "  Les exes ne sont pas suivis par git : copie native-host\\build\\NovaVSTHost_artefacts\\Release\\ "
              "depuis un worktree qui l'a construit, ou indique-le par NOVA_VST_HOST_EXE.")
        return 2
    port = next((p for p in (8797, 8798) if port_free(p)), None)
    if port is None:
        print("ports 8797 et 8798 occupés")
        return 2
    env = dict(os.environ, NOVA_BRIDGE_PORT=str(port), NOVA_BRIDGE_DEBUG="1", PYTHONIOENCODING="utf-8", NOVA_VST_HOST_EXE=EXE)
    env.pop("NOVA_TEST_SLOW_MS", None)
    env.pop("NOVA_TEST_SLOW_JITTER_MS", None)
    res = {"url": URL, "label": LABEL, "port_pont": port, "exe": EXE, "plugin": PLUGIN[0], "pont_ralenti": SLOW, "phases": {}, "verifications": {}}
    logf = open(OUT / f"pont-{LABEL}.log", "w", encoding="utf-8")
    br = subprocess.Popen([str(BRIDGE_PY), "nova_bridge_server.py"], cwd=str(ROOT / "bridge-python"), env=env,
                          stdout=logf, stderr=subprocess.STDOUT, creationflags=0x08000000)
    t_start = time.time()
    try:
        for _ in range(240):
            if not port_free(port):
                break
            time.sleep(0.5)
        while running_qa() >= 2:
            time.sleep(20)
        with sync_playwright() as p:
            b = p.chromium.launch(headless=True, executable_path=CHROME, args=["--autoplay-policy=no-user-gesture-required"])
            pg = b.new_page(viewport={"width": 1440, "height": 900})
            errs = []
            pg.on("pageerror", lambda x: errs.append(str(x)[:300]))
            pg.add_init_script(APP_MODULE_INIT)
            pg.add_init_script(f"try {{ localStorage.setItem('nova.bridge.url', 'ws://127.0.0.1:{port}'); localStorage.setItem('nova_welcome_seen', '1'); localStorage.setItem('nova_simple_mode', '0'); }} catch (e) {{}}")
            pg.goto(URL, wait_until="domcontentloaded", timeout=120000)
            pg.wait_for_timeout(5000)
            pg.get_by_text("Nouveau Projet", exact=True).first.click()
            pg.locator("[data-testid=dsp-meter]").first.wait_for(timeout=60000)
            pg.wait_for_timeout(1500)
            pg.set_default_timeout(900000)
            res["installation"] = pg.evaluate(SETUP_JS, {"SR": SR, "path": PLUGIN[1], "name": PLUGIN[0], "sets": PLUGIN[2]})
            print("installation", res["installation"], flush=True)
            if res["installation"].get("erreur"):
                raise RuntimeError(res["installation"]["erreur"])

            def close_dialogs():
                # Proposition « Utiliser ton autotune » (pont connecté) : « Plus tard », sans rien activer.
                later = pg.get_by_role("button", name="Plus tard")
                if later.count() and later.first.is_visible():
                    later.first.click()
                    pg.wait_for_timeout(400)

            def phase(key, dur, export=True, shots=(), rebuild=None):
                """Écoute mesurée. Machine partagée : une écoute dérangée (ordonnanceur du moteur en
                retard, blocs non captés par l'enregistreur — rien à voir avec le pont) est refaite,
                2 fois au plus ; toutes les tentatives sont gardées."""
                essais = []
                for k in range(3):
                    if k and rebuild:
                        rebuild()
                    r = one(key, dur, export, shots)
                    essais.append({x: r.get(x) for x in ("trous", "trous_reference", "trous_apres_2s", "ordonnanceur_en_retard", "blocs_non_captures", "decalages_gauche_droite")})
                    if not r.get("ordonnanceur_en_retard") and not r.get("blocs_non_captures"):
                        break
                r["tentatives"] = essais
                res["phases"][key] = r
                (OUT / f"silence_{LABEL}.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
                return r

            def one(key, dur, export, shots):
                close_dialogs()
                pg.evaluate(f"() => window.__silence.capture({dur})")
                pendant = None
                for at, name in shots:
                    pg.wait_for_timeout(int(at * 1000))
                    pg.screenshot(path=str(OUT / f"{LABEL}_{name}.png"))
                    al = pg.locator("[data-testid=vst-late-alert]")
                    pendant = {"visible": al.count() > 0 and al.first.is_visible(), "texte": al.first.inner_text() if al.count() else None}
                info = pg.evaluate("() => window.__silence.pending")
                ana = pg.evaluate("(w) => window.__silence.analyse(w)", export)
                alert = pg.locator("[data-testid=vst-late-alert]")
                r = {**ana, "noeud": info, "alerte_pendant_l_ecoute": pendant, "alerte_visible_a_la_fin": alert.count() > 0 and alert.first.is_visible(),
                     "alerte_texte_a_la_fin": alert.first.inner_text() if alert.count() else None}
                print(key, json.dumps({k: r[k] for k in ("trous", "trous_ms_total", "silence_pct", "trous_reference", "trous_apres_2s", "dernier_trou_fin_s",
                                                          "decalages_gauche_droite", "attente_transport_ech", "ordonnanceur_en_retard", "blocs_non_captures") if k in r},
                                      ensure_ascii=False), (r.get("lecture_vs_export") or {}).get("ecart_max_lsb16"), flush=True)
                return r

            # 0) Pont normal, tampon adaptatif (réglage par défaut).
            res["phases_installation"] = {"0": built("0", pg.evaluate("() => window.__silence.build(true)"))}
            p0 = phase("0_pont_normal", 6)
            # A) Pont ralenti, tampon FIXE : le comportement d'avant (silence).
            pg.evaluate("(o) => window.__silence.slow(o)", SLOW)
            res["phases_installation"]["A"] = built("A", pg.evaluate("() => window.__silence.build(false)"))
            pA = phase("A_ralenti_tampon_fixe", 6, export=False, shots=[(3.5, "A_alerte_tampon_fixe")])
            # B) Pont ralenti, tampon ADAPTATIF : 1re écoute (agrandissement en cours d'écoute).
            def build_b():
                pg.evaluate("() => window.__novaTest.update(d => { d.tracks = d.tracks.filter(t => !t.id.startsWith('silence-')); })")
                pg.wait_for_timeout(1500)
                res["phases_installation"]["B"] = built("B", pg.evaluate("() => window.__silence.build(true)"))
                pg.wait_for_timeout(1500)   # mise en route du plugin passée
            build_b()
            pB = phase("B_ralenti_adaptatif_1re_ecoute", 8, shots=[(3.5, "B_alerte_tampon_agrandi")], rebuild=build_b)
            # B2) 2e écoute, pont toujours ralenti : tampon déjà agrandi.
            pB2 = phase("B2_ralenti_adaptatif_2e_ecoute", 6)
            # Fenêtre de l'effet, ouverte depuis sa pastille (compteur, tampon, actions).
            try:
                close_dialogs()
                badge = pg.locator("[data-testid^='vst-late-badge-']").first
                res["pastille_insert"] = badge.count() > 0 and badge.is_visible()
                res["pastille_insert_titre"] = badge.get_attribute("title") if badge.count() else None
                if res["pastille_insert"]:
                    badge.click()
                    pg.locator("[data-testid=vst-late-panel]").first.wait_for(timeout=8000)
                    res["fenetre_effet_texte"] = pg.locator("[data-testid=vst-late-panel]").first.inner_text()
                    pg.screenshot(path=str(OUT / f"{LABEL}_fenetre_effet.png"))
                    pg.keyboard.press("Escape")
                    pg.wait_for_timeout(400)
            except Exception as ex:
                res["fenetre_effet_erreur"] = str(ex)[:200]
            # C) Pont redevenu normal : 17 s d'écoute sans coupure, puis arrêt → le tampon redescend.
            pg.evaluate("() => window.__silence.slow({ ms: 0, jitter_ms: 0 })")
            pC = phase("C_pont_normal_17s_puis_arret", 17, export=False)
            pg.wait_for_timeout(1500)
            res["apres_descente"] = pg.evaluate("() => window.__silence.info()")
            # D) Pont normal, tampon redescendu.
            pD = phase("D_pont_normal_apres_descente", 6)
            res["erreurs_page"] = errs[:10]
            b.close()

        base_lags = set(p0.get("decalages_gauche_droite") or [])
        lsb = lambda r: (r.get("lecture_vs_export") or {}).get("ecart_max_lsb16", 99)
        nB = pB.get("noeud") or {}
        v = res["verifications"] = {
            "0 · pont normal : aucun trou, lecture = export (≤ 1 LSB16)": p0["trous"] == 0 and p0["trous_reference"] == 0 and lsb(p0) <= 1,
            "A · avant (tampon fixe) : le pont ralenti fait des trous": pA["trous"] > 0,
            "A · alerte affichée même tampon fixe": bool((pA["alerte_pendant_l_ecoute"] or {}).get("visible")),
            "B · alerte affichée « a pris du retard : N coupure(s) en 10 s » + action « Geler »": bool((pB["alerte_pendant_l_ecoute"] or {}).get("visible"))
                and "a pris du retard" in ((pB["alerte_pendant_l_ecoute"] or {}).get("texte") or "") and "en 10 s" in ((pB["alerte_pendant_l_ecoute"] or {}).get("texte") or "")
                and "Geler" in ((pB["alerte_pendant_l_ecoute"] or {}).get("texte") or ""),
            "B · pastille de l'insert et fenêtre de l'effet (compteur, actions)": bool(res.get("pastille_insert")) and "Geler la piste" in (res.get("fenetre_effet_texte") or ""),
            "B · tampon agrandi (> 2048)": ((nB.get("pendant") or {}).get("tampon_echantillons") or 0) > 2048,
            "B · 0 silence après 2 s": pB["trous_apres_2s"] == 0,
            "B · calage exact entre pistes après agrandissement (= phase 0)": bool(pB["decalages_gauche_droite"]) and set(pB["decalages_gauche_droite"]) <= base_lags,
            "B · lecture = export décalé de K (transport attendu), ≤ 1 LSB16": lsb(pB) <= 1,
            "B2 · 2e écoute : aucun trou, calage exact, lecture = export": pB2["trous"] == 0 and pB2["trous_reference"] == 0 and set(pB2["decalages_gauche_droite"]) <= base_lags and lsb(pB2) <= 1 and pB2["attente_transport_ech"] == 0,
            "C · pont redevenu normal : aucun trou": pC["trous"] == 0 and pC["trous_reference"] == 0,
            "C · tampon redescendu à 2048 à l'arrêt": (res.get("apres_descente") or {}).get("tampon_echantillons") == 2048,
            "D · aucun trou, lecture = export": pD["trous"] == 0 and pD["trous_reference"] == 0 and lsb(pD) <= 1 and set(pD["decalages_gauche_droite"]) <= base_lags,
        }
        res["ok"] = all(v.values())
    finally:
        subprocess.run(["taskkill", "/PID", str(br.pid), "/T", "/F"], capture_output=True, creationflags=0x08000000)
        logf.close()
    res["secondes"] = round(time.time() - t_start, 1)
    (OUT / f"silence_{LABEL}.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    for k, ok in res.get("verifications", {}).items():
        print(("OK   " if ok else "ÉCHEC"), k)
    print("OK" if res.get("ok") else "ÉCHEC")
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
