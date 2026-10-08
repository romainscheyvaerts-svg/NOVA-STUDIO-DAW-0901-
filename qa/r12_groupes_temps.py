"""R12 · Groupes d'édition et temps : preuves dans un navigateur headless (aucune fenêtre).

  pc    : groupe VOX (LEAD + DOUBLE + BACKS) créé dans la liste des groupes ; clic au Grabber
          = les 3 clips ; Ctrl+E à la tête de lecture = coupés ensemble (mesuré) ; nudge groupé
          (mesuré, même décalage partout) ; Maj+Ctrl = la piste seule ; plage coupée sur le
          groupe ; muet lié (groupe de mix) ; insertion de 4 temps au milieu par la fenêtre
          Temps : repères, accords, tempo et automation décalés EXACTEMENT ; Refrain dupliqué
          en le glissant depuis la piste Arrangement (Alt) ; export du refrain d'origine et
          de la copie par la fenêtre Exporter : null test ; captures (sombre).
  clair : captures en thème clair.
  tab   : tablette au doigt : section glissée au doigt (mode « Copier »), captures.
  tel   : téléphone : groupes en lecture seule, fenêtre Temps, captures.

Usage : serveur `npx vite --port 3461 --strictPort` dans le worktree, puis
  NOVA_URL=http://127.0.0.1:3461/ python qa/r12_groupes_temps.py [pc] [clair] [tab] [tel]
Sorties : D:\\1 WORK\\CONTENU\\nova-r12\\
"""
import io, json, os, re, sys, time, wave, zipfile
from pathlib import Path

import numpy as np

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3461/")
os.environ["QA_OUT"] = r"D:\1 WORK\CONTENU\nova-r12"
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa
from qalib import OUT, Log, new_page, shot, save_log  # noqa
import protools_edition as pe  # noqa
from playwright.sync_api import sync_playwright

SR = 48000
DUR = 16.0
ZOOM = 40
res = {"etapes": {}, "mesures": {}}


def ok(k, v, note=None):
    res["etapes"][k] = {"ok": bool(v), **({"detail": note} if note is not None else {})}
    print(("OK  " if v else "KO  ") + k, "" if note is None else json.dumps(note, ensure_ascii=False)[:600])


def wav_bytes(x):
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return b.getvalue()


def audio():
    n = int(DUR * SR)
    t = np.arange(n) / SR
    beat = np.zeros(n)
    for k in range(int(DUR * 2)):
        i0 = int(k * 0.5 * SR); m = min(n - i0, int(0.25 * SR)); tt = np.arange(m) / SR
        beat[i0:i0 + m] += 0.5 * np.sin(2 * np.pi * (55 + 70 * np.exp(-tt * 30)) * tt) * np.exp(-tt * 9)
    beat += 0.08 * np.sin(2 * np.pi * 82.4 * t)
    lead = 0.22 * np.sin(2 * np.pi * 220 * t + 2 * np.sin(2 * np.pi * 5 * t)) * (0.7 + 0.3 * np.sin(2 * np.pi * 0.7 * t))
    dbl = 0.15 * np.sin(2 * np.pi * 221.5 * t + 0.4) * (0.7 + 0.3 * np.sin(2 * np.pi * 0.9 * t))
    backs = 0.12 * np.sin(2 * np.pi * 329.6 * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 1.3 * t))
    return {"audio/beat.wav": wav_bytes(beat), "audio/lead.wav": wav_bytes(lead), "audio/dbl.wav": wav_bytes(dbl), "audio/backs.wav": wav_bytes(backs)}


def project():
    f = OUT / "r12_projet.zip"
    lane = {"id": "lane-lead-vol", "parameterName": "volume", "color": "#22d3ee", "isExpanded": False, "min": 0, "max": 1.5,
            "points": [{"id": "a0", "time": 0, "value": 0.8}, {"id": "a1", "time": 8, "value": 0.5}, {"id": "a2", "time": 10, "value": 1.0}, {"id": "a3", "time": 12, "value": 0.6}]}
    tracks = [
        pe.track("beat", "BEAT", [pe.clip("c-beat", "Beat", 0, DUR, "audio/beat.wav")], color="#eab308"),
        pe.track("lead", "LEAD", [pe.clip("c-lead", "Lead", 2, 12, "audio/lead.wav", offset=2)], automationLanes=[lane], color="#ef4444"),
        pe.track("dbl", "DOUBLE", [pe.clip("c-dbl", "Double", 2, 12, "audio/dbl.wav", offset=2)], color="#f97316"),
        pe.track("backs", "BACKS", [pe.clip("c-backs", "Backs", 4, 8, "audio/backs.wav", offset=4)], color="#a855f7"),
        pe.track("master", "MASTER", [], type="BUS", outputTrackId=""),
    ]
    pe.make_project(f, tracks, audio(), name="R12 Groupes et temps")
    z = zipfile.ZipFile(f)
    st = json.loads(z.read("project.json"))
    files = {k: z.read(k) for k in z.namelist() if k != "project.json"}
    z.close()
    st["markers"] = [
        {"id": "m-intro", "name": "Intro", "time": 0, "type": "MARKER", "color": "#64748b", "number": 1},
        {"id": "m-couplet", "name": "Couplet", "time": 2, "type": "MARKER", "color": "#22d3ee", "number": 2},
        {"id": "m-refrain", "name": "Refrain", "time": 8, "type": "MARKER", "color": "#f59e0b", "number": 3},
        {"id": "m-outro", "name": "Outro", "time": 12, "type": "MARKER", "color": "#a855f7", "number": 4},
    ]
    st["chords"] = [
        {"id": "k1", "start": 0, "end": 4, "root": 9, "quality": "min"},
        {"id": "k2", "start": 4, "end": 8, "root": 5, "quality": "maj"},
        {"id": "k3", "start": 8, "end": 12, "root": 0, "quality": "maj"},
        {"id": "k4", "start": 12, "end": 16, "root": 7, "quality": "maj"},
    ]
    st["tempoEvents"] = [{"id": "tp-7", "bar": 6, "bpm": 100}]
    with zipfile.ZipFile(f, "w") as z:
        z.writestr("project.json", json.dumps(st))
        for k, v in files.items():
            z.writestr(k, v)
    return f


def mod(page, path, expr):
    return page.evaluate(f"async () => {{ const m = await window.__novaAppModule('{path}'); return ({expr})(m); }}")


def st(page, expr):
    return pe.st(page, expr)


def box(page):
    # Le calque de l'arrangement (celui qui porte data-tracks-top) ; les vumètres R11 sont aussi des canvas.
    return page.evaluate("""() => { const c = document.querySelector('.nova-grille canvas[data-tracks-top]'); const r = c.getBoundingClientRect();
      const sc = document.querySelector('.nova-grille .custom-scroll'); return { x: r.left, y: r.top, w: r.width, h: r.height, sl: sc ? sc.scrollLeft : 0, st: sc ? sc.scrollTop : 0, tt: +(c.dataset.tracksTop || 40) }; }""")


def x_of(b, t):
    return b["x"] + t * ZOOM - b["sl"]


def lane_top(b, idx, zoomv=120):
    return b["y"] + b["tt"] + idx * zoomv - b["st"]


def clips(page, tid):
    return pe.clips_of(page, tid)


def close_overlays(page):
    for _ in range(2):
        page.keyboard.press("Escape"); page.wait_for_timeout(120)


def click(page, x, y, mods=()):
    for m in mods: page.keyboard.down(m)
    page.mouse.move(x, y); page.mouse.down(); page.mouse.up()
    for m in mods: page.keyboard.up(m)
    page.wait_for_timeout(250)


def drag(page, x0, y0, x1, y1, steps=14, mods=()):
    for m in mods: page.keyboard.down(m)
    page.mouse.move(x0, y0); page.mouse.down()
    for i in range(1, steps + 1):
        page.mouse.move(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps); page.wait_for_timeout(20)
    page.mouse.up()
    for m in mods: page.keyboard.up(m)
    page.wait_for_timeout(300)


def close_groups(page):
    page.get_by_test_id("groups-panel").get_by_role("button", name="Fermer").click(); page.wait_for_timeout(250)


def set_playhead(page, t):
    mod(page, "/utils/playheadStore.ts", f"m => m.playheadStore.set({t})")


def sel_clip_ids(page):
    return mod(page, "/utils/editSelection.ts", "m => m.editSelectionStore.get().clipIds")


def open_r12(page, label, theme="dark"):
    page.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); localStorage.setItem('nova_simple_mode', '0'); localStorage.setItem('nova_arrange_lane', '1'); }} catch (e) {{}}")
    pe.open_project(page, project(), label)
    close_overlays(page)


def snapshot(page):
    return st(page, """s => ({
      markers: s.markers.map(m => [m.name, +m.time.toFixed(6)]).sort((a, b) => a[1] - b[1]),
      chords: (s.chords || []).map(c => [c.root, +c.start.toFixed(6), +c.end.toFixed(6)]).sort((a, b) => a[1] - b[1]),
      tempo: (s.tempoEvents || []).map(e => [e.bar, e.bpm ?? null, e.numerator ?? null]),
      bpm: s.bpm, ts: s.timeSignature,
      auto: s.tracks.find(t => t.id === 'lead').automationLanes[0].points.map(p => [+p.time.toFixed(6), +p.value.toFixed(6)]).sort((a, b) => a[0] - b[0]),
      clips: Object.fromEntries(s.tracks.filter(t => t.id !== 'master').map(t => [t.id, t.clips.map(c => [+c.start.toFixed(6), +(c.start + c.duration).toFixed(6), +(c.offset || 0).toFixed(6)]).sort((a, b) => a[0] - b[0])])),
    })""")


def bar_time(page, bar):
    return page.evaluate(f"""async () => {{ const T = await window.__novaAppModule('/utils/tempoMap.ts'); const s = window.__novaEdit.getState();
      return T.barToTime(T.buildTempoMap(s.bpm, s.timeSignature, s.tempoEvents), {bar}); }}""")


def automation_value(page, t):
    return page.evaluate(f"""async () => {{ const A = await window.__novaAppModule('/utils/automationWrite.ts'); const s = window.__novaEdit.getState();
      const pts = A.sortedPoints(s.tracks.find(x => x.id === 'lead').automationLanes[0].points); return A.valueAtPoints(pts, {t}, 0); }}""")


# ------------------------------------------------------------------------ export (fenêtre Exporter)

def open_export(page):
    if page.locator("[data-export-vue=avancee]").count() == 0:
        b = page.get_by_role("button", name="Exporter le mix").locator("visible=true")
        if b.count() == 0:
            page.keyboard.press("Control+Shift+E"); page.wait_for_timeout(1200)
        else:
            b.first.click(); page.wait_for_timeout(1200)
        if page.locator("[data-export-vue=avancee]").count() == 0:
            page.get_by_role("button", name=re.compile("Réglages avancés")).click(); page.wait_for_timeout(400)
    page.locator("[data-export-vue=avancee]").wait_for(timeout=10000)


def esel(page, label, value):
    page.locator(f'[data-export-vue=avancee] label:has(> span:text-is("{label}")) select').first.select_option(str(value))


def export_between(page, tag, a_id, b_id):
    open_export(page)
    page.get_by_test_id("export-source-MASTER").click()
    esel(page, "Type de fichier", "WAV")
    esel(page, "Fréquence d'échantillonnage", 48000)
    esel(page, "Résolution", "32")
    esel(page, "Canaux", "stereo")
    esel(page, "Durée", "MARKERS")
    page.locator('select[aria-label="Repère de début"]').select_option(a_id)
    page.locator('select[aria-label="Repère de fin"]').select_option(b_id)
    esel(page, "Queue (réverbe après la fin)", "cut")
    try: esel(page, "Volume", "off")
    except Exception: pass
    with page.expect_download(timeout=180000) as dl:
        page.get_by_test_id("export-go").click()
    d = dl.value
    path = OUT / f"{tag}.wav"
    d.save_as(str(path))
    page.wait_for_timeout(1200)
    close_overlays(page)
    return path


def read_wav(path):
    import soundfile as sf
    x, sr = sf.read(str(path), dtype="float64", always_2d=True)
    return x, sr


# ------------------------------------------------------------------------ scénarios

def scenario_pc(page, res_, theme="dark"):
    open_r12(page, "pc_00_projet", theme)
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)[:300]))
    b = box(page)
    res["mesures"]["tracksTop"] = b["tt"]

    # 1. Groupe VOX créé dans la liste des groupes (Pro Tools : Groups List).
    page.get_by_test_id("dock-groups").click(); page.wait_for_timeout(400)
    shot(page, "pc_01_liste_groupes_vide")
    page.get_by_test_id("group-new").click(); page.wait_for_timeout(400)
    page.get_by_test_id("group-name-input").fill("VOX"); page.keyboard.press("Enter"); page.wait_for_timeout(200)
    for tid in ("lead", "dbl", "backs"):
        cb = page.get_by_test_id(f"group-member-{tid}")
        if not cb.is_checked(): cb.click(); page.wait_for_timeout(120)
    # La piste sélectionnée (BEAT) entre d'office dans le nouveau groupe : on la décoche.
    if page.get_by_test_id("group-member-beat").is_checked(): page.get_by_test_id("group-member-beat").click(); page.wait_for_timeout(120)
    shot(page, "pc_02_groupe_vox_reglages")
    g = st(page, "s => s.trackGroups.map(g => ({ name: g.name, kind: g.kind, ids: g.trackIds, active: g.isActive !== false }))")
    ok("groupe VOX créé (édition et mix, 3 pistes)", len(g) == 1 and g[0]["name"] == "VOX" and sorted(g[0]["ids"]) == ["backs", "dbl", "lead"] and g[0]["kind"] == "both", g)
    page.get_by_role("button", name="OK", exact=True).click(); page.wait_for_timeout(200)
    shot(page, "pc_03_liste_groupes")
    close_groups(page)
    b = box(page)

    # 2. Clic au Grabber (moitié basse) sur la LEAD : les 3 clips du groupe.
    click(page, x_of(b, 5), lane_top(b, 1) + 95)
    ids = sel_clip_ids(page)
    ok("clic sur la LEAD : les clips jumeaux du groupe sélectionnés", sorted(ids) == ["c-backs", "c-dbl", "c-lead"], ids)
    shot(page, "pc_04_clic_groupe")

    # 3. Coupe groupée : Ctrl+E à 7,000 s.
    set_playhead(page, 7.0)
    page.keyboard.press("Control+e"); page.wait_for_timeout(500)
    cuts = {tid: clips(page, tid) for tid in ("lead", "dbl", "backs", "beat")}
    split_ok = all(any(abs(c["end"] - 7.0) < 1e-9 for c in cuts[tid]) and any(abs(c["start"] - 7.0) < 1e-9 for c in cuts[tid]) for tid in ("lead", "dbl", "backs"))
    ok("Ctrl+E : LEAD, DOUBLE et BACKS coupés ensemble à 7,000 s (BEAT intact)", split_ok and len(cuts["beat"]) == 1,
       {k: [(c["start"], c["end"]) for c in v] for k, v in cuts.items()})
    res["mesures"]["coupe"] = {k: [(c["start"], c["end"]) for c in v] for k, v in cuts.items()}
    shot(page, "pc_05_coupe_groupee")

    # 4. Nudge groupé : clic sur la 2e moitié de la LEAD (9 s) puis → (un pas de grille).
    click(page, x_of(b, 9), lane_top(b, 1) + 95)
    ids = sel_clip_ids(page)
    before = {tid: [c for c in clips(page, tid) if c["start"] >= 7 - 1e-9][0]["start"] for tid in ("lead", "dbl", "backs")}
    page.keyboard.press("ArrowRight"); page.wait_for_timeout(500)
    after = {tid: [c for c in clips(page, tid) if c["start"] >= 7 - 1e-9][0]["start"] for tid in ("lead", "dbl", "backs")}
    deltas = {tid: round(after[tid] - before[tid], 9) for tid in before}
    step = mod(page, "/hooks/useEditCommands.ts", "m => m.getEditCommands().nudgeStepSeconds()")
    ok("nudge groupé : les 3 clips décalés du même pas (à l'échantillon)", len(ids) == 3 and len(set(deltas.values())) == 1 and abs(list(deltas.values())[0] - step) < 1e-9,
       {"selection": ids, "decalages_s": deltas, "pas_s": step})
    res["mesures"]["nudge"] = {"decalages_s": deltas, "pas_s": step}
    shot(page, "pc_06_nudge_groupe")
    page.keyboard.press("Control+z"); page.wait_for_timeout(600)
    back = {tid: [c for c in clips(page, tid) if c["start"] >= 7 - 1e-9][0]["start"] for tid in ("lead", "dbl", "backs")}
    ok("Ctrl+Z : le nudge groupé revient en une étape", back == before, back)

    # 5. Maj+Ctrl : le groupe s'inverse pour ce geste (la LEAD seule).
    click(page, x_of(b, 9), lane_top(b, 1) + 95, mods=("Shift", "Control"))
    ids = sel_clip_ids(page)
    page.keyboard.press("ArrowRight"); page.wait_for_timeout(500)
    after = {tid: [c for c in clips(page, tid) if c["start"] >= 7 - 1e-9][0]["start"] for tid in ("lead", "dbl", "backs")}
    ok("Maj+Ctrl + clic : la LEAD seule (DOUBLE et BACKS ne bougent pas)", len(ids) == 1 and after["lead"] != before["lead"] and after["dbl"] == before["dbl"] and after["backs"] == before["backs"],
       {"selection": ids, "debuts": after})
    page.keyboard.press("Control+z"); page.wait_for_timeout(600)

    # 5 bis. Rognage et fondu groupés : la fin de la LEAD (14 s) tirée d'une seconde vers la gauche,
    # puis un fondu d'entrée tiré dans le coin haut de la LEAD (7 s) : DOUBLE et BACKS suivent.
    close_overlays(page)
    ends0 = {tid: max(c["end"] for c in clips(page, tid)) for tid in ("lead", "dbl", "backs")}
    drag(page, x_of(b, 14.0) - 3, lane_top(b, 1) + 60, x_of(b, 13.0) - 3, lane_top(b, 1) + 60)
    ends1 = {tid: max(c["end"] for c in clips(page, tid)) for tid in ("lead", "dbl", "backs")}
    dtrim = {tid: round(ends1[tid] - ends0[tid], 9) for tid in ends0}
    ok("rognage groupé : la fin des 3 clips recule du même pas", len(set(dtrim.values())) == 1 and abs(dtrim["lead"] + 1.0) < 1e-6, {"avant": ends0, "apres": ends1})
    shot(page, "pc_06b_rognage_groupe")
    page.keyboard.press("Control+z"); page.wait_for_timeout(600)
    drag(page, x_of(b, 7.0) + 4, lane_top(b, 1) + 10, x_of(b, 7.5) + 4, lane_top(b, 1) + 10)
    fades = {tid: [c for c in clips(page, tid) if abs(c["start"] - 7.0) < 1e-6][0]["fadeIn"] for tid in ("lead", "dbl", "backs")}
    ok("fondu d'entrée groupé : même longueur sur les 3 clips", len(set(fades.values())) == 1 and 0.3 < fades["lead"] < 0.7, fades)
    res["mesures"]["rognage_fondu"] = {"rognage_s": dtrim, "fondus_s": fades}
    shot(page, "pc_06c_fondu_groupe")
    page.keyboard.press("Control+z"); page.wait_for_timeout(600)

    # 6. Plage (moitié haute) sur la LEAD : elle couvre le groupe ; Ctrl+X la coupe partout.
    close_overlays(page)
    drag(page, x_of(b, 3.0), lane_top(b, 1) + 25, x_of(b, 4.0), lane_top(b, 1) + 25)
    sel = mod(page, "/utils/editSelection.ts", "m => m.editSelectionStore.get().time")
    ok("plage tirée sur la LEAD : sélection étendue au groupe", sel and sorted(sel["trackIds"]) == ["backs", "dbl", "lead"], sel)
    shot(page, "pc_07_plage_groupe")
    page.keyboard.press("Control+x"); page.wait_for_timeout(500)
    gap = {tid: [(c["start"], c["end"]) for c in clips(page, tid)] for tid in ("lead", "dbl")}
    hole = all(not any(c[0] < 4.0 - 1e-6 and c[1] > 3.0 + 1e-6 for c in v) for v in gap.values())
    ok("Ctrl+X : la plage 3–4 s coupée sur LEAD et DOUBLE ensemble", hole, gap)
    page.keyboard.press("Control+z"); page.wait_for_timeout(600)
    mod(page, "/utils/editSelection.ts", "m => m.editSelectionStore.set({ time: null, clipIds: [] })")

    # 7. Groupe de mix : muet sur la LEAD = DOUBLE et BACKS muets.
    page.get_by_role("button", name="Muet : LEAD").first.click(); page.wait_for_timeout(400)
    mutes = st(page, "s => Object.fromEntries(s.tracks.map(t => [t.id, !!t.isMuted]))")
    ok("muet lié par le groupe (mix)", mutes["lead"] and mutes["dbl"] and mutes["backs"] and not mutes["beat"], mutes)
    shot(page, "pc_08_muet_lie")
    page.get_by_role("button", name="Muet : LEAD").first.click(); page.wait_for_timeout(400)
    mutes = st(page, "s => Object.fromEntries(s.tracks.map(t => [t.id, !!t.isMuted]))")
    ok("muet retiré sur tout le groupe", not any(mutes.values()), mutes)

    # 8. Insérer 4 temps au milieu (mesure 4, à 6 s) par la fenêtre Temps.
    s0 = snapshot(page)
    t_bar6_before = bar_time(page, 6)
    a_before = {t: automation_value(page, t) for t in (5.0, 6.0, 7.0, 8.0, 9.0, 11.0, 13.0)}
    set_playhead(page, 0)
    page.get_by_test_id("dock-time").click(); page.wait_for_timeout(500)
    page.get_by_test_id("timeops-bar").fill("4"); page.get_by_test_id("timeops-beat").fill("1")
    page.get_by_test_id("timeops-len-bars").fill("0"); page.get_by_test_id("timeops-len-beats").fill("4")
    page.wait_for_timeout(200)
    shot(page, "pc_09_fenetre_temps")
    prev = page.get_by_test_id("timeops-preview").inner_text()
    page.get_by_test_id("timeops-go").click(); page.wait_for_timeout(800)
    s1 = snapshot(page)
    L = 2.0
    mk_ok = s1["markers"] == [[n, t + (L if t >= 6 else 0)] for n, t in s0["markers"]]
    ch_exp = []
    for r, a, e in s0["chords"]:
        if a >= 6: ch_exp.append([r, a + L, e + L])
        elif e > 6: ch_exp += [[r, a, 6.0], [r, 6.0 + L, e + L]]
        else: ch_exp.append([r, a, e])
    ch_ok = s1["chords"] == sorted(ch_exp, key=lambda c: c[1])
    t_bar7_after = bar_time(page, 7)
    tempo_ok = s1["tempo"] == [[7, 100, None]] and abs(t_bar7_after - (t_bar6_before + L)) < 1e-12
    a_after = {t: automation_value(page, t + (L if t >= 6 else 0)) for t in a_before}
    flat = [automation_value(page, t) for t in (6.0, 6.5, 7.5, 7.999)]
    auto_ok = all(abs(a_after[t] - a_before[t]) < 1e-9 for t in a_before) and max(flat) - min(flat) < 1e-9 and abs(flat[0] - a_before[6.0]) < 1e-9
    res["mesures"]["insertion_4_temps"] = {"apercu": prev, "avant": s0, "apres": s1, "mesure7_avant_s": t_bar6_before, "mesure8_apres_s": t_bar7_after,
                                          "automation_avant": a_before, "automation_apres_decalee": a_after, "automation_plate_dans_le_blanc": flat}
    ok("4 temps insérés à 6 s : repères décalés de 2,000 s exactement", mk_ok, s1["markers"])
    ok("accords décalés (celui coupé par l'insertion : en deux)", ch_ok, s1["chords"])
    ok("tempo : le changement à 100 BPM passe de la mesure 7 à 8, 2,000 s plus tard (à 1e-12 près)", tempo_ok, {"tempo": s1["tempo"], "avant": t_bar6_before, "apres": t_bar7_after})
    ok("automation décalée à l'identique, plate pendant le blanc", auto_ok, {"apres": a_after, "blanc": flat})
    clip_ok = all(any(abs(c[0] - 8.0) < 1e-9 for c in s1["clips"][tid]) for tid in ("beat", "lead", "dbl", "backs"))
    ok("clips coupés à 6 s, la suite recule de 2 s", clip_ok, s1["clips"])
    shot(page, "pc_10_temps_insere")

    # 9. Refrain (désormais 10–14 s) dupliqué depuis la piste Arrangement (Alt + glisser à sa fin).
    sec = page.get_by_test_id("arrange-section-m-refrain")
    bb = sec.bounding_box()
    y = bb["y"] + bb["height"] / 2
    x0 = bb["x"] + 20
    page.keyboard.down("Alt")
    page.mouse.move(x0, y); page.mouse.down()
    for i in range(1, 15):
        page.mouse.move(x0 + 4 * ZOOM * i / 14, y); page.wait_for_timeout(25)
    shot(page, "pc_11_section_glissee")
    tip = page.get_by_test_id("arrange-drop-tip").inner_text() if page.get_by_test_id("arrange-drop-tip").count() else ""
    page.mouse.up(); page.keyboard.up("Alt"); page.wait_for_timeout(900)
    s2 = snapshot(page)
    names = [m for m in s2["markers"]]
    ok("Refrain dupliqué depuis la règle : Refrain à 10 et 14 s, Outro à 18 s", names == [["Intro", 0], ["Couplet", 2], ["Refrain", 10], ["Refrain", 14], ["Outro", 18]], {"reperes": names, "bulle": tip})
    ok("tempo : le changement suit (mesure 10, après les 2 mesures ajoutées)", s2["tempo"] == [[9, 100, None]], s2["tempo"])
    shot(page, "pc_12_section_dupliquee")
    ids2 = st(page, "s => s.markers.slice().sort((a, b) => a.time - b.time).map(m => m.id)")

    # 10. Null test : export du refrain d'origine (10–14) et de la copie (14–18) par la fenêtre Exporter.
    pa = export_between(page, "r12_refrain_origine", ids2[2], ids2[3])
    pb = export_between(page, "r12_refrain_copie", ids2[3], ids2[4])
    xa, sra = read_wav(pa); xb, srb = read_wav(pb)
    n = min(len(xa), len(xb))
    d = xa[:n] - xb[:n]
    peak = float(np.max(np.abs(xa[:n])))
    rms_sig = float(np.sqrt(np.mean(xa[:n] ** 2)))
    rms_d = float(np.sqrt(np.mean(d ** 2))) if n else 1.0
    null_db = 20 * np.log10(max(rms_d, 1e-12) / max(rms_sig, 1e-12))
    # Sans les 2 premières millisecondes (rampe d'automation de 0,1 ms aux bords de la copie).
    guard = int(0.002 * sra)
    dmax_in = float(np.max(np.abs(d[guard:n - guard]))) if n > 2 * guard else 1.0
    res["mesures"]["null_test"] = {"fichiers": [pa.name, pb.name], "echantillons": [len(xa), len(xb)], "sr": [sra, srb], "crete": peak,
                                   "rms_signal": rms_sig, "rms_difference": rms_d, "null_db": round(float(null_db), 1), "ecart_max_hors_2ms_bords": dmax_in,
                                   "ecart_max_total": float(np.max(np.abs(d))) if n else None}
    ok("null test : export du refrain copié = refrain d'origine", len(xa) == len(xb) and len(xa) > 0.9 * 4 * sra and null_db < -90 and peak > 0.05,
       res["mesures"]["null_test"])
    page.keyboard.press("Control+z"); page.wait_for_timeout(600)
    s3 = snapshot(page)
    ok("Ctrl+Z : la section dupliquée s'annule en une étape", s3 == s1, {"apres_annulation": s3["markers"]})
    page.keyboard.press("Control+y"); page.wait_for_timeout(600)

    # 11. Captures : groupes suspendus, console avec groupe, piste Arrangement, fenêtre Temps en sombre.
    page.keyboard.press("Control+Shift+G"); page.wait_for_timeout(400)
    susp = st(page, "s => !!(s.groupSettings && s.groupSettings.suspended)")
    page.get_by_test_id("dock-groups").click(); page.wait_for_timeout(400)
    shot(page, "pc_13_groupes_suspendus")
    ok("Ctrl+Maj+G : tous les groupes suspendus", susp)
    close_groups(page)
    page.keyboard.press("Control+Shift+G"); page.wait_for_timeout(300)
    ok("aucune erreur de page", not errs, errs[:5])


def scenario_clair(page, res_):
    open_r12(page, "clair_00_projet", "light")
    page.get_by_test_id("dock-groups").click(); page.wait_for_timeout(300)
    page.get_by_test_id("group-new").click(); page.wait_for_timeout(300)
    for tid in ("lead", "dbl", "backs"):
        cb = page.get_by_test_id(f"group-member-{tid}")
        if not cb.is_checked(): cb.click(); page.wait_for_timeout(100)
    if page.get_by_test_id("group-member-beat").is_checked(): page.get_by_test_id("group-member-beat").click(); page.wait_for_timeout(100)
    shot(page, "clair_01_groupe_reglages")
    page.get_by_role("button", name="OK", exact=True).click(); page.wait_for_timeout(200)
    shot(page, "clair_02_liste_groupes")
    close_groups(page)
    page.get_by_test_id("dock-time").click(); page.wait_for_timeout(400)
    shot(page, "clair_03_fenetre_temps")
    close_overlays(page)
    page.get_by_test_id("arrange-section-m-refrain").click(button="right"); page.wait_for_timeout(300)
    shot(page, "clair_04_menu_section")
    close_overlays(page)
    ok("thème clair : liste des groupes, fenêtre Temps, piste Arrangement", page.get_by_test_id("arrange-lane").count() == 1)


def scenario_tab(page, res_):
    open_r12(page, "tab_00_projet")
    page.get_by_test_id("dock-groups").click(); page.wait_for_timeout(300)
    shot(page, "tab_01_liste_groupes")
    close_groups(page)
    # Au doigt : « Copier » puis glisser le Refrain jusqu'à sa fin.
    page.get_by_test_id("arrange-copy-mode").tap(); page.wait_for_timeout(200)
    sec = page.get_by_test_id("arrange-section-m-refrain")
    bb = sec.bounding_box()
    y = bb["y"] + bb["height"] / 2
    x0 = bb["x"] + 20
    cdp = page.context.new_cdp_session(page)
    def touch(kind, x):
        cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [] if kind == "touchEnd" else [{"x": x, "y": y}]})
    touch("touchStart", x0)
    for i in range(1, 12):
        touch("touchMove", x0 + 4 * ZOOM * i / 11); page.wait_for_timeout(30)
    shot(page, "tab_02_section_au_doigt")
    touch("touchEnd", x0)
    page.wait_for_timeout(800)
    mk = st(page, "s => s.markers.map(m => [m.name, m.time]).sort((a, b) => a[1] - b[1])")
    ok("tablette : Refrain dupliqué au doigt (mode Copier)", mk == [["Intro", 0], ["Couplet", 2], ["Refrain", 8], ["Refrain", 12], ["Outro", 16]], mk)
    shot(page, "tab_03_section_dupliquee")
    page.get_by_test_id("dock-time").tap(); page.wait_for_timeout(400)
    shot(page, "tab_04_fenetre_temps")
    close_overlays(page)


def scenario_tel(page, res_):
    # Groupe déjà dans le projet : le téléphone le montre en lecture seule.
    f = project()
    z = zipfile.ZipFile(f); stt = json.loads(z.read("project.json")); files = {k: z.read(k) for k in z.namelist() if k != "project.json"}; z.close()
    stt["trackGroups"] = [{"id": "grp-vox", "name": "VOX", "color": "#ec4899", "trackIds": ["lead", "dbl", "backs"], "isCollapsed": False, "kind": "both",
                          "linkedVolume": True, "linkedMute": True, "linkedSolo": True, "linkedPan": False}]
    for t in stt["tracks"]:
        if t["id"] in ("lead", "dbl", "backs"): t["groupId"] = "grp-vox"
    f2 = OUT / "r12_projet_groupe.zip"
    with zipfile.ZipFile(f2, "w") as z:
        z.writestr("project.json", json.dumps(stt))
        for k, v in files.items(): z.writestr(k, v)
    page.add_init_script("try { localStorage.setItem('nova_theme', 'dark'); } catch (e) {}")
    pe.open_project(page, f2, "tel_00_projet")
    close_overlays(page)
    g = page.get_by_test_id("mobile-groups").locator("visible=true")
    ok("téléphone : bouton Groupes visible", g.count() > 0)
    if g.count():
        g.first.tap(); page.wait_for_timeout(400)
        shot(page, "tel_01_groupes_lecture_seule")
        ro = page.get_by_test_id("group-new").count() == 0 and page.get_by_test_id("group-toggle-grp-vox").is_disabled()
        ok("téléphone : groupes en lecture seule", ro)
        page.get_by_role("button", name="Fermer").first.tap(); page.wait_for_timeout(300)
    t = page.get_by_test_id("mobile-time").locator("visible=true")
    if t.count():
        t.first.tap(); page.wait_for_timeout(400)
        shot(page, "tel_02_fenetre_temps")
        page.get_by_test_id("timeops-len-bars").fill("1")
        page.get_by_test_id("timeops-go").tap(); page.wait_for_timeout(700)
        mk = st(page, "s => s.markers.map(m => m.time).sort((a, b) => a - b)")
        ok("téléphone : 1 mesure insérée à la tête de lecture (0 s), repères décalés de 2 s", mk == [0, 4, 10, 14] or mk == [2, 4, 10, 14], mk)
        shot(page, "tel_03_temps_insere")
    else:
        ok("téléphone : bouton Temps visible", False)


def main(names):
    names = names or ["pc", "clair", "tab", "tel"]
    with sync_playwright() as p:
        b = pe.launch(p)
        for n in names:
            vp = {"pc": "pc", "clair": "pc", "tab": "tab", "tel": "tel"}[n]
            log = Log(n)
            ctx, page = new_page(b, vp, log)
            try:
                {"pc": scenario_pc, "clair": scenario_clair, "tab": scenario_tab, "tel": scenario_tel}[n](page, res)
            except Exception as e:
                ok(f"{n} : scénario terminé sans exception", False, repr(e)[:500])
                try: shot(page, f"{n}_zz_erreur")
                except Exception: pass
            finally:
                errs = [e for e in log.errors() if "favicon" not in e["text"]]
                res.setdefault("erreurs_console", {})[n] = errs[:10]
                ctx.close()
        b.close()
    (OUT / "r12_resultats.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    ko = [k for k, v in res["etapes"].items() if not v["ok"]]
    print(f"\n{len(res['etapes']) - len(ko)}/{len(res['etapes'])} étapes OK" + (f" — KO : {ko}" if ko else ""))


if __name__ == "__main__":
    main(sys.argv[1:])
