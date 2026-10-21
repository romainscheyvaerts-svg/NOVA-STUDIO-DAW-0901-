"""L5 · écart 7 « Réparer la voix » et éditeur spectral, de bout en bout, navigateurs headless
(aucune fenêtre), Supabase simulé (qa_hors_prod via qalib) : jamais la production, aucun pont,
aucune carte son ni micro réels.

Usage (serveur NOVA lancé : npx vite --host 127.0.0.1 --port 3523 --strictPort) :
  NOVA_URL=http://127.0.0.1:3523/ python qa/voix_reparation.py [A B C D]

  A. bureau 1600 × 900, thème sombre :
     menu du clip (Voix) → « Réparer la voix… » : l'onglet « Réparer la voix » du traitement
     de clip ; « Réparer » (calcul dans un Worker) ; bilan annoncé ; projet enregistré : étape
     « Voix réparée », original gardé ; bourdonnement 50 Hz mesuré sur le son rendu par NOVA,
     clics et plosives comptés ; Ctrl+Z (prise d'origine au bit près) / Ctrl+Y ; « Revenir à
     l'original » (au bit près) ; éditeur spectral : zone tracée à la souris sur un sifflement
     parasite, « Atténuer −20 dB », « Garder » : sifflement baissé (mesuré), reste du son
     identique au bit près ; palette Ctrl+K « réparer » ; en mode simple, l'entrée du menu est cachée.
  B. bureau 1366 × 768, thème clair : les deux fenêtres (réglages, spectre, zone).
  C. téléphone 390 × 844, thème sombre : fenêtres en bas d'écran, zone tracée au doigt, aucun
     débordement, boutons ≥ 40 px.
  D. téléphone, thème clair : les deux fenêtres.

Matériel : 12 s d'une vraie prise rap sèche du studio (REC_224, si elle est sur ce PC, sinon une
voix synthétique) à −20 dBFS efficaces, + bourdonnement 50 Hz et 7 harmoniques (−40 dBFS
chacune), 20 clics de bouche, 2 plosives, et un sifflement parasite (3,2 kHz, 0,6 s).
Sortie : D:\\1 WORK\\CONTENU\\nova-pro-2026\\voixrep\\scenario (QA_OUT) ; code 0 si tout passe.
"""
import io, json, os, re, sys, time, wave, zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-pro-2026\voixrep\scenario")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3523/")
from qalib import *  # noqa
from qalib import OUT, run_one, shot, overflow_report  # noqa
from gel_pre_effet import open_project_file, save_zip  # noqa
from stems_separation import prepare, dismiss_popups  # noqa
from voix_ia_locale import clip_menu, menu_item, header_y  # noqa
from voix_propre import read_wav_bytes, clip_audio, lsb_gap, theme  # noqa

SR = 48000
T_CLIP = 1.0
SESSION = Path(r"D:\1 WORK\2 SESSIONS PROTOOLS\OneDrive\13 mini 22 04 vs 2\Audio Files")
HUM_F = 50.0
CLICKS = [0.8 + i * 0.52 for i in range(20)]
PLOSIVES = [2.3, 7.1]
WHISTLE = (5.0, 5.6, 3200.0)


# ─── Matériel ──────────────────────────────────────────────────────────────────

def voice_source(n):
    f = SESSION / "REC_224.wav"
    if f.is_file():
        import mesure_voix_propre as mv
        x = mv.load48(f)[:n]
        return (x * 10 ** ((-20 - mv.active_rms_db(x)) / 20)).astype(np.float64), "REC_224 (vraie prise)"
    t = np.arange(n) / SR
    f0 = 170 * (1 + 0.05 * np.sin(2 * np.pi * 0.6 * t))
    ph = 2 * np.pi * np.cumsum(f0) / SR
    x = sum(np.sin(h * ph) / h for h in range(1, 25))
    x *= (0.5 + 0.5 * np.sin(2 * np.pi * 0.4 * t) ** 2)
    return 0.1 * x / np.sqrt(np.mean(x ** 2)), "voix synthétique"


def make_project(path: Path):
    n = 12 * SR
    voice, src = voice_source(n)
    rng = np.random.default_rng(5)
    t = np.arange(n) / SR
    hum = sum(0.01 * np.sin(2 * np.pi * h * HUM_F * t + h) for h in range(1, 9))
    clicks = np.zeros(n)
    for c in CLICKS:
        i0 = int(c * SR); L = int(rng.uniform(0.0004, 0.0015) * SR)
        w = rng.uniform(-1, 1, L + 1)
        clicks[i0:i0 + L] += rng.uniform(0.04, 0.09) * np.exp(-np.arange(L) / (L / 3)) * np.diff(w)
    pl = np.zeros(n)
    for p in PLOSIVES:
        i0 = int(p * SR); tt = np.arange(int(0.25 * SR)) / SR  # le souffle s'éteint tout seul (pas de coupure = pas de clic)
        pl[i0:i0 + len(tt)] += 0.6 * (1 - np.exp(-tt / 0.002)) * np.exp(-tt / 0.025) * np.sin(2 * np.pi * 45 * tt)
    wh = np.zeros(n)
    a, b, f = WHISTLE
    i0, i1 = int(a * SR), int(b * SR)
    env = np.sin(np.pi * np.arange(i1 - i0) / (i1 - i0)) ** 0.3
    wh[i0:i1] = 0.08 * env * np.sin(2 * np.pi * f * np.arange(i1 - i0) / SR)
    x = voice + hum + clicks + pl + wh
    q = np.clip(np.round(x * 32767), -32768, 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(q.tobytes())
    base = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0,
            "sends": [], "plugins": [], "volume": 1.0, "outputTrackId": "master"}
    voix = {**base, "id": "voix", "name": "Voix", "type": "AUDIO", "color": "#f472b6",
            "clips": [{"id": "prise", "name": "Prise à réparer", "type": "AUDIO", "audioRef": "audio/prise.wav", "color": "#f472b6",
                       "fadeIn": 0, "fadeOut": 0, "gain": 1.0, "start": T_CLIP, "offset": 0.0, "duration": round(len(q) / SR, 3)}]}
    state = {
        "id": "proj-voix-reparation", "name": "Test réparer la voix (L5)", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": [voix], "trackGroups": [], "markers": [], "selectedTrackId": "voix", "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True, "lyrics": "",
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/prise.wav", buf.getvalue())
    return src


# ─── Mesures ──────────────────────────────────────────────────────────────────

def line_db(y, sr, f, a=0.5, b=None):
    """Niveau (dB) d'une raie à f Hz : projection sur un nombre entier de périodes (fenêtre de Hann)."""
    b = b if b is not None else len(y) / sr - 0.5
    i0, i1 = int(a * sr), int(b * sr)
    seg = y[i0:i1].astype(np.float64)
    w = np.hanning(len(seg))
    ph = 2 * np.pi * f * (np.arange(i0, i1) / sr)
    c = np.sum(seg * w * np.cos(ph)); s = np.sum(seg * w * np.sin(ph))
    return 20 * np.log10(2 * np.hypot(c, s) / np.sum(w) + 1e-12)


def hum_report(before, after, sr):
    """Baisse de chaque raie, mesurée entre les deux plosives (leur souffle grave couvre aussi 50 Hz)."""
    out = {}
    for h in range(1, 9):
        out[int(h * HUM_F)] = round(line_db(before, sr, h * HUM_F, 2.6, 6.9) - line_db(after, sr, h * HUM_F, 2.6, 6.9), 1)
    return out


def clicks_removed(before, after, sr):
    """Par clic ajouté : baisse (dB) de l'énergie au-dessus de 3 kHz sur ses 2 premières ms."""
    def hp(y):
        Y = np.fft.rfft(y.astype(np.float64)); fr = np.fft.rfftfreq(len(y), 1 / sr)
        Y[fr < 3000] = 0
        return np.fft.irfft(Y, len(y))
    hb, ha = hp(before), hp(after)
    out = []
    for c in CLICKS:
        i0, i1 = int(c * sr), int((c + 0.002) * sr)
        out.append(round(10 * np.log10((np.sum(hb[i0:i1] ** 2) + 1e-20) / (np.sum(ha[i0:i1] ** 2) + 1e-20)), 1))
    return out


def band_db(y, sr, a, b, f0, f1):
    i0, i1 = int(a * sr), int(b * sr)
    seg = y[i0:i1].astype(np.float64) * np.hanning(i1 - i0)
    X = np.abs(np.fft.rfft(seg)) ** 2
    fr = np.fft.rfftfreq(len(seg), 1 / sr)
    return 10 * np.log10(np.sum(X[(fr >= f0) & (fr <= f1)]) + 1e-20)


def notice_text(page):
    return page.evaluate("""() => [...document.querySelectorAll('[role=status], [role=alert], [aria-live]')].map(e => (e.innerText || '').trim()).filter(Boolean).join(' | ')""")


# ─── Gestes ───────────────────────────────────────────────────────────────────

def open_repair_from_menu(page, pfx):
    clip_menu(page, "Voix", x=700)
    it = menu_item(page, "Réparer la voix")
    shot(page, f"{pfx}01_menu_clip")
    it.click()
    page.get_by_test_id("audiosuite-dialog").wait_for(timeout=10000)
    page.get_by_test_id("repair-panel").wait_for(timeout=10000)
    page.wait_for_timeout(300)


def open_spectral_from_menu(page):
    clip_menu(page, "Voix", x=700)
    menu_item(page, "Éditeur spectral").click()
    wait_spectrum(page)


def wait_spectrum(page):
    page.get_by_test_id("spectral-editor").wait_for(timeout=10000)
    page.wait_for_function("""() => { const c = document.querySelector('[data-testid=spectral-canvas] canvas');
      return c && c.width > 50 && !/Calcul du spectre/.test(document.querySelector('[data-testid=spectral-editor]').innerText); }""", timeout=60000)
    page.wait_for_timeout(300)


def drag_zone(page, x0, y0, x1, y1, touch=False):
    """Trace une zone : fractions (0-1) du spectre (temps, hauteur depuis le haut)."""
    bb = page.get_by_test_id("spectral-canvas").bounding_box()
    X = lambda f: bb["x"] + f * bb["width"]
    Y = lambda f: bb["y"] + f * bb["height"]
    if touch:
        # Vrai glissé au doigt (événements tactiles du navigateur, comme un écran de téléphone).
        cdp = page.context.new_cdp_session(page)
        pts = [(X(x0) + (X(x1) - X(x0)) * i / 10, Y(y0) + (Y(y1) - Y(y0)) * i / 10) for i in range(11)]
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": pts[0][0], "y": pts[0][1]}]})
        for x, y in pts[1:]:
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y}]})
            page.wait_for_timeout(16)
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        cdp.detach()
    else:
        page.mouse.move(X(x0), Y(y0)); page.mouse.down()
        page.mouse.move(X(x1), Y(y1), steps=10); page.mouse.up()
    page.wait_for_timeout(300)


def fy(f, fmin=30.0, fmax=None, sr=48000):
    fmax = fmax or sr / 2
    return 1 - np.log(f / fmin) / np.log(fmax / fmin)


SET_SIMPLE = """async (on) => { const { simpleModeStore } = await window.__novaAppModule('/utils/simpleMode.ts'); simpleModeStore.setPref(on); return simpleModeStore.get().simple; }"""


# ─── A. bureau sombre ─────────────────────────────────────────────────────────

def scenario_desktop(page, log, res, vp):
    prepare(page, port=None, desktop=False)
    open_project_file(page, PROJECT, res, "A00_projet")
    dismiss_popups(page, 3000)
    page.evaluate(SET_SIMPLE, False); page.wait_for_timeout(500)
    d0, _ = save_zip(page, OUT / "A_avant.zip")
    ref, sr = clip_audio(OUT / "A_avant.zip", d0["tracks"][0]["clips"][0])
    res["frequence_projet"] = sr
    open_repair_from_menu(page, "A")
    res["onglet_actif"] = page.locator("[data-testid=audiosuite-dialog] [role=tab][aria-selected=true]").inner_text().strip()
    res["sensibilite"] = page.locator("[role=radiogroup][aria-label='Sensibilité'] [aria-checked=true]").inner_text().strip()
    shot(page, "A02_fenetre_reparer")
    t0 = time.time()
    page.get_by_test_id("audiosuite-run").click()
    try:
        page.wait_for_function("() => /Réparation/.test(document.querySelector('[data-testid=audiosuite-dialog]')?.innerText || '')", timeout=5000)
        shot(page, "A03_calcul")
    except Exception:
        pass
    page.get_by_test_id("audiosuite-dialog").wait_for(state="detached", timeout=180000)
    res["temps_interface_s"] = round(time.time() - t0, 2)
    page.wait_for_timeout(300)
    res["annonce"] = notice_text(page)
    shot(page, "A04_repare")
    data, _ = save_zip(page, OUT / "A_apres_reparation.zip")
    c = data["tracks"][0]["clips"][0]
    a = c.get("audioSuite") or {}
    res["clip_apres"] = {"nom": c["name"], "etapes": [s.get("name") for s in a.get("steps", [])], "types": [s.get("type") for s in a.get("steps", [])],
                         "original_garde": bool(a.get("sourceRef"))}
    y, _ = clip_audio(OUT / "A_apres_reparation.zip", c)
    n = min(len(y), len(ref))
    res["bourdonnement_baisse_db"] = hum_report(ref[:n], y[:n], sr)
    m = re.search(r"(\d+) clics? de bouche", res["annonce"] or "")
    res["clics_annonces"] = int(m.group(1)) if m else 0
    res["clics_baisse_db"] = clicks_removed(ref[:n], y[:n], sr)
    m = re.search(r"(\d+) plosives? adoucie", res["annonce"] or "")
    res["plosives_annoncees"] = int(m.group(1)) if m else 0
    # Hors des défauts, la voix (300 Hz-5 kHz) garde son niveau.
    res["voix_300_5k_db"] = round(band_db(y, sr, 8.0, 11.5, 300, 5000) - band_db(ref, sr, 8.0, 11.5, 300, 5000), 2)
    # Ctrl+Z / Ctrl+Y
    page.mouse.click(800, 860)
    page.keyboard.press("Control+z"); page.wait_for_timeout(1200)
    d_undo, _ = save_zip(page, OUT / "A_apres_annulation.zip")
    cu = d_undo["tracks"][0]["clips"][0]
    yu, _ = clip_audio(OUT / "A_apres_annulation.zip", cu)
    page.keyboard.press("Control+y"); page.wait_for_timeout(1200)
    d_redo, _ = save_zip(page, OUT / "A_apres_retablir.zip")
    res["annulation"] = {"ctrl_z_audiosuite": "audioSuite" in cu, "ctrl_y_audiosuite": "audioSuite" in d_redo["tracks"][0]["clips"][0], "ctrl_z": lsb_gap(yu, ref)}
    # Revenir à l'original (menu du clip)
    clip_menu(page, "Voix", x=700)
    menu_item(page, "Revenir à l’original \\(avant traitement\\)").click()
    page.wait_for_timeout(1500)
    d_rev, _ = save_zip(page, OUT / "A_apres_retour.zip")
    cr = d_rev["tracks"][0]["clips"][0]
    yr, _ = clip_audio(OUT / "A_apres_retour.zip", cr)
    res["retour_original"] = {"nom": cr["name"], "audioSuite": "audioSuite" in cr, **lsb_gap(yr, ref)}

    # Éditeur spectral : le sifflement à 3,2 kHz (5,0 → 5,6 s du clip).
    open_spectral_from_menu(page)
    shot(page, "A05_spectre")
    dur = d_rev["tracks"][0]["clips"][0]["duration"]
    a, b, f = WHISTLE
    drag_zone(page, (a - 0.05) / dur, fy(f * 1.12, sr=sr), (b + 0.05) / dur, fy(f / 1.12, sr=sr))
    res["zone_affichee"] = page.get_by_test_id("spectral-zone").inner_text()
    page.locator("[data-testid=spectral-editor] select[aria-label='Atténuation']").select_option("20")
    shot(page, "A06_zone_tracee")
    page.get_by_test_id("spectral-attenuate").click()
    page.wait_for_function("() => { const b = document.querySelector('[data-testid=spectral-keep]'); return b && !b.disabled && /1 retouche/.test(b.textContent); }", timeout=60000)
    wait_spectrum(page)
    shot(page, "A07_zone_attenuee")
    # Annuler la retouche puis la refaire (dans la fenêtre).
    page.get_by_test_id("spectral-undo").click()
    page.wait_for_function("() => document.querySelector('[data-testid=spectral-keep]').disabled", timeout=30000)
    page.get_by_test_id("spectral-attenuate").click()
    page.wait_for_function("() => { const b = document.querySelector('[data-testid=spectral-keep]'); return b && !b.disabled; }", timeout=60000)
    page.get_by_test_id("spectral-keep").click()
    page.get_by_test_id("spectral-editor").wait_for(state="detached", timeout=10000)
    page.wait_for_timeout(800)
    res["annonce_spectre"] = notice_text(page)
    shot(page, "A08_spectre_garde")
    ds, _ = save_zip(page, OUT / "A_apres_spectre.zip")
    cs = ds["tracks"][0]["clips"][0]
    ys, _ = clip_audio(OUT / "A_apres_spectre.zip", cs)
    n = min(len(ys), len(ref))
    res["spectre"] = {
        "types": [s.get("type") for s in (cs.get("audioSuite") or {}).get("steps", [])],
        "sifflement_baisse_db": round(band_db(ref, sr, a + 0.1, b - 0.1, f - 60, f + 60) - band_db(ys, sr, a + 0.1, b - 0.1, f - 60, f + 60), 1),
        "voix_sous_2k_meme_moment_db": round(band_db(ys, sr, a + 0.1, b - 0.1, 200, 2000) - band_db(ref, sr, a + 0.1, b - 0.1, 200, 2000), 2),
        "identique_avant_4_9s": float(np.max(np.abs(ys[: int(4.9 * sr)] - ref[: int(4.9 * sr)]))) * 32768,
        "identique_apres_5_7s": float(np.max(np.abs(ys[int(5.7 * sr):n] - ref[int(5.7 * sr):n]))) * 32768,
    }
    # Palette Ctrl+K
    page.mouse.click(700, header_y(page, "Voix") + 20)
    page.keyboard.press("Control+k")
    page.get_by_test_id("command-palette").wait_for(timeout=5000)
    page.get_by_test_id("palette-input").type("réparer", delay=25)
    page.wait_for_timeout(500)
    opts = page.locator("[data-testid=command-palette] [role=option]")
    res["palette"] = [o.inner_text().replace("\n", " · ")[:120] for o in opts.all()[:4]]
    shot(page, "A09_palette")
    page.keyboard.press("Enter")
    page.get_by_test_id("repair-panel").wait_for(timeout=8000)
    res["palette_ouvre_reparer"] = True
    page.keyboard.press("Escape"); page.wait_for_timeout(400)
    # Mode simple : pas d'entrée dans le menu du clip.
    page.evaluate(SET_SIMPLE, True); page.wait_for_timeout(600)
    clip_menu(page, "Voix", x=700)
    page.wait_for_timeout(300)
    res["mode_simple_menu"] = page.evaluate("""() => [...document.querySelectorAll('[role=menu] button, [role=menu] [data-submenu]')].map(b => (b.innerText || '') + ' ' + (b.dataset.submenu || '')).join(' ')""")
    res["mode_simple_cache"] = "Réparer la voix" not in res["mode_simple_menu"] and "Éditeur spectral" not in res["mode_simple_menu"]
    page.keyboard.press("Escape")
    page.evaluate(SET_SIMPLE, False)


# ─── B. bureau clair ──────────────────────────────────────────────────────────

def open_by_event(page, name):
    page.evaluate("""(n) => window.dispatchEvent(new CustomEvent('nova:open-window', { detail: { name: n, targets: [{ trackId: 'voix', clipId: 'prise' }] } }))""", name)


def scenario_light(page, log, res, vp, pfx="B", touch=False):
    prepare(page, port=None, desktop=False)
    open_project_file(page, PROJECT, res, f"{pfx}00_projet")
    dismiss_popups(page, 3000)
    open_by_event(page, "voice-repair")
    page.get_by_test_id("repair-panel").wait_for(timeout=10000)
    page.wait_for_timeout(400)
    shot(page, f"{pfx}01_fenetre_reparer")
    res["debordement_reparer"] = [o for o in overflow_report(page) if o.get("kind") == "page-hscroll"]
    res["petits_reparer"] = small_targets(page, "audiosuite-dialog") if touch else []
    page.keyboard.press("Escape"); page.wait_for_timeout(400)
    open_by_event(page, "spectral-editor")
    wait_spectrum(page)
    shot(page, f"{pfx}02_spectre")
    drag_zone(page, 0.40, 0.25, 0.48, 0.45, touch=touch)
    res["zone"] = page.get_by_test_id("spectral-zone").inner_text()
    shot(page, f"{pfx}03_zone")
    page.get_by_test_id("spectral-fill").click()
    page.wait_for_function("() => { const b = document.querySelector('[data-testid=spectral-keep]'); return b && !b.disabled; }", timeout=60000)
    wait_spectrum(page)
    shot(page, f"{pfx}04_zone_remplie")
    res["garder"] = page.get_by_test_id("spectral-keep").inner_text().strip()
    res["debordement_spectre"] = [o for o in overflow_report(page) if o.get("kind") == "page-hscroll"]
    res["petits_spectre"] = small_targets(page, "spectral-editor") if touch else []
    res["theme"] = page.evaluate("document.documentElement.getAttribute('data-theme')")


def small_targets(page, testid):
    return page.evaluate("""(id) => [...document.querySelectorAll(`[data-testid=${id}] button, [data-testid=${id}] select`)]
      .filter(e => e.getClientRects().length).map(e => { const r = e.getBoundingClientRect(); return { t: (e.innerText || e.getAttribute('aria-label') || '').trim().slice(0, 30), h: Math.round(r.height), w: Math.round(r.width) }; })
      .filter(x => x.t && x.h < 40)""", testid)


def scenario_phone(page, log, res, vp):
    scenario_light(page, log, res, vp, pfx=PFX, touch=True)


PFX = "C"

if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    PROJECT = OUT / "projet_voix_reparation.zip"
    source = make_project(PROJECT)
    only = set(a.upper() for a in sys.argv[1:])
    report = {"url": os.environ["NOVA_URL"], "voix": source}

    def want(k):
        return not only or k in only
    if want("A"):
        theme("dark")
        report["A_bureau_sombre"] = run_one(scenario_desktop, "pc", "A_bureau_sombre")
    if want("B"):
        theme("light")
        report["B_bureau_clair"] = run_one(scenario_light, "pc1366", "B_bureau_clair")
    if want("C"):
        theme("dark"); PFX = "C"
        report["C_telephone_sombre"] = run_one(scenario_phone, "tel390", "C_telephone_sombre")
    if want("D"):
        theme("light"); PFX = "D"
        report["D_telephone_clair"] = run_one(scenario_phone, "tel390", "D_telephone_clair")

    checks = {}
    A, B, C, D = (report.get(k) or {} for k in ("A_bureau_sombre", "B_bureau_clair", "C_telephone_sombre", "D_telephone_clair"))
    if A:
        checks["A · menu du clip → onglet « Réparer la voix », sensibilité Moyen par défaut"] = A.get("ok") and A.get("onglet_actif") == "Réparer la voix" and A.get("sensibilite") == "Moyen"
        ca = A.get("clip_apres") or {}
        checks["A · traitement de clip : étape « Voix réparée (tout) », original gardé"] = ca.get("types") == ["VOICE_REPAIR"] and ca.get("etapes") == ["Voix réparée (tout)"] and ca.get("original_garde")
        hb = A.get("bourdonnement_baisse_db") or {}
        checks["A · bourdonnement 50 Hz et harmoniques baissés d'au moins 30 dB (son rendu par NOVA)"] = bool(hb) and min(hb.values()) >= 30
        cb = A.get("clics_baisse_db") or []
        checks["A · au moins 18 des 20 clics ajoutés retirés (aigus −6 dB ou plus à leur place), au plus 20 autres, plosives adoucies"] =             sum(1 for v in cb if v >= 6) >= 18 and A.get("clics_annonces", 0) <= 40 and A.get("plosives_annoncees", 0) >= 2
        checks["A · voix 300 Hz-5 kHz hors défauts : ±0,5 dB"] = abs(A.get("voix_300_5k_db", 99)) <= 0.5
        an = A.get("annulation") or {}
        checks["A · Ctrl+Z rend la prise d'origine au bit près, Ctrl+Y rétablit"] = an.get("ctrl_z_audiosuite") is False and an.get("ctrl_y_audiosuite") is True and (an.get("ctrl_z") or {}).get("ecart_max_lsb") == 0
        ro = A.get("retour_original") or {}
        checks["A · « Revenir à l'original » : prise d'origine au bit près"] = ro.get("audioSuite") is False and ro.get("ecart_max_lsb") == 0
        sp = A.get("spectre") or {}
        checks["A · éditeur spectral : sifflement −20 dB (±1,5), voix du même moment ±0,5 dB, reste identique au bit près"] = sp.get("types") == ["SPECTRAL_EDIT"] \
            and abs(sp.get("sifflement_baisse_db", 0) - 20) <= 1.5 and abs(sp.get("voix_sous_2k_meme_moment_db", 9)) <= 0.5 \
            and sp.get("identique_avant_4_9s") == 0 and sp.get("identique_apres_5_7s") == 0
        checks["A · palette Ctrl+K « réparer » ouvre l'onglet"] = bool(A.get("palette_ouvre_reparer")) and any("Réparer la voix" in x for x in A.get("palette") or [])
        checks["A · mode simple : entrées cachées du menu du clip"] = bool(A.get("mode_simple_cache"))
    if B:
        checks["B · bureau clair 1366 : fenêtres, zone remplie, sans débordement"] = B.get("ok") and B.get("theme") == "light" and "1 retouche" in (B.get("garder") or "") \
            and not B.get("debordement_reparer") and not B.get("debordement_spectre")
    for k, R in (("C", C), ("D", D)):
        if R:
            checks[f"{k} · téléphone : fenêtres sans débordement, zone au doigt, cibles ≥ 40 px"] = R.get("ok") and "1 retouche" in (R.get("garder") or "") \
                and not R.get("debordement_reparer") and not R.get("debordement_spectre") and not R.get("petits_reparer") and not R.get("petits_spectre")
    for k, R in (("A", A), ("B", B), ("C", C), ("D", D)):
        if R:
            checks[f"{k} · aucune erreur dans la console"] = not R.get("errors")
    report["verifications"] = checks
    report["ok"] = bool(checks) and all(checks.values())
    (OUT / f"qa_voix_reparation{'_' + ''.join(sorted(only)) if only else ''}.json").write_text(json.dumps(report, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    for k, v in checks.items():
        print(("OK   " if v else "ÉCHEC"), k)
    for k in ("A_bureau_sombre", "B_bureau_clair", "C_telephone_sombre", "D_telephone_clair"):
        if report.get(k) and (report[k].get("notes") or report[k].get("errors")):
            print(k, report[k].get("notes"), report[k].get("errors")[:5])
    print("OK" if report["ok"] else "ÉCHEC")
    sys.exit(0 if report["ok"] else 1)
