"""Échange AAF avec Pro Tools (chantier 14, A4) : preuves dans un navigateur headless (aucune fenêtre).

  export   : projet NOVA à 48 kHz (clips à des positions quelconques, décalages, gains, ligne de gain,
             fondus de formes différentes, fondu enchaîné, piste stéréo, piste MIDI) → fenêtre
             « Séance pour Pro Tools » → .zip téléchargé (AAF lié, puis AAF intégré) → relu par pyaaf2 :
             position, décalage, longueur de chaque clip comparés au projet (échantillons), BWF horodatés ;
  retour   : l'AAF exporté réimporté dans NOVA (fenêtre « Importer une séance Pro Tools ») → mêmes clips ;
  reference: AAF de référence fabriqués par pyaaf2 (qa/aaf_reference.py) importés par l'interface :
             médias intégrés (47 clips), médias liés avec un fichier absent (choix des sons, clips muets),
             débit d'édition vidéo 25 i/s ; positions comparées à la vérité attendue ; rapport d'import ouvert.

QA 100 % hors production (qalib → qa_hors_prod). pyaaf2 tourne dans le venv du worktree (.venv-aaf).
Usage : serveur Vite caché sur 3436 dans le worktree, puis
  NOVA_URL=http://127.0.0.1:3436/ PYTHONIOENCODING=utf-8 python qa/echange_aaf.py [passage]
Sorties : D:\\1 WORK\\CONTENU\\nova-aaf\\qa\\<passage>\\ (captures, zip exportés, echange_aaf_resultats.json)
"""
import io, json, math, os, re, struct, subprocess, sys, time, wave, zipfile
from pathlib import Path

RUN = sys.argv[1] if len(sys.argv) > 1 else "1"
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3436/")
os.environ["QA_OUT"] = rf"D:\1 WORK\CONTENU\nova-aaf\qa\passage_{RUN}"
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402  (QA hors production)
from qalib import OUT, Log, new_page, shot  # noqa: E402
import protools_edition as pe  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

HERE = Path(__file__).resolve().parent
WT = HERE.parent
# Python avec pyaaf2 (lecture de référence des AAF) : variable AAF_VENV_PY, sinon le .venv-aaf
# de ce worktree, sinon celui du worktree d'origine du chantier AAF.
VENV_PY = next((p for p in [Path(os.environ["AAF_VENV_PY"])] if p.exists()), None) if os.environ.get("AAF_VENV_PY") else None
VENV_PY = VENV_PY or next((p for p in (WT / ".venv-aaf" / "Scripts" / "python.exe",
                                       WT.parent / "NOVA-aaf-wt" / ".venv-aaf" / "Scripts" / "python.exe") if p.exists()),
                          WT / ".venv-aaf" / "Scripts" / "python.exe")
REF = Path(r"D:\1 WORK\CONTENU\nova-aaf\reference")
SR = 48000
res = {"passage": RUN, "etapes": {}, "mesures": {}}


def ok(k, v, note=None):
    res["etapes"][k] = {"ok": bool(v), **({"detail": note} if note is not None else {})}
    print(("OK  " if v else "KO  ") + k, "" if note is None else json.dumps(note, ensure_ascii=False)[:600], flush=True)


# ── Projet NOVA de départ (48 kHz) ───────────────────────────────────────────────────────
def wav(chans, sr=SR):
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(len(chans)); w.setsampwidth(2); w.setframerate(sr)
        fr = bytearray()
        for i in range(len(chans[0])):
            for c in chans:
                fr += struct.pack("<h", max(-32768, min(32767, int(c[i] * 32767))))
        w.writeframes(bytes(fr))
    return b.getvalue()


def tone(n, f, amp=0.3):
    return [amp * math.sin(2 * math.pi * f * i / SR) + 0.05 * math.sin(i * 0.731) for i in range(n)]


S = lambda n: n / SR  # noqa: E731  échantillons → secondes (comme NOVA)

# Clips du projet en ÉCHANTILLONS (vérité) : nom, position, longueur, décalage, extra
LEAD = [
    ("Prise 1", 48_001, 40_000, 1_234, {"fadeIn": S(480), "fadeInCurve": "EQUAL_POWER", "fadeOut": S(2_400), "fadeOutCurve": "S_CURVE", "gain": 0.8}),
    ("Prise 2", 85_601, 30_000, 100_000, {"fadeIn": S(2_400), "fadeInCurve": "S_CURVE", "fadeOut": S(1_111), "fadeOutCurve": "EXPONENTIAL"}),  # fondu enchaîné avec Prise 1
    ("Prise 3", 150_017, 22_222, 7, {"gainPoints": [{"t": S(7), "db": 0}, {"t": S(11_007), "db": -6}, {"t": S(22_229), "db": 0}]}),
    ("Prise 4", 201_999, 9_001, 333_333, {"fadeIn": S(97), "fadeInCurve": "LINEAR", "gain": 1.5}),
    ("Prise 5", 260_000, 48_000, 480_000, {}),
]
BEAT = [("Beat", 0, SR * 12, 0, {"fadeOut": S(4_800), "fadeOutCurve": "LINEAR"})]


def make_project(path: Path):
    clips_lead = [pe.clip(f"lead-{i}", n, S(p), S(l), "audio/voix.wav", offset=S(o), **x) for i, (n, p, l, o, x) in enumerate(LEAD)]
    clips_beat = [pe.clip("beat-0", n, S(p), S(l), "audio/beat.wav", offset=S(o), **x) for (n, p, l, o, x) in BEAT]
    midi = pe.track("synth", "Synth", [{"id": "m1", "name": "Notes", "start": 0, "duration": 4, "offset": 0, "fadeIn": 0, "fadeOut": 0, "color": "#a78bfa", "type": "MIDI",
                                         "notes": [{"id": "n1", "pitch": 60, "start": 0, "duration": 1, "velocity": 100}]}], type="MIDI")
    tracks = [pe.track("lead", "Lead", clips_lead, volume=0.7, pan=-0.3), pe.track("beat", "Beat", clips_beat), midi]
    pe.make_project(path, tracks, {"audio/voix.wav": wav([tone(SR * 12, 220)]), "audio/beat.wav": wav([tone(SR * 12, 110), tone(SR * 12, 113)])}, name="Seance AAF QA")
    # Fréquence du projet : 48 kHz (comme une séance Pro Tools)
    z = zipfile.ZipFile(path); files = {n: z.read(n) for n in z.namelist()}; z.close()
    st = json.loads(files["project.json"]); st["sampleRate"] = SR
    files["project.json"] = json.dumps(st).encode()
    with zipfile.ZipFile(path, "w") as z2:
        for n, d in files.items(): z2.writestr(n, d)


# ── Outils ───────────────────────────────────────────────────────────────────────────────
def pyaaf2(*args):
    r = subprocess.run([str(VENV_PY), str(HERE / "aaf_reference.py"), *args], capture_output=True, text=True, encoding="utf-8",
                       env={**os.environ, "PYTHONIOENCODING": "utf-8"}, creationflags=0x08000000)
    if r.returncode:
        raise RuntimeError(r.stderr[-1500:])
    return json.loads(r.stdout) if args and args[0] == "--relire" else r.stdout


def bwf_time_reference(p: Path):
    b = p.read_bytes()
    i = b.find(b"bext")
    return struct.unpack_from("<Q", b, i + 8 + 338)[0] if i > 0 else None


def state(page, expr="s => s"):
    return page.evaluate(f"() => {{ const s = window.__novaEdit && window.__novaEdit.getState(); return s ? ({expr})(s) : null; }}")


TRACKS_JS = """s => s.tracks.map(t => ({ id: t.id, name: t.name, volume: t.volume, pan: t.pan, clips: t.clips.map(c => ({ name: c.name, start: c.start, duration: c.duration, offset: c.offset,
  fadeIn: c.fadeIn, fadeOut: c.fadeOut, fadeInCurve: c.fadeInCurve || null, fadeOutCurve: c.fadeOutCurve || null, gain: c.gain ?? 1, gainPoints: c.gainPoints || null,
  offline: !!c.isOffline, bufferId: c.bufferId || null })) }))"""


def palette(page, query, want):
    page.keyboard.press("Escape"); page.mouse.click(5, 300)
    page.keyboard.press("Control+k")
    page.locator("[data-testid=command-palette]").wait_for(timeout=4000)
    page.keyboard.type(query, delay=10)
    page.wait_for_timeout(250)
    opt = page.locator(f"[data-testid=command-palette] [data-palette-id='{want}']").first
    first = page.locator("[data-testid=command-palette] [role=option]").first.get_attribute("data-palette-id")
    res["mesures"].setdefault("palette", {})[query] = {"premier": first, "voulu": want}
    if first == want:
        page.keyboard.press("Enter")
    else:
        opt.click()


def open_import(page):
    palette(page, "séance pro tools aaf importer", "pal.aafImport")
    page.locator("[data-testid=aaf-import-dialog]").wait_for(timeout=8000)


def import_files(page, files, label, expect_missing=None):
    """Importe un AAF (et ses sons) par la fenêtre ; renvoie (pistes ajoutées, texte du rapport)."""
    before = {t["id"] for t in state(page, TRACKS_JS)}
    open_import(page)
    page.set_input_files("[data-testid=aaf-input]", [str(f) for f in files])
    page.locator("[data-testid=aaf-review]").wait_for(timeout=60000)
    preview = page.locator("[data-testid=aaf-preview]").inner_text()
    shot(page, f"{label}_1_apercu")
    missing = page.locator("[data-testid=aaf-missing]")
    miss_txt = missing.inner_text() if missing.count() else ""
    if expect_missing is not None:
        ok(f"{label} : sons introuvables signalés avant l'import", all(m in miss_txt for m in expect_missing) and (bool(miss_txt) == bool(expect_missing)), miss_txt[:300])
    t0 = time.time()
    page.locator("[data-testid=aaf-import-go]").click()
    page.locator("[data-testid=aaf-import-report]").wait_for(timeout=120000)
    res["mesures"].setdefault("import_ms", {})[label] = round((time.time() - t0) * 1000)
    report = page.locator("[data-testid=aaf-import-report]").inner_text()
    shot(page, f"{label}_2_rapport")
    page.locator("[data-testid=aaf-import-close]").click()
    page.wait_for_timeout(300)
    after = state(page, TRACKS_JS)
    return [t for t in after if t["id"] not in before], report, preview


def compare(label, tracks, want_tracks, key=lambda c: c):
    """Clips NOVA (secondes) contre la vérité (échantillons) : écart en échantillons."""
    total = exact = 0
    worst = []
    float_err = 0.0
    for t, w in zip(tracks, want_tracks):
        for c, e in zip(t["clips"], w["clips"]):
            total += 1
            pos, ln, off = c["start"] * SR, c["duration"] * SR, c["offset"] * SR
            float_err = max(float_err, abs(pos - round(pos)), abs(ln - round(ln)))
            d = (round(pos) - e["pos"], round(ln) - e["len"], round(off) - e["offset"])
            if d == (0, 0, 0):
                exact += 1
            elif len(worst) < 8:
                worst.append({"piste": t["name"], "clip": c["name"], "ecart(pos,long,decal)": d})
        if len(t["clips"]) != len(w["clips"]):
            worst.append({"piste": t["name"], "clips": [len(t["clips"]), len(w["clips"])]})
    want_total = sum(len(w["clips"]) for w in want_tracks)
    res["mesures"].setdefault("exactitude", {})[label] = {"clips": total, "attendus": want_total, "exacts": exact, "taux": f"{100 * exact / max(1, want_total):.1f} %", "erreur_flottante_max": float_err}
    ok(f"{label} : {exact}/{want_total} clips à 0 échantillon d'écart", total == want_total and exact == want_total, worst or None)
    return exact, want_total


# ── Scénarios ────────────────────────────────────────────────────────────────────────────
def project_truth():
    """Vérité attendue après export : pistes AAF (Lead, Beat stéréo) en échantillons."""
    lead = [{"name": n, "pos": p, "len": l, "offset": o, "x": x} for (n, p, l, o, x) in LEAD]
    beat = [{"name": n, "pos": p, "len": l, "offset": o, "x": x} for (n, p, l, o, x) in BEAT]
    return [{"name": "Lead", "clips": lead}, {"name": "Beat", "clips": beat}]


def scenario_export(page):
    zp = OUT / "projet_aaf_qa.zip"
    make_project(zp)
    pe.open_project(page, zp, "export_0_projet")
    st = state(page, "s => ({ rate: s.sampleRate, tracks: s.tracks.length })")
    ok("projet NOVA ouvert à 48 kHz", st and st["rate"] == SR, st)
    truth = project_truth()
    exported = {}
    for mode in ("lie", "integre"):
        palette(page, "exporter séance pro tools aaf", "pal.aafExport")
        page.locator("[data-testid=aaf-export-dialog]").wait_for(timeout=8000)
        if mode == "integre":
            page.locator("[data-testid=aaf-embedded]").check()
        preview = page.locator("[data-testid=aaf-export-preview]").inner_text()
        notes = page.locator("[data-testid=aaf-export-notes]").inner_text() if page.locator("[data-testid=aaf-export-notes]").count() else ""
        shot(page, f"export_{mode}_1_fenetre")
        ok(f"export {mode} : aperçu « 2 pistes · 6 clips · 3 fichiers BWF · 48 kHz »", "2 pistes" in preview and "6 clips" in preview and "3 fichiers BWF" in preview and "48 kHz" in preview, preview)
        ok(f"export {mode} : piste MIDI listée comme non exportée", "« Synth » (MIDI) : non exportée" in notes, notes[:300])
        with page.expect_download(timeout=120000) as dl:
            page.locator("[data-testid=aaf-export-go]").click()
        page.locator("[data-testid=aaf-export-done]").wait_for(timeout=60000)
        shot(page, f"export_{mode}_2_fait")
        zpath = OUT / f"export_{mode}.zip"
        dl.value.save_as(str(zpath))
        page.locator("[data-testid=aaf-export-close]").click()
        d = OUT / f"export_{mode}"
        with zipfile.ZipFile(zpath) as z:
            z.extractall(d)
        aaf = next(d.rglob("*.aaf"))
        wavs = sorted(p.name for p in aaf.parent.joinpath("Audio Files").glob("*.wav"))
        ok(f"export {mode} : zip = AAF + Audio Files/*.wav + LISEZ-MOI", wavs == ["Beat.L.wav", "Beat.R.wav", "Prise 1.wav"] and aaf.parent.joinpath("LISEZ-MOI.txt").exists(),
           {"aaf": aaf.name, "wav": wavs, "taille_aaf": aaf.stat().st_size})
        rl = pyaaf2("--relire", str(aaf))
        exported[mode] = (aaf, rl)
        names = [t["name"] for t in rl["tracks"]]
        ok(f"export {mode} : relu par pyaaf2 (pistes Lead, Beat.L, Beat.R ; 1 séance)", names == ["Lead", "Beat.L", "Beat.R"] and rl["compositions"] == 1, {"pistes": names, "mobs": rl["mobs"], "essence": rl["essence"]})
        # Positions : chaque slot comparé au projet (Beat.L et Beat.R = la piste Beat)
        slots = {t["name"]: t for t in rl["tracks"]}
        mapping = [("Lead", truth[0]), ("Beat.L", truth[1]), ("Beat.R", truth[1])]
        total = exact = 0
        bad = []
        for sname, w in mapping:
            for c, e in zip(slots[sname]["clips"], w["clips"]):
                total += 1
                if (c["pos"], c["len"], c["offset"]) == (e["pos"], e["len"], e["offset"]):
                    exact += 1
                else:
                    bad.append({sname: [c["pos"], c["len"], c["offset"]], "attendu": [e["pos"], e["len"], e["offset"]]})
        res["mesures"].setdefault("exactitude", {})[f"export_{mode}_pyaaf2"] = {"clips": total, "exacts": exact, "taux": f"{100 * exact / max(1, total):.1f} %"}
        ok(f"export {mode} : NOVA → AAF → pyaaf2, {exact}/{total} clips à 0 échantillon d'écart", total == 7 and exact == total, bad or None)
        lead = slots["Lead"]["clips"]
        fades = [(c["fadeIn"] or {}).get("interp") for c in lead] + [(c["fadeOut"] or {}).get("interp") for c in lead]
        ok(f"export {mode} : fondus et formes (Power, BSpline, Log, Linear) + fondu enchaîné", lead[0]["fadeIn"]["len"] == 480 and lead[0]["fadeIn"]["interp"] == "PowerInterp"
           and lead[1]["fadeIn"] and lead[1]["fadeIn"]["len"] == 2400 and lead[1]["fadeOut"]["interp"] == "LogInterp" and lead[3]["fadeIn"]["len"] == 97, fades)
        ok(f"export {mode} : gain de clip (0,8 ; 1,5) et ligne de gain", abs(lead[0]["gain"] - 0.8) < 1e-6 and abs(lead[3]["gain"] - 1.5) < 1e-6
           and lead[2]["gainPoints"] and len(lead[2]["gainPoints"]) == 3 and abs(lead[2]["gainPoints"][1][1] - 10 ** (-6 / 20)) < 1e-5, [lead[0]["gain"], lead[3]["gain"], lead[2]["gainPoints"]])
        ok(f"export {mode} : volume et pan de piste", abs(slots["Lead"]["volume"] - 0.7) < 1e-6 and abs(slots["Lead"]["pan"] - 0.35) < 1e-6 and slots["Beat.L"]["pan"] == 0 and slots["Beat.R"]["pan"] == 1.0,
           {k: [slots[k]["volume"], slots[k]["pan"]] for k in slots})
        ok(f"export {mode} : sons {'intégrés' if mode == 'integre' else 'liés (Audio Files/…)'}",
           all(c["embedded"] == (mode == "integre") for t in rl["tracks"] for c in t["clips"]) and (mode == "integre" or all((c["locator"] or "").startswith("Audio%20Files/") for t in rl["tracks"] for c in t["clips"])),
           sorted({c["locator"] for t in rl["tracks"] for c in t["clips"]}, key=str))
        tr = {p.name: bwf_time_reference(p) for p in aaf.parent.joinpath("Audio Files").glob("*.wav")}
        ok(f"export {mode} : BWF horodatés (bext TimeReference = position du 1er échantillon)", tr.get("Prise 1.wav") == 48_001 - 1_234 and tr.get("Beat.L.wav") == 0, tr)
    return exported


def scenario_retour(page, exported):
    aaf, _ = exported["lie"]
    files = [aaf, *sorted(aaf.parent.joinpath("Audio Files").glob("*.wav"))]
    new, report, _ = import_files(page, files, "retour", expect_missing=[])
    truth = project_truth()
    want = [{"name": "Lead", "clips": [{"pos": c["pos"], "len": c["len"], "offset": c["offset"]} for c in truth[0]["clips"]]},
            {"name": "Beat", "clips": [{"pos": c["pos"], "len": c["len"], "offset": c["offset"]} for c in truth[1]["clips"]]}]
    ok("retour : 2 pistes ajoutées (Lead, Beat)", len(new) == 2, [t["name"] for t in new])
    compare("retour NOVA → AAF → NOVA", new, want)
    lead = new[0]["clips"] if new else []
    if lead:
        ok("retour : fondus, formes, gain, ligne de gain, volume et pan retrouvés",
           round(lead[0]["fadeIn"] * SR) == 480 and lead[0]["fadeInCurve"] == "EQUAL_POWER" and round(lead[1]["fadeOut"] * SR) == 1111 and lead[1]["fadeOutCurve"] == "EXPONENTIAL"
           and abs(lead[0]["gain"] - 0.8) < 1e-6 and lead[2]["gainPoints"] and abs(new[0]["volume"] - 0.7) < 1e-6 and abs(new[0]["pan"] + 0.3) < 1e-6,
           {"fondus": [[round(c["fadeIn"] * SR), c["fadeInCurve"], round(c["fadeOut"] * SR), c["fadeOutCurve"]] for c in lead], "gain": lead[0]["gain"], "vol": new[0]["volume"], "pan": new[0]["pan"]})
        ok("retour : fondu enchaîné relu (chevauchement de 2 400 = fondus égaux)", round((lead[0]["start"] + lead[0]["duration"] - lead[1]["start"]) * SR) == 2400
           and round(lead[0]["fadeOut"] * SR) == 2400 and round(lead[1]["fadeIn"] * SR) == 2400)
    ok("retour : stéréo double mono relue au centre (pan 0)", len(new) > 1 and abs(new[1]["pan"]) < 1e-9, [t["pan"] for t in new])
    ok("retour : rapport « 6 clips importés… »", report.startswith("✅ 6 clips importés"), report[:300])
    n0 = len(state(page, TRACKS_JS))
    page.mouse.click(5, 300); page.keyboard.press("Control+z"); page.wait_for_timeout(600)
    n1 = len(state(page, TRACKS_JS))
    ok("retour : Ctrl+Z annule l'import (2 pistes retirées)", n1 == n0 - 2, [n0, n1])


def scenario_reference(page):
    if not (REF / "attendu.json").exists():
        pyaaf2(str(REF))
    want = json.loads((REF / "attendu.json").read_text(encoding="utf-8"))
    pe.open_project(page, OUT / "projet_aaf_qa.zip", "reference_0_projet")
    # 1. Médias intégrés : 47 clips
    new, report, preview = import_files(page, [REF / "ref_integre.aaf"], "ref_integre", expect_missing=[])
    ok("référence intégrée : aperçu (6 pistes, 47 clips, 48 kHz, sons intégrés)", "6 pistes" in preview and "47 clips" in preview and "48 kHz" in preview and "intégrés" in preview, preview)
    compare("référence intégrée (pyaaf2)", new, want["integre"]["tracks"])
    fades = {"exacts": 0, "formes_ok": 0, "approches": 0}
    for t, w in zip(new, want["integre"]["tracks"]):
        for c, e in zip(t["clips"], w["clips"]):
            for side, curve in (("fadeIn", "fadeInCurve"), ("fadeOut", "fadeOutCurve")):
                if e[side]:
                    fades["exacts"] += round(c[side] * SR) == e[side]["len"]
                    fades["formes_ok"] += c[curve] == e[side]["shape"]
                    fades["approches"] += bool(e[side]["approx"])
    nf = sum(1 for w in want["integre"]["tracks"] for e in w["clips"] for s in ("fadeIn", "fadeOut") if e[s])
    res["mesures"]["fondus_reference"] = {**fades, "total": nf}
    ok(f"référence intégrée : {fades['exacts']}/{nf} fondus à la bonne longueur, {fades['formes_ok']}/{nf} formes", fades["exacts"] == nf and fades["formes_ok"] == nf, fades)
    gains = [(c["gain"], e["gain"]) for t, w in zip(new, want["integre"]["tracks"]) for c, e in zip(t["clips"], w["clips"])]
    ok("référence intégrée : gain de clip (47/47)", all(abs(a - b) < 1e-6 for a, b in gains))
    vp = [(t["volume"], t["pan"], w["volume"], w["pan"]) for t, w in zip(new, want["integre"]["tracks"])]
    ok("référence intégrée : volume et pan de piste", all(abs(a - (c if c is not None else 1)) < 1e-6 and abs(b - ((2 * d - 1) if d is not None else 0)) < 1e-6 for a, b, c, d in vp), vp)
    n_approx = sum(1 for w in want["integre"]["tracks"] for e in w["clips"] for s in ("fadeIn", "fadeOut") if e[s] and e[s]["approx"])
    ok(f"référence intégrée : rapport « 47 clips importés, 6 pistes, {n_approx} fondus approchés »", f"47 clips importés, 6 pistes, {n_approx} fondus approchés" in report, report[:400])
    ok("référence intégrée : rapport détaillé (fondus rendus remplacés, stéréo double mono regroupée)", "2 fondus rendus par le logiciel d’origine remplacés" in report and "1 piste stéréo en double mono" in report, report[:600])
    ok("référence intégrée : tous les sons présents (aucun clip muet)", all(not c["offline"] and c["bufferId"] for t in new for c in t["clips"]))

    # 2. Médias liés : d'abord l'AAF seul (7 sons manquants), puis le choix des sons (1 reste absent)
    open_import(page)
    page.set_input_files("[data-testid=aaf-input]", [str(REF / "ref_lie.aaf")])
    page.locator("[data-testid=aaf-missing]").wait_for(timeout=30000)
    miss1 = page.locator("[data-testid=aaf-missing]").inner_text()
    shot(page, "ref_lie_1_sons_manquants")
    ok("référence liée : sans les sons, les fichiers manquants sont listés", "7 fichiers son introuvables (47 clips)" in miss1 and "Adlibs_01.wav" in miss1, miss1[:300])
    wavs = sorted((REF / "Audio Files").glob("*.wav"))
    page.set_input_files("[data-testid=aaf-media-input]", [str(p) for p in wavs])
    page.wait_for_timeout(500)
    miss2 = page.locator("[data-testid=aaf-missing]").inner_text()
    shot(page, "ref_lie_2_un_son_absent")
    ok("référence liée : après « Choisir des fichiers », seul Adlibs_01.wav manque (8 clips muets)", "1 fichier son introuvable (8 clips)" in miss2 and "Adlibs_01.wav" in miss2
       and "Importer quand même (8 clips muets)" in page.locator("[data-testid=aaf-import-go]").inner_text(), miss2[:300])
    before = {t["id"] for t in state(page, TRACKS_JS)}
    page.locator("[data-testid=aaf-import-go]").click()
    page.locator("[data-testid=aaf-import-report]").wait_for(timeout=120000)
    report = page.locator("[data-testid=aaf-import-report]").inner_text()
    shot(page, "ref_lie_3_rapport")
    page.locator("[data-testid=aaf-import-close]").click()
    new = [t for t in state(page, TRACKS_JS) if t["id"] not in before]
    compare("référence liée (pyaaf2)", new, want["lie"]["tracks"])
    off = [c["name"] for t in new for c in t["clips"] if c["offline"]]
    ok("référence liée : 8 clips gardés à leur place, muets (Adlibs) ; rapport le dit", len(off) == 8 and "1 fichier introuvable : Adlibs_01.wav" in report and "8 clips gardés" in report, {"muets": len(off), "rapport": report[:500]})

    # 3. Glisser-déposer d'un .aaf sur la timeline : la fenêtre d'import s'ouvre sur la séance
    import base64, gzip
    data = base64.b64encode(gzip.decompress((WT / "tests" / "fixtures" / "aaf" / "ref_lie_petit.aaf.gz").read_bytes())).decode()
    page.evaluate("""(b64) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const dt = new DataTransfer(); dt.items.add(new File([u], 'glisse.aaf'));
      const el = document.querySelector('.nova-grille canvas') || document.querySelector('main') || document.body;
      el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); }""", data)
    try:
        page.locator("[data-testid=aaf-review]").wait_for(timeout=20000)
        pv = page.locator("[data-testid=aaf-preview]").inner_text()
        shot(page, "glisser_deposer_aaf")
        ok("glisser-déposer un .aaf sur la timeline : la fenêtre d'import s'ouvre sur la séance", "47 clips" in pv and "glisse.aaf" in page.locator("[data-testid=aaf-import-dialog]").inner_text(), pv)
        page.locator("[data-testid=aaf-import-dialog] [data-testid=aaf-cancel]").click()
        page.locator("[data-testid=aaf-import-dialog]").wait_for(state="detached", timeout=5000)
    except Exception as e:  # noqa
        ok("glisser-déposer un .aaf sur la timeline : la fenêtre d'import s'ouvre sur la séance", False, repr(e)[:300])

    # 4. Débit d'édition vidéo (25 i/s)
    new, report, _ = import_files(page, [REF / "ref_25ips.aaf"], "ref_25ips", expect_missing=[])
    compare("référence 25 i/s (pyaaf2)", new, want["25ips"]["tracks"])
    ok("référence 25 i/s : rapport signale le débit vidéo", "débit d'édition vidéo (25 images/s)" in report, report[:400])


def _billing_admin(route, request):
    if request.method == "OPTIONS":
        return route.fulfill(status=204, headers={"access-control-allow-origin": "*", "access-control-allow-headers": "*"})
    try: action = json.loads(request.post_data or "{}").get("action")
    except Exception: action = None
    body = {"status": {"plans": [], "admin": True},
            "export_access": {"unlocked": True, "via": "admin", "reason": None, "missing": [], "items": [], "kits": False, "pro": None}}.get(action)
    if body is None:
        return route.fulfill(status=400, content_type="application/json", headers={"access-control-allow-origin": "*"}, body=json.dumps({"error": "Action inconnue"}))
    route.fulfill(status=200, content_type="application/json", headers={"access-control-allow-origin": "*"}, body=json.dumps(body))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    with sync_playwright() as p:
        b = pe.launch(p)
        for name, fn in (("export", None), ("reference", scenario_reference)):
            log = Log(f"aaf_{name}")
            ctx, page = new_page(b, "pc", log)
            # Grille du 14/10 : la séance Pro Tools (AAF + BWF) est un export, débloqué par le serveur
            # (licence, projet payé, Nova Pro, admin). Ici : compte du studio (admin), comme avant.
            page.route(re.compile(r"^https://[a-z0-9-]+\.supabase\.co/functions/v1/nova-billing"), _billing_admin)
            try:
                if name == "export":
                    exported = scenario_export(page)
                    scenario_retour(page, exported)
                else:
                    fn(page)
            except Exception as e:  # noqa
                ok(f"{name} : scénario terminé sans exception", False, repr(e)[:800])
                try: shot(page, f"{name}_zz_erreur")
                except Exception: pass
            finally:
                errs = [e for e in log.errors() if "favicon" not in e["text"]]
                res.setdefault("erreurs_console", {})[name] = [e["text"][:300] for e in errs[:10]]
                ctx.close()
        b.close()
    ex = res["mesures"].get("exactitude", {})
    tot = sum(v.get("attendus", v.get("clips", 0)) for v in ex.values())
    exa = sum(v["exacts"] for v in ex.values())
    res["mesures"]["total"] = {"clips_compares": tot, "exacts": exa, "taux": f"{100 * exa / max(1, tot):.1f} %", "duree_s": round(time.time() - t0, 1)}
    (OUT / "echange_aaf_resultats.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    ko = [k for k, v in res["etapes"].items() if not v["ok"]]
    print(f"\n{len(res['etapes']) - len(ko)}/{len(res['etapes'])} étapes OK ; clips exacts {exa}/{tot}" + (f" — KO : {ko}" if ko else ""))
    sys.exit(1 if ko else 0)


if __name__ == "__main__":
    main()
