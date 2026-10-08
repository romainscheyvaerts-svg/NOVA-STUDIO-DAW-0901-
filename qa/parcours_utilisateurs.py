"""Parcours d'utilisateurs réels de NOVA (audit UX du 08/10/2026), rejouables en headless.

Quatre profils, chaque écran capturé et audité (qa/ux_audit.js : cibles tactiles < 40 px,
textes coupés ou hors écran, mots anglais, contrastes rendus) et chaque ouverture chronométrée :

  artiste    téléphone 390×844 (sombre + clair) : accueil → beat du catalogue → prise au micro
             (vraie voix simulée) → Mix auto → respirations → démo MP3 (sombre seulement) ;
  inge       PC 1600×900, mode avancé (sombre + clair) : session de 12 pistes, 2 prises,
             console, effet ouvert, envois, bus, automation, modes d'édition (Shuffle / Slip /
             Spot / Grid), prises, justesse note par note, Master Nova, export (stems) ;
  beatmaker  PC sombre + tablette 1024×768 claire au doigt : mélodie → boîte à rythmes,
             style, piste MIDI + synthé NOVA, piano roll (regardé seulement), tempo ;
  collab     hôte sur PC + invité sur téléphone : panneau, mise en ligne, lien d'invitation,
             arrivée de l'invité, choix du rôle, ce qu'il voit et peut faire (REC, sa piste).
             Serveur NOVA et Realtime SIMULÉS (qa/collab_sim.py).

Aucune écriture en base : POST / PATCH / PUT / DELETE externes bloqués (qalib.new_page).
Aucune fenêtre : navigateur headless.

Usage :
  NOVA_URL=http://127.0.0.1:3436/ PYTHONIOENCODING=utf-8 python qa/parcours_utilisateurs.py [profil…] [--court]
  --court : saute l'export MP3 (le plus long).
Sorties : D:\\1 WORK\\CONTENU\\nova-audit-ux\\2026-10-08\\parcours\\ (PNG + resume.json).
"""
import json, os, re, sys, time
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-audit-ux\2026-10-08\parcours")
import qalib  # noqa: E402

VOIX = Path(r"D:\1 WORK\CONTENU\nova-audit-ux\2026-10-08\voix_micro.wav")
if VOIX.exists():
    qalib.FAKE_WAV = str(VOIX)  # une vraie voix (ffmpeg : nova-v19/D_vraie_voix_avant.wav en boucle, mono 48 kHz)
qalib.VIEWPORTS["tel"] = {"width": 390, "height": 844}
from qalib import launch, new_page, Log, BASE, OUT  # noqa: E402
from scenarios import close_welcome, wait_text_gone, visible  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
COURT = "--court" in sys.argv
AUDIT_JS = "\n".join(l for l in (Path(__file__).parent / "ux_audit.js").read_text(encoding="utf-8").splitlines() if not l.startswith("//"))
INIT = ("try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_count_in', '0');"
        " localStorage.setItem('nova_welcome_seen', '{welcome}'); localStorage.setItem('nova_simple_mode', '{simple}');"
        " localStorage.setItem('nova_theme', '{theme}'); } catch (e) {}")
R = {}


class Parcours:
    def __init__(self, nom, page, log, vp):
        self.nom, self.pg, self.log, self.vp = nom, page, log, vp
        self.r = R.setdefault(nom, {"etapes": [], "ecrans": {}, "temps_s": {}})
        self.n = 0

    def ecran(self, label):
        """Capture + audit de l'écran courant."""
        self.n += 1
        name = f"{self.nom}_{self.n:02d}_{label}"
        try:
            self.pg.screenshot(path=str(OUT / f"{name}.png"))
            a = self.pg.evaluate(AUDIT_JS, {"touch": self.vp != "pc"})
            self.r["ecrans"][label] = {k: v[:12] for k, v in a.items() if v}
        except Exception as e:  # noqa
            self.r["ecrans"][label] = {"erreur": f"{type(e).__name__}: {str(e)[:200]}"}

    def etape(self, label, fn):
        t = time.time()
        try:
            info = fn()
            self.r["etapes"].append({"etape": label, "ok": True, "s": round(time.time() - t, 1), **({"info": info} if info else {})})
        except Exception as e:  # noqa
            self.r["etapes"].append({"etape": label, "ok": False, "err": f"{type(e).__name__}: {str(e)[:300]}"})
            try:
                self.pg.screenshot(path=str(OUT / f"{self.nom}_ECHEC_{len(self.r['etapes']):02d}.png"))
            except Exception:  # noqa
                pass
        print(f"  [{self.nom}] {'OK ' if self.r['etapes'][-1]['ok'] else 'KO '} {label} ({round(time.time() - t, 1)} s)", flush=True)

    def chrono(self, cle, t0):
        self.r["temps_s"][cle] = round(time.time() - t0, 1)

    def fin(self):
        self.r["erreurs_console"] = [e["text"][:200] for e in self.log.errors() if "ERR_FAILED" not in e["text"]][:15]


def contexte(b, vp, theme, simple=True, welcome="1"):
    log = Log(f"{vp}_{theme}")
    ctx, pg = new_page(b, vp, log)
    pg.add_init_script(INIT.replace("{welcome}", welcome).replace("{simple}", "1" if simple else "0").replace("{theme}", theme))
    return ctx, pg, log


def tap(loc, vp):
    (loc.tap if vp != "pc" else loc.click)()


def bouton(pg, rx):
    return pg.get_by_role("button", name=re.compile(rx)).locator("visible=true").first


def ouvrir_beat(P, beat="NOCTAMBULE"):
    pg = P.pg
    t = time.time()
    pg.goto(BASE, wait_until="domcontentloaded")
    pg.get_by_text(beat, exact=True).first.wait_for(timeout=45000)
    P.chrono("accueil", t)
    P.ecran("accueil")
    t = time.time()
    pg.get_by_text(beat, exact=True).first.click()
    pg.wait_for_timeout(1200)
    close_welcome(pg)
    wait_text_gone(pg, "Chargement", 60)
    P.chrono("studio_avec_beat", t)
    pg.wait_for_timeout(800)


def prise(P, secondes=5):
    pg = P.pg
    rec = bouton(pg, "^Enregistrer$")
    tap(rec, P.vp)
    pg.wait_for_timeout(1500)
    P.ecran("prise_en_cours")
    pg.wait_for_timeout(secondes * 1000)
    n0 = pg.evaluate("() => (window.__novaEdit?.getState().tracks || []).reduce((n, t) => n + (t.clips || []).length, 0)")
    tap(bouton(pg, "Arrêter l'enregistrement"), P.vp)
    t = time.time()
    # La prise est posée (clip(s) en plus) ; la carte « Et maintenant ? » ne vient qu'à la 1re prise.
    for _ in range(40):
        pg.wait_for_timeout(250)
        if pg.evaluate("() => (window.__novaEdit?.getState().tracks || []).reduce((n, t) => n + (t.clips || []).length, 0)") > n0:
            break
    P.chrono("prise_posee", t)
    pg.wait_for_timeout(2500)


def fermer_carte(pg):
    c = pg.get_by_role("region", name="Et maintenant ?").get_by_role("button", name="Fermer")
    if visible(c):
        c.click(); pg.wait_for_timeout(300)


# ------------------------------------------------------------------ 1. artiste débutant (téléphone)
def artiste(b, theme):
    ctx, pg, log = contexte(b, "tel", theme, simple=True, welcome="0")
    P = Parcours(f"artiste_tel_{theme}", pg, log, "tel")

    def beat():
        P.pg.goto(BASE, wait_until="domcontentloaded")
        P.pg.get_by_text("NOCTAMBULE", exact=True).first.wait_for(timeout=45000)
        P.ecran("accueil")
        t = time.time()
        P.pg.get_by_text("NOCTAMBULE", exact=True).first.click(); P.pg.wait_for_timeout(1500)
        P.ecran("bienvenue_3_gestes")
        close_welcome(P.pg); wait_text_gone(P.pg, "Chargement", 60)
        P.chrono("studio_avec_beat", t)
        P.pg.wait_for_timeout(800)
        P.ecran("studio")
    P.etape("ouvrir le site et choisir un beat du catalogue", beat)

    def enregistrer():
        prise(P, 6)
        P.ecran("apres_prise")
        txt = P.pg.inner_text("body")
        return {"prise_visible": "Prise 1" in txt, "style_pose": "Trap autotune" in txt}
    P.etape("enregistrer une prise (micro simulé, vraie voix)", enregistrer)

    def mix_auto():
        fermer_carte(P.pg)
        t = time.time()
        tap(bouton(P.pg, "Trap autotune|Mix auto"), "tel")
        P.pg.get_by_role("dialog", name=re.compile("Mix auto")).wait_for(timeout=8000)
        P.chrono("ouverture_mix_auto", t)
        P.ecran("mix_auto")
        tap(P.pg.get_by_role("dialog", name=re.compile("Mix auto")).get_by_role("button", name="Rap clair").first, "tel")
        P.pg.wait_for_timeout(1200)
        P.ecran("mix_auto_rap_clair")
    P.etape("Mix auto : changer de style", mix_auto)

    def respirations():
        t = time.time()
        tap(P.pg.locator("[data-testid=breath-all]").first, "tel")
        for _ in range(30):
            P.pg.wait_for_timeout(400)
            if re.search(r"respiration", P.pg.inner_text("body")[-800:], re.I):
                break
        P.chrono("respirations", t)
        P.ecran("respirations")
        msg = [l for l in P.pg.inner_text("body").split("\n") if "espiration" in l][-1:]
        return {"message": msg}
    P.etape("traiter les respirations", respirations)

    def exporter():
        P.pg.keyboard.press("Escape"); P.pg.wait_for_timeout(400)
        tap(bouton(P.pg, "Ouvrir le menu"), "tel"); P.pg.wait_for_timeout(500)
        P.ecran("menu")
        t = time.time()
        tap(bouton(P.pg, r"^\W*Exporter\s*$"), "tel"); P.pg.wait_for_timeout(900)
        P.chrono("ouverture_export", t)
        P.ecran("export")
        if COURT or theme != "dark":
            return {"export": "sauté (--court ou thème clair)"}
        t = time.time()
        with P.pg.expect_download(timeout=600000) as dl:
            tap(bouton(P.pg, "Démo gratuite du morceau complet"), "tel")
            P.pg.wait_for_timeout(1500)
            P.ecran("export_en_cours")
        d = dl.value
        P.chrono("demo_mp3", t)
        path = OUT / f"{P.nom}_{d.suggested_filename}"
        d.save_as(str(path))
        P.pg.wait_for_timeout(800)
        P.ecran("export_fini")
        return {"fichier": d.suggested_filename, "octets": path.stat().st_size}
    P.etape("exporter la démo MP3", exporter)
    P.fin(); ctx.close()


# ------------------------------------------------------------------ 2. ingé son (PC, mode avancé)
def inge(b, theme):
    ctx, pg, log = contexte(b, "pc", theme, simple=False)
    P = Parcours(f"inge_pc_{theme}", pg, log, "pc")

    def session():
        ouvrir_beat(P)
        P.ecran("session")
        return {"pistes": pg.evaluate("() => (window.__novaEdit?.getState().tracks || []).map(t => t.name)")}
    P.etape("session de 12 pistes (beat + voix + bus + retours)", session)

    def deux_prises():
        for _ in range(2):
            pg.keyboard.press("Home"); prise(P, 4); fermer_carte(pg)
        P.ecran("deux_prises")
    P.etape("deux prises sur REC", deux_prises)

    def console():
        t = time.time(); bouton(pg, "^Console$").click(); pg.wait_for_timeout(1000); P.chrono("console", t)
        P.ecran("console")
        try:
            t = time.time(); pg.locator(".fx-slot button[aria-label^='Ouvrir']").locator("visible=true").first.click(); pg.wait_for_timeout(1000)
            P.chrono("ouverture_effet", t)
            P.ecran("effet_insert")
            pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
            pg.evaluate("() => document.querySelectorAll('.custom-scroll').forEach(e => e.scrollLeft = 99999)")
            bus = pg.get_by_text("+ Bus").locator("visible=true")
            if bus.count():
                bus.first.click(); pg.wait_for_timeout(800); P.ecran("bus_cree"); pg.keyboard.press("Escape")
            return {"bouton_bus": bus.count()}
        finally:
            bouton(pg, "^Pistes$").click(); pg.wait_for_timeout(600)
    P.etape("console : inserts, effet ouvert, nouveau bus", console)

    def envois():
        bouton(pg, "^Envois de LEAD COUPLET$").click(); pg.wait_for_timeout(500)
        P.ecran("envois")
        bouton(pg, "^Envois de LEAD COUPLET$").click(); pg.wait_for_timeout(300)
    P.etape("envois (écho, reverbs) d'une piste voix", envois)

    def automation():
        t = time.time(); bouton(pg, "^Auto$").click(); pg.wait_for_timeout(900); P.chrono("automation", t)
        P.ecran("automation")
        bouton(pg, "^Pistes$").click(); pg.wait_for_timeout(500)
    P.etape("vue automation", automation)

    def modes():
        out = {}
        for m in ("SHUF", "SLIP", "GRID", "SPOT"):
            loc = pg.locator("[data-edit-mode]").filter(has_text=re.compile(m))
            if loc.count():
                loc.first.click(); pg.wait_for_timeout(250)
                out[m] = pg.evaluate("() => window.__novaEditMode?.get().mode")
        P.ecran("mode_spot")
        rec = pg.locator("[data-track-header='track-rec-main']").first.bounding_box()
        pg.mouse.click(rec["x"] + rec["width"] + 40, rec["y"] + 60); pg.wait_for_timeout(700)
        P.ecran("spot_fenetre")
        pg.keyboard.press("Escape")
        pg.locator("[data-edit-mode]").filter(has_text=re.compile("SLIP")).first.click()
        return out
    P.etape("modes d'édition Shuffle / Slip / Grid / Spot", modes)

    def prises():
        pg.locator("button", has_text=re.compile(r"Prises \(\d")).locator("visible=true").first.click(); pg.wait_for_timeout(700)
        P.ecran("prises_playlists")
        pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    P.etape("prises (comp, playlists)", prises)

    def justesse():
        rec = pg.locator("[data-track-header='track-rec-main']").first.bounding_box()
        pg.mouse.click(rec["x"] + rec["width"] + 40, rec["y"] + 60, button="right"); pg.wait_for_timeout(500)
        P.ecran("menu_clip")
        t = time.time(); pg.get_by_text("Justesse note par note…").first.click(); pg.wait_for_timeout(2500); P.chrono("justesse", t)
        P.ecran("justesse")
        pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
    P.etape("justesse note par note", justesse)

    def master():
        t = time.time(); pg.locator("[data-nova-open-master]").first.click(); pg.wait_for_timeout(900); P.chrono("master_nova", t)
        P.ecran("master_nova")
        pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    P.etape("Master Nova", master)

    def stems():
        t = time.time(); pg.keyboard.press("Control+Shift+E"); pg.get_by_text("Réglages avancés").first.wait_for(timeout=5000); P.chrono("export_ctrl_maj_e", t)
        P.ecran("export")
        pg.get_by_text("Réglages avancés").first.click(); pg.wait_for_timeout(600)
        P.ecran("export_avance")
        txt = pg.inner_text("body")
        pg.keyboard.press("Escape")
        return {"stems_proposes": bool(re.search(r"pistes séparées|stems", txt, re.I))}
    P.etape("export des stems (Ctrl+Maj+E)", stems)
    P.fin(); ctx.close()


# ------------------------------------------------------------------ 3. beatmaker
def beatmaker(b, vp, theme):
    ctx, pg, log = contexte(b, vp, theme, simple=False)
    P = Parcours(f"beatmaker_{vp}_{theme}", pg, log, vp)

    def melodie():
        t = time.time()
        pg.goto(BASE, wait_until="domcontentloaded")
        pg.get_by_text("Mélodies", exact=False).first.click(timeout=45000); pg.wait_for_timeout(1200)
        P.ecran("melodies")
        pg.get_by_text("Neon Storm", exact=False).first.click(); pg.wait_for_timeout(1500)
        close_welcome(pg); wait_text_gone(pg, "Chargement", 60); pg.wait_for_timeout(1500); close_welcome(pg)
        P.chrono("studio_melodie_batterie", t)
        P.ecran("boite_a_rythmes")
    P.etape("mélodie du catalogue → boîte à rythmes", melodie)

    def style():
        drums = pg.locator("[aria-labelledby='drums-title']")
        tap(drums.get_by_role("button", name=re.compile("Drill")).first, vp); pg.wait_for_timeout(800)
        pas = drums.locator("button[aria-label*=', pas 3']").first
        tap(pas, vp); pg.wait_for_timeout(300)
        P.ecran("batterie_drill_pas")
        tap(drums.get_by_role("button", name="Fermer la batterie"), vp); pg.wait_for_timeout(400)
    P.etape("style Drill + un pas", style)

    def synth():
        t = time.time(); tap(bouton(pg, "Piste MIDI"), vp); pg.wait_for_timeout(1200); P.chrono("piste_midi_piano_roll", t)
        # Une piste MIDI ouvre le piano roll en plein écran : regardé seulement (V25 le modifie).
        P.ecran("piano_roll_regarde")
        pg.keyboard.press("Escape"); pg.wait_for_timeout(600)
        fermer = pg.locator("button[title='Fermer (Échap)']").locator("visible=true")
        if fermer.count():
            fermer.first.click(); pg.wait_for_timeout(500)
        P.ecran("piste_midi")
        pill = pg.locator("[data-testid^=synth-pill]").locator("visible=true")
        if pill.count():
            t = time.time(); tap(pill.last, vp); pg.locator("[data-testid=synth-panel]").wait_for(timeout=8000); P.chrono("synth_nova", t)
            P.ecran("synthe_nova")
            pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
        return {"pastille_synthe": pill.count()}
    P.etape("piste MIDI + synthé NOVA", synth)

    def tempo():
        t = pg.locator(".nova-verre-haut [title^='Tempo'], [data-nova-transport] [title^='Tempo']").locator("visible=true")
        if t.count():
            t.first.dblclick(); pg.wait_for_timeout(300)
            inp = pg.locator("[title^='Tempo'] input").first
            if visible(inp):
                inp.fill("100"); inp.press("Enter"); pg.wait_for_timeout(500)
        P.ecran("tempo_100")
        return {"tempo_affiche": pg.locator("[title^='Tempo']").locator("visible=true").first.inner_text() if t.count() else None}
    P.etape("tempo et tonalité", tempo)
    P.fin(); ctx.close()


# ------------------------------------------------------------------ 4. collaboration
def collab(b):
    from gel_pre_effet import prepare, open_project_file
    from collab_sim import FakeNovaCloud, FakeRealtime, connect
    from collab_direct import artist_project, dismiss, wait_for, open_panel, panel_text
    from collab_direct import collab as cstate
    cloud, rt = FakeNovaCloud(), FakeRealtime()
    src = OUT / "collab_session_hote.novaproj.zip"
    artist_project(src)
    lA, lG = Log("collab_hote"), Log("collab_invite")
    cA, A = new_page(b, "pc", lA)
    cG, G = new_page(b, "tel", lG)
    prepare(A, None); prepare(G, None)
    connect(A, cloud, rt, "A", "11111111-1111-4111-8111-111111111111", "lina@test.local")
    connect(G, cloud, rt, "G", "33333333-3333-4333-8333-333333333333", "sam@test.local")
    H = Parcours("collab_hote_pc", A, lA, "pc")
    I = Parcours("collab_invite_tel", G, lG, "tel")
    lien = {}

    def hote():
        open_project_file(A, src, {}, "collab_hote_00_session")
        dismiss(A)
        t = time.time(); open_panel(A); H.chrono("panneau_collab", t)
        H.ecran("panneau")
        A.get_by_placeholder("Ton nom (affiché aux autres)").fill("Lina")
        t = time.time()
        A.get_by_role("button", name=re.compile("Démarrer la collaboration en direct")).click()
        wait_for(A, lambda: cstate(A, "c.role()") == "artist", 60, what="hôte en ligne")
        H.chrono("mise_en_ligne", t)
        A.wait_for_timeout(600)
        H.ecran("en_ligne")
        sid = next(k for k, v in cloud.sessions.items() if v["manifest"])
        lien["s"] = f"{sid}.{cloud.sessions[sid]['secret']}"
    H.etape("hôte : ouvrir sa session et la mettre en ligne", hote)

    def arrivee():
        t = time.time()
        G.goto(f"{BASE}?session={lien['s']}&invite=1", wait_until="domcontentloaded")
        G.get_by_test_id("arrival-role-artist").wait_for(timeout=45000)
        I.chrono("arrivee_choix_du_role", t)
        G.wait_for_timeout(2000)  # la carte de bienvenue s'ouvrait 1,2 s après l'arrivée
        I.ecran("arrivee")
        return {"bienvenue_par_dessus": "Ta voix sur nos beats" in G.inner_text("body")}
    I.etape("invité : ouvre le lien d'invitation", arrivee)

    def rejoindre():
        G.get_by_test_id("arrival-role-artist").tap(); G.wait_for_timeout(300)
        t = time.time()
        bouton(G, "Rejoindre comme").tap()
        wait_for(G, lambda: cstate(G, "c.role()") == "artist", 60, what="invité relié")
        I.chrono("rejoindre", t)
        G.wait_for_timeout(1200)
        I.ecran("relie")
        return {"panneau": re.sub(r"\s+", " ", panel_text(G))[:300]}
    I.etape("invité : choisit « Artiste » et rejoint", rejoindre)

    def voit():
        G.keyboard.press("Escape"); G.wait_for_timeout(2500)
        I.ecran("studio_invite")
        txt = G.inner_text("body")
        return {"bienvenue_apres_fermeture": "Ta voix sur nos beats" in txt, "piste_hote_visible": "Voix lead" in txt}
    I.etape("invité : ce qu'il voit après avoir fermé le panneau", voit)

    def peut():
        tap(bouton(G, "^Enregistrer$"), "tel"); G.wait_for_timeout(1200)
        casque = G.get_by_role("button", name="Oui, j'ai un casque")
        if visible(casque):
            I.ecran("question_casque")
            casque.tap()
        G.wait_for_timeout(3000)
        I.ecran("rec_invite")
        tap(bouton(G, "Arrêter l'enregistrement|^Enregistrer$"), "tel"); G.wait_for_timeout(3000)
        I.ecran("apres_rec_invite")
        pistes = G.evaluate("() => (window.__novaEdit?.getState().tracks || []).map(t => t.name)")
        return {"pistes_chez_invite": pistes}
    I.etape("invité : REC (doit enregistrer sur SA piste)", peut)

    def hote_voit():
        open_panel(A); A.wait_for_timeout(1500)
        H.ecran("hote_voit_invite")
        return {"panneau": re.sub(r"\s+", " ", panel_text(A))[:300]}
    H.etape("hôte : voit l'invité", hote_voit)
    H.fin(); I.fin()
    cA.close(); cG.close()


PROFILS = {
    "artiste": lambda b: [artiste(b, t) for t in ("dark", "light")],
    "inge": lambda b: [inge(b, t) for t in ("dark", "light")],
    "beatmaker": lambda b: [beatmaker(b, "pc", "dark"), beatmaker(b, "tab", "light")],
    "collab": collab,
}

if __name__ == "__main__":
    todo = [k for k in PROFILS if not ARGS or k in ARGS]
    t0 = time.time()
    with sync_playwright() as p:
        br = launch(p)
        for k in todo:
            print(f"== {k}", flush=True)
            try:
                PROFILS[k](br)
            except Exception as e:  # noqa
                R.setdefault(k, {})["EXCEPTION"] = f"{type(e).__name__}: {str(e)[:400]}"
                print("   EXCEPTION", R[k]["EXCEPTION"], flush=True)
        br.close()
    R["_duree_s"] = round(time.time() - t0, 1)
    nom = "resume_" + "_".join(todo) + ".json" if ARGS else "resume.json"
    (OUT / nom).write_text(json.dumps(R, ensure_ascii=False, indent=1), encoding="utf-8")
    ko = [(n, e["etape"]) for n, v in R.items() if isinstance(v, dict) for e in v.get("etapes", []) if not e["ok"]]
    print("étapes en échec :", ko or "aucune")
    print("sorties :", OUT)
