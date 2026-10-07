"""Preuves d'interface du synthé NOVA (V24), navigateur headless, aucune fenêtre.

Projet avec une piste MIDI à l'ancien synthé -> pastille « Synthé simple » -> écran du
synthé (PC, tablette, téléphone) : choix d'un son, précédent / suivant, favori, réglage,
annuler (Ctrl+Z), aucun débordement horizontal, cibles tactiles.

Usage : python qa/synth_v24_ui.py [URL]   (par défaut http://localhost:3422/)
"""
import json, os, sys, zipfile
from pathlib import Path

URL = next((a for a in sys.argv[1:] if not a.startswith("--")), "http://localhost:3422/")
os.environ["NOVA_URL"] = URL
os.environ["QA_OUT"] = r"D:\1 WORK\CONTENU\nova-v24"
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402
from qalib import OUT, Log, new_page, shot, overflow_report  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

PROJ = OUT / "projet_synthe_v24.zip"


def make_project():
    notes = [{"id": f"n{i}", "pitch": p, "start": 0.0, "duration": 1.5, "velocity": 0.8} for i, p in enumerate([48, 55, 58, 62, 65])]
    track = {"id": "melodie", "name": "Mélodie", "type": "MIDI", "color": "#22d3ee", "isMuted": False, "isSolo": False,
             "isTrackArmed": False, "isFrozen": False, "volume": 1.0, "pan": 0, "outputTrackId": "master", "sends": [],
             "clips": [{"id": "c1", "name": "Accord", "start": 0, "duration": 2, "offset": 0, "fadeIn": 0, "fadeOut": 0,
                        "color": "#22d3ee", "type": "MIDI", "notes": notes, "gain": 1}],
             "plugins": [], "automationLanes": [], "totalLatency": 0}
    state = {
        "id": "proj-synthe-v24", "name": "Synthé V24", "bpm": 90, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": [track], "trackGroups": [], "markers": [], "selectedTrackId": "melodie", "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "projectMode": "BEATMAKING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(PROJ, "w") as z:
        z.writestr("project.json", json.dumps(state))


INIT = "try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_count_in', '0'); localStorage.setItem('nova_auto_clean', '0'); } catch (e) {}"


def open_project(page):
    page.add_init_script(INIT)
    page.route("**/functions/v1/nova-billing", lambda r: r.fulfill(status=200, content_type="application/json",
               body=json.dumps({"plans": [], "admin": True, "unlocked": True, "free_exports_left": 10})))
    page.goto(URL, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=30000)
    page.get_by_text("Charger Projet").first.click(); page.wait_for_timeout(700)
    with page.expect_file_chooser(timeout=8000) as fc:
        page.get_by_text("Charger depuis l'ordinateur").first.click()
    fc.value.set_files(str(PROJ))
    page.wait_for_timeout(5000)
    for name in ("C'est parti", "Plus tard"):
        b = page.get_by_role("button", name=name, exact=True).locator("visible=true").first
        try:
            if b.is_visible(): b.click(); page.wait_for_timeout(300)
        except Exception:
            pass
    page.wait_for_function("() => !!window.__novaEdit", timeout=20000)


def synth_state(page):
    return page.evaluate("() => { const t = window.__novaEdit.getState().tracks.find(x => x.id === 'melodie'); return t.novaSynth ? { presetId: t.novaSynth.presetId, name: t.novaSynth.name, cutoff: t.novaSynth.filter.cutoff } : null; }")


def panel_metrics(page):
    return page.evaluate("""() => {
      const p = document.querySelector('[data-testid=synth-panel]'); if (!p) return null;
      const box = p.firstElementChild.getBoundingClientRect();
      const small = Array.from(p.querySelectorAll('button, input')).filter(b => b.getClientRects().length).map(b => b.getBoundingClientRect())
        .filter(r => r.width > 0 && (r.height < 32 || r.width < 32)).length;
      const over = Array.from(p.querySelectorAll('*')).filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > window.innerWidth + 1; }).length;
      return { panneau: [Math.round(box.width), Math.round(box.height)], ecran: [innerWidth, innerHeight], elements_hors_ecran: over,
               cibles_de_moins_de_32px: small, defilement_horizontal: document.documentElement.scrollWidth > innerWidth + 1 };
    }""")


def run(vp, res):
    log = Log(f"synth_v24_{vp}")
    with sync_playwright() as p:
        b = qalib.launch(p)
        ctx, page = new_page(b, vp, log)
        r = {}
        try:
            open_project(page)
            pill = page.locator("[data-testid=synth-pill-melodie]").first
            pill.wait_for(timeout=15000)
            r["pastille"] = pill.get_attribute("title")
            r["avant"] = synth_state(page)
            shot(page, f"ui_{vp}_1_piste_pastille")
            pill.click(); page.wait_for_timeout(800)
            page.locator("[data-testid=synth-panel]").wait_for(timeout=10000)
            shot(page, f"ui_{vp}_2_ecran_sons")
            r["mesures_sons"] = panel_metrics(page)
            # Choisir un son (aperçu joué au clic)
            page.get_by_role("tab", name="Pianos & Rhodes").click(); page.wait_for_timeout(300)
            page.locator("[data-preset=rhodes-soul]").first.click(); page.wait_for_timeout(500)
            r["apres_choix"] = synth_state(page)
            r["nom_affiche"] = page.locator("[data-testid=synth-preset-name]").inner_text()
            # Suivant / précédent
            page.get_by_role("button", name="Son suivant").click(); page.wait_for_timeout(500)
            r["apres_suivant"] = synth_state(page)
            page.get_by_role("button", name="Son précédent").click(); page.wait_for_timeout(500)
            r["apres_precedent"] = synth_state(page)
            # Favori puis filtre Favoris
            page.get_by_role("button", name="Ajouter aux favoris").click(); page.wait_for_timeout(200)
            page.get_by_role("tab", name="★ Favoris (1)").click(); page.wait_for_timeout(300)
            r["favoris_affiches"] = page.locator("[data-testid=synth-presets] [data-preset]").count()
            shot(page, f"ui_{vp}_3_favoris")
            # Réglages
            page.locator("[data-testid=synth-tab-reglages]").click(); page.wait_for_timeout(400)
            shot(page, f"ui_{vp}_4_ecran_reglages")
            r["mesures_reglages"] = panel_metrics(page)
            page.wait_for_timeout(400)  # sort de l'anti-rebond de l'historique
            cut = page.locator("[data-testid=synth-cutoff]")
            cut.scroll_into_view_if_needed()
            cut.fill("300"); page.wait_for_timeout(500)
            r["apres_reglage_coupure"] = synth_state(page)
            r["aide_affichee"] = page.locator("[data-testid=synth-hint]").inner_text()[:140]
            shot(page, f"ui_{vp}_5_reglage_coupure")
            # Annuler (Ctrl+Z) : la coupure revient, puis le son d'avant.
            page.locator("[data-testid=synth-preset-name]").click()
            page.keyboard.press("Control+z"); page.wait_for_timeout(500)
            r["apres_annuler_1"] = synth_state(page)
            page.keyboard.press("Control+z"); page.wait_for_timeout(500)
            r["apres_annuler_2"] = synth_state(page)
            page.keyboard.press("Escape"); page.wait_for_timeout(400)
            r["ecran_ferme_par_echap"] = page.locator("[data-testid=synth-panel]").count() == 0
            r["pastille_apres"] = page.locator("[data-testid=synth-pill-melodie]").first.get_attribute("title")
        except Exception as e:  # noqa
            r["ERREUR"] = f"{type(e).__name__}: {str(e)[:300]}"
            try: shot(page, f"ui_{vp}_ECHEC")
            except Exception: pass
        r["erreurs_console"] = [e["text"][:200] for e in log.errors()][:8]
        ctx.close(); b.close()
    res[vp] = r


def main():
    make_project()
    res = {}
    for vp in ("pc", "tab", "tel"):
        run(vp, res)
    (OUT / "preuves_ui.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(res, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
