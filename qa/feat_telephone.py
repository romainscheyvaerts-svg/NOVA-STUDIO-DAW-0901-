"""Panneau Collaboration sur téléphone (432 px, tactile) : lisible, rien qui déborde.

Un navigateur headless (aucune fenêtre), serveur simulé. L'artiste démarre
une collaboration sur son téléphone ; on capture le panneau et on relève les
débordements et la taille des zones à toucher.

Usage : NOVA_URL=http://127.0.0.1:3423/ python qa/feat_telephone.py
"""
import json, os, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-collab-artistes\telephone")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3423/")
from qalib import *  # noqa
from gel_pre_effet import prepare  # noqa
from collab_sim import FakeNovaCloud, FakeRealtime, connect  # noqa
from feat_lib import *  # noqa


def run():
    res = {"name": "feat_telephone", "ok": True}
    cloud, rt = FakeNovaCloud(per_device=True, codes=True), FakeRealtime()
    src = OUT / "00_session.novaproj.zip"
    feat_project(src)
    with sync_playwright() as p:
        b = launch(p)
        log = Log("telephone")
        ctx, A = new_page(b, "tel", log)
        A.add_init_script(REC_INIT)
        prepare(A, None, desktop=False)
        connect(A, cloud, rt, "A", "11111111-1111-4111-8111-111111111111", "leo@test.local")
        open_project_file(A, src, res, "T1_session")
        dismiss(A)
        open_panel(A)
        shot(A, "T2_choix")
        A.get_by_placeholder("Ton nom (affiché aux autres)").fill("Léo")
        A.get_by_role("button", name="Démarrer la collaboration en direct").click()
        wait_for(A, lambda: collab(A, "c.role()") == "artist", 60, what="collaboration ouverte")
        A.wait_for_timeout(2500)
        dismiss(A)
        open_panel(A)
        A.wait_for_timeout(500)
        shot(A, "T3_panneau_actif")
        A.get_by_test_id("collab-scroll").evaluate("e => e.scrollTo(0, e.scrollHeight)")
        A.wait_for_timeout(300)
        shot(A, "T4_panneau_bas")
        res["debordements"] = overflow_report(A)
        res["petites_cibles"] = A.evaluate("""() => Array.from(document.querySelectorAll("[aria-labelledby='collab-title'] button, [aria-labelledby='collab-title'] input"))
          .filter(e => e.getClientRects().length).map(e => { const r = e.getBoundingClientRect(); return { t: (e.innerText || e.getAttribute('aria-label') || e.placeholder || '').trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) }; })
          .filter(x => x.h < 36 && x.t !== 'Quitter la collaboration')""")
        panel_box = A.locator("[aria-labelledby='collab-title']").bounding_box()
        res["panneau"] = panel_box
        res["ok"] = not [d for d in res["debordements"] if d["kind"] == "page-hscroll"] and panel_box["x"] >= 0 and panel_box["x"] + panel_box["width"] <= 432
        res["erreurs"] = [e["text"][:200] for e in log.errors()][:8]
        ctx.close(); b.close()
    (OUT / "resultat_telephone.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(res, ensure_ascii=True, indent=1)[:3000])
    return res


if __name__ == "__main__":
    r = run()
    sys.exit(0 if r["ok"] else 1)
