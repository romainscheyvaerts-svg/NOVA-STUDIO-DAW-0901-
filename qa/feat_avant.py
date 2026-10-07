"""Constat AVANT les changements : deux artistes dans la même session « En direct ».

Deux navigateurs headless (aucune fenêtre), serveur NOVA et Realtime simulés
(qa/collab_sim.py). L'artiste A (Léo) démarre la collaboration ; l'artiste B
(Sam) arrive par le lien d'invitation « artiste ». Chacun appuie sur REC
(micro simulé) en même temps, puis on regarde ce que chacun a.

Usage :
  NOVA_URL=http://127.0.0.1:3423/ python qa/feat_avant.py
"""
import json, os, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-collab-artistes\avant")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3423/")
from qalib import *  # noqa
from gel_pre_effet import prepare  # noqa
from collab_sim import FakeNovaCloud, FakeRealtime, connect  # noqa
from feat_lib import *  # noqa


def run():
    res = {"name": "feat_avant", "steps": [], "constats": {}}
    cloud, rt = FakeNovaCloud(), FakeRealtime()
    src = OUT / "00_session_leo.novaproj.zip"
    feat_project(src)
    link = {}

    def step(label, fn):
        t = time.time()
        try:
            o = fn()
            res["steps"].append({"step": label, "ok": True, "s": round(time.time() - t, 1), **({"info": o} if o else {})})
        except Exception as e:  # noqa
            res["steps"].append({"step": label, "ok": False, "err": f"{type(e).__name__}: {str(e)[:400]}"})

    with sync_playwright() as p:
        b = launch(p)
        logA, logB = Log("avant_A"), Log("avant_B")
        ctxA, A = new_page(b, "pc", logA)
        ctxB, B = new_page(b, "pc", logB)
        for page in (A, B):
            page.add_init_script(REC_INIT)
            prepare(page, None, desktop=False)
        connect(A, cloud, rt, "A", "11111111-1111-4111-8111-111111111111", "leo@test.local")
        connect(B, cloud, rt, "B", "33333333-3333-4333-8333-333333333333", "sam@test.local")

        def a_start():
            open_project_file(A, src, res, "AV1_leo_session")
            dismiss(A)
            open_panel(A)
            A.get_by_placeholder("Ton nom (affiché aux autres)").fill("Léo")
            A.get_by_role("button", name="Démarrer la collaboration en direct").click()
            wait_for(A, lambda: collab(A, "c.role()") == "artist", 60, what="collaboration ouverte chez Léo")
            sid = next(k for k, v in cloud.sessions.items() if v["manifest"])
            link["s"] = f"{sid}.{cloud.sessions[sid]['secret']}"
        step("Léo démarre la collaboration", a_start)

        def b_join():
            B.goto(f"{BASE}?session={link['s']}&role=artist", wait_until="domcontentloaded")
            wait_for(B, lambda: collab(B, "c.role()") == "artist", 60, what="Sam relié")
            dismiss(B)
            B.wait_for_timeout(2500)
            open_panel(A); open_panel(B)
            shot(A, "AV2_leo_panneau"); shot(B, "AV3_sam_panneau")
            return {"membres_vus_par_leo": A.get_by_test_id("collab-members").inner_text(), "membres_vus_par_sam": B.get_by_test_id("collab-members").inner_text(),
                    "panneau_sam": panel_text(B)[:400]}
        step("Sam rejoint par le lien « artiste »", b_join)

        def both_record():
            close_panel(A); close_panel(B)
            A.keyboard.press("Escape"); B.keyboard.press("Escape")
            rec_button(A).click(); rec_button(B).click()
            A.wait_for_timeout(3000)
            rec_button(A).click(); rec_button(B).click()
            A.wait_for_timeout(1500)
            return {"leo": tracks(A), "sam": tracks(B)}
        step("Léo et Sam appuient sur REC en même temps (3 s)", both_record)

        def after_sync():
            A.wait_for_timeout(26000)
            shot(A, "AV4_leo_apres_synchro"); shot(B, "AV5_sam_apres_synchro")
            return {"leo": tracks(A), "sam": tracks(B)}
        step("Après la synchronisation (10 s + rattrapage)", after_sync)

        res["ops"] = [{k: o[k] for k in ("seq", "role", "kind", "member_key")} | {"trackId": (o["op"] or {}).get("trackId")} for o in cloud.ops]
        res["instantanes_ecrits"] = [x for x in cloud.log if x[1] == "commit"]
        res["A_erreurs"] = [e["text"][:200] for e in logA.errors()][:10]
        res["B_erreurs"] = [e["text"][:200] for e in logB.errors()][:10]
        save_log(logA); save_log(logB)
        ctxA.close(); ctxB.close(); b.close()

    (OUT / "resultat_feat_avant.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(res, ensure_ascii=True, indent=1)[:12000])
    return res


if __name__ == "__main__":
    run()
