"""Collaboration de la piste d'accords (V20) dans de VRAIS navigateurs (headless, aucune fenêtre).

Deux pages : l'ARTISTE (A, appli Windows simulée) ouvre sa session et démarre
« En direct » ; l'INGÉ (B, navigateur) la rejoint par le lien d'invitation.
Serveur NOVA (daw-session : journal des opérations) et Supabase Realtime
(diffusion + présence) SIMULÉS en Python (qa/collab_sim.py), partagés par les
deux pages : rien ne part vers Supabase.

Tout se fait à la souris, dans le couloir d'accords (components/ChordLane) :
  1. A pose « Am » (clic dans le couloir, choix dans la fenêtre) → B le voit
     (même accord, même position) ; délai mesuré ;
  2. B change l'accord en « F » → A le voit ;
  3. B le supprime → il disparaît chez A ;
  4. A et B posent un accord AU MÊME ENDROIT presque en même temps (C chez A,
     G chez B) → les deux pages finissent avec le même résultat ;
  5. B recharge sa page : il retrouve les accords (journal rejoué).

Usage : NOVA_URL=http://127.0.0.1:3437/ python qa/collab_accords.py
Sorties : D:\\1 WORK\\CONTENU\\nova-finitions-accords\\collab\\
"""
import json, os, re, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-finitions-accords\collab")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3437/")
from qalib import *  # noqa
from gel_pre_effet import prepare, open_project_file  # noqa
from collab_sim import FakeNovaCloud, FakeRealtime, FakeBridgeV7, connect  # noqa
from collab_direct import artist_project, dismiss, wait_for, collab, open_panel, panel_text  # noqa


def chords_of(page):
    """Accords affichés dans le couloir : [(symbole, début s)]."""
    return page.evaluate("""() => [...document.querySelectorAll('[data-testid="chord-lane"] [data-chord-event]')]
        .map(e => [e.getAttribute('data-chord-event'), +e.getAttribute('data-start')]).sort((a, b) => a[1] - b[1])""")


def close_overlays(page):
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    x = page.locator("[aria-labelledby='collab-title']")
    if x.count():
        try:
            x.first.get_by_role("button", name=re.compile("Fermer", re.I)).first.click(timeout=1500)
        except Exception:
            page.keyboard.press("Escape")
        page.wait_for_timeout(300)


def lane_area(page):
    lane = page.get_by_test_id("chord-lane").locator("visible=true").first
    lane.wait_for(timeout=15000)
    return lane.locator("div.cursor-pointer").first


def click_lane_at(page, frac):
    """Clic dans le couloir, à `frac` de sa largeur visible (comme la souris)."""
    area = lane_area(page)
    box = area.bounding_box()
    page.mouse.click(box["x"] + box["width"] * frac, box["y"] + box["height"] / 2)
    page.get_by_test_id("chord-picker").wait_for(timeout=5000)


NAMES_EN = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']


def pick(page, symbol):
    """Choix dans la fenêtre : accords de la gamme s'il y en a, sinon fondamentale puis type (comme à la main)."""
    pk = page.get_by_test_id("chord-picker")
    btn = pk.locator(f"button[data-chord='{symbol}']")
    if not btn.count():
        root = re.match(r"^[A-G](#|b)?", symbol).group(0)
        pk.get_by_role("radiogroup", name="Fondamentale").get_by_role("radio").nth(NAMES_EN.index(root)).click()
    pk.locator(f"button[data-chord='{symbol}']").first.click()
    page.wait_for_timeout(100)


def click_chord(page, symbol):
    ev = page.locator(f"[data-testid='chord-lane'] [data-chord-event='{symbol}']").first
    box = ev.bounding_box()
    page.mouse.click(box["x"] + min(20, box["width"] / 3), box["y"] + box["height"] / 2)
    page.get_by_test_id("chord-picker").wait_for(timeout=5000)


def run():
    out = OUT
    res = {"name": "collab_accords", "ok": True, "steps": [], "mesures": {},
           "note": "Serveur NOVA (daw-session) et Supabase Realtime SIMULÉS (qa/collab_sim.py), protocole Phoenix réel côté navigateur ; gestes à la souris dans le couloir d'accords."}
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
        logA, logB = Log("artiste_accords"), Log("inge_accords")
        ctxA, A = new_page(b, "pc", logA)
        ctxB, B = new_page(b, "pc", logB)
        prepare(A, bridgeA, desktop=True)
        prepare(B, None, desktop=False)
        connect(A, cloud, rt, "A", "11111111-1111-4111-8111-111111111111", "lina@test.local")
        connect(B, cloud, rt, "B", "22222222-2222-4222-8222-222222222222", "max@test.local")

        def a_open():
            open_project_file(A, src, res, "A1_session_artiste")
            dismiss(A)
            open_panel(A)
            A.get_by_placeholder("Ton nom (affiché aux autres)").fill("Lina")
            A.get_by_role("button", name=re.compile("Démarrer la collaboration en direct")).click()
            wait_for(A, lambda: collab(A, "c.role()") == "artist", 60, what="collaboration ouverte chez l'artiste")
            sid = next(k for k, v in cloud.sessions.items() if v["manifest"])
            link["s"] = f"{sid}.{cloud.sessions[sid]['secret']}"
        step("A : ouvre sa session et démarre la collaboration en direct", a_open)

        def b_join():
            B.goto(f"{BASE}?session={link['s']}&role=engineer", wait_until="domcontentloaded")
            wait_for(B, lambda: collab(B, "c.role()") == "engineer", 60, what="B relié")
            dismiss(B)
            open_panel(B)
            s = wait_for(B, lambda: B.get_by_test_id("collab-members").locator("span.rounded-full").count() >= 2, 30, what="présence")
            wait_for(B, lambda: collab(B, "c.status().realtime") == "live" and collab(A, "c.status().realtime") == "live", 30, what="direct des deux côtés")
            close_overlays(A); close_overlays(B)
            lane_area(A); lane_area(B)
            shot(A, "A2_couloir_vide"); shot(B, "B1_couloir_vide")
            return {"presence_s": s, "accords_A": chords_of(A), "accords_B": chords_of(B)}
        step("B : rejoint par le lien (présence, direct), couloir d'accords visible des deux côtés", b_join)

        def a_place():
            click_lane_at(A, 0.30)
            shot(A, "A3_fenetre_poser_un_accord")
            t0 = time.time()
            pick(A, "Am")
            ca = chords_of(A)
            assert ca and ca[0][0] == "Am", f"accord non posé chez A : {ca}"
            wait_for(B, lambda: chords_of(B) == ca, 20, step=50, what="Am vu chez B")
            res["mesures"]["A_pose_vers_B_voit_s"] = round(time.time() - t0, 2)
            B.wait_for_timeout(300)
            shot(A, "A4_am_pose"); shot(B, "B2_am_recu")
            title = B.locator("[data-testid='chord-lane'] [data-chord-event='Am']").first.get_attribute("title")
            return {"A": ca, "B": chords_of(B), "infobulle_chez_B": title}
        step("A pose « Am » dans le couloir → B voit le même accord, au même endroit", a_place)

        def b_change():
            click_chord(B, "Am")
            t0 = time.time()
            pick(B, "F")
            cb = chords_of(B)
            assert cb and cb[0][0] == "F", f"changement non fait chez B : {cb}"
            wait_for(A, lambda: chords_of(A) == cb, 20, step=50, what="F vu chez A")
            res["mesures"]["B_change_vers_A_voit_s"] = round(time.time() - t0, 2)
            shot(A, "A5_f_recu")
            return {"A": chords_of(A), "B": cb}
        step("B change l'accord en « F » → A le voit", b_change)

        def b_delete():
            click_chord(B, "F")
            t0 = time.time()
            B.get_by_test_id("chord-delete").click()
            assert chords_of(B) == [], chords_of(B)
            wait_for(A, lambda: chords_of(A) == [], 20, step=50, what="suppression vue chez A")
            res["mesures"]["B_supprime_vers_A_voit_s"] = round(time.time() - t0, 2)
            return {"A": chords_of(A), "B": chords_of(B)}
        step("B supprime l'accord → il disparaît chez A", b_delete)

        def concurrent():
            # Les deux ouvrent la fenêtre au même endroit, puis choisissent presque ensemble.
            click_lane_at(A, 0.50)
            click_lane_at(B, 0.50)
            pick(A, "C")
            pick(B, "G")
            local = {"A": chords_of(A), "B": chords_of(B)}
            s = wait_for(A, lambda: chords_of(A) == chords_of(B) and len(chords_of(A)) > 0, 20, step=100, what="même résultat des deux côtés")
            A.wait_for_timeout(1500)  # plus rien ne bouge ensuite
            fin = {"A": chords_of(A), "B": chords_of(B)}
            assert fin["A"] == fin["B"], fin
            shot(A, "A6_simultane_resultat"); shot(B, "B3_simultane_resultat")
            ops = [o for o in cloud.ops if o["kind"] == "chords"]
            return {"juste_apres_les_clics": local, "converge_en_s": s, "final": fin,
                    "dernier_dans_le_journal": ops[-1]["author_name"] if ops else None}
        step("A (C) et B (G) posent au même endroit en même temps → même résultat partout", concurrent)

        def b_reload():
            before = chords_of(A)
            B.goto(f"{BASE}?session={link['s']}", wait_until="domcontentloaded")
            wait_for(B, lambda: collab(B, "c.role()") == "engineer", 60, what="collaboration reprise")
            dismiss(B); close_overlays(B)
            try:
                wait_for(B, lambda: chords_of(B) == before, 30, what="accords retrouvés après rechargement")
            except AssertionError:
                shot(B, "B4_ECHEC_recharge")
                raise AssertionError(f"accords non retrouvés : A={before} B={chords_of(B)} couloir={B.get_by_test_id('chord-lane').count()} "
                                     f"statut={collab(B, 'c.status()')} lastSeq={B.evaluate('() => window.__novaCollab && window.__novaCollab.status()')}")
            shot(B, "B4_recharge_accords_retrouves")
            return {"A": before, "B": chords_of(B)}
        step("B recharge sa page → il retrouve les accords de la session", b_reload)

        res["A_erreurs"] = [e["text"][:200] for e in logA.errors()][:12]
        res["B_erreurs"] = [e["text"][:200] for e in logB.errors()][:12]
        res["ops_accords"] = [{"seq": o["seq"], "par": o["author_name"], "op": o["op"]} for o in cloud.ops if o["kind"] == "chords"]
        res["ecritures_bloquees"] = (A._blocked + B._blocked)[:20]
        save_log(logA); save_log(logB)
        ctxA.close(); ctxB.close(); b.close()

    (out / "resultat_collab_accords.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: res[k] for k in ("ok", "steps", "mesures")}, ensure_ascii=False, indent=1)[:9000])
    return res


if __name__ == "__main__":
    r = run()
    sys.exit(0 if r["ok"] else 1)
