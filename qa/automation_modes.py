"""Scénario de bout en bout : modes d'automation Touch, Latch et Write (V6 Pro Tools).

Une piste « Voix » joue un son continu (440 Hz). Pendant la lecture, on bouge
VRAIMENT le fader de volume de l'en-tête de piste à la souris :
  1. Touch : fader baissé de 2 s à 4 s puis relâché → retour à 0 dB.
  2. Latch : fader baissé à 2 s puis relâché → la valeur tient jusqu'à l'arrêt (6 s).
     Ctrl+Z annule la passe (une seule étape), Ctrl+Y la rétablit.
  3. Write : passe complète de 0 à 5 s avec le fader à -6 dB environ dès 1 s ;
     la piste repasse en Touch ensuite.
Après chaque passe : la courbe enregistrée (points) ET le niveau mesuré à
l'export (RMS par fenêtre, ffmpeg).

Usage :
  NOVA_URL=http://localhost:3412/ QA_OUT="D:\\1 WORK\\CONTENU\\nova-protools\\automation" python qa/automation_modes.py
"""
import io, json, os, re, sys, time, wave, zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-protools\automation")
os.environ.setdefault("NOVA_URL", "http://localhost:3412/")
from qalib import *  # noqa
from gel_pre_effet import prepare, open_project_file, rms_db  # noqa

SR = 44100
DUR = 12.0


def tone_wav() -> bytes:
    t = np.arange(int(DUR * SR)) / SR
    x = 0.25 * np.sin(2 * np.pi * 440 * t)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((x * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def make_project(path: Path):
    clip = {"id": "ton", "name": "Son continu", "start": 0, "duration": DUR, "offset": 0, "fadeIn": 0, "fadeOut": 0,
            "color": "#22d3ee", "type": "AUDIO", "audioRef": "audio/ton.wav", "gain": 1}
    track = {"id": "voix", "name": "Voix", "type": "AUDIO", "color": "#22d3ee", "isMuted": False, "isSolo": False,
             "isTrackArmed": False, "isFrozen": False, "volume": 1.0, "pan": 0, "outputTrackId": "master", "sends": [],
             "clips": [clip], "plugins": [], "automationLanes": [], "totalLatency": 0}
    state = {
        "id": "proj-auto", "name": "Automation", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": [track], "trackGroups": [], "markers": [], "selectedTrackId": "voix", "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/ton.wav", tone_wav())


def state(page):
    return page.evaluate("() => { const s = window.DAW_CONTROL.getState(); const t = s.tracks.find(x => x.id === 'voix');"
                         " return { time: s.currentTime, playing: s.isPlaying, mode: t.automationMode || 'read', volume: t.volume,"
                         " lanes: t.automationLanes.map(l => ({ p: l.parameterName, n: l.points.length, pts: l.points.map(q => [Math.round(q.time*1000)/1000, Math.round(q.value*10000)/10000]) })) }; }")


def lane_value(points, t):
    pts = sorted(points)
    if not pts: return None
    if t <= pts[0][0]: return pts[0][1]
    for (t0, v0), (t1, v1) in zip(pts, pts[1:]):
        if t0 <= t <= t1:
            return v0 + (v1 - v0) * ((t - t0) / (t1 - t0) if t1 > t0 else 1)
    return pts[-1][1]


def set_mode(page, label):
    page.locator('[data-testid="automation-mode-voix"]').first.click()
    page.wait_for_timeout(300)
    page.get_by_role("menuitemradio", name=re.compile(f"^{label}")).first.click()
    page.wait_for_timeout(300)


def clear_automation(page):
    page.locator('[data-testid="automation-mode-voix"]').first.click(); page.wait_for_timeout(300)
    b = page.get_by_role("menuitem", name=re.compile("Effacer l'automation")).first
    if b.is_enabled(): b.click()
    else: page.keyboard.press("Escape")
    page.wait_for_timeout(300)


def fader_box(page):
    return page.locator('[data-nova-target="vol-voix"]').first.bounding_box()


def gain_to_x(box, gain):
    pos = (gain / 1.5) ** 0.5
    return box["x"] + box["width"] * pos


def blur(page):
    """Rend le clavier à l'application (sans cliquer sur un bouton)."""
    page.evaluate("() => document.activeElement && document.activeElement.blur && document.activeElement.blur()")


def play_from_zero(page):
    blur(page)
    page.keyboard.press("Home"); page.wait_for_timeout(300)
    page.keyboard.press("Space")


def wait_until(page, t, timeout=20):
    t_end = time.time() + timeout
    while time.time() < t_end:
        if page.evaluate("() => window.DAW_CONTROL.getState().currentTime") >= t: return
        page.wait_for_timeout(20)
    raise RuntimeError(f"la lecture n'a pas atteint {t} s")


def pause(page):
    page.keyboard.press("Space"); page.wait_for_timeout(800)


def export_wav(page, dest: Path, label):
    page.keyboard.press("Escape")
    b = page.get_by_role("button", name=re.compile(r"^\W*Exporter( le mix)?\s*$")).locator("visible=true").first
    if not b.is_visible():
        page.get_by_role("button", name=re.compile("Ouvrir le menu")).first.click(); page.wait_for_timeout(500)
        b = page.get_by_role("button", name=re.compile(r"^\W*Exporter( le mix)?\s*$")).locator("visible=true").first
    b.click(); page.wait_for_timeout(1200)
    with page.expect_download(timeout=240000) as dl:
        page.get_by_text("Mon morceau complet", exact=True).first.click()
    dl.value.save_as(str(dest))
    page.wait_for_timeout(800)
    for _ in range(3):
        close = page.get_by_role("button", name=re.compile("^(Fermer|Close)$")).locator("visible=true")
        try:
            if close.count() and page.get_by_text("Exporter ton morceau", exact=False).count(): close.last.click(); page.wait_for_timeout(300)
        except Exception:
            break
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    return dest


def levels(f: Path, windows):
    ref = rms_db(f, 0.2, 0.9)
    return {f"{a}-{b}s": (None if (v := rms_db(f, a, b)) is None else round(v - ref, 2)) for a, b in windows}, ref


def db(g): return 20 * np.log10(g)


def run():
    res = {"name": "automation_modes", "ok": True, "passes": {}, "verifs": []}
    src = OUT / "00_projet_automation.novaproj.zip"
    make_project(src)

    def check(label, cond, detail=""):
        res["verifs"].append({"verif": label, "ok": bool(cond), "detail": detail})
        if not cond: res["ok"] = False

    with sync_playwright() as p:
        b = launch(p)
        log = Log("automation_modes")
        ctx, page = new_page(b, "pc", log)
        prepare(page, None, desktop=False)
        try:
            open_project_file(page, src, res, "01_projet_ouvert")
            page.wait_for_timeout(1500)
            # Le mode simple (débutant) masque l'automation : on passe en mode avancé.
            adv = page.get_by_role("button", name=re.compile("mode avancé", re.I)).locator("visible=true").first
            if adv.count() and adv.is_visible(): adv.click(); page.wait_for_timeout(800)

            # ---------------- 1. TOUCH
            set_mode(page, "Touch")
            shot(page, "02_mode_touch")
            box = fader_box(page)
            low = 0.25  # ≈ -12 dB
            play_from_zero(page)
            wait_until(page, 2.0)
            page.mouse.move(gain_to_x(box, low), box["y"] + box["height"] / 2)
            page.mouse.down()
            t_down = state(page)["time"]
            page.mouse.move(gain_to_x(box, low) + 1, box["y"] + box["height"] / 2)
            shot(page, "03_touch_pendant_ecriture")
            wait_until(page, 4.0)
            page.mouse.up()
            t_up = state(page)["time"]
            wait_until(page, 6.0)
            pause(page)
            st = state(page)
            vol = next(l for l in st["lanes"] if l["p"] == "volume")
            res["passes"]["touch"] = {"appui_s": round(t_down, 2), "relachement_s": round(t_up, 2), "points": vol["n"], "courbe": vol["pts"]}
            check("Touch : points écrits et simplifiés", 2 <= vol["n"] <= 40, f"{vol['n']} points")
            check("Touch : courbe basse pendant l'appui", abs(lane_value(vol["pts"], (t_down + t_up) / 2) - low) < 0.03, str(lane_value(vol["pts"], (t_down + t_up) / 2)))
            check("Touch : retour à 0 dB après le relâchement", abs(lane_value(vol["pts"], t_up + 0.6) - 1.0) < 0.02, str(lane_value(vol["pts"], t_up + 0.6)))
            shot(page, "04_touch_courbe")
            wav = export_wav(page, OUT / "export_touch.wav", "touch")
            lv, ref = levels(wav, [(0.2, 1.8), (t_down + 0.3, t_up - 0.3), (t_up + 0.6, 5.8)])
            res["passes"]["touch"]["niveaux_rel_dB"] = lv
            vals = list(lv.values())
            check("Touch export : 0 dB avant", abs(vals[0]) < 0.5, str(vals[0]))
            check("Touch export : ≈ -12 dB pendant l'appui", abs(vals[1] - db(low)) < 1.0, str(vals[1]))
            check("Touch export : 0 dB après le relâchement", abs(vals[2]) < 0.5, str(vals[2]))

            # ---------------- 2. LATCH (+ annuler / rétablir)
            clear_automation(page)
            set_mode(page, "Latch")
            box = fader_box(page)
            mid = 0.5  # ≈ -6 dB
            play_from_zero(page)
            wait_until(page, 2.0)
            page.mouse.move(gain_to_x(box, mid), box["y"] + box["height"] / 2)
            page.mouse.down()
            t_down = state(page)["time"]
            page.wait_for_timeout(400)
            page.mouse.up()
            wait_until(page, 6.0)
            t_stop = state(page)["time"]
            pause(page)
            st = state(page)
            vol = next(l for l in st["lanes"] if l["p"] == "volume")
            res["passes"]["latch"] = {"appui_s": round(t_down, 2), "arret_s": round(t_stop, 2), "points": vol["n"], "courbe": vol["pts"]}
            check("Latch : la valeur tient jusqu'à l'arrêt", abs(lane_value(vol["pts"], t_stop - 0.2) - mid) < 0.03, str(lane_value(vol["pts"], t_stop - 0.2)))
            check("Latch : intact avant l'appui", abs(lane_value(vol["pts"], 1.0) - 1.0) < 0.02, str(lane_value(vol["pts"], 1.0)))
            shot(page, "05_latch_courbe")
            # Annuler : une seule étape pour toute la passe
            blur(page)
            page.keyboard.press("Control+z"); page.wait_for_timeout(500)
            undone = next(l for l in state(page)["lanes"] if l["p"] == "volume")
            check("Ctrl+Z annule la passe Latch en une fois", undone["n"] == 0, f"{undone['n']} points après Ctrl+Z")
            page.keyboard.press("Control+y"); page.wait_for_timeout(500)
            redone = next(l for l in state(page)["lanes"] if l["p"] == "volume")
            check("Ctrl+Y rétablit la passe", redone["n"] == vol["n"], f"{redone['n']} points")
            wav = export_wav(page, OUT / "export_latch.wav", "latch")
            lv, ref = levels(wav, [(0.2, 1.8), (t_down + 0.5, t_stop - 0.2), (t_stop + 0.6, 8.0)])
            res["passes"]["latch"]["niveaux_rel_dB"] = lv
            vals = list(lv.values())
            check("Latch export : ≈ -6 dB jusqu'à l'arrêt", abs(vals[1] - db(mid)) < 1.0, str(vals[1]))
            check("Latch export : 0 dB après l'arrêt", abs(vals[2]) < 0.5, str(vals[2]))

            # ---------------- 3. WRITE
            set_mode(page, "Write")
            shot(page, "06_mode_write")
            box = fader_box(page)
            w = 0.7
            play_from_zero(page)
            wait_until(page, 1.0)
            page.mouse.move(gain_to_x(box, w), box["y"] + box["height"] / 2)
            page.mouse.down(); page.wait_for_timeout(300); page.mouse.up()
            wait_until(page, 5.0)
            t_stop = state(page)["time"]
            pause(page)
            st = state(page)
            vol = next(l for l in st["lanes"] if l["p"] == "volume")
            res["passes"]["write"] = {"arret_s": round(t_stop, 2), "points": vol["n"], "courbe": vol["pts"], "mode_apres": st["mode"]}
            check("Write : tout le passage écrasé (plus de -6 dB du Latch)", abs(lane_value(vol["pts"], 4.0) - w) < 0.03, str(lane_value(vol["pts"], 4.0)))
            check("Write : la piste repasse en Touch", st["mode"] == "touch", st["mode"])
            shot(page, "07_write_courbe")
            wav = export_wav(page, OUT / "export_write.wav", "write")
            lv, ref = levels(wav, [(0.2, 0.9), (1.5, t_stop - 0.2), (6.6, 8.0)])
            res["passes"]["write"]["niveaux_rel_dB"] = lv
            vals = list(lv.values())
            check("Write export : ≈ -3,6 dB après le geste", abs(vals[1] - db(w)) < 1.0, str(vals[1]))
            check("Write export : après 6,25 s, la fin du Latch d'avant (0 dB)", abs(vals[2]) < 0.5, str(vals[2]))
        except Exception as e:  # noqa
            res["ok"] = False
            res["erreur"] = f"{type(e).__name__}: {str(e)[:500]}"
            try: shot(page, "99_echec")
            except Exception: pass
        finally:
            res["erreurs_page"] = [e["text"][:300] for e in log.errors()][:20]
            ctx.close(); b.close()
    (OUT / "automation_modes_resultats.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in res.items() if k != "passes"}, ensure_ascii=False, indent=1))
    return res


if __name__ == "__main__":
    run()
