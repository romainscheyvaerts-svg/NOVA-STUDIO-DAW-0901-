"""« Tu as un casque ? » au premier REC : détection automatique, sinon un seul geste mémorisé.

Cas (Chrome headless, aucune fenêtre ; la liste des sorties audio est simulée comme la
donnerait Chrome une fois le micro autorisé) :
- casque     : sortie « Casque (Realtek(R) Audio) » → la prise part sans question, retour micro ALLUMÉ ;
- haut-parleurs : « Haut-parleurs (Realtek(R) Audio) » → sans question, retour micro COUPÉ ;
- carte son  : « Haut-parleurs (Focusrite USB Audio) » → sans question, retour ALLUMÉ ;
- inconnu (PC, clavier) : nom ambigu → la question s'affiche, Entrée répond « Oui » (1 touche)
  et la prise part ; au 2e REC, plus de question (réponse mémorisée) ;
- inconnu (tablette, doigt) : 1 toucher sur « Oui, j'ai un casque », la prise part.

NOVA_URL=http://127.0.0.1:3492/ PYTHONIOENCODING=utf-8 python qa/casque_rec.py
Sorties : D:\\1 WORK\\CONTENU\\nova-pro2\\point7\\ (casque_rec.json + captures)
"""
import json, os, re, sys, time
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3492/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-pro2\point7")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, OUT, Log, BASE  # noqa: E402
from desktop_gate import install_mocks, SUPERADMIN  # noqa: E402
from scenarios import close_welcome  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

FAKE_OUT = """(label) => { const md = navigator.mediaDevices; if (!md) return; const orig = md.enumerateDevices.bind(md);
  md.enumerateDevices = async () => { const l = (await orig()).filter(d => d.kind !== 'audiooutput');
    return [...l, { deviceId: 'default', kind: 'audiooutput', label: 'Par défaut - ' + label, groupId: 'g', toJSON() { return this; } }]; }; }"""

checks, res = [], {"cas": {}}


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("  OK  " if cond else "  KO  ") + name + (f" — {detail}" if detail is not None else ""))


def studio(b, vp, label):
    log = Log(f"casque_{vp}")
    ctx, page = new_page(b, vp, log=log, touch=(vp != "pc"))
    page.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
    page.add_init_script(f"({FAKE_OUT})({json.dumps(label)})")
    install_mocks(page, "romain", SUPERADMIN, {})
    page.goto(BASE, wait_until="domcontentloaded")
    nouveau = page.locator("button:visible", has_text=re.compile("Nouveau Projet")).first
    nouveau.wait_for(timeout=90000)
    nouveau.tap() if vp != "pc" else nouveau.click()
    page.wait_for_timeout(800); close_welcome(page)
    page.wait_for_function("() => !!window.__novaEdit && !!document.querySelector('.nova-grille canvas')", timeout=60000)
    page.keyboard.press("Escape")
    b_voix = page.locator("button[aria-label='Ajouter une piste voix']").locator("visible=true").first
    b_voix.tap() if vp != "pc" else b_voix.click()
    page.wait_for_timeout(800)
    return ctx, page, log


def rec_and_stop(page, gestures, vp, answer=None):
    """REC ; si la question vient : répond (Entrée au clavier, toucher au doigt). Renvoie (question vue, prise lancée)."""
    if vp == "pc": page.keyboard.press("r")
    else: page.locator("button[aria-label='Enregistrer']").locator("visible=true").first.tap()
    gestures.append("REC")
    asked = False
    t0 = time.time()
    while time.time() - t0 < 6:
        if page.locator("#casque-titre").count():
            asked = True; break
        if page.evaluate("() => window.__novaEdit.getState().isRecording"): break
        page.wait_for_timeout(100)
    if asked:
        page.screenshot(path=str(OUT / f"{vp}_question.png"))
        if vp == "pc": page.keyboard.press("Enter"); gestures.append("Entrée (Oui, focus d'office)")
        else: page.get_by_role("button", name=re.compile("Oui, j.ai un casque")).first.tap(); gestures.append("toucher « Oui »")
    started = False
    t0 = time.time()
    while time.time() - t0 < 8 and not started:
        started = page.evaluate("() => window.__novaEdit.getState().isRecording"); page.wait_for_timeout(100)
    page.wait_for_timeout(1500)
    if vp == "pc": page.keyboard.press("Space")
    else: page.locator("button[aria-label='Stop']").locator("visible=true").first.tap()
    page.wait_for_timeout(1500)
    return asked, started


with sync_playwright() as p:
    b = launch(p)
    for name, label, want in (("casque", "Casque (Realtek(R) Audio)", "1"), ("haut-parleurs", "Haut-parleurs (Realtek(R) Audio)", "0"),
                              ("carte son", "Haut-parleurs (Focusrite USB Audio)", "1")):
        ctx, page, log = studio(b, "pc", label)
        g = []
        asked, started = rec_and_stop(page, g, "pc")
        stored = page.evaluate("() => localStorage.getItem('nova_headphones')")
        note = page.evaluate("() => [...document.querySelectorAll('[role=status], [aria-live]')].map(e => e.innerText).filter(t => /détecté/.test(t)).slice(0, 1)")
        page.screenshot(path=str(OUT / f"pc_{name.replace(' ', '_')}_detecte.png"))
        res["cas"][name] = {"sortie": label, "question": asked, "prise": started, "memorise": stored, "gestes": g, "message": note}
        check(f"{name} : la prise part sans question (1 geste : REC)", started and not asked, g)
        check(f"{name} : réponse mémorisée « {want} »", stored == want, stored)
        ctx.close()
    # Nom ambigu : la question, une seule touche, puis plus rien au 2e REC.
    ctx, page, log = studio(b, "pc", "Realtek Digital Output")
    g = []
    asked, started = rec_and_stop(page, g, "pc")
    check("inconnu (PC) : la question s'affiche, Entrée = « Oui » et la prise part (REC + 1 touche)", asked and started and len(g) == 2, g)
    g2 = []
    asked2, started2 = rec_and_stop(page, g2, "pc")
    check("inconnu (PC) : au 2e REC, plus de question (réponse mémorisée)", started2 and not asked2, g2)
    res["cas"]["inconnu_pc"] = {"1re_prise": g, "2e_prise": g2}
    ctx.close()
    ctx, page, log = studio(b, "tab", "Realtek Digital Output")
    g = []
    asked, started = rec_and_stop(page, g, "tab")
    check("inconnu (tablette) : un seul toucher sur « Oui » et la prise part", asked and started and len(g) == 2, g)
    res["cas"]["inconnu_tablette"] = {"gestes": g}
    ctx.close()
    b.close()
res["verifications"] = checks
res["bilan"] = {"ok": sum(c["ok"] for c in checks), "total": len(checks)}
(OUT / "casque_rec.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
print("\nBILAN :", json.dumps(res["bilan"], ensure_ascii=False))
