"""Scénario de bout en bout : « Feat à distance » (deux artistes et un ingé, En direct).

Trois navigateurs headless (aucune fenêtre) : l'artiste A (Léo, hôte), l'artiste
B (Sam) et l'ingé E (Max). Serveur NOVA (daw-session, AVEC le patch : clé par
appareil, codes d'invitation) et Supabase Realtime SIMULÉS en Python
(qa/collab_sim.py) : le direct marche vraiment entre les pages, on peut le
couper. Rien ne part vers Supabase (écritures bloquées par qalib).

Vérifié :
  1. invitation : Sam par le CODE (6 caractères), Max par le LIEN ; chacun
     choisit son rôle en arrivant ; présence des trois ;
  2. Léo et Sam enregistrent EN MÊME TEMPS (micro simulé) : chacun sur SA piste,
     pastille REC chez les autres, piste verrouillée ; aucune prise écrasée ;
  3. chacun entend l'autre à l'export (niveau mesuré dans la prise de l'autre) ;
     l'ingé voit (et exporte) les deux ;
  4. « Écouter ensemble » : départ en même temps (écart mesuré), pause suivie ;
  5. chat « à 0:12 » qui place la tête de lecture ; repère partagé ;
  6. une ancienne version de NOVA dans la session (opérations à l'ancien format) ;
  7. coupure réseau de Sam (il enregistre et écrit hors ligne), puis retour : rien
     de perdu.

Usage :
  NOVA_URL=http://127.0.0.1:3423/ python qa/feat_distance.py
  FEAT_SERVEUR=ancien … : fonction daw-session actuelle (sans le patch : pas de code).
"""
import json, os, re, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-collab-artistes\feat_distance")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3423/")
from qalib import *  # noqa
from gel_pre_effet import prepare, export_wav, rms_db, duration_s  # noqa
from collab_sim import FakeNovaCloud, FakeRealtime, connect  # noqa
from feat_lib import *  # noqa

NEW_SERVER = os.environ.get("FEAT_SERVEUR", "patch") != "ancien"
LEO_ID, SAM_ID, MAX_ID = "11111111-1111-4111-8111-111111111111", "33333333-3333-4333-8333-333333333333", "22222222-2222-4222-8222-222222222222"
LEO, SAM = f"u:{LEO_ID}", f"u:{SAM_ID}"
B_REC_AT = 12.0   # Sam enregistre à partir de 12 s (Léo à 0 s) : prises distinctes à l'écoute
B_REC2_AT = 20.0  # prise de Sam hors ligne


def engine(page):
    return collab(page, "c.engineTime()")


def seek(page, t):
    page.evaluate(f"async () => {{ const m = await import('/utils/playheadStore.ts'); m.playheadStore.set({t}); }}")


def takes(page):
    """Prises (clips « Prise … ») par piste : {nom de piste: [(id, début, propriétaire)]}."""
    out = {}
    for t in tracks(page) or []:
        for c in t["clips"]:
            if c["name"].startswith("Prise"):
                out.setdefault(t["name"], []).append({"id": c["id"], "start": c["start"], "dur": c["dur"], "owner": t["ownerName"]})
    return out


def take_ids(page):
    return sorted(c["id"] for v in takes(page).values() for c in v)


def notice(page):
    """Annonces visibles (bandeaux, assistant Nova) : le texte de la page."""
    return page.locator("body").inner_text()[-4000:]


def run():
    res = {"name": "feat_distance", "ok": True, "serveur": "avec le patch (clé par appareil, codes)" if NEW_SERVER else "actuel (sans le patch)",
           "steps": [], "mesures": {}, "verifications": {},
           "note": "Serveur NOVA et Supabase Realtime SIMULÉS (protocole Phoenix réel côté navigateur), micro simulé (fichier WAV)."}
    cloud, rt = FakeNovaCloud(per_device=NEW_SERVER, codes=NEW_SERVER), FakeRealtime()
    src = OUT / "00_session_leo.novaproj.zip"
    feat_project(src)
    link, ids = {}, {}
    out = OUT

    def step(label, fn):
        t = time.time()
        try:
            o = fn()
            res["steps"].append({"step": label, "ok": True, "s": round(time.time() - t, 1), **({"info": o} if o else {})})
            return o
        except Exception as e:  # noqa
            res["ok"] = False
            res["steps"].append({"step": label, "ok": False, "err": f"{type(e).__name__}: {str(e)[:600]}"})
            for tag, pg in (("A", A), ("B", B), ("E", E)):
                try: shot(pg, f"ECHEC_{len(res['steps'])}_{tag}")
                except Exception: pass
            return None

    def check(label, ok):
        res["verifications"][label] = bool(ok)
        if not ok:
            res["ok"] = False

    with sync_playwright() as p:
        b = launch(p)
        logA, logB, logE = Log("feat_A_leo"), Log("feat_B_sam"), Log("feat_E_max")
        ctxA, A = new_page(b, "pc", logA)
        ctxB, B = new_page(b, "tab", logB)   # Sam sur tablette (au doigt)
        ctxE, E = new_page(b, "pc", logE)
        for page in (A, B, E):
            page.add_init_script(REC_INIT)
            prepare(page, None, desktop=False)
        connect(A, cloud, rt, "A", LEO_ID, "leo@test.local")
        connect(B, cloud, rt, "B", SAM_ID, "sam@test.local")
        connect(E, cloud, rt, "E", MAX_ID, "max@test.local")

        # ------------------------------------------------------------------ 1. invitation
        def a_start():
            open_project_file(A, src, res, "A1_leo_session")
            dismiss(A)
            open_panel(A)
            A.get_by_placeholder("Ton nom (affiché aux autres)").fill("Léo")
            A.get_by_role("button", name="Démarrer la collaboration en direct").click()
            wait_for(A, lambda: collab(A, "c.role()") == "artist", 60, what="collaboration ouverte chez Léo")
            sid = next(k for k, v in cloud.sessions.items() if v["manifest"])
            link["s"] = f"{sid}.{cloud.sessions[sid]['secret']}"
            if NEW_SERVER:
                wait_for(A, lambda: re.search(r"[A-Z0-9]{3} [A-Z0-9]{3}", A.get_by_test_id("collab-invite-code").inner_text()), 20, what="code d'invitation affiché")
                link["code"] = re.search(r"([A-Z0-9]{3}) ([A-Z0-9]{3})", A.get_by_test_id("collab-invite-code").inner_text()).group(0)
            else:
                wait_for(A, lambda: "indisponible" in A.get_by_test_id("collab-invite-code").inner_text(), 20, what="code indisponible (ancienne fonction)")
            A.wait_for_timeout(500)
            shot(A, "A2_leo_invite_lien_et_code")
            me = collab(A, "c.me()")
            badge = A.evaluate("() => { const b = document.querySelector('[data-testid=collab-owner-voix]'); if (!b) return null; const r = b.getBoundingClientRect(); return { text: b.innerText, w: Math.round(r.width), visible: r.width > 0 && r.right <= window.innerWidth }; }")
            return {"badge_piste_leo": badge, "code": link.get("code"), "moi": me, "pistes": [(t["name"], t["ownerName"]) for t in tracks(A)], "texte_invitation": A.get_by_test_id("collab-invite-code").inner_text()}
        step("Léo (hôte) démarre : ses pistes sont à son nom ; lien + code à 6 caractères", a_start)

        def b_code():
            B.goto(BASE, wait_until="domcontentloaded")
            B.get_by_text("Nouveau Projet").first.wait_for(timeout=25000)
            B.get_by_text("Nouveau Projet").first.click(); B.wait_for_timeout(2500)
            dismiss(B)
            open_panel(B)
            if NEW_SERVER:
                B.get_by_test_id("collab-code-input").fill(link["code"].lower())
                shot(B, "B1_sam_entre_le_code")
                B.get_by_test_id("collab-code-join").click()
            else:
                B.goto(f"{BASE}?session={link['s']}&invite=1", wait_until="domcontentloaded")
            wait_for(B, lambda: B.get_by_test_id("collab-arrival").count() > 0, 60, what="choix du rôle à l'arrivée (Sam)")
            B.wait_for_timeout(2500)
            dismiss(B)
            B.wait_for_timeout(500)
            shot(B, "B2_sam_choisit_son_role")
            txt = B.get_by_test_id("collab-arrival").inner_text()
            B.get_by_test_id("arrival-role-artist").click()
            B.get_by_label("Ton nom", exact=True).fill("Sam")
            B.get_by_test_id("arrival-join").click()
            wait_for(B, lambda: collab(B, "c.role()") == "artist", 60, what="Sam relié")
            return {"ecran_arrivee": txt[:600]}
        step("Sam (tablette) rejoint avec le CODE, choisit « Artiste »", b_code)

        def e_link():
            E.goto(f"{BASE}?session={link['s']}&invite=1", wait_until="domcontentloaded")
            wait_for(E, lambda: E.get_by_test_id("collab-arrival").count() > 0, 60, what="choix du rôle à l'arrivée (Max)")
            E.wait_for_timeout(2500)
            dismiss(E)
            E.get_by_test_id("arrival-role-engineer").click()
            E.get_by_label("Ton nom", exact=True).fill("Max")
            shot(E, "E1_max_choisit_ingé")
            E.get_by_test_id("arrival-join").click()
            wait_for(E, lambda: collab(E, "c.role()") == "engineer", 60, what="Max relié")
            dismiss(E)
            online = lambda pg: pg.locator("[data-testid=collab-peer][data-online='1']").count()  # noqa
            for pg in (A, B, E):
                open_panel(pg)
            s = wait_for(A, lambda: online(A) >= 3 and online(B) >= 3 and online(E) >= 3, 40, what="présence des trois partout")
            for pg, n in ((A, "A3_leo_trois_presents"), (B, "B3_sam_trois_presents"), (E, "E2_max_trois_presents")):
                pg.wait_for_timeout(200); shot(pg, n)
            return {"presence_s": s, "vu_par_leo": A.get_by_test_id("collab-members").inner_text(), "moi_sam": collab(B, "c.me()"), "moi_max": collab(E, "c.me()")}
        step("Max (ingé) rejoint par le LIEN, choisit « Ingé son » ; les trois se voient", e_link)

        # ------------------------------------------------------------------ 2. deux prises en même temps
        def both_record():
            for pg in (A, B, E):
                close_panel(pg); pg.keyboard.press("Escape")
            seek(A, 0.0); seek(B, B_REC_AT)
            rec_button(A).click(); rec_button(B).click()
            A.wait_for_timeout(1500)
            during = {"recs_vus_par_max": collab(E, "c.recs()"), "recs_vus_par_sam": collab(B, "c.recs()"), "recs_vus_par_leo": collab(A, "c.recs()"),
                      "notification_sam": notice(B)[:400]}
            shot(E, "E3_max_voit_deux_REC"); shot(B, "B4_sam_enregistre_sur_sa_piste")
            A.wait_for_timeout(1700)
            rec_button(A).click(); rec_button(B).click()
            A.wait_for_timeout(1500)
            ids["A_take"] = [c["id"] for c in takes(A).get("Voix lead", [])]
            ids["B_take"] = [c["id"] for v in takes(B).values() for c in v]
            during["prises_leo"] = takes(A); during["prises_sam"] = takes(B)
            return during
        step("Léo et Sam appuient sur REC en même temps (3 s) : chacun sur SA piste", both_record)

        def locked():
            # Sam essaie d'armer la piste de Léo : refusé, phrase claire.
            B.keyboard.press("Escape")
            B.get_by_role("button", name="Armer l'enregistrement : Voix lead").first.dispatch_event("click")
            B.wait_for_timeout(600)
            msg = notice(B)
            shot(B, "B5_sam_piste_de_leo_refusee")
            armed = B.evaluate("() => window.__novaEdit.getState().tracks.find(t => t.id === 'voix').isTrackArmed")
            m = re.search(r".*piste de Léo.*", msg)
            return {"message": m.group(0) if m else msg[-300:], "armee": armed}
        o = step("Sam essaie d'armer la piste de Léo : refusé", locked)
        if o:
            check("piste de Léo : Sam ne peut pas l'armer (message clair)", (not o["armee"]) and "piste de Léo" in o["message"])

        def synced():
            t0 = time.time()
            wait_for(A, lambda: any(i in take_ids(A) for i in ids["B_take"]) and all(i in take_ids(B) for i in ids["A_take"])
                     and all(i in take_ids(E) for i in ids["A_take"] + ids["B_take"]), 60, step=500, what="les deux prises chez les trois")
            res["mesures"]["prises_recues_partout_s"] = round(time.time() - t0, 1)
            A.wait_for_timeout(1500)
            for pg, n in ((A, "A4_leo_voit_la_piste_de_sam"), (B, "B6_sam_voit_la_piste_de_leo"), (E, "E4_max_voit_les_deux")):
                shot(pg, n)
            return {"leo": takes(A), "sam": takes(B), "max": takes(E), "pistes_max": [(t["name"], t["ownerName"], t["color"]) for t in tracks(E)]}
        o = step("Les deux prises arrivent chez tout le monde (aucune écrasée)", synced)
        if o:
            check("chez Léo : sa prise ET celle de Sam", all(i in take_ids(A) for i in ids["A_take"] + ids["B_take"]))
            check("chez Sam : sa prise ET celle de Léo", all(i in take_ids(B) for i in ids["A_take"] + ids["B_take"]))
            check("chez Max (ingé) : les deux prises", all(i in take_ids(E) for i in ids["A_take"] + ids["B_take"]))
            check("la prise de Sam est sur « Voix de Sam », à son nom", any(t["name"] == "Voix de Sam" and t["ownerName"] == "Sam" for t in tracks(A)))

        # ------------------------------------------------------------------ 3. exports
        def exports():
            export_wav(A, out / "A_export_leo.wav", "A5")
            export_wav(B, out / "B_export_sam.wav", "B7")
            export_wav(E, out / "E_export_max.wav", "E5")
        step("Exports (Léo, Sam, Max)", exports)

        # ------------------------------------------------------------------ 4. Écouter ensemble
        def listen():
            open_panel(A)
            A.get_by_test_id("collab-listen-toggle").click()
            wait_for(B, lambda: (collab(B, "c.listen()") or {}).get("on"), 30, step=200, what="« Écouter ensemble » reçu chez Sam")
            wait_for(E, lambda: (collab(E, "c.listen()") or {}).get("on"), 30, step=200, what="« Écouter ensemble » reçu chez Max")
            open_panel(B); B.wait_for_timeout(300); shot(B, "B8_sam_suit_la_lecture_de_leo")
            close_panel(A); A.keyboard.press("Escape")
            seek(A, 2.0)
            A.wait_for_timeout(1500)
            t_play = time.time()
            A.keyboard.press("Space")
            wait_for(B, lambda: engine(B)["playing"] and engine(E)["playing"], 15, step=50, what="lecture partie chez Sam et Max")
            res["mesures"]["depart_suivi_s"] = round(time.time() - t_play, 2)
            A.wait_for_timeout(2500)
            samples = []
            for _ in range(5):
                a, bb, e = engine(A), engine(B), engine(E)
                # Position de chacun ramenée au même instant (horloge commune de la machine).
                ref = a["pos"] - (a["t"]) / 1000
                samples.append({"sam_ms": round(((bb["pos"] - bb["t"] / 1000) - ref) * 1000, 1), "max_ms": round(((e["pos"] - e["t"] / 1000) - ref) * 1000, 1)})
                A.wait_for_timeout(300)
            res["mesures"]["ecouter_ensemble_ecarts_ms"] = samples
            worst = max(max(abs(s["sam_ms"]), abs(s["max_ms"])) for s in samples)
            res["mesures"]["ecouter_ensemble_ecart_max_ms"] = worst
            shot(A, "A6_ecoute_ensemble_lecture"); shot(E, "E6_max_suit")
            A.keyboard.press("Space")
            wait_for(B, lambda: not engine(B)["playing"] and not engine(E)["playing"], 15, step=50, what="pause suivie")
            return {"ecart_max_ms": worst, "journal_sam": collab(B, "c.listen()")["log"][-4:]}
        o = step("« Écouter ensemble » : Léo guide, Sam et Max démarrent et s'arrêtent avec lui", listen)
        if o:
            check("« Écouter ensemble » : écart ≤ 120 ms", o["ecart_max_ms"] <= 120)

        # ------------------------------------------------------------------ 5. chat + repères
        def chat_marker():
            open_panel(B)
            B.get_by_label("Message").fill("Le refrain à 0:12, on le double ?")
            B.get_by_role("button", name="Envoyer").click()
            open_panel(A)
            wait_for(A, lambda: A.get_by_role("button", name="Aller à 0:12").count() > 0, 30, what="message de Sam chez Léo")
            A.get_by_role("button", name="Aller à 0:12").first.click()
            A.wait_for_timeout(500)
            pos = engine(A)["pos"]
            shot(A, "A7_leo_message_position")
            open_panel(E)
            seek(E, 24.0)
            E.get_by_label("Nom du repère").fill("couplet 2 ici")
            E.get_by_test_id("collab-marker-add").click()
            wait_for(A, lambda: "couplet 2 ici" in A.get_by_test_id("collab-markers").inner_text(), 30, what="repère de Max chez Léo")
            wait_for(B, lambda: B.evaluate("() => window.__novaEdit.getState().markers.some(m => m.name === 'couplet 2 ici')"), 30, what="repère de Max chez Sam")
            A.wait_for_timeout(400)
            shot(A, "A8_leo_repere_de_max")
            mk = A.evaluate("() => window.__novaEdit.getState().markers.map(m => ({ name: m.name, time: m.time, by: m.by || null }))")
            return {"tete_de_lecture_apres_clic": round(pos, 2), "reperes_chez_leo": mk}
        o = step("Chat « à 0:12 » (la tête de lecture saute) et repère partagé « couplet 2 ici »", chat_marker)
        if o:
            check("clic sur « 0:12 » : tête de lecture à 12 s", abs(o["tete_de_lecture_apres_clic"] - 12) < 0.05)
            check("repère de Max chez Léo (avec son nom)", any(m["name"] == "couplet 2 ici" and m["by"] == "Max" and abs(m["time"] - 24) < 0.01 for m in o["reperes_chez_leo"]))

        # ------------------------------------------------------------------ 6. ancienne version de NOVA
        def old_client():
            sid = link["s"].split(".")[0]
            old_key = "u:44444444-4444-4444-8444-444444444444"
            cloud.members[(sid, old_key)] = {"role": "artist", "name": "Ana (ancienne version)"}
            def inject(kind, op):
                cloud.seq += 1
                cloud.ops.append({"seq": cloud.seq, "sid": sid, "member_key": old_key, "role": "artist", "author_name": "Ana (ancienne version)",
                                  "kind": kind, "op": op, "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"), "t": time.time()})
            # Opérations telles qu'une version d'avant les envoie : ni _id, ni _d, ni propriétaire.
            inject("chat", {"text": "Salut, je suis sur l'ancienne version"})
            inject("content", {"trackId": "voix", "content": {"name": "Voix lead", "type": "AUDIO", "color": "#22d3ee", "clips": []}, "audio": {}})
            inject("content", {"trackId": "track-ana", "content": {"name": "Backs d'Ana", "type": "AUDIO", "color": "#f59e0b", "clips": []}, "audio": {},
                               "mix": {"volume": 0.7, "pan": 0.2, "sends": [], "plugins": []}})
            inject("lock", {"trackId": "track-ana", "lock": {"volume": 0.7, "by": "Ana", "at": 1}})
            wait_for(A, lambda: any(t["name"] == "Backs d'Ana" for t in tracks(A)) and any(t["name"] == "Backs d'Ana" for t in tracks(E)), 40, what="piste de l'ancienne version reçue")
            A.wait_for_timeout(800)
            voix_leo = [c["id"] for c in next(t for t in tracks(A) if t["id"] == "voix")["clips"]]
            ana = next(t for t in tracks(A) if t["name"] == "Backs d'Ana")
            return {"prises_de_leo_intactes": all(i in voix_leo for i in ids["A_take"]), "piste_ana_chez_leo": {"owner": ana["ownerName"], "ownerKey": ana["ownerKey"]},
                    "erreurs_page": [e["text"][:160] for e in logA.errors()][-3:]}
        o = step("Ancienne version de NOVA dans la session : opérations à l'ancien format", old_client)
        if o:
            check("ancien format : la version vide d'Ana n'efface pas la prise de Léo", o["prises_de_leo_intactes"])
            check("ancien format : la nouvelle piste d'Ana arrive, à son nom", o["piste_ana_chez_leo"]["owner"] == "Ana (ancienne version)")

        # ------------------------------------------------------------------ 7. coupure réseau de Sam
        def cut():
            cloud.down.add("B"); rt.blocked.add("B"); rt.drop("B")
            wait_for(B, lambda: (collab(B, "c.status()") or {}).get("reachable") is False or (collab(B, "c.status()") or {}).get("browserOffline"), 30, what="Sam hors ligne")
            close_panel(B); B.keyboard.press("Escape")
            seek(B, B_REC2_AT)
            rec_button(B).click(); B.wait_for_timeout(2500); rec_button(B).click(); B.wait_for_timeout(1500)
            ids["B_take2"] = [c["id"] for v in takes(B).values() for c in v if c["id"] not in ids["B_take"] and c["id"] not in ids["A_take"]]
            open_panel(B)
            B.get_by_label("Message").fill("Je suis hors ligne, ma 2e prise part au retour")
            B.get_by_role("button", name="Envoyer").click()
            wait_for(B, lambda: "Hors ligne" in panel_text(B), 30, what="« Hors ligne » chez Sam")
            B.wait_for_timeout(400)
            shot(B, "B9_sam_hors_ligne")
            open_panel(A)
            wait_for(A, lambda: A.locator("[data-testid=collab-peer]", has_text="Sam").get_attribute("data-state") in ("late", "offline"), 40, what="Sam « en retard / hors ligne » chez Léo")
            shot(A, "A9_leo_voit_sam_hors_ligne")
            state_vu = A.locator("[data-testid=collab-peer]", has_text="Sam").inner_text()
            t0 = time.time()
            cloud.down.discard("B"); rt.blocked.discard("B")
            wait_for(A, lambda: all(i in take_ids(A) for i in ids["B_take2"]) and "Je suis hors ligne" in panel_text(A), 90, step=500, what="prise et message hors ligne reçus après le retour")
            res["mesures"]["hors_ligne_recu_apres_retour_s"] = round(time.time() - t0, 1)
            wait_for(E, lambda: all(i in take_ids(E) for i in ids["B_take2"]), 60, what="prise hors ligne chez Max")
            A.wait_for_timeout(800)
            shot(A, "A10_leo_recoit_apres_retour"); shot(B, "B10_sam_de_retour")
            return {"etat_de_sam_vu_par_leo": state_vu, "prise_hors_ligne": ids["B_take2"]}
        o = step("Coupure réseau de Sam (prise + message hors ligne), puis retour : rien de perdu", cut)
        if o:
            check("coupure : la prise faite hors ligne arrive chez Léo et Max", bool(ids.get("B_take2")) and all(i in take_ids(A) and i in take_ids(E) for i in ids["B_take2"]))
            check("coupure : aucune prise perdue nulle part", all(i in take_ids(pg) for pg in (A, B, E) for i in ids["A_take"] + ids["B_take"] + ids.get("B_take2", [])))

        res["A_erreurs"] = [e["text"][:200] for e in logA.errors()][:12]
        res["B_erreurs"] = [e["text"][:200] for e in logB.errors()][:12]
        res["E_erreurs"] = [e["text"][:200] for e in logE.errors()][:12]
        res["ops"] = [{"seq": o["seq"], "role": o["role"], "kind": o["kind"], "membre": o["member_key"][-14:], "piste": (o["op"] or {}).get("trackId")} for o in cloud.ops]
        res["instantanes_ecrits_par"] = sorted({x[0] for x in cloud.log if x[1] == "commit"})
        res["ecritures_bloquees"] = (A._blocked + B._blocked + E._blocked)[:20]
        save_log(logA); save_log(logB); save_log(logE)
        ctxA.close(); ctxB.close(); ctxE.close(); b.close()

    # ------------------------------------------------------------------ mesures audio
    m = res["mesures"]
    fa, fb, fe = out / "A_export_leo.wav", out / "B_export_sam.wav", out / "E_export_max.wav"
    win_a = (0.15, 0.9)                     # prise de Léo (avant la phrase 1 à 1 s)
    win_b = (B_REC_AT + 0.4, B_REC_AT + 2.4)  # prise de Sam
    win_silence = (10.0, 11.5)              # rien dans la session
    for k, f in (("leo", fa), ("sam", fb), ("max", fe)):
        if f.exists():
            m[f"export_{k}"] = {"prise_leo_dB": rms_db(f, *win_a), "prise_sam_dB": rms_db(f, *win_b), "silence_dB": rms_db(f, *win_silence), "duree_s": duration_s(f)}
    if all(f"export_{k}" in m for k in ("leo", "sam", "max")):
        audible = lambda d, key: d[key] is not None and d[key] > -45 and d[key] - (d["silence_dB"] if d["silence_dB"] is not None else -200) > 20  # noqa
        check("Léo entend la prise de Sam dans son export", audible(m["export_leo"], "prise_sam_dB"))
        check("Sam entend la prise de Léo dans son export", audible(m["export_sam"], "prise_leo_dB"))
        check("Max entend les deux prises dans son export", audible(m["export_max"], "prise_leo_dB") and audible(m["export_max"], "prise_sam_dB"))
    else:
        check("exports présents", False)
    check("instantané écrit par l'hôte seulement", res.get("instantanes_ecrits_par") in (["A"], []))
    (out / "resultat_feat_distance.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: res[k] for k in ("ok", "serveur", "verifications", "mesures")}, ensure_ascii=True, indent=1)[:6000])
    for s in res["steps"]:
        print(("OK " if s["ok"] else "ECHEC ") + s["step"].encode("ascii", "replace").decode() + ("" if s["ok"] else "  -> " + s["err"].encode("ascii", "replace").decode()[:400]))
    return res


if __name__ == "__main__":
    r = run()
    sys.exit(0 if r["ok"] else 1)
