"""Banc du moteur audio WEB (navigateur, sans l'appli Windows) : fiabilité mesurée, avant → après.

Headless (aucune fenêtre), hors production (Supabase simulé par qalib / qa_hors_prod), faux micro de
Chrome (--use-fake-device-for-media-stream, fichier audio connu), JAMAIS de vraie carte ASIO.

Mesures (chacune lancée à part : --tests a,b,c) :
  isolation  page isolée (SharedArrayBuffer), chemin des échantillons de la prise, Supabase simulé
             toujours joint, polices et images chargées, aucune erreur ;
  prise      prise de 6 s au faux micro : images captées = images écrites dans la base de récupération,
             aucune perdue ; chemin (anneau partagé / port / page) ;
  latence    boucle intégrée (sortie du moteur → flux micro simulé → entrée) : clics posés sur la
             timeline, enregistrés pendant la lecture : écart de calage de la prise (échantillons),
             latence aller-retour mesurée par le moteur (si la mesure existe) ;
  derive     même boucle pendant --derive-min minutes : dérive du calage (début → fin) ;
  crash      prise de 10 s, fil de l'interface figé 4 s, navigateur TUÉ (taskkill /F /T) au milieu ;
             relancé sur le même profil : secondes de prise récupérées / perdues ;
  charge     --charge-min minutes de lecture + prise, CPU ralenti ×4 (CDP), onglet en arrière-plan
             une partie du temps : sous-régimes (playbackStats), images de prise manquantes, perdues ;
  demarrage  --n navigateurs complets en parallèle (comme la batterie) : délai avant que l'horloge
             audio avance, lecture restée à 0 ; puis panne simulée (contexte suspendu en douce +
             événement « error ») : la lecture repart-elle seule ?

Usage :
  NOVA_URL=http://127.0.0.1:3548/ PYTHONIOENCODING=utf-8 python qa/moteur_web.py --label apres --tests isolation,prise,latence,crash,demarrage
Sortie : $QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-moteur-web)\\moteur_web_<label>.json
Code de sortie : 0 si chaque mesure a pu être relevée sans erreur de page (les objectifs sont rapportés,
les régressions fonctionnelles — prise incomplète, perte d'échantillons — font échouer).
"""
import argparse, json, os, subprocess, sys, tempfile, threading, time, shutil
from pathlib import Path

os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-moteur-web")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402
import qa_hors_prod  # noqa: E402
from qalib import BASE, CHROME, FAKE_WAV, APP_MODULE_INIT, Log, new_page  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

OUT = Path(os.environ["QA_OUT"])
OUT.mkdir(parents=True, exist_ok=True)
KO = []


def ok(name, cond, detail=None):
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:700]}"), flush=True)
    if not cond:
        KO.append(name)


# ---------------------------------------------------------------- outils dans la page
HELPERS = r"""
window.__mw = {
  async engine() {
    const { audioEngine: E } = await window.__novaAppModule('/engine/AudioEngine.ts');
    await E.init(); try { await E.resume(); } catch (e) {}
    return E;
  },
  async types() { return await window.__novaAppModule('/types.ts'); },
  track(T, id, clips) { return { id, name: id, type: T.TrackType.AUDIO, volume: 1, pan: 0, isMuted: false, isSolo: false, sends: [], automationLanes: [], plugins: [], clips: clips || [], outputTrackId: 'master', isTrackArmed: false }; },
  /** Fronts montants au-dessus de 0,3 (un par clic). */
  find(x, thr) { thr = thr || 0.3; const out = []; for (let i = 1; i < x.length; i++) if (Math.abs(x[i]) > thr && Math.abs(x[i - 1]) <= thr) { out.push(i); i += 64; } return out; },
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  /** Boucle intégrée : la sortie du moteur revient par le « micro ». */
  loop(E) {
    const ctx = E.ctx;
    const dest = ctx.createMediaStreamDestination();
    (E.browserOutput || E.mainOut).connect(dest);
    navigator.mediaDevices.getUserMedia = async () => dest.stream;
    return dest;
  },
};
"""

def page_ready(page):
    page.goto(BASE, wait_until="domcontentloaded", timeout=180000)
    page.wait_for_function("() => !!window.__novaAppModule && document.readyState === 'complete'", timeout=180000)
    page.wait_for_timeout(2500)


def browser_page(p, log_name):
    b = qalib.launch(p)
    log = Log(log_name)
    ctx, page = new_page(b, "pc", log)
    ctx.add_init_script(HELPERS)
    page.set_default_timeout(1800_000)
    return b, ctx, page, log


def console_errors(log):
    # 504 « Outdated Optimize Dep » : serveur de dev qui réoptimise ses dépendances (cache partagé), pas l appli.
    return [e["text"][:200] for e in log.errors() if "status of 4" not in e["text"] and "Outdated Optimize Dep" not in e["text"]][:8]


# ---------------------------------------------------------------- isolation
ISOLATION = r"""async () => {
  const E = await __mw.engine();
  let partage = null; try { const R = await window.__novaAppModule('/engine/takeRing.ts'); partage = R.canShareMemory(); } catch (e) {}
  const fonts = document.fonts ? [...document.fonts].filter(f => f.status === 'loaded').length : null;
  const imgs = [...document.images].map(i => ({ src: i.src.slice(0, 80), ok: i.complete && i.naturalWidth > 0 }));
  return { crossOriginIsolated: self.crossOriginIsolated === true, sab: typeof SharedArrayBuffer, partage,
    polices_chargees: fonts, images: imgs.length, images_cassees: imgs.filter(i => !i.ok).map(i => i.src).slice(0, 5), sr: E.ctx.sampleRate };
}"""


def t_isolation(p, res):
    b, ctx, page, log = browser_page(p, "mw_isolation")
    page_ready(page)
    r = page.evaluate(ISOLATION)
    r["supabase_simule"] = qa_hors_prod.STATS if hasattr(qa_hors_prod, "STATS") else None
    r["erreurs_console"] = console_errors(log)
    res["isolation"] = r
    print("isolation :", json.dumps(r, ensure_ascii=False, default=str)[:600], flush=True)
    ok("isolation : aucune image cassée, aucune erreur de console", not r["images_cassees"] and not r["erreurs_console"], r)
    b.close()


# ---------------------------------------------------------------- prise (faux micro)
PRISE = r"""async (secs) => {
  const E = await __mw.engine(); const T = await __mw.types();
  const tid = 'voix-prise';
  const tr = __mw.track(T, tid); E.updateTrack(tr, [tr]);
  const err = await E.armTrack(tid, { alone: true }); if (err) return { erreur: err };
  await __mw.sleep(800);
  const t0 = E.ctx.currentTime;
  if (!(await E.startRecording(0, tid))) return { erreur: 'startRecording' };
  await __mw.sleep(secs * 1000);
  const takes = await E.stopRecordingAll(); const t1 = E.ctx.currentTime; E.disarmTrack(tid);
  const h = E.getLastTakeHealth ? E.getLastTakeHealth() : null;
  const RS = await window.__novaAppModule('/utils/recoveryStore.ts');
  await __mw.sleep(600);
  const pend = (await RS.recoveryStore().pendingTakes()).filter(m => m.trackId === tid);
  const last = pend[pend.length - 1];
  const stored = last ? await RS.recoveryStore().readTake(last.takeId) : null;
  const clip = takes[0] && takes[0].clip;
  return { secs, duree_horloge_s: +(t1 - t0).toFixed(3), sr: E.ctx.sampleRate, sante: h,
    images_prise: h ? h.frames : null, images_journal: stored ? stored.samples.length : null,
    clip_s: clip ? +clip.duration.toFixed(3) : null };
}"""


def t_prise(p, res):
    b, ctx, page, log = browser_page(p, "mw_prise")
    page_ready(page)
    r = page.evaluate(PRISE, 6)
    r["erreurs_console"] = console_errors(log)
    res["prise"] = r
    print("prise :", json.dumps(r, ensure_ascii=False, default=str), flush=True)
    h = r.get("sante") or {}
    if r.get("sante") is None and not r.get("erreur"):
        print("   (version sans compte de santé de la prise : comparaison impossible, mesure informative)", flush=True)
        ok("prise : prise relevée (journal écrit)", (r.get("images_journal") or 0) > 0, r)
    else:
        ok("prise : 6 s captées, autant d'images dans la base de récupération (aucune perdue)",
           not r.get("erreur") and r.get("images_prise") and abs((r.get("images_journal") or 0) - r["images_prise"]) <= 0 and (h.get("lost") or 0) == 0, r)
    b.close()


# ---------------------------------------------------------------- latence (boucle intégrée)
LATENCE = r"""async (opts) => {
  const E = await __mw.engine(); const T = await __mw.types();
  const ctx = E.ctx, sr = ctx.sampleRate;
  const dest = __mw.loop(E);
  const N = opts.n, step = opts.step, first = 1.0;
  const dur = first + N * step + 1;
  const buf = ctx.createBuffer(1, Math.ceil(dur * sr), sr);
  const d = buf.getChannelData(0);
  const want = [];
  for (let i = 0; i < N; i++) { const at = Math.round((first + i * step) * sr); want.push(at); for (let j = 0; j < 24; j++) d[at + j] = 0.8; }
  const guide = __mw.track(T, 'guide', [{ id: 'clics', name: 'clics', start: 0, duration: buf.duration, offset: 0, fadeIn: 0, fadeOut: 0, type: T.TrackType.AUDIO, color: '#fff', buffer: buf }]);
  const voix = __mw.track(T, 'voix-boucle');
  const tracks = [guide, voix];
  tracks.forEach(t => E.updateTrack(t, tracks));
  E.setInputMonitoring && E.setInputMonitoring(false);
  const err = await E.armTrack('voix-boucle', { alone: true }); if (err) return { erreur: err };
  await __mw.sleep(1000);
  let mesure = null;
  if (opts.calibrer && typeof E.measureRoundTrip === 'function') { try { mesure = await E.measureRoundTrip(); } catch (e) { mesure = { erreur: String(e) }; } }
  const compensation = E.measureRecordLatency ? E.measureRecordLatency().total : null;
  E.startPlayback(0, tracks);
  if (!(await E.startRecording(0, 'voix-boucle'))) return { erreur: 'startRecording' };
  const series = [];
  const t0 = performance.now();
  while (performance.now() - t0 < dur * 1000) { await __mw.sleep(1000); if (opts.suivi) series.push({ t: Math.round((performance.now() - t0) / 1000), ctx: +ctx.currentTime.toFixed(2) }); }
  const takes = await E.stopRecordingAll(); E.stopAll(); E.disarmTrack('voix-boucle');
  try { (E.browserOutput || E.mainOut).disconnect(dest); } catch (e) {}
  const clip = takes[0] && takes[0].clip;
  if (!clip) return { erreur: 'pas de prise' };
  const x = clip.buffer.getChannelData(0);
  const found = __mw.find(x, 0.2);
  // Position de chaque clic trouvé sur la timeline (s → échantillons), comparée au clic posé le plus proche.
  const errs = found.map(f => { const p = Math.round(clip.start * sr) + f; let best = want[0]; for (const w of want) if (Math.abs(w - p) < Math.abs(best - p)) best = w; return { k: want.indexOf(best), e: p - best }; })
    .filter(r => Math.abs(r.e) < sr * 0.3);
  const e = errs.map(r => r.e);
  const med = e.length ? [...e].sort((a, b) => a - b)[e.length >> 1] : null;
  const firstErr = errs.slice(0, 5).map(r => r.e), lastErr = errs.slice(-5).map(r => r.e);
  const avg = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
  return { sr, clics: N, trouves: errs.length, ecart_median_ech: med, ecart_median_ms: med === null ? null : +(med / sr * 1000).toFixed(2),
    ecart_min_ech: e.length ? Math.min(...e) : null, ecart_max_ech: e.length ? Math.max(...e) : null,
    derive_ech: errs.length > 10 ? +((avg(lastErr) - avg(firstErr)).toFixed(1)) : null,
    compensation_ms: compensation === null ? null : +(compensation * 1000).toFixed(2), mesure,
    base_ms: +(ctx.baseLatency * 1000).toFixed(2), sortie_ms: +((ctx.outputLatency || 0) * 1000).toFixed(2),
    duree_s: +dur.toFixed(1), suivi: series.length ? [series[0], series[series.length - 1]] : null };
}"""


def t_latence(p, res, calibrer):
    b, ctx, page, log = browser_page(p, "mw_latence")
    page_ready(page)
    r = page.evaluate(LATENCE, {"n": 12, "step": 0.5, "calibrer": calibrer, "suivi": False})
    r["erreurs_console"] = console_errors(log)
    res["latence"] = r
    print("latence :", json.dumps(r, ensure_ascii=False, default=str), flush=True)
    ok("latence : prise de la boucle relevée (clics retrouvés)", not r.get("erreur") and r.get("trouves", 0) >= 10, r)
    if calibrer and (r.get("mesure") or {}).get("ok"):
        ok("latence : latence mesurée par la boucle, prise calée à ±1 échantillon", r.get("ecart_median_ech") is not None and abs(r["ecart_median_ech"]) <= 1, r)
    b.close()


def t_derive(p, res, minutes, calibrer):
    b, ctx, page, log = browser_page(p, "mw_derive")
    page_ready(page)
    n = int(minutes * 60)
    r = page.evaluate(LATENCE, {"n": n, "step": 1.0, "calibrer": calibrer, "suivi": True})
    r["erreurs_console"] = console_errors(log)
    res["derive"] = r
    print("dérive :", json.dumps(r, ensure_ascii=False, default=str), flush=True)
    ok(f"dérive : prise de {minutes} min relevée", not r.get("erreur") and r.get("trouves", 0) >= n * 0.9, r)
    b.close()


# ---------------------------------------------------------------- crash (navigateur tué)
CRASH_REC = r"""async (o) => {
  const E = await __mw.engine(); const T = await __mw.types();
  const tid = 'voix-crash';
  const tr = __mw.track(T, tid); E.updateTrack(tr, [tr]);
  const err = await E.armTrack(tid, { alone: true }); if (err) return { erreur: err };
  await __mw.sleep(800);
  if (!(await E.startRecording(0, tid))) return { erreur: 'startRecording' };
  window.__crashT0 = performance.now();
  await __mw.sleep(o.avant * 1000);
  // Interface figée (fil principal bloqué), comme un gros projet qui se charge : le navigateur est tué pendant ce temps.
  setTimeout(() => { const t = performance.now(); while (performance.now() - t < o.fige * 1000) {} }, 0);
  return { ok: true, sr: E.ctx.sampleRate };
}"""

CRASH_READ = r"""async () => {
  const RS = await window.__novaAppModule('/utils/recoveryStore.ts');
  const all = await RS.recoveryStore().pendingTakes();
  const mine = all.filter(m => m.trackId === 'voix-crash');
  const out = [];
  for (const m of mine) { const t = await RS.recoveryStore().readTake(m.takeId); out.push({ takeId: m.takeId, secondes: t ? +t.seconds.toFixed(3) : 0, fin: m.endedAt }); }
  const card = !!document.body.innerText.match(/récupér|Reprendre/i);
  return { prises: out, carte_reprise: card };
}"""


def kill_tree(profile: Path):
    import psutil
    killed = 0
    for pr in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            cl = " ".join(pr.info.get("cmdline") or [])
            if str(profile) in cl and "chrome" in (pr.info.get("name") or "").lower():
                pr.kill(); killed += 1
        except Exception:
            pass
    return killed


def persistent(p, profile: Path):
    ctx = p.chromium.launch_persistent_context(
        str(profile), headless=True, executable_path=CHROME, viewport={"width": 1600, "height": 900}, locale="fr-BE",
        permissions=["microphone"],
        args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={FAKE_WAV}",
              "--autoplay-policy=no-user-gesture-required"])
    qa_hors_prod.install(ctx, None)
    ctx.add_init_script(APP_MODULE_INIT)
    ctx.add_init_script(HELPERS)
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.set_default_timeout(180000)
    return ctx, page


def t_crash(p, res, avant=10.0, fige=4.0, tue_apres=2.0):
    profile = Path(tempfile.mkdtemp(prefix="nova_mw_crash_"))
    ctx, page = persistent(p, profile)
    page_ready(page)
    r = page.evaluate(CRASH_REC, {"avant": avant, "fige": fige})
    if r.get("erreur"):
        res["crash"] = r; ok("crash : prise lancée", False, r); return
    t_rec_start = time.time() - avant
    time.sleep(tue_apres)
    capte = time.time() - t_rec_start
    killed = kill_tree(profile)
    try: ctx.close()
    except Exception: pass
    time.sleep(1.5)
    ctx2, page2 = persistent(p, profile)
    page_ready(page2)
    page2.wait_for_timeout(3000)
    rd = page2.evaluate(CRASH_READ)
    try: ctx2.close()
    except Exception: pass
    shutil.rmtree(profile, ignore_errors=True)
    rec = max([x["secondes"] for x in rd["prises"]] or [0])
    out = {"enregistre_avant_le_crash_s": round(capte, 2), "dont_interface_figee_s": tue_apres, "recupere_s": rec, "perdu_s": round(capte - rec, 2),
           "processus_tues": killed, **rd}
    res["crash"] = out
    print("crash :", json.dumps(out, ensure_ascii=False), flush=True)
    ok("crash : une prise est retrouvée après la mort du navigateur", rec > 0, out)
    ok("crash : moins de 0,5 s perdue (interface figée au moment du crash)", out["perdu_s"] <= 0.5, out)


# ---------------------------------------------------------------- charge (CPU ×4, arrière-plan)
CHARGE_START = r"""async (o) => {
  const E = await __mw.engine(); const T = await __mw.types();
  const ctx = E.ctx, sr = ctx.sampleRate;
  // Lecture : 8 pistes d'un son continu (bruit filtré) en boucle de 20 s, chacune avec un effet NOVA si dispo.
  const len = 20 * sr; const buf = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); let y = 0; for (let i = 0; i < len; i++) { y = 0.97 * y + 0.03 * (Math.random() * 2 - 1); d[i] = y * 0.3; } }
  const tracks = [];
  for (let k = 0; k < 8; k++) tracks.push(__mw.track(T, 'lecture-' + k, [{ id: 'c' + k, name: 'c' + k, start: 0, duration: 20, offset: 0, fadeIn: 0, fadeOut: 0, type: T.TrackType.AUDIO, color: '#888', buffer: buf }]));
  const voix = __mw.track(T, 'voix-charge'); tracks.push(voix);
  tracks.forEach(t => E.updateTrack(t, tracks));
  const err = await E.armTrack('voix-charge', { alone: true }); if (err) return { erreur: err };
  await __mw.sleep(800);
  E.setLoop(true, 0, 20);
  const ps = ctx.playbackStats;
  window.__charge = { t0: ctx.currentTime, w0: performance.now(), u0: ps ? ps.underrunEvents : null, d0: ps ? ps.underrunDuration : null, tracks };
  E.startPlayback(0, tracks);
  if (!(await E.startRecording(0, 'voix-charge'))) return { erreur: 'startRecording' };
  window.__charge.r0 = ctx.currentTime;
  return { ok: true, sr };
}"""

CHARGE_STOP = r"""async () => {
  const { audioEngine: E } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const c = window.__charge, ctx = E.ctx;
  const r1 = ctx.currentTime;
  const takes = await E.stopRecordingAll(); E.stopAll(); E.disarmTrack('voix-charge'); E.setLoop(false, 0, 0);
  const ps = ctx.playbackStats;
  const h = E.getLastTakeHealth ? E.getLastTakeHealth() : null;
  const sr = ctx.sampleRate;
  const attendu = Math.round((r1 - c.r0) * sr);
  return { duree_horloge_s: +(r1 - c.t0).toFixed(1), duree_murale_s: +((performance.now() - c.w0) / 1000).toFixed(1),
    sous_regimes: ps ? ps.underrunEvents - c.u0 : null, sous_regimes_ms: ps ? +((ps.underrunDuration - c.d0) * 1000).toFixed(1) : null,
    latence_moy_ms: ps ? +(ps.averageLatency * 1000).toFixed(1) : null,
    images_attendues: attendu, images_prise: h ? h.frames : (takes[0] ? takes[0].clip.buffer.length : null),
    ecart_images: h ? h.frames - attendu : null, sante: h, horloge_audio: E.getClockWatchStatus ? E.getClockWatchStatus() : null };
}"""


def t_charge(p, res, minutes, fond_min):
    b, ctx, page, log = browser_page(p, "mw_charge")
    page_ready(page)
    cdp = ctx.new_cdp_session(page)
    r = page.evaluate(CHARGE_START, {})
    if r.get("erreur"):
        res["charge"] = r; ok("charge : lecture + prise lancées", False, r); b.close(); return
    cdp.send("Emulation.setCPUThrottlingRate", {"rate": 4})
    total = minutes * 60
    t0 = time.time()
    # Onglet en arrière-plan : un autre onglet passe devant pendant fond_min minutes (au milieu).
    other = None
    phase = "avant"   # avant → fond → fini
    fond_debut = (total - fond_min * 60) / 2
    vis_fond = None
    while time.time() - t0 < total:
        el = time.time() - t0
        if phase == "avant" and fond_min > 0 and el >= fond_debut:
            other = ctx.new_page(); other.goto("about:blank"); other.bring_to_front()
            vis_fond = page.evaluate("() => document.visibilityState")
            print(f"  arrière-plan à {el:.0f} s (page : {vis_fond})", flush=True)
            phase = "fond"
        elif phase == "fond" and el >= fond_debut + fond_min * 60:
            page.bring_to_front(); other.close(); other = None
            print(f"  premier plan à {el:.0f} s", flush=True)
            phase = "fini"
        time.sleep(5)
    cdp.send("Emulation.setCPUThrottlingRate", {"rate": 1})
    if other is not None:
        page.bring_to_front(); other.close()
    r = page.evaluate(CHARGE_STOP)
    r["minutes"] = minutes; r["arriere_plan_min"] = fond_min; r["visibilite_en_arriere_plan"] = vis_fond
    r["erreurs_console"] = console_errors(log)
    res["charge"] = r
    print("charge :", json.dumps(r, ensure_ascii=False, default=str), flush=True)
    ok(f"charge : prise de {minutes} min complète (images = horloge, aucune perdue)",
       r.get("ecart_images") is None or (abs(r["ecart_images"]) <= 128 and ((r.get("sante") or {}).get("lost") or 0) == 0), r)
    b.close()


# ---------------------------------------------------------------- démarrage sous charge + panne simulée
DEMARRAGE = r"""async () => {
  const E = await __mw.engine(); const T = await __mw.types();
  const ctx0 = E.ctx;
  const sr = ctx0.sampleRate; const buf = ctx0.createBuffer(1, 30 * sr, sr); buf.getChannelData(0).fill(0.01);
  const tr = __mw.track(T, 'piste', [{ id: 'c', name: 'c', start: 0, duration: 30, offset: 0, fadeIn: 0, fadeOut: 0, type: T.TrackType.AUDIO, color: '#888', buffer: buf }]);
  E.updateTrack(tr, [tr]);
  const t0 = performance.now();
  E.startPlayback(0, [tr]);
  let avance = null;
  while (performance.now() - t0 < 20000) { if (E.getCurrentTime() > 0.3) { avance = (performance.now() - t0) / 1000; break; } await __mw.sleep(50); }
  return { lecture_avance_s: avance === null ? null : +avance.toFixed(2), contexte_recree: E.ctx !== ctx0, garde: E.getClockWatchStatus ? E.getClockWatchStatus() : null };
}"""

PANNE = r"""async () => {
  // Panne de la sortie simulée pendant la lecture : contexte suspendu en douce (l'horloge s'arrête,
  // comme après « The AudioContext encountered an error from the audio device »), puis l'événement « error ».
  const { audioEngine: E } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const T = await __mw.types();
  const ctx0 = E.ctx;
  if (!E.isPlaying) {
    const sr = ctx0.sampleRate; const buf = ctx0.createBuffer(1, 60 * sr, sr); buf.getChannelData(0).fill(0.01);
    const tr = __mw.track(T, 'piste-panne', [{ id: 'p', name: 'p', start: 0, duration: 60, offset: 0, fadeIn: 0, fadeOut: 0, type: T.TrackType.AUDIO, color: '#888', buffer: buf }]);
    E.updateTrack(tr, [tr]); E.startPlayback(0, [tr]);
  }
  await __mw.sleep(1500);
  const avant = E.getCurrentTime();
  await AudioContext.prototype.suspend.call(ctx0);
  try { ctx0.dispatchEvent(new Event('error')); } catch (e) {}
  const t0 = performance.now(); let repart = null;
  while (performance.now() - t0 < 15000) { await __mw.sleep(100); if (E.ctx && E.ctx.state === 'running' && E.isPlaying && E.getCurrentTime() > avant + 0.5) { repart = (performance.now() - t0) / 1000; break; } }
  const msgs = (window.__mwNotes || []).slice(-4);
  return { position_avant_s: +avant.toFixed(2), repart_s: repart === null ? null : +repart.toFixed(2), contexte_recree: E.ctx !== ctx0,
    position_apres_s: +E.getCurrentTime().toFixed(2), messages: msgs, garde: E.getClockWatchStatus ? E.getClockWatchStatus() : null };
}"""

NOTES_INIT = "window.__mwNotes = []; window.addEventListener('nova:notify', e => window.__mwNotes.push(String(e.detail)));"


def t_demarrage(p_unused, res, n):
    out = [None] * n

    def run(i):
        with sync_playwright() as p:
            b = qalib.launch(p)
            log = Log(f"mw_dem_{i}")
            ctx, page = new_page(b, "pc", log)
            ctx.add_init_script(HELPERS); ctx.add_init_script(NOTES_INIT)
            page.set_default_timeout(240000)
            try:
                page_ready(page)
                r = page.evaluate(DEMARRAGE)
                if i < 3:
                    r["panne"] = page.evaluate(PANNE)
                r["erreurs_audio"] = [e["text"][:120] for e in log.entries if "AudioContext" in e["text"]][:3]
                out[i] = r
            except Exception as e:
                out[i] = {"exception": str(e)[:200]}
            b.close()
    th = [threading.Thread(target=run, args=(i,)) for i in range(n)]
    for t in th:
        t.start(); time.sleep(0.3)
    for t in th:
        t.join()
    starts = [r.get("lecture_avance_s") for r in out if r and "lecture_avance_s" in r]
    jamais = sum(1 for s in starts if s is None)
    vals = sorted(s for s in starts if s is not None)
    pannes = [r["panne"] for r in out if r and r.get("panne")]
    summ = {"navigateurs": n, "lecture_jamais_partie_20s": jamais, "delai_median_s": vals[len(vals) // 2] if vals else None,
            "delai_max_s": vals[-1] if vals else None, "delais_s": vals, "contextes_recrees": sum(1 for r in out if r and r.get("contexte_recree")),
            "panne": pannes, "pannes_resolues": sum(1 for x in pannes if x.get("repart_s") is not None),
            "exceptions": [r["exception"] for r in out if r and r.get("exception")][:3]}
    res["demarrage"] = summ
    print("démarrage :", json.dumps(summ, ensure_ascii=False, default=str)[:1500], flush=True)
    ok(f"démarrage : {n} navigateurs en parallèle relevés", len(starts) == n, summ)
    ok("démarrage : la lecture repart seule après une panne de la sortie", pannes and summ["pannes_resolues"] == len(pannes), summ)


# ---------------------------------------------------------------- toucher → son (téléphone)
TOUCH_PROBE = r"""() => {
  window.__tp = { downs: [], res: [] };
  window.addEventListener('pointerdown', e => { window.__tp.downs.push(e.timeStamp); }, { capture: true });
}"""

TOUCH_WAIT = r"""async (p0) => {
  const { audioEngine: E } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const t0 = window.__tp.downs[window.__tp.downs.length - 1];
  const start = performance.now();
  while (performance.now() - start < 5000) {
    const c = E.ctx;
    if (c && E.isPlaying && c.state === 'running' && c.currentTime > 0 && E.getCurrentTime() > p0 + 0.005) {
      const now = performance.now();
      // Instant où le 1er échantillon de la lecture a été rendu ≈ maintenant − (position atteinte).
      const rendu = now - (E.getCurrentTime() - p0) * 1000;
      return { rendu_ms: Math.round(Math.max(0, rendu - t0)), constate_ms: Math.round(now - t0), sortie_ms: Math.round(((c.outputLatency || 0) + (c.baseLatency || 0)) * 1000), etat: c.state };
    }
    await new Promise(r => setTimeout(r, 2));
  }
  return { rendu_ms: null, etat: E.ctx ? E.ctx.state : null };
}"""


def close_welcome(page):
    for name in ("C'est parti", "Fermer", "Plus tard"):
        try:
            b = page.get_by_role("button", name=name, exact=True).locator("visible=true")
            if b.count(): b.first.click(timeout=1500); page.wait_for_timeout(300)
        except Exception:
            pass


def t_toucher(p, res, passes=3):
    import re as _re
    rows = []
    for k in range(passes):
        b = qalib.launch(p)
        log = Log(f"mw_toucher_{k}")
        ctx, page = new_page(b, "tel390", log)
        ctx.add_init_script(HELPERS)
        page.set_default_timeout(120000)
        page.goto(BASE, wait_until="domcontentloaded")
        page.locator("button:visible", has_text=_re.compile("Nouveau Projet")).first.wait_for(timeout=120000)
        page.wait_for_function("() => !document.getElementById('loading-screen')", timeout=30000)
        page.wait_for_timeout(300)
        page.locator("button:visible", has_text=_re.compile("Nouveau Projet")).first.tap()
        page.wait_for_timeout(800); close_welcome(page)
        page.wait_for_function("() => !!window.__novaEdit", timeout=60000)
        page.wait_for_timeout(2500); close_welcome(page)
        etat0 = page.evaluate("async () => { const { audioEngine: E } = await window.__novaAppModule('/engine/AudioEngine.ts'); return E.ctx ? E.ctx.state : 'aucun'; }")
        page.evaluate(TOUCH_PROBE)
        play = page.locator("button[aria-label=Lecture]:visible").first
        play.tap(); r1 = page.evaluate(TOUCH_WAIT, 0)
        page.wait_for_timeout(700)
        page.locator("button[aria-label=Pause]:visible").first.tap(); page.wait_for_timeout(700)
        p0 = page.evaluate("() => window.__novaEdit.getState().currentTime || 0")
        play.tap(); r2 = page.evaluate(TOUCH_WAIT, p0)
        page.wait_for_timeout(500)
        rows.append({"contexte_avant_1er_toucher": etat0, "premier": r1, "second": r2})
        b.close()
    vals1 = sorted(r["premier"]["rendu_ms"] for r in rows if r["premier"].get("rendu_ms") is not None)
    vals2 = sorted(r["second"]["rendu_ms"] for r in rows if r["second"].get("rendu_ms") is not None)
    out = {"passes": rows, "premier_toucher_median_ms": vals1[len(vals1) // 2] if vals1 else None, "premier_toucher_max_ms": vals1[-1] if vals1 else None,
           "toucher_suivant_median_ms": vals2[len(vals2) // 2] if vals2 else None}
    res["toucher"] = out
    print("toucher :", json.dumps(out, ensure_ascii=False), flush=True)
    ok("toucher : la lecture démarre au toucher (téléphone 390)", len(vals1) == passes and len(vals2) == passes, out)
    ok("toucher : 1er toucher sur Lecture → son rendu en moins de 50 ms (studio ouvert)", bool(vals1) and out["premier_toucher_median_ms"] < 50, out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="mesure")
    ap.add_argument("--tests", default="isolation,prise,latence,crash,demarrage")
    ap.add_argument("--derive-min", dest="derive_min", type=float, default=10)
    ap.add_argument("--charge-min", dest="charge_min", type=float, default=30)
    ap.add_argument("--fond-min", dest="fond_min", type=float, default=10)
    ap.add_argument("--n", type=int, default=12)
    ap.add_argument("--sans-calibrage", dest="sans_calibrage", action="store_true")
    a = ap.parse_args()
    tests = [t.strip() for t in a.tests.split(",") if t.strip()]
    res = {"banc": "moteur_web", "label": a.label, "url": BASE, "date": time.strftime("%Y-%m-%d %H:%M"), "tests": tests}
    path = OUT / f"moteur_web_{a.label}.json"
    with sync_playwright() as p:
        for t in tests:
            t0 = time.time()
            try:
                if t == "isolation": t_isolation(p, res)
                elif t == "prise": t_prise(p, res)
                elif t == "latence": t_latence(p, res, not a.sans_calibrage)
                elif t == "derive": t_derive(p, res, a.derive_min, not a.sans_calibrage)
                elif t == "crash": t_crash(p, res)
                elif t == "charge": t_charge(p, res, a.charge_min, a.fond_min)
                elif t == "demarrage": t_demarrage(p, res, a.n)
                elif t == "toucher": t_toucher(p, res)
                else: print("test inconnu :", t)
            except Exception as e:
                res.setdefault("exceptions", {})[t] = str(e)[:400]
                ok(f"{t} : exécuté sans exception", False, str(e)[:400])
            res.setdefault("durees_s", {})[t] = round(time.time() - t0, 1)
            path.write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    res["KO"] = KO
    path.write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print(f"{'KO' if KO else 'OK'} : {len(KO)} échec(s) -> {path}")
    return 1 if KO else 0


if __name__ == "__main__":
    sys.exit(main())
