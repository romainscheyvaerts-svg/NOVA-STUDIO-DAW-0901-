"""Lot L6 « ergonomie pro » + échange DAWproject (22/10/2026), bout en bout, hors production.

Navigateur headless (aucune fenêtre), Supabase simulé (qalib → qa_hors_prod), aucun pont,
aucun micro ni caméra réels.

  dawproject : projet NOVA à 48 kHz (clips à des positions quelconques, fondus, gain, piste
               MIDI, effet, changement de tempo) → palette « Exporter en DAWproject » →
               .dawproject téléchargé, relu en Python (ZIP + XML : pistes, noires → secondes
               à l'échantillon près, sons WAV) → réouvert par « Ouvrir un projet DAWproject » :
               mêmes clips, mêmes notes ; puis un fichier de RÉFÉRENCE fabriqué ici à la manière
               d'un autre logiciel (plugin VST3 absent, son manquant) : rapport clair ;
               fenêtres en sombre et clair, bureau et téléphone, rien de recouvert.

NOVA_URL=http://127.0.0.1:3524/ python qa/ergo_pro.py [section ...]
Sorties : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-pro-2026\\qa\\ergo) : ergo_pro.json + captures.
"""
import io, json, math, os, re, struct, sys, time, wave, zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3524/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-pro-2026\qa\ergo")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402,F401  (Supabase simulé avant tout navigateur)
from qalib import BASE, OUT, CHROME, Log, new_page, shot, save_log  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SR = 48000
checks = []
res = {}


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:700]}"), flush=True)


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


def tone(n, f, amp=0.3, sr=SR):
    return [amp * math.sin(2 * math.pi * f * i / sr) for i in range(n)]


S = lambda n: n / SR  # noqa: E731


def track(tid, name, clips, **extra):
    return {"id": tid, "name": name, "type": "AUDIO", "color": "#22d3ee", "isMuted": False, "isSolo": False,
            "isTrackArmed": False, "isFrozen": False, "volume": 1.0, "pan": 0, "outputTrackId": "master",
            "sends": [], "clips": clips, "plugins": [], "automationLanes": [], "totalLatency": 0, **extra}


def aclip(cid, name, start, dur, ref, **extra):
    return {"id": cid, "name": name, "start": start, "duration": dur, "offset": 0, "fadeIn": 0, "fadeOut": 0,
            "color": "#22d3ee", "type": "AUDIO", "audioRef": ref, "gain": 1, **extra}


def make_state(name, tracks, **extra):
    return {
        "id": f"proj-{name}", "name": name, "bpm": 90, "timeSignature": {"numerator": 4, "denominator": 4}, "sampleRate": SR,
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": tracks[0]["id"], "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0}, **extra,
    }


def write_project(path: Path, state, audio: dict):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        for k, v in audio.items():
            z.writestr(k, v)


INIT = """
try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_count_in', '0'); localStorage.setItem('nova_auto_clean', '0');
      localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}
"""


def launch(p):
    return p.chromium.launch(headless=True, executable_path=CHROME, args=["--autoplay-policy=no-user-gesture-required"])


def open_project(page, f: Path, label, touch=False, advanced=True):
    page.add_init_script(INIT)
    page.route("**/functions/v1/nova-billing", lambda r: r.fulfill(status=200, content_type="application/json",
               body=json.dumps({"plans": [], "admin": True, "unlocked": True, "free_exports_left": 10})))
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=60000)
    b = page.get_by_text("Charger Projet").first
    b.tap() if touch else b.click()
    page.wait_for_timeout(700)
    with page.expect_file_chooser(timeout=8000) as fc:
        c = page.get_by_text("Charger depuis l'ordinateur").first
        c.tap() if touch else c.click()
    fc.value.set_files(str(f))
    page.wait_for_timeout(5000)
    for name in ("C'est parti", "Plus tard"):
        bb = page.get_by_role("button", name=name, exact=True).locator("visible=true").first
        try:
            if bb.is_visible(): bb.click(); page.wait_for_timeout(300)
        except Exception:
            pass
    page.wait_for_function("() => !!window.__novaEdit || !!window.DAW_CONTROL", timeout=30000)
    if advanced and not touch:
        adv = page.get_by_role("button", name=re.compile("Mode avanc", re.I)).locator("visible=true").first
        try:
            if adv.is_visible(): adv.click(); page.wait_for_timeout(500)
        except Exception:
            pass
    shot(page, label)


def st(page, expr="s => s"):
    return page.evaluate(f"() => {{ const s = window.DAW_CONTROL.getState(); return ({expr})(s); }}")


COVER_JS = """(sel) => [...document.querySelectorAll(sel)].filter(b => b.offsetParent !== null).map(b => {
  const r = b.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  const inView = x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight;
  return { label: (b.getAttribute('aria-label') || b.innerText || '').trim().slice(0, 40), ok: !inView || (!!hit && (hit === b || b.contains(hit))),
           over: hit && hit !== b && !b.contains(hit) ? (hit.getAttribute('aria-label') || hit.className || hit.tagName).toString().slice(0, 80) : null };
})"""

FITS_JS = """(sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), vw: innerWidth, vh: innerHeight,
           inside: r.x >= -1 && r.y >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1, hscroll: document.documentElement.scrollWidth > innerWidth + 1 }; }"""


def palette(page, query, want):
    page.keyboard.press("Escape"); page.mouse.click(5, 300)
    page.keyboard.press("Control+k")
    page.locator("[data-testid=command-palette]").wait_for(timeout=4000)
    page.keyboard.type(query, delay=10)
    page.wait_for_timeout(250)
    opt = page.locator(f"[data-testid=command-palette] [data-palette-id='{want}']").first
    first = page.locator("[data-testid=command-palette] [role=option]").first.get_attribute("data-palette-id")
    res.setdefault("palette", {})[query] = {"premier": first, "voulu": want}
    if first == want:
        page.keyboard.press("Enter")
    else:
        opt.click()


def set_theme(page, theme):
    page.evaluate(f"() => window.DAW_CONTROL.setTheme('{theme}')")
    page.wait_for_timeout(400)


# ── DAWproject ───────────────────────────────────────────────────────────────────────────
LEAD = [("Prise 1", 48_001, 40_000, 1_234, {"fadeIn": S(480), "fadeOut": S(2_400), "gain": 0.8}),
        ("Prise 2", 150_017, 22_222, 7, {}),
        ("Prise 3", 700_013, 9_001, 100_003, {"fadeIn": S(97)})]  # après le changement de tempo (mesure 4)
NOTES = [(60, 0.0, 0.5, 100), (64, 0.5, 0.25, 87), (67, 1.75, 1.5, 127)]


def dawp_project(path: Path):
    lead = [aclip(f"l{i}", n, S(p), S(l), "audio/voix.wav", offset=S(o), **x) for i, (n, p, l, o, x) in enumerate(LEAD)]
    beat = [aclip("b0", "Beat", 0, 8, "audio/beat.wav", fadeOut=S(4_800))]
    synth = track("synth", "Synth", [{"id": "m1", "name": "Accords", "start": 2, "duration": 4, "offset": 0, "fadeIn": 0, "fadeOut": 0, "color": "#facc15", "type": "MIDI",
                                      "notes": [{"id": f"n{i}", "pitch": p, "start": s, "duration": d, "velocity": v} for i, (p, s, d, v) in enumerate(NOTES)]}], type="MIDI", color="#facc15")
    tracks = [track("lead", "Lead", lead, volume=0.7, pan=-0.3, color="#a78bfa",
                    plugins=[{"id": "fx1", "name": "Compresseur", "type": "COMPRESSOR", "isEnabled": True, "latency": 0, "params": {"threshold": -21, "ratio": 3, "attack": 0.004, "release": 0.12, "makeupGain": 1.5}}]),
              track("beat", "Beat", beat, color="#34d399"), synth]
    state = make_state("Echange DAWproject QA", tracks, tempoEvents=[{"id": "t1", "bar": 4, "bpm": 120}])
    write_project(path, state, {"audio/voix.wav": wav([tone(SR * 20, 220)]), "audio/beat.wav": wav([tone(SR * 9, 110), tone(SR * 9, 113)])})


def beats_to_sec(beat, bpm0=90, change_beat=16, bpm1=120):
    return beat * 60 / bpm0 if beat <= change_beat else change_beat * 60 / bpm0 + (beat - change_beat) * 60 / bpm1


def reference_file(path: Path):
    """Fichier écrit comme un autre logiciel : noires, Warps, dossier, plugin VST3, son absent."""
    xml = """<?xml version="1.0" encoding="UTF-8"?>
<Project version="1.0"><Application name="Logiciel de reference" version="5.1"/>
 <Transport><Tempo unit="bpm" value="120" id="a0"/><TimeSignature numerator="4" denominator="4" id="a1"/></Transport>
 <Structure>
  <Track contentType="audio" id="t1" name="Guitare" color="#3366CC"><Channel role="regular" destination="m" id="c1">
   <Devices><Vst3Plugin deviceID="ABCDEF" deviceName="SuperReverb" deviceRole="audioFX" id="d1"><Enabled value="true" id="d1e"/></Vst3Plugin>
    <Compressor deviceName="Compressor" deviceRole="audioFX" id="d2"><Threshold unit="decibel" value="-12" id="d2t"/><Ratio unit="linear" value="2.5" id="d2r"/></Compressor></Devices>
   <Mute value="false" id="c1m"/><Pan unit="normalized" value="0.75" id="c1p"/><Volume unit="linear" value="0.5" id="c1v"/></Channel></Track>
  <Track contentType="notes" id="t2" name="Piano" color="#00AA55"><Channel role="regular" destination="m" id="c2">
   <Devices><ClapPlugin deviceID="com.x.piano" deviceName="GrandPiano" deviceRole="instrument" id="d3"/></Devices><Volume unit="linear" value="0.8" id="c2v"/></Channel></Track>
  <Track contentType="audio notes" id="tm" name="Master"><Channel role="master" id="m"><Volume unit="linear" value="1" id="mv"/></Channel></Track>
 </Structure>
 <Arrangement id="ar"><Lanes timeUnit="beats" id="l0">
  <Lanes track="t1" id="l1"><Clips id="cl1">
   <Clip time="4" duration="4" playStart="1" name="Riff"><Warps contentTimeUnit="seconds" timeUnit="beats" id="w1">
     <Audio channels="1" sampleRate="44100" duration="4" id="au1"><File path="audio/guitare.wav"/></Audio><Warp time="0" contentTime="0"/><Warp time="8" contentTime="4"/></Warps></Clip>
   <Clip time="12" duration="2" playStart="0" name="Perdu"><Audio channels="1" sampleRate="44100" duration="1" id="au2"><File path="audio/absent.wav"/></Audio></Clip>
  </Clips></Lanes>
  <Lanes track="t2" id="l2"><Clips id="cl2"><Clip time="8" duration="4" playStart="0" name="Notes"><Notes id="n1">
     <Note time="0" duration="1" key="60" vel="0.7874"/><Note time="2" duration="1" key="64" vel="1"/></Notes></Clip></Clips></Lanes>
 </Lanes><Markers id="mk"><Marker time="8" name="Refrain" id="mk1"/></Markers></Arrangement><Scenes/>
</Project>"""
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.xml", xml)
        z.writestr("metadata.xml", "<MetaData><Title>Reference</Title></MetaData>")
        z.writestr("audio/guitare.wav", wav([tone(44100 * 4, 330, sr=44100)], sr=44100))


TRACKS_JS = """s => s.tracks.map(t => ({ id: t.id, name: t.name, type: t.type, volume: t.volume, pan: t.pan, muted: !!t.isMuted, plugins: t.plugins.map(p => p.type),
  clips: t.clips.map(c => ({ name: c.name, start: c.start, duration: c.duration, offset: c.offset, fadeIn: c.fadeIn, fadeOut: c.fadeOut, gain: c.gain ?? 1,
  offline: !!c.isOffline, muted: !!c.isMuted, bufferId: c.bufferId || null, notes: (c.notes || []).map(n => [n.pitch, +n.start.toFixed(6), +n.duration.toFixed(6), n.velocity]) })) }))"""


def dialog_checks(page, sel, label):
    cov = page.evaluate(COVER_JS, f"{sel} button")
    check(f"{label} : aucun bouton recouvert", cov and all(c["ok"] for c in cov), [c for c in cov if not c["ok"]])
    fit = page.evaluate(FITS_JS, f"{sel}")
    check(f"{label} : la fenêtre tient dans l'écran, sans défilement horizontal", fit and fit["inside"] and not fit["hscroll"], fit)


def dawproject(b):
    R = res.setdefault("dawproject", {})
    log = Log("ergo_dawproject")
    ctx, page = new_page(b, "pc1366", log=log, touch=False)
    zp = OUT / "dawp_projet.zip"
    dawp_project(zp)
    open_project(page, zp, "dawp_00_projet")
    before = st(page, TRACKS_JS)
    check("projet NOVA ouvert (3 pistes, 48 kHz, changement de tempo à la mesure 4)", len([t for t in before if t["id"] != "master"]) == 3
          and st(page, "s => s.sampleRate") == SR and st(page, "s => (s.tempoEvents || []).length") == 1, before)

    # 1. Export par la palette.
    for theme in ("dark", "light"):
        set_theme(page, theme)
        palette(page, "dawproject exporter", "pal.dawpExport")
        page.locator("[data-testid=dawp-export-dialog]").wait_for(timeout=8000)
        page.wait_for_timeout(300)
        shot(page, f"dawp_01_export_{theme}")
        dialog_checks(page, "[data-testid=dawp-export-dialog]", f"export ({theme})")
        if theme == "dark":
            page.keyboard.press("Escape"); page.wait_for_timeout(200)
            page.locator("[data-testid=dawp-cancel]").click() if page.locator("[data-testid=dawp-export-dialog]").count() else None
    preview = page.locator("[data-testid=dawp-export-preview]").inner_text()
    check("export : aperçu « 3 pistes · 4 clips audio · 3 notes · 2 sons »", all(x in preview for x in ("3 pistes", "4 clips audio", "3 notes", "2 sons")), preview)
    with page.expect_download(timeout=120000) as dl:
        page.locator("[data-testid=dawp-export-go]").click()
    page.locator("[data-testid=dawp-export-done]").wait_for(timeout=60000)
    shot(page, "dawp_02_export_fait")
    out = OUT / "export.dawproject"
    dl.value.save_as(str(out))
    check("export : fichier « .dawproject » téléchargé", dl.value.suggested_filename.endswith(".dawproject"), dl.value.suggested_filename)
    page.locator("[data-testid=dawp-export-close]").click()

    # 2. Relu en Python (format ouvert : ZIP + XML).
    with zipfile.ZipFile(out) as z:
        names = sorted(z.namelist())
        proj = ET.fromstring(z.read("project.xml"))
        wavs = {n: z.read(n) for n in names if n.endswith(".wav")}
    check("export : project.xml, metadata.xml, audio/*.wav et nova/nova.json", {"project.xml", "metadata.xml", "nova/nova.json"} <= set(names) and len(wavs) == 2, names)
    tracks_xml = [t.get("name") for t in proj.iter("Track")]
    roles = [t.find("Channel").get("role") for t in proj.iter("Track")]
    check("export : pistes dans le XML (Lead, Beat, Synth, puis le master)", tracks_xml[:3] == ["Lead", "Beat", "Synth"] and roles == ["regular"] * 3 + ["master"], [tracks_xml, roles])
    lanes = {l.get("track"): l for l in proj.iter("Lanes") if l.get("track")}
    tid = {t.get("name"): t.get("id") for t in proj.iter("Track")}
    clips = lanes[tid["Lead"]].find("Clips").findall("Clip")
    got = [(round(beats_to_sec(float(c.get("time"))) * SR), round((beats_to_sec(float(c.get("time")) + float(c.get("duration"))) - beats_to_sec(float(c.get("time")))) * SR)) for c in clips]
    want = [(p, l) for (_, p, l, _, _) in LEAD]
    check("export : clips de Lead relus en noires → secondes à 0 échantillon d'écart (avant ET après le changement de tempo)", got == want, {"relu": got, "attendu": want})
    notes = [(int(n.get("key")), round(float(n.get("time")) * 60 / 90, 6)) for n in lanes[tid["Synth"]].iter("Note")]
    check("export : notes MIDI en noires (60, 64, 67)", notes == [(p, round(s, 6)) for (p, s, _, _) in NOTES], notes)
    comp = proj.find(".//Compressor")
    check("export : compresseur NOVA écrit en appareil générique du format (seuil −21 dB, ratio 3)", comp is not None and float(comp.find("Threshold").get("value")) == -21 and float(comp.find("Ratio").get("value")) == 3,
          None if comp is None else {c.tag: c.get("value") for c in comp})
    wb = wavs[[n for n in wavs if "Prise" in n][0]]
    fmt = wb.find(b"fmt ")
    tag, nch, rate = struct.unpack_from("<HHI", wb, fmt + 8)
    check("export : WAV lisible (RIFF, 32 bits flottants, 48 kHz)", wb[:4] == b"RIFF" and tag == 3 and rate == SR, [wb[:4], tag, nch, rate])
    R["fichier"] = {"taille": out.stat().st_size, "fichiers": names}

    # 3. Réouvert dans NOVA (aller-retour).
    ids_before = {t["id"] for t in st(page, TRACKS_JS)}
    palette(page, "dawproject ouvrir", "pal.dawpImport")
    page.locator("[data-testid=dawp-import-dialog]").wait_for(timeout=8000)
    shot(page, "dawp_03_import_choisir")
    page.set_input_files("[data-testid=dawp-input]", str(out))
    page.locator("[data-testid=dawp-review]").wait_for(timeout=60000)
    shot(page, "dawp_04_import_apercu")
    dialog_checks(page, "[data-testid=dawp-import-dialog]", "import (aperçu)")
    prev = page.locator("[data-testid=dawp-preview]").inner_text()
    check("import : aperçu « 3 pistes · 5 clips · 90 BPM · fait avec NOVA »", all(x in prev for x in ("3 pistes", "5 clips", "90 BPM", "fait avec NOVA")), prev)
    t0 = time.time()
    page.locator("[data-testid=dawp-import-go]").click()
    page.locator("[data-testid=dawp-import-report]").wait_for(timeout=120000)
    R["import_ms"] = round((time.time() - t0) * 1000)
    rep = page.locator("[data-testid=dawp-import-report]").inner_text()
    shot(page, "dawp_05_import_rapport")
    page.locator("[data-testid=dawp-import-close]").click()
    after = st(page, TRACKS_JS)
    new = [t for t in after if t["id"] not in ids_before]
    check("import : 3 pistes ajoutées (Lead 2, Beat 2, Synth 2)", [t["name"] for t in new] == ["Lead 2", "Beat 2", "Synth 2"], [t["name"] for t in new])
    orig = {t["name"]: t for t in before}
    bad = []
    for t in new:
        o = orig[t["name"][:-2]]
        for c, e in zip(t["clips"], o["clips"]):
            if (round(c["start"] * SR), round(c["duration"] * SR), round(c["offset"] * SR)) != (round(e["start"] * SR), round(e["duration"] * SR), round(e["offset"] * SR)) \
                    or abs(c["fadeIn"] - e["fadeIn"]) > 1e-9 or abs(c["fadeOut"] - e["fadeOut"]) > 1e-9 or abs(c["gain"] - e["gain"]) > 1e-9 or c["notes"] != e["notes"] or c["offline"]:
                bad.append({"piste": t["name"], "clip": c, "attendu": e})
        if (t["volume"], t["pan"], t["plugins"], len(t["clips"])) != (o["volume"], o["pan"], o["plugins"], len(o["clips"])):
            bad.append({"piste": t["name"], "reglages": [t["volume"], t["pan"], t["plugins"]], "attendu": [o["volume"], o["pan"], o["plugins"]]})
    check("aller-retour NOVA → DAWproject → NOVA : clips à 0 échantillon, fondus, gain, notes, volume, pan, effets identiques", not bad, bad[:3])
    son = page.evaluate("""async () => { const { audioBufferRegistry: R } = await window.__novaAppModule('/utils/audioBufferRegistry.ts');
      const s = window.DAW_CONTROL.getState(); const a = s.tracks.find(t => t.name === 'Lead').clips[0], b = s.tracks.find(t => t.name === 'Lead 2').clips[0];
      const x = R.get(a.bufferId).getChannelData(0), y = R.get(b.bufferId).getChannelData(0); let d = 0; for (let i = 0; i < x.length; i++) d = Math.max(d, Math.abs(x[i] - y[i]));
      return { n: [x.length, y.length], diff: d }; }""")
    check("aller-retour : son identique au bit près", son["n"][0] == son["n"][1] and son["diff"] == 0, son)
    page.keyboard.press("Control+z"); page.wait_for_timeout(600)
    check("Ctrl+Z annule l'import en une fois", len(st(page, "s => s.tracks")) == len(before), len(st(page, "s => s.tracks")))

    # 4. Fichier de référence d'un autre logiciel (glissé sur NOVA).
    ref = OUT / "reference.dawproject"
    reference_file(ref)
    palette(page, "dawproject ouvrir", "pal.dawpImport")
    page.locator("[data-testid=dawp-import-dialog]").wait_for(timeout=8000)
    page.set_input_files("[data-testid=dawp-input]", str(ref))
    page.locator("[data-testid=dawp-review]").wait_for(timeout=60000)
    warn = page.locator("[data-testid=dawp-warnings]").inner_text() if page.locator("[data-testid=dawp-warnings]").count() else ""
    shot(page, "dawp_06_reference_apercu")
    check("référence : plugins et son absent annoncés AVANT l'import", "SuperReverb" in warn and "GrandPiano" in warn and "son absent" in warn and "garde sa place" in warn, warn)
    page.locator("[data-testid=dawp-import-go]").click()
    page.locator("[data-testid=dawp-import-report]").wait_for(timeout=60000)
    rep = page.locator("[data-testid=dawp-import-report]").inner_text()
    shot(page, "dawp_07_reference_rapport")
    check("référence : rapport « plugins absents … à remplacer à la main » et fichier introuvable nommé", "plugins absents" in rep and "SuperReverb" in rep and "absent.wav" in rep, rep[:600])
    page.locator("[data-testid=dawp-import-close]").click()
    g = st(page, "s => { const t = s.tracks.find(x => x.name === 'Guitare'); return t && { vol: t.volume, pan: t.pan, fx: t.plugins.map(p => p.type), c: t.clips.map(c => [c.start, c.duration, c.offset, !!c.isOffline]) }; }")
    check("référence : Guitare à 0,5 / pan 0,5, compresseur repris, clip à 2 s (décalage 0,5 s), clip perdu gardé muet",
          g and g["vol"] == 0.5 and g["pan"] == 0.5 and g["fx"] == ["COMPRESSOR"] and abs(g["c"][0][0] - 2) < 1e-9 and abs(g["c"][0][2] - 0.5) < 1e-9 and g["c"][1][3], g)
    errs = log.errors()
    check("DAWproject bureau : aucune erreur dans la console", not errs, errs[:5])
    save_log(log)
    ctx.close()

    # Téléphone (390) : la fenêtre d'import tient à l'écran, au doigt, sombre et clair.
    for theme in ("dark", "light"):
        log = Log(f"ergo_dawproject_tel_{theme}")
        ctx, page = new_page(b, "tel390", log=log, touch=True)
        page.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); }} catch (e) {{}}")
        open_project(page, zp, f"dawp_tel_{theme}_00", touch=True)
        page.evaluate("async () => (await window.__novaAppModule('/utils/dawproject/dawProjectBus.ts')).openDawProjectImport()")
        page.locator("[data-testid=dawp-import-dialog]").wait_for(timeout=8000)
        page.set_input_files("[data-testid=dawp-input]", str(ref))
        page.locator("[data-testid=dawp-review]").wait_for(timeout=60000)
        page.wait_for_timeout(300)
        shot(page, f"dawp_tel_{theme}_01_apercu")
        dialog_checks(page, "[data-testid=dawp-import-dialog]", f"téléphone {theme} : import")
        page.locator("[data-testid=dawp-cancel]").tap()
        errs = log.errors()
        check(f"téléphone {theme} : aucune erreur dans la console", not errs, errs[:5])
        save_log(log)
        ctx.close()


SECTIONS = {"dawproject": dawproject}

if __name__ == "__main__":
    wanted = [a for a in sys.argv[1:] if a in SECTIONS] or list(SECTIONS)
    with sync_playwright() as p:
        b = launch(p)
        try:
            for name in wanted:
                try:
                    SECTIONS[name](b)
                except Exception as e:  # une section qui casse n'empêche pas les autres
                    check(f"{name} : déroulé sans exception", False, repr(e)[:600])
        finally:
            b.close()
    res["verifications"] = checks
    res["bilan"] = {"ok": sum(c["ok"] for c in checks), "total": len(checks)}
    (OUT / "ergo_pro.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print("\nBILAN :", json.dumps(res["bilan"], ensure_ascii=False))
    sys.exit(0 if checks and all(c["ok"] for c in checks) else 1)
