"""Banc reproductible « grosse séance » : 96 pistes audio × 4 effets NOVA, bus, automation, 60 s de lecture.

Navigateur headless (aucune fenêtre), QA 100 % hors production (Supabase simulé par qalib / qa_hors_prod).

Séance générée (qa/grosses_seances.py pour les sons et les rôles, profil « réaliste ») :
  - N pistes audio (96 par défaut), chacune : EQ 12 bandes, compresseur (CLEAN / OPTO / FET / VCA),
    de-esser, et un envoi vers une reverb (piste retour) ;
  - 4 bus compressés (seuil automatisé), retour reverb, master (EQ 12 bandes + compresseur) ;
  - automation : volume sur les voix lead et doublages, panoramique sur les ad-libs ;
  - morceau de 64 s lu en boucle.

Mesures :
  - démarrage à froid : accueil prêt (« Charger Projet » visible), JS téléchargé, temps de script ;
    ouverture de la séance ;
  - pendant la lecture (60 s par défaut) :
      · charge du fil audio : trace Chromium « webaudio », temps CPU de
        RealtimeAudioDestinationHandler::Render / temps réel (moyenne, max par seconde, bloc p99 / max,
        blocs plus longs que le temps réel d'un bloc de 128) ;
      · sous-régimes (craquements) : AudioContext.playbackStats ;
      · interface : temps d'image (requestAnimationFrame) sur toute la lecture : pire image, p95,
        images > 50 ms, tâches longues ; fil principal en ms/s (CDP Performance.getMetrics) ;
      · CPU de tous les processus du navigateur (psutil) ;
      · pistes en veille ;
  - mémoire : tas JS, nœuds DOM, audio décodé, mémoire privée des processus du navigateur ;
  - profil du fil principal (8 s, fonctions les plus coûteuses) et répartition par type de nœud audio ;
  - images pendant l'édition (défilement, zoom, déplacement d'un clip), lecture en cours.

Usage :
  NOVA_URL=http://127.0.0.1:3513/ PYTHONIOENCODING=utf-8 python qa/banc_grosse_seance.py --label avant
  # A/B entrelacé (deux serveurs, ex. build de production avant / après) :
  python qa/banc_grosse_seance.py --ab avant=http://127.0.0.1:3513/,apres=http://127.0.0.1:3514/ --passes 2 --label ab
Sortie : $QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-perfseance)\\banc_grosse_seance_<label>.json

Code de sortie : 0 si la séance s'ouvre, joue et que toutes les mesures sont relevées sans erreur de page.
Les objectifs (fil audio < 85 %, 0 sous-régime, pire image ≤ 50 ms) sont rapportés, pas imposés :
la machine de test est partagée et le headless n'est pas l'appli.
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401
import argparse, json, os, sys, time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-perfseance")
from qalib import CHROME, FAKE_WAV, Log, new_page  # noqa: E402
import grosses_seances as G  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

try:
    import psutil
except Exception:  # pragma: no cover
    psutil = None

OUT = Path(os.environ["QA_OUT"])
OUT.mkdir(parents=True, exist_ok=True)
BANC_VERSION = 1


# --------------------------------------------------------------------------- séance
def make_project(path: Path, n: int):
    """Séance de banc : pistes à 4 effets (EQ, compresseur, de-esser, envoi reverb), bus, automation."""
    import zipfile
    G.make_bench_project(path, n, "realiste")
    with zipfile.ZipFile(path) as z:
        files = {k: z.read(k) for k in z.namelist()}
    st = json.loads(files["project.json"])
    for t in st["tracks"]:
        tid = t["id"]
        if t["type"] == "AUDIO":
            # 3e insert = de-esser partout (la base alterne avec une saturation).
            t["plugins"] = [p for p in t["plugins"] if p["type"] != "VOCALSATURATOR"]
            if not any(p["type"] == "DEESSER" for p in t["plugins"]):
                t["plugins"].append(G.plugin(f"{tid}-ds", "DEESSER", {"frequency": 7000, "threshold": -30, "reduction": 0.5, "detection": "RELATIVE",
                                                                    "relThreshold": -6, "mode": "BELL", "q": 1, "isEnabled": True}))
            role = G.ROLES[int(tid[1:]) % len(G.ROLES)]
            if role in ("lead", "double"):
                pts = [{"id": f"{tid}-v{k}", "time": float(k * 2), "value": 0.30 if k % 2 else 0.42} for k in range(33)]
                t["automationLanes"] = [{"id": f"{tid}-vol", "parameterName": "volume", "points": pts, "color": "#fbbf24",
                                         "isExpanded": False, "min": 0, "max": 1}]
            elif role == "adlib":
                pts = [{"id": f"{tid}-p{k}", "time": float(k * 4), "value": -0.6 if k % 2 else 0.6} for k in range(17)]
                t["automationLanes"] = [{"id": f"{tid}-pan", "parameterName": "pan", "points": pts, "color": "#a78bfa",
                                         "isExpanded": False, "min": -1, "max": 1}]
        elif tid.startswith("bus-"):
            b = tid.split("-")[1]
            pts = [{"id": f"{tid}-t{k}", "time": float(k * 8), "value": -18.0 if k % 2 else -14.0} for k in range(9)]
            t["automationLanes"] = [{"id": f"{tid}-thr", "parameterName": f"plugin::bus{b}-comp::threshold", "points": pts,
                                     "color": "#f472b6", "isExpanded": False, "min": -60, "max": 0}]
    st["id"] = f"proj-banc-grosse-seance-{n}"
    st["name"] = f"Banc grosse séance {n} pistes"
    files["project.json"] = json.dumps(st).encode("utf-8")
    with zipfile.ZipFile(path, "w") as z:
        for k, v in files.items():
            z.writestr(k, v)
    aud = [t for t in st["tracks"] if t["type"] == "AUDIO"]
    act = G.activity(st)
    return {"pistes_audio": len(aud), "effets_par_piste": 4, "inserts_total": sum(len(t["plugins"]) for t in st["tracks"]),
            "envois": sum(len(t["sends"]) for t in st["tracks"]), "bus": 4,
            "pistes_automatisees": sum(1 for t in st["tracks"] if t["automationLanes"]),
            "activite_moyenne_pct": act["moyenne"], "activite_max_pct": act["max"]}


# --------------------------------------------------------------------------- mesures
FRAMES_START = r"""() => { const P = window.__perf; P.frames = []; P.long = []; P.on = true; let last = performance.now();
  const tick = (t) => { if (!P.on) return; P.frames.push(t - last); last = t; requestAnimationFrame(tick); }; requestAnimationFrame(tick); return true; }"""
STARTUP_JS = r"""() => { const nav = performance.getEntriesByType('navigation')[0] || {};
  const res = performance.getEntriesByType('resource'); let js = 0, jsDec = 0, n = 0, css = 0;
  for (const r of res) { if (/\.m?js(\?|$)/.test(r.name) || r.initiatorType === 'script') { js += r.transferSize || 0; jsDec += r.decodedBodySize || 0; n++; }
    if (/\.css(\?|$)/.test(r.name)) css += r.decodedBodySize || 0; }
  return { dom_contenu_ms: Math.round(nav.domContentLoadedEventEnd || 0), chargement_ms: Math.round(nav.loadEventEnd || 0),
           js_fichiers: n, js_transfere_ko: Math.round(js / 1024), js_decode_ko: Math.round(jsDec / 1024), css_ko: Math.round(css / 1024) }; }"""


def proc_snapshot(bcdp):
    """CPU (s) et mémoire privée (Mo) des processus du navigateur (CDP SystemInfo + psutil)."""
    procs = bcdp.send("SystemInfo.getProcessInfo")["processInfo"]
    out = {"t": time.time(), "cpu": {}, "prive_mo": 0, "rendu_prive_mo": 0}
    for pr in procs:
        out["cpu"][pr["id"]] = (pr["type"], pr["cpuTime"])
        if psutil:
            try:
                mi = psutil.Process(pr["id"]).memory_full_info()
                priv = getattr(mi, "private", None) or getattr(mi, "uss", None) or mi.rss
                out["prive_mo"] += priv / 2**20
                if pr["type"] == "renderer": out["rendu_prive_mo"] += priv / 2**20
            except Exception:
                pass
    out["prive_mo"] = round(out["prive_mo"]); out["rendu_prive_mo"] = round(out["rendu_prive_mo"])
    return out


def proc_cpu(s0, s1):
    """% d'un cœur par type de processus entre deux relevés."""
    dt = max(0.001, s1["t"] - s0["t"])
    by = {}
    for pid, (typ, c1) in s1["cpu"].items():
        c0 = s0["cpu"].get(pid, (typ, 0))[1]
        by[typ] = by.get(typ, 0) + (c1 - c0) / dt * 100
    return {k: round(v, 1) for k, v in by.items()}


def thread_busy(events, secs):
    """Occupation par fil (ms/s) d'après la trace « toplevel » : fil principal, compositeur, audio."""
    names = {}
    for e in events:
        if e.get("ph") == "M" and e.get("name") == "thread_name":
            names[(e.get("pid"), e.get("tid"))] = (e.get("args") or {}).get("name", "")
    busy = {}
    for e in events:
        if e.get("ph") != "X" or e.get("name") not in ("ThreadControllerImpl::RunTask", "RunTask"):
            continue
        n = names.get((e.get("pid"), e.get("tid")), "")
        if not n: continue
        busy[n] = busy.get(n, 0) + (e.get("tdur") or e.get("dur") or 0)
    keep = {k: round(v / 1000 / max(0.001, secs), 1) for k, v in busy.items()
            if k in ("CrRendererMain", "Compositor", "VizCompositorThread", "AudioWorklet", "AudioOutputDevice") or "Audio" in k}
    return keep


def metrics(cdp):
    m = {x["name"]: x["value"] for x in cdp.send("Performance.getMetrics")["metrics"]}
    return m


def main_thread_rate(m0, m1, secs):
    d = lambda k: (m1.get(k, 0) - m0.get(k, 0)) * 1000 / max(0.001, secs)
    return {"taches_ms_s": round(d("TaskDuration"), 1), "script_ms_s": round(d("ScriptDuration"), 1),
            "mise_en_page_ms_s": round(d("LayoutDuration"), 1), "style_ms_s": round(d("RecalcStyleDuration"), 1),
            "mises_en_page_s": round((m1.get("LayoutCount", 0) - m0.get("LayoutCount", 0)) / max(0.001, secs), 1)}


def cpu_profile_top(cdp, seconds=8.0, top=20):
    cdp.send("Profiler.enable")
    cdp.send("Profiler.setSamplingInterval", {"interval": 250})
    cdp.send("Profiler.start")
    time.sleep(seconds)
    prof = cdp.send("Profiler.stop")["profile"]
    cdp.send("Profiler.disable")
    nodes = {n["id"]: n for n in prof["nodes"]}
    deltas = prof.get("timeDeltas") or []
    samples = prof.get("samples") or []
    self_us = {}
    for sid, dt in zip(samples, deltas[1:] + [0]):
        self_us[sid] = self_us.get(sid, 0) + max(0, dt)
    agg = {}
    tot = 0
    for nid, us in self_us.items():
        cf = nodes[nid]["callFrame"]
        name = cf.get("functionName") or "(anonyme)"
        url = (cf.get("url") or "").split("/")[-1].split("?")[0]
        key = f"{name} {url}:{cf.get('lineNumber', 0) + 1}:{cf.get('columnNumber', 0)}" if url else name
        agg[key] = agg.get(key, 0) + us
        if name not in ("(idle)", "(program)", "(garbage collector)") or True:
            tot += us
    busy = sum(v for k, v in agg.items() if not k.startswith("(idle)"))
    rows = sorted(((k, v) for k, v in agg.items() if not k.startswith("(idle)")), key=lambda kv: -kv[1])[:top]
    return {"duree_s": seconds, "occupe_ms_s": round(busy / 1000 / seconds, 1),
            "fonctions": [{"fonction": k, "ms_s": round(v / 1000 / seconds, 2)} for k, v in rows]}


def open_session(page, url, proj, n):
    page.goto(url, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=90000)
    t0 = time.time()
    page.get_by_text("Charger Projet").first.click(); page.wait_for_timeout(700)
    with page.expect_file_chooser(timeout=15000) as fc:
        page.get_by_text("Charger depuis l'ordinateur").first.click()
    fc.value.set_files(str(proj))
    k = 0
    for _ in range(180):
        page.wait_for_timeout(500)
        k = page.evaluate("() => window.DAW_CONTROL && window.DAW_CONTROL.diag ? window.DAW_CONTROL.diag().tracks : 0")
        if k >= n + 6:
            break
    secs = time.time() - t0
    for name in ("C'est parti", "Plus tard"):
        b = page.get_by_role("button", name=name, exact=True).locator("visible=true").first
        try:
            if b.is_visible(): b.click(); page.wait_for_timeout(300)
        except Exception:
            pass
    page.mouse.click(5, 300); page.keyboard.press("Escape")
    return k, secs


def launch(p):
    return p.chromium.launch(headless=True, executable_path=CHROME, args=[
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={FAKE_WAV}",
        "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows", "--enable-precise-memory-info"])


def startup(p, url):
    """Démarrage à froid (cache vide) : accueil prêt."""
    b = launch(p)
    try:
        ctx, page = new_page(b, "pc", Log("banc_demarrage"))
        from gel_pre_effet import prepare  # noqa
        prepare(page, None, desktop=False)
        cdp = ctx.new_cdp_session(page)
        cdp.send("Performance.enable")
        t0 = time.time()
        page.goto(url, wait_until="domcontentloaded")
        page.get_by_text("Charger Projet").first.wait_for(timeout=90000)
        ready = time.time() - t0
        m = metrics(cdp)
        r = {"accueil_pret_s": round(ready, 2), "script_ms": round(m.get("ScriptDuration", 0) * 1000), "taches_ms": round(m.get("TaskDuration", 0) * 1000),
             "tas_js_mo": round(m.get("JSHeapUsedSize", 0) / 2**20, 1), **page.evaluate(STARTUP_JS)}
        ctx.close()
        return r
    finally:
        b.close()


def plugin_windows(page, browser):
    """Fenêtres d'effets ouvertes pendant la lecture (EQ 12 bandes puis compresseur de la 2e piste) :
    fil principal (trace « toplevel ») et images, 6 s chacune."""
    out = {}
    for k, label in ((0, "eq"), (1, "compresseur")):
        chip = page.locator('[data-testid=inserts-t001] .fx-slot button[aria-label^="Ouvrir"]').nth(k)
        try:
            chip.click(timeout=5000)
        except Exception as e:  # noqa
            out[label] = {"erreur": f"fenêtre introuvable : {str(e)[:120]}"}
            continue
        page.wait_for_timeout(1500)
        page.evaluate(FRAMES_START)
        browser.start_tracing(page=page, categories=["toplevel"])
        t0 = time.time()
        page.wait_for_timeout(6000)
        ev = json.loads(browser.stop_tracing()); ev = ev["traceEvents"] if isinstance(ev, dict) else ev
        fr = page.evaluate(G.FRAMES_STOP)
        out[label] = {"fils_ms_s": thread_busy(ev, time.time() - t0), "images": fr}
        page.keyboard.press("Escape"); page.wait_for_timeout(600)
    return out


def run_session(p, url, proj, n, seconds, gestures=True, profile=True, label="banc", windows=True):
    log = Log(f"banc_{label}")
    b = launch(p)
    from gel_pre_effet import prepare  # noqa
    ctx, page = new_page(b, "pc", log)
    page.set_default_timeout(30000)
    prepare(page, None, desktop=False)
    ctx.add_init_script(G.CTX_HOOK)
    ctx.add_init_script(G.PERF_INIT)
    r = {"url": url, "pistes": n}
    bcdp = b.new_browser_cdp_session()
    try:
        k, secs = open_session(page, url, proj, n)
        r["ouverture_s"] = round(secs, 1)
        r["pistes_chargees"] = k
        cdp = ctx.new_cdp_session(page)
        cdp.send("Performance.enable")
        page.evaluate("() => window.DAW_CONTROL.seek(0)")
        # Repos (séance ouverte, rien ne joue) : ce qui tourne encore à l'arrêt.
        page.wait_for_timeout(5000)
        q0 = proc_snapshot(bcdp); mr0 = metrics(cdp)
        b.start_tracing(page=page, categories=["toplevel"])
        tq = time.time(); page.wait_for_timeout(8000)
        evq = json.loads(b.stop_tracing()); evq = evq["traceEvents"] if isinstance(evq, dict) else evq
        q1 = proc_snapshot(bcdp); mr1 = metrics(cdp)
        r["repos"] = {"cpu_processus_pct": proc_cpu(q0, q1), "fils_ms_s": thread_busy(evq, time.time() - tq),
                      "fil_principal": main_thread_rate(mr0, mr1, time.time() - tq)}
        r["repos"]["cpu_navigateur_pct"] = round(sum(r["repos"]["cpu_processus_pct"].values()), 1)
        G.ensure_playing(page)
        page.wait_for_timeout(6000)   # chauffe : worklets compilés, premières veilles
        G.ensure_playing(page)
        a = page.evaluate(G.PB)
        m0 = metrics(cdp); s0 = proc_snapshot(bcdp)
        page.evaluate(FRAMES_START)
        b.start_tracing(page=page, categories=["webaudio", "toplevel"])
        sl = []
        t0 = time.time(); t_end = t0 + seconds
        while time.time() < t_end:
            page.wait_for_timeout(2000)
            s = page.evaluate(G.SLEEP_STATS)
            if s: sl.append(s)
            G.ensure_playing(page)
        data = b.stop_tracing()
        el = time.time() - t0
        fr = page.evaluate(G.FRAMES_STOP)
        m1 = metrics(cdp); s1 = proc_snapshot(bcdp)
        z = page.evaluate(G.PB)
        ev = json.loads(data); ev = ev["traceEvents"] if isinstance(ev, dict) else ev
        r["charge_audio"] = G.trace_load(ev)
        if r["charge_audio"]:
            r["charge_audio"].pop("par_seconde_cpu_pct", None)
            # Coût réel du rendu : temps CPU du fil audio par seconde de son RENDUE (pas par seconde
            # d'horloge) : ne plafonne pas à 100 % quand le rendu ne suit plus, et ne compte pas le
            # temps où le fil est privé de processeur par d'autres programmes.
            rend = [e for e in ev if e.get("name") == "RealtimeAudioDestinationHandler::Render" and e.get("ph") == "X"]
            if a and z and z["ct"] > a["ct"]:
                r["charge_audio"]["cout_cpu_par_s_de_son_pct"] = round(sum(e.get("tdur", e.get("dur", 0)) for e in rend) / ((z["ct"] - a["ct"]) * 1e6) * 100, 1)
        if a and z:
            r["sous_regimes"] = {"evenements": z["ev"] - a["ev"], "duree_ms": round((z["s"] - a["s"]) * 1000, 1),
                                 "duree_mesure_s": round((z["t"] - a["t"]) / 1000, 1),
                                 "par_min": round((z["ev"] - a["ev"]) / max(0.001, (z["t"] - a["t"]) / 60000), 1),
                                 "temps_audio_avance_s": round(z["ct"] - a["ct"], 1)}
        r["interface_lecture"] = fr
        r["fil_principal_lecture"] = main_thread_rate(m0, m1, el)
        pc = proc_cpu(s0, s1)
        r["cpu_processus_pct"] = pc
        r["cpu_navigateur_pct"] = round(sum(pc.values()), 1)
        r["fils_ms_s"] = thread_busy(ev, el)
        if sl:
            r["veille"] = {"pistes_en_veille_moy": round(sum(x.get("asleep", 0) for x in sl) / len(sl), 1),
                           "pistes_en_veille_max": max(x.get("asleep", 0) for x in sl), "pistes_eligibles": sl[-1].get("eligible")}
        dom = cdp.send("Memory.getDOMCounters") if True else {}
        diag = page.evaluate("() => { const d = window.DAW_CONTROL.diag(); return { s: d.bufferSeconds, b: d.buffers, sr: window.__soakAudioCtx ? window.__soakAudioCtx.sampleRate : 44100 }; }")
        r["memoire"] = {"tas_js_mo": round(m1.get("JSHeapUsedSize", 0) / 2**20, 1), "tas_js_total_mo": round(m1.get("JSHeapTotalSize", 0) / 2**20, 1),
                        "noeuds_dom": dom.get("nodes"), "ecouteurs": dom.get("jsEventListeners"),
                        "audio_decode_mo": round(diag["s"] * diag["sr"] * 4 / 2**20, 1), "tampons_audio": diag["b"],
                        "navigateur_prive_mo": s1["prive_mo"], "rendu_prive_mo": s1["rendu_prive_mo"]}
        if profile:
            G.ensure_playing(page)
            r["profil_fil_principal"] = cpu_profile_top(cdp, 8.0)
            b.start_tracing(page=page, categories=["webaudio", "disabled-by-default-webaudio.audionode"])
            page.wait_for_timeout(1500)
            ev2 = json.loads(b.stop_tracing()); ev2 = ev2["traceEvents"] if isinstance(ev2, dict) else ev2
            r["repartition_noeuds"] = G.node_breakdown(ev2)
            r["noeuds_par_bloc"] = node_count(ev2)
        if windows:
            G.ensure_playing(page)
            r["fenetres_effets"] = plugin_windows(page, b)
        if gestures:
            G.ensure_playing(page)
            r["images_edition"] = G.edit_gestures(page)
    except Exception as e:  # noqa
        r["exception"] = f"{type(e).__name__}: {str(e)[:400]}"
    finally:
        r["erreurs_console"] = [x["text"][:200] for x in log.errors()][:8]
        try: ctx.close()
        except Exception: pass
        b.close()
    return r


def node_count(events):
    """Nombre moyen de nœuds traités par bloc audio (trace webaudio.audionode)."""
    rend = [e for e in events if e.get("name") == "RealtimeAudioDestinationHandler::Render" and e.get("ph") == "X"]
    proc = [e for e in events if e.get("ph") == "X" and (e.get("name") or "").endswith("::ProcessIfNecessary")]
    if not rend:
        return None
    return round(len(proc) / len(rend), 1)


def summary(r):
    c = r.get("charge_audio") or {}
    sr = r.get("sous_regimes") or {}
    ui = r.get("interface_lecture") or {}
    ed = r.get("images_edition") or {}
    pire_ed = max([v.get("pire_image_ms") or 0 for v in ed.values() if isinstance(v, dict)] or [0])
    mm = r.get("memoire") or {}
    fp = r.get("fil_principal_lecture") or {}
    th = r.get("fils_ms_s") or {}
    return {"cout_audio_pct": c.get("cout_cpu_par_s_de_son_pct"), "fil_audio_moy_pct": c.get("charge_cpu_moy_pct"), "fil_audio_max_pct": c.get("charge_cpu_max_pct"),
            "bloc_p99_us": c.get("bloc_p99_us"), "blocs_hors_temps_reel": c.get("blocs_plus_longs_que_temps_reel"),
            "sous_regimes": sr.get("evenements"), "sous_regimes_ms": sr.get("duree_ms"),
            "pire_image_lecture_ms": ui.get("pire_image_ms"), "images_sup_50ms_lecture": ui.get("images_sup_50ms"), "p95_image_ms": ui.get("p95_ms"),
            "pire_image_edition_ms": pire_ed, "fil_principal_ms_s": th.get("CrRendererMain", fp.get("taches_ms_s")),
            "script_ms_s": fp.get("script_ms_s"), "compositeur_ms_s": th.get("VizCompositorThread"), "cpu_navigateur_pct": r.get("cpu_navigateur_pct"),
            "tas_js_mo": mm.get("tas_js_mo"), "navigateur_prive_mo": mm.get("navigateur_prive_mo"), "ouverture_s": r.get("ouverture_s"),
            "veille_moy": (r.get("veille") or {}).get("pistes_en_veille_moy"),
            "repos_cpu_navigateur_pct": (r.get("repos") or {}).get("cpu_navigateur_pct"),
            "repos_fil_audio_ms_s": ((r.get("repos") or {}).get("fils_ms_s") or {}).get("Realtime AudioWorklet thread"),
            "repos_fil_principal_ms_s": ((r.get("repos") or {}).get("fils_ms_s") or {}).get("CrRendererMain"),
            "fil_principal_fenetre_eq_ms_s": (((r.get("fenetres_effets") or {}).get("eq") or {}).get("fils_ms_s") or {}).get("CrRendererMain"),
            "fil_principal_fenetre_comp_ms_s": (((r.get("fenetres_effets") or {}).get("compresseur") or {}).get("fils_ms_s") or {}).get("CrRendererMain")}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pistes", type=int, default=96)
    ap.add_argument("--secondes", type=int, default=60)
    ap.add_argument("--label", default=os.environ.get("QA_TAG") or "mesure")
    ap.add_argument("--ab", default="", help="nom=url,nom=url : passes entrelacées sur plusieurs serveurs")
    ap.add_argument("--passes", type=int, default=1)
    ap.add_argument("--sans-gestes", dest="sans_gestes", action="store_true")
    ap.add_argument("--sans-profil", dest="sans_profil", action="store_true")
    ap.add_argument("--sans-demarrage", dest="sans_demarrage", action="store_true")
    ap.add_argument("--sans-fenetres", dest="sans_fenetres", action="store_true")
    a = ap.parse_args()
    url0 = os.environ.get("NOVA_URL", "http://127.0.0.1:3503/")
    servers = [tuple(x.split("=", 1)) for x in a.ab.split(",") if "=" in x] or [("nova", url0)]
    proj = OUT / f"banc_grosse_seance_{a.pistes}_v{BANC_VERSION}.novaproj.zip"
    info = make_project(proj, a.pistes)
    res = {"banc": "grosse_seance", "version": BANC_VERSION, "label": a.label, "date": time.strftime("%Y-%m-%d %H:%M"),
           "machine": "PC de Romain (RTX 5090 Laptop, 64 Go), Chromium headless (pas Nova Studio), machine partagée",
           "seance": info, "secondes": a.secondes, "passes": []}
    path = OUT / f"banc_grosse_seance_{a.label}.json"
    ok = True
    with sync_playwright() as p:
        for k in range(a.passes):
            for name, url in servers:
                one = {"serveur": name, "passe": k + 1}
                if not a.sans_demarrage:
                    try: one["demarrage"] = startup(p, url)
                    except Exception as e: one["demarrage"] = {"exception": str(e)[:300]}; ok = False
                r = run_session(p, url, proj, a.pistes, a.secondes, gestures=not a.sans_gestes, profile=not a.sans_profil, label=f"{name}_{k + 1}",
                                windows=not a.sans_fenetres)
                one.update(r)
                one["resume"] = summary(r)
                res["passes"].append(one)
                sr = r.get("sous_regimes") or {}
                good = (not r.get("exception") and r.get("pistes_chargees", 0) >= a.pistes + 6 and r.get("charge_audio")
                        and (sr.get("temps_audio_avance_s") or 0) > a.secondes * 0.3 and (r.get("interface_lecture") or {}).get("images"))
                if not good:
                    ok = False
                s = one["resume"]
                print(f"{'OK ' if good else 'KO '} {name} passe {k + 1} : coût audio {s['cout_audio_pct']} % · fil audio moy {s['fil_audio_moy_pct']} % / max {s['fil_audio_max_pct']} % · "
                      f"bloc p99 {s['bloc_p99_us']} µs · sous-régimes {s['sous_regimes']} ({s['sous_regimes_ms']} ms) · "
                      f"pire image lecture {s['pire_image_lecture_ms']} ms ({s['images_sup_50ms_lecture']} > 50 ms) · édition {s['pire_image_edition_ms']} ms · "
                      f"fil principal {s['fil_principal_ms_s']} ms/s · CPU navigateur {s['cpu_navigateur_pct']} % · tas JS {s['tas_js_mo']} Mo · "
                      f"mémoire navigateur {s['navigateur_prive_mo']} Mo · ouverture {s['ouverture_s']} s · veille {s['veille_moy']}"
                      f"{' · ' + r['exception'] if r.get('exception') else ''}", flush=True)
                if one.get("demarrage"):
                    print("   démarrage :", json.dumps(one["demarrage"], ensure_ascii=False), flush=True)
                if r.get("erreurs_console"):
                    print("   erreurs console :", r["erreurs_console"][:3], flush=True)
                path.write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    # Médianes par serveur
    import statistics as S
    med = {}
    for name, _ in servers:
        rows = [x["resume"] for x in res["passes"] if x["serveur"] == name]
        dem = [x.get("demarrage") or {} for x in res["passes"] if x["serveur"] == name]
        m = {}
        for key in rows[0].keys():
            vals = [r[key] for r in rows if isinstance(r.get(key), (int, float))]
            m[key] = round(S.median(vals), 1) if vals else None
        for key in ("accueil_pret_s", "script_ms", "js_transfere_ko", "tas_js_mo"):
            vals = [d[key] for d in dem if isinstance(d.get(key), (int, float))]
            m["demarrage_" + key] = round(S.median(vals), 2) if vals else None
        med[name] = m
    res["medianes"] = med
    res["objectifs"] = {name: {"fil_audio_sous_85_pct": (m["fil_audio_moy_pct"] or 999) < 85, "zero_sous_regime": m["sous_regimes"] == 0,
                               "pire_image_50ms": (m["pire_image_lecture_ms"] or 999) <= 50} for name, m in med.items()}
    res["ok"] = ok
    path.write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print("médianes :", json.dumps(med, ensure_ascii=False))
    print("objectifs :", json.dumps(res["objectifs"], ensure_ascii=False))
    print("OK" if ok else "ÉCHEC", "->", path)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
