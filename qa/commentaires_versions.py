"""Chantier 11 · Commentaires horodatés + versions validées (le « Frame.io de la musique »).

Deux navigateurs headless : l'INGÉ (Max, PC 1600 × 900) ouvre sa séance et la met en ligne ;
l'ARTISTE (Nina, téléphone 390 × 844, au doigt) la rejoint par le lien d'invitation, en mode
« artiste invité » (components/GuestStudio). On vérifie :

  A. Nina pose « 1:12 le "s" siffle » depuis son téléphone → chez Max en ≤ 1 s (délai mesuré dans
     les pages : création chez Nina → réception chez Max), à 72,000 s exactement, puce sur la règle
     à la bonne abscisse (au pixel près) ;
  B. Max clique la puce : le commentaire s'ouvre et la lecture va à 1:12 ;
  C. Max répond, puis résout ; Nina voit la réponse et la résolution, puis ARCHIVE (au doigt) :
     chez Max le commentaire passe aux archives et sa puce disparaît ;
  D. coupure réseau chez Nina : elle commente hors ligne, rien ne part ; au retour, Max le reçoit ;
  E. saisie simultanée, réseau coupé des DEUX côtés : chacun commente, répond, résout le même
     commentaire ; au retour, les deux finissent avec le MÊME état (empreinte complète identique) ;
  F. versions : Max « envoie la version 1 » (bounce du mix + référence du projet) ; Nina l'écoute
     (le son arrive), demande des retouches avec un commentaire ; Max envoie la version 2 ; Nina la
     valide → « Version 2 validée par Nina le JJ/MM/AAAA à HH:MM » dans l'historique de Max ;
  G. persistance : Max rouvre sa page, Nina aussi → commentaires et versions identiques ; la version
     envoyée est aussi un instantané nommé dans l'historique de l'appareil de Max.

100 % hors production : qalib → qa_hors_prod (Supabase simulé, prod bloquée, code 3 sinon), serveur
NOVA et Realtime simulés (qa/collab_sim.py), comptes simulés, aucun pont réel (port 8765 refusé).

Usage : NOVA_URL=http://127.0.0.1:3432/ RUN=1 PYTHONIOENCODING=utf-8 python qa/commentaires_versions.py
Sorties : D:\\1 WORK\\CONTENU\\nova-commentaires\\run_<RUN>\\ (captures + resultat.json)
"""
import datetime, io, json, os, re, sys, time, wave, zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
RUN = os.environ.get("RUN", "1")
ROOT = Path(os.environ.get("QA_ROOT", r"D:\1 WORK\CONTENU\nova-commentaires"))
os.environ["QA_OUT"] = str(ROOT / f"run_{RUN}")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3432/")
import qalib  # noqa: E402  (qa_hors_prod : Supabase simulé, production bloquée)
from qalib import BASE, Log, new_page, save_log, sync_playwright  # noqa: E402
from collab_artiste import launch_rtc, beat_wav  # noqa: E402
from collab_sim import FakeNovaCloud, FakeRealtime, connect  # noqa: E402
from feat_lib import BASE_T, REC_INIT, dismiss, wait_for, collab, open_panel, close_panel  # noqa: E402
from gel_pre_effet import prepare, voice_wav, open_project_file  # noqa: E402

OUT = qalib.OUT
MAX_UID, NINA_UID = "22222222-2222-4222-8222-222222222222", "44444444-4444-4444-8444-444444444444"
PAGES = {}
RES = {"run": RUN, "url": BASE, "etapes": {}, "mesures": {}, "ok": True, "erreurs": []}


def check(label, ok, detail=None):
    RES["etapes"][label] = {"ok": bool(ok), **({"detail": detail} if detail is not None else {})}
    if not ok:
        RES["ok"] = False
    print(("OK   " if ok else "ÉCHEC") + f" {label}" + (f" — {json.dumps(detail, ensure_ascii=False)[:300]}" if detail is not None else ""), flush=True)


def shot(page, name):
    try:
        page.screenshot(path=str(OUT / f"{name}.png"))
    except Exception:
        pass


def project(path: Path, seconds=80):
    """La séance de Max : un beat de 80 s, la « Voix lead » (3 phrases), un bus voix."""
    clips = [{"id": f"p{i+1}", "name": f"Phrase {i+1}", "start": a, "duration": b - a, "offset": a, "fadeIn": 0, "fadeOut": 0,
              "color": "#22d3ee", "type": "AUDIO", "audioRef": "audio/voix.wav", "gain": 1} for i, (a, b) in enumerate([(1.0, 3.0), (4.0, 6.0), (7.0, 9.0)])]
    tracks = [
        {**BASE_T, "id": "instrumental", "name": "Beat", "type": "AUDIO", "color": "#f59e0b", "volume": 0.8, "outputTrackId": "master", "sends": [], "plugins": [],
         "clips": [{"id": "beat1", "name": "Beat", "start": 0, "duration": seconds, "offset": 0, "fadeIn": 0, "fadeOut": 0, "color": "#f59e0b", "type": "AUDIO", "audioRef": "audio/beat.wav", "gain": 1}]},
        {**BASE_T, "id": "voix", "name": "Voix lead", "type": "AUDIO", "color": "#22d3ee", "volume": 1.0, "outputTrackId": "bus-voix", "sends": [], "plugins": [], "clips": clips},
        {**BASE_T, "id": "bus-voix", "name": "Bus voix", "type": "BUS", "color": "#a78bfa", "volume": 1.0, "outputTrackId": "master", "sends": [], "plugins": [], "clips": []},
    ]
    state = {
        "id": "proj-seance-retours", "name": "Séance retours", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": "voix", "currentView": "ARRANGEMENT",
        "projectPhase": "MIXING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0, "recStartTime": None,
        "isDelayCompEnabled": True, "lyrics": "J'arrive au studio\nLe refrain revient",
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/voix.wav", voice_wav())
        z.writestr("audio/beat.wav", beat_wav(seconds))


def cm(page, expr):
    return page.evaluate(f"() => {{ const c = window.__novaComments; return c ? ({expr}) : null; }}")


def comments(page):
    return cm(page, "c.list()") or []


def find(page, text):
    return next((c for c in comments(page) if text in c["text"]), None)


def tap(page, loc):
    loc = loc.first
    loc.scroll_into_view_if_needed(timeout=8000)
    try:
        loc.tap(timeout=6000)
    except Exception:
        loc.click(timeout=6000)


def offline(page, cloud, rt, tag, on):
    if on:
        cloud.down.add(tag); rt.blocked.add(tag); rt.drop(tag)
        page.context.set_offline(True)
        page.evaluate("() => window.dispatchEvent(new Event('offline'))")
    else:
        cloud.down.discard(tag); rt.blocked.discard(tag)
        page.context.set_offline(False)
        page.evaluate("() => window.dispatchEvent(new Event('online'))")


def show_time(E, t):
    """Fait défiler la timeline de Max pour que l'instant t soit visible (la règle porte les puces)."""
    E.evaluate("""(t) => { const ov = document.querySelector('[data-testid=ruler-overlay]'); if (!ov) return;
        const sc = ov.parentElement.querySelector('.custom-scroll.overflow-auto'); const pin = document.querySelector('[data-testid=comment-pin]');
        const z = pin ? +pin.dataset.zoom : 40; if (sc) { sc.scrollLeft = Math.max(0, t * z - 300); sc.dispatchEvent(new Event('scroll')); } }""", t)
    E.wait_for_timeout(400)


def pin_geometry(E, cid):
    return E.evaluate("""(id) => { const p = document.querySelector(`[data-testid=comment-pin][data-id="${id}"]`); const ov = document.querySelector('[data-testid=ruler-overlay]');
        if (!p || !ov) return null; const sc = ov.parentElement.querySelector('.custom-scroll.overflow-auto');
        const b = p.getBoundingClientRect(), o = ov.getBoundingClientRect();
        return { t: +p.dataset.t, zoom: +p.dataset.zoom, x: +p.dataset.x, scrollLeft: sc ? sc.scrollLeft : null, centre: b.left + b.width / 2 - o.left, status: p.dataset.status }; }""", cid)


def run():
    cloud = FakeNovaCloud(per_device=True, codes=True, strict=True)
    rt = FakeRealtime()
    src = OUT / "00_seance_retours.novaproj.zip"
    project(src)
    today = datetime.date.today().strftime("%d/%m/%Y")
    with sync_playwright() as p:
        b = launch_rtc(p)
        lE, lT = Log("inge"), Log("artiste")
        cE, E = new_page(b, "pc", lE)
        E.add_init_script(REC_INIT)
        prepare(E, None, desktop=False)
        connect(E, cloud, rt, "E", MAX_UID, "max@test.local")
        cT, T = new_page(b, "tel390", lT)
        T.add_init_script(REC_INIT)
        prepare(T, None, desktop=False)
        connect(T, cloud, rt, "T", NINA_UID, "nina@test.local")
        PAGES.update(E=E, T=T, lE=lE, lT=lT)
        try:

            # ------------------------------------------------ préparation : Max ouvre sa séance, en ligne, hôte
            open_project_file(E, src, {}, "E0")
            dismiss(E); open_panel(E)
            E.get_by_test_id("collab-role").select_option("engineer")
            E.get_by_placeholder("Ton nom (affiché aux autres)").fill("Max")
            E.get_by_role("button", name="Démarrer la collaboration en direct").click()
            wait_for(E, lambda: collab(E, "c.role()") == "engineer", 120, what="séance de Max en ligne")
            E.wait_for_timeout(1500)
            sid = next(k for k, v in cloud.sessions.items() if v["manifest"])
            secret = cloud.sessions[sid]["secret"]
            link = collab(E, "c.invite ? c.invite() : null") or f"{BASE}?session={sid}.{secret}&invite=1"
            close_panel(E)

            T.goto(link, wait_until="domcontentloaded", timeout=180000)
            wait_for(T, lambda: T.get_by_test_id("collab-arrival").count() > 0, 120, step=200, what="carte d'arrivée")
            T.wait_for_timeout(800); dismiss(T)
            art = T.get_by_test_id("arrival-role-artist")
            if art.count() and not art.locator("input:checked").count() and not T.locator("[data-testid=arrival-role-artist][data-quick='1']").count():
                tap(T, art)
            name = T.get_by_label("Ton nom", exact=True)
            if name.count():
                name.fill("Nina")
            tap(T, T.get_by_test_id("arrival-join"))
            wait_for(T, lambda: collab(T, "c.role()") == "artist", 90, step=200, what="Nina reliée")
            wait_for(T, lambda: T.get_by_test_id("guest-studio").count() > 0 and T.get_by_test_id("reviews-inline").count() > 0, 30, step=200, what="écran de l'artiste avec « Retours »")
            T.wait_for_timeout(1500); dismiss(T)
            shot(T, "T0_ecran_artiste")
            R = lambda: T.get_by_test_id("reviews-inline")  # noqa: E731

            # ------------------------------------------------ A. « 1:12 le s siffle » depuis le téléphone
            tap(T, T.get_by_test_id("guest-review-jump"))
            T.wait_for_timeout(500)
            R().get_by_test_id("comment-time").fill("1:12")
            R().get_by_test_id("comment-text").fill('le « s » siffle')
            shot(T, "T1a_commentaire_en_cours")
            t_click = time.time()
            tap(T, R().get_by_test_id("comment-add"))
            seen = None
            while time.time() - t_click < 10:
                c = find(E, "siffle")
                if c:
                    seen = c
                    break
                E.wait_for_timeout(20)
            py_ms = round((time.time() - t_click) * 1000)
            c1 = seen
            tt, te = cm(T, "c.times()") or {}, cm(E, "c.times()") or {}
            delay = None
            if c1 and c1["id"] in te and c1["id"] in tt:
                delay = te[c1["id"]].get("receivedAt", 0) - tt[c1["id"]]["createdAt"]
            RES["mesures"]["commentaire_telephone_vers_inge_ms"] = delay
            RES["mesures"]["commentaire_telephone_vers_inge_ms_vu_par_le_script"] = py_ms
            check("A1 commentaire du téléphone reçu chez l'ingé en ≤ 1 s", c1 is not None and delay is not None and delay <= 1000, {"delai_ms": delay, "vu_par_le_script_ms": py_ms})
            check("A2 position exacte : 72,000 s (1:12), un instant", c1 is not None and c1["t"] == 72 and c1["end"] is None and c1["by"] == "Nina", c1)
            shot(T, "T1b_commentaire_pose")
            cid = c1["id"] if c1 else ""
            show_time(E, 72)
            wait_for(E, lambda: pin_geometry(E, cid) is not None, 10, step=100, what="puce sur la règle")
            g = pin_geometry(E, cid)
            expected = 72 * g["zoom"] - g["scrollLeft"]
            check("A3 puce sur la règle temporelle au pixel près (72 s × zoom − défilement)", abs(g["x"] - expected) < 0.51 and abs(g["centre"] - expected) < 1.01, {**g, "attendu": round(expected, 2)})
            shot(E, "E1_puce_sur_la_regle")

            # ------------------------------------------------ B. Max clique la puce : commentaire ouvert, lecture à 1:12
            E.locator(f"[data-testid=comment-pin][data-id='{cid}']").click()
            wait_for(E, lambda: E.get_by_test_id("reviews-panel").count() > 0, 10, step=100, what="panneau Retours")
            E.wait_for_timeout(500)
            pos = collab(E, "c.engineTime().pos")
            focused = E.locator(f"[data-testid=reviews-panel] [data-testid=comment-item][data-id='{cid}']").count() > 0
            check("B1 clic sur la puce : commentaire ouvert et lecture amenée à 1:12", focused and pos is not None and abs(pos - 72) < 0.05, {"position_s": pos, "ouvert": focused})
            shot(E, "E2_clic_puce_panneau_ouvert")

            # ------------------------------------------------ C. réponse, résolu, archivé
            P = lambda: E.get_by_test_id("reviews-panel")  # noqa: E731
            item = lambda: P().locator(f"[data-testid=comment-item][data-id='{cid}']")  # noqa: E731
            item().get_by_test_id("comment-reply-open").click()
            item().get_by_test_id("comment-reply-input").fill("De-esser posé à 1:12, tu me dis ?")
            t0 = time.time()
            item().get_by_test_id("comment-reply-send").click()
            wait_for(T, lambda: any(r["text"].startswith("De-esser") for r in (find(T, "siffle") or {}).get("replies", [])), 10, step=20, what="réponse reçue par Nina")
            RES["mesures"]["reponse_inge_vers_artiste_ms"] = round((time.time() - t0) * 1000)
            t0 = time.time()
            item().get_by_test_id("comment-resolve").click()
            wait_for(T, lambda: (find(T, "siffle") or {}).get("status") == "resolved", 10, step=20, what="résolution reçue par Nina")
            RES["mesures"]["resolution_vers_artiste_ms"] = round((time.time() - t0) * 1000)
            T.wait_for_timeout(400)
            shot(T, "T2_reponse_et_resolu_recus")
            check("C1 réponse de l'ingé et résolution vues par l'artiste", True, {"reponse_ms": RES["mesures"]["reponse_inge_vers_artiste_ms"], "resolu_ms": RES["mesures"]["resolution_vers_artiste_ms"]})
            tap(T, R().get_by_test_id("comments-filter-resolved"))
            T.wait_for_timeout(300)
            t0 = time.time()
            tap(T, R().locator(f"[data-testid=comment-item][data-id='{cid}']").get_by_test_id("comment-archive"))
            wait_for(E, lambda: (find(E, "siffle") or {}).get("archived") is True, 10, step=20, what="archivage reçu par Max")
            RES["mesures"]["archivage_vers_inge_ms"] = round((time.time() - t0) * 1000)
            E.wait_for_timeout(300)
            pin_gone = E.locator(f"[data-testid=comment-pin][data-id='{cid}']").count() == 0
            P().get_by_test_id("comments-filter-archived").click()
            E.wait_for_timeout(300)
            in_archives = P().locator(f"[data-testid=comment-item][data-id='{cid}'][data-archived='1']").count() == 1
            check("C2 résolu puis archivé (au doigt) : aux archives chez l'ingé, puce retirée de la règle", pin_gone and in_archives, {"puce_retiree": pin_gone, "dans_archives": in_archives, "ms": RES["mesures"]["archivage_vers_inge_ms"]})
            shot(E, "E3_archive")
            P().get_by_test_id("comments-filter-open").click()

            # ------------------------------------------------ D. coupure réseau chez Nina
            tap(T, R().get_by_test_id("comments-filter-open"))
            offline(T, cloud, rt, "T", True)
            T.wait_for_timeout(1500)
            R().get_by_test_id("comment-time").fill("0:45")
            R().get_by_test_id("comment-text").fill("un souffle avant le refrain")
            tap(T, R().get_by_test_id("comment-add"))
            E.wait_for_timeout(3000)
            not_yet = find(E, "souffle") is None
            shot(T, "T3_hors_ligne_commentaire_garde")
            t0 = time.time()
            offline(T, cloud, rt, "T", False)
            try:
                wait_for(E, lambda: find(E, "souffle") is not None, 30, step=50, what="commentaire hors ligne reçu au retour")
                back_ms = round((time.time() - t0) * 1000)
            except AssertionError:
                back_ms = None
            RES["mesures"]["commentaire_hors_ligne_recu_apres_retour_ms"] = back_ms
            c2 = find(E, "souffle")
            check("D1 coupure réseau : rien ne part hors ligne, tout arrive au retour, au bon endroit (0:45)", not_yet and c2 is not None and c2["t"] == 45, {"pas_parti_hors_ligne": not_yet, "recu_apres_retour_ms": back_ms, "commentaire": c2})

            # ------------------------------------------------ E. saisie simultanée, réseau coupé des deux côtés
            offline(T, cloud, rt, "T", True)
            offline(E, cloud, rt, "E", True)
            T.wait_for_timeout(1200)
            # Nina : nouveau commentaire à 0:30, réponse sur « souffle », le résout.
            R().get_by_test_id("comment-time").fill("0:30")
            R().get_by_test_id("comment-text").fill("clic au début du couplet")
            tap(T, R().get_by_test_id("comment-add"))
            T.wait_for_timeout(200)
            it_t = R().locator(f"[data-testid=comment-item][data-id='{c2['id']}']")
            tap(T, it_t.get_by_test_id("comment-reply-open"))
            it_t.get_by_test_id("comment-reply-input").fill("c'est ma respiration, on la garde ?")
            tap(T, it_t.get_by_test_id("comment-reply-send"))
            # Max, au même moment (sans rien voir de Nina) : commentaire à 0:30 aussi, réponse, résolu.
            P().get_by_test_id("comment-time").fill("0:30")
            P().get_by_test_id("comment-text").fill("petit clic ici aussi")
            P().get_by_test_id("comment-add").click()
            it_e = P().locator(f"[data-testid=comment-item][data-id='{c2['id']}']")
            it_e.get_by_test_id("comment-reply-open").click()
            it_e.get_by_test_id("comment-reply-input").fill("je le nettoie")
            it_e.get_by_test_id("comment-reply-send").click()
            it_e.get_by_test_id("comment-resolve").click()
            tap(T, it_t.get_by_test_id("comment-resolve"))
            before = {"inge": cm(E, "c.sig()"), "artiste": cm(T, "c.sig()")}
            shot(E, "E4_hors_ligne_saisie_simultanee"); shot(T, "T4_hors_ligne_saisie_simultanee")
            t0 = time.time()
            offline(E, cloud, rt, "E", False)
            offline(T, cloud, rt, "T", False)
            conv_ms = None
            try:
                wait_for(E, lambda: cm(E, "c.sig()") == cm(T, "c.sig()") and len(comments(E)) == 4, 40, step=100, what="mêmes commentaires des deux côtés")
                conv_ms = round((time.time() - t0) * 1000)
            except AssertionError:
                pass
            RES["mesures"]["convergence_apres_retour_ms"] = conv_ms
            lE_, lT_ = comments(E), comments(T)
            souffle = find(E, "souffle") or {}
            check("E1 saisie simultanée + coupure : même état des deux côtés (empreinte complète identique)",
                  conv_ms is not None and before["inge"] != before["artiste"] and len(lE_) == 4 and len(souffle.get("replies", [])) == 2,
                  {"ms": conv_ms, "differaient_hors_ligne": before["inge"] != before["artiste"], "commentaires": len(lE_), "reponses_sur_souffle": len(souffle.get("replies", [])), "statut_souffle": souffle.get("status")})
            RES["etat_converge"] = lE_
            E.wait_for_timeout(500)
            shot(E, "E5_converge"); shot(T, "T5_converge")

            # ------------------------------------------------ F. versions envoyées / validées
            P().get_by_test_id("reviews-tab-versions").click()
            P().get_by_test_id("version-note").fill("Voix plus devant, « s » adoucis à 1:12")
            t0 = time.time()
            P().get_by_test_id("version-send").click()
            wait_for(E, lambda: len(cm(E, "c.versions()") or []) == 1 and E.get_by_test_id("reviews-busy").count() == 0, 120, step=200, what="version 1 envoyée")
            RES["mesures"]["envoi_version_1_s"] = round(time.time() - t0, 1)
            v1 = cm(E, "c.versions()")[0]
            check("F1 l'ingé envoie la version 1 (bounce du mix joint)", v1["audio"] and v1["duration"] and v1["duration"] >= 79, v1)
            shot(E, "E6_version_1_envoyee")
            wait_for(T, lambda: R().locator("[data-testid=version-item][data-n='1']").count() > 0, 30, step=100, what="version 1 chez Nina")
            RES["mesures"]["version_1_recue_chez_l_artiste_s"] = round(time.time() - t0, 1)
            tap(T, R().locator("[data-testid=version-item][data-n='1']").get_by_test_id("version-play"))
            t1 = time.time()
            try:
                wait_for(T, lambda: cm(T, "c.playing()") is not None, 40, step=100, what="version 1 en lecture chez Nina")
                listen_s = round(time.time() - t1, 1)
            except AssertionError:
                listen_s = None
            RES["mesures"]["version_1_son_pret_chez_l_artiste_s"] = listen_s
            check("F2 l'artiste écoute la version 1 (le son du mix arrive sur son téléphone)", listen_s is not None, {"pret_en_s": listen_s})
            shot(T, "T6_ecoute_version_1")
            tap(T, R().locator("[data-testid=version-item][data-n='1']").get_by_test_id("version-play"))
            tap(T, R().locator("[data-testid=version-item][data-n='1']").get_by_test_id("version-changes"))
            R().get_by_test_id("version-changes-text").fill("Le refrain est trop fort")
            t0 = time.time()
            tap(T, R().get_by_test_id("version-changes-send"))
            wait_for(E, lambda: ((cm(E, "c.versions()") or [{}])[0].get("decision") or {}).get("kind") == "changes", 15, step=50, what="retouches reçues par Max")
            RES["mesures"]["retouches_vers_inge_ms"] = round((time.time() - t0) * 1000)
            line1 = cm(E, "c.versions()")[0]["line"]
            try:
                wait_for(E, lambda: find(E, "Le refrain est trop fort") is not None, 10, step=50, what="retouches posées sur la timeline")
            except AssertionError:
                pass
            retouche_cmt = find(E, "Le refrain est trop fort")
            check("F3 « Demander des retouches » avec un commentaire : reçu et daté chez l'ingé (et posé sur la timeline)",
                  re.match(rf"^Version 1 : retouches demandées par Nina le {re.escape(today)} à \d\d:\d\d \(« Le refrain est trop fort »\)$", line1) is not None and retouche_cmt is not None,
                  {"historique": line1, "commentaire_timeline": retouche_cmt and {"t": retouche_cmt["t"], "texte": retouche_cmt["text"]}})
            E.wait_for_timeout(300)
            shot(E, "E7_retouches_demandees")
            P().get_by_test_id("version-name").fill("Mix final")
            P().get_by_test_id("version-note").fill("Refrain baissé de 2 dB")
            P().get_by_test_id("version-send").click()
            wait_for(E, lambda: len(cm(E, "c.versions()") or []) == 2 and E.get_by_test_id("reviews-busy").count() == 0, 120, step=200, what="version 2 envoyée")
            wait_for(T, lambda: R().locator("[data-testid=version-item][data-n='2']").count() > 0, 30, step=100, what="version 2 chez Nina")
            t0 = time.time()
            tap(T, R().locator("[data-testid=version-item][data-n='2']").get_by_test_id("version-approve"))
            wait_for(E, lambda: any((v.get("decision") or {}).get("kind") == "approved" for v in cm(E, "c.versions()") or []), 15, step=50, what="validation reçue par Max")
            RES["mesures"]["validation_vers_inge_ms"] = round((time.time() - t0) * 1000)
            E.wait_for_timeout(400)
            hist = [x.inner_text() for x in P().get_by_test_id("version-history-line").all()]
            ok_line = any(re.match(rf"^Version 2 validée par Nina le {re.escape(today)} à \d\d:\d\d$", h) for h in hist)
            check("F4 historique : « Version 2 validée par Nina le … » daté", ok_line, hist)
            RES["historique_versions"] = hist
            shot(E, "E8_historique_version_validee"); shot(T, "T7_version_2_validee")

            # ------------------------------------------------ G. persistance : réouverture des deux côtés
            sig_e, vsig_e = cm(E, "c.sig()"), cm(E, "c.versionsSig()")
            named = E.evaluate("""async () => { const m = await window.__novaAppModule('/utils/recoveryStore.ts'); const id = window.__novaTest.getState().id;
                const l = await m.recoveryStore().listVersions(id); return l.filter(v => v.versionNumber).map(v => ({ n: v.versionNumber, comment: v.comment || null })); }""")
            check("G1 chaque version envoyée est aussi un instantané nommé dans l'historique de l'appareil de l'ingé",
                  sum(1 for v in named if (v.get("comment") or "").startswith("Version ")) >= 2, named)
            t0 = time.time()
            E.goto(f"{BASE}?session={sid}.{secret}", wait_until="domcontentloaded", timeout=180000)
            wait_for(E, lambda: collab(E, "c.role()") == "engineer", 120, step=250, what="collaboration reprise après réouverture")
            dismiss(E)
            try:
                wait_for(E, lambda: cm(E, "c.sig()") == sig_e and cm(E, "c.versionsSig()") == vsig_e, 40, step=200, what="commentaires et versions retrouvés")
                same_e = True
            except AssertionError:
                same_e = False
            RES["mesures"]["reouverture_inge_s"] = round(time.time() - t0, 1)
            show_time(E, 30)
            pins = E.locator("[data-testid=comment-pin]").count()
            check("G2 l'ingé rouvre sa page : commentaires (réponses, résolus, archivés) et versions identiques, puces revenues",
                  same_e and pins >= 1, {"identique": same_e, "puces_visibles": pins, "commentaires": len(comments(E)), "versions": [v["line"] for v in cm(E, "c.versions()") or []]})
            qalib.ouvrir_menu_range(E, "[data-testid=dock-reviews]"); E.get_by_test_id("dock-reviews").click()
            E.wait_for_timeout(500)
            shot(E, "E9_apres_reouverture")
            T.goto(link, wait_until="domcontentloaded", timeout=180000)
            try:
                wait_for(T, lambda: T.get_by_test_id("collab-arrival").count() > 0 or collab(T, "c.role()") == "artist", 120, step=250, what="retour de Nina")
                if collab(T, "c.role()") != "artist":
                    T.wait_for_timeout(600); dismiss(T)
                    art = T.get_by_test_id("arrival-role-artist")
                    if art.count() and not art.locator("input:checked").count() and not T.locator("[data-testid=arrival-role-artist][data-quick='1']").count():
                        tap(T, art)
                    nm = T.get_by_label("Ton nom", exact=True)
                    if nm.count() and not (nm.input_value() or "").strip():
                        nm.fill("Nina")
                    tap(T, T.get_by_test_id("arrival-join"))
                wait_for(T, lambda: collab(T, "c.role()") == "artist", 90, step=250, what="Nina reliée à nouveau")
                wait_for(T, lambda: cm(T, "c.sig()") == sig_e and cm(T, "c.versionsSig()") == vsig_e, 40, step=200, what="mêmes retours chez Nina")
                same_t = True
            except AssertionError:
                same_t = False
            check("G3 l'artiste rouvre le lien : mêmes commentaires et versions que l'ingé", same_t, {"commentaires": len(comments(T)), "versions": len(cm(T, "c.versions()") or [])})
            T.wait_for_timeout(800); dismiss(T)
            try:
                tap(T, T.get_by_test_id("guest-review-jump")); T.wait_for_timeout(600)
            except Exception:
                pass
            shot(T, "T8_apres_reouverture")
        except Exception:
            for k, pg in (("E", E), ("T", T)):
                shot(pg, f"ECHEC_{k}")
            raise

        for k, lg in (("inge", lE), ("artiste", lT)):
            RES["erreurs"] += [f"{k}: {e['text'][:200]}" for e in lg.errors()][:10]
            save_log(lg)
        RES["ecritures_bloquees"] = len(getattr(T, "_blocked", [])) + len(getattr(E, "_blocked", []))
        b.close()


if __name__ == "__main__":
    t0 = time.time()
    try:
        run()
    except Exception as e:  # noqa
        import traceback
        RES["ok"] = False
        RES["exception"] = f"{type(e).__name__}: {str(e)[:800]}"
        RES["trace"] = traceback.format_exc()[-3000:]
        print(RES["trace"], flush=True)
        for k in ("E", "T"):
            try:
                shot(PAGES[k], f"ECHEC_{k}")
            except Exception:
                pass
        for k in ("lE", "lT"):
            if k in PAGES:
                RES["erreurs"] += [f"{k}: {e['text'][:300]}" for e in PAGES[k].errors()][:10]
    RES["duree_s"] = round(time.time() - t0, 1)
    (OUT / "resultat.json").write_text(json.dumps(RES, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({"ok": RES["ok"], "mesures": RES["mesures"], "duree_s": RES["duree_s"]}, ensure_ascii=False, indent=1))
    sys.exit(0 if RES["ok"] else 1)
