"""Scénario V25 (groove, outils MIDI, fichiers .mid) dans un Chrome headless, avec captures.

PC :
  1. un vrai .mid d'Ableton glissé sur l'arrangement → pistes / clip au tempo du projet ;
  2. export du clip en .mid (menu du clip) puis relecture : mêmes notes, vélocités, durées ;
  3. piano roll : une note → Chop 1/16 → swing MPC 58 % (positions mesurées) → Appliquer le groove ;
  4. roll de hi-hats 1/32 sur une note (rampe de vélocité) ;
  5. capture : notes jouées au clavier de l'ordinateur, puis « Capturer » → clip créé.
Tablette et téléphone : menu ☰ (import / export .mid, swing, capture), import par le menu,
fenêtre Groove, menu Outils au doigt. Aucune erreur de page.

Usage : python qa/v25_midi.py [pc|tab|tel|tout]   (NOVA_URL=http://127.0.0.1:3433/)
"""
import base64, json, os, re, sys, time
from pathlib import Path
sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3433/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-v25")
from qalib import launch, new_page, shot, overflow_report, BASE, OUT, menu_open_for  # noqa: E402
from scenarios import close_welcome, wait_text_gone  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
MID = ROOT / "tests" / "fixtures" / "midi" / "ableton-piano.mid"
WHICH = sys.argv[1] if len(sys.argv) > 1 else "tout"
RES = {"etapes": {}, "mesures": {}}


def ok(k, v, note=None):
    RES["etapes"][k] = {"ok": bool(v), **({"detail": note} if note is not None else {})}
    print(("OK  " if v else "KO  ") + k, "" if note is None else json.dumps(note, ensure_ascii=False)[:400])


def tracks(pg):
    return pg.evaluate("() => window.__novaMidi ? window.__novaMidi.tracks() : []")


def open_studio(pg, vp):
    pg.goto(BASE, wait_until="domcontentloaded")
    pg.get_by_text("Mélodies", exact=False).first.click(timeout=40000)
    pg.wait_for_timeout(1500)
    pg.get_by_text("Neon Storm", exact=False).first.click()
    pg.wait_for_timeout(1500)
    close_welcome(pg)
    wait_text_gone(pg, "Chargement", 60)
    pg.wait_for_timeout(1500)
    close_welcome(pg)
    drums = pg.locator("[aria-labelledby='drums-title']")
    if drums.count():
        cl = drums.locator("button[aria-label^='Fermer'], button[title^='Fermer']")
        if cl.count(): cl.first.click()
        else: pg.keyboard.press("Escape")
        pg.wait_for_timeout(600)
    pg.wait_for_function("() => !!window.__novaMidi", timeout=20000)


PARSE_JS = """async (b64) => {
  const { parseMidi } = await import('/utils/midiFile.ts');
  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const d = parseMidi(bin);
  return { format: d.format, ppq: d.ppq, tempos: d.tempos.map(t => +t.bpm.toFixed(3)),
    notes: d.tracks.flatMap(t => t.notes).map(n => [n.pitch, n.velocity, +(n.startTick / d.ppq).toFixed(4), +(n.durationTicks / d.ppq).toFixed(4), n.channel]).sort((a, b) => a[2] - b[2] || a[0] - b[0]) };
}"""

DROP_JS = """async ({ b64, name, x, y }) => {
  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const file = new File([bin], name, { type: 'audio/midi' });
  const dt = new DataTransfer(); dt.items.add(file);
  const target = document.elementFromPoint(x, y);
  for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
  return target.className.slice(0, 60);
}"""


def canvas_box(pg):
    return pg.evaluate("""() => { const cs = document.querySelectorAll('.nova-grille canvas'); const c = cs[1] || cs[0]; const r = c.getBoundingClientRect();
      const sc = document.querySelector('.nova-grille .custom-scroll'); return { x: r.left, y: r.top, w: r.width, h: r.height, sl: sc ? sc.scrollLeft : 0, st: sc ? sc.scrollTop : 0, tt: +(c.dataset.tracksTop || 40) }; }""")


def find_clip_menu(pg, t, want="Exporter le clip en .mid"):
    """Clic droit sur les rangées de pistes jusqu'à trouver le menu du clip voulu."""
    box = canvas_box(pg)
    for row in range(0, 14):
        for yoff in (60, 30):
            y = box["y"] + box.get("tt", 40) + row * 120 + yoff - box["st"]
            if y > box["y"] + box["h"] - 5: return False
            pg.mouse.click(box["x"] + t * 40 - box["sl"], y, button="right"); pg.wait_for_timeout(250)
            menu_open_for(pg, want)  # sous-menu « MIDI »
            item = pg.get_by_role("button", name=re.compile(re.escape(want))).or_(pg.get_by_text(want, exact=False))
            if item.count() and item.first.is_visible():
                return True
            pg.keyboard.press("Escape"); pg.mouse.click(5, 5); pg.wait_for_timeout(150)
    return False


def clip_menu_on_track(pg, name, t):
    """Clic droit sur le clip de la piste `name` (hauteur lue sur son en-tête)."""
    head = pg.locator(".nova-grille").get_by_text(name, exact=True).first
    head.scroll_into_view_if_needed(); pg.wait_for_timeout(200)
    hb = head.bounding_box()
    box = canvas_box(pg)
    pg.mouse.click(box["x"] + t * 40 - box["sl"], hb["y"] + hb["height"] / 2 + 4, button="right"); pg.wait_for_timeout(300)
    menu_open_for(pg, "Exporter le clip en .mid")  # sous-menu « MIDI »
    item = pg.get_by_text("Exporter le clip en .mid", exact=False)
    return item.count() > 0 and item.first.is_visible()


def ui_scale(pg):
    return pg.evaluate("() => { const g = document.querySelector('[data-nova-pianoroll] .custom-scroll'); return g.getBoundingClientRect().width / g.clientWidth; }")


def draw_note(pg, pitch, start_s, dur_s, beat):
    """Dessine une note au crayon (clic + glisser), positions en secondes du clip."""
    pg.evaluate("""(p) => { const k = document.querySelector(`[data-nova-pianoroll] [data-pitch='${p}']`); const g = document.querySelector('[data-nova-pianoroll] .custom-scroll');
      g.scrollTop = Math.max(0, k.offsetTop - g.clientHeight / 2); g.scrollLeft = 0; g.dispatchEvent(new Event('scroll')); }""", pitch)
    pg.wait_for_timeout(250)
    sc = ui_scale(pg)
    kb = pg.locator(f"[data-nova-pianoroll] [data-pitch='{pitch}']").first.bounding_box()
    grid = pg.locator("[data-nova-pianoroll] .custom-scroll").first.bounding_box()
    yy = kb["y"] + kb["height"] / 2
    xa = grid["x"] + (start_s * 100 + 3) * sc
    # Le crayon pose une note d'un temps (grille) ; glisser l'allonge du reste.
    pg.mouse.move(xa, yy); pg.mouse.down()
    if dur_s > beat * 1.01: pg.mouse.move(xa + (dur_s - beat) * 100 * sc, yy, steps=8)
    pg.mouse.up()
    pg.wait_for_timeout(300)
    return yy, grid, sc


def scenario_pc(pg, errs):
    vp = "pc"
    open_studio(pg, vp)
    bpm = pg.evaluate("() => window.__novaMidi.bpm()")
    RES["mesures"]["bpm_projet"] = bpm
    shot(pg, f"v25_{vp}_00_studio")

    # --- 1. Glisser un .mid réel (Ableton, format 0, 96 ppq) sur l'arrangement ---
    b64 = base64.b64encode(MID.read_bytes()).decode()
    orig = pg.evaluate(PARSE_JS, b64)
    box = canvas_box(pg)
    drop_t = 4.0
    x = box["x"] + drop_t * 40 - box["sl"]
    y = box["y"] + box["h"] - 30
    before = tracks(pg)
    pg.evaluate(DROP_JS, {"b64": b64, "name": "Ableton piano.mid", "x": x, "y": y})
    pg.wait_for_timeout(600)
    dlg = pg.locator("[data-nova-midi-import]")
    asked = dlg.count() > 0
    if asked:
        shot(pg, f"v25_{vp}_01_import_tempo")
        pg.locator("[data-testid='midi-import-project']").click()
        pg.wait_for_timeout(700)
    after = tracks(pg)
    new_tracks = [t for t in after if t["id"] not in {x["id"] for x in before}]
    imported = new_tracks[0] if new_tracks else None
    n_notes = len(imported["clips"][0]["notes"]) if imported else 0
    clip = imported["clips"][0] if imported else None
    beat = 60 / bpm
    ok("import_glisser_mid", imported is not None and n_notes == len(orig["notes"]),
       {"dialogue_tempo": asked, "piste": imported and imported["name"], "notes": n_notes, "attendu": len(orig["notes"]), "debut_clip_s": clip and round(clip["start"], 4), "temps_du_depot": round(drop_t / beat, 2)})
    # Notes au tempo du projet : temps de la note = beat du fichier × (60 / bpm).
    if clip:
        mine = sorted([[n["p"], round(n["v"] * 127), round(n["s"] / beat, 4), round(n["d"] / beat, 4)] for n in clip["notes"]], key=lambda a: (a[2], a[0]))
        ref = [[a[0], a[1], a[2], a[3]] for a in orig["notes"]]
        diff = [(a, b) for a, b in zip(sorted(mine), sorted(ref)) if a[:2] != b[:2] or abs(a[2] - b[2]) > 2e-4 or abs(a[3] - b[3]) > 2e-4]
        ok("import_positions_en_temps", not diff and len(mine) == len(ref), {"premieres": sorted(mine)[:3], "differences": diff[:3]})
    shot(pg, f"v25_{vp}_02_mid_importe")

    # --- 2. Export du clip (menu du clip) puis relecture ---
    found = clip_menu_on_track(pg, imported["name"] if imported else "PIANO 6", (clip["start"] + 0.5) if clip else 5)
    shot(pg, f"v25_{vp}_03_menu_clip")
    ok("menu_clip_exporter", found)
    if found:
        with pg.expect_download(timeout=15000) as dl:
            pg.get_by_text("Exporter le clip en .mid", exact=False).first.click()
        path = OUT / "export_clip_v25.mid"
        dl.value.save_as(str(path))
        back = pg.evaluate(PARSE_JS, base64.b64encode(path.read_bytes()).decode())
        same = [a[:4] for a in back["notes"]] == [a[:4] for a in orig["notes"]]
        ok("export_relu_identique", same and abs(back["tempos"][0] - bpm) < 0.01,
           {"fichier": path.name, "octets": path.stat().st_size, "format": back["format"], "ppq": back["ppq"], "tempo": back["tempos"][:1], "notes": len(back["notes"])})
        RES["mesures"]["export_clip"] = {"notes": len(back["notes"]), "identiques": same}
    pg.wait_for_timeout(500)

    # --- 3. Piano roll : note → chop 1/16 → swing MPC 58 % ---
    pg.locator("button[title^='Nouvelle piste MIDI']").first.click()
    pg.wait_for_timeout(1200)
    pg.locator("[data-nova-pianoroll]").first.wait_for(timeout=10000)
    tid = pg.evaluate("() => { const t = window.__novaMidi.tracks(); return t.filter(x => /SYNTH/.test(x.name)).pop().id; }")
    # Une note d'une mesure sur la ligne Fa#3 (hi-hat) : clic + glisser.
    yy, grid, sc = draw_note(pg, 66, 0, 4 * beat, beat)
    RES["mesures"]["echelle_interface"] = round(sc, 3)
    t1 = next(t for t in tracks(pg) if t["id"] == tid)
    one = t1["clips"][0]["notes"]
    ok("note_dessinee", len(one) == 1 and abs(one[0]["d"] - 4 * beat) < beat * 0.3, one)
    # Outils → Chop 1/16
    pg.locator("[data-nova-roll='outils']").click(); pg.wait_for_timeout(300)
    shot(pg, f"v25_{vp}_04_menu_outils")
    pg.locator("[data-testid='tool-chop']").click(); pg.wait_for_timeout(200)
    pg.locator("[data-testid='opt-morceaux-1/16']").click(); pg.wait_for_timeout(300)
    prev = pg.locator("[data-nova-preview]").count()
    shot(pg, f"v25_{vp}_05_apercu_chop")
    pg.locator("[data-testid='tool-apply']").click(); pg.wait_for_timeout(400)
    hats = next(t for t in tracks(pg) if t["id"] == tid)["clips"][0]
    ok("chop_16e", len(hats["notes"]) == 16 and prev == 16, {"notes": len(hats["notes"]), "apercu": prev})
    # Ctrl+Z : une seule étape (on revient à la note d'origine), Ctrl+Y la remet.
    pg.wait_for_timeout(1300)  # hors de l'anti-rebond de l'historique
    pg.keyboard.press("Control+z"); pg.wait_for_timeout(500)
    undone = len(next(t for t in tracks(pg) if t["id"] == tid)["clips"][0]["notes"])
    pg.keyboard.press("Control+y"); pg.wait_for_timeout(500)
    redone = len(next(t for t in tracks(pg) if t["id"] == tid)["clips"][0]["notes"])
    ok("outil_une_etape_annulation", undone == 1 and redone == 16, {"apres_ctrl_z": undone, "apres_ctrl_y": redone})
    # Swing MPC 58 %
    pg.locator("[data-nova-roll='groove']").click(); pg.wait_for_timeout(400)
    pg.locator("[data-testid='groove-mpc58']").click(); pg.wait_for_timeout(400)
    shot(pg, f"v25_{vp}_06_groove_mpc58")
    c = next(t for t in tracks(pg) if t["id"] == tid)["clips"][0]
    st = c["start"]
    sixteenth = beat / 4
    devs = [round(((st + n["s"]) / sixteenth - round((st + n["s"]) / sixteenth - (0.16 if i % 2 else 0))) , 3) for i, n in enumerate(sorted(c["notes"], key=lambda n: n["s"]))]
    pos = sorted(n["s"] for n in c["notes"])
    offs_ms = [round((pos[i] - (pos[i - 1] + pos[i + 1]) / 2) * 1000, 2) for i in range(1, 15, 2)]
    expect_ms = round(0.16 * sixteenth * 1000, 2)
    ok("swing_mpc58_mesure", c["groove"] == "mpc58" and all(abs(o - expect_ms) < 0.05 for o in offs_ms),
       {"decalage_contretemps_ms": offs_ms[:4], "attendu_ms": expect_ms, "place_contretemps_pct": round(100 * (pos[1] - pos[0]) / (pos[2] - pos[0]), 2)})
    RES["mesures"]["swing"] = {"bpm": bpm, "double_croche_ms": round(sixteenth * 1000, 2), "decalages_ms": offs_ms, "place_contretemps_pct": round(100 * (pos[1] - pos[0]) / (pos[2] - pos[0]), 2)}
    # Swing 66 % au curseur, puis on revient à MPC 58 et on applique (commit)
    pg.locator("[data-testid='swing-pct']").fill("66"); pg.wait_for_timeout(300)
    c2 = next(t for t in tracks(pg) if t["id"] == tid)["clips"][0]
    p2 = sorted(n["s"] for n in c2["notes"])
    ok("swing_curseur_66", abs(100 * (p2[1] - p2[0]) / (p2[2] - p2[0]) - 66) < 0.1, round(100 * (p2[1] - p2[0]) / (p2[2] - p2[0]), 2))
    pg.locator("[data-testid='groove-mpc58']").click(); pg.wait_for_timeout(300)
    pg.locator("[data-testid='groove-commit']").click(); pg.wait_for_timeout(400)
    c3 = next(t for t in tracks(pg) if t["id"] == tid)["clips"][0]
    p3 = sorted(n["s"] for n in c3["notes"])
    ok("groove_applique_commit", c3["groove"] is None and abs(p3[1] - p3[0] - sixteenth * 1.16) < 1e-6, {"groove": c3["groove"]})

    # --- 4. Roll de hi-hats 1/32 sur la dernière note ---
    # Une noire de hi-hat au temps 5, sélectionnée à la flèche, puis l'outil Roll.
    draw_note(pg, 66, 4 * beat, beat, beat)
    c3b = next(t for t in tracks(pg) if t["id"] == tid)["clips"][0]
    last = max(c3b["notes"], key=lambda n: n["s"])
    pg.locator("[data-nova-pianoroll] button[title^='Flèche']").first.click(); pg.wait_for_timeout(150)
    sl = pg.evaluate("() => document.querySelector('[data-nova-pianoroll] .custom-scroll').scrollLeft")
    pg.mouse.click(grid["x"] + (last["s"] * 100 - sl + 10) * sc, yy); pg.wait_for_timeout(250)
    sel = pg.locator("[data-nova-pianoroll] .text-cyan-400").first.inner_text() if pg.locator("[data-nova-pianoroll] .text-cyan-400").count() else ""
    pg.locator("[data-nova-roll='outils']").click(); pg.wait_for_timeout(300)
    pg.locator("[data-testid='tool-roll']").click(); pg.wait_for_timeout(200)
    pg.locator("[data-testid='opt-vitesse-1/32']").click(); pg.wait_for_timeout(150)
    pg.locator("[data-testid='opt-rampe-up']").click(); pg.wait_for_timeout(300)
    shot(pg, f"v25_{vp}_07_apercu_roll")
    pg.locator("[data-testid='tool-apply']").click(); pg.wait_for_timeout(400)
    c4 = next(t for t in tracks(pg) if t["id"] == tid)["clips"][0]
    tail = sorted([n for n in c4["notes"] if n["s"] >= last["s"] - 1e-6], key=lambda n: n["s"])
    gaps = [round((tail[i + 1]["s"] - tail[i]["s"]) * 1000, 2) for i in range(len(tail) - 1)]
    vels = [round(n["v"], 2) for n in tail]
    ok("roll_hihats_32e", len(c4["notes"]) == 16 + 8 and "1 sélectionnée" in sel and all(abs(g - beat / 8 * 1000) < 0.05 for g in gaps) and vels == sorted(vels),
       {"selection": sel, "coups": len(tail), "ecarts_ms": gaps, "velocites": vels})
    RES["mesures"]["roll"] = {"coups": len(tail), "ecarts_ms": gaps, "velocites": vels, "trente_deuxieme_ms": round(beat / 8 * 1000, 2)}
    shot(pg, f"v25_{vp}_08_roll_applique")

    # --- 5. Capture : jouer au clavier de l'ordinateur sans enregistrer, puis « Capturer » ---
    pg.locator("[data-nova-roll='clavier']").click(); pg.wait_for_timeout(300)
    for code in ("KeyA", "KeyD", "KeyG", "KeyK"):
        pg.keyboard.down(code[-1].lower()); pg.wait_for_timeout(180); pg.keyboard.up(code[-1].lower()); pg.wait_for_timeout(140)
    badge = pg.evaluate("() => window.__novaMidi.captured()")
    shot(pg, f"v25_{vp}_09_capture_badge")
    nclips_before = len(next(t for t in tracks(pg) if t["id"] == tid)["clips"])
    pg.locator("[data-nova-roll='capturer']").click(); pg.wait_for_timeout(600)
    t5 = next(t for t in tracks(pg) if t["id"] == tid)
    capt = [cl for cl in t5["clips"] if cl["name"] == "Capture"]
    host_notes = [n for cl in t5["clips"] for n in cl["notes"] if n["p"] in (60, 64, 67, 72)]
    ok("capture_clavier", badge == 4 and (len(capt) == 1 or len(host_notes) >= 4) and pg.evaluate("() => window.__novaMidi.captured()") == 0,
       {"notes_en_memoire": badge, "clips_avant": nclips_before, "clips_apres": len(t5["clips"]), "hauteurs": sorted({n["p"] for n in host_notes})})
    shot(pg, f"v25_{vp}_10_capture_faite")
    # Raccourci Ctrl+Maj+C (comme Live) : trois notes de plus, puis le raccourci.
    for k in ("s", "f", "h"):
        pg.keyboard.down(k); pg.wait_for_timeout(150); pg.keyboard.up(k); pg.wait_for_timeout(120)
    n_before = sum(len(cl["notes"]) for cl in next(t for t in tracks(pg) if t["id"] == tid)["clips"])
    pg.locator("[data-nova-roll='clavier']").click(); pg.wait_for_timeout(200)  # le clavier musical coupé, les raccourcis reviennent
    pg.keyboard.press("Control+Shift+C"); pg.wait_for_timeout(500)
    n_after = sum(len(cl["notes"]) for cl in next(t for t in tracks(pg) if t["id"] == tid)["clips"])
    ok("capture_raccourci_ctrl_maj_c", n_after == n_before + 3, {"avant": n_before, "apres": n_after})
    pg.locator("[data-nova-roll='clavier']").click(); pg.wait_for_timeout(200)
    pg.locator("[data-nova-roll='clavier']").click(); pg.wait_for_timeout(200)
    pg.keyboard.press("Escape"); pg.wait_for_timeout(600)

    # --- 6. Menu MIDI de la barre de transport + export de toutes les pistes ---
    pg.locator("[data-nova-midi-menu]").first.click(); pg.wait_for_timeout(300)
    shot(pg, f"v25_{vp}_11_menu_midi")
    with pg.expect_download(timeout=15000) as dl2:
        pg.locator("[data-testid='midi-export-all']").click()
    p_all = OUT / "export_toutes_pistes_v25.mid"
    dl2.value.save_as(str(p_all))
    allb = pg.evaluate(PARSE_JS, base64.b64encode(p_all.read_bytes()).decode())
    ok("export_toutes_pistes_format1", allb["format"] == 1 and len(allb["notes"]) >= n_notes + 17, {"notes": len(allb["notes"]), "format": allb["format"]})
    # Menu de la piste et fenêtre d'export
    head = pg.locator(".nova-grille").get_by_text("PIANO 6", exact=True).first
    head.click(button="right"); pg.wait_for_timeout(400)
    tr_item = pg.get_by_text("Exporter la piste en .mid", exact=False)
    shot(pg, f"v25_{vp}_12_menu_piste")
    ok("menu_piste_exporter_mid", tr_item.count() > 0 and tr_item.first.is_visible())
    pg.keyboard.press("Escape"); pg.mouse.click(5, 450); pg.wait_for_timeout(300)
    pg.locator("button[aria-label='Exporter le mix']").first.click(); pg.wait_for_timeout(900)
    row = pg.locator("[data-testid='export-midi']")
    if row.count(): row.first.scroll_into_view_if_needed()
    shot(pg, f"v25_{vp}_13_fenetre_export")
    ok("fenetre_export_ligne_mid", row.count() == 1, row.count() and row.first.inner_text().replace(chr(10), " · "))
    pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    shot(pg, f"v25_{vp}_14_fin")
    ov = overflow_report(pg)
    ok("pas_de_debordement_pc", not [o for o in ov if o["kind"] == "page-hscroll"], ov[:3])


def scenario_mobile(pg, errs, vp):
    open_studio(pg, vp)
    # Menu ☰ : entrées MIDI
    burger = pg.locator("button[aria-label*='menu' i], button[title*='menu' i]").first
    burger.click(); pg.wait_for_timeout(500)
    item = pg.locator("[data-testid='m-midi-import']")
    item.first.scroll_into_view_if_needed(); pg.wait_for_timeout(200)
    shot(pg, f"v25_{vp}_01_menu")
    ok(f"{vp}_menu_midi", item.count() > 0 and pg.locator("[data-testid='m-midi-capture']").count() > 0)
    with pg.expect_file_chooser(timeout=8000) as fc:
        item.first.click()
    fc.value.set_files(str(MID))
    pg.wait_for_timeout(700)
    if pg.locator("[data-nova-midi-import]").count():
        shot(pg, f"v25_{vp}_02_import_tempo")
        pg.locator("[data-testid='midi-import-project']").click(); pg.wait_for_timeout(700)
    imp = [t for t in tracks(pg) if t["name"].startswith("PIANO")]
    ok(f"{vp}_import_menu", len(imp) == 1 and len(imp[0]["clips"][0]["notes"]) > 50, imp and len(imp[0]["clips"][0]["notes"]))
    shot(pg, f"v25_{vp}_03_importe")
    # Swing par le menu ☰
    burger.click(); pg.wait_for_timeout(400)
    pg.locator("[data-testid='m-midi-swing']").first.click(); pg.wait_for_timeout(600)
    panel = pg.locator("[data-nova-groove]")
    ok(f"{vp}_fenetre_swing", panel.count() == 1)
    pg.locator("[data-testid='groove-mpc62']").click(); pg.wait_for_timeout(400)
    shot(pg, f"v25_{vp}_04_swing")
    g = [cl["groove"] for t in tracks(pg) if t["name"].startswith("PIANO") for cl in t["clips"]]
    ok(f"{vp}_swing_pose", "mpc62" in g, g)
    pg.locator("[data-nova-groove] button[aria-label='Fermer']").click(); pg.wait_for_timeout(300)
    # Export par le menu ☰
    burger.click(); pg.wait_for_timeout(400)
    with pg.expect_download(timeout=15000) as dl:
        pg.locator("[data-testid='m-midi-export']").first.click()
    p = OUT / f"export_{vp}_v25.mid"
    dl.value.save_as(str(p))
    ok(f"{vp}_export_menu", p.stat().st_size > 100, p.stat().st_size)
    # Capture sans rien jouer : message clair
    burger.click(); pg.wait_for_timeout(400)
    pg.locator("[data-testid='m-midi-capture']").first.click(); pg.wait_for_timeout(600)
    shot(pg, f"v25_{vp}_05_capture_vide")
    if vp == "tab":
        # Piano roll au doigt : menu Outils
        pg.evaluate("""async () => {}""")
        midi = [t for t in tracks(pg) if t["name"].startswith("PIANO")][0]
        pg.evaluate("""async (id) => { const { midiBus } = await import('/utils/midiBus.ts'); }""", midi["id"])
        btn = pg.locator("button[title^='Nouvelle piste MIDI']")
        if btn.count():
            btn.first.click(); pg.wait_for_timeout(1200)
            if pg.locator("[data-nova-roll='outils']").count():
                pg.locator("[data-nova-roll='outils']").first.tap(); pg.wait_for_timeout(400)
                shot(pg, f"v25_{vp}_06_outils_doigt")
                ok("tab_menu_outils_doigt", pg.locator("[data-testid='tool-roll']").count() == 1)
    ov = overflow_report(pg)
    ok(f"{vp}_pas_de_debordement", not [o for o in ov if o["kind"] == "page-hscroll"], ov[:3])


with sync_playwright() as p:
    b = launch(p)
    for vp in (["pc", "tab", "tel"] if WHICH == "tout" else [WHICH]):
        ctx, pg = new_page(b, vp)
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)[:300]))
        pg.on("console", lambda m: errs.append("console: " + m.text[:300]) if m.type == "error" else None)
        t0 = time.time()
        try:
            if vp == "pc": scenario_pc(pg, errs)
            else: scenario_mobile(pg, errs, vp)
        except Exception as e:  # noqa
            ok(f"{vp}_exception", False, f"{type(e).__name__}: {str(e)[:500]}")
            try: shot(pg, f"v25_{vp}__ECHEC")
            except Exception: pass
        page_errs = [e for e in errs if not e.startswith("console: ") or not re.search(r"Failed to load resource|net::|supabase|favicon|404|401|403|blocked", e, re.I)]
        ok(f"{vp}_aucune_erreur_de_page", not [e for e in errs if not e.startswith("console: ")], errs[:6])
        RES.setdefault("erreurs", {})[vp] = errs[:20]
        RES.setdefault("duree_s", {})[vp] = round(time.time() - t0, 1)
        ctx.close()
    b.close()

(OUT / f"resultat_v25_{WHICH}.json").write_text(json.dumps(RES, ensure_ascii=False, indent=1), encoding="utf-8")
bad = [k for k, v in RES["etapes"].items() if not v["ok"]]
print("\nKO :", bad if bad else "aucun")
