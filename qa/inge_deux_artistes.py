"""Scénario de bout en bout : « Ingé à distance » avec DEUX artistes sur le même lien.

Trois navigateurs headless (aucune fenêtre) : Léo et Sam (artistes, chacun SA
session, et leurs deux pistes portent le MÊME identifiant « voix ») et Max
(l'ingé, appli Windows simulée avec pont VST simulé). Serveur NOVA simulé
(qa/collab_sim.py, clé de membre par appareil), direct Realtime muet (le
rattrapage toutes les 10 s fait tout passer). Rien ne part vers Supabase.

Vérifié :
  1. Sam rejoint le lien de Léo comme 2e artiste ;
  2. chez Max : deux pistes distinctes, au nom de chacun (avant : la piste de
     Sam remplaçait celle de Léo) ;
  3. Max met la reverb de NOVA sur la piste de Léo seulement, gèle et renvoie
     les deux : chacun ne reçoit que SON rendu (avant : le retour de Léo
     s'appliquait aussi chez Sam).

Usage :
  NOVA_URL=http://127.0.0.1:3423/ python qa/inge_deux_artistes.py
"""
import json, os, re, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-collab-artistes\inge_deux_artistes")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3423/")
from qalib import *  # noqa
from gel_pre_effet import prepare, FakeBridge, open_project_file  # noqa
from collab_sim import FakeNovaCloud, SUPA, STORE, jwt  # noqa
from mode_inge import artist_project, engineer_project, dismiss, open_collab, panel, wait_for, text_of, click_track, side_tab, close_plugin_window  # noqa


def connect_muted(page, cloud, tag, uid, email):
    """Compte et abonnement simulés, daw-session simulée, direct Realtime ouvert mais muet."""
    user = {"id": uid, "email": email, "aud": "authenticated", "role": "authenticated", "app_metadata": {}, "user_metadata": {}, "created_at": "2026-01-01T00:00:00Z"}
    tok = jwt(uid, email)
    sess = {"access_token": tok, "token_type": "bearer", "expires_in": 86400 * 30, "expires_at": int(time.time()) + 86400 * 30, "refresh_token": "qa-refresh", "user": user}
    page.add_init_script(f"try {{ localStorage.setItem('sb-mxdrxpzxbgybchzzvpkf-auth-token', {json.dumps(json.dumps(sess))}); localStorage.setItem('nova_simple_mode', '0'); }} catch (e) {{}}")
    page.route(f"{SUPA}/auth/v1/user*", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(user)))
    page.route(f"{SUPA}/auth/v1/token*", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(sess)))
    page.route(f"{SUPA}/functions/v1/daw-session", cloud.handler(tag))
    page.route(f"{SUPA}/storage/v1/object/upload/sign/**", cloud.upload)
    page.route(f"{STORE}/**", cloud.download)
    page.route(f"{SUPA}/rest/v1/instrumentals*", lambda r: r.fulfill(status=200, content_type="application/json", body="[]"))
    page.route_web_socket(re.compile(r"realtime/v1/websocket"), lambda ws: None)


def track_of(page, tid):
    return page.evaluate(f"() => {{ const t = window.__novaEdit.getState().tracks.find(x => x.id === '{tid}'); return t ? {{ id: t.id, name: t.name, owner: t.collabOwnerName || null, sends: (t.sends || []).map(s => s.id), frozen: !!t.isFrozen, remote: t.remote ? {{ peerKey: t.remote.peerKey || null, recvV: t.remote.recvV || null, appliedV: t.remote.appliedV || null, pending: !!t.remote.pending }} : null }} : null; }}")


def remote_tracks(page):
    return page.evaluate("() => window.__novaEdit.getState().tracks.filter(t => t.remote).map(t => ({ id: t.id, name: t.name, owner: t.collabOwnerName || null, peerKey: t.remote.peerKey || null, clips: t.clips.length }))")


def run():
    res = {"name": "inge_deux_artistes", "ok": True, "steps": [], "verifications": {},
           "note": "Serveur NOVA simulé (clé par appareil), direct muet (rattrapage 10 s), pont VST de l'ingé simulé."}
    cloud = FakeNovaCloud(per_device=True)
    a_src, b_src, e_src = OUT / "00_session_leo.novaproj.zip", OUT / "00_session_sam.novaproj.zip", OUT / "00_session_max.novaproj.zip"
    artist_project(a_src); artist_project(b_src); engineer_project(e_src)
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
        logA, logB, logE = Log("ri_leo"), Log("ri_sam"), Log("ri_max")
        ctxA, A = new_page(b, "pc", logA)
        ctxB, B = new_page(b, "pc", logB)
        ctxE, E = new_page(b, "pc", logE)
        bridge = FakeBridge()
        prepare(A, None, desktop=False); prepare(B, None, desktop=False); prepare(E, bridge, desktop=True)
        connect_muted(A, cloud, "A", "11111111-1111-4111-8111-111111111111", "leo@test.local")
        connect_muted(B, cloud, "B", "33333333-3333-4333-8333-333333333333", "sam@test.local")
        connect_muted(E, cloud, "E", "22222222-2222-4222-8222-222222222222", "max@test.local")

        def a_link():
            open_project_file(A, a_src, res, "A1_leo_session")
            dismiss(A)
            open_collab(A)
            A.get_by_test_id("collab-mode-remote").click(); A.wait_for_timeout(300)
            A.get_by_placeholder("Ton nom (affiché aux autres)").fill("Léo")
            A.get_by_test_id("remote-start").click()
            A.get_by_test_id("remote-invite").wait_for(timeout=20000)
            link["url"] = A.get_by_test_id("remote-invite").input_value()
            A.wait_for_timeout(400)
            shot(A, "A2_leo_lien_et_invitation_artiste")
            return {"lien": link["url"][-40:], "bouton_artiste": text_of(A, "remote-invite-artist")}
        step("Léo crée le lien « Ingé à distance » (et peut inviter un 2e artiste)", a_link)

        def b_join():
            open_project_file(B, b_src, res, "B1_sam_session")
            dismiss(B)
            open_collab(B)
            B.get_by_test_id("collab-mode-remote").click(); B.wait_for_timeout(300)
            B.get_by_test_id("remote-link-input").fill(link["url"] + "&ri=artist")
            B.get_by_placeholder("Ton nom (affiché aux autres)").fill("Sam")
            shot(B, "B2_sam_colle_le_lien_de_leo")
            B.get_by_test_id("remote-start").click()
            B.get_by_test_id("remote-panel").wait_for(timeout=20000)
            B.wait_for_timeout(600)
            shot(B, "B3_sam_relie")
            return {"panneau": text_of(B, "remote-panel")[:300]}
        step("Sam rejoint le MÊME lien comme 2e artiste", b_join)

        def e_join():
            open_project_file(E, e_src, res, "E1_max_session")
            dismiss(E)
            wait_for(E, lambda: E.evaluate("() => !!(window.__novaBridge && window.__novaBridge.isConnected())"), 20, what="pont simulé")
            open_collab(E)
            E.get_by_test_id("collab-mode-remote").click(); E.wait_for_timeout(200)
            E.get_by_test_id("collab-role").select_option("engineer"); E.wait_for_timeout(200)
            E.get_by_test_id("remote-link-input").fill(link["url"])
            E.get_by_placeholder("Ton nom (affiché aux autres)").fill("Max")
            E.get_by_test_id("remote-start").click()
            E.get_by_test_id("remote-panel").wait_for(timeout=20000)
        step("Max (ingé) se relie au lien", e_join)

        def both_send():
            for pg in (A, B):
                panel(pg)
                pg.get_by_test_id("remote-send-voix").click()
            wait_for(E, lambda: len(remote_tracks(E)) >= 2, 60, what="deux pistes chez Max")
            E.wait_for_timeout(800)
            panel(E)
            shot(E, "E2_max_deux_pistes_au_nom_de_chacun")
            return {"pistes_chez_max": remote_tracks(E), "panneau": text_of(E, "remote-panel")[:500]}
        o = step("Léo et Sam envoient chacun « voix » (même identifiant) : deux pistes chez Max", both_send)
        if o:
            rt = o["pistes_chez_max"]
            check("chez Max : deux pistes distinctes", len({t["id"] for t in rt}) == 2)
            check("chez Max : chacune au nom de son artiste", sorted(t["owner"] or "" for t in rt) == ["Léo", "Sam"])

        def e_work():
            rt = remote_tracks(E)
            leo = next(t for t in rt if t["owner"] == "Léo")
            sam = next(t for t in rt if t["owner"] == "Sam")
            link["leo_e"], link["sam_e"] = leo["id"], sam["id"]
            click_track(E, leo["name"])
            side_tab(E, "FX")
            E.get_by_text("Spatial Verb", exact=True).first.click(); E.wait_for_timeout(1200)
            close_plugin_window(E)
            panel(E)
            for tid in (leo["id"], sam["id"]):
                E.get_by_test_id(f"remote-return-{tid}").click()
                wait_for(E, lambda: "Envoyée à l'artiste" in text_of(E, f"remote-status-{tid}"), 60, what=f"gel + envoi {tid}")
            shot(E, "E3_max_renvoie_les_deux")
            rets = [o for o in cloud.ops if o["kind"] == "ri_return"]
            return {"retours": [{"trackId": (o["op"] or {}).get("trackId"), "to": (o["op"] or {}).get("to")} for o in rets],
                    "envois_leo": track_of(E, leo["id"])["sends"], "envois_sam": track_of(E, sam["id"])["sends"]}
        o = step("Max : reverb de NOVA sur la piste de Léo seulement, gèle et renvoie les deux", e_work)
        if o:
            check("chaque retour porte son destinataire", len(o["retours"]) >= 2 and all(r["to"] for r in o["retours"]))

        def receive():
            for pg, n in ((A, "A3_leo_recoit"), (B, "B4_sam_recoit")):
                panel(pg)
                wait_for(pg, lambda: pg.get_by_test_id("remote-receive-voix").count() > 0, 60, what="réglages prêts")
                pg.get_by_test_id("remote-receive-voix").click()
                wait_for(pg, lambda: "Mise à jour reçue" in text_of(pg, "remote-status-voix"), 30, what="réglages appliqués")
                pg.wait_for_timeout(600)
                shot(pg, n)
            return {"leo": track_of(A, "voix"), "sam": track_of(B, "voix")}
        o = step("Léo et Sam reçoivent : chacun SON rendu", receive)
        if o:
            check("Léo reçoit la reverb que Max a mise sur SA piste", any("verb" in s or "ri-" in s or "bus" in s for s in o["leo"]["sends"]) and len(o["leo"]["sends"]) > len(o["sam"]["sends"]))
            check("Sam ne reçoit pas le rendu de Léo (pas de reverb chez lui)", len(o["sam"]["sends"]) < len(o["leo"]["sends"]))

        res["ops"] = [{"seq": o["seq"], "kind": o["kind"], "membre": o["member_key"][-12:], "piste": (o["op"] or {}).get("trackId"), "to": (o["op"] or {}).get("to")} for o in cloud.ops]
        res["erreurs"] = {k: [e["text"][:200] for e in lg.errors()][:8] for k, lg in (("A", logA), ("B", logB), ("E", logE))}
        save_log(logA); save_log(logB); save_log(logE)
        ctxA.close(); ctxB.close(); ctxE.close(); b.close()

    (OUT / "resultat_inge_deux_artistes.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: res[k] for k in ("ok", "verifications")}, ensure_ascii=True, indent=1))
    for s in res["steps"]:
        print(("OK " if s["ok"] else "ECHEC ") + s["step"].encode("ascii", "replace").decode() + ("" if s["ok"] else "  -> " + s["err"].encode("ascii", "replace").decode()[:400]))
    return res


if __name__ == "__main__":
    r = run()
    sys.exit(0 if r["ok"] else 1)
