"""Lot 6 (BandLab Splitter) : 6 stems, voix lead / chœurs, stem → MIDI, licence des beats,
avec le VRAI pont (nova_bridge_server.py, port de test 8806) et le VRAI module Demucs du PC.
100 % hors production (qa_hors_prod via qalib), navigateurs headless (un seul à la fois).

Usage (serveur NOVA lancé : npx vite --port 3459 --strictPort) :
  NOVA_URL=http://127.0.0.1:3459/ python qa/stems6.py

  A. site sans l'appli (bureau + téléphone) : message clair « sur ton PC, appli Windows »
  B. appli, module prêt : les 4 choix (2, 4, 6, voix lead / chœurs), 6 stems → 6 pistes nommées
     et calées, « Basse → MIDI » ouvre Audio → MIDI sur le stem de basse et crée une piste MIDI,
     voix lead / chœurs → 3 pistes + crédit UVR ; fenêtre au téléphone (390 × 844)
  C. licence : beat du catalogue NON acheté → refus + « Acheter cette instru » (aucun envoi au
     pont) ; beat acheté → stems marqués « beat » (instrumentId, beatStem), aucun WAV gardé
  D. premier usage (module sans le modèle 6 stems, dossier temporaire) : taille annoncée,
     téléchargement visible, Annuler pendant le téléchargement, puis téléchargement + séparation

Pas de carte ASIO, aucune fenêtre : le pont est lancé caché, le module stems est celui de
%LOCALAPPDATA%\\NovaStudio\\stems (installé, 6 stems et voix lead / chœurs compris).
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-bandlab\lot6_stems\qa")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3459/")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import *  # noqa: E402,F401,F403
import stems_separation as ss  # noqa: E402

PORT = int(os.environ.get("NOVA_TEST_PORT", "8806"))
REAL_HOME = Path(os.environ["LOCALAPPDATA"]) / "NovaStudio" / "stems"
RESULTS = {}


def state(page):
    return page.evaluate("""() => (window.__novaEdit.getState().tracks || []).map(t => ({ id: t.id, name: t.name, type: t.type,
        instrumentId: t.instrumentId ?? null, beatStem: !!t.beatStem,
        clips: (t.clips || []).map(c => ({ id: c.id, start: c.start, offset: c.offset || 0, duration: c.duration, muted: !!c.isMuted,
          notes: (c.notes || []).length })) }))""")


def stem_tracks(page):
    return [t for t in state(page) if re.search(r"\(stem\)$", t["name"] or "")]


def billing_route(page, owned: bool):
    """nova-billing simulé : compte normal (pas admin), beat du catalogue acheté ou non."""
    def handle(route):
        try:
            body = json.loads(route.request.post_data or "{}")
        except ValueError:
            body = {}
        act = body.get("action")
        if act == "export_access":
            ids = body.get("catalog_ids") or []
            items = [{"id": i, "title": "Beat QA", "kind": "beat", "owned": owned} for i in ids]
            d = ({"unlocked": True, "via": "licence", "reason": None, "missing": [], "items": items} if owned else
                 {"unlocked": False, "via": None, "reason": "catalogue_non_achete",
                  "missing": [{"id": i, "title": "Beat QA", "kind": "beat"} for i in ids], "items": items})
        else:
            d = {"plans": [], "admin": False, "free_exports_left": 0}
        route.fulfill(status=200, content_type="application/json", body=json.dumps(d))
    page.route("**/functions/v1/nova-billing", handle)


def arm_timer(page):
    """Chrono DANS la page (clic → « pistes ajoutées ») : le navigateur headless dessine
    lentement 7 à 10 pistes de formes d'onde (rendu logiciel) et les appels de Playwright
    attendent alors plusieurs secondes ; le temps vu par l'utilisateur est celui-ci."""
    page.evaluate("""() => { window.__stT0 = performance.now(); window.__stDone = null;
        const mo = new MutationObserver(() => { const r = document.querySelector('[data-testid=stems-ready] [role=status]');
          if (!window.__stDone && r && /pistes ajoutées/.test(r.textContent || '')) { window.__stDone = Math.round(performance.now() - window.__stT0); mo.disconnect(); } });
        mo.observe(document.body, { subtree: true, childList: true, characterData: true }); }""")


def wait_ready(page, timeout=600):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if page.get_by_test_id("stems-ready").count() and page.get_by_test_id("stems-ready").is_visible():
                ms = page.evaluate("() => window.__stDone")
                return round(ms / 1000, 1) if ms else round(time.time() - t0, 1)
        except Exception:  # appel Playwright trop lent pendant le dessin des pistes : on réessaie
            pass
        page.wait_for_timeout(500)
    raise TimeoutError("séparation trop longue")


def pick(page, value):
    page.get_by_test_id(f"stems-choice-{value}").locator("input").check()
    page.wait_for_timeout(200)


# --- A. site sans l'appli -------------------------------------------------------------

def open_by_event(page, label):
    """Téléphone : pas de clic droit ; « Séparer en stems » s'ouvre par l'événement de l'appli
    (nova:separate-stems, le même que les autres entrées)."""
    ss.dismiss_popups(page)
    page.evaluate("""() => { const t = window.__novaEdit.getState().tracks.find(x => x.name === 'Beat');
        window.dispatchEvent(new CustomEvent('nova:separate-stems', { detail: { trackId: t.id, clipId: t.clips[0].id } })); }""")
    page.get_by_test_id("stems-dialog").wait_for(timeout=8000)
    page.wait_for_timeout(800)


def scenario_web(page, log, res, vp):
    ss.prepare(page, port=None, desktop=False)
    ss.open_project_file(page, PROJECT, res, f"A0_projet_web_{vp}")
    if vp.startswith("tel"):
        open_by_event(page, f"A1_web_{vp}")
    else:
        ss.open_stems_menu(page, f"A1_web_{vp}")
    page.get_by_test_id("stems-web").wait_for(timeout=5000)
    shot(page, f"A2_web_sans_appli_{vp}")
    txt = page.get_by_test_id("stems-web").inner_text()
    res["message"] = txt[:300]
    assert "6 stems" in txt and "voix lead" in txt.lower() and "Nova Studio" in txt, txt
    ov = page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
    res["debordement_horizontal_px"] = ov


# --- B. appli, module prêt --------------------------------------------------------------

def scenario_six_midi_leadback(page, log, res, vp):
    ss.prepare(page, port=PORT)
    page.set_default_timeout(60000)
    ss.open_project_file(page, PROJECT, res, "B0_projet")
    ss.open_stems_menu(page, "B1")
    page.get_by_test_id("stems-ready").wait_for(timeout=20000)
    for n in ("2", "4", "6", "leadback"):
        page.get_by_test_id(f"stems-choice-{n}").wait_for(timeout=5000)
        assert page.get_by_test_id(f"stems-choice-{n}").locator("input").is_enabled(), n
    res["telechargements_annonces"] = page.locator("[data-testid^=stems-download-]").all_inner_texts()
    shot(page, "B2_quatre_choix")
    pick(page, "6")
    shot(page, "B3_choix_6_stems")
    before = state(page)
    src = next(t for t in before if t["name"] == "Beat")
    arm_timer(page)
    page.get_by_test_id("stems-start").click()
    page.get_by_test_id("stems-running").wait_for(timeout=15000)
    page.wait_for_timeout(600)
    shot(page, "B4_separation_6_en_cours")
    res["six_s"] = wait_ready(page)
    page.wait_for_timeout(700)
    shot(page, "B5_six_stems_ajoutes")
    st = stem_tracks(page)
    res["pistes_6"] = [t["name"] for t in st]
    assert res["pistes_6"] == ["Voix (stem)", "Batterie (stem)", "Basse (stem)", "Guitare (stem)", "Piano (stem)", "Autres (stem)"], res["pistes_6"]
    c0 = src["clips"][0]
    for t in st:
        c = t["clips"][0]
        assert (c["start"], c["offset"], c["duration"]) == (c0["start"], c0["offset"], c0["duration"]), (t["name"], c, c0)
        assert not t["beatStem"] and t["instrumentId"] is None, t
    res["calage"] = "6 clips : même début, même découpe, même durée que le clip d'origine"
    # Basse → MIDI
    midi = page.get_by_test_id("stems-midi")
    res["boutons_midi"] = midi.locator("button").all_inner_texts()
    assert any("Basse" in b for b in res["boutons_midi"]) and any("Piano" in b for b in res["boutons_midi"]), res["boutons_midi"]
    n_tracks = len(state(page))
    midi.get_by_role("button", name=re.compile("Basse → MIDI")).click()
    page.get_by_test_id("audio-to-midi").wait_for(timeout=10000)
    page.wait_for_timeout(1500)
    shot(page, "B6_basse_vers_midi")
    create = page.get_by_test_id("a2m-create")
    t0 = time.time()
    while time.time() - t0 < 60 and not create.is_enabled():
        page.wait_for_timeout(500)
    res["a2m_titre"] = page.get_by_test_id("audio-to-midi").get_attribute("aria-label")
    create.click()
    page.wait_for_timeout(1500)
    after = state(page)
    new = [t for t in after if t["type"] == "MIDI" and t["id"] not in {x["id"] for x in before}]
    res["piste_midi"] = [{"nom": t["name"], "notes": sum(c["notes"] for c in t["clips"])} for t in new]
    # Basse de « Silence blanc » (808 en Si bémol mineur, fondamentale 44 à 60 Hz) : au moins une note
    # par mesure environ sur 45 s (avant la détection dès 30 Hz : 5 notes seulement).
    assert len(after) == n_tracks + 1 and new and res["piste_midi"][0]["notes"] >= 12, res["piste_midi"]
    shot(page, "B7_piste_midi_creee")
    page.keyboard.press("Escape")
    # Voix lead / chœurs sur le même clip
    ss.open_stems_menu(page, "B8")
    page.get_by_test_id("stems-ready").wait_for(timeout=15000)
    pick(page, "leadback")
    page.get_by_test_id("stems-credit").wait_for(timeout=3000)
    res["credit"] = page.get_by_test_id("stems-credit").inner_text()
    shot(page, "B9_choix_voix_lead_choeurs")
    arm_timer(page)
    page.get_by_test_id("stems-start").click()
    page.get_by_test_id("stems-running").wait_for(timeout=15000)
    res["leadback_s"] = wait_ready(page)
    page.wait_for_timeout(700)
    shot(page, "B10_voix_lead_choeurs_ajoutees")
    names = [t["name"] for t in stem_tracks(page)]
    res["pistes_leadback"] = [n for n in names if n in ("Voix lead (stem)", "Chœurs (stem)", "Instru (stem)")]
    assert res["pistes_leadback"] == ["Voix lead (stem)", "Chœurs (stem)", "Instru (stem)"], names
    res["resume"] = page.get_by_test_id("stems-ready").inner_text()[:240]


def scenario_phone_dialog(page, log, res, vp):
    """Fenêtre au téléphone (appli + vrai pont) : les 4 choix tiennent dans 390 px, sans débordement."""
    ss.prepare(page, port=PORT)
    page.set_default_timeout(60000)
    ss.open_project_file(page, PROJECT, res, "B11_projet_tel")
    open_by_event(page, "B12_tel")
    page.get_by_test_id("stems-ready").wait_for(timeout=20000)
    shot(page, "B12_tel_quatre_choix")
    pick(page, "leadback")
    page.get_by_test_id("stems-start").scroll_into_view_if_needed()
    shot(page, "B13_tel_voix_lead_choeurs")
    ov = page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
    res["debordement_horizontal_px"] = ov
    box = page.get_by_test_id("stems-start").bounding_box()
    res["bouton_separer"] = box
    assert ov <= 1 and box and box["height"] >= 44 and box["x"] >= 0 and box["x"] + box["width"] <= 391, (ov, box)


# --- C. licence des beats --------------------------------------------------------------

def scenario_licence(page, log, res, vp, owned=False):
    ss.prepare(page, port=PORT)
    page.set_default_timeout(60000)
    billing_route(page, owned)
    ss.open_project_file(page, PROJECT_CAT, res, f"C0_beat_catalogue_{'achete' if owned else 'non_achete'}")
    ss.open_stems_menu(page, f"C1_{'achete' if owned else 'non_achete'}")
    if not owned:
        page.get_by_test_id("stems-licence-refused").wait_for(timeout=15000)
        shot(page, "C2_beat_non_achete_refus")
        res["refus"] = page.get_by_test_id("stems-licence-refused").inner_text()[:300]
        assert page.get_by_role("button", name=re.compile("Acheter cette instru")).count() == 1
        assert not page.get_by_test_id("stems-start").count()
        return
    page.get_by_test_id("stems-ready").wait_for(timeout=20000)
    page.get_by_test_id("stems-beat-note").wait_for(timeout=3000)
    res["note_beat"] = page.get_by_test_id("stems-beat-note").inner_text()
    shot(page, "C3_beat_achete_pret")
    before_dirs = {p for p in ss.SORTIES.rglob("*") if p.is_dir()} if ss.SORTIES.exists() else set()
    pick(page, "2")
    arm_timer(page)
    page.get_by_test_id("stems-start").click()
    page.get_by_test_id("stems-running").wait_for(timeout=15000)
    res["deux_s"] = wait_ready(page)
    page.wait_for_timeout(600)
    shot(page, "C4_beat_achete_stems")
    st = stem_tracks(page)
    res["pistes"] = [{"nom": t["name"], "instrumentId": t["instrumentId"], "beatStem": t["beatStem"]} for t in st]
    assert st and all(t["beatStem"] and t["instrumentId"] == "qa-beat-1" for t in st), res["pistes"]
    after_dirs = {p for p in ss.SORTIES.rglob("*") if p.is_dir()} if ss.SORTIES.exists() else set()
    res["dossiers_wav_nouveaux"] = [str(p) for p in after_dirs - before_dirs]
    assert not res["dossiers_wav_nouveaux"], res["dossiers_wav_nouveaux"]
    leftovers = [p for p in Path(tempfile.gettempdir()).glob("nova-stems-*")]
    res["dossiers_temporaires_restants"] = [str(p) for p in leftovers]
    assert "Documents" not in page.get_by_test_id("stems-ready").inner_text()


# --- D. premier usage : téléchargement du modèle 6 stems ----------------------------------

def make_home_without_6s() -> Path:
    """Module stems « comme juste installé » : même environnement Python (jonction), modèle
    htdemucs (lien physique), sans le modèle 6 stems ni l'ajout voix lead / chœurs."""
    home = Path(tempfile.mkdtemp(prefix="nova-stems-qa6-"))
    subprocess.run(["cmd", "/c", "mklink", "/J", str(home / "env"), str(REAL_HOME / "env")], capture_output=True, check=True,
                   creationflags=0x08000000)
    ck = home / "models" / "hub" / "checkpoints"
    ck.mkdir(parents=True)
    os.link(REAL_HOME / "models" / "hub" / "checkpoints" / "955717e8-8726e21a.th", ck / "955717e8-8726e21a.th")
    info = json.loads((REAL_HOME / "installed.json").read_text(encoding="utf-8"))
    info.pop("addons", None)
    (home / "installed.json").write_text(json.dumps(info), encoding="utf-8")
    shutil.copyfile(Path(__file__).resolve().parents[1] / "bridge-python" / "stems_worker.py", home / "stems_worker.py")
    return home


def drop_home(home: Path):
    j = home / "env"
    if j.exists():
        os.rmdir(j)  # jonction : on retire le lien, jamais l'environnement réel
    shutil.rmtree(home, ignore_errors=True)


def scenario_first_use(page, log, res, vp):
    ss.prepare(page, port=PORT)
    page.set_default_timeout(60000)
    ss.open_project_file(page, PROJECT, res, "D0_projet")
    ss.open_stems_menu(page, "D1")
    page.get_by_test_id("stems-ready").wait_for(timeout=20000)
    res["annonce_6"] = page.get_by_test_id("stems-download-6").inner_text()
    assert "55 Mo" in res["annonce_6"], res["annonce_6"]
    pick(page, "6")
    res["bouton"] = page.get_by_test_id("stems-start").inner_text()
    shot(page, "D2_taille_annoncee")
    page.get_by_test_id("stems-start").click()
    page.get_by_test_id("stems-running").wait_for(timeout=15000)
    t0 = time.time()
    while time.time() - t0 < 30 and "Téléchargement" not in page.get_by_test_id("stems-running").inner_text():
        page.wait_for_timeout(100)
    res["pendant_telechargement"] = page.get_by_test_id("stems-running").inner_text()[:200]
    shot(page, "D3_telechargement_en_cours")
    n0 = len(stem_tracks(page))
    page.get_by_test_id("stems-running").get_by_role("button", name="Annuler", exact=True).click()
    page.get_by_test_id("stems-cancelled").wait_for(timeout=30000)
    page.wait_for_timeout(3000)
    shot(page, "D4_telechargement_annule")
    assert len(stem_tracks(page)) == n0
    res["apres_annulation_modele_present"] = (HOME_D / "models" / "hub" / "checkpoints" / "5c90dfd2-34c22ccb.th").exists()
    arm_timer(page)
    page.get_by_test_id("stems-start").click()
    page.get_by_test_id("stems-running").wait_for(timeout=15000)
    res["six_premier_usage_s"] = wait_ready(page, 900)
    page.wait_for_timeout(700)
    shot(page, "D5_six_stems_apres_telechargement")
    res["pistes"] = [t["name"] for t in stem_tracks(page)]
    assert len(res["pistes"]) == n0 + 6, res["pistes"]
    # Le modèle est là : plus de taille annoncée pour 6 stems.
    assert not page.get_by_test_id("stems-download-6").count()


def make_catalogue_project(src: Path, dst: Path):
    with zipfile.ZipFile(src) as z:
        st = json.loads(z.read("project.json"))
        audio = z.read("audio/beat.wav")
    t = st["tracks"][0]
    t["id"] = "instrumental"
    t["instrumentId"] = "qa-beat-1"
    st["selectedTrackId"] = "instrumental"
    st["id"] = "proj-stems-catalogue"
    with zipfile.ZipFile(dst, "w") as z:
        z.writestr("project.json", json.dumps(st))
        z.writestr("audio/beat.wav", audio)


if __name__ == "__main__":
    shutil.rmtree(ss.SORTIES, ignore_errors=True)
    PROJECT = OUT / "projet_stems6.zip"
    PROJECT_CAT = OUT / "projet_stems6_catalogue.zip"
    ss.make_project(PROJECT)
    make_catalogue_project(PROJECT, PROJECT_CAT)
    ss.PROJECT = PROJECT
    ONLY = {x.upper() for x in sys.argv[1:]}  # ex. « python qa/stems6.py B D » : seulement ces parties
    want = lambda k: not ONLY or k in ONLY  # noqa: E731
    report = {}
    if want("A"):
        report["A_web_pc"] = run_one(scenario_web, "pc", "A_web_pc")
        report["A_web_tel"] = run_one(scenario_web, "tel390", "A_web_tel")
    if want("B") or want("C"):
        br = ss.start_bridge(PORT)
        try:
            if want("B"):
                report["B_six_midi_leadback"] = run_one(scenario_six_midi_leadback, "pc", "B_six_midi_leadback")
                report["B_tel"] = run_one(scenario_phone_dialog, "tel390", "B_tel")
            if want("C"):
                report["C_non_achete"] = run_one(lambda p, l, r, v: scenario_licence(p, l, r, v, False), "pc", "C_non_achete")
                report["C_achete"] = run_one(lambda p, l, r, v: scenario_licence(p, l, r, v, True), "pc", "C_achete")
        finally:
            ss.stop_bridge(br)
            time.sleep(2)
    if want("D"):
        HOME_D = make_home_without_6s()
        try:
            br = ss.start_bridge(PORT, HOME_D)
            try:
                report["D_premier_usage"] = run_one(scenario_first_use, "pc", "D_premier_usage")
            finally:
                ss.stop_bridge(br)
                time.sleep(2)
        finally:
            drop_home(HOME_D)
    report["ok"] = all(v.get("ok") for k, v in report.items() if isinstance(v, dict))
    (OUT / "qa_stems6.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=1))
    sys.exit(0 if report["ok"] else 1)
