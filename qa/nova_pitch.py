"""Nova Pitch · « Notes de la voix » : l'éditeur de notes de NOVA, de bout en bout,
dans un navigateur headless (aucune fenêtre), hors production.

  NOVA_URL=http://127.0.0.1:3552/ python qa/nova_pitch.py [A B C D E]

  A. PC sombre 1600 : double-clic sur le clip de voix → panneau en bas (analyse avec
     avancement) ; glisser une note (aimant gamme), Maj+↑ (2 cents), ↑ (demi-ton),
     saisie « La2 +4 », « Corriger la sélection » ; un geste = une étape (Ctrl+Z ×2,
     Ctrl+Y ×2) ; Réglages (formant, gain) ; Élastique (bord tiré ×1,5, double-clic =
     durée d'origine) ; Couper puis Fusionner. Mesures sur le son rendu (Python, YIN
     indépendant) : hauteur demandée ±1 cent, pas de 2 cents ; lecture = export (même
     son au bit près) ; sauvegarde .zip (analyse pitch/<clip>.bin + retouches) puis
     réouverture : retouches retrouvées, pas de nouvelle analyse.
  B. Tablette 1024 au doigt (thème clair) : ouverture par le menu du clip, note
     glissée au doigt, cibles ≥ 44 px.
  C. Téléphone 390 : bouton du clip → « Corriger la justesse » (épuré), dosage.
  D. PC clair 1366 : commande « Corriger la justesse » (Ctrl+K), version épurée.
  E. Aucun nom de logiciel concurrent dans le panneau ni dans ses menus.

Sortie : D:\\1 WORK\\CONTENU\\nova-pitch\\qa (QA_OUT) ; code 0 si tout passe.
"""
import json, os, re, sys, time, zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-pitch\qa")
from qalib import *  # noqa
from gel_pre_effet import prepare, open_project_file, save_zip  # noqa
from v19_justesse import synth_voice, make_project, wav_bytes, read_wav, note_pitch, canvas_box, SYN_DUR, SR  # noqa

OUT = Path(os.environ["QA_OUT"]); OUT.mkdir(parents=True, exist_ok=True)
CHECKS = []
RES = {}
CONCURRENTS = re.compile(r"melodyne|flex ?pitch|variaudio|newtone|auto-?tune|waves|antares|celemony|logic|cubase|studio one|fl studio|pro tools|psola", re.I)


def check(label, ok, detail=None):
    CHECKS.append({"check": label, "ok": bool(ok), "detail": detail})
    print(("OK  " if ok else "KO  ") + label + (f"  ({detail})" if detail is not None else ""), flush=True)


CLIP = """s => { const c = s.tracks.find(t => t.id === 'voix').clips[0]; return { id: c.id, bufferId: c.bufferId, offset: c.offset, start: c.start, duration: c.duration, name: c.name,
  pe: c.pitchEdit ? { n: c.pitchEdit.edits.length, renderSig: c.pitchEdit.renderSig, source: c.pitchEdit.sourceBufferId, regionStart: c.pitchEdit.regionStart, cuts: c.pitchEdit.cuts || [], joins: c.pitchEdit.joins || [], extend: c.pitchEdit.extend || 0, edits: c.pitchEdit.edits } : null }; }"""


def clip(page):
    return page.evaluate(f"() => ({CLIP})(window.__novaEdit.getState())")


def in_sync(page):
    """Le son joué est le rendu des retouches actuelles (aucun calcul en attente)."""
    return page.evaluate("""async () => {
      const np = await window.__novaAppModule('/utils/novaPitch.ts');
      const reg = (await window.__novaAppModule('/utils/audioBufferRegistry.ts')).audioBufferRegistry;
      const c = window.__novaEdit.getState().tracks.find(t => t.id === 'voix').clips[0];
      const pe = c.pitchEdit; if (!pe) return true;
      return pe.renderSig === np.infoSig(pe) && reg.has(c.bufferId) && c.bufferId !== pe.sourceBufferId;
    }""")


def wait_sync(page, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if in_sync(page):
            return round(time.time() - t0, 2)
        page.wait_for_timeout(100)
    return None


def buffer(page, bid):
    r = page.evaluate("""async (bid) => { const reg = (await window.__novaAppModule('/utils/audioBufferRegistry.ts')).audioBufferRegistry;
      const b = reg.get(bid); if (!b) return null; return { sr: b.sampleRate, x: Array.from(b.getChannelData(0)) }; }""", bid)
    return (np.array(r["x"], dtype=np.float32), r["sr"]) if r else (None, None)


def geom(page):
    return json.loads(page.locator("[data-testid=pitch-canvas]").get_attribute("data-geom"))


def cbox(page):
    return page.locator("[data-testid=pitch-canvas]").bounding_box()


def clip_point(page, t=2.0):
    box = canvas_box(page)
    return box["x"] + t * 40 - box["sl"], box["y"] + box.get("tt", 40) + 60 - box["st"]


def open_by_dblclick(page):
    page.mouse.click(800, 600); page.wait_for_timeout(200)
    x, y = clip_point(page)
    page.mouse.click(x, y); page.wait_for_timeout(200)
    t0 = time.time()
    page.mouse.dblclick(x, y)
    page.wait_for_selector("[data-testid=pitch-editor]", timeout=8000)
    prog = page.locator("[data-testid=pitch-progress]").count() > 0
    page.wait_for_function("() => !document.querySelector('[data-testid=pitch-status]')", timeout=60000)
    return round(time.time() - t0, 2), prog


def drag_mouse(page, x0, y0, x1, y1, steps=8, mods=()):
    for m in mods: page.keyboard.down(m)
    page.mouse.move(x0, y0); page.mouse.down()
    for k in range(1, steps + 1):
        page.mouse.move(x0 + (x1 - x0) * k / steps, y0 + (y1 - y0) * k / steps)
    page.mouse.up()
    for m in mods: page.keyboard.up(m)
    page.wait_for_timeout(250)


def touch_drag(page, x0, y0, x1, y1, steps=10):
    cdp = page.context.new_cdp_session(page)
    pt = lambda x, y: [{"x": x, "y": y, "id": 1}]  # noqa
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": pt(x0, y0)})
    for k in range(1, steps + 1):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": pt(x0 + (x1 - x0) * k / steps, y0 + (y1 - y0) * k / steps)})
        page.wait_for_timeout(16)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    page.wait_for_timeout(300)


def note_center_px(page, i):
    b, g = cbox(page), geom(page)[i]
    return b["x"] + (g["x0"] + g["x1"]) / 2, b["y"] + g["y"]


def menu_pick(page, button_testid, item_id):
    page.get_by_test_id(button_testid).click(); page.wait_for_timeout(250)
    page.locator(f"[data-nova-roll='{item_id}']").first.click(); page.wait_for_timeout(250)


def measured_cents(x, sr, a, b, target):
    return (note_pitch(x, sr, a, b) - target) * 100


def small_targets(page, scope="[data-testid=pitch-editor]"):
    return page.evaluate(f"""() => Array.from(document.querySelectorAll('{scope} button, {scope} input, {scope} select')).filter(e => {{ const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.height < 43.5); }}).map(e => (e.getAttribute('aria-label') || e.textContent || e.getAttribute('data-testid') || '').trim().slice(0, 40))""")


# ---------------------------------------------------------------- A. PC sombre
def scenario_pc(p):
    log = Log("A_pc")
    x, _ = synth_voice()
    proj = OUT / "voix_synthetique.zip"
    make_project(proj, wav_bytes(x), SYN_DUR, "Notes de la voix (QA)")
    b = launch(p)
    _, page = new_page(b, "pc", log)
    prepare(page)
    open_project_file(page, proj, RES, "A0_projet")
    page.wait_for_function("() => !!window.__novaEdit", timeout=20000)
    secs, prog = open_by_dblclick(page)
    shot(page, "A1_editeur_ouvert")
    check("A · double-clic sur le clip de voix → panneau « Notes de la voix » en bas", page.locator("#nova-pitch-dock [data-testid=pitch-editor]").count() == 1)
    check("A · analyse avec barre d'avancement puis notes affichées", prog and len(geom(page)) == 8, {"s": secs, "notes": len(geom(page))})
    src = clip(page)
    src_x, src_sr = buffer(page, src["bufferId"])

    # 1. Glisser la note 1 vers le haut (aimant gamme) : une étape.
    x0, y0 = note_center_px(page, 0)
    drag_mouse(page, x0, y0, x0, y0 - 24)
    g1 = clip(page)
    m_after_drag = geom(page)[0]["m"]
    check("A · glisser : la note se pose sur la gamme (La mineur)", abs(m_after_drag - round(m_after_drag)) < 1e-3 and round(m_after_drag) % 12 in (9, 11, 0, 2, 4, 5, 7), m_after_drag)
    t_render = wait_sync(page)
    check("A · son rendu en arrière-plan après le geste", t_render is not None and t_render < 5, t_render)
    shot(page, "A2_note_glissee")

    # 2. Maj+↑ (2 cents) puis ↑ (demi-ton) sur la note sélectionnée.
    page.keyboard.press("Shift+ArrowUp"); page.wait_for_timeout(250)
    m2 = geom(page)[0]["m"]
    check("A · Maj+↑ = +2 cents", abs((m2 - m_after_drag) * 100 - 2) < 0.01, round((m2 - m_after_drag) * 100, 3))
    page.keyboard.press("ArrowUp"); page.wait_for_timeout(250)
    m3 = geom(page)[0]["m"]
    check("A · ↑ = demi-ton juste", abs(m3 - round(m3)) < 1e-6 and round(m3) == round(m2) + 1, m3)
    wait_sync(page)

    # 3. Un geste = une étape : Ctrl+Z ×2 puis Ctrl+Y ×2.
    page.keyboard.press("Control+z"); page.wait_for_timeout(500)
    u1 = geom(page)[0]["m"]
    page.keyboard.press("Control+z"); page.wait_for_timeout(500)
    u2 = geom(page)[0]["m"]
    page.keyboard.press("Control+y"); page.wait_for_timeout(400)
    page.keyboard.press("Control+y"); page.wait_for_timeout(500)
    u3 = geom(page)[0]["m"]
    check("A · annuler / rétablir : une étape par geste", abs(u1 - m2) < 1e-6 and abs(u2 - m_after_drag) < 1e-6 and abs(u3 - m3) < 1e-6, [u1, u2, u3])
    check("A · après Ctrl+Z / Ctrl+Y : le son joué suit (rendu recalculé si besoin)", wait_sync(page) is not None)

    # 4. Saisie numérique « La2 +4 » sur la note 3 (Réglages, Entrée).
    x3, y3 = note_center_px(page, 2)
    page.mouse.click(x3, y3); page.wait_for_timeout(300)
    page.keyboard.press("r"); page.wait_for_timeout(300)
    shot(page, "A3_reglages_note")
    fld = page.get_by_test_id("pitch-number")
    fld.fill("La2 +4"); fld.press("Enter"); page.wait_for_timeout(400)
    m_in = geom(page)[2]["m"]
    check("A · saisie « La2 +4 » → MIDI 57,04", abs(m_in - 57.04) < 1e-6, m_in)
    # Gain −6 dB (curseur), formant +2 dt.
    for tid, val in (("pitch-gain", -6), ("pitch-formant", 2)):
        page.evaluate("""([id, v]) => { const el = document.querySelector(`[data-testid=${id}]`); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          set.call(el, String(v)); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); }""", [tid, val])
        page.wait_for_timeout(300)
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    c4 = clip(page)
    e3 = [e for e in c4["pe"]["edits"] if abs(e["t0"] - 1.5285) < 0.05]
    check("A · réglages de la note rangés (gain −6 dB, formant +2)", bool(e3) and e3[0].get("gain") == -6 and e3[0].get("formant") == 2, e3[:1])
    wait_sync(page)

    # 5. Mesures sur le son rendu : note 1 (demi-ton juste), note 3 (57,04).
    c5 = clip(page)
    y, ysr = buffer(page, c5["bufferId"])
    off = c5["offset"]
    g = geom(page)
    # Mesure relative (même détecteur, même fenêtre, avant / après) : le biais du vibrato chanté s'annule.
    sung = page.evaluate("() => JSON.parse(document.querySelector('[data-testid=pitch-canvas]').dataset.sung || '[]')")
    def rel(i):
        a_, b_ = g[i]["a"] + 0.12, g[i]["b"] - 0.1
        return ((note_pitch(y, ysr, a_, b_) - note_pitch(src_x, src_sr, a_, b_)) - (g[i]["m"] - sung[i])) * 100
    err1, err3 = rel(0), rel(2)
    RES["A_hauteur_mesuree"] = {"note1_ct": round(err1, 2), "note3_ct": round(err3, 2), "offset": off}
    check("A · hauteur mesurée (YIN Python) = hauteur demandée à ±1 cent", abs(err1) < 1 and abs(err3) < 1, RES["A_hauteur_mesuree"])
    check("A · durée du son inchangée", len(y) == len(src_x), [len(y), len(src_x)])

    # 6. Corriger la sélection (toutes) : centre 100 %, dérive 50 %.
    page.keyboard.press("Control+a"); page.wait_for_timeout(200)
    page.keyboard.press("q"); page.wait_for_timeout(300)
    shot(page, "A4_corriger_selection")
    page.get_by_test_id("pitch-correct-apply").click(); page.wait_for_timeout(500)
    gs = geom(page)
    on_scale = all(abs(n["m"] - round(n["m"])) < 1e-6 for n in gs)
    check("A · « Corriger la sélection » 100 % : toutes les notes pile sur la gamme", on_scale, [n["m"] for n in gs])
    wait_sync(page)

    # 7. Élastique : outil 2, bord droit de la note 4 tiré (×1,5), puis double-clic = durée d'origine.
    page.keyboard.press("Escape"); page.wait_for_timeout(150)
    page.keyboard.press("2"); page.wait_for_timeout(200)
    bx = cbox(page); n4 = geom(page)[3]
    L = n4["b"] - n4["a"]
    yPre, _ = buffer(page, clip(page)["bufferId"])
    # Fenêtre d'un nombre entier de cycles de vibrato (5,5 Hz) : le vibrato chanté ne biaise pas la moyenne.
    kcy = int((L - 0.2) * 5.5)
    tPre = note_pitch(yPre, ysr, n4["a"] + 0.1, n4["a"] + 0.1 + kcy / 5.5)
    pps = (n4["x1"] - n4["x0"]) / L
    xe, ye = bx["x"] + n4["x1"] - 1, bx["y"] + n4["y"]
    page.keyboard.down("Alt")
    drag_mouse(page, xe, ye, xe + 1 + 0.3 * L * pps, ye, steps=10)
    page.keyboard.up("Alt")
    n4b = geom(page)[3]
    got = n4b["b"] - n4b["a"]
    check("A · élastique : note allongée ×1,3 (sans grille, Alt)", abs(got / L - 1.3) < 0.01, round(got / L, 3))
    nxt_ok = geom(page)[4]["a"] >= n4b["b"] - 1e-6
    check("A · élastique : la note voisine s'adapte, rien ne se chevauche", nxt_ok)
    shot(page, "A5_elastique")
    wait_sync(page)
    cE = clip(page)
    yE, _ = buffer(page, cE["bufferId"])
    kcy2 = int((n4b["b"] - n4b["a"] - 0.2) * 5.5)
    tE = note_pitch(yE, ysr, n4b["a"] + 0.1, n4b["a"] + 0.1 + kcy2 / 5.5)
    check("A · note étirée : même hauteur (±1 cent)", abs((tE - tPre) * 100) < 1, round((tE - tPre) * 100, 2))
    check("A · durée du son toujours celle du clip (la voisine absorbe)", len(yE) == len(src_x))
    bx = cbox(page)
    page.mouse.dblclick(bx["x"] + (n4b["x0"] + n4b["x1"]) / 2, bx["y"] + n4b["y"]); page.wait_for_timeout(400)
    n4c = geom(page)[3]
    check("A · double-clic = durée d'origine", abs((n4c["b"] - n4c["a"]) - L) < 1e-3, round(n4c["b"] - n4c["a"], 4))

    # 8. Couper (outil 3) au milieu de la note 8, puis Fusionner (M).
    page.keyboard.press("3"); page.wait_for_timeout(150)
    bx = cbox(page); n8 = geom(page)[7]
    page.mouse.click(bx["x"] + (n8["x0"] + n8["x1"]) / 2, bx["y"] + n8["y"]); page.wait_for_timeout(400)
    cut_ok = len(geom(page)) == 9
    page.keyboard.press("1"); page.wait_for_timeout(100)
    bx = cbox(page); n8 = geom(page)[7]
    page.mouse.click(bx["x"] + (n8["x0"] + n8["x1"]) / 2, bx["y"] + n8["y"]); page.wait_for_timeout(200)
    page.keyboard.press("m"); page.wait_for_timeout(400)
    check("A · couper une note puis fusionner", cut_ok and len(geom(page)) == 8, len(geom(page)))
    wait_sync(page)

    # 9. Menus : outil, aimant, notes, vue (captures) ; aucun nom concurrent.
    shot(page, "A6_avant_menus")
    texts = []
    for tid in ("pitch-tool", "pitch-magnet", "pitch-menu-notes", "pitch-menu-view"):
        page.get_by_test_id(tid).click(); page.wait_for_timeout(250)
        texts.append(page.locator("[data-nova-roll-menu]").last.inner_text())
        shot(page, f"A6_menu_{tid}")
        page.keyboard.press("Escape"); page.wait_for_timeout(150)
    texts.append(page.get_by_test_id("pitch-editor").inner_text())
    bad = [t for t in texts if CONCURRENTS.search(t)]
    check("E · aucun nom de logiciel concurrent dans le panneau et ses menus", not bad, bad[:2])

    # 10. Lecture = export : le son joué par le clip est le rendu ; export hors ligne du projet comparé.
    cF = clip(page)
    yF, _ = buffer(page, cF["bufferId"])
    r = page.evaluate("""async () => { const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts');
      const s = window.__novaEdit.getState(); const b = await audioEngine.renderProject(s.tracks, 7.5, 0, 44100);
      return { sr: b.sampleRate, x: Array.from(b.getChannelData(0)) }; }""")
    ex = np.array(r["x"], dtype=np.float32)
    s0 = int(round(cF["start"] * SR)); o0 = int(round(cF["offset"] * SR)); n = int(cF["duration"] * SR) - 10
    seg_e, seg_r = ex[s0:s0 + n], yF[o0:o0 + n]
    # Le moteur applique un gain par piste (fader, panoramique) : on compare la forme, pas le niveau.
    k = float(np.dot(seg_e, seg_r) / max(1e-12, np.dot(seg_r, seg_r)))
    resid = float(np.max(np.abs(seg_e - k * seg_r)))
    RES["A_export"] = {"gain_piste": round(k, 6), "ecart_max": resid}
    check("A · export = son rendu du clip (au bit près à gain de piste près)", resid < 2e-6, RES["A_export"])

    # 11. Sauvegarde .zip puis réouverture : retouches et analyse.
    before = clip(page)
    gb = geom(page)
    proj2 = OUT / "projet_notes_retouchees.zip"
    data, names = save_zip(page, proj2)
    check("A · .zip : analyse de la voix rangée (pitch/<clip>.bin)", "pitch/voix-1.bin" in names, [n for n in names if n.startswith("pitch/")])
    page.locator("[data-testid=pitch-close]").click(); page.wait_for_timeout(300)
    open_project_file(page, proj2, RES, "A7_reouvert")
    page.wait_for_function("() => !!window.__novaEdit", timeout=20000)
    after = clip(page)
    check("A · réouverture : retouches et son rendu à jour", after["pe"] and after["pe"]["n"] == before["pe"]["n"] and in_sync(page), {"avant": before["pe"]["n"], "apres": after["pe"] and after["pe"]["n"]})
    secs2, prog2 = open_by_dblclick(page)
    ga = geom(page)
    same = len(ga) == len(gb) and all(abs(a["m"] - b_["m"]) < 1e-3 for a, b_ in zip(ga, gb))
    check("A · réouverture : éditeur sans nouvelle analyse, notes à l'identique", same and secs2 < 3, {"s": secs2, "barre": prog2})
    shot(page, "A8_reouvert")
    RES["A_erreurs_console"] = [e["text"][:200] for e in log.errors()][:8]
    check("A · aucune erreur dans la console", not log.errors(), RES["A_erreurs_console"])
    b.close()


# ---------------------------------------------------------------- B. Tablette au doigt, clair
def scenario_tablet(p):
    log = Log("B_tab")
    x, _ = synth_voice()
    proj = OUT / "voix_synthetique.zip"
    if not proj.exists(): make_project(proj, wav_bytes(x), SYN_DUR, "Notes de la voix (QA)")
    os.environ["QA_THEME"] = "light"
    b = launch(p)
    _, page = new_page(b, "tab", log)
    os.environ.pop("QA_THEME", None)
    prepare(page)
    open_project_file(page, proj, RES, "B0_projet")
    page.wait_for_function("() => !!window.__novaEdit", timeout=20000)
    page.evaluate("() => window.dispatchEvent(new CustomEvent('nova:open-window', { detail: { name: 'pitch-editor', targets: [{ trackId: 'voix', clipId: 'voix-1' }] } }))")
    page.wait_for_selector("[data-testid=pitch-editor]", timeout=8000)
    page.wait_for_function("() => !document.querySelector('[data-testid=pitch-status]')", timeout=60000)
    page.wait_for_timeout(400)
    shot(page, "B1_tablette_clair")
    x0, y0 = note_center_px(page, 1)
    m0 = geom(page)[1]["m"]
    touch_drag(page, x0, y0, x0, y0 - 30)
    m1 = geom(page)[1]["m"]
    check("B · tablette : note glissée au doigt (une note de la gamme plus haut)", m1 > m0 + 0.5 and abs(m1 - round(m1)) < 1e-6, [m0, m1])
    shot(page, "B2_tablette_note_glissee")
    small = small_targets(page)
    check("B · tablette : toutes les commandes du panneau ≥ 44 px", not small, small[:6])
    b.close()


# ---------------------------------------------------------------- C. Téléphone 390
def scenario_phone(p):
    log = Log("C_tel")
    x, _ = synth_voice()
    proj = OUT / "voix_synthetique.zip"
    if not proj.exists(): make_project(proj, wav_bytes(x), SYN_DUR, "Notes de la voix (QA)")
    b = launch(p)
    _, page = new_page(b, "tel390", log)
    prepare(page)
    open_project_file(page, proj, RES, "C0_projet")
    page.wait_for_function("() => !!window.__novaEdit", timeout=20000)
    page.evaluate("() => window.dispatchEvent(new CustomEvent('nova:open-window', { detail: { name: 'pitch-editor', simple: true, targets: [{ trackId: 'voix', clipId: 'voix-1' }] } }))")
    page.wait_for_selector("[data-testid=pitch-editor]", timeout=8000)
    page.wait_for_function("() => !document.querySelector('[data-testid=pitch-status]')", timeout=60000)
    page.wait_for_timeout(400)
    mode = page.get_by_test_id("pitch-editor").get_attribute("data-mode")
    shot(page, "C1_telephone")
    page.evaluate("""() => { const el = document.querySelector('[data-testid=pitch-amount]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, '100'); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); }""")
    page.wait_for_timeout(600)
    gs = geom(page)
    check("C · téléphone : plein écran, « Corriger la justesse » à 100 % → notes sur la gamme", mode == "phone" and all(abs(n["m"] - round(n["m"])) < 1e-6 for n in gs), mode)
    check("C · téléphone : son rendu", wait_sync(page) is not None)
    over = page.evaluate("() => document.documentElement.scrollWidth > window.innerWidth + 1")
    check("C · téléphone : aucun débordement horizontal", not over)
    shot(page, "C2_telephone_corrige")
    b.close()


# ---------------------------------------------------------------- D. PC clair : « Corriger la justesse » (palette)
def scenario_simple(p):
    log = Log("D_simple")
    x, _ = synth_voice()
    proj = OUT / "voix_synthetique.zip"
    if not proj.exists(): make_project(proj, wav_bytes(x), SYN_DUR, "Notes de la voix (QA)")
    os.environ["QA_THEME"] = "light"
    b = launch(p)
    _, page = new_page(b, "pc1366", log)
    os.environ.pop("QA_THEME", None)
    prepare(page)
    open_project_file(page, proj, RES, "D0_projet")
    page.wait_for_function("() => !!window.__novaEdit", timeout=20000)
    page.mouse.click(700, 560); page.wait_for_timeout(200)
    x, y = clip_point(page)
    page.mouse.click(x, y); page.wait_for_timeout(200)
    page.keyboard.press("Control+k"); page.wait_for_timeout(400)
    page.get_by_test_id("palette-input").type("corriger la justesse", delay=20); page.wait_for_timeout(400)
    shot(page, "D1_palette")
    page.keyboard.press("Enter")
    page.wait_for_selector("[data-testid=pitch-editor]", timeout=8000)
    page.wait_for_function("() => !document.querySelector('[data-testid=pitch-status]')", timeout=60000)
    page.wait_for_timeout(400)
    mode = page.get_by_test_id("pitch-editor").get_attribute("data-mode")
    check("D · « Corriger la justesse » ouvre l'éditeur épuré", mode == "simple", mode)
    shot(page, "D2_epure_clair")
    page.get_by_test_id("pitch-style-robot").click(); page.wait_for_timeout(500)
    gs = geom(page)
    check("D · style Robot : notes droites sur la gamme", all(abs(n["m"] - round(n["m"])) < 1e-6 for n in gs))
    page.get_by_test_id("pitch-full").click(); page.wait_for_timeout(300)
    check("D · « Note par note… » passe à l'éditeur complet", page.get_by_test_id("pitch-editor").get_attribute("data-mode") == "full")
    shot(page, "D3_complet_clair")
    b.close()


def run():
    only = (sys.argv[1:] or ["A", "B", "C", "D"])
    with sync_playwright() as p:
        for name, fn in (("A", scenario_pc), ("B", scenario_tablet), ("C", scenario_phone), ("D", scenario_simple)):
            if name not in only:
                continue
            try:
                fn(p)
            except Exception as e:  # noqa
                import traceback
                tb = traceback.format_exc()
                check(f"{name} · scénario sans exception", False, [l for l in tb.splitlines() if 'nova_pitch.py' in l][-3:] + tb.splitlines()[-2:])
    (OUT / "qa_nova_pitch.json").write_text(json.dumps({"checks": CHECKS, "mesures": RES}, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    ko = [c for c in CHECKS if not c["ok"]]
    print(f"\n{len(CHECKS) - len(ko)}/{len(CHECKS)} vérifications OK")
    sys.exit(1 if ko else 0)


if __name__ == "__main__":
    run()
