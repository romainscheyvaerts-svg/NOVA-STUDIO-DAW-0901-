"""R4 / R6 · scénario dans l'interface (navigateur headless, aucune fenêtre), avec captures
PC, tablette et téléphone, en thème sombre et clair :

  R4  fenêtre d'un effet → Presets (Enregistrer sous, liste, favori) → un réglage tourné
      (molette) → Comparer (A/B) ; Track Preset « Voix lead Make Music » rappelé sur la piste ;
  R6  Commit de la piste (originale inactive + masquée) → Restaurer ; Consolider avec effets
      depuis la barre de plage ; AudioSuite sur un clip → Revenir à l'original ;
      impression du BUS VOX ; tout en une étape d'annulation chacun (Ctrl+Z vérifié).

NOVA_URL=http://127.0.0.1:3444/ PYTHONIOENCODING=utf-8 python qa/r4_r6_ui.py [pc] [tab] [tel]
Sorties : D:\\1 WORK\\CONTENU\\nova-r4-r6\\ (captures ui_*.png, r4_r6_ui.json)
"""
import io, json, os, re, sys, wave, zipfile
from pathlib import Path
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3444/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-r4-r6")
from qalib import launch, new_page, shot, overflow_report, Log, OUT  # noqa: E402
from gel_pre_effet import prepare, open_project_file  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SR = 44100
PROJECT = OUT / "r4_r6_projet.novaproj.zip"


def voice_wav() -> bytes:
    t = np.arange(int(10 * SR)) / SR
    x = np.zeros_like(t)
    for a, b in [(1.0, 3.0), (4.0, 6.0)]:
        m = (t >= a) & (t < b)
        env = np.minimum(1, np.minimum((t[m] - a) / 0.02, (b - t[m]) / 0.02))
        x[m] = 0.5 * env * (np.sin(2 * np.pi * 220 * t[m]) + 0.4 * np.sin(2 * np.pi * 440 * t[m]) + 0.2 * np.sin(2 * np.pi * 660 * t[m])) / 1.6
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def make_project():
    base = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0}
    comp = {"id": "fx-comp", "name": "Compresseur", "type": "COMPRESSOR", "isEnabled": True, "latency": 0,
            "params": {"threshold": -18, "ratio": 4, "knee": 12, "attack": 0.003, "release": 0.25, "makeupGain": 1.6, "mix": 1, "scHpFreq": 80, "lookahead": 0, "autoMakeup": False, "mode": "CLEAN", "isEnabled": True}}
    clips = [{"id": f"c{i+1}", "name": f"Phrase {i+1}", "start": a, "duration": b - a, "offset": a, "fadeIn": 0.02, "fadeOut": 0.05,
              "color": "#22d3ee", "type": "AUDIO", "audioRef": "audio/voix.wav", "gain": 1, "takeNumber": 1} for i, (a, b) in enumerate([(1.0, 3.0), (4.0, 6.0)])]
    tracks = [
        {**base, "id": "voix", "name": "Voix lead", "type": "AUDIO", "color": "#22d3ee", "volume": 0.9, "outputTrackId": "bus-vox",
         "sends": [{"id": "send-verb-short", "level": 0.2, "isEnabled": True}], "clips": clips, "plugins": [comp]},
        {**base, "id": "bus-vox", "name": "BUS VOX", "type": "BUS", "color": "#fbbf24", "volume": 1.0, "outputTrackId": "master", "sends": [], "clips": [],
         "plugins": [{**comp, "id": "fx-bus", "params": {**comp["params"], "ratio": 2}}]},
        {**base, "id": "send-verb-short", "name": "Reverb courte", "type": "SEND", "color": "#10b981", "volume": 0.7, "outputTrackId": "master", "sends": [], "clips": [],
         "plugins": [{"id": "fx-rv", "name": "Reverb", "type": "REVERB", "isEnabled": True, "latency": 0, "params": {"decay": 1.2, "preDelay": 0.02, "mix": 1, "size": 0.4, "mode": "PLATE", "isEnabled": True}}]},
        {**base, "id": "send-delay", "name": "Écho 1/4", "type": "SEND", "color": "#00f2ff", "volume": 0.8, "outputTrackId": "master", "sends": [], "clips": [],
         "plugins": [{"id": "fx-dl", "name": "Delay", "type": "DELAY", "isEnabled": True, "latency": 0, "params": {"division": "1/4", "feedback": 0.3, "mix": 1, "isEnabled": True}}]},
        {**base, "id": "master", "name": "MASTER BUS", "type": "BUS", "color": "#00f2ff", "volume": 1.0, "outputTrackId": "", "sends": [], "clips": [], "plugins": []},
    ]
    state = {
        "id": "proj-r4-r6", "name": "R4 R6", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": "voix", "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(PROJECT, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/voix.wav", voice_wav())


STATE = "() => { const s = window.__novaEdit.getState(); return s.tracks.map(t => ({ id: t.id, name: t.name, inactive: !!t.isInactive, hidden: !!t.isHidden, muted: !!t.isMuted, commit: t.commit ? t.commit.kind : null, plugins: t.plugins.map(p => p.type + (p.isInactive ? '(x)' : p.isEnabled ? '' : '(b)')), sends: t.sends.map(s => s.id + ':' + s.level), clips: t.clips.map(c => ({ id: c.id, name: c.name, muted: !!c.isMuted, as: !!c.audioSuite, buf: c.bufferId })), presetName: (t.plugins[0] || {}).params ? t.plugins[0].params.presetName || null : null })); }"


def open_window(pg, detail):
    pg.evaluate("d => window.dispatchEvent(new CustomEvent('nova:open-window', { detail: d }))", detail)
    pg.wait_for_timeout(700)


def menu_on_track(pg, name, vp):
    """Clic droit (souris) ou appui long (doigt) sur le nom de la piste : menu de la piste."""
    loc = pg.get_by_text(name, exact=True).locator("visible=true").first
    box = loc.bounding_box()
    if not box:
        return False
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    if vp == "pc":
        pg.mouse.click(x, y, button="right")
    else:
        loc.click(button="right")
    pg.wait_for_timeout(600)
    return True


def click_menu(pg, label):
    it = pg.get_by_role("menuitem", name=re.compile(label)).locator("visible=true")
    if not it.count():
        it = pg.get_by_text(re.compile(label)).locator("visible=true")
    if not it.count():
        return False
    it.first.click(); pg.wait_for_timeout(800)
    return True


def undo(pg):
    pg.keyboard.press("Escape"); pg.mouse.click(5, 300); pg.keyboard.press("Control+z"); pg.wait_for_timeout(700)


def run(vp, theme="dark"):
    tag = f"{vp}_{theme}"
    res = {"vp": vp, "theme": theme, "etapes": {}}
    log = Log(f"r4r6_{tag}")
    def step(name, fn):
        try:
            res["etapes"][name] = fn()
        except Exception as e:  # noqa
            res["etapes"][name] = {"erreur": str(e)[:300]}
            try: shot(pg, f"ui_{tag}_ERREUR_{name}")
            except Exception: pass
    with sync_playwright() as p:
        b = launch(p)
        ctx, pg = new_page(b, vp, log)
        prepare(pg)
        pg.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); localStorage.setItem('nova_simple_mode', '0'); }} catch (e) {{}}")
        open_project_file(pg, PROJECT, res, f"ui_{tag}_01_projet")
        pg.keyboard.press("Escape"); pg.wait_for_timeout(500)

        # ---------------- R4 : presets dans la fenêtre de l'effet
        def r4_presets():
            out = {}
            if vp == "tel":
                m = pg.get_by_text("Mixer", exact=True)
                if m.count(): m.last.click(); pg.wait_for_timeout(900)
                pg.get_by_text("Compresseur", exact=True).locator("visible=true").first.click()
            elif vp == "tab":
                # Tablette : l'effet s'ouvre au doigt depuis l'en-tête de la piste.
                pg.get_by_text("Compresseur", exact=True).locator("visible=true").first.click()
            else:
                for label in ("Console", "Mixage", "Mixer"):
                    t = pg.get_by_role("button", name=re.compile(f"^{label}$", re.I))
                    if t.count() and t.first.is_visible():
                        t.first.click(); pg.wait_for_timeout(1000); break
                pg.locator("button[aria-label^='Ouvrir Compresseur (Voix lead)']").first.click()
            pg.wait_for_timeout(1800)
            btn = pg.locator("[data-testid=preset-button]").locator("visible=true").first
            btn.click(); pg.wait_for_timeout(500)
            shot(pg, f"ui_{tag}_10_presets_vide")
            pg.locator("[data-testid=preset-save-as]").first.click()
            pg.locator("[data-testid=preset-name]").first.fill("Voix rap · 2:1")
            pg.keyboard.press("Enter"); pg.wait_for_timeout(900)
            out["liste"] = pg.locator("[data-testid=preset-list] li").all_inner_texts()
            # Favori
            star = pg.get_by_role("button", name=re.compile("Mettre « Voix rap · 2:1 » en favori"))
            if star.count(): star.first.click(); pg.wait_for_timeout(300)
            shot(pg, f"ui_{tag}_11_preset_enregistre")
            pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
            if vp != "tel":
                # Un réglage tourné à la molette → « modifié » → Comparer.
                knob = pg.locator(".nova-hosted-plugin [title*='molette']").locator("visible=true").first
                kb = knob.bounding_box()
                if kb:
                    pg.mouse.move(kb["x"] + kb["width"] / 2, kb["y"] + kb["height"] / 2)
                    for _ in range(12): pg.mouse.wheel(0, -100); pg.wait_for_timeout(30)
                pg.wait_for_timeout(500)
                cmp_btn = pg.locator("[data-testid=preset-compare]").first
                out["comparer_actif_apres_reglage"] = cmp_btn.is_enabled()
                cmp_btn.click(); pg.wait_for_timeout(600)
                out["comparer_presse"] = cmp_btn.get_attribute("aria-pressed")
                shot(pg, f"ui_{tag}_12_comparer_A")
                cmp_btn.click(); pg.wait_for_timeout(600)
                out["comparer_relache"] = cmp_btn.get_attribute("aria-pressed")
            out["preset_sur_l_effet"] = pg.evaluate(STATE)[0]["presetName"]
            out["debordements"] = overflow_report(pg)[:5]
            pg.keyboard.press("Escape"); pg.wait_for_timeout(500)
            if vp == "tel":
                f = pg.get_by_role("button", name="Fermer", exact=True).locator("visible=true")
                if f.count(): f.first.click(); pg.wait_for_timeout(500)
            return out
        step("R4_presets_effet", r4_presets)

        # ---------------- R4 : Track Preset
        def r4_track_preset():
            out = {}
            if vp == "tel":
                open_window(pg, {"name": "track-preset", "trackId": "voix"})
            else:
                for label in ("Édition", "Arrangement", "Pistes"):
                    t = pg.get_by_role("button", name=re.compile(f"^{label}$", re.I))
                    if t.count() and t.first.is_visible():
                        t.first.click(); pg.wait_for_timeout(800); break
                if not (menu_on_track(pg, "Voix lead", vp) and click_menu(pg, "Track Preset")):
                    out["via"] = "événement (menu introuvable)"
                    open_window(pg, {"name": "track-preset", "trackId": "voix"})
            dlg = pg.locator("[data-testid=track-preset-dialog]")
            dlg.wait_for(timeout=5000)
            pg.wait_for_timeout(500)
            out["presets"] = pg.locator("[data-testid=track-preset-list] li p.text-\\[13px\\]").all_inner_texts()
            shot(pg, f"ui_{tag}_20_track_presets")
            lead = pg.locator("[data-testid=track-preset-list] li", has_text="Voix lead Make Music").first
            lead.locator("[data-testid=track-preset-apply]").click(); pg.wait_for_timeout(900)
            st = pg.evaluate(STATE)
            out["chaine_apres"] = next(t for t in st if t["id"] == "voix")["plugins"]
            out["envois_apres"] = next(t for t in st if t["id"] == "voix")["sends"]
            shot(pg, f"ui_{tag}_21_track_preset_rappele")
            pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
            undo(pg)
            out["apres_ctrl_z"] = next(t for t in pg.evaluate(STATE) if t["id"] == "voix")["plugins"]
            return out
        step("R4_track_preset", r4_track_preset)

        # ---------------- R6 : Commit puis restauration
        def r6_commit():
            out = {}
            if vp == "pc" and menu_on_track(pg, "Voix lead", vp) and click_menu(pg, "Commit"):
                out["via"] = "menu de la piste"
            else:
                open_window(pg, {"name": "bounce", "trackId": "voix", "bounce": {"mode": "commit"}})
                out["via"] = "fenêtre"
            pg.locator("[data-testid=bounce-dialog-commit]").wait_for(timeout=5000)
            shot(pg, f"ui_{tag}_30_commit_fenetre")
            pg.locator("[data-testid=commit-run]").click()
            pg.locator("[data-testid=bounce-dialog-commit]").wait_for(state="detached", timeout=60000)
            pg.wait_for_timeout(800)
            st = pg.evaluate(STATE)
            out["apres"] = [{k: t[k] for k in ("id", "name", "inactive", "hidden", "commit")} for t in st if t["id"] != "master"]
            shot(pg, f"ui_{tag}_31_commit_fait")
            cm = next((t for t in st if t["commit"] == "commit"), None)
            if cm:
                if vp == "pc" and menu_on_track(pg, cm["name"], vp) and click_menu(pg, "Restaurer la piste"):
                    out["restauration_via"] = "menu de la piste"
                else:
                    pg.evaluate("""async (id) => { const m = await import('/utils/structureBus.ts'); const c = await import('/utils/commit.ts');
                      m.applyTracks(ts => c.restoreCommitted(ts, id).tracks, 'Piste d’origine restaurée'); }""", cm["id"])
                    out["restauration_via"] = "commande"
                pg.wait_for_timeout(800)
                st2 = pg.evaluate(STATE)
                out["apres_restauration"] = [{k: t[k] for k in ("id", "inactive", "hidden", "commit")} for t in st2 if t["id"] != "master"]
            return out
        step("R6_commit", r6_commit)

        # ---------------- R6 : Consolider avec effets (barre de plage)
        def r6_bounce():
            out = {}
            pg.evaluate("() => window.__novaEdit.selectRange(0.5, 3.5, ['voix'])")
            pg.wait_for_timeout(600)
            bar = pg.locator("[data-nova-target=range-actions]")
            out["barre_visible"] = bar.count() > 0 and bar.first.is_visible()
            if out["barre_visible"]:
                shot(pg, f"ui_{tag}_40_barre_plage")
                bar.first.get_by_role("button", name="Consolider").click()
            else:
                open_window(pg, {"name": "bounce", "bounce": {"mode": "range"}, "range": {"start": 0.5, "end": 3.5, "trackIds": ["voix"]}})
            pg.locator("[data-testid=bounce-dialog-range]").wait_for(timeout=5000)
            shot(pg, f"ui_{tag}_41_consolider_fenetre")
            pg.locator("[data-testid=bounce-wet]").click()
            pg.locator("[data-testid=bounce-dialog-range]").wait_for(state="detached", timeout=60000)
            pg.wait_for_timeout(800)
            st = pg.evaluate(STATE)
            out["pistes"] = [{k: t[k] for k in ("id", "name", "commit")} for t in st if t["id"] != "master"]
            out["clips_voix"] = [c for c in next(t for t in st if t["id"] == "voix")["clips"]]
            shot(pg, f"ui_{tag}_42_bounce_fait")
            undo(pg)
            out["apres_ctrl_z"] = [t["id"] for t in pg.evaluate(STATE)]
            pg.evaluate("() => window.__novaEdit.clearSelection()")
            return out
        step("R6_consolider_avec_effets", r6_bounce)

        # ---------------- R6 : AudioSuite puis retour à l'original
        def r6_audiosuite():
            out = {}
            before = next(t for t in pg.evaluate(STATE) if t["id"] == "voix")["clips"][0]
            open_window(pg, {"name": "audiosuite", "targets": [{"trackId": "voix", "clipId": before["id"]}]})
            pg.locator("[data-testid=audiosuite-dialog]").wait_for(timeout=5000)
            pg.get_by_role("tab", name="Effet NOVA").click(); pg.wait_for_timeout(200)
            pg.locator("[data-testid=audiosuite-nova]").select_option("DEESSER")
            shot(pg, f"ui_{tag}_50_audiosuite_fenetre")
            pg.locator("[data-testid=audiosuite-run]").click()
            pg.locator("[data-testid=audiosuite-dialog]").wait_for(state="detached", timeout=60000)
            pg.wait_for_timeout(600)
            after = next(c for c in next(t for t in pg.evaluate(STATE) if t["id"] == "voix")["clips"] if c["id"] == before["id"])
            out["traite"] = after
            open_window(pg, {"name": "audiosuite", "revert": True, "targets": [{"trackId": "voix", "clipId": before["id"]}]})
            back = next(c for c in next(t for t in pg.evaluate(STATE) if t["id"] == "voix")["clips"] if c["id"] == before["id"])
            out["retour"] = back
            out["retour_identique"] = back == before
            return out
        step("R6_audiosuite", r6_audiosuite)

        # ---------------- R6 : impression du BUS VOX
        def r6_print():
            out = {}
            if vp == "pc" and menu_on_track(pg, "BUS VOX", vp) and click_menu(pg, "Imprimer le bus"):
                out["via"] = "menu de la piste"
            else:
                open_window(pg, {"name": "print-bus", "trackId": "bus-vox"})
                out["via"] = "fenêtre"
            pg.locator("[data-testid=bounce-dialog-bus]").wait_for(timeout=5000)
            shot(pg, f"ui_{tag}_60_imprimer_bus")
            pg.locator("[data-testid=print-run]").click()
            pg.locator("[data-testid=bounce-dialog-bus]").wait_for(state="detached", timeout=60000)
            pg.wait_for_timeout(800)
            st = pg.evaluate(STATE)
            out["pistes"] = [{k: t[k] for k in ("id", "name", "muted", "commit")} for t in st if t["id"] != "master"]
            shot(pg, f"ui_{tag}_61_bus_imprime")
            return out
        step("R6_imprimer_bus", r6_print)

        res["erreurs_console"] = [e["text"] for e in log.errors() if "supabase" not in e["text"].lower() and "401" not in e["text"] and "key" not in e["text"].lower()][:8]
        b.close()
    return res


if __name__ == "__main__":
    make_project()
    vps = [a for a in sys.argv[1:] if a in ("pc", "tab", "tel")] or ["pc", "tab", "tel"]
    all_res = []
    for vp in vps:
        for theme in (("dark", "light") if vp == "pc" else ("dark",)):
            r = run(vp, theme)
            all_res.append(r)
            print(json.dumps(r, ensure_ascii=False, indent=1)[:4000])
    (OUT / "r4_r6_ui.json").write_text(json.dumps(all_res, ensure_ascii=False, indent=1), encoding="utf-8")
