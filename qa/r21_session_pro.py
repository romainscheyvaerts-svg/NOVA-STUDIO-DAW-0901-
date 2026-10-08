"""R21 · Session pro : preuves dans un navigateur headless (aucune fenêtre).

  import   : projet A (LEAD, BACK, ADLIB → bus VOX BUS et RV, effets, envois, automation) exporté ;
             projet B vide : « Importer depuis une session » → A.zip, 3 pistes, « Tout » (fenêtre) ;
             bus manquants créés ; export de B = export de A (null test) ; recalage au tempo (90 BPM).
  versions : « Enregistrer comme nouvelle version » v2 (commentaire), piste retirée, v3 ; Comparer ;
             Restaurer la v2 (pistes et nom revenus) ; l'historique automatique la garde.
  arr      : arrangements « Explicite », « Radio edit » (Couplet, Refrain, Refrain), « Clean »
             (passage coupé sur LEAD) : exports par la fenêtre Exporter, longueurs et sections mesurées,
             null test des sections, passage coupé silencieux.
  notes    : notes de projet + commentaires de piste (panneau et console), sauvegarde .zip, réouverture.
  clips    : liste des clips : recherche, glisser vers une piste, clip retiré → hors timeline,
             « Supprimer les clips inutilisés » (confirmation), Ctrl+Z.
  ecrans   : captures PC (sombre, clair), tablette, téléphone (version simple : notes et versions).

Usage : serveur `npx vite --port 3463 --strictPort` dans le worktree, puis
  NOVA_URL=http://127.0.0.1:3463/ PYTHONIOENCODING=utf-8 python qa/r21_session_pro.py [import] [versions] [arr] [notes] [clips] [ecrans]
Sorties : D:\\1 WORK\\CONTENU\\nova-r21\\
"""
import io, json, os, re, sys, time, wave, zipfile
from pathlib import Path

import numpy as np

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3463/")
os.environ["QA_OUT"] = r"D:\1 WORK\CONTENU\nova-r21"
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa
from qalib import OUT, Log, new_page, shot  # noqa
import protools_edition as pe  # noqa
from playwright.sync_api import sync_playwright

SR = 48000
DUR = 12.0
res = {"etapes": {}, "mesures": {}}


def ok(k, v, note=None):
    res["etapes"][k] = {"ok": bool(v), **({"detail": note} if note is not None else {})}
    print(("OK  " if v else "KO  ") + k, "" if note is None else json.dumps(note, ensure_ascii=False)[:700], flush=True)


def wav_bytes(x):
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return b.getvalue()


def audio():
    n = int(DUR * SR)
    t = np.arange(n) / SR
    lead = 0.25 * np.sin(2 * np.pi * 220 * t + 2 * np.sin(2 * np.pi * 5 * t)) * (0.6 + 0.4 * np.sin(2 * np.pi * 0.7 * t))
    back = 0.18 * np.sin(2 * np.pi * 329.6 * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 1.3 * t))
    adlib = np.zeros(n)
    for k in range(6):
        i0 = int((1 + k * 1.7) * SR); m = int(0.4 * SR); tt = np.arange(m) / SR
        adlib[i0:i0 + m] += 0.3 * np.sin(2 * np.pi * (500 + 300 * tt) * tt) * np.exp(-tt * 4)
    beat = np.zeros(n)
    for k in range(int(DUR * 2)):
        i0 = int(k * 0.5 * SR); m = min(n - i0, int(0.25 * SR)); tt = np.arange(m) / SR
        beat[i0:i0 + m] += 0.5 * np.sin(2 * np.pi * (55 + 70 * np.exp(-tt * 30)) * tt) * np.exp(-tt * 9)
    return {"audio/lead.wav": wav_bytes(lead), "audio/back.wav": wav_bytes(back), "audio/adlib.wav": wav_bytes(adlib), "audio/beat.wav": wav_bytes(beat)}


def mod(page, path, expr):
    return page.evaluate(f"async () => {{ const m = await window.__novaAppModule('{path}'); return ({expr})(m); }}")


def st(page, expr):
    return pe.st(page, expr)


def apply(page, fn_js, label=None):
    """Modification du projet par le bus R21 (une étape d'annulation)."""
    page.evaluate(f"async () => {{ const m = await window.__novaAppModule('/utils/r21Bus.ts'); m.applyR21({fn_js}{', ' + json.dumps(label) if label else ''}); }}")
    page.wait_for_timeout(400)


def close_overlays(page):
    for _ in range(2):
        page.keyboard.press("Escape"); page.wait_for_timeout(120)


def plugins_for(page):
    """Effets de NOVA avec leurs vrais réglages (fabrique des modèles)."""
    return mod(page, "/utils/sessionTemplate.ts", """m => ({
      cmp: m.builtinPlugin('COMPRESSOR', { threshold: -24, ratio: 4 }, 'cmp-lead', 120),
      dly: m.builtinPlugin('DELAY', {}, 'dly-back', 120),
      dly2: m.builtinPlugin('DELAY', {}, 'dly-adlib', 120),
      bus: m.builtinPlugin('COMPRESSOR', { threshold: -18, ratio: 2 }, 'cmp-bus', 120),
      rv: m.builtinPlugin('REVERB', {}, 'rv-1', 120),
    })""")


def project_a(page, path, bpm=120):
    p = plugins_for(page)
    lane = {"id": "lane-lead-vol", "parameterName": "volume", "color": "#22d3ee", "isExpanded": False, "min": 0, "max": 1.5,
            "points": [{"id": "a0", "time": 0, "value": 0.9}, {"id": "a1", "time": 6, "value": 0.5}, {"id": "a2", "time": 9, "value": 1.0}]}
    tracks = [
        pe.track("lead", "LEAD", [pe.clip("c-lead", "Lead prise 1", 1, 10, "audio/lead.wav", offset=1)], color="#ef4444", volume=0.8, pan=-0.3,
                 plugins=[p["cmp"]], sends=[{"id": "rv", "level": 0.4, "isEnabled": True}], outputTrackId="voxbus", automationLanes=[lane], comment="SM7B, 10 cm"),
        pe.track("back", "BACK", [pe.clip("c-back", "Backs", 3, 6, "audio/back.wav", offset=3)], color="#a855f7", pan=0.4, plugins=[p["dly"]], outputTrackId="voxbus"),
        pe.track("adlib", "ADLIB", [pe.clip("c-adlib", "Adlibs", 0, DUR, "audio/adlib.wav")], color="#f59e0b", plugins=[p["dly2"]],
                 sends=[{"id": "rv", "level": 0.25, "isEnabled": True, "preFader": True}]),
        pe.track("voxbus", "VOX BUS", [], type="BUS", color="#22d3ee", plugins=[p["bus"]], sends=[{"id": "rv", "level": 0.1, "isEnabled": True}]),
        pe.track("rv", "RV", [], type="BUS", color="#64748b", plugins=[p["rv"]]),
        pe.track("master", "MASTER", [], type="BUS", outputTrackId=""),
    ]
    pe.make_project(path, tracks, {k: v for k, v in audio().items() if k != "audio/beat.wav"}, name="Projet A")
    set_bpm(path, bpm)
    return path


def set_bpm(path, bpm, **extra):
    z = zipfile.ZipFile(path); s = json.loads(z.read("project.json")); files = {k: z.read(k) for k in z.namelist() if k != "project.json"}; z.close()
    s["bpm"] = bpm; s.update(extra)
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(s))
        for k, v in files.items(): z.writestr(k, v)


def project_b(path, bpm=120, name="Projet B"):
    tracks = [pe.track("idee", "IDÉE", [], color="#34d399"), pe.track("master", "MASTER", [], type="BUS", outputTrackId="")]
    pe.make_project(path, tracks, {}, name=name)
    set_bpm(path, bpm)
    # Un projet vide ne serait pas gardé par la sauvegarde automatique : un clip court suffit (muet, hors du rendu).
    return path


# ------------------------------------------------------------------------ export

def open_export(page):
    if page.locator("[data-export-vue=avancee]").count() == 0:
        b = page.get_by_role("button", name="Exporter le mix").locator("visible=true")
        if b.count() == 0:
            page.keyboard.press("Control+Shift+E"); page.wait_for_timeout(1500)
        else:
            b.first.click(); page.wait_for_timeout(1500)
        if page.locator("[data-export-vue=avancee]").count() == 0:
            page.get_by_role("button", name=re.compile("Réglages avancés")).click(); page.wait_for_timeout(400)
    page.locator("[data-export-vue=avancee]").wait_for(timeout=15000)


def esel(page, label, value):
    page.locator(f'[data-export-vue=avancee] label:has(> span:text-is("{label}")) select').first.select_option(str(value))


def export_full(page, tag, arrangement=None, keep_open=False):
    open_export(page)
    if arrangement is not None:
        page.locator('[data-export-vue=avancee] select[aria-label="Arrangement exporté"]').select_option(label=arrangement)
        page.wait_for_timeout(300)
    page.get_by_test_id("export-source-MASTER").click()
    esel(page, "Type de fichier", "WAV")
    esel(page, "Fréquence d'échantillonnage", 48000)
    esel(page, "Résolution", "32")
    esel(page, "Canaux", "stereo")
    esel(page, "Durée", "FULL")
    esel(page, "Queue (réverbe après la fin)", "cut")
    try: esel(page, "Volume", "off")
    except Exception: pass
    info = None
    if arrangement is not None:
        try: info = page.get_by_test_id("export-arrangement-info").first.inner_text()
        except Exception: pass
    if keep_open:
        shot(page, f"{tag}_fenetre_export")
    with page.expect_download(timeout=240000) as dl:
        page.get_by_test_id("export-go").click()
    path = OUT / f"{tag}.wav"
    dl.value.save_as(str(path))
    page.wait_for_timeout(1500)
    close_overlays(page)
    return path, info


def read_wav(path):
    import soundfile as sf
    x, sr = sf.read(str(path), dtype="float64", always_2d=True)
    return x, sr


def null_db(a, b):
    n = min(len(a), len(b))
    d = a[:n] - b[:n]
    rs = float(np.sqrt(np.mean(a[:n] ** 2))) if n else 0.0
    rd = float(np.sqrt(np.mean(d ** 2))) if n else 1.0
    return 20 * np.log10(max(rd, 1e-12) / max(rs, 1e-12)), float(np.max(np.abs(d))) if n else 1.0, rs


def open_session(page, tab="notes"):
    if page.get_by_test_id("session-panel").count() == 0:
        page.get_by_test_id("dock-session").click(); page.wait_for_timeout(500)
    page.get_by_test_id(f"session-tab-{tab}").click(); page.wait_for_timeout(400)


def close_session(page):
    if page.get_by_test_id("session-panel").count():
        page.get_by_test_id("session-panel").get_by_role("button", name="Fermer").click(); page.wait_for_timeout(300)


# ------------------------------------------------------------------------ scénarios

def scenario_import(page):
    log_errs = []
    page.goto(qalib.BASE, wait_until="domcontentloaded")
    page.wait_for_timeout(2500)
    fa = project_a(page, OUT / "r21_projet_A.zip")
    fb = project_b(OUT / "r21_projet_B.zip")
    # 1. Export de A (référence).
    pe.open_project(page, fa, "import_01_projet_A")
    pa, _ = export_full(page, "r21_A_mix")
    # 2. Projet B, import par la fenêtre.
    pe.open_project(page, fb, "import_02_projet_B")
    open_session(page, "notes")
    page.get_by_test_id("session-import").click(); page.wait_for_timeout(600)
    page.get_by_test_id("import-session-dialog").wait_for(timeout=8000)
    shot(page, "import_03_fenetre_source")
    with page.expect_file_chooser(timeout=8000) as fc:
        page.get_by_test_id("import-from-zip").click()
    fc.value.set_files(str(fa))
    page.get_by_test_id("import-tracks").wait_for(timeout=30000)
    names = page.locator("[data-testid=import-track]").evaluate_all("els => els.map(e => e.dataset.trackName)")
    ok("import : les pistes de A sont listées (sans le master)", names == ["LEAD", "BACK", "ADLIB", "VOX BUS", "RV"], names)
    for n in ("LEAD", "BACK", "ADLIB"):
        page.get_by_label(f"Importer {n}").check()
    page.wait_for_timeout(400)
    prev = page.get_by_test_id("import-preview").inner_text()
    shot(page, "import_04_fenetre_pistes")
    ok("import : aperçu (3 pistes, bus manquants annoncés)", "3 pistes ajoutées" in prev and "VOX BUS" in prev and "RV" in prev, prev)
    page.get_by_test_id("import-go").click()
    page.get_by_test_id("import-done").wait_for(timeout=60000)
    shot(page, "import_05_fenetre_fin")
    page.get_by_test_id("import-close").click(); page.wait_for_timeout(800)
    close_session(page)
    s = st(page, """s => s.tracks.map(t => ({ id: t.id, name: t.name, out: t.outputTrackId, sends: (t.sends||[]).map(x => [x.id, x.level, !!x.preFader]), plugins: t.plugins.map(p => [p.type, JSON.stringify(p.params)]), clips: t.clips.map(c => [c.start, c.duration, c.offset, !!c.bufferId]), lanes: t.automationLanes.filter(l => l.points.length).map(l => l.points.map(p => [p.time, p.value])), comment: t.comment || null, vol: t.volume, pan: t.pan }))""")
    shot(page, "import_06_projet_B_importe")
    by = {t["name"]: t for t in s}
    ok("import : LEAD, BACK, ADLIB + bus VOX BUS et RV créés", all(n in by for n in ("LEAD", "BACK", "ADLIB", "VOX BUS", "RV", "IDÉE")), list(by))
    ok("import : routage gardé (LEAD → VOX BUS, envoi RV 0,4 ; ADLIB pré-fader)",
       by["LEAD"]["out"] == by["VOX BUS"]["id"] and by["LEAD"]["sends"] == [[by["RV"]["id"], 0.4, False]] and by["ADLIB"]["sends"] == [[by["RV"]["id"], 0.25, True]],
       {"LEAD": [by["LEAD"]["out"], by["LEAD"]["sends"]], "ADLIB": by["ADLIB"]["sends"]})
    ok("import : effets, automation, volume, pan et commentaire gardés",
       by["LEAD"]["plugins"][0][0] == "COMPRESSOR" and by["RV"]["plugins"][0][0] == "REVERB" and by["LEAD"]["lanes"] == [[[0, 0.9], [6, 0.5], [9, 1.0]]]
       and by["LEAD"]["vol"] == 0.8 and by["LEAD"]["pan"] == -0.3 and by["LEAD"]["comment"] == "SM7B, 10 cm",
       {"LEAD": by["LEAD"]["plugins"], "lanes": by["LEAD"]["lanes"]})
    # 3. Export de B = export de A.
    pb, _ = export_full(page, "r21_B_mix_apres_import")
    xa, sra = read_wav(pa); xb, srb = read_wav(pb)
    ndb, dmax, rs = null_db(xa, xb)
    res["mesures"]["import_null_test"] = {"A": pa.name, "B": pb.name, "echantillons": [len(xa), len(xb)], "sr": [sra, srb], "rms_signal": rs, "null_db": round(float(ndb), 1), "ecart_max": dmax}
    ok("import : null test, export de B (3 pistes importées) = export de A", len(xa) == len(xb) and rs > 0.01 and ndb < -90, res["mesures"]["import_null_test"])
    # 4. Ctrl+Z : l'import s'annule en une étape.
    page.keyboard.press("Control+z"); page.wait_for_timeout(700)
    after = st(page, "s => s.tracks.map(t => t.name)")
    ok("import : Ctrl+Z annule l'import en une étape", after == ["IDÉE", "MASTER"], after)
    page.keyboard.press("Control+y"); page.wait_for_timeout(500)
    # 5. Même nom « remplacer » (effets seuls), puis tempo différent (90 BPM) : recalage.
    fc90 = project_b(OUT / "r21_projet_C_90bpm.zip", bpm=90, name="Projet C")
    pe.open_project(page, fc90, "import_07_projet_C")
    page.keyboard.press("Alt+Shift+I"); page.wait_for_timeout(700)
    page.get_by_test_id("import-session-dialog").wait_for(timeout=8000)
    with page.expect_file_chooser(timeout=8000) as fc:
        page.get_by_test_id("import-from-zip").click()
    fc.value.set_files(str(fa))
    page.get_by_test_id("import-tracks").wait_for(timeout=30000)
    page.get_by_label("Importer LEAD").check(); page.wait_for_timeout(300)
    tempo_box = page.get_by_text("Faire correspondre au tempo").first.inner_text()
    shot(page, "import_08_tempo_90")
    page.get_by_test_id("import-go").click()
    page.get_by_test_id("import-done").wait_for(timeout=120000)
    page.get_by_test_id("import-close").click(); page.wait_for_timeout(800)
    c = st(page, "s => { const t = s.tracks.find(x => x.name === 'LEAD'); const c = t.clips[0]; return { start: c.start, duration: c.duration, elastic: !!c.elastic, tempo: c.elastic && c.elastic.tempo, lane: t.automationLanes.filter(l => l.points.length).map(l => l.points.map(p => +p.time.toFixed(6))) }; }")
    k = 120 / 90
    ok("import au tempo : 120 → 90 BPM, mêmes mesures (position, durée étirée, automation)",
       abs(c["start"] - 1 * k) < 1e-6 and abs(c["duration"] - 10 * k) < 1e-3 and c["elastic"] and c["lane"] == [[0, round(6 * k, 6), round(9 * k, 6)]],
       {"clip": c, "attendu_start": k, "attendu_duree": 10 * k, "case_tempo": tempo_box})
    return log_errs


def scenario_versions(page):
    fb = project_b(OUT / "r21_projet_V.zip", name="Mon son")
    fa = OUT / "r21_projet_A.zip"
    if not fa.exists():
        page.goto(qalib.BASE, wait_until="domcontentloaded"); page.wait_for_timeout(2000)
        project_a(page, fa)
    pe.open_project(page, fa, "versions_01_projet")
    apply(page, "s => ({ ...s, id: 'proj-versions', name: 'Mon son' })")
    # v2 depuis la fenêtre Sauvegarder.
    sv = page.get_by_role("button", name="Sauvegarder").locator("visible=true")
    if sv.count() == 0:
        page.get_by_test_id("transport-menu").click(); page.wait_for_timeout(500)
        sv = page.get_by_role("button", name="Sauvegarder").locator("visible=true")
    sv.first.click(); page.wait_for_timeout(700)
    page.get_by_test_id("save-new-version-box").wait_for(timeout=5000)
    label = page.get_by_test_id("save-new-version").inner_text()
    page.get_by_test_id("save-new-version-comment").fill("voix posées, mix brut")
    shot(page, "versions_02_fenetre_sauvegarder")
    page.get_by_test_id("save-new-version").click(); page.wait_for_timeout(2500)
    n2 = st(page, "s => [s.name, s.sessionVersion]")
    ok("versions : « Enregistrer comme nouvelle version » → « Mon son v2 »", n2 == ["Mon son v2", 2] and "Mon son v2" in label, {"etat": n2, "bouton": label})
    # Une piste retirée, puis v3 depuis le panneau Session.
    apply(page, "s => ({ ...s, tracks: s.tracks.filter(t => t.name !== 'ADLIB') })")
    open_session(page, "versions")
    page.get_by_test_id("version-comment").fill("sans les adlibs")
    page.get_by_test_id("version-save").click(); page.wait_for_timeout(2500)
    page.wait_for_timeout(1200)
    n3 = st(page, "s => [s.name, s.sessionVersion, s.tracks.map(t => t.name)]")
    rows = page.get_by_test_id("named-version").all_inner_texts()
    shot(page, "versions_03_panneau")
    ok("versions : v3 enregistrée, liste avec numéro, date et commentaire",
       n3[0] == "Mon son v3" and len(rows) == 2 and "v3" in rows[0] and "sans les adlibs" in rows[0] and "voix posées" in rows[1], {"etat": n3, "lignes": rows})
    # Ajout d'une piste après la v3, puis comparer à la v2.
    apply(page, "s => ({ ...s, tracks: [{ ...s.tracks[0], id: 'nouvelle', name: 'TALKBOX', clips: [], comment: undefined }, ...s.tracks] })")
    page.get_by_test_id("named-version").nth(1).get_by_test_id("version-compare").click(); page.wait_for_timeout(900)
    diff = page.get_by_test_id("version-diff").inner_text()
    shot(page, "versions_04_comparer")
    ok("versions : Comparer la v2 → piste ajoutée (TALKBOX) et retirée (ADLIB)", "TALKBOX" in diff and "ADLIB" in diff and "ajoutée" in diff and "retirée" in diff, diff)
    # Restaurer la v2.
    page.get_by_test_id("named-version").nth(1).get_by_test_id("version-restore").click(); page.wait_for_timeout(300)
    page.get_by_test_id("version-restore-confirm").click(); page.wait_for_timeout(5000)
    back = st(page, "s => [s.name, s.sessionVersion, s.tracks.map(t => t.name)]")
    shot(page, "versions_05_v2_restauree")
    ok("versions : la v2 restaurée (ADLIB revenu, TALKBOX absent, nom v2)", back[0] == "Mon son v2" and "ADLIB" in back[2] and "TALKBOX" not in back[2], back)
    # L'historique complet garde les versions nommées.
    open_session(page, "versions")
    page.get_by_test_id("versions-all").click(); page.wait_for_timeout(1000)
    hist = page.get_by_test_id("versions-dialog").inner_text()
    shot(page, "versions_06_historique")
    ok("versions : l'historique automatique montre v2 et v3 avec leurs commentaires", "v2" in hist and "v3" in hist and "sans les adlibs" in hist and "version nommée" in hist, hist[:400])
    close_overlays(page)
    vs = mod(page, "/utils/recoveryStore.ts", "async m => (await m.recoveryStore().listVersions('proj-versions')).filter(v => v.versionNumber).map(v => [v.versionNumber, v.comment])")
    res["mesures"]["versions_nommees"] = vs
    ok("versions : points marqués dans l'historique de la sauvegarde automatique (pas un 2e historique)", sorted(v[0] for v in vs) == [2, 3], vs)


def song_project(path):
    """Projet avec sections : Intro 0-2, Couplet 2-6, Refrain 6-10, Outro 10-12."""
    tracks = [
        pe.track("beat", "BEAT", [pe.clip("c-beat", "Beat", 0, DUR, "audio/beat.wav")], color="#eab308"),
        pe.track("lead", "LEAD", [pe.clip("c-lead", "Lead", 2, 8, "audio/lead.wav", offset=2)], color="#ef4444"),
        pe.track("master", "MASTER", [], type="BUS", outputTrackId=""),
    ]
    pe.make_project(path, tracks, audio(), name="Arrangements")
    set_bpm(path, 120, markers=[
        {"id": "m-intro", "name": "Intro", "time": 0, "type": "MARKER", "color": "#64748b", "number": 1},
        {"id": "m-couplet", "name": "Couplet", "time": 2, "type": "MARKER", "color": "#22d3ee", "number": 2},
        {"id": "m-refrain", "name": "Refrain", "time": 6, "type": "MARKER", "color": "#f59e0b", "number": 3},
        {"id": "m-outro", "name": "Outro", "time": 10, "type": "MARKER", "color": "#a855f7", "number": 4},
    ])
    return path


def scenario_arr(page):
    f = song_project(OUT / "r21_projet_arrangements.zip")
    pe.open_project(page, f, "arr_01_projet")
    open_session(page, "arrangements")
    page.get_by_test_id("arrangement-new-Explicite").click(); page.wait_for_timeout(500)
    page.get_by_test_id("arrangement-new-Radio edit").click(); page.wait_for_timeout(500)
    page.get_by_test_id("arrangement-new-Clean").click(); page.wait_for_timeout(500)
    page.get_by_test_id("arrangement-new-Version longue").click(); page.wait_for_timeout(500)
    # Radio edit : Couplet, Refrain (Intro et Outro retirées dans l'éditeur).
    page.get_by_test_id("arrangement-Radio edit").click(); page.wait_for_timeout(300)
    ed = page.locator("[data-testid^=arrangement-editor-]").first
    ed.get_by_role("button", name="Retirer la section").first.click(); page.wait_for_timeout(300)   # Intro
    ed.get_by_role("button", name="Retirer la section").last.click(); page.wait_for_timeout(300)    # Outro
    shot(page, "arr_02_radio_edit")
    # Version longue : le refrain deux fois (ajouté à la fin, remonté avant l'Outro).
    page.get_by_test_id("arrangement-Version longue").click(); page.wait_for_timeout(300)
    ed = page.locator("[data-testid^=arrangement-editor-]").first
    ed.get_by_label("Section à ajouter").select_option("m-refrain"); ed.get_by_role("button", name="Ajouter", exact=True).click(); page.wait_for_timeout(400)
    ed.get_by_role("button", name="Monter").last.click(); page.wait_for_timeout(400)
    shot(page, "arr_02b_version_longue")
    # Clean : passage coupé sur LEAD (3,0 → 3,5 s), par la sélection de plage.
    page.get_by_test_id("arrangement-Clean").click(); page.wait_for_timeout(300)
    mod(page, "/utils/editSelection.ts", "m => m.editSelectionStore.set({ time: { start: 3, end: 3.5, trackIds: ['lead'] }, clipIds: [] })")
    page.locator("[data-testid^=arrangement-editor-]").first.get_by_test_id("arrangement-mute-range").click(); page.wait_for_timeout(400)
    shot(page, "arr_03_clean")
    arrs = st(page, "s => (s.arrangements || []).map(a => ({ name: a.name, sections: a.sections, ranges: a.mutedRanges }))")
    ok("arrangements : 4 arrangements (Explicite, Radio edit, Clean, Version longue) dans le projet", [a["name"] for a in arrs] == ["Explicite", "Radio edit", "Clean", "Version longue"]
       and arrs[1]["sections"] == ["m-couplet", "m-refrain"] and arrs[3]["sections"] == ["m-intro", "m-couplet", "m-refrain", "m-refrain", "m-outro"]
       and arrs[2]["ranges"] == [{"trackId": "lead", "start": 3, "end": 3.5}], arrs)
    tl = st(page, "s => s.tracks.map(t => t.clips.length)")
    close_session(page)
    # Exports : explicite (timeline), radio edit, clean.
    pe_, i_e = export_full(page, "r21_arr_explicite", arrangement="Explicite")
    pr, i_r = export_full(page, "r21_arr_radio_edit", arrangement="Radio edit", keep_open=True)
    pc, i_c = export_full(page, "r21_arr_clean", arrangement="Clean")
    pl, i_l = export_full(page, "r21_arr_version_longue", arrangement="Version longue")
    xe, sr = read_wav(pe_); xr, _ = read_wav(pr); xc, _ = read_wav(pc); xl, _ = read_wav(pl)
    L = lambda x: len(x) / sr
    res["mesures"]["arrangements"] = {"explicite_s": L(xe), "radio_edit_s": L(xr), "clean_s": L(xc), "version_longue_s": L(xl), "infos": [i_e, i_r, i_c, i_l]}
    ok("arrangements : longueurs exportées (Explicite 12 s, Radio edit 8 s, Clean 12 s, Version longue 16 s)",
       abs(L(xe) - 12) < 0.01 and abs(L(xr) - 8) < 0.01 and abs(L(xc) - 12) < 0.01 and abs(L(xl) - 16) < 0.01, res["mesures"]["arrangements"])
    # Sections : radio edit [0,4) = couplet (2-6 de l'explicite), [4,8) = refrain (6-10) ;
    # version longue [0,10) = explicite [0,10), [10,14) = refrain, [14,16) = outro (10-12).
    seg = lambda x, a, b: x[int(a * sr):int(b * sr)]
    g = int(0.003 * sr)  # bords : 3 ms (la queue des effets de la section précédente ne suit pas)
    nulls = [null_db(seg(xr, 0, 4)[g:], seg(xe, 2, 6)[g:])[0], null_db(seg(xr, 4, 8)[g:], seg(xe, 6, 10)[g:])[0],
             null_db(seg(xl, 0, 10)[g:], seg(xe, 0, 10)[g:])[0], null_db(seg(xl, 10, 14)[g:], seg(xe, 6, 10)[g:])[0], null_db(seg(xl, 14, 16)[g:], seg(xe, 10, 12)[g:])[0]]
    res["mesures"]["arrangements"]["null_sections_db"] = [round(float(n), 1) for n in nulls]
    ok("arrangements : sections au bon endroit (radio edit Couplet → Refrain ; version longue … Refrain → Refrain → Outro), null test", max(nulls) < -90, res["mesures"]["arrangements"]["null_sections_db"])
    # Clean : seul le passage 3,0-3,5 change ; il est sans voix (beat seul).
    d = xc - xe
    outside = np.concatenate([d[:int(2.99 * sr)], d[int(3.51 * sr):]])
    ndb_out = 20 * np.log10(max(float(np.sqrt(np.mean(outside ** 2))), 1e-12) / max(float(np.sqrt(np.mean(xe ** 2))), 1e-12))
    lead_e = float(np.sqrt(np.mean(seg(xe, 3.05, 3.45) ** 2))); lead_c = float(np.sqrt(np.mean(seg(xc, 3.05, 3.45) ** 2)))
    res["mesures"]["arrangements"]["clean"] = {"null_hors_passage_db": round(float(ndb_out), 1), "rms_passage_explicite": lead_e, "rms_passage_clean": lead_c}
    ok("arrangements : version clean — passage coupé (voix absente), le reste identique", ndb_out < -90 and lead_c < lead_e * 0.9, res["mesures"]["arrangements"]["clean"])
    tl2 = st(page, "s => s.tracks.map(t => t.clips.length)")
    ok("arrangements : la timeline n'a pas bougé", tl == tl2, [tl, tl2])


def scenario_notes(page):
    f = song_project(OUT / "r21_projet_notes.zip")
    pe.open_project(page, f, "notes_01_projet")
    open_session(page, "notes")
    page.get_by_test_id("note-tab-mix").click()
    page.get_by_test_id("note-mix").fill("Voix lead bien devant, 808 sans saturation.")
    page.get_by_test_id("note-tab-references").click()
    page.get_by_test_id("note-references").fill("Réf : « Titre » pour le son de la voix")
    page.get_by_test_id("note-tab-lyrics").click()
    page.get_by_test_id("note-lyrics").fill("Couplet 1 : on y va\nRefrain : encore")
    page.get_by_test_id("comment-lead").fill("U87, pop filter"); page.get_by_test_id("comment-lead").press("Enter")
    page.wait_for_timeout(900)
    shot(page, "notes_02_panneau")
    # Commentaire écrit depuis la console (vue Mixer).
    close_session(page)
    page.keyboard.press("Control+Equal") if False else None
    st0 = st(page, "s => ({ pn: s.projectNotes, lyrics: s.lyrics, c: s.tracks.map(t => [t.id, t.comment || null]) })")
    ok("notes : notes de projet, paroles et commentaire posés", st0["pn"]["mix"].startswith("Voix lead") and "Réf" in st0["pn"]["references"] and st0["lyrics"].startswith("Couplet 1") and ["lead", "U87, pop filter"] in st0["c"], st0)
    hdr = page.get_by_test_id("header-comment-lead").count()
    ok("notes : commentaire affiché dans l'en-tête de piste", hdr == 1, hdr)
    # Sauvegarde .zip puis réouverture.
    blob_b64 = page.evaluate("""async () => {
      const io = await window.__novaAppModule('/services/ProjectIO.ts');
      const s = window.__novaEdit.getState();
      const b = await io.ProjectIO.saveProject(s, []);
      const buf = new Uint8Array(await b.arrayBuffer()); let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return btoa(bin);
    }""")
    import base64
    saved = OUT / "r21_notes_sauve.zip"
    saved.write_bytes(base64.b64decode(blob_b64))
    js = json.loads(zipfile.ZipFile(saved).read("project.json"))
    pe.open_project(page, saved, "notes_03_reouvert")
    st1 = st(page, "s => ({ pn: s.projectNotes, lyrics: s.lyrics, c: s.tracks.map(t => [t.id, t.comment || null]) })")
    ok("notes : conservées après sauvegarde .zip et réouverture", st1["pn"]["mix"] == st0["pn"]["mix"] and st1["pn"]["references"] == st0["pn"]["references"] and st1["lyrics"] == st0["lyrics"] and st1["c"] == st0["c"],
       {"dans_le_fichier": {"projectNotes": js.get("projectNotes"), "comment_lead": [t.get("comment") for t in js["tracks"] if t["id"] == "lead"]}})
    # Console : commentaire visible et modifiable.
    page.keyboard.press("Control+Alt+m") if False else None
    try:
        page.get_by_role("button", name=re.compile(r"^Mixer$|Console", re.I)).locator("visible=true").first.click(); page.wait_for_timeout(900)
    except Exception:
        apply(page, "s => ({ ...s, currentView: 'MIXER' })")
    if page.get_by_test_id("strip-comment-lead").count() == 0:
        mod(page, "/utils/r21Bus.ts", "m => m.applyR21Silent(s => ({ ...s, currentView: 'MIXER' }))"); page.wait_for_timeout(900)
    strip = page.get_by_test_id("strip-comment-lead").inner_text() if page.get_by_test_id("strip-comment-lead").count() else ""
    page.get_by_test_id("strip-comment-beat").click(); page.wait_for_timeout(200)
    page.get_by_test_id("strip-comment-input-beat").fill("Beat du catalogue, -6 dB")
    page.get_by_test_id("strip-comment-input-beat").press("Enter"); page.wait_for_timeout(500)
    shot(page, "notes_04_console_commentaires")
    cb = st(page, "s => s.tracks.find(t => t.id === 'beat').comment")
    ok("notes : commentaire affiché et écrit dans la console (Pro Tools : Comments)", "U87" in strip and cb == "Beat du catalogue, -6 dB", {"tranche_lead": strip, "beat": cb})
    # Collaboration : opération « notes » reçue (champ par champ).
    mod(page, "/utils/sessionNotes.ts", "m => 0")
    r = page.evaluate("""async () => {
      const n = await window.__novaAppModule('/utils/sessionNotes.ts');
      const s = window.__novaEdit.getState();
      const op = n.sanitizeNotesOp({ fields: { 'p:general': 'Refaire le 2e couplet', 't:lead': 'U87 → SM7B' } });
      const r = n.applyNotesFields(s, op);
      return { applied: r.applied, general: r.state.projectNotes.general, lead: r.state.tracks.find(t => t.id === 'lead').comment };
    }""")
    ok("notes : une opération de collaboration « notes » s'applique champ par champ", r["applied"] == ["p:general", "t:lead"] and r["lead"] == "U87 → SM7B", r)


def scenario_clips(page):
    f = song_project(OUT / "r21_projet_clips.zip")
    pe.open_project(page, f, "clips_01_projet")
    open_session(page, "clips")
    rows = page.get_by_test_id("clips-row").count()
    page.get_by_test_id("clips-search").fill("lead"); page.wait_for_timeout(300)
    found = page.get_by_test_id("clips-row").all_inner_texts()
    shot(page, "clips_02_recherche")
    ok("clips : liste (2 clips) et recherche « lead »", rows == 2 and len(found) == 1 and "Lead" in found[0], {"lignes": rows, "trouves": found})
    page.get_by_test_id("clips-search").fill("")
    # Glisser le clip LEAD sur la piste BEAT n'est pas permis (audio → audio : permis) : on le pose sur LEAD à 10 s par un vrai glisser.
    box = pe.canvas_box(page)
    zoom = st(page, "s => 0") or 0
    lead_row = page.locator("[data-testid=clips-row][data-clip-key='t:lead:c-lead']")
    # Piste LEAD = 2e piste visible ; cible : y au milieu de son couloir, x = 10 s (zoom 40 px/s).
    y = box["y"] + box["tt"] + 1 * 120 - box["st"] + 60
    x = box["x"] + 10.5 * 40 - box["sl"]
    lead_row.drag_to(page.locator(".nova-grille .custom-scroll").first, target_position={"x": max(5, x - page.locator('.nova-grille .custom-scroll').first.bounding_box()["x"]), "y": max(5, y - page.locator('.nova-grille .custom-scroll').first.bounding_box()["y"])})
    page.wait_for_timeout(800)
    lc = st(page, "s => s.tracks.find(t => t.id === 'lead').clips.map(c => [c.id, +c.start.toFixed(2), c.bufferId === s.tracks.find(t => t.id === 'lead').clips[0].bufferId])")
    shot(page, "clips_03_glisse")
    ok("clips : glisser un clip de la liste sur une piste le pose à l'endroit lâché", len(lc) == 2 and lc[1][2] and 9 < lc[1][1] < 12, lc)
    # Clip retiré de la timeline → hors timeline (réserve).
    apply(page, "s => ({ ...s, tracks: s.tracks.map(t => t.id === 'beat' ? { ...t, clips: [] } : t) })")
    page.wait_for_timeout(600)
    page.get_by_role("radio", name=re.compile("Hors timeline")).click(); page.wait_for_timeout(300)
    unused = page.get_by_test_id("clips-row").all_inner_texts()
    shot(page, "clips_04_hors_timeline")
    ok("clips : un clip supprimé de la timeline reste dans la liste (hors timeline)", len(unused) == 1 and "Beat" in unused[0], unused)
    # « Supprimer les clips inutilisés » : confirmation, la timeline intacte, Ctrl+Z.
    tl = st(page, "s => s.tracks.map(t => t.clips.length)")
    page.get_by_test_id("clips-clear-unused").click(); page.wait_for_timeout(300)
    shot(page, "clips_05_confirmation")
    page.get_by_test_id("clips-clear-confirm").click(); page.wait_for_timeout(600)
    bin_after = st(page, "s => (s.clipBin || []).length")
    tl2 = st(page, "s => s.tracks.map(t => t.clips.length)")
    ok("clips : « Supprimer les clips inutilisés » (avec confirmation) vide la réserve, la timeline ne bouge pas", bin_after == 0 and tl == tl2, {"reserve": bin_after, "timeline": [tl, tl2]})
    close_session(page)
    page.mouse.click(5, 300)
    page.keyboard.press("Control+z"); page.wait_for_timeout(700)
    bin_undo = st(page, "s => (s.clipBin || []).map(c => c.name)")
    ok("clips : Ctrl+Z remet les clips retirés de la liste", bin_undo == ["Beat"], bin_undo)
    # Le clip hors timeline se repose (bouton « Poser », au doigt).
    open_session(page, "clips")
    page.get_by_role("radio", name=re.compile("Hors timeline")).click(); page.wait_for_timeout(300)
    page.get_by_test_id("clips-row").first.get_by_role("button", name="Poser").click(); page.wait_for_timeout(300)
    page.get_by_test_id("clips-row").first.get_by_role("button", name=re.compile("BEAT")).click(); page.wait_for_timeout(600)
    back = st(page, "s => [s.tracks.find(t => t.id === 'beat').clips.length, (s.clipBin || []).length]")
    ok("clips : « Poser » remet le clip hors timeline sur sa piste", back == [1, 0], back)
    close_session(page)


def scenario_ecrans(page, vp, theme="dark"):
    f = song_project(OUT / f"r21_projet_ecrans_{vp}.zip")
    pe.open_project(page, f, f"ecrans_{vp}_{theme}_00")
    if theme == "light":
        mod(page, "/utils/themeStore.ts", "m => { try { (m.themeStore || m.default).set('light'); } catch (e) { document.documentElement.dataset.theme = 'light'; } }")
        page.wait_for_timeout(500)
    apply(page, """s => ({ ...s, projectNotes: { mix: 'Voix devant, reverb courte sur les backs', references: 'Titre de référence' }, lyrics: 'Couplet 1…',
      arrangements: [{ id: 'a1', name: 'Explicite', sections: ['m-intro','m-couplet','m-refrain','m-outro'], mutedClipIds: [], mutedRanges: [] }, { id: 'a2', name: 'Clean', sections: ['m-intro','m-couplet','m-refrain','m-outro'], mutedClipIds: [], mutedRanges: [{ trackId: 'lead', start: 3, end: 3.5 }] }],
      tracks: s.tracks.map(t => t.id === 'lead' ? { ...t, comment: 'U87, pop filter' } : t) })""")
    tag = f"ecrans_{vp}_{theme}"
    if vp == "tel":
        # Téléphone : menu ☰ → Notes / Versions (version simple).
        page.get_by_test_id("transport-menu").click(); page.wait_for_timeout(500)
        shot(page, f"{tag}_01_menu")
        page.get_by_test_id("menu-session-notes").click(); page.wait_for_timeout(700)
        shot(page, f"{tag}_02_notes")
        tabs = page.locator("[data-testid^=session-tab-]").evaluate_all("els => els.map(e => e.dataset.testid)")
        page.get_by_test_id("session-tab-versions").click(); page.wait_for_timeout(700)
        shot(page, f"{tag}_03_versions")
        over = qalib.overflow_report(page)
        ok(f"écrans {vp} : version simple (Notes et Versions seulement), rien ne déborde", tabs == ["session-tab-notes", "session-tab-versions"] and not [o for o in over if o["kind"] == "page-hscroll"], {"onglets": tabs, "debordements": over[:5]})
        return
    open_session(page, "notes")
    shot(page, f"{tag}_01_notes")
    for t in ("clips", "arrangements", "versions"):
        open_session(page, t)
        if t == "arrangements":
            page.get_by_test_id("arrangement-Clean").click(); page.wait_for_timeout(300)
        shot(page, f"{tag}_0{['clips', 'arrangements', 'versions'].index(t) + 2}_{t}")
    over = qalib.overflow_report(page)
    close_session(page)
    page.keyboard.press("Alt+Shift+I"); page.wait_for_timeout(800)
    shot(page, f"{tag}_05_import")
    close_overlays(page)
    ok(f"écrans {vp} {theme} : panneau Session (4 onglets) et fenêtre d'import, rien ne déborde", not [o for o in over if o["kind"] == "page-hscroll"], over[:6])


def main(names):
    names = names or ["import", "versions", "arr", "notes", "clips", "ecrans"]
    with sync_playwright() as p:
        b = pe.launch(p)
        jobs = []
        for n in names:
            if n == "ecrans":
                jobs += [("ecrans_pc", "pc", lambda pg: scenario_ecrans(pg, "pc")), ("ecrans_clair", "pc", lambda pg: scenario_ecrans(pg, "pc", "light")),
                         ("ecrans_tab", "tab", lambda pg: scenario_ecrans(pg, "tab")), ("ecrans_tel", "tel", lambda pg: scenario_ecrans(pg, "tel"))]
            else:
                jobs.append((n, "pc", {"import": scenario_import, "versions": scenario_versions, "arr": scenario_arr, "notes": scenario_notes, "clips": scenario_clips}[n]))
        for name, vp, fn in jobs:
            log = Log(name)
            ctx, page = new_page(b, vp, log)
            try:
                fn(page)
            except Exception as e:
                ok(f"{name} : scénario terminé sans exception", False, repr(e)[:600])
                try: shot(page, f"{name}_zz_erreur")
                except Exception: pass
            finally:
                errs = [e for e in log.errors() if "favicon" not in e["text"]]
                res.setdefault("erreurs_console", {})[name] = errs[:10]
                ctx.close()
        b.close()
    (OUT / "r21_resultats.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    ko = [k for k, v in res["etapes"].items() if not v["ok"]]
    print(f"\n{len(res['etapes']) - len(ko)}/{len(res['etapes'])} étapes OK" + (f" — KO : {ko}" if ko else ""))


if __name__ == "__main__":
    main(sys.argv[1:])
