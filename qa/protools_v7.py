"""Scénario de bout en bout V7 : raccourcis Pro Tools et petites fonctions.

Sur une vraie voix (extrait d'un stem de session du studio), dans un navigateur
headless : aide « Raccourcis » avec recherche, grille 1/32 et triolets, Strip
Silence (fenêtre, aperçu, application, Ctrl+Z), renommer et colorer un clip,
couleur de piste, hauteur des pistes, pavé numérique (repères « . N . »,
Entrée du pavé), Memory Locations, Ctrl+E, Keyboard Focus (T / R zoom), flèches.
Puis tablette et téléphone : la page s'ouvre sans erreur.

Usage :
  NOVA_URL=http://localhost:3412/ QA_OUT="D:\\1 WORK\\CONTENU\\nova-protools\\automation" python qa/protools_v7.py
"""
import json, os, re, sys, time, zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-protools\automation")
os.environ.setdefault("NOVA_URL", "http://localhost:3412/")
from qalib import *  # noqa
from gel_pre_effet import prepare, open_project_file  # noqa

VOICE = OUT / "strip_source_1306_voix_24-34s.wav"


def make_project(path: Path):
    clip = {"id": "prise", "name": "Prise 1", "start": 0, "duration": 10, "offset": 0, "fadeIn": 0, "fadeOut": 0,
            "color": "#22d3ee", "type": "AUDIO", "audioRef": "audio/voix.wav", "gain": 1, "takeNumber": 1}
    base = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0,
            "outputTrackId": "master", "sends": [], "plugins": []}
    tracks = [{**base, "id": "voix", "name": "Voix", "type": "AUDIO", "color": "#22d3ee", "volume": 1.0, "clips": [clip]},
              {**base, "id": "back", "name": "Back", "type": "AUDIO", "color": "#a855f7", "volume": 1.0, "clips": []}]
    state = {
        "id": "proj-v7", "name": "V7 Pro Tools", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": "voix", "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.write(VOICE, "audio/voix.wav")


ST = "() => { const s = window.DAW_CONTROL.getState(); return { t: s.currentTime, rec: s.isRecording, playing: s.isPlaying, sel: s.selectedTrackId, markers: s.markers.map(m => ({ n: m.number, name: m.name, t: Math.round(m.time*1000)/1000 })), tracks: s.tracks.map(t => ({ id: t.id, color: t.color, clips: t.clips.map(c => ({ id: c.id, name: c.name, color: c.color, start: Math.round(c.start*1000)/1000, dur: Math.round(c.duration*1000)/1000 })) })) }; }"


def st(page): return page.evaluate(ST)
def voix(page): return next(t for t in st(page)["tracks"] if t["id"] == "voix")
def blur(page): page.evaluate("() => document.activeElement && document.activeElement.blur && document.activeElement.blur()")


def press(page, key, wait=250):
    blur(page); page.keyboard.press(key); page.wait_for_timeout(wait)


def row_box(page):
    return page.locator('[data-nova-target="track-voix"]').first.bounding_box()


def clip_point(page, t):
    """Point écran d'un instant t (s) sur la bande des clips de la piste Voix."""
    hb = row_box(page)
    zoom = float(page.locator('input[type=range][max="300"]').first.input_value())
    return hb["x"] + hb["width"] + t * zoom, hb["y"] + hb["height"] * 0.55


def set_range(page, label, value):
    page.evaluate("""([label, value]) => {
      const el = document.querySelector(`input[aria-label="${label}"]`);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, String(value)); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    }""", [label, value])


def run():
    res = {"name": "protools_v7", "ok": True, "verifs": [], "mesures": {}}
    src = OUT / "00_projet_v7.novaproj.zip"
    make_project(src)

    def check(label, cond, detail=""):
        res["verifs"].append({"verif": label, "ok": bool(cond), "detail": str(detail)[:300]})
        if not cond: res["ok"] = False

    with sync_playwright() as p:
        b = launch(p)
        log = Log("protools_v7")
        ctx, page = new_page(b, "pc", log)
        prepare(page, None, desktop=False)
        try:
            open_project_file(page, src, res, "v7_01_projet_ouvert")
            page.wait_for_timeout(1500)
            adv = page.get_by_role("button", name=re.compile("mode avancé", re.I)).locator("visible=true").first
            if adv.count() and adv.is_visible(): adv.click(); page.wait_for_timeout(800)

            # --- Aide des raccourcis avec recherche
            press(page, "?", 500)
            shot(page, "v7_02_raccourcis")
            n_all = page.locator('[role=dialog] li').count()
            page.locator('[data-testid="shortcuts-search"]').fill("séparer")
            page.wait_for_timeout(300)
            shot(page, "v7_03_raccourcis_recherche")
            found = page.locator('[role=dialog] li').all_inner_texts()
            check("Aide : tous les raccourcis listés", n_all >= 60, f"{n_all} lignes")
            check("Aide : la recherche « séparer » trouve Ctrl+E", any("Ctrl + E" in t for t in found), found[:4])
            page.keyboard.press("Escape"); page.wait_for_timeout(300)

            # --- Grille 1/32 et triolets (clic droit sur la timeline vide)
            hb = row_box(page)
            page.mouse.click(hb["x"] + hb["width"] + 900, hb["y"] + hb["height"] + 200, button="right")
            page.wait_for_timeout(400)
            shot(page, "v7_04_menu_grille")
            # Les valeurs de grille sont des « menuitemradio » depuis l'audit G3 (avant : boutons).
            grid_item = lambda n: page.get_by_role("menuitemradio", name=n, exact=True).or_(page.get_by_role("button", name=n, exact=True)).first
            grid_item("1/32").click(); page.wait_for_timeout(300)
            g1 = page.evaluate("() => window.gridSize")
            page.mouse.click(hb["x"] + hb["width"] + 900, hb["y"] + hb["height"] + 200, button="right"); page.wait_for_timeout(300)
            grid_item("1/8 triolet").click(); page.wait_for_timeout(300)
            g2 = page.evaluate("() => window.gridSize")
            label = page.get_by_role("button", name="Grille 1/8 triolet").count()
            check("Grille 1/32 puis 1/8 triolet", g1 == "1/32" and g2 == "1/8T", f"{g1} → {g2}")
            check("La grille choisie s'affiche dans la barre", label >= 1)
            # Flèche → sans sélection : la tête de lecture avance d'un pas de grille (1/8T = 1/6 s à 120 BPM)
            press(page, "Home")
            press(page, "ArrowRight")
            t_arrow = st(page)["t"]
            check("Flèche → : tête de lecture d'un pas de grille (1/8T)", abs(t_arrow - 1 / 6) < 0.01, t_arrow)

            # --- Pavé numérique : repères
            press(page, "Home")
            press(page, "Numpad2"); press(page, "NumpadEnter")
            press(page, "Numpad2"); press(page, "NumpadEnter")
            press(page, "Home")
            press(page, "NumpadDecimal", 80); press(page, "Numpad2", 80); press(page, "NumpadDecimal", 300)
            s = st(page)
            check("Entrée du pavé : 2 repères numérotés", [m["n"] for m in s["markers"]] == [1, 2], s["markers"])
            check("Pavé « . 2 . » : va au repère 2 (4 s)", abs(s["t"] - 4.0) < 0.01, s["t"])
            press(page, "Control+Numpad5", 500)
            ml = page.locator('[data-testid="memory-locations"]')
            check("Ctrl+5 : fenêtre des repères", ml.count() == 1 and ml.locator("li").count() == 2)
            shot(page, "v7_05_memory_locations")
            page.get_by_role("button", name="Fermer les repères").click(); page.wait_for_timeout(200)

            # --- Strip Silence sur la vraie voix
            x, y = clip_point(page, 1.0)
            page.mouse.click(x, y); page.wait_for_timeout(300)
            press(page, "Control+u", 800)
            dlg = page.locator('[data-testid="strip-silence"]')
            check("Ctrl+U : fenêtre Strip Silence", dlg.count() == 1)
            set_range(page, "Seuil", -45); set_range(page, "Blanc minimum", 300); set_range(page, "Marge avant", 50); set_range(page, "Marge après", 120)
            page.wait_for_timeout(600)
            summary = page.locator('[data-testid="strip-summary"]').inner_text()
            shot(page, "v7_06_strip_silence_apercu")
            page.locator('[data-testid="strip-apply"]').click(); page.wait_for_timeout(600)
            clips = voix(page)["clips"]
            res["mesures"]["strip_silence"] = {"resume": summary, "clips": clips}
            check("Strip Silence : la prise est découpée en passages", len(clips) >= 3, f"{len(clips)} clips · {summary}")
            check("Strip Silence : passages chantés gardés (≈ 2,2 s → 8 s)", clips and min(c["start"] for c in clips) > 1.9 and max(c["start"] + c["dur"] for c in clips) < 8.6, clips)
            shot(page, "v7_07_strip_silence_applique")
            press(page, "Control+z", 500)
            check("Ctrl+Z : la prise d'origine revient", len(voix(page)["clips"]) == 1, voix(page)["clips"])
            press(page, "Control+y", 500)

            # --- Renommer (double-clic) et couleur d'un clip, couleur de piste
            first = voix(page)["clips"][0]
            x, y = clip_point(page, first["start"] + first["dur"] / 2)
            page.mouse.click(x, y); page.wait_for_timeout(200)
            page.mouse.dblclick(x, y); page.wait_for_timeout(500)
            dlg = page.locator('[data-testid="clip-props"]')
            check("Double-clic sur un clip : fenêtre Renommer", dlg.count() == 1)
            page.get_by_role("textbox", name="Nom").fill("Couplet 1 · phrase A")
            page.get_by_role("radio", name="#ef4444").click()
            shot(page, "v7_08_renommer_clip")
            page.locator('[data-testid="clip-props-save"]').click(); page.wait_for_timeout(400)
            c = next(c for c in voix(page)["clips"] if c["id"] == first["id"])
            check("Clip renommé et coloré", c["name"] == "Couplet 1 · phrase A" and c["color"] == "#ef4444", c)
            hb = row_box(page)
            page.mouse.click(hb["x"] + 60, hb["y"] + 20, button="right"); page.wait_for_timeout(300)
            page.get_by_text("Couleur de la piste…").first.click(); page.wait_for_timeout(300)
            page.get_by_role("radio", name="#22c55e").click()
            page.locator('[data-testid="clip-props-save"]').click(); page.wait_for_timeout(300)
            check("Couleur de la piste", voix(page)["color"] == "#22c55e", voix(page)["color"])

            # --- Ctrl+E : séparer à la tête de lecture
            before = len(voix(page)["clips"])
            mid = c["start"] + c["dur"] / 2
            page.evaluate(f"() => window.DAW_CONTROL && null")
            x, y = clip_point(page, mid)
            page.mouse.click(x, y); page.wait_for_timeout(200)
            # place la tête de lecture dans le clip sélectionné (clic sur la règle)
            page.mouse.click(x, row_box(page)["y"] - 20); page.wait_for_timeout(300)
            page.mouse.click(x, y); page.wait_for_timeout(200)
            press(page, "Control+e", 400)
            after = len(voix(page)["clips"])
            check("Ctrl+E : le clip est séparé à la tête de lecture", after == before + 1, f"{before} → {after}")

            # --- Hauteur des pistes
            h0 = row_box(page)["height"]
            press(page, "Control+ArrowUp", 400)
            h1 = row_box(page)["height"]
            press(page, "Control+ArrowDown", 300); press(page, "Control+ArrowDown", 400)
            h2 = row_box(page)["height"]
            check("Ctrl+↑ / Ctrl+↓ : hauteur des pistes", h1 > h0 and h2 < h0, f"{h0} → {h1} → {h2}")
            shot(page, "v7_09_pistes_basses")
            press(page, "Control+ArrowUp", 300)

            # --- Flèches ↑ ↓ : piste précédente / suivante
            press(page, "ArrowDown"); sel1 = st(page)["sel"]
            press(page, "ArrowUp"); sel2 = st(page)["sel"]
            check("↓ / ↑ : change de piste", sel1 == "back" and sel2 == "voix", f"{sel1}, {sel2}")

            # --- Keyboard Focus : T zoom avant, R zoom arrière (sans enregistrer)
            zoom = lambda: float(page.locator('input[type=range][max="300"]').first.input_value())
            z0 = zoom()
            press(page, "Control+Alt+1", 400)
            badge = page.locator('[data-testid="keyboard-focus-badge"]').count()
            press(page, "t", 300); z1 = zoom()
            press(page, "r", 300); z2 = zoom()
            rec = st(page)["rec"]
            shot(page, "v7_10_keyboard_focus")
            press(page, "Control+Alt+1", 300)
            check("Keyboard Focus : témoin a–z affiché", badge == 1)
            check("Keyboard Focus : T zoome, R dézoome, sans lancer l'enregistrement", z1 > z0 and z2 < z1 and not rec, f"{z0} → {z1} → {z2}, rec={rec}")
            check("Keyboard Focus arrêté : témoin masqué", page.locator('[data-testid="keyboard-focus-badge"]').count() == 0)
        except Exception as e:  # noqa
            res["ok"] = False
            res["erreur"] = f"{type(e).__name__}: {str(e)[:600]}"
            try: shot(page, "v7_99_echec")
            except Exception: pass
        finally:
            res["erreurs_page_pc"] = [e["text"][:300] for e in log.errors()][:20]
            ctx.close()

        # --- Tablette et téléphone : rien ne casse
        for vp in ("tab", "tel"):
            logv = Log(f"v7_{vp}")
            ctxv, pv = new_page(b, vp, logv)
            prepare(pv, None, desktop=False)
            try:
                open_project_file(pv, src, res, f"v7_11_{vp}")
                pv.wait_for_timeout(1200)
                ok = pv.evaluate("() => !!window.DAW_CONTROL && window.DAW_CONTROL.getState().tracks.length >= 2")
                check(f"{vp} : projet ouvert sans erreur", ok and not logv.errors(), [e["text"][:160] for e in logv.errors()][:3])
            except Exception as e:  # noqa
                check(f"{vp} : projet ouvert sans erreur", False, f"{type(e).__name__}: {str(e)[:200]}")
            finally:
                ctxv.close()
        b.close()
    (OUT / "protools_v7_resultats.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in res.items() if k != "mesures"}, ensure_ascii=False, indent=1))
    return res


if __name__ == "__main__":
    run()
