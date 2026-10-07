"""Scénario de bout en bout : collaboration « En direct » (comme TeamViewer).

Deux navigateurs headless (aucune fenêtre) : l'ARTISTE (appli Windows simulée,
pont VST v7 simulé, un compresseur « VST3 » de test sur sa voix) et l'INGÉ
(navigateur, sans pont : il n'a pas ce VST). L'ingé travaille DANS la session
de l'artiste.

Serveur NOVA (daw-session) et Supabase Realtime (diffusion + présence) SIMULÉS
en Python et partagés par les deux navigateurs (qa/collab_sim.py) : le direct
marche vraiment entre les deux pages, et on peut le couper. Rien ne part vers
Supabase (écritures bloquées par qalib).

Vérifié :
  1. connexion à deux, présence (chacun voit l'autre) ;
  2. l'ingé règle le VST de l'artiste à distance et ENTEND le résultat
     (aperçu rendu par le pont de l'artiste) : export de l'ingé ≈ export de
     l'artiste, et le réglage (-12 dB) s'entend ;
  3. mix fait par l'ingé reçu par l'artiste ; direct coupé chez l'artiste :
     état visible, reconnexion et rattrapage ;
  4. ingé hors ligne : message gardé (« envoi… »), état « Hors ligne », parti
     au retour du réseau (« Réessayer ») ;
  5. page de l'ingé rouverte : la collaboration reprend toute seule ;
  6. pont VST de l'artiste fermé : message clair chez l'ingé.

Usage :
  NOVA_URL=http://127.0.0.1:4020/ python qa/collab_direct.py
"""
import json, os, re, sys, time, zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-collab-durcissement\en_direct")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:4020/")
from qalib import *  # noqa
from gel_pre_effet import prepare, open_project_file, rms_db, duration_s, voice_wav, export_wav, vst, PHRASES, COMP_PATH  # noqa
from collab_sim import FakeNovaCloud, FakeRealtime, FakeBridgeV7, connect  # noqa

BASE_T = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0}


def artist_project(path: Path):
    clips = [{"id": f"p{i+1}", "name": f"Phrase {i+1}", "start": a, "duration": b - a, "offset": a, "fadeIn": 0, "fadeOut": 0,
              "color": "#22d3ee", "type": "AUDIO", "audioRef": "audio/voix.wav", "gain": 1, "takeNumber": 1} for i, (a, b) in enumerate(PHRASES)]
    tracks = [{**BASE_T, "id": "voix", "name": "Voix lead", "type": "AUDIO", "color": "#22d3ee", "volume": 1.0, "outputTrackId": "master",
               "sends": [], "clips": clips, "plugins": [vst("vst-comp", "NovaTestComp", COMP_PATH)]}]
    state = {
        "id": "proj-direct", "name": "Session en direct", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": None, "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/voix.wav", voice_wav())


def dismiss(page):
    for name in ("C'est parti", "Plus tard", "C'est noté"):
        b = page.get_by_role("button", name=name, exact=True).locator("visible=true").first
        try:
            if b.is_visible(): b.click(); page.wait_for_timeout(300)
        except Exception:
            pass


def wait_for(page, fn, timeout=40, step=400, what="condition"):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            v = fn()
            if v:
                return round(time.time() - t0, 1)
        except Exception:
            pass
        page.wait_for_timeout(step)
    raise AssertionError(f"délai dépassé : {what}")


def collab(page, expr):
    return page.evaluate(f"() => {{ const c = window.__novaCollab; return c ? ({expr}) : null; }}")


def open_panel(page):
    if page.locator("[aria-labelledby='collab-title']").count():
        return
    b = page.get_by_role("button", name=re.compile(r"(Collaborer|en ligne · Chat)$")).locator("visible=true").first
    b.click(); page.wait_for_timeout(600)


def panel_text(page):
    loc = page.locator("[aria-labelledby='collab-title']")
    return loc.first.inner_text() if loc.count() else ""


def run():
    out = OUT
    res = {"name": "collab_direct", "ok": True, "steps": [], "mesures": {},
           "note": "Serveur NOVA et Supabase Realtime SIMULÉS (protocole Phoenix réel côté navigateur), pont VST de l'artiste simulé (v7)."}
    cloud, rt = FakeNovaCloud(), FakeRealtime()
    bridgeA = FakeBridgeV7()
    src = out / "00_session_artiste.novaproj.zip"
    artist_project(src)
    link = {}

    def step(label, fn):
        t = time.time()
        try:
            o = fn()
            res["steps"].append({"step": label, "ok": True, "s": round(time.time() - t, 1), **({"info": o} if o else {})})
            return o
        except Exception as e:  # noqa
            res["ok"] = False
            res["steps"].append({"step": label, "ok": False, "err": f"{type(e).__name__}: {str(e)[:500]}"})
            return None

    with sync_playwright() as p:
        b = launch(p)
        logA, logE = Log("artiste_direct"), Log("inge_direct")
        ctxA, A = new_page(b, "pc", logA)
        ctxE, E = new_page(b, "pc", logE)
        prepare(A, bridgeA, desktop=True)
        prepare(E, None, desktop=False)
        connect(A, cloud, rt, "A", "11111111-1111-4111-8111-111111111111", "lina@test.local")
        connect(E, cloud, rt, "E", "22222222-2222-4222-8222-222222222222", "max@test.local")

        def a_open():
            open_project_file(A, src, res, "A1_artiste_session")
            dismiss(A)
            wait_for(A, lambda: A.evaluate("() => !!(window.__novaBridge && window.__novaBridge.isConnected())"), 25, what="pont VST de l'artiste")
            wait_for(A, lambda: any(s.get("path") == COMP_PATH for s in bridgeA.slots.values()), 25, what="VST chargé en direct chez l'artiste")
        step("Artiste : sa session (appli Windows, pont VST : compresseur VST chargé en direct)", a_open)

        def a_start():
            open_panel(A)
            shot(A, "A2_choix_en_direct")
            A.get_by_placeholder("Ton nom (affiché aux autres)").fill("Lina")
            A.get_by_role("button", name=re.compile("Démarrer la collaboration en direct")).click()
            wait_for(A, lambda: collab(A, "c.role()") == "artist", 60, what="collaboration ouverte chez l'artiste")
            sid = next(k for k, v in cloud.sessions.items() if v["manifest"])
            link["s"] = f"{sid}.{cloud.sessions[sid]['secret']}"
            A.wait_for_timeout(800)
            shot(A, "A3_artiste_en_attente_de_l_inge")
            return {"etat": panel_text(A)[:300]}
        step("Artiste : « Démarrer la collaboration en direct » (session mise en ligne, en attente de l'ingé)", a_start)

        def e_join():
            E.goto(f"{BASE}?session={link['s']}&role=engineer", wait_until="domcontentloaded")
            wait_for(E, lambda: collab(E, "c.role()") == "engineer", 60, what="ingé relié")
            dismiss(E)
            open_panel(E)
            s = wait_for(E, lambda: E.get_by_test_id("collab-members").locator("span.rounded-full").count() >= 2 and A.get_by_test_id("collab-members").locator("span.rounded-full").count() >= 2, 30, what="présence des deux côtés")
            shot(E, "E1_inge_relie_presence")
            open_panel(A); shot(A, "A4_artiste_voit_l_inge")
            return {"presence_en_s": s, "membres_inge": E.get_by_test_id("collab-members").inner_text(), "membres_artiste": A.get_by_test_id("collab-members").inner_text(),
                    "etat_inge": collab(E, "c.status()")}
        step("Ingé : ouvre le lien d'invitation → relié, présence des deux côtés", e_join)

        def e_first_preview():
            t0 = time.time()
            wait_for(E, lambda: collab(E, "c.track('Voix lead')")["livePreview"], 60, what="premier aperçu chez l'ingé")
            res["mesures"]["premier_apercu_s"] = round(time.time() - t0, 1)
            E.wait_for_timeout(500)
            open_panel(E)
            shot(E, "E2_apercu_a_jour")
            return {"etat": E.get_by_test_id("live-preview").inner_text()}
        step("Ingé : l'aperçu du son de l'artiste (ses VST) arrive tout seul", e_first_preview)

        def e_export_before():
            export_wav(E, out / "E1_inge_apercu_0dB.wav", "E3")
        step("Ingé : export (aperçu, Output 0 dB)", e_export_before)

        def e_set_param():
            open_panel(E)
            E.get_by_role("button", name="Lire ses réglages").click()
            wait_for(E, lambda: E.get_by_label("Valeur de Output").count() > 0, 40, what="réglages lus chez l'artiste")
            before = collab(E, "c.track('Voix lead')")["livePreview"]["renderId"]
            E.get_by_label("Valeur de Output").fill("-12")
            t0 = time.time()
            E.get_by_label("Valeur de Output").locator("xpath=..").get_by_role("button", name="Régler").click()
            seen_busy = {}
            def changed():
                txt = E.get_by_test_id("live-preview").inner_text() if E.get_by_test_id("live-preview").count() else ""
                if "en cours de calcul" in txt and "busy" not in seen_busy:
                    seen_busy["busy"] = round(time.time() - t0, 1)
                    shot(E, "E4_apercu_en_cours_de_calcul")
                lp = collab(E, "c.track('Voix lead')")["livePreview"]
                return lp and lp["renderId"] != before
            wait_for(E, changed, 60, step=200, what="nouvel aperçu après le réglage")
            res["mesures"]["reglage_vers_apercu_s"] = round(time.time() - t0, 1)
            E.wait_for_timeout(400)
            shot(E, "E5_reglage_relu_et_apercu_a_jour")
            return {"relu": E.locator("text=relu sur le plugin").first.inner_text() if E.locator("text=relu sur le plugin").count() else None,
                    "etat_vu_pendant": seen_busy, "pont_artiste": bridgeA.sets[-1:]}
        step("Ingé : règle « Output » du VST de l'artiste à -12 dB → relu sur son plugin, aperçu recalculé", e_set_param)

        def e_export_after():
            export_wav(E, out / "E2_inge_apercu_-12dB.wav", "E6")
        step("Ingé : export après le réglage (il entend le VST de l'artiste)", e_export_after)

        def a_export():
            export_wav(A, out / "A1_artiste_reference.wav", "A5")
        step("Artiste : export de référence (son vrai VST, réglé par l'ingé)", a_export)

        def mix_and_reconnect():
            # Direct coupé chez l'artiste (il ne peut pas se reconnecter pendant quelques secondes) ;
            # l'ingé coupe le son de la piste pendant ce temps.
            rt.blocked.add("A")
            rt.drop("A")
            wait_for(A, lambda: collab(A, "c.status().realtime") == "down", 15, step=200, what="direct coupé vu par l'artiste")
            etat_coupure = collab(A, "c.status()")
            open_panel(A); A.wait_for_timeout(300); shot(A, "A6_direct_coupe")
            E.keyboard.press("Escape")
            mute = E.get_by_role("button", name="Muet : Voix lead").locator("visible=true").first
            mute.click()
            E.wait_for_timeout(3000)
            pendant = collab(A, "c.track('Voix lead')")["isMuted"]
            t0 = time.time()
            rt.blocked.discard("A")
            wait_for(A, lambda: collab(A, "c.track('Voix lead')")["isMuted"] is True, 30, step=250, what="mix de l'ingé reçu après la reconnexion")
            res["mesures"]["mix_recu_apres_retour_du_direct_s"] = round(time.time() - t0, 1)
            wait_for(A, lambda: rt.online("A") and collab(A, "c.status().realtime") == "live", 60, what="direct de l'artiste reconnecté")
            shot(A, "A7_reconnecte_mix_recu")
            t1 = time.time()
            mute.click()  # on rend le son : par le direct cette fois
            wait_for(A, lambda: collab(A, "c.track('Voix lead')")["isMuted"] is False, 20, step=100, what="son rendu")
            res["mesures"]["mix_par_le_direct_s"] = round(time.time() - t1, 2)
            return {"etat_pendant_coupure": {k: etat_coupure.get(k) for k in ("realtime", "reachable", "pending")},
                    "deja_recu_pendant_la_coupure (rattrapage 10 s)": pendant, "connexions": [x for x in rt.log if x[0] == "A"][-5:]}
        step("Mix de l'ingé (muet) pendant une coupure du direct chez l'artiste : reçu après la reconnexion", mix_and_reconnect)

        def offline():
            cloud.down.add("E"); rt.blocked.add("E"); rt.drop("E")
            open_panel(E)
            E.get_by_label("Message").fill("Je teste hors ligne : ce message part au retour du réseau")
            E.get_by_role("button", name="Envoyer").click()
            wait_for(E, lambda: "Hors ligne" in panel_text(E), 30, what="état « Hors ligne » chez l'ingé")
            E.wait_for_timeout(500)
            shot(E, "E7_hors_ligne_message_en_attente")
            txt = panel_text(E)
            cloud.down.discard("E"); rt.blocked.discard("E")
            t0 = time.time()
            E.get_by_test_id("collab-status-action").click()
            open_panel(A)
            wait_for(A, lambda: "Je teste hors ligne" in panel_text(A), 30, what="message reçu par l'artiste")
            res["mesures"]["message_hors_ligne_recu_apres_retour_s"] = round(time.time() - t0, 1)
            E.wait_for_timeout(800)
            shot(E, "E8_retour_du_reseau")
            shot(A, "A8_message_recu")
            return {"panneau_hors_ligne": txt[:400], "en_attente_affiche": "envoi…" in txt}
        step("Ingé hors ligne : état « Hors ligne », message gardé (« envoi… »), parti au retour (« Réessayer »)", offline)

        def reload_engineer():
            E.goto(f"{BASE}?session={link['s']}", wait_until="domcontentloaded")
            s = wait_for(E, lambda: collab(E, "c.role()") == "engineer", 60, what="collaboration reprise après réouverture")
            dismiss(E)
            wait_for(A, lambda: A.get_by_test_id("collab-members").locator("span.rounded-full").count() >= 2, 30, what="présence revenue chez l'artiste")
            open_panel(E)
            E.wait_for_timeout(800)
            shot(E, "E9_inge_reprend_apres_rechargement")
            return {"reprise_en_s": s, "etat": collab(E, "c.status()")}
        step("Ingé : page rouverte en pleine session → la collaboration reprend toute seule", reload_engineer)

        def bridge_closed():
            bridgeA.close()
            wait_for(A, lambda: not A.evaluate("() => window.__novaBridge.isConnected()"), 20, what="pont fermé chez l'artiste")
            open_panel(E)
            wait_for(E, lambda: E.get_by_test_id("live-preview").count() > 0, 20, what="section aperçu")
            E.get_by_test_id("live-preview").get_by_role("button").first.click()
            wait_for(E, lambda: "pont VST de l'artiste" in E.get_by_test_id("live-preview").inner_text(), 60, what="message pont fermé chez l'ingé")
            E.wait_for_timeout(400)
            shot(E, "E10_pont_artiste_ferme")
            return {"message": E.get_by_test_id("live-preview").inner_text()[:300]}
        step("Pont VST de l'artiste fermé : l'ingé le sait (message clair, « Réessayer »)", bridge_closed)

        res["A_erreurs"] = [e["text"][:200] for e in logA.errors()][:12]
        res["E_erreurs"] = [e["text"][:200] for e in logE.errors()][:12]
        res["ops"] = [{k: o[k] for k in ("seq", "role", "kind")} for o in cloud.ops]
        res["realtime"] = rt.log[-40:]
        res["ecritures_bloquees"] = (A._blocked + E._blocked)[:20]
        save_log(logA); save_log(logE)
        ctxA.close(); ctxE.close(); b.close()

    m = res["mesures"]
    f = {"e0": out / "E1_inge_apercu_0dB.wav", "e12": out / "E2_inge_apercu_-12dB.wav", "a": out / "A1_artiste_reference.wav"}
    for k, path in f.items():
        if path.exists():
            m[k] = {"phrase1_dB": rms_db(path, 1.2, 2.8), "duree_s": duration_s(path)}
    checks = {}
    if all(k in m for k in ("e0", "e12", "a")):
        d = (m["e0"]["phrase1_dB"] or 0) - (m["e12"]["phrase1_dB"] or 0)
        checks["le réglage -12 dB fait chez l'artiste s'entend chez l'ingé (écart 12 ± 1,5 dB)"] = abs(d - 12) <= 1.5
        checks["chez l'ingé comme chez l'artiste (phrase 1, ± 1 dB)"] = abs((m["e12"]["phrase1_dB"] or 0) - (m["a"]["phrase1_dB"] or 99)) <= 1
        m["ecart_reglage_dB"] = round(d, 2)
    res["verifications_audio"] = checks
    if not checks or not all(checks.values()):
        res["ok"] = False
    (out / "resultat_collab_direct.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: res[k] for k in ("ok", "steps", "mesures", "verifications_audio")}, ensure_ascii=True, indent=1)[:9000])
    return res


if __name__ == "__main__":
    r = run()
    sys.exit(0 if r["ok"] else 1)
