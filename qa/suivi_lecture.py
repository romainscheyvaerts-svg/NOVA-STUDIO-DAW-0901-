"""▶ Suivi de la tête de lecture (arrangement) + « Dupliquer » au téléphone. 100 % hors production.

Supabase simulé (qa_hors_prod via qalib), navigateur headless, beat de démonstration.

Cas :
  pc_sombre / pc_clair (1366 × 768) :
    1. zoom au maximum, lecture : la vue AVANCE seule avec la tête de lecture (suivi actif) ;
    2. défilement à la main (molette horizontale) pendant la lecture : le suivi se SUSPEND
       (data-follow="suspendu"), la vue reste où on l'a mise alors que la tête sort de l'écran ;
       le bouton « Suivre » apparaît, rien de recouvert ;
    3. « Suivre » : la vue rejoint la tête de lecture, le suivi reprend ;
    4. Ctrl + molette (zoom) pendant la lecture : ne suspend PAS le suivi ;
    5. défilement à la main puis Stop / Play : le prochain Play repart en suivi.
  tel_sombre / tel_clair (390 × 844, au doigt) : page Arrangement du téléphone, clip du beat choisi,
    « DUP » → le clip est VRAIMENT dupliqué (un clip de plus sur la piste, juste après) et le message le dit.

  NOVA_URL=http://127.0.0.1:3426/ PYTHONIOENCODING=utf-8 python qa/suivi_lecture.py [cas ...]
Sorties : D:\\1 WORK\\CONTENU\\nova-152\\nettoyage\\qa (captures + suivi_lecture.json)
"""
import json
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-152\nettoyage\qa")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import qalib  # noqa: E402  (Supabase simulé, production bloquée)
from qalib import launch, new_page, Log, save_log, balayage_chevauchement  # noqa: E402
from scenarios import close_welcome, wait_text_gone, DEFAULT_BEAT  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = qalib.BASE
OUT = Path(os.environ["QA_OUT"])
OUT.mkdir(parents=True, exist_ok=True)

CASES = {
    "pc_sombre": {"vp": "pc1366", "theme": "dark"},
    "pc_clair": {"vp": "pc1366", "theme": "light"},
    "tel_sombre": {"vp": "tel390", "theme": "dark"},
    "tel_clair": {"vp": "tel390", "theme": "light"},
}
res = {"cas": {}}

VIEW_JS = """() => {
  const sc = document.querySelector('[data-follow]');
  if (!sc) return null;
  const st = window.DAW_CONTROL.getState();
  const zoom = +(sc.dataset.zoomH || 0);
  return { follow: sc.dataset.follow, left: sc.scrollLeft, width: sc.clientWidth, t: st.currentTime, playing: st.isPlaying, zoom };
}"""


def run_case(p, case, vp, theme):
    log = Log(f"suivi_{case}")
    tel = vp.startswith("tel")
    r = {"vp": vp, "theme": theme, "ok": True, "checks": [], "captures": []}
    res["cas"][case] = r

    def check(label, cond, extra=""):
        r["checks"].append({"label": label, "ok": bool(cond), **({"extra": str(extra)[:400]} if extra not in ("", None) else {})})
        if not cond:
            r["ok"] = False
        print(("OK  " if cond else "KO  ") + f"[{case}] {label}" + ("" if cond else f"  → {str(extra)[:300]}"), flush=True)

    def snap(tag):
        path = OUT / f"suivi_{case}_{tag}.png"
        page.screenshot(path=str(path))
        r["captures"].append(path.name)

    def view():
        return page.evaluate(VIEW_JS)

    def playhead_in_view(v):
        x = v["t"] * v["zoom"]
        return v["left"] - 2 <= x <= v["left"] + v["width"]

    def wait_until(fn, timeout_s=12):
        t0 = time.time()
        while time.time() - t0 < timeout_s:
            v = view()
            if v and fn(v):
                return v
            page.wait_for_timeout(250)
        return view()

    def play(on):
        if bool(view()["playing"]) != on:
            page.evaluate("() => window.DAW_CONTROL.togglePlay()")
        page.wait_for_timeout(500)

    b = launch(p)
    ctx, page = new_page(b, vp, log)
    ctx.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); }} catch (e) {{}}")
    try:
        page.goto(BASE, wait_until="domcontentloaded")
        page.get_by_text(DEFAULT_BEAT, exact=True).first.wait_for(timeout=40000)
        page.get_by_text(DEFAULT_BEAT, exact=True).first.click()
        page.wait_for_timeout(1500)
        close_welcome(page)
        wait_text_gone(page, "Chargement", 60)
        close_welcome(page)
        page.wait_for_timeout(1500)

        if tel:
            tab = page.locator("[data-testid=mobile-tab-ARRANGEMENT], [data-nova-target=tab-ARRANGEMENT]").locator("visible=true")
            if tab.count():
                tab.first.tap()
                page.wait_for_timeout(800)
            st = page.evaluate("() => window.DAW_CONTROL.getState().tracks.map(t => ({ id: t.id, n: t.clips.length, clips: t.clips.map(c => c.id) }))")
            beat = next((t for t in st if t["n"] > 0), None)
            check("téléphone : un clip à dupliquer (beat)", beat is not None, st)
            if not beat:
                return
            clip = page.locator(f"[data-clip-id='{beat['clips'][0]}']").locator("visible=true").first
            clip.tap()
            page.wait_for_timeout(500)
            dup = page.locator("[data-testid=mobile-dup]").locator("visible=true")
            check("téléphone : bouton DUP présent quand un clip est choisi", dup.count() > 0)
            if not dup.count():
                snap("pas_de_dup")
                return
            snap("1_clip_choisi")
            dup.first.tap()
            page.wait_for_timeout(700)
            after = page.evaluate("(id) => { const t = window.DAW_CONTROL.getState().tracks.find(x => x.id === id); return t.clips.map(c => ({ id: c.id, start: c.start, dur: c.duration })); }", beat["id"])
            check("téléphone : DUP a VRAIMENT ajouté un clip sur la piste", len(after) == beat["n"] + 1, after)
            src = next((c for c in after if c["id"] == beat["clips"][0]), None)
            new = [c for c in after if c["id"] not in beat["clips"]]
            check("téléphone : la copie est posée juste après le clip", bool(src and new and new[0]["start"] >= src["start"] + src["dur"] - 0.001), {"src": src, "new": new})
            body = page.locator("body").inner_text()
            check("téléphone : message « Clip dupliqué juste après »", "Clip dupliqué juste après" in body)
            bal = balayage_chevauchement(page)
            check("téléphone : aucun bouton recouvert", not bal.get("recouverts") and not bal.get("erreur"), bal)
            snap("2_duplique")
            return

        sc = page.locator("[data-follow]").first
        sc.wait_for(timeout=15000)
        # Zoom au maximum (curseur de zoom, comme à la main) et tête de lecture au début.
        # Curseur logarithmique depuis le 22/10/2026 (1 à 48 000 px/s) : la position de 300 px/s.
        page.evaluate("""() => { const el = [...document.querySelectorAll('[data-testid="zoom-slider"]')].find(e => e.offsetParent);
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, String(Math.round(1000 * Math.log(300) / Math.log(48000))));
          el.dispatchEvent(new Event('input', { bubbles: true })); window.DAW_CONTROL.seek(0); }""")
        page.wait_for_timeout(500)
        v0 = view()
        check("zoom serré (300 px/s)", v0["zoom"] >= 290, v0)
        check("suivi actif au départ", v0["follow"] == "actif", v0)

        # 1. La vue avance seule pendant la lecture.
        play(True)
        v1 = wait_until(lambda v: v["left"] > 50, 15)
        check("1. lecture : la vue avance seule avec la tête de lecture", v1["left"] > 50 and v1["follow"] == "actif", v1)

        # 2. Molette horizontale pendant la lecture : suivi suspendu, la vue ne bouge plus.
        box = sc.bounding_box()
        page.mouse.move(box["x"] + box["width"] * 0.6, box["y"] + box["height"] * 0.5)
        page.mouse.wheel(-3000, 0)
        page.wait_for_timeout(500)
        v2 = view()
        check("2. défilement à la main pendant la lecture : suivi suspendu", v2["follow"] == "suspendu", v2)
        left_fige = v2["left"]
        v2b = wait_until(lambda v: not playhead_in_view(v), 15)
        page.wait_for_timeout(1500)
        v2c = view()
        check("2. la tête de lecture sort de l'écran sans ramener la vue de force", (not playhead_in_view(v2c)) and abs(v2c["left"] - left_fige) < 2, {"fige": left_fige, "apres": v2c})
        suivre = page.locator("[data-testid=follow-playhead]").locator("visible=true")
        check("2. bouton « Suivre » affiché", suivre.count() == 1)
        bal = balayage_chevauchement(page)
        check("2. aucun bouton recouvert", not bal.get("recouverts") and not bal.get("erreur"), bal)
        snap("1_suivi_suspendu")

        # 3. « Suivre » : la vue rejoint la tête de lecture.
        if suivre.count():
            suivre.first.click()
        v3 = wait_until(lambda v: v["follow"] == "actif" and playhead_in_view(v), 6)
        check("3. « Suivre » : la vue rejoint la tête de lecture, suivi repris", v3["follow"] == "actif" and playhead_in_view(v3), v3)
        check("3. le bouton « Suivre » disparaît", page.locator("[data-testid=follow-playhead]").locator("visible=true").count() == 0)
        snap("2_suivi_repris")

        # 4. Ctrl + molette (zoom) : pas une suspension.
        page.mouse.move(box["x"] + box["width"] * 0.6, box["y"] + box["height"] * 0.5)  # le clic sur « Suivre » a déplacé la souris
        page.keyboard.down("Control")
        page.mouse.wheel(0, 200)
        page.keyboard.up("Control")
        page.wait_for_timeout(800)
        v4 = view()
        check("4. Ctrl + molette (zoom) pendant la lecture : le suivi reste actif", v4["follow"] == "actif", v4)

        # 5. Défiler à la main (vers la droite : à gauche, la vue peut déjà être au début), puis Stop / Play.
        page.mouse.wheel(3000, 0)
        page.wait_for_timeout(400)
        check("5. défilement à la main : suspendu", view()["follow"] == "suspendu", view())
        play(False)
        play(True)
        v5 = view()
        check("5. nouveau Play : suivi repris tout seul", v5["follow"] == "actif", v5)
        play(False)
    except Exception as e:  # noqa: BLE001
        check("scénario sans exception", False, repr(e))
        try:
            snap("exception")
        except Exception:
            pass
    finally:
        r["erreurs_console"] = [e["text"] for e in log.errors()][:10]
        save_log(log)
        ctx.close()
        b.close()


def main():
    names = [a for a in sys.argv[1:] if a in CASES] or list(CASES)
    t0 = time.time()
    with sync_playwright() as p:
        for n in names:
            run_case(p, n, **CASES[n])
    ok = all(c["ok"] for c in res["cas"].values())
    res["ok"] = ok
    res["duree_s"] = round(time.time() - t0, 1)
    (OUT / "suivi_lecture.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(("TOUT VERT" if ok else "ÉCHECS") + f" : {sum(len(c['checks']) for c in res['cas'].values())} vérifications, {res['duree_s']} s", flush=True)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
