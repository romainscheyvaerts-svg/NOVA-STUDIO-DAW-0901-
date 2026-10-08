"""Audit UX du piano roll (constat R5) : PC, tablette et téléphone, thèmes sombre et clair.

Navigateur headless, aucune fenêtre. Pour chaque écran : capture, puis qa/ux_audit.js
limité au piano roll ([data-nova-pianoroll]) : cibles tactiles sous 40 px (tablette et
téléphone), contrastes WCAG rendus, mots anglais. Vérifie aussi la gamme du morceau
(lignes hors gamme marquées, aimant, « seulement la gamme ») et le clavier de
l'ordinateur (A = Do, Z / X = octave, C / V = vélocité).

Usage : NOVA_URL=http://127.0.0.1:3441/ python qa/pianoroll_ux.py [pc] [tab] [tel] [dark] [light]
Sorties : D:\\1 WORK\\CONTENU\\nova-finitions-3\\roll_*.png / pianoroll_ux.json
"""
import json, os, re, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-finitions-3")
from qalib import launch, new_page, Log, BASE, OUT  # noqa: E402
from scenarios import close_welcome, wait_text_gone  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

AUDIT_JS = "\n".join(l for l in (Path(__file__).parent / "ux_audit.js").read_text(encoding="utf-8").splitlines() if not l.startswith("//"))
INIT = ("try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_welcome_seen', '1');"
        " localStorage.setItem('nova_simple_mode', '0'); localStorage.setItem('nova_theme', '{theme}'); } catch (e) {}")
ROLL = "[data-nova-pianoroll]"


def open_roll(pg):
    pg.goto(BASE, wait_until="domcontentloaded")
    pg.get_by_text("Mélodies", exact=False).first.click(timeout=40000)
    pg.wait_for_timeout(1500)
    pg.get_by_text("Neon Storm", exact=False).first.click()
    pg.wait_for_timeout(1500)
    close_welcome(pg)
    wait_text_gone(pg, "Chargement", 60)
    pg.wait_for_timeout(1500)
    close_welcome(pg)
    drums = pg.locator("[aria-labelledby='drums-title']")
    if drums.count():
        cl = drums.locator("button[aria-label^='Fermer'], button[title^='Fermer']")
        if cl.count(): cl.first.click()
        else: pg.keyboard.press("Escape")
        pg.wait_for_timeout(600)
    pg.locator("button[title^='Nouvelle piste MIDI']").first.click()
    pg.locator(ROLL).first.wait_for(timeout=10000)
    pg.wait_for_timeout(800)


def close_menu(pg):
    """Touche le voile du menu, en bas de l'écran (en haut à gauche, la barre de l'appli passe dessus)."""
    vs = pg.viewport_size
    pg.mouse.click(vs["width"] // 2, vs["height"] - 4); pg.wait_for_timeout(250)


def audit(pg, touch, root=ROLL):
    return pg.evaluate(AUDIT_JS, {"touch": touch, "root": root})


def clavier_midi(pg):
    """Clavier de l'ordinateur = clavier MIDI : A joue Do3, Z / X = octave, C / V = vélocité, S ne coupe pas de clip."""
    clips = "() => (window.__novaEdit?.getState().tracks || []).reduce((n, t) => n + (t.clips || []).length, 0)"
    bandeau = lambda: pg.locator("[data-nova-roll='bandeau']").first.inner_text()  # noqa: E731
    pg.locator("[data-nova-roll='clavier']").first.click(); pg.wait_for_timeout(300)
    out = {"au_depart": bandeau()}
    n0 = pg.evaluate(clips)
    pg.keyboard.down("a"); pg.wait_for_timeout(200); out["a_tenu"] = bandeau(); pg.keyboard.up("a")
    pg.keyboard.press("z"); pg.wait_for_timeout(150); out["apres_z"] = bandeau()
    pg.keyboard.press("x"); pg.keyboard.press("x"); pg.wait_for_timeout(150); out["apres_x_x"] = bandeau()
    pg.keyboard.press("v"); pg.wait_for_timeout(150); out["apres_v"] = bandeau()
    pg.keyboard.press("c"); pg.keyboard.press("c"); pg.wait_for_timeout(150); out["apres_c_c"] = bandeau()
    pg.keyboard.press("s"); pg.wait_for_timeout(300)
    out["clips_avant_apres_s"] = [n0, pg.evaluate(clips)]
    pg.screenshot(path=str(OUT / "roll_pc_clavier_midi.png"))
    pg.locator("[data-nova-roll='clavier']").first.click(); pg.wait_for_timeout(200)
    out["ok"] = ("Do3" in out["au_depart"] and out["a_tenu"].count("Do3") >= 2 and "Do2" in out["apres_z"]
                 and "Do4" in out["apres_x_x"] and "127" in out["apres_v"] and "80" in out["apres_c_c"]
                 and out["clips_avant_apres_s"][0] == out["clips_avant_apres_s"][1])
    return out


def run(vps, themes):
    res = {"ok": True, "ecrans": {}, "fonctions": {}}
    with sync_playwright() as p:
        b = launch(p)
        for vp in vps:
            for theme in themes:
                name = f"{vp}_{theme}"
                log = Log(name)
                ctx, pg = new_page(b, vp, log)
                pg.add_init_script(INIT.replace("{theme}", theme))
                touch = vp != "pc"
                open_roll(pg)
                pg.screenshot(path=str(OUT / f"roll_{name}_1.png"))
                a = audit(pg, touch)
                # Menu de la gamme (tonalité, surlignage, aimant, seulement la gamme).
                pg.locator("[data-nova-roll='gamme']").first.click(); pg.wait_for_timeout(300)
                pg.get_by_label("Note de la tonalité").select_option("9"); pg.wait_for_timeout(150)
                pg.get_by_label("Gamme", exact=True).select_option("MINOR"); pg.wait_for_timeout(300)
                pg.screenshot(path=str(OUT / f"roll_{name}_2_gamme.png"))
                menu = audit(pg, touch, "[data-nova-roll-menu='scale']")
                gamme_txt = pg.locator("[data-nova-roll='gamme']").first.inner_text()
                # Échap fermerait le piano roll : on touche à côté du menu.
                close_menu(pg)
                rows = pg.evaluate(f"""() => {{ const r = document.querySelector("{ROLL}");
                  return {{ hors: r.querySelectorAll('[data-hors-gamme-ligne="1"]').length, dans: r.querySelectorAll('[data-hors-gamme-ligne="0"]').length }}; }}""")
                # Menus : accords, quantification ; panneau Outils (PC et tablette).
                pg.locator("[data-nova-roll='accords']").first.click(); pg.wait_for_timeout(300)
                accords = audit(pg, touch, "[data-nova-roll-menu='chord']")
                pg.screenshot(path=str(OUT / f"roll_{name}_3_accords.png"))
                close_menu(pg)
                pg.locator(f"{ROLL} button[title='Grille de quantification et force']").first.click(); pg.wait_for_timeout(300)
                quant = audit(pg, touch, f"{ROLL} [data-nova-roll-menu='quantize']")
                pg.screenshot(path=str(OUT / f"roll_{name}_4_quantification.png"))
                quant["visible"] = pg.evaluate("""() => { const m = document.querySelector("[data-nova-roll-menu='quantize']"); if (!m) return false;
                  const r = m.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + 20); return !!e && m.contains(e); }""")
                if not quant["visible"]:
                    res["ok"] = False
                close_menu(pg)
                outils = {}
                if pg.locator("[data-nova-roll='outils']").first.is_visible():
                    pg.locator("[data-nova-roll='outils']").first.click(); pg.wait_for_timeout(400)
                    outils = audit(pg, touch, "[data-nova-roll-menu='outils']")
                    pg.screenshot(path=str(OUT / f"roll_{name}_5_outils.png"))
                    close_menu(pg)
                if vp == "pc" and theme == themes[0]:
                    res["fonctions"]["gamme"] = {"bouton": gamme_txt, "lignes": rows, "ok": "La mineur" in gamme_txt and rows["hors"] > 0 and rows["dans"] > 0}
                    res["fonctions"]["clavier_midi"] = clavier_midi(pg)
                    for f in res["fonctions"].values():
                        if not f.get("ok"):
                            res["ok"] = False
                ecran = {k: v for k, v in a.items() if v}
                menus = {"gamme": menu, "accords": accords, "quantification": quant, "outils": outils}
                menus = {m: {k: v for k, v in d.items() if v and k != "visible"} for m, d in menus.items()}
                menus = {m: d for m, d in menus.items() if d}
                res["ecrans"][name] = {"roll": ecran, "menus": menus, "erreurs_console": [e["text"][:200] for e in log.errors()]}
                bad = any(ecran.get(k) for k in ("petits", "contraste", "anglais")) or any(d.get(k) for d in menus.values() for k in ("petits", "contraste", "anglais")) or log.errors()
                if bad:
                    res["ok"] = False
                print(name, "OK" if not bad else "", json.dumps({"roll": ecran, "menus": menus}, ensure_ascii=False)[:1500], flush=True)
                ctx.close()
    (OUT / "pianoroll_ux.json").write_text(json.dumps(res, indent=2, ensure_ascii=False), encoding="utf-8")
    return res


if __name__ == "__main__":
    a = sys.argv[1:]
    run([v for v in a if v in ("pc", "tab", "tel")] or ["pc", "tab", "tel"], [t for t in a if t in ("dark", "light")] or ["dark", "light"])
