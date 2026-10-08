"""Palette de commandes (Ctrl+K) : chaque action se trouve par son nom et se lance.

Pour chaque recherche (mots d'un ingé : « export », « tempo », « bus », « strip », « melodyne »…),
la palette doit proposer la bonne action EN PREMIER, Entrée doit l'exécuter (fenêtre ouverte,
piste créée, vue changée…), et Échap doit fermer la palette. Mesures : temps d'ouverture de la
palette, temps jusqu'à la fenêtre visée, nombre de touches. PC (clavier), tablette (loupe au
doigt), thème sombre et clair. Chrome headless (aucune fenêtre), aucune écriture externe.

NOVA_URL=http://127.0.0.1:3491/ QA_PHASE=apres PYTHONIOENCODING=utf-8 python qa/palette_commandes.py
Sorties : D:\\1 WORK\\CONTENU\\nova-pro\\<phase>\\palette\\ (palette_commandes.json + captures)
"""
import json, os, sys, time
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3491/")
PHASE = os.environ.get("QA_PHASE", "apres")
os.environ.setdefault("QA_OUT", rf"D:\1 WORK\CONTENU\nova-pro\{PHASE}\palette")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, OUT, Log  # noqa: E402
from nova_pro_lib import clip_point  # noqa: E402
from desktop_gate import install_mocks, SUPERADMIN  # noqa: E402
_r1 = (Path(__file__).parent / "r1_export.py").read_text(encoding="utf-8").split("\nwith sync_playwright() as p:")[0]
exec(compile(_r1, "r1_export.py", "exec"))  # make_project, open_with_project…
from playwright.sync_api import sync_playwright  # noqa: E402

PAL = "[data-testid=command-palette]"
# (recherche, id attendu en 1er, vérification JS après Entrée)
CASES = [
    ("export", "nova.export", "() => !!document.querySelector('[role=dialog][aria-labelledby=export-title]')"),
    ("tempo", "pal.tempo", "() => /TEMPO ET MESURE/i.test(document.body.innerText)"),
    ("bus", "pal.bus", "() => window.__novaEdit.getState().tracks.length > window.__nTracks"),
    ("reverbe", "pal.reverbReturn", "() => window.__novaEdit.getState().tracks.some(t => t.name === 'REVERB' && t.type === 'SEND')"),
    ("strip silence", "pt.stripSilence", None),
    ("separer", "pt.split", None),
    ("master", "pal.masterNova", "() => !!document.querySelector('[data-nova-master]')"),
    ("lufs", "pal.loudness", "() => /Loudness du master/.test(document.body.innerText)"),
    ("mix auto", "pal.mixAuto", "() => /Mix auto de ta voix/.test(document.body.innerText)"),
    ("console", "view.mixer", "() => /MASTER/.test(document.body.innerText)"),
    ("arrangement", "view.arrangement", None),
    ("repere", "pal.memory", "() => !!document.querySelector('[data-testid=memory-locations]')"),
    ("preset voix lead", "pal.trackPreset", None),
    ("melodyne", "pal.melodyne", None),
    ("modele", "pal.templates", None),
    ("casque", "pal.cue", None),
    ("groupe", "pal.groups", "() => /Groupes/.test(document.body.innerText)"),
    ("raccourcis", "nova.help", None),
]
res = {"phase": PHASE, "cas": [], "echecs": []}


def open_palette(page, how):
    t = time.time()
    if how == "clavier":
        page.keyboard.press("Control+k")
    else:
        page.locator("[data-testid=open-palette]").locator("visible=true").first.tap()
    page.locator(PAL).wait_for(timeout=5000)
    return round((time.time() - t) * 1000)


def run(page, log, how, theme):
    page.evaluate("""async (theme) => { const { themeStore } = await window.__novaAppModule('/utils/themeStore.ts'); themeStore.setPref(theme); }""", theme)
    page.wait_for_timeout(300)
    for q, want, check in CASES:
        if want in ("pt.stripSilence", "pt.split", "pal.melodyne", "pal.trackPreset"):
            x, y = clip_point(page, 1, 3.0)
            page.mouse.click(x, y); page.wait_for_timeout(150)
        page.evaluate("() => { window.__nTracks = window.__novaEdit.getState().tracks.length; }")
        ms_open = open_palette(page, how)
        n = page.locator(f"{PAL} [role=option]").count()
        page.keyboard.type(q, delay=15)
        page.wait_for_timeout(150)
        first = page.locator(f"{PAL} [role=option]").first.get_attribute("data-palette-id")
        if q == CASES[0][0]:
            page.screenshot(path=str(OUT / f"palette_{how}_{theme}_{q.replace(' ', '_')}.png"))
        t = time.time()
        page.keyboard.press("Enter")
        page.wait_for_timeout(120)
        closed = page.locator(PAL).count() == 0
        ok_check = None
        if check:
            ok_check = False
            for _ in range(40):
                if page.evaluate(check): ok_check = True; break
                page.wait_for_timeout(100)
        ms_action = round((time.time() - t) * 1000)
        pb = []
        if first != want: pb.append(f"1er résultat {first} au lieu de {want}")
        if not closed: pb.append("palette restée ouverte")
        if ok_check is False: pb.append("l'action n'a pas eu lieu")
        item = {"mode": how, "theme": theme, "recherche": q, "attendu": want, "premier": first, "nb_actions": n, "ms_ouverture": ms_open,
                "ms_action": ms_action if check else None, "touches": 1 + len(q) + 1, "ok": not pb, "problemes": pb}
        res["cas"].append(item)
        if pb: res["echecs"].append(f"{how}/{theme}/{q}")
        print(("OK  " if not pb else "KO  ") + f"{how}/{theme} « {q} » → {first} ({n} actions, palette {ms_open} ms" + (f", action {ms_action} ms" if check else "") + ")", " | ".join(pb))
        # Retour à un état neutre : fenêtres fermées, arrangement.
        for _ in range(3):
            page.keyboard.press("Escape"); page.wait_for_timeout(120)
        if q == "console":
            page.keyboard.press("Control+Equal"); page.wait_for_timeout(300)
    # Échap ferme la palette sans rien lancer.
    open_palette(page, how)
    page.keyboard.type("tempo")
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    esc = page.locator(PAL).count() == 0 and not page.evaluate("() => /TEMPO ET MESURE/i.test(document.body.innerText)")
    res["cas"].append({"mode": how, "theme": theme, "recherche": "(Échap)", "ok": esc})
    if not esc: res["echecs"].append(f"{how}/{theme}/echap")
    print(("OK  " if esc else "KO  ") + f"{how}/{theme} Échap ferme la palette sans rien lancer")


with sync_playwright() as p:
    b = launch(p)
    z = OUT / "palette.zip"; make_project(z)
    for vp, how, themes in (("pc", "clavier", ("dark", "light")), ("tab", "doigt", ("dark",))):
        log = Log("palette")
        ctx, page = new_page(b, vp, log=log)
        page.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
        install_mocks(page, "romain", SUPERADMIN, {})
        open_with_project(page, z)
        page.mouse.click(5, 300); page.keyboard.press("Escape")
        # Un clip sélectionné et la piste voix sélectionnée (Melodyne, preset de piste, Strip Silence).
        x, y = clip_point(page, 1, 3.0)
        page.mouse.click(x, y); page.wait_for_timeout(200)
        for th in themes:
            run(page, log, how, th)
        errs = [e["text"][:200] for e in log.errors() if "8765" not in e["text"] and "8766" not in e["text"]]
        res.setdefault("erreurs_console", {})[vp] = errs[:10]
        ctx.close()
    b.close()

(OUT / "palette_commandes.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
n = len(res["cas"])
print(f"\nBILAN : {n - len(res['echecs'])} / {n}" + (f" — ÉCHECS : {', '.join(res['echecs'])}" if res["echecs"] else ""), "| console :", json.dumps(res.get("erreurs_console"), ensure_ascii=False)[:600])
sys.exit(1 if res["echecs"] else 0)
