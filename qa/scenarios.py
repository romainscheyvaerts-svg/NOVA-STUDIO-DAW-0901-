"""Batterie QA de bout en bout pour NOVA (headless, aucune fenêtre).

Usage :
  python qa/scenarios.py                 # tout, sur pc + tel + tab selon les scénarios
  python qa/scenarios.py rec export      # seulement certains scénarios (filtre par nom)
  NOVA_URL=http://127.0.0.1:3300/ QA_OUT=D:\\...\\dossier python qa/scenarios.py

Chaque scénario écrit des captures PNG + un journal JSON (console, exceptions,
requêtes en échec, écritures externes bloquées) dans QA_OUT, puis un résumé
global `resume.json`. Aucune écriture n'atteint Supabase : tout POST/PATCH/PUT/
DELETE vers un domaine extérieur est bloqué par qalib.new_page.
"""
import sys, json, time, re, os
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from qalib import *  # noqa

DEFAULT_BEAT = os.environ.get("QA_BEAT", "NOCTAMBULE")


# ---------------------------------------------------------------- utilitaires
@contextmanager
def step(res, label):
    t = time.time()
    try:
        yield
        res.setdefault("steps", []).append({"step": label, "ok": True, "s": round(time.time() - t, 1)})
    except Exception as e:  # noqa
        res["ok"] = False
        res.setdefault("steps", []).append({"step": label, "ok": False, "err": f"{type(e).__name__}: {str(e)[:300]}"})


def body(page):
    return page.inner_text("body")


def btn(page, name, exact=False):
    """Premier bouton VISIBLE de ce nom (les barres cachées gardent des doublons invisibles)."""
    return page.get_by_role("button", name=name, exact=exact).locator("visible=true").first


def visible(loc):
    try:
        return loc.is_visible()
    except Exception:
        return False


def wait_text_gone(page, text, timeout_s=40):
    t = time.time()
    while time.time() - t < timeout_s:
        if text not in body(page):
            return time.time() - t
        page.wait_for_timeout(400)
    raise TimeoutError(f"« {text} » toujours affiché après {timeout_s}s")


def wait_text(page, text, timeout_s=20):
    page.get_by_text(text).first.wait_for(state="visible", timeout=timeout_s * 1000)


def position(page):
    return page.evaluate("""() => { const m = document.body.innerText.match(/\\d\\d:\\d\\d\\.\\d\\d/); return m ? m[0] : null; }""")


def secs(pos):
    if not pos: return None
    m, s = pos.split(":")
    return int(m) * 60 + float(s)


def bottom_nav(page):
    """Barre d'onglets du bas (téléphone)."""
    return page.locator("[role=navigation], div.fixed.bottom-0").filter(has_text="Morceau").last


def close_welcome(page):
    for name in ("C'est parti", "Plus tard"):
        b = btn(page, name, exact=True)
        if visible(b):
            b.click(); page.wait_for_timeout(300); return name
    return None


def open_studio(page, res, beat=DEFAULT_BEAT, vp="pc"):
    t = time.time()
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text(beat, exact=True).first.wait_for(timeout=20000)
    res.setdefault("timing", {})["accueil_s"] = round(time.time() - t, 1)
    t = time.time()
    page.get_by_text(beat, exact=True).first.click()
    page.wait_for_timeout(1200)
    res["welcome_buttons"] = [b["t"] for b in visible_buttons(page) if b["t"] in ("Choisir un beat", "Plus tard", "C'est parti")]
    shot(page, f"{res['name']}_01_bienvenue")
    close_welcome(page)
    wait_text_gone(page, "Chargement", 45)
    res["timing"]["beat_charge_s"] = round(time.time() - t, 1)
    page.wait_for_timeout(600)


def dismiss_toasts(page):
    page.mouse.move(5, 5)


def count_clips(page):
    return page.evaluate("""() => document.querySelectorAll('[data-clip-id], [data-clipid]').length""")


def project_clips(page, res, label):
    """Sauvegarde locale (.zip) puis lecture de project.json : liste réelle des clips par piste."""
    import zipfile
    page.keyboard.press("Control+s"); page.wait_for_timeout(800)
    loc = page.get_by_role("button", name=re.compile("(Export local|cet appareil)", re.I)).first
    with page.expect_download(timeout=30000) as dl:
        loc.click()
    path = OUT / f"{res['name']}_{label}.zip"
    dl.value.save_as(str(path))
    page.wait_for_timeout(500)
    if visible(btn(page, "Fermer")): page.keyboard.press("Escape")
    proj = json.loads(zipfile.ZipFile(path).read("project.json"))
    out = {}
    for t in proj.get("tracks", []):
        if t.get("clips"):
            out[t.get("name")] = [{"nom": c.get("name"), "debut": round(c.get("start", 0), 2), "duree": round(c.get("duration", 0), 2), "muet": bool(c.get("isMuted"))} for c in t["clips"]]
    return out


# ---------------------------------------------------------------- scénarios
def s_accueil(page, log, res, vp):
    t = time.time()
    with step(res, "chargement accueil"):
        page.goto(BASE, wait_until="domcontentloaded")
        page.get_by_text("Nouveau Projet").first.wait_for(timeout=20000)
        res.setdefault("timing", {})["accueil_s"] = round(time.time() - t, 1)
        page.wait_for_timeout(1500)
        shot(page, f"{res['name']}_01")
        res["overflow"] = overflow_report(page)
    with step(res, "onglet Mélodies"):
        page.get_by_role("tab", name=re.compile("Mélodies")).click(); page.wait_for_timeout(1200)
        shot(page, f"{res['name']}_02_melodies")
        page.get_by_role("tab", name=re.compile("Instrus")).click(); page.wait_for_timeout(500)
    with step(res, "pré-écoute d'une carte (▶)"):
        b = page.get_by_role("button", name=re.compile(f"Écouter.{{0,3}}{DEFAULT_BEAT}")).first
        t0 = time.time(); b.click()
        playing = None
        for _ in range(60):
            page.wait_for_timeout(250)
            if page.get_by_role("button", name=re.compile(f"pause.{{0,3}}{DEFAULT_BEAT}", re.I)).count():
                playing = round(time.time() - t0, 1); break
        res["preecoute_demarre_apres_s"] = playing
        shot(page, f"{res['name']}_03_preecoute")
        res["preecoute_erreur"] = "Lecture impossible" in body(page)
        page.get_by_role("button", name=re.compile(f"(pause|Écouter).{{0,3}}{DEFAULT_BEAT}", re.I)).first.click(); page.wait_for_timeout(400)
    with step(res, "double-clic impatient sur ▶ (pas de fausse erreur)"):
        b = page.get_by_role("button", name=re.compile(f"(Écouter|pause).{{0,3}}MIDNIGHT", re.I)).first
        b.click(); page.wait_for_timeout(300); b.click(); page.wait_for_timeout(800)
        res["double_clic_fausse_erreur"] = "Lecture impossible" in body(page)
        shot(page, f"{res['name']}_03b_double_clic")
    with step(res, "Connexion → écran de connexion (sans valider)"):
        btn(page, "Connexion").click(); page.wait_for_timeout(1000)
        shot(page, f"{res['name']}_04_connexion")
        res["connexion_txt"] = body(page)[:400]
        close = page.get_by_role("button", name=re.compile("^Fermer"))
        res["connexion_croix_visible"] = any(visible(close.nth(i)) and close.nth(i).bounding_box() and page.evaluate("([x,y]) => !!document.elementFromPoint(x,y)?.closest('button[aria-label^=Fermer]')", [close.nth(i).bounding_box()["x"] + 8, close.nth(i).bounding_box()["y"] + 8]) for i in range(close.count()))
        page.keyboard.press("Escape"); page.wait_for_timeout(500)
        res["connexion_ferme_echap"] = not visible(page.get_by_role("button", name=re.compile("se connecter", re.I)).first)
        if not res["connexion_ferme_echap"] and res["connexion_croix_visible"]:
            close.first.click(); page.wait_for_timeout(400)
        res["connexion_fermee"] = not visible(page.get_by_role("button", name=re.compile("se connecter", re.I)).first)
    with step(res, "Charger Projet"):
        page.get_by_text("Charger Projet").first.click(); page.wait_for_timeout(1200)
        shot(page, f"{res['name']}_05_charger")
        res["charger_txt"] = body(page)[:600]
        page.keyboard.press("Escape"); page.wait_for_timeout(500)
        shot(page, f"{res['name']}_05b_apres_echap")
    with step(res, "Ouvrir Audio (Nova Pro)"):
        if "Nouveau Projet" not in body(page):
            page.goto(BASE); page.get_by_text("Nouveau Projet").first.wait_for()
        try:
            with page.expect_file_chooser(timeout=3000) as fc:
                page.get_by_text("Ouvrir Audio").first.click()
            res["ouvrir_audio"] = "sélecteur de fichier ouvert"
        except Exception:
            res["ouvrir_audio"] = "pas de sélecteur de fichier"
        page.wait_for_timeout(1200)
        shot(page, f"{res['name']}_06_ouvrir_audio")
        res["ouvrir_audio_txt"] = body(page)[:600]
        page.keyboard.press("Escape"); page.wait_for_timeout(500)
    with step(res, "Défi du jour"):
        page.goto(BASE); page.get_by_text("Nouveau Projet").first.wait_for()
        page.get_by_text("DÉFI DU JOUR").first.click(); page.wait_for_timeout(2500)
        shot(page, f"{res['name']}_07_defi")
        res["defi_txt"] = body(page)[:300]
    with step(res, "Nouveau Projet"):
        page.goto(BASE); page.get_by_text("Nouveau Projet").first.wait_for()
        page.get_by_text("Nouveau Projet").first.click(); page.wait_for_timeout(2500)
        shot(page, f"{res['name']}_08_nouveau")
        res["nouveau_buttons"] = [b["t"] for b in visible_buttons(page)][:40]


def s_studio_transport(page, log, res, vp):
    with step(res, "ouvrir studio avec un beat"):
        open_studio(page, res, vp=vp)
        shot(page, f"{res['name']}_02_pret")
        res["overflow"] = overflow_report(page)
    with step(res, "lecture 2 s"):
        p0 = secs(position(page))
        page.keyboard.press("Space"); page.wait_for_timeout(2200)
        p1 = secs(position(page))
        res["lecture"] = [p0, p1]
        assert p1 and p1 > (p0 or 0) + 1, f"la position n'avance pas {p0}->{p1}"
        shot(page, f"{res['name']}_03_lecture")
    with step(res, "pause (espace) garde la position"):
        page.keyboard.press("Space"); page.wait_for_timeout(600)
        a = secs(position(page)); page.wait_for_timeout(700); b = secs(position(page))
        res["pause"] = [a, b]
        assert abs(b - a) < 0.05, "la position bouge encore en pause"
    with step(res, "mesure suivante (.) / précédente (,)"):
        a = secs(position(page)); page.keyboard.press("."); page.wait_for_timeout(300)
        b = secs(position(page)); page.keyboard.press(","); page.wait_for_timeout(300)
        c = secs(position(page)); res["mesures"] = [a, b, c]
        assert b > a, "« . » n'avance pas"
    with step(res, "retour au début (Entrée)"):
        page.keyboard.press("End"); page.wait_for_timeout(300)
        res["fin"] = position(page)
        page.keyboard.press("Home"); page.wait_for_timeout(300)
        assert secs(position(page)) == 0, f"Début → {position(page)}"
    with step(res, "stop (bouton) remet à zéro"):
        page.keyboard.press("Space"); page.wait_for_timeout(1500)
        stop = btn(page, "Stop", exact=True)
        if visible(stop): stop.click()
        else: page.keyboard.press("Escape")
        page.wait_for_timeout(500)
        res["apres_stop"] = position(page)
    with step(res, "boucle (L) et métronome"):
        page.keyboard.press("l"); page.wait_for_timeout(300)
        lb = page.get_by_role("button", name="Boucle").first
        res["boucle_pressed"] = lb.get_attribute("aria-pressed") if visible(lb) else "bouton caché"
        page.keyboard.press("l")
        mb = page.get_by_role("button", name="Métronome").first
        if visible(mb):
            mb.click(); page.wait_for_timeout(300)
            res["metronome_pressed"] = mb.get_attribute("aria-pressed")
            mb.click()
        else:
            res["metronome_pressed"] = "bouton caché (menu)"
    with step(res, "tempo (double-clic → saisie 100)"):
        bpm = page.locator("[title^='Tempo']").first
        if visible(bpm):
            bpm.dblclick(); page.wait_for_timeout(300)
            inp = page.locator("[title^='Tempo'] input").first
            if visible(inp):
                inp.fill("100"); inp.press("Enter"); page.wait_for_timeout(500)
                res["tempo_apres"] = page.locator("[title^='Tempo']").first.inner_text()
            else:
                res["tempo_apres"] = "pas de champ de saisie au double-clic"
        else:
            res["tempo_apres"] = "contrôle de tempo invisible"
        shot(page, f"{res['name']}_04_tempo")
    with step(res, "aide raccourcis (?)"):
        page.keyboard.press("?"); page.wait_for_timeout(500)
        res["aide_ouverte"] = "Raccourcis clavier" in body(page)
        shot(page, f"{res['name']}_05_raccourcis")
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
        res["aide_fermee_echap"] = "Raccourcis clavier" not in body(page)
    with step(res, "repère (K)"):
        page.keyboard.press("k"); page.wait_for_timeout(400)
        shot(page, f"{res['name']}_06_repere")


def do_take(page, res, label, seconds=4, first=False):
    page.keyboard.press("Home")
    page.keyboard.press("r")
    page.wait_for_timeout(900)
    if first:
        shot(page, f"{res['name']}_{label}_casque")
        res["casque_vu"] = "casque ou des écouteurs" in body(page)
        b = btn(page, "Oui, j'ai un casque")
        if visible(b): b.click()
    # décompte
    page.wait_for_timeout(700)
    shot(page, f"{res['name']}_{label}_decompte")
    page.wait_for_timeout(3500)
    shot(page, f"{res['name']}_{label}_enregistrement")
    res.setdefault("bandeau_niveau", []).append(any(k in body(page) for k in ("Bon niveau", "Un peu faible", "Trop fort", "niveau")))
    page.wait_for_timeout(seconds * 1000)
    page.keyboard.press("r")
    page.wait_for_timeout(4000)  # la carte « Et maintenant ? » arrive ~2,6 s après l'arrêt
    shot(page, f"{res['name']}_{label}_apres")


def s_rec(page, log, res, vp):
    with step(res, "ouvrir studio"):
        open_studio(page, res, vp=vp)
    with step(res, "prise 1 (casque, décompte, arrêt)"):
        do_take(page, res, "p1", first=True)
        txt = body(page)
        res["prise1_clip"] = "Prise 1" in txt
        res["apres_prise_carte"] = "Et maintenant" in txt
        res["mix_auto_propose"] = any(k in txt for k in ("Mix auto", "mix"))
        assert res["prise1_clip"], "pas de clip « Prise 1 »"
    with step(res, "carte « Et maintenant ? » se ferme (croix)"):
        b = page.get_by_role("region", name="Et maintenant ?").get_by_role("button", name="Fermer")
        if visible(b): b.click(); page.wait_for_timeout(300)
        res["carte_fermee"] = "Et maintenant ?" not in body(page)
    with step(res, "prise 2"):
        do_take(page, res, "p2", seconds=3)
        txt = body(page)
        res["prise2"] = re.findall(r"Prise \d[^\n]{0,6}", txt)[:6]
    with step(res, "annuler (Ctrl+Z) puis rétablir (Ctrl+Y)"):
        before = re.findall(r"Prise \d[^\n]{0,6}", body(page))
        page.keyboard.press("Control+z"); page.wait_for_timeout(700)
        mid = re.findall(r"Prise \d[^\n]{0,6}", body(page))
        shot(page, f"{res['name']}_annule")
        page.keyboard.press("Control+y"); page.wait_for_timeout(700)
        after = re.findall(r"Prise \d[^\n]{0,6}", body(page))
        res["undo_redo"] = {"avant": before, "annule": mid, "retabli": after}
    with step(res, "lecture de la prise"):
        page.keyboard.press("Home"); page.keyboard.press("Space"); page.wait_for_timeout(2000)
        page.keyboard.press("Space")
        shot(page, f"{res['name']}_lecture_prise")
    with step(res, "annuler le décompte (clic)"):
        page.keyboard.press("r"); page.wait_for_timeout(800)
        c = page.get_by_role("button", name="Annuler le décompte")
        if visible(c):
            c.click(); page.wait_for_timeout(800)
            res["decompte_annule"] = "Prépare-toi" not in body(page) and "Prépare-toi" not in body(page).replace("…", "...")
        else:
            res["decompte_annule"] = "décompte non vu"
            page.keyboard.press("r")
        page.wait_for_timeout(800)
        shot(page, f"{res['name']}_decompte_annule")
    with step(res, "clips réels de la piste REC (fichier projet)"):
        clips = project_clips(page, res, "projet_apres_prises")
        res["clips_projet"] = {k: v for k, v in clips.items() if k != "BEAT"}
        rec = [c for k, v in clips.items() if k != "BEAT" for c in v]
        res["nb_prises_distinctes"] = sorted({re.sub(r" · \d+$", "", c["nom"] or "") for c in rec})
        res["clips_courts_<0.5s"] = [c for c in rec if c["duree"] < 0.5]


def s_pistes(page, log, res, vp):
    with step(res, "ouvrir studio"):
        open_studio(page, res, vp=vp)
    with step(res, "ajouter une piste voix"):
        n0 = body(page).count(" M\n")
        b = btn(page, re.compile("Piste voix", re.I))
        b.click(); page.wait_for_timeout(1000)
        shot(page, f"{res['name']}_01_piste_ajoutee")
        res["piste_voix_txt"] = re.findall(r"(VOIX[^\n]*|Voix \d[^\n]*)", body(page))[:6]
    with step(res, "muet / solo / volume"):
        ms = page.get_by_role("button", name=re.compile("^(M|Mute|Muet)", re.I))
        res["nb_boutons_M"] = ms.count()
        m = page.locator("button", has_text=re.compile(r"^M$")).first
        m.click(); page.wait_for_timeout(300)
        res["mute_pressed"] = m.get_attribute("aria-pressed") or m.get_attribute("class")[:80]
        shot(page, f"{res['name']}_02_mute")
        m.click()
        s = page.locator("button", has_text=re.compile(r"^S$")).first
        s.click(); page.wait_for_timeout(300)
        shot(page, f"{res['name']}_03_solo")
        s.click()
    with step(res, "outils sélection / ciseaux / gomme (1-2-3)"):
        for k in ("2", "3", "1"):
            page.keyboard.press(k); page.wait_for_timeout(250)
        shot(page, f"{res['name']}_04_outils")
    with step(res, "zoom (Ctrl+molette)"):
        page.mouse.move(1000 if vp == "pc" else 300, 400)
        page.keyboard.down("Control"); page.mouse.wheel(0, -400); page.keyboard.up("Control")
        page.wait_for_timeout(500)
        shot(page, f"{res['name']}_05_zoom")


def s_paroles(page, log, res, vp):
    with step(res, "ouvrir studio"):
        open_studio(page, res, vp=vp)
    with step(res, "ouvrir Paroles"):
        if vp == "tel":
            bottom_nav(page).get_by_text("Paroles").last.click()
        else:
            btn(page, re.compile("Paroles")).click()
        page.wait_for_timeout(1000)
        shot(page, f"{res['name']}_01_paroles")
        res["paroles_txt"] = body(page)[-800:]
    with step(res, "écrire des paroles"):
        ta = page.locator("textarea").first
        ta.fill("Premier vers de mon couplet\nDeuxième vers qui rime\nTroisième vers\nRefrain qui tue")
        page.wait_for_timeout(600)
        shot(page, f"{res['name']}_02_ecrit")
    with step(res, "lecture avec prompteur"):
        page.keyboard.press("Escape")  # Échap dans le champ : la feuille reste-t-elle ?
        page.wait_for_timeout(300)
        res["echap_dans_champ_ferme"] = "Mes paroles" not in body(page)
        shot(page, f"{res['name']}_03_apres_echap")
        pret = btn(page, re.compile("Prêt"))
        if visible(pret): pret.click(); page.wait_for_timeout(400)
        page.keyboard.press("Home"); page.keyboard.press("Space"); page.wait_for_timeout(3000)
        shot(page, f"{res['name']}_04_prompteur")
        page.keyboard.press("Space")
    if vp == "tel":
        with step(res, "onglets mobiles après Paroles (bug feuille par-dessus)"):
            nav = bottom_nav(page)
            out = {}
            for tab in ("Sons", "Nova", "Morceau"):
                nav.get_by_text(tab, exact=True).click(); page.wait_for_timeout(900)
                shot(page, f"{res['name']}_05_onglet_{tab}")
                out[tab] = page.evaluate("""() => { const h = [...document.querySelectorAll('h2,h3')].filter(e=>e.getClientRects().length && /paroles/i.test(e.innerText)); return h.map(e=>e.innerText); }""")
            res["feuille_paroles_visible_apres"] = out


def s_mix(page, log, res, vp):
    with step(res, "ouvrir studio"):
        open_studio(page, res, vp=vp)
    with step(res, "ouvrir Mix auto"):
        page.locator("button[title='Choisir un style de mix pour ta voix']").first.click(); page.wait_for_timeout(900)
        shot(page, f"{res['name']}_01_panneau")
    styles = ["Rap clair", "Trap autotune", "Drill", "Chant / R&B", "Voix brute", "Effet téléphone"]
    res["styles"] = {}
    for s in styles:
        with step(res, f"style {s}"):
            panel = page.get_by_role("dialog", name=re.compile("Mix auto"))
            if not visible(panel):
                res["styles"][s + " (panneau rouvert)"] = True
                page.locator("button[title='Choisir un style de mix pour ta voix']").first.click(); page.wait_for_timeout(700)
            b = panel.get_by_role("button", name=s).first
            b.click(); page.wait_for_timeout(900)
            res["styles"][s] = {"actif": b.get_attribute("aria-pressed") if visible(b) else "panneau fermé après le clic",
                                "notif": (re.findall(r"[^\n]*Mix «[^\n]*", body(page)) or [""])[-1][:90]}
    shot(page, f"{res['name']}_02_style")
    with step(res, "fermer (clic à côté)"):
        page.mouse.click(10, 10); page.wait_for_timeout(500)
        res["ferme_clic_cote"] = "Mix auto de ta voix" not in body(page)
        if not res["ferme_clic_cote"]:
            page.keyboard.press("Escape")
        shot(page, f"{res['name']}_03_ferme")
        res["libelle_bouton_mix"] = [b["t"] for b in visible_buttons(page) if "🎚" in b["t"] or "Mix" in b["t"] or "Rap" in b["t"]]


def s_nova(page, log, res, vp):
    with step(res, "ouvrir studio"):
        open_studio(page, res, vp=vp)
    with step(res, "ouvrir Nova"):
        if vp == "tel":
            bottom_nav(page).get_by_text("Nova", exact=True).click()
        else:
            cand = page.locator("[aria-label*='Nova'], [title*='Nova']").first
            cand.click()
        page.wait_for_timeout(1200)
        shot(page, f"{res['name']}_01_nova")
        res["nova_txt"] = body(page)[-1200:]
    with step(res, "commande locale « mets le tempo à 90 »"):
        inp = page.locator("textarea, input[type=text]").last
        inp.fill("mets le tempo à 90"); inp.press("Enter")
        page.wait_for_timeout(5000)
        shot(page, f"{res['name']}_02_reponse")
        res["nova_reponse"] = body(page)[-900:]
    with step(res, "commande locale « mix trap »"):
        inp = page.locator("textarea, input[type=text]").last
        inp.fill("mix trap"); inp.press("Enter")
        page.wait_for_timeout(3000)
        res["nova_mix_trap"] = body(page)[-400:]
    with step(res, "question libre (IA serveur, bloquée hors ligne)"):
        inp = page.locator("textarea, input[type=text]").last
        inp.fill("donne moi un conseil pour mon couplet"); inp.press("Enter")
        page.wait_for_timeout(9000)
        shot(page, f"{res['name']}_03_reponse_ia")
        res["nova_reponse_ia"] = body(page)[-900:]


def s_avance(page, log, res, vp):
    with step(res, "ouvrir studio"):
        open_studio(page, res, vp=vp)
    with step(res, "passer en mode avancé"):
        b = btn(page, re.compile("Mode avancé", re.I))
        if not visible(b):
            btn(page, re.compile("Menu|menu")).click(); page.wait_for_timeout(500)
            b = btn(page, re.compile("avancé", re.I))
        b.click(); page.wait_for_timeout(1000)
        shot(page, f"{res['name']}_01_avance")
    for view in ("Console", "Auto", "Pistes"):
        with step(res, f"vue {view}"):
            v = btn(page, view, exact=True)
            v.click(); page.wait_for_timeout(1200)
            shot(page, f"{res['name']}_02_{view}")
    with step(res, "ajouter un effet (FX → Ajouter un effet → 1er effet)"):
        page.locator("button[aria-label^='Effets de']").locator("visible=true").nth(1).click(timeout=5000); page.wait_for_timeout(500)
        shot(page, f"{res['name']}_03_menu_fx")
        page.get_by_role("button", name=re.compile("Ajouter un effet")).first.click(); page.wait_for_timeout(600)
        shot(page, f"{res['name']}_04_liste_fx")
        res["liste_fx"] = [x["t"] for x in visible_buttons(page)][-25:]
        page.get_by_text(re.compile("^(Reverb|Réverb|Delay|EQ|Compress)", re.I)).first.click(); page.wait_for_timeout(1200)
        shot(page, f"{res['name']}_05_effet_ouvert")
        page.keyboard.press("Escape"); page.wait_for_timeout(500)
        res["effet_ferme_echap"] = page.evaluate("""() => ![...document.querySelectorAll('[role=dialog],[aria-modal=true]')].some(e=>e.getClientRects().length)""")
        shot(page, f"{res['name']}_06_apres_echap")


def s_sauvegarde(page, log, res, vp):
    with step(res, "ouvrir studio + une prise"):
        open_studio(page, res, vp=vp)
        do_take(page, res, "prise", first=True)
    with step(res, "Ctrl+S → fenêtre de sauvegarde"):
        page.keyboard.press("Control+s"); page.wait_for_timeout(900)
        shot(page, f"{res['name']}_01_fenetre")
        res["save_txt"] = body(page)[-900:]
    with step(res, "sauver un fichier sur l'appareil (.zip)"):
        loc = page.get_by_role("button", name=re.compile("(Export local|cet appareil)", re.I)).first
        with page.expect_download(timeout=30000) as dl:
            loc.click()
        d = dl.value
        path = OUT / f"{res['name']}_{d.suggested_filename}"
        d.save_as(str(path))
        res["fichier_projet"] = {"nom": d.suggested_filename, "octets": path.stat().st_size, "chemin": str(path)}
        page.wait_for_timeout(600)
        shot(page, f"{res['name']}_02_apres")
    with step(res, "sauvegarde auto puis rechargement → « Reprendre ma session »"):
        page.wait_for_timeout(6000)  # sauvegarde auto 4 s après la dernière modif
        res["notif_sauvegarde_auto"] = "sauvegardée automatiquement" in body(page)
        page.reload(wait_until="domcontentloaded"); page.wait_for_timeout(4000)
        shot(page, f"{res['name']}_03_rechargee")
        res["reprendre_propose"] = "Reprendre ma session" in body(page)
        page.get_by_text("Reprendre ma session").first.click(); page.wait_for_timeout(6000)
        close_welcome(page)
        shot(page, f"{res['name']}_04_session_reprise")
        res["apres_reprise"] = re.findall(r"Prise \d[^\n]{0,8}|NOCTAMBULE", body(page))[:6]
        res["clips_apres_reprise"] = project_clips(page, res, "reprise")
    with step(res, "recharger le fichier .zip (accueil → Charger Projet)"):
        f = res.get("fichier_projet", {}).get("chemin")
        page.goto(BASE); page.get_by_text("Charger Projet").first.wait_for()
        page.get_by_text("Charger Projet").first.click(); page.wait_for_timeout(800)
        with page.expect_file_chooser(timeout=5000) as fc:
            page.get_by_text("Charger depuis l'ordinateur").first.click()
        fc.value.set_files(f)
        page.wait_for_timeout(7000)
        close_welcome(page)
        shot(page, f"{res['name']}_05_fichier_recharge")
        res["clips_apres_fichier"] = project_clips(page, res, "fichier_recharge")


def s_export(page, log, res, vp):
    """Export SANS paiement : on ne clique jamais « Payer » (bloqué de toute façon)."""
    with step(res, "ouvrir studio + une prise"):
        open_studio(page, res, vp=vp)
        do_take(page, res, "export_prise", first=True)
        for n in ("Fermer",):
            c = page.get_by_role("region", name="Et maintenant ?").get_by_role("button", name=n)
            if visible(c): c.click()
    with step(res, "ouvrir Exporter"):
        b = btn(page, re.compile(r"^\W*Exporter( le mix)?\s*$"))
        if not visible(b):
            page.get_by_role("button", name=re.compile("Ouvrir le menu")).first.click(); page.wait_for_timeout(500)
            b = btn(page, re.compile(r"^\W*Exporter( le mix)?\s*$"))
        b.click(); page.wait_for_timeout(1000)
        shot(page, f"{res['name']}_01_fenetre")
        res["boutons_export"] = [x["t"] for x in visible_buttons(page) if any(k in x["t"].lower() for k in ("export", "payer", "démo", "acheter", "mixer"))]
    for label, rx in (("extrait 30 s", "Extrait audio 30"), ("démo complète", "Démo complète")):
        with step(res, f"fichier {label} (gratuit, tagué)"):
            if not visible(page.get_by_text("Fais écouter ton son")):
                page.get_by_role("button", name=re.compile("Démo gratuite")).first.click(); page.wait_for_timeout(800)
                shot(page, f"{res['name']}_02_partage")
            t0 = time.time()
            with page.expect_download(timeout=int(os.environ.get("QA_EXPORT_TIMEOUT", "420")) * 1000) as dl:
                page.get_by_role("button", name=re.compile(rx)).first.click()
            d = dl.value
            path = OUT / f"{res['name']}_{d.suggested_filename}"
            d.save_as(str(path))
            res.setdefault("fichiers", {})[label] = {"nom": d.suggested_filename, "octets": path.stat().st_size, "secs": round(time.time() - t0, 1)}
            assert path.stat().st_size > 20000, "fichier audio presque vide"
            page.wait_for_timeout(800)
            res.setdefault("retour", {})[label] = (re.findall(r"(Fichier enregistré ✓|Partagé ✓|Création impossible[^\n]*)", body(page)) or ["(aucun message)"])[0]
            shot(page, f"{res['name']}_03_{label.replace(' ', '_')}")


def s_fenetres(page, log, res, vp):
    with step(res, "ouvrir studio"):
        open_studio(page, res, vp=vp)
    targets = [("Partager", re.compile("Partager")), ("Audio", re.compile("Réglages audio|^Audio")), ("Ouvrir", re.compile("Ouvrir un projet|^Ouvrir")), ("Sauver", re.compile("Sauvegarder|^Sauver"))]
    res["fenetres"] = {}
    for label, rx in targets:
        with step(res, f"fenêtre {label}"):
            b = btn(page, rx)
            if not visible(b):
                res["fenetres"][label] = "bouton non visible dans la barre"
                continue
            b.click(); page.wait_for_timeout(900)
            shot(page, f"{res['name']}_{label}")
            txt = body(page)
            page.keyboard.press("Escape"); page.wait_for_timeout(500)
            closed = page.evaluate("""() => ![...document.querySelectorAll('[role=dialog],[aria-modal=true]')].some(e=>e.getClientRects().length)""")
            res["fenetres"][label] = {"ferme_echap": closed, "extrait": txt[-300:]}
            if not closed:
                page.mouse.click(5, 895 if vp == "pc" else 760); page.wait_for_timeout(400)
    with step(res, "thème clair puis sombre"):
        t = page.get_by_role("button", name=re.compile("thème clair|thème sombre"))
        if visible(t.first):
            t.first.click(); page.wait_for_timeout(700)
            shot(page, f"{res['name']}_theme_clair")
            page.get_by_role("button", name=re.compile("thème")).first.click(); page.wait_for_timeout(400)
        else:
            res["theme"] = "bouton thème non visible dans la barre"
    with step(res, "modes PC / Tablette / Mobile"):
        for m in ("Mode Tablette", "Mode Mobile", "Mode PC"):
            b = btn(page, re.compile(m))
            if visible(b):
                b.click(); page.wait_for_timeout(1200)
                shot(page, f"{res['name']}_{m.replace(' ', '_')}")
            else:
                res.setdefault("modes_invisibles", []).append(m)


def s_largeurs(page, log, res, vp):
    """Barre du haut aux largeurs courantes de portables."""
    with step(res, "ouvrir studio"):
        open_studio(page, res, vp=vp)
    res["barre"] = {}
    for w in (1280, 1366, 1440, 1536, 1600, 1680, 1920):
        page.set_viewport_size({"width": w, "height": 900})
        page.wait_for_timeout(500)
        info = page.evaluate("""() => {
          const bar = document.querySelector('.nova-verre-haut');
          if (!bar) return null;
          const vw = window.innerWidth, hidden = [];
          for (const b of bar.querySelectorAll('button, [title]')) {
            if (!b.getClientRects().length) continue;
            const r = b.getBoundingClientRect();
            if (r.right > vw + 1) hidden.push((b.getAttribute('aria-label') || b.title || b.innerText || '').trim().slice(0, 30));
          }
          return {hors_ecran: hidden};
        }""")
        res["barre"][w] = info
        shot(page, f"{res['name']}_{w}")


def s_mobile_onglets(page, log, res, vp):
    with step(res, "ouvrir studio"):
        open_studio(page, res, vp=vp)
    nav = bottom_nav(page)
    res["onglets"] = {}
    for tab in ("Sons", "Paroles", "Nova", "Sons", "Morceau", "Paroles", "Morceau"):
        with step(res, f"onglet {tab}"):
            nav.get_by_text(tab, exact=True).click(); page.wait_for_timeout(900)
            shot(page, f"{res['name']}_{len(res['onglets'])}_{tab}")
            res.setdefault("feuille_paroles_visible", {})[f"{len(res['onglets'])}_{tab}"] = visible(page.get_by_text("Mes paroles").first)
            res["onglets"][f"{len(res['onglets'])}_{tab}"] = page.evaluate("""() => [...document.querySelectorAll('[role=dialog], h2')].filter(e=>e.getClientRects().length).map(e=>(e.getAttribute('aria-label')||e.innerText||'').slice(0,40))""")
    with step(res, "menu ☰"):
        page.get_by_role("button", name=re.compile("menu", re.I)).first.click(); page.wait_for_timeout(700)
        shot(page, f"{res['name']}_menu")
        res["menu"] = [b["t"] for b in visible_buttons(page)][:50]
        page.keyboard.press("Escape")


ALL = [
    (s_accueil, ["pc", "tel"]),
    (s_studio_transport, ["pc", "tel"]),
    (s_rec, ["pc", "tel"]),
    (s_pistes, ["pc"]),
    (s_paroles, ["pc", "tel"]),
    (s_mix, ["pc", "tel"]),
    (s_nova, ["pc", "tel"]),
    (s_avance, ["pc"]),
    (s_sauvegarde, ["pc"]),
    (s_export, ["pc", "tel"]),
    (s_fenetres, ["pc", "tab"]),
    (s_largeurs, ["pc"]),
    (s_mobile_onglets, ["tel"]),
]


if __name__ == "__main__":
    filt = [a for a in sys.argv[1:] if not a.startswith("--")]
    vps = [a[5:] for a in sys.argv[1:] if a.startswith("--vp=")]
    results = []
    for fn, vlist in ALL:
        if filt and not any(f in fn.__name__ for f in filt):
            continue
        for vp in vlist:
            if vps and vp not in vps:
                continue
            r = run_one(fn, vp)
            results.append(r)
            print(json.dumps({k: r[k] for k in r if k not in ()}, ensure_ascii=False)[:4000], flush=True)
    tag = os.environ.get("QA_TAG", "")
    (OUT / f"resume{tag}.json").write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
