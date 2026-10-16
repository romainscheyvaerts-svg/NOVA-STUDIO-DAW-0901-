"""Guidage d'un débutant (1.5.2, chantier « guidage ») : les frictions corrigées, prouvées dans le navigateur.

Navigateur headless (aucune fenêtre), Supabase simulé (qa_hors_prod via qalib), micro simulé ou refusé.
Bureau 1366 × 768 et téléphone 390 × 844 (au doigt), thèmes sombre ET clair :

  1. Téléphone : micro refusé, puis aucun micro → le message se pose DANS la page Morceau (bande
     « mobile-notice »), au lieu de partir seulement dans le fil de Nova (onglet fermé : rien à l'écran).
     Bureau : la bulle habituelle reste (non-régression), aucune bande.
  2. Téléphone : barre du clip en français (COPIER, COLLER, DOUBLER, COUPER, INVERSER, MUET), libellés lisibles
     par un lecteur d'écran ; aucun bouton recouvert.
  3. « Montre-moi » en mode simple (bureau) : « Inviter un ingé son ou un artiste », « Sauvegarder et rouvrir »,
     « Brancher ton micro » vont jusqu'à la bonne fenêtre en suivant l'anneau (☰ › Plus d'outils › bouton
     précis), sans tourner en rond sur « Plus d'outils ». Téléphone : même chose pour la collaboration.
  4. Téléphone : les étapes ne parlent plus de « Ctrl+K » (pas de clavier) mais de ☰ › « Chercher une action… » ;
     le détail d'un parcours affiche la variante téléphone.
  5. « Faire sa version » sans compte : l'étape « Connecte-toi » montre le formulaire (plus de « bouton pas visible »).
  6. Collaboration : un code entré sans compte → le formulaire de connexion apparaît juste sous le message,
     à l'écran (avant : tout en bas du panneau, hors de l'écran).
  7. « Ouvrir un projet » sans compte : l'onglet « Fichier sur l'ordinateur » d'abord, fenêtre annoncée
     (role=dialog), phrases au tutoiement qui disent quoi faire ; projet abîmé → message clair et lisible 8 s.
  8. Master Nova : LUFS et dBTP expliqués en infobulle.
  9. Balayage de chevauchement (qalib.balayage_chevauchement) sur chaque écran capturé : aucun bouton recouvert.

  NOVA_URL=http://127.0.0.1:3427/ PYTHONIOENCODING=utf-8 python qa/guidage.py
Sorties : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-152\\guidage\\qa) : guidage.json + captures.
"""
import json, os, re, sys, time
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3427/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-152\guidage\qa")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402,F401  (Supabase simulé avant tout navigateur)
from qalib import BASE, OUT, Log, launch, new_page, save_log, balayage_chevauchement  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

checks = []
res = {}

MIC_DENY = "(() => { const md = navigator.mediaDevices; if (!md) return; md.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')); })();"
MIC_NONE = """(() => { const md = navigator.mediaDevices; if (!md) return; md.getUserMedia = () => Promise.reject(new DOMException('Requested device not found', 'NotFoundError'));
  const o = md.enumerateDevices.bind(md); md.enumerateDevices = async () => (await o()).filter(d => d.kind !== 'audioinput'); })();"""
EN = re.compile(r"\b(COPY|PASTE|DUP|SPLIT|REV|MUTE|Error|Failed|Cancel|Upload|Download|Settings)\b")


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:600]}"), flush=True)


def shot(page, name):
    page.wait_for_timeout(250)
    page.screenshot(path=str(OUT / f"{name}.png"))


def balayer(page, label, scope=None):
    bal = balayage_chevauchement(page, scope)
    check(f"{label} : aucun bouton recouvert", not bal.get("erreur") and not bal.get("recouverts"), (bal.get("recouverts") or bal.get("erreur") or [])[:3])


def tap(page, loc, doigt):
    (loc.tap if doigt else loc.click)()


def ouvrir(b, vp, theme, nom, init=None):
    log = Log(f"guidage_{nom}")
    ctx, page = new_page(b, vp, log=log)
    page.set_default_timeout(20000)
    page.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); }} catch (e) {{}}")
    if init: page.add_init_script(init)
    return ctx, page, log


def studio(page, doigt):
    page.goto(BASE, wait_until="domcontentloaded")
    page.locator("[aria-label^='Poser ma voix sur']").first.wait_for(timeout=60000)
    page.wait_for_timeout(500)
    tap(page, page.locator("[aria-label^='Poser ma voix sur']").locator("visible=true").first, doigt)
    page.wait_for_function("() => !!window.__novaEdit && window.__novaEdit.getState().tracks.some(t => t.id === 'instrumental' && t.clips.length)", timeout=60000)
    page.wait_for_timeout(1500)


def rec_button(page):
    return page.get_by_role("button", name=re.compile(r"^Enregistrer$")).locator("visible=true").first


def fermer(page, log, ctx):
    errs = [e for e in log.errors() if not re.search(r"876[56]|ERR_CONNECTION_REFUSED|status of 40[01]|ARM ERROR", e["text"])]
    save_log(log)
    ctx.close()
    return errs


# --- 1. Micro refusé / absent -------------------------------------------------------------------
def micro(b):
    for vp, theme, mode in (("tel390", "dark", "refuse"), ("tel390", "light", "refuse"), ("tel390", "dark", "aucun"), ("pc1366", "dark", "refuse")):
        doigt = vp.startswith("tel")
        ctx, page, log = ouvrir(b, vp, theme, f"micro_{vp}_{theme}_{mode}", MIC_DENY if mode == "refuse" else MIC_NONE)
        studio(page, doigt)
        tap(page, rec_button(page), doigt)
        page.wait_for_timeout(2500)
        bande = page.locator("[data-testid=mobile-notice]").locator("visible=true")
        attendu = "Micro bloqué" if mode == "refuse" else "Aucun micro"
        if doigt:
            txt = bande.first.inner_text() if bande.count() else ""
            check(f"téléphone ({theme}) : micro {mode} → message posé dans la page Morceau", attendu in txt, txt or "aucune bande")
            if bande.count():
                r = bande.first.bounding_box()
                check(f"téléphone ({theme}) : la bande est dans le flux (pas flottante) et à l'écran", r and r["y"] >= 0 and r["y"] + r["height"] <= 844
                      and page.evaluate("() => getComputedStyle(document.querySelector('[data-testid=mobile-notice]')).position") == "static", r)
            shot(page, f"1_tel_{theme}_micro_{mode}")
            balayer(page, f"téléphone ({theme}) micro {mode}")
            if bande.count():
                tap(page, bande.first.get_by_role("button", name="Fermer le message"), True)
                page.wait_for_timeout(300)
                check(f"téléphone ({theme}) : la bande se ferme d'un toucher", page.locator("[data-testid=mobile-notice]").count() == 0)
        else:
            bulle = page.get_by_role("status").filter(has_text=attendu).locator("visible=true")
            check("bureau : micro refusé → la bulle habituelle (non-régression), pas de bande de téléphone",
                  bulle.count() > 0 and page.locator("[data-testid=mobile-notice]").count() == 0, page.locator("[role=status]").all_inner_texts()[:4])
            shot(page, "1_pc_dark_micro_refuse")
        errs = fermer(page, log, ctx)
        check(f"{vp} ({theme}) micro {mode} : aucune erreur dans la console", not errs, [e["text"][:160] for e in errs[:3]])


# --- 2. Barre du clip en français (téléphone) ------------------------------------------------------
def barre_clip(b):
    for theme in ("dark", "light"):
        ctx, page, log = ouvrir(b, "tel390", theme, f"barre_clip_{theme}")
        studio(page, True)
        # La pastille « ✅ Importé : … » (3 s) passe au-dessus de la barre du clip : on la laisse partir.
        page.wait_for_function("() => !/Importé :/.test(document.body.innerText)", timeout=15000)
        clip = page.locator("[data-clip-id]").locator("visible=true").first
        if not clip.count():
            clip = page.get_by_text("SCH", exact=True).locator("visible=true").first
        tap(page, clip, True)
        page.wait_for_timeout(600)
        bar = page.locator("button", has_text=re.compile(r"^(COPIER|COLLER|DOUBLER|COUPER|INVERSER|MUET)$")).locator("visible=true")
        labels = bar.all_inner_texts()
        check(f"téléphone ({theme}) : barre du clip en français", {"COPIER", "DOUBLER", "COUPER"} <= {l.strip() for l in labels}, labels)
        txt = page.inner_text("body")
        check(f"téléphone ({theme}) : plus de COPY / PASTE / SPLIT / MUTE à l'écran", not re.search(r"\b(COPY|PASTE|SPLIT|MUTE|DUP|REV)\b", txt), re.findall(r"\b(COPY|PASTE|SPLIT|MUTE|DUP|REV)\b", txt)[:5])
        noms = page.evaluate("""() => [...document.querySelectorAll('button')].filter(b => /^(COPIER|COLLER|DOUBLER|COUPER|INVERSER|MUET)$/.test((b.innerText||'').trim())).map(b => b.getAttribute('aria-label'))""")
        check(f"téléphone ({theme}) : chaque bouton de la barre a un libellé parlé", noms and all(noms), noms)
        shot(page, f"2_tel_{theme}_barre_clip")
        balayer(page, f"téléphone ({theme}) barre du clip")
        errs = fermer(page, log, ctx)
        check(f"téléphone ({theme}) barre du clip : aucune erreur dans la console", not errs, [e["text"][:160] for e in errs[:3]])


# --- 3. « Montre-moi » qui suit l'anneau jusqu'à la bonne fenêtre --------------------------------
COACH = """() => { const c = document.querySelector('[data-testid=howto-coach]'); if (!c) return null;
  const ring = document.querySelector('[data-testid=howto-ring]'); const vis = ring && getComputedStyle(ring).display !== 'none';
  const r = vis ? ring.getBoundingClientRect() : null;
  const el = r ? document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2).find(e => !e.closest('[data-testid=howto-coach]') && e.closest('button, [role=button], a')) : null;
  const b = el ? el.closest('button, [role=button], a') : null;
  return { step: c.dataset.step, text: (c.querySelector('[data-testid=howto-coach-text]') || {}).innerText || '',
    missing: !!c.querySelector('[data-testid=howto-coach-missing]'), ring: r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null,
    cible: b ? ((b.getAttribute('data-testid') || '') + ' ' + (b.innerText || b.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ')).slice(0, 60) : null }; }"""


def montre_moi(page, gid, doigt, fenetre, max_gestes=5):
    """Lance « Montre-moi », touche l'anneau jusqu'à ce que `fenetre` soit visible. Renvoie (ok, chemin)."""
    page.evaluate("async (id) => (await window.__novaAppModule('/utils/howTo.ts')).howTo.showMe(id)", gid)
    page.wait_for_timeout(600)
    chemin = []
    for _ in range(max_gestes):
        if page.locator(fenetre).locator("visible=true").count():
            break
        c = page.evaluate(COACH)
        if not c or not c["ring"]:
            chemin.append(f"anneau absent ({c and c['text'][:60]})"); break
        chemin.append(c["cible"] or "?")
        if doigt: page.touchscreen.tap(c["ring"]["x"], c["ring"]["y"])
        else: page.mouse.click(c["ring"]["x"], c["ring"]["y"])
        page.wait_for_timeout(700)
    ok = page.locator(fenetre).locator("visible=true").count() > 0
    page.wait_for_timeout(500)
    c = page.evaluate(COACH)
    return ok, chemin, c


def guides(b):
    cas = [("pc1366", "dark", "collab", '[aria-labelledby="collab-title"]', "menu-collab"),
           ("pc1366", "light", "sauvegarder", '[data-testid="save-new-version-box"]', "menu-save"),
           ("pc1366", "dark", "micro-latence", '[data-testid="audio-input-select"]', "menu-audio"),
           ("pc1366", "dark", "emporter", '[aria-labelledby="takehome-title"]', "menu-save"),
           ("tel390", "light", "collab", '[aria-labelledby="collab-title"]', "menu-collab"),
           ("tel390", "dark", "sauvegarder", '[data-testid="save-new-version-box"]', "menu-save")]
    for vp, theme, gid, fen, bouton in cas:
        doigt = vp.startswith("tel")
        ctx, page, log = ouvrir(b, vp, theme, f"guide_{gid}_{vp}")
        studio(page, doigt)
        ok, chemin, c = montre_moi(page, gid, doigt, fen)
        res.setdefault("montre_moi", {})[f"{gid}_{vp}"] = {"chemin": chemin, "apres": c}
        check(f"{vp} ({theme}) « Montre-moi » {gid} : l'anneau mène à la fenêtre en {len(chemin)} geste(s)", ok and len(chemin) <= 4, chemin)
        check(f"{vp} ({theme}) « Montre-moi » {gid} : l'anneau vise le bouton précis ({bouton}), sans repasser par « Plus d'outils »",
              any(bouton in x for x in chemin) and sum("menu-plus-toggle" in x for x in chemin) <= 1, chemin)
        check(f"{vp} ({theme}) « Montre-moi » {gid} : l'étape a avancé", c is not None and c["step"] not in ("1",), c)
        shot(page, f"3_{vp}_{theme}_montre_moi_{gid}")
        page.keyboard.press("Escape")
        errs = fermer(page, log, ctx)
        check(f"{vp} ({theme}) « Montre-moi » {gid} : aucune erreur dans la console", not errs, [e["text"][:160] for e in errs[:3]])


# --- 4 et 5. Textes du téléphone ; « Faire sa version » sans compte -----------------------------------
def textes_telephone(b):
    ctx, page, log = ouvrir(b, "tel390", "light", "textes_tel")
    studio(page, True)
    page.evaluate("async () => (await window.__novaAppModule('/utils/howTo.ts')).howTo.open('clip-tiktok')")
    page.wait_for_timeout(600)
    etapes = page.locator("[data-testid=howto-steps]").inner_text()
    check("téléphone : le détail d'un parcours ne parle pas de Ctrl+K mais de ☰ › « Chercher une action… »",
          "Ctrl+K" not in etapes and "Chercher une action" in etapes, etapes[:300])
    shot(page, "4_tel_light_detail_clip_tiktok")
    page.evaluate("async () => (await window.__novaAppModule('/utils/howTo.ts')).howTo.open('exporter')")
    page.wait_for_timeout(500)
    etapes = page.locator("[data-testid=howto-steps]").inner_text()
    check("téléphone : le détail affiche la variante téléphone (« Exporter » flèche ⬆ en haut)", "flèche" in etapes and "Ctrl+Maj+E" not in etapes, etapes[:300])
    page.keyboard.press("Escape"); page.keyboard.press("Escape"); page.wait_for_timeout(300)
    page.evaluate("async () => (await window.__novaAppModule('/utils/howTo.ts')).howTo.showMe('faire-sa-version')")
    page.wait_for_timeout(500)
    page.locator("[data-testid=howto-coach-doit]").tap(); page.wait_for_timeout(1500)
    c = page.evaluate(COACH)
    check("« Faire sa version » sans compte : l'étape suivante montre la connexion (anneau visible, pas « bouton pas visible »)",
          c and c["ring"] and not c["missing"] and re.search("Connecte-toi", c["text"]), c)
    shot(page, "5_tel_light_faire_sa_version_connexion")
    # Fenêtre ouverte : le reste du studio est derrière elle (inactif) ; on balaie la fenêtre et le guide.
    balayer(page, "téléphone (clair) « Faire sa version » sans compte (fenêtre)", "[data-testid=share-session]")
    page.locator("[data-testid=howto-coach-close]").tap()
    errs = fermer(page, log, ctx)
    check("téléphone textes : aucune erreur dans la console", not errs, [e["text"][:160] for e in errs[:3]])


# --- 6. Collaboration : code sans compte ------------------------------------------------------------
def collab_code(b):
    for vp, theme in (("pc1366", "dark"), ("tel390", "light")):
        doigt = vp.startswith("tel")
        ctx, page, log = ouvrir(b, vp, theme, f"collab_code_{vp}")
        studio(page, doigt)
        if True:
            if doigt:
                tap(page, page.locator("[data-testid=transport-menu]").locator("visible=true").first, True); page.wait_for_timeout(300)
                tap(page, page.locator("[data-testid=menu-plus-toggle]").locator("visible=true").first, True); page.wait_for_timeout(300)
                tap(page, page.locator("[data-testid=menu-collab]").locator("visible=true").first, True)
            else:
                page.keyboard.press("Control+k"); page.wait_for_timeout(300); page.keyboard.type("collaborer"); page.keyboard.press("Enter")
            page.wait_for_timeout(700)
        inp = page.locator("[data-testid=collab-code-input]")
        inp.fill("ZZZ999"); page.wait_for_timeout(100)
        tap(page, page.locator("[data-testid=collab-code-join]"), doigt)
        page.wait_for_timeout(1500)
        login = page.locator("[data-testid=collab-login]").locator("visible=true")
        box = login.first.bounding_box() if login.count() else None
        H = 844 if doigt else 768
        check(f"{vp} ({theme}) collaboration : code sans compte → connexion juste sous le message, à l'écran",
              box is not None and box["y"] < H - 60, box)
        shot(page, f"6_{vp}_{theme}_collab_code_sans_compte")
        balayer(page, f"{vp} ({theme}) collaboration code sans compte")
        errs = fermer(page, log, ctx)
        check(f"{vp} ({theme}) collaboration : aucune erreur dans la console", not errs, [e["text"][:160] for e in errs[:3]])


# --- 7. Ouvrir un projet sans compte ; projet abîmé ---------------------------------------------------
def ouvrir_projet(b):
    for vp, theme in (("pc1366", "dark"), ("tel390", "light")):
        doigt = vp.startswith("tel")
        ctx, page, log = ouvrir(b, vp, theme, f"ouvrir_projet_{vp}")
        studio(page, doigt)
        if doigt:
            tap(page, page.locator("[data-testid=transport-menu]").locator("visible=true").first, True); page.wait_for_timeout(300)
            tap(page, page.locator("[data-testid=menu-open-project]").locator("visible=true").first, True)
        else:
            page.keyboard.press("Control+k"); page.wait_for_timeout(300); page.keyboard.type("ouvrir un projet"); page.keyboard.press("Enter")
        page.wait_for_timeout(700)
        dlg = page.locator('[role=dialog][aria-labelledby="load-title"]').locator("visible=true")
        check(f"{vp} ({theme}) ouvrir un projet : fenêtre annoncée (role=dialog)", dlg.count() == 1)
        txt = dlg.first.inner_text() if dlg.count() else ""
        check(f"{vp} ({theme}) ouvrir un projet sans compte : « Fichier sur l'ordinateur » d'abord, au tutoiement",
              "choisir mon fichier" in txt.lower() and "connectez" not in txt.lower() and "cliquez" not in txt.lower(), txt[:300])
        shot(page, f"7_{vp}_{theme}_ouvrir_sans_compte")
        balayer(page, f"{vp} ({theme}) ouvrir un projet")
        tap(page, dlg.first.get_by_role("button", name=re.compile("Mon compte")), doigt)
        page.wait_for_timeout(400)
        txt = dlg.first.inner_text()
        check(f"{vp} ({theme}) onglet « Mon compte » sans compte : dit quoi faire (se connecter ou passer par un .zip)",
              "Connecte-toi" in txt and ".zip" in txt, txt[:300])
        shot(page, f"7_{vp}_{theme}_ouvrir_onglet_compte")
        if not doigt:
            bad = OUT / "projet_abime.zip"; bad.write_bytes(b"ceci n'est pas un zip" * 20)
            tap(page, dlg.first.locator("button", has_text=re.compile(r"^\s*Fichier sur l.ordinateur\s*$", re.I)).first, doigt); page.wait_for_timeout(300)
            page.set_input_files('input[type=file][accept=".zip,.json"]', str(bad))
            page.wait_for_timeout(1500)
            t = page.inner_text("body")
            m = re.search(r"❌[^\n]*", t)
            check("projet abîmé : message clair (« ne s'ouvre pas », quoi faire), sans « Erreur: »", m and "ne s’ouvre pas" in m.group(0) and "Erreur:" not in t, m and m.group(0))
            shot(page, "7_pc_dark_projet_abime")
            page.wait_for_timeout(4500)
            check("projet abîmé : le message reste lisible au moins 6 s", "ne s’ouvre pas" in page.inner_text("body"))
        errs = fermer(page, log, ctx)
        check(f"{vp} ({theme}) ouvrir un projet : aucune erreur dans la console", not errs, [e["text"][:160] for e in errs[:3]])


# --- 8. Master Nova : LUFS / dBTP expliqués --------------------------------------------------------
def master_jargon(b):
    ctx, page, log = ouvrir(b, "pc1366", "light", "master_jargon")
    studio(page, False)
    page.keyboard.press("Control+k"); page.wait_for_timeout(300); page.keyboard.type("master nova"); page.wait_for_timeout(200); page.keyboard.press("Enter")
    page.wait_for_timeout(900)
    titres = page.evaluate("""() => [...document.querySelectorAll('[role=dialog][aria-label="Master Nova"] [title]')].map(e => e.title).filter(t => /LUFS/.test(t))""")
    expl = [t for t in titres if "volume moyen" in t and "dBTP" in t]
    check("Master Nova : LUFS et dBTP expliqués en infobulle (une par cible)", len(expl) >= 6, titres[:3])
    shot(page, "8_pc_light_master_jargon")
    errs = fermer(page, log, ctx)
    check("Master Nova : aucune erreur dans la console", not errs, [e["text"][:160] for e in errs[:3]])


if __name__ == "__main__":
    t0 = time.time()
    with sync_playwright() as p:
        b = launch(p)
        try:
            tous = (micro, barre_clip, guides, textes_telephone, collab_code, ouvrir_projet, master_jargon)
            for f in [f for f in tous if not sys.argv[1:] or f.__name__ in sys.argv[1:]]:
                try:
                    f(b)
                except Exception as e:  # noqa
                    check(f"{f.__name__} : déroulé sans exception", False, f"{type(e).__name__}: {str(e)[:300]}")
        finally:
            b.close()
    res["verifications"] = checks
    res["bilan"] = {"ok": sum(c["ok"] for c in checks), "total": len(checks), "secs": round(time.time() - t0)}
    (OUT / "guidage.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print("\nBILAN :", json.dumps(res["bilan"], ensure_ascii=False))
    sys.exit(0 if all(c["ok"] for c in checks) else 1)
