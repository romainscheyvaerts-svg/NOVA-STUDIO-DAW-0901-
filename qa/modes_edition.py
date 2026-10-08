"""Preuves des modes d'édition Pro Tools (Shuffle, Slip, Spot, Grid absolu / relatif),
du point de synchro, de la touche d'inversion temporaire et de Tab to Transient.
Navigateur headless, à la souris et au clavier, aucune fenêtre.

Usage : serveur `npx vite --port 3429 --strictPort` dans le worktree, puis
  python qa/modes_edition.py [pc] [tab] [tel]
Captures et mesures : D:\\1 WORK\\CONTENU\\nova-modes-edition\\
"""
import io, json, math, os, sys, time, wave
from pathlib import Path

import numpy as np

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3429/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-modes-edition")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa
from qalib import OUT, Log, new_page, shot, save_log  # noqa
import protools_edition as pe  # noqa
from playwright.sync_api import sync_playwright

SR = 48000
ZOOM = 40


def burst_wav(times, seconds, sr=SR) -> bytes:
    """Silence avec des attaques nettes (pour Tab to Transient)."""
    x = np.zeros(int(seconds * sr))
    for at in times:
        i0 = int(at * sr)
        n = int(0.25 * sr)
        i = np.arange(n)
        x[i0:i0 + n] += 0.5 * np.exp(-i / (sr * 0.06)) * np.sin(2 * np.pi * 220 * i / sr + 0.3)
    x += 0.0005 * np.sin(2 * np.pi * 50 * np.arange(len(x)) / sr)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def project():
    f = OUT / "modes_projet.zip"
    pe.make_project(f, [
        pe.track("voix", "Voix", [
            # Une prise « un peu en avance » : commence 0,125 s après le temps 1 (hors grille).
            pe.clip("A", "Prise A", 0.125, 2, "audio/a.wav", originStart=0.125),
            pe.clip("B", "Phrase B", 6, 2, "audio/b.wav"),
            pe.clip("C", "Phrase C", 9, 2, "audio/c.wav"),
        ]),
        pe.track("back", "Back", [pe.clip("D", "Back D", 0, 8, "audio/d.wav")], color="#f97316"),
    ], {"audio/a.wav": burst_wav([0.5, 1.2], 6), "audio/b.wav": pe.sine_wav(330, 6), "audio/c.wav": pe.sine_wav(550, 6),
        "audio/d.wav": pe.sine_wav(220, 10)}, "Modes edition")
    return f


def ph(page):
    return round(page.evaluate("async () => (await import('/utils/playheadStore.ts')).playheadStore.get()"), 4)


def mode(page):
    return page.evaluate("() => { const m = window.__novaEditMode.get(); return m.mode + (m.mode === 'GRID' ? ':' + m.gridKind : '') + (m.shuffleLock ? ':LOCK' : ''); }")


def place(page, tid, patches):
    """Remet des clips à une position connue (une étape d'annulation, comme un geste)."""
    page.evaluate("([t, p]) => window.__novaEdit.patchClips(t, p)", [tid, patches]); page.wait_for_timeout(250)


def clip_of(page, tid, cid):
    return page.evaluate(f"() => {{ const c = window.__novaEdit.getState().tracks.find(t => t.id === '{tid}').clips.find(c => c.id === '{cid}'); return c ? {{ start: +c.start.toFixed(5), end: +(c.start + c.duration).toFixed(5), offset: +(c.offset||0).toFixed(5), sync: c.syncPoint ?? null, fadeIn: +(c.fadeIn||0).toFixed(4), fadeOut: +(c.fadeOut||0).toFixed(4) }} : null; }}")


def spans(page, tid):
    return [(c["id"], c["start"], c["end"]) for c in pe.clips_of(page, tid) if not c["muted"]]


def starts(sp):
    return [(i, round(a, 2)) for i, a, _ in sp]


def drag_clip(page, box, t0, dt, track=0, frac=0.85, hold=None, steps=8):
    """Glisse un clip (moitié basse = Grabber du Smart Tool) ; `hold` = touche maintenue PENDANT le geste."""
    y = pe.lane_y(box, track, frac)
    x0 = pe.x_of(box, t0)
    page.mouse.move(x0, y); page.mouse.down()
    page.mouse.move(x0 + 6, y, steps=2)
    if hold: page.keyboard.down(hold)
    page.mouse.move(x0 + dt * ZOOM, y, steps=steps)
    page.wait_for_timeout(80)
    tip = page.evaluate("() => { const t = document.querySelector('[data-testid=\"drag-tip\"]'); return t ? t.textContent : null; }")
    page.mouse.up()
    if hold: page.keyboard.up(hold)
    page.wait_for_timeout(300)
    return tip


def on_grid(t, step=0.5):
    return abs(t / step - round(t / step)) < 1e-5


RATE = {"sr": SR}


def sample_aligned(t):
    """Début à l'échantillon près (fréquence de la session ; positions arrondies à 5 décimales par la mesure)."""
    sr = RATE["sr"]
    return abs(t * sr - round(t * sr)) < 0.5


def scenario_pc(page, res):
    pe.open_project(page, project(), "pc_01_session")
    box = pe.canvas_box(page)
    res["canvas"] = box
    RATE["sr"] = page.evaluate("() => window.__novaEditMode.sampleRate()")
    res["frequence_session_debut"] = RATE["sr"]
    res["selecteur"] = page.evaluate("() => [...document.querySelectorAll('[data-edit-mode]')].map(b => ({ mode: b.dataset.editMode, actif: b.getAttribute('aria-checked'), texte: b.textContent.trim(), infobulle: (b.title || '').slice(0, 60) }))")
    res["mode_initial"] = mode(page)
    shot(page, "pc_02_selecteur_grid_relatif")
    page.locator('[data-testid="grid-value"]').click(); page.wait_for_timeout(250)
    shot(page, "pc_03_menu_grille")
    page.keyboard.press("Escape"); page.wait_for_timeout(150)

    # ---------------- Grid relatif (défaut) : +1,1 s → 2 pas de grille, garde 0,125 de décalage
    tip = drag_clip(page, box, 1.0, 1.1)
    a = clip_of(page, "voix", "A")
    res["grid_relatif"] = {"debut": a["start"], "bulle": tip, "attendu": 1.125}
    res["grid_relatif_ok"] = abs(a["start"] - 1.125) < 1e-6
    shot(page, "pc_04_grid_relatif")

    # ---------------- F4 (2e appui) : Grid absolu → le début tombe sur la grille
    place(page, "voix", {"A": {"start": 0.125}})
    page.mouse.click(5, 300)  # focus nulle part (Tab / F-keys pour la timeline)
    page.keyboard.press("F4"); page.wait_for_timeout(200)
    res["apres_F4"] = mode(page)
    tip = drag_clip(page, box, 1.0, 1.1)
    a = clip_of(page, "voix", "A")
    res["grid_absolu"] = {"debut": a["start"], "bulle": tip, "attendu": 1.0}
    res["grid_absolu_ok"] = abs(a["start"] - 1.0) < 1e-6 and res["apres_F4"] == "GRID:ABSOLUTE"
    shot(page, "pc_05_grid_absolu")

    # ---------------- Inversion temporaire en Grid : Ctrl maintenu pendant le geste → libre
    place(page, "voix", {"A": {"start": 0.125}})
    tip = drag_clip(page, box, 1.0, 1.1, hold="Control")
    a = clip_of(page, "voix", "A")
    res["grid_plus_ctrl"] = {"debut": a["start"], "bulle": tip, "attendu_environ": 1.225}
    res["grid_plus_ctrl_ok"] = abs(a["start"] - 1.225) < 0.03 and not on_grid(a["start"]) and sample_aligned(a["start"])

    # ---------------- F2 : Slip → libre à l'échantillon près
    place(page, "voix", {"A": {"start": 0.125}})
    page.keyboard.press("F2"); page.wait_for_timeout(200)
    res["apres_F2"] = mode(page)
    tip = drag_clip(page, box, 1.0, 1.1)
    a = clip_of(page, "voix", "A")
    res["slip"] = {"debut": a["start"], "bulle": tip, "echantillon": round(a["start"] * RATE["sr"], 2)}
    res["slip_ok"] = abs(a["start"] - 1.225) < 0.03 and sample_aligned(a["start"]) and res["apres_F2"] == "SLIP"
    shot(page, "pc_06_slip")
    # Slip + Maj : calé sur la grille le temps du geste
    place(page, "voix", {"A": {"start": 0.125}})
    tip = drag_clip(page, box, 1.0, 1.1, hold="Shift")
    a = clip_of(page, "voix", "A")
    res["slip_plus_maj"] = {"debut": a["start"], "bulle": tip}
    res["slip_plus_maj_ok"] = abs(a["start"] - 1.0) < 1e-6
    # Rognage en Slip : à l'échantillon ; en Grid : sur la grille
    place(page, "voix", {"A": {"start": 0.125, "duration": 2}})
    y = pe.lane_y(box, 0, 0.6)
    pe.drag(page, pe.x_of(box, 2.12), y, pe.x_of(box, 1.82), y)
    res["rognage_slip_fin"] = clip_of(page, "voix", "A")["end"]

    # ---------------- Point de synchro (Ctrl+,) puis Grid absolu : c'est lui qui se cale
    place(page, "voix", {"A": {"start": 0.125, "duration": 2}})
    page.mouse.click(pe.x_of(box, 1.0), pe.lane_y(box, 0, 0.85)); page.wait_for_timeout(200)  # sélectionne A
    page.mouse.click(pe.x_of(box, 0.425), box["y"] + 20); page.wait_for_timeout(200)          # tête de lecture (Slip : libre)
    res["tete_avant_synchro"] = ph(page)
    page.mouse.click(pe.x_of(box, 1.0), pe.lane_y(box, 0, 0.85)); page.wait_for_timeout(200)
    page.keyboard.press("Control+Comma"); page.wait_for_timeout(250)
    a = clip_of(page, "voix", "A")
    res["synchro_pose"] = a["sync"]
    shot(page, "pc_07_point_de_synchro")
    page.keyboard.press("F4"); page.wait_for_timeout(150)  # Slip → Grid (garde le genre absolu)
    res["mode_synchro"] = mode(page)
    drag_clip(page, box, 1.0, 1.1)
    a = clip_of(page, "voix", "A")
    sync_tl = a["start"] + (a["sync"] - a["offset"]) if a["sync"] is not None else None
    res["grid_avec_synchro"] = {"debut": a["start"], "point_de_synchro_sur_la_timeline": sync_tl}
    res["grid_avec_synchro_ok"] = sync_tl is not None and on_grid(sync_tl) and not on_grid(a["start"])

    # ---------------- Shuffle (F1) : supprimer, glisser, rogner, coller, plage
    page.keyboard.press("F1"); page.wait_for_timeout(200)
    res["apres_F1"] = mode(page)
    place(page, "voix", {"A": {"start": 0, "duration": 2, "offset": 0, "syncPoint": None}, "B": {"start": 2}, "C": {"start": 4}})
    res["shuffle_depart"] = spans(page, "voix")
    shot(page, "pc_08_shuffle_avant")
    page.mouse.click(pe.x_of(box, 3.0), pe.lane_y(box, 0, 0.85)); page.wait_for_timeout(150)
    page.keyboard.press("Delete"); page.wait_for_timeout(350)
    res["shuffle_suppr"] = spans(page, "voix")
    a, c = clip_of(page, "voix", "A"), clip_of(page, "voix", "C")
    res["shuffle_suppr_crossfade_anti_clic"] = {"A_fondu_sortie": a["fadeOut"], "C_fondu_entree": c["fadeIn"]}
    res["shuffle_suppr_ok"] = starts(res["shuffle_suppr"]) == [("A", 0.0), ("C", 2.0)] and a["fadeOut"] == 0.01 and c["fadeIn"] == 0.01
    shot(page, "pc_09_shuffle_supprime_recolle")
    page.keyboard.press("Control+z"); page.wait_for_timeout(450)
    res["shuffle_annule_en_1_fois"] = spans(page, "voix")
    res["shuffle_annule_ok"] = res["shuffle_annule_en_1_fois"] == res["shuffle_depart"]
    # Glisser A après C : les clips s'échangent et restent collés
    drag_clip(page, box, 1.0, 4.6)
    res["shuffle_glisse"] = spans(page, "voix")
    res["shuffle_glisse_ok"] = starts(res["shuffle_glisse"]) == [("B", 0.0), ("C", 2.0), ("A", 4.0)]
    shot(page, "pc_10_shuffle_glisse")
    # Rogner la fin de B de 0,5 s (bord, au-dessus du bas de la jonction) : C et A reculent d'autant
    y = pe.lane_y(box, 0, 0.45)
    pe.drag(page, pe.x_of(box, 1.97), y, pe.x_of(box, 1.47), y)
    res["shuffle_rogne"] = spans(page, "voix")
    st_ = starts(res["shuffle_rogne"])
    res["shuffle_rogne_ok"] = [x[0] for x in st_] == ["B", "C", "A"] and all(abs(x[1] - e) < 0.03 for x, e in zip(st_, (0.0, 1.5, 3.5)))
    shot(page, "pc_11_shuffle_rogne")
    # Copier C, tête de lecture au début de C, coller : la copie s'insère, la suite avance de 2 s
    c0 = clip_of(page, "voix", "C")["start"]
    page.mouse.click(pe.x_of(box, c0 + 1.0), pe.lane_y(box, 0, 0.85)); page.wait_for_timeout(150)
    page.keyboard.press("Control+c"); page.wait_for_timeout(150)
    page.mouse.click(pe.x_of(box, c0), box["y"] + 20); page.wait_for_timeout(200)
    page.mouse.click(pe.x_of(box, c0 + 1.0), pe.lane_y(box, 0, 0.85)); page.wait_for_timeout(150)
    page.keyboard.press("Control+v"); page.wait_for_timeout(350)
    res["shuffle_colle"] = spans(page, "voix")
    st_ = starts(res["shuffle_colle"])
    res["shuffle_colle_ok"] = len(st_) == 4 and all(abs(x[1] - e) < 0.03 for x, e in zip(st_, (0.0, c0, c0 + 2, c0 + 4)))
    shot(page, "pc_12_shuffle_colle_pousse")
    # Plage 0,5 → 1,0 s dans B (moitié haute, Smart Tool), Suppr : tout recule de 0,5 s
    avant = starts(spans(page, "voix"))
    hi = pe.lane_y(box, 0, 0.15)
    pe.drag(page, pe.x_of(box, 0.5), hi, pe.x_of(box, 1.0), hi)
    res["shuffle_plage"] = pe.tsel(page)
    page.keyboard.press("Delete"); page.wait_for_timeout(350)
    res["shuffle_plage_suppr"] = spans(page, "voix")
    apres = starts(res["shuffle_plage_suppr"])
    res["shuffle_plage_ok"] = (len(apres) == len(avant) + 1 and abs(apres[1][1] - 0.5) < 0.02
                               and all(abs(a2[1] - (a1[1] - 0.5)) < 1e-3 for a1, a2 in zip(avant[1:], apres[2:])))
    shot(page, "pc_13_shuffle_plage_supprimee")
    # Shuffle Lock (clic droit sur SHUF) : F1 ne fait plus entrer en Shuffle
    page.keyboard.press("F2"); page.wait_for_timeout(150)
    page.locator('[data-edit-mode="SHUFFLE"]').click(button="right"); page.wait_for_timeout(150)
    page.keyboard.press("F1"); page.wait_for_timeout(150)
    res["shuffle_lock"] = mode(page)
    res["shuffle_lock_ok"] = res["shuffle_lock"] == "SLIP:LOCK"
    shot(page, "pc_14_shuffle_lock")
    page.locator('[data-edit-mode="SHUFFLE"]').click(button="right"); page.wait_for_timeout(150)

    # ---------------- Projet rouvert : le mode (préférence) est gardé ; Spot (F3 / Alt+3)
    pe.open_project(page, project(), "pc_15_projet_rouvert")
    res["mode_apres_reouverture"] = mode(page)
    box = pe.canvas_box(page)
    page.mouse.click(5, 300)
    page.keyboard.press("Alt+3"); page.wait_for_timeout(200)
    res["apres_Alt3"] = mode(page)
    page.mouse.click(pe.x_of(box, 6.8), pe.lane_y(box, 0, 0.85)); page.wait_for_timeout(400)
    res["spot_ouvert"] = page.locator('[data-testid="spot-dialog"]').is_visible()
    page.get_by_role("radio", name="Mesures|temps|ticks").click()
    page.locator('[data-testid="spot-input"]').fill("8|1|000"); page.wait_for_timeout(100)
    shot(page, "pc_16_spot_mesures")
    page.keyboard.press("Enter"); page.wait_for_timeout(300)
    res["spot_mesures"] = clip_of(page, "voix", "B")["start"]  # 8|1|000 = 14 s à 120 BPM
    page.mouse.click(pe.x_of(box, 14.8), pe.lane_y(box, 0, 0.85)); page.wait_for_timeout(400)
    page.get_by_role("radio", name="Min:sec").click()
    page.locator('[data-testid="spot-input"]').fill("0:12.345"); page.keyboard.press("Enter"); page.wait_for_timeout(300)
    res["spot_minsec"] = clip_of(page, "voix", "B")["start"]
    page.mouse.click(pe.x_of(box, 13.0), pe.lane_y(box, 0, 0.85)); page.wait_for_timeout(400)
    page.get_by_role("radio", name="Échantillons").click()
    sr = page.evaluate("() => window.__novaEditMode.sampleRate()")
    res["frequence_session"] = sr
    page.locator('[data-testid="spot-input"]').fill(str(int(13 * sr))); page.keyboard.press("Enter"); page.wait_for_timeout(300)
    res["spot_echantillons"] = clip_of(page, "voix", "B")["start"]  # 13 × fréquence de la session = 13 s
    # Point de synchro de A (0,3 s) + Spot sur la synchro, puis « position d'origine »
    place(page, "voix", {"A": {"start": 3, "syncPoint": 0.3}})
    page.mouse.click(pe.x_of(box, 3.9), pe.lane_y(box, 0, 0.85)); page.wait_for_timeout(400)
    page.get_by_role("radio", name="Mesures|temps|ticks").click()
    page.get_by_role("radio", name="Point de synchro").click()
    page.locator('[data-testid="spot-input"]').fill("5|1|000"); page.wait_for_timeout(100)
    shot(page, "pc_17_spot_point_de_synchro")
    page.keyboard.press("Enter"); page.wait_for_timeout(300)
    res["spot_synchro"] = clip_of(page, "voix", "A")["start"]  # synchro à 8 s → début 7,7 s
    page.mouse.click(pe.x_of(box, 8.4), pe.lane_y(box, 0, 0.85)); page.wait_for_timeout(400)
    page.locator('[data-testid="spot-origin"]').click(); page.wait_for_timeout(100)
    shot(page, "pc_18_spot_position_origine")
    page.locator('[data-testid="spot-apply"]').click(); page.wait_for_timeout(300)
    res["spot_origine"] = clip_of(page, "voix", "A")["start"]
    res["spot_ok"] = (res["spot_ouvert"] and abs(res["spot_mesures"] - 14) < 1e-6 and abs(res["spot_minsec"] - 12.345) < 1e-6
                      and abs(res["spot_echantillons"] - 13) < 1e-6 and abs(res["spot_synchro"] - 7.7) < 1e-6 and abs(res["spot_origine"] - 0.125) < 1e-6)
    # R1 (audit UX 08/10) : début hors tick (9 s + 14 994 éch.). « Placer » sans retoucher en Mesures ne
    # bouge pas le clip, et Mesures → Min:sec → Échantillons affiche l'échantillon exact (avant : +5).
    s_c = int(round(9 * sr)) + 14994
    start_c = "() => Math.round(window.__novaEdit.getState().tracks.find(t => t.id === 'voix').clips.find(c => c.id === 'C').start * window.__novaEditMode.sampleRate())"
    place(page, "voix", {"C": {"start": s_c / sr}})
    page.mouse.click(pe.x_of(box, 9.9), pe.lane_y(box, 0, 0.85)); page.wait_for_timeout(400)
    page.get_by_role("radio", name="Mesures|temps|ticks").click(); page.wait_for_timeout(80)
    res["r1_texte_mesures"] = page.locator('[data-testid="spot-input"]').input_value()
    page.locator('[data-testid="spot-apply"]').click(); page.wait_for_timeout(300)
    res["r1_placer_sans_retoucher"] = page.evaluate(start_c)
    page.mouse.click(pe.x_of(box, 9.9), pe.lane_y(box, 0, 0.85)); page.wait_for_timeout(400)
    page.get_by_role("radio", name="Min:sec").click(); page.wait_for_timeout(80)
    page.get_by_role("radio", name="Échantillons").click(); page.wait_for_timeout(80)
    res["r1_texte_echantillons"] = page.locator('[data-testid="spot-input"]').input_value()
    shot(page, "pc_18b_spot_echantillon_exact")
    page.keyboard.press("Escape"); page.wait_for_timeout(150)
    res["r1_attendu"] = s_c
    res["r1_ok"] = res["r1_placer_sans_retoucher"] == s_c and res["r1_texte_echantillons"] == str(s_c)
    res["spot_ok"] = res["spot_ok"] and res["r1_ok"]

    # ---------------- Tab to Transient : attaques de A à 0,5 et 1,2 s du fichier
    page.keyboard.press("F2"); page.wait_for_timeout(150)
    place(page, "voix", {"A": {"start": 2, "offset": 0, "duration": 2}})
    page.mouse.click(pe.x_of(box, 1.0), box["y"] + 20); page.wait_for_timeout(200)
    page.mouse.click(pe.x_of(box, 3.0), pe.lane_y(box, 0, 0.85)); page.wait_for_timeout(200)
    page.mouse.click(5, 300); page.wait_for_timeout(100)
    tabs = []
    for key in ("Tab", "Tab", "Tab", "Shift+Tab"):
        page.keyboard.press(key); page.wait_for_timeout(200); tabs.append(ph(page))
    res["tab_to_transient"] = tabs  # attendu ≈ 2 (début du clip), 2,5, 3,2, puis 2,5
    res["tab_ok"] = abs(tabs[0] - 2.0) < 0.002 and abs(tabs[1] - 2.5) < 0.002 and abs(tabs[2] - 3.2) < 0.002 and abs(tabs[3] - 2.5) < 0.002
    page.keyboard.press("Control+Alt+ArrowRight"); page.wait_for_timeout(250)
    res["clip_suivant"] = ph(page)

    # ---------------- Mode sauvé avec le projet et en préférence
    res["mode_dans_le_projet"] = page.evaluate("() => window.__novaEdit.getState().editMode")
    res["mode_en_preference"] = page.evaluate("() => JSON.parse(localStorage.getItem('nova_edit_mode') || 'null')")
    page.keyboard.press("?"); page.wait_for_timeout(400)
    page.get_by_placeholder("Chercher", exact=False).first.fill("mode")
    page.wait_for_timeout(300)
    shot(page, "pc_19_aide_raccourcis_modes")
    txt = page.evaluate("() => document.body.innerText.toLowerCase()")
    res["aide_modes"] = all(k in txt for k in ("modes d’édition", "shuffle", "slip", "spot", "grid", "f4"))


LIBRE_GRILLE_JS = """() => [...document.querySelectorAll('[role=radiogroup][aria-label="Placement des clips"] button')]
  .filter(b => b.getClientRects().length)
  .map(b => ({ t: b.textContent.trim(), on: b.getAttribute('aria-checked'), h: Math.round(b.getBoundingClientRect().height) }))"""


def libre_grille(page):
    return page.evaluate(LIBRE_GRILLE_JS)


def scenario_ecran(page, res, vp):
    # Mode simple d'abord : Libre / Grille ; puis (tablette) mode avancé : SHUF / SLIP / SPOT / GRID.
    pe.open_project(page, project(), f"{vp}_01_session")
    res[f"{vp}_simple_libre_grille"] = libre_grille(page)
    shot(page, f"{vp}_01b_simple_libre_grille")
    if vp == "tab":
        page.add_init_script("try { localStorage.setItem('nova_simple_mode', '0'); } catch (e) {}")
        pe.open_project(page, project(), f"{vp}_01c_avance")
    res[f"{vp}_debordements"] = qalib.overflow_report(page)[:10]
    res[f"{vp}_hscroll"] = page.evaluate("() => document.documentElement.scrollWidth > innerWidth + 1")
    res[f"{vp}_selecteur"] = page.evaluate("() => [...document.querySelectorAll('[data-edit-mode]')].filter(b => b.getClientRects().length).map(b => { const r = b.getBoundingClientRect(); return { mode: b.dataset.editMode, h: Math.round(r.height), w: Math.round(r.width) }; })")
    res[f"{vp}_libre_grille"] = libre_grille(page)
    shot(page, f"{vp}_02_selecteur")
    if vp == "tab":
        box = pe.canvas_box(page)
        res["tab_canvas"] = box
        # Mode Spot au doigt, puis appui long sur A : Position exacte (et pas le menu du clip)
        page.locator('[data-edit-mode="SPOT"]').tap(); page.wait_for_timeout(150)
        res["tab_tap_spot"] = mode(page)
        x, y = pe.x_of(box, 1.0), pe.lane_y(box, 0, 0.85)
        cdp = page.context.new_cdp_session(page)
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
        page.wait_for_timeout(800)
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        page.wait_for_timeout(300)
        res["tab_appui_long_spot"] = page.locator('[data-testid="spot-dialog"]').is_visible()
        res["tab_appui_long_menu_du_clip_aussi"] = page.get_by_text("Normaliser").locator("visible=true").count() > 0
        shot(page, "tab_03_appui_long_spot")
        page.keyboard.press("Escape"); page.wait_for_timeout(200)
        # Sélecteur au doigt : SLIP puis GRID
        page.locator('[data-edit-mode="SLIP"]').tap(); page.wait_for_timeout(150)
        res["tab_tap_slip"] = mode(page)
        page.locator('[data-edit-mode="GRID"]').tap(); page.wait_for_timeout(150)
        res["tab_tap_grid"] = mode(page)
    if vp == "tel":
        btn = page.get_by_role("radio", name="Libre").locator("visible=true").first
        if btn.count():
            btn.tap(); page.wait_for_timeout(200)
            res["tel_libre"] = mode(page)
            shot(page, "tel_03_libre")
            page.get_by_role("radio", name="Grille").locator("visible=true").first.tap(); page.wait_for_timeout(200)
            res["tel_grille"] = mode(page)
        else:
            res["tel_libre"] = "menu Libre / Grille non visible"


SCENARIOS = {"pc": scenario_pc, "tab": lambda p, r: scenario_ecran(p, r, "tab"), "tel": lambda p, r: scenario_ecran(p, r, "tel")}


def main(names):
    summary = {}
    with sync_playwright() as p:
        b = pe.launch(p)
        for n in names:
            log = Log(f"modes_{n}")
            res = {"name": n, "ok": True}
            ctx, page = new_page(b, n if n in ("tab", "tel") else "pc", log, touch=(n != "pc"))
            t = time.time()
            try:
                SCENARIOS[n](page, res)
            except Exception as e:  # noqa
                res["ok"] = False
                res["exception"] = f"{type(e).__name__}: {str(e)[:600]}"
                try: shot(page, f"{n}__ECHEC")
                except Exception: pass
            res["secs"] = round(time.time() - t, 1)
            res["erreurs_page"] = [e["text"][:300] for e in log.errors()][:20]
            save_log(log, {"result": res})
            (OUT / f"mesures_{n}.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
            summary[n] = res
            ctx.close()
        b.close()
    print(json.dumps(summary, ensure_ascii=False, indent=1)[:9000])


if __name__ == "__main__":
    main([a for a in sys.argv[1:] if a in SCENARIOS] or list(SCENARIOS))
