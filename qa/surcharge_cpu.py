"""Preuve headless : surcharge processeur → compteur CPU, alerte avec solutions, mode sécurité.

Session lourde de l'endurance (40 pistes, 3 effets par piste) lue en boucle :
  1. sans mode sécurité : le compteur passe en « surcharge », l'alerte apparaît avec
     ses boutons (Geler « … », Tampon plus grand, Mode sécurité) ; sous-régimes / min mesurés ;
  2. mode sécurité activé PENDANT une prise : aucun gel automatique tant qu'on enregistre ;
  3. prise arrêtée, lecture : le mode sécurité gèle les pistes les plus lourdes (une par
     épisode, 4 au plus) ; sous-régimes / min mesurés après les gels.

Usage : NOVA_URL=http://127.0.0.1:3442/ PYTHONIOENCODING=utf-8 python qa/surcharge_cpu.py
Sortie : D:\\1 WORK\\CONTENU\\nova-stabilite\\surcharge_cpu.json + captures.

Grosses séances (chantier 13, « 96 pistes × 4 effets ») : --paliers 32,64,96,128
  Session de banc par palier (qa/grosses_seances.py) : N pistes audio × (EQ 12 bandes,
  compresseur, de-esser ou saturation, envoi reverb), profil « realiste » et/ou « dense ».
  Mesures : charge du fil audio (trace Chromium), sous-régimes (playbackStats), pistes en
  veille, images pendant le défilement / zoom / déplacement d'un clip, coût de chaque effet.
  NOVA_URL=http://127.0.0.1:3435/ PYTHONIOENCODING=utf-8 python qa/surcharge_cpu.py --paliers 32,64,96,128 \\
      --profils realiste,dense --secondes 30 --secondes-96 60 --label avant
  Sortie : D:\\1 WORK\\CONTENU\\nova-128-pistes\\paliers_<label>.json
"""
import json, os, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-stabilite")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3442/")
from qalib import OUT, CHROME, FAKE_WAV, Log, new_page, shot  # noqa: E402
from gel_pre_effet import prepare  # noqa: E402
from endurance import INIT, CTX_HOOK, open_project, make_project  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

PB = """() => { const c = window.__soakAudioCtx; if (!c || !c.playbackStats) return null; const p = c.playbackStats;
  return { ev: p.underrunEvents, s: p.underrunDuration, t: performance.now() }; }"""
METER = """() => { const b = document.querySelector('[data-testid=dsp-meter]'); return b ? { level: b.dataset.level, label: b.getAttribute('aria-label') } : null; }"""
FROZEN = "() => window.DAW_CONTROL.getState().tracks.filter(t => t.isFrozen).map(t => t.name)"


def rate(page, seconds):
    """Sous-régimes par minute mesurés sur `seconds` secondes de lecture."""
    a = page.evaluate(PB)
    page.wait_for_timeout(int(seconds * 1000))
    b = page.evaluate(PB)
    if not a or not b:
        return None
    mins = (b["t"] - a["t"]) / 60000
    return {"par_min": round((b["ev"] - a["ev"]) / mins, 1), "part_du_temps_en_sous_regime_pct": round((b["s"] - a["s"]) / (mins * 60) * 100, 2)}


def ensure_playing(page):
    if not page.evaluate("() => { const s = window.DAW_CONTROL.getState(); return s.isPlaying || s.isRecording; }"):
        page.evaluate("() => window.DAW_CONTROL.togglePlay()")
        page.wait_for_timeout(500)


def run():
    OUT.mkdir(parents=True, exist_ok=True)
    proj = OUT / "endurance_session_40_pistes.novaproj.zip"
    if not proj.exists():
        make_project(proj)
    res = {"name": "surcharge_cpu", "ok": True, "verifs": [], "mesures": {}}

    def check(label, cond, detail=""):
        res["verifs"].append({"verif": label, "ok": bool(cond), "detail": detail})
        if not cond: res["ok"] = False
        print(("OK  " if cond else "ÉCHEC ") + label, detail, flush=True)

    log = Log("surcharge_cpu")
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, executable_path=CHROME, args=[
            "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={FAKE_WAV}",
            "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"])
        ctx, page = new_page(b, "pc", log)
        page.set_default_timeout(20000)
        prepare(page, None, desktop=False)
        ctx.add_init_script(INIT)
        ctx.add_init_script(CTX_HOOK)
        ctx.add_init_script("try { localStorage.setItem('nova_safe_mode', '0'); localStorage.removeItem('nova_audio_latency'); } catch (e) {}")
        try:
            open_project(page, proj)
            page.evaluate("""() => { window.__safeFreezes = []; window.addEventListener('nova:safe-freeze', e => window.__safeFreezes.push({ ...e.detail, rec: window.DAW_CONTROL.getState().isRecording, t: performance.now() })); }""")
            page.evaluate("() => window.DAW_CONTROL.seek(0)")
            ensure_playing(page)

            # 1. Sans mode sécurité : compteur en surcharge + alerte avec solutions.
            seen_overload = False
            for _ in range(60):
                page.wait_for_timeout(1000)
                m = page.evaluate(METER)
                if m and m["level"] == "surcharge":
                    seen_overload = True
                if page.locator("[data-testid=dsp-alert]").count():
                    break
            check("compteur CPU en « surcharge »", seen_overload, json.dumps(page.evaluate(METER), ensure_ascii=False))
            alert = page.locator("[data-testid=dsp-alert]")
            check("alerte claire affichée", alert.count() > 0, alert.first.inner_text()[:300] if alert.count() else "")
            if alert.count():
                shot(page, "surcharge_cpu_01_alerte")
                btns = [x.strip() for x in alert.first.locator("button").all_inner_texts()]
                res["boutons_alerte"] = btns
                check("l'alerte propose de geler la piste la plus lourde", any(x.startswith("Geler") for x in btns), str(btns))
                check("l'alerte propose un tampon plus grand", "Tampon plus grand" in btns, str(btns))
                alert.first.get_by_role("button", name="Ignorer").click()
            ensure_playing(page)
            res["mesures"]["avant_mode_securite"] = rate(page, 60)
            print("avant :", res["mesures"]["avant_mode_securite"], flush=True)

            # Panneau du compteur (pistes lourdes, mode sécurité, tampon).
            page.locator("[data-testid=dsp-meter]").click()
            page.wait_for_timeout(600)
            panel = page.locator("[data-testid=dsp-panel]")
            check("panneau du compteur ouvert", panel.count() > 0)
            res["panneau"] = panel.first.inner_text()[:600] if panel.count() else None
            shot(page, "surcharge_cpu_02_panneau")

            # 2. Mode sécurité activé pendant une prise : aucun gel tant qu'on enregistre.
            page.evaluate("() => { const s = window.DAW_CONTROL.getState(); const t = s.tracks.find(x => x.id === 'rec'); window.DAW_CONTROL.updateTrack({ ...t, isTrackArmed: true }); }")
            page.wait_for_timeout(1500)
            page.locator("[data-testid=safe-mode]").check()
            page.keyboard.press("Escape"); page.mouse.click(5, 5)
            page.evaluate("() => window.DAW_CONTROL.toggleRecord()")
            page.wait_for_timeout(1500)
            recording = page.evaluate("() => window.DAW_CONTROL.getState().isRecording")
            check("prise lancée", recording)
            page.wait_for_timeout(25000)
            during = page.evaluate("() => window.__safeFreezes.length")
            check("aucun gel automatique pendant la prise (25 s de surcharge)", during == 0, f"{during} gel(s)")
            page.evaluate("() => window.DAW_CONTROL.toggleRecord()")
            page.wait_for_timeout(1500)
            page.evaluate("() => { const s = window.DAW_CONTROL.getState(); const t = s.tracks.find(x => x.id === 'rec'); if (t.isTrackArmed) window.DAW_CONTROL.updateTrack({ ...t, isTrackArmed: false }); }")
            ensure_playing(page)

            # 3. Lecture : gels automatiques (une piste par épisode, 4 au plus).
            t_end = time.time() + 150
            while time.time() < t_end and page.evaluate("() => window.__safeFreezes.length") < 4:
                page.wait_for_timeout(2000)
                ensure_playing(page)
            page.wait_for_timeout(8000)  # rendus terminés
            freezes = page.evaluate("() => window.__safeFreezes")
            res["gels_automatiques"] = freezes
            res["pistes_gelees"] = page.evaluate(FROZEN)
            check("gels automatiques en surcharge", len(freezes) >= 1, ", ".join(f["name"] for f in freezes))
            check("jamais pendant une prise", all(not f["rec"] for f in freezes))
            check("4 gels au plus par séance", len(freezes) <= 4, str(len(freezes)))
            shot(page, "surcharge_cpu_03_apres_gels")
            ensure_playing(page)
            res["mesures"]["apres_mode_securite"] = rate(page, 60)
            print("après :", res["mesures"]["apres_mode_securite"], flush=True)
            av, ap = res["mesures"]["avant_mode_securite"], res["mesures"]["apres_mode_securite"]
            if av and ap:
                check("les sous-régimes par minute baissent après les gels", ap["par_min"] < av["par_min"],
                      f"{av['par_min']} → {ap['par_min']} / min")
            res["compteur_fin"] = page.evaluate(METER)
        except Exception as e:  # noqa
            res["ok"] = False
            res["exception"] = f"{type(e).__name__}: {str(e)[:500]}"
            try: shot(page, "surcharge_cpu_FAIL")
            except Exception: pass
        finally:
            res["erreurs_console"] = [e["text"][:200] for e in log.errors()][:20]
            (OUT / "surcharge_cpu.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
            ctx.close(); b.close()
    print(json.dumps({k: res[k] for k in ("ok", "mesures")}, ensure_ascii=False))
    return res


def run_paliers(args):
    import grosses_seances as G
    out_dir = Path(os.environ.get("QA_OUT_PALIERS", r"D:\1 WORK\CONTENU\nova-128-pistes"))
    out_dir.mkdir(parents=True, exist_ok=True)
    paliers = [int(x) for x in args.paliers.split(",") if x]
    profils = [x for x in args.profils.split(",") if x]
    res = {"label": args.label, "url": G.BASE, "machine": "PC de Romain (RTX 5090 Laptop, 64 Go), Chromium headless (pas Nova Studio)",
           "date": time.strftime("%Y-%m-%d %H:%M"), "paliers": [], "couts_effets": None}
    path = out_dir / f"paliers_{args.label}.json"
    with sync_playwright() as p:
        if not args.sans_couts:
            res["couts_effets"] = G.offline_costs(p)
            print("coûts des effets (ms de calcul / s de son / instance) :", json.dumps(res["couts_effets"], ensure_ascii=False), flush=True)
        for prof in profils:
            for n in paliers:
                proj = out_dir / f"banc_{n}_{prof}.novaproj.zip"
                info = G.make_bench_project(proj, n, prof)
                secs = args.secondes_96 if n == 96 else args.secondes
                r = G.run_palier(p, proj, n, secs, trace_nodes=(n == 96 and not args.sans_noeuds),
                                 gestures=(prof == "realiste" and not args.sans_images), log_name=f"palier_{n}_{prof}")
                r.update({"profil": prof, "activite": info})
                res["paliers"].append(r)
                c = r.get("charge") or {}
                sr = r.get("sous_regimes") or {}
                im = {k: v.get("pire_image_ms") for k, v in (r.get("images_edition") or {}).items() if isinstance(v, dict)}
                print(f"{prof:9s} {n:4d} pistes : fil audio moy {c.get('charge_cpu_moy_pct')} % / max {c.get('charge_cpu_max_pct')} %"
                      f" | sous-régimes {sr.get('evenements')} en {sr.get('duree_mesure_s')} s | veille {r.get('veille')}"
                      f" | pire image {im} {r.get('exception', '')}", flush=True)
                path.write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print("écrit :", path)
    return res


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--paliers", default="")
    ap.add_argument("--profils", default="realiste,dense")
    ap.add_argument("--secondes", type=int, default=30)
    ap.add_argument("--secondes-96", dest="secondes_96", type=int, default=60)
    ap.add_argument("--label", default="mesure")
    ap.add_argument("--sans-couts", dest="sans_couts", action="store_true")
    ap.add_argument("--sans-noeuds", dest="sans_noeuds", action="store_true")
    ap.add_argument("--sans-images", dest="sans_images", action="store_true")
    a = ap.parse_args()
    if a.paliers:
        run_paliers(a)
    else:
        run()
