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
  let inView = x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight;
  // Bouton défilé hors de sa zone (ou sous la barre collante de cette zone) : pas « recouvert ».
  for (let p = b.parentElement; p && inView; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1) {
      const pr = p.getBoundingClientRect();
      if (y < pr.top || y > pr.bottom) inView = false;
      else if (hit && p.contains(hit)) { for (let h = hit; h && h !== p; h = h.parentElement) if (getComputedStyle(h).position === 'sticky') { inView = false; break; } }
      break;
    }
  }
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
    page.wait_for_function("() => document.activeElement && document.activeElement.closest('[data-testid=command-palette]')", timeout=4000)
    page.keyboard.type(query, delay=10)
    page.wait_for_timeout(250)
    opt = page.locator(f"[data-testid=command-palette] [data-palette-id='{want}']").first
    try:
        first = page.locator("[data-testid=command-palette] [role=option]").first.get_attribute("data-palette-id", timeout=5000)
    except Exception:
        shot(page, f"palette_vide_{re.sub(r'[^a-z]+', '_', query)}")
        raise
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


# ── Épingler et filtrer (grosses séances) ──────────────────────────────────────────────────
def big_project(path: Path):
    kinds = [("Lead", "#a78bfa"), ("Back", "#a78bfa"), ("Adlib", "#a78bfa"), ("Kick", "#f97316"), ("Snare", "#f97316"), ("Hats", "#f97316"), ("Basse", "#34d399"), ("Pad", "#34d399")]
    tracks = []
    for i in range(48):
        n, c = kinds[i % len(kinds)]
        tracks.append(track(f"t{i}", f"{n} {i // len(kinds) + 1}", [aclip(f"c{i}", f"{n} clip", 1 + (i % 6) * 2.5, 4, "audio/son.wav", color=c)], color=c))
    write_project(path, make_state("Grosse seance QA", tracks), {"audio/son.wav": wav([tone(SR * 5, 330)])})


PANE_JS = """() => { const p = document.querySelector('[data-testid=pinned-tracks]'); if (!p) return null; const r = p.getBoundingClientRect();
  const rows = [...p.querySelectorAll('[data-testid^=pinned-row-]')].map(x => x.dataset.testid.slice(11));
  const clip = p.querySelector('[data-pinned-clip]'); const lane = p.querySelector('[data-testid^=pinned-lane-]');
  const sc = document.querySelector('main [data-follow]');
  return { y: Math.round(r.y), h: Math.round(r.height), bottom: Math.round(r.bottom), vh: innerHeight, rows, count: +p.dataset.pinnedCount,
           clipX: clip ? clip.getBoundingClientRect().x : null, laneX: lane ? lane.getBoundingClientRect().x : null,
           scrollTop: sc ? sc.scrollTop : null, scrollLeft: sc ? sc.scrollLeft : null }; }"""

PROJECT_SIG = "s => JSON.stringify(s.tracks.map(t => [t.id, t.isHidden || false, t.isMuted, t.isSolo, t.volume, t.pan, t.clips.length]))"


def epingler(b):
    R = res.setdefault("epingler", {})
    zp = OUT / "grosse_seance.zip"
    big_project(zp)
    for vp, theme in (("pc1366", "dark"), ("pc1366", "light"), ("tab", "dark")):
        log = Log(f"ergo_epingler_{vp}_{theme}")
        ctx, page = new_page(b, vp, log=log, touch=False)
        page.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); }} catch (e) {{}}")
        open_project(page, zp, f"pin_{vp}_{theme}_00")
        tag = f"{vp} {theme}"
        before = st(page, PROJECT_SIG)
        palette(page, "filtrer pistes", "pal.trackSearch")
        page.locator("[data-testid=track-list-panel]").wait_for(timeout=8000)
        page.wait_for_timeout(400)
        focused = page.evaluate("() => document.activeElement && document.activeElement.dataset.testid")
        check(f"{tag} : la palette ouvre la liste des pistes, curseur dans la recherche", focused == "tracklist-search", focused)
        t0 = time.time()
        page.locator("[data-testid=tracklist-kind-voix]").click()
        page.locator("[data-testid=tracklist-count]").wait_for(timeout=3000)
        ms = round((time.time() - t0) * 1000)
        cnt = page.locator("[data-testid=tracklist-count]").inner_text()
        check(f"{tag} : filtre « Voix » : 18 pistes sur 48 ({ms} ms au clic, affichage compris)", cnt.startswith("18 pistes sur 48") and ms < 1000, [cnt, ms])
        R[f"filtre_voix_ms_{tag}"] = ms
        page.locator("[data-testid=tracklist-search]").fill("lead")
        page.wait_for_timeout(200)
        cnt2 = page.locator("[data-testid=tracklist-count]").inner_text()
        check(f"{tag} : « Voix » + « lead » : 6 pistes", cnt2.startswith("6 pistes"), cnt2)
        shot(page, f"pin_{vp}_{theme}_01_filtre")
        cov = page.evaluate(COVER_JS, "[data-testid=track-list-panel] button")
        check(f"{tag} : liste des pistes : aucun bouton recouvert", cov and all(c["ok"] for c in cov), [c for c in cov if not c["ok"]][:5])
        page.locator("[data-testid=tracklist-pin-t0]").click()
        page.locator("[data-testid=tracklist-pin-t16]").click()
        page.wait_for_timeout(400)
        g = page.evaluate(PANE_JS)
        check(f"{tag} : 2 pistes épinglées dans le bandeau au-dessus de l'arrangement", g and g["rows"] == ["t0", "t16"], g)
        if theme == "dark" and vp == "pc1366":
            page.locator("[data-testid=tracklist-show-only]").click(); page.wait_for_timeout(500)
            hidden = st(page, "s => s.tracks.filter(t => t.isHidden).length")
            check("« N'afficher que celles-ci » : 42 pistes masquées (elles jouent toujours)", hidden == 42, hidden)
            page.locator("[data-testid=track-list-panel] button[aria-label=Fermer]").click()
            page.mouse.click(700, 600); page.keyboard.press("Control+z"); page.wait_for_timeout(500)
            check("Ctrl+Z : tout est réaffiché", st(page, "s => s.tracks.filter(t => t.isHidden).length") == 0)
        else:
            page.locator("[data-testid=track-list-panel] button[aria-label=Fermer]").click()
        page.wait_for_timeout(300)
        # Défiler l'arrangement tout en bas : le bandeau reste en haut, calé sur le zoom.
        page.evaluate("() => { const sc = document.querySelector('main [data-follow]'); sc.scrollTop = sc.scrollHeight; }")
        page.wait_for_timeout(500)
        g1 = page.evaluate(PANE_JS)
        z = page.evaluate("async () => { const W = await window.__novaAppModule('/utils/windowLayouts.ts'); return W.readLayoutPart('zoom'); }")
        check(f"{tag} : défilé tout en bas, les pistes épinglées restent visibles en haut", g1 and g1["scrollTop"] > 200 and g1["rows"] == ["t0", "t16"] and g1["bottom"] < g1["vh"] * 0.6, g1)
        want = g1["laneX"] + 1 * z["h"] - g1["scrollLeft"]
        check(f"{tag} : clip épinglé calé sur le zoom de l'arrangement (±1 px)", abs(g1["clipX"] - want) <= 1, {"clipX": g1["clipX"], "attendu": want, "zoom": z})
        page.evaluate("() => { const sc = document.querySelector('main [data-follow]'); sc.scrollLeft = 120; }")
        page.wait_for_timeout(500)
        g2 = page.evaluate(PANE_JS)
        check(f"{tag} : défilement horizontal suivi par le bandeau", abs((g1["clipX"] - g2["clipX"]) - (g2["scrollLeft"] - g1["scrollLeft"])) <= 1, [g1, g2])
        shot(page, f"pin_{vp}_{theme}_02_defile")
        cov = page.evaluate(COVER_JS, "[data-testid=pinned-tracks] button")
        check(f"{tag} : bandeau : aucun bouton recouvert", cov and all(c["ok"] for c in cov), [c for c in cov if not c["ok"]][:5])
        after = st(page, PROJECT_SIG)
        check(f"{tag} : épingler ne change rien au projet (son, export)", after == before)
        if vp == "pc1366" and theme == "dark":
            page.locator("[data-testid=pinned-mute-t0]").click(); page.wait_for_timeout(300)
            check("bandeau : M coupe la piste épinglée", st(page, "s => s.tracks.find(t => t.id === 't0').isMuted") is True)
            page.locator("[data-testid=pinned-mute-t0]").click()
            page.locator("[data-testid=pinned-unpin-t16]").click(); page.wait_for_timeout(300)
            check("bandeau : 📌 désépingle", page.evaluate(PANE_JS)["rows"] == ["t0"])
            pins_js = "async () => (await window.__novaAppModule('/utils/trackPins.ts')).pinnedIds()"
            sel = st(page, "s => s.selectedTrackId")
            p0 = page.evaluate(pins_js)
            palette(page, "épingler piste sélectionnée", "pal.trackPin")
            page.wait_for_timeout(300)
            p1 = page.evaluate(pins_js)
            check("palette : « Épingler / désépingler la piste sélectionnée » bascule son épingle", (sel in p0) != (sel in p1), [sel, p0, p1])
        errs = log.errors()
        check(f"{tag} : aucune erreur dans la console", not errs, errs[:5])
        save_log(log)
        ctx.close()


# ── Macros ──────────────────────────────────────────────────────────────────────────────
MACRO_STEPS = [("nouvelle piste audio", "pal.audioTrack"), ("nouveau bus", "pal.bus"), ("retour réverbe", "pal.reverbReturn"),
               ("retour écho", "pal.delayReturn"), ("nouvelle piste audio", "pal.audioTrack")]


def macros(b):
    R = res.setdefault("macros", {})
    zp = OUT / "macros_projet.zip"
    write_project(zp, make_state("Macros QA", [track("t0", "Lead", [aclip("c0", "Prise", 1, 4, "audio/son.wav")])]), {"audio/son.wav": wav([tone(SR * 5, 330)])})
    for vp, theme in (("pc1366", "dark"), ("pc1366", "light"), ("tab", "dark")):
        log = Log(f"ergo_macros_{vp}_{theme}")
        ctx, page = new_page(b, vp, log=log, touch=False)
        page.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); }} catch (e) {{}}")
        open_project(page, zp, f"macro_{vp}_{theme}_00")
        tag = f"{vp} {theme}"
        main_run = vp == "pc1366" and theme == "dark"
        if main_run:
            # Deux commandes lancées dans la palette : elles serviront à « Reprendre mes dernières commandes ».
            palette(page, "liste des pistes", "pal.trackList"); page.wait_for_timeout(300); page.keyboard.press("Escape")
            palette(page, "groupes de pistes", "pal.groups"); page.wait_for_timeout(300); page.keyboard.press("Escape")
        palette(page, "macros enchaîner", "pal.macros")
        page.locator("[data-testid=macros-panel]").wait_for(timeout=8000)
        check(f"{tag} : la palette ouvre l'éditeur de raccourcis sur l'onglet Macros", page.locator("[data-testid=keymap-tab-macros][aria-selected=true]").count() == 1)
        page.locator("[data-testid=macros-new]").click()
        page.locator("[data-testid=macro-name]").fill("Préparer la séance")
        if main_run:
            page.locator("[data-testid=macro-from-recent]").click()
            n_recent = page.locator("[data-testid=macro-steps] li").count()
            check("« Reprendre mes dernières commandes de la palette » ajoute les commandes lancées", n_recent >= 2, n_recent)
            for _ in range(n_recent):
                page.locator("[data-testid=macro-steps] li button[aria-label=Retirer]").first.click()
        for q, want in MACRO_STEPS:
            page.locator("[data-testid=macro-search]").fill(q)
            page.locator(f"[data-testid=macro-search-results] [data-step-id='{want}']").first.click()
        steps = page.locator("[data-testid=macro-steps] li").count()
        check(f"{tag} : 5 commandes dans la macro", steps == 5, steps)
        page.locator("[data-testid=macro-key]").click()
        page.locator("[data-testid=macro-capture]").wait_for(timeout=3000)
        page.keyboard.press("Control+z")
        warn = page.locator("[data-testid=macros-message]").inner_text()
        check(f"{tag} : Ctrl+Z refusé comme touche de macro (déjà pris), raison donnée", "sert déjà" in warn and "Annuler" in warn, warn)
        page.locator("[data-testid=macro-key]").click()
        page.locator("[data-testid=macro-capture]").wait_for(timeout=3000)
        page.keyboard.press("Control+Alt+Shift+M")
        key_txt = page.locator("[data-testid=macro-key]").inner_text()
        check(f"{tag} : touche Ctrl+Alt+Maj+M posée", "M" in key_txt and "Ctrl" in key_txt, key_txt)
        shot(page, f"macro_{vp}_{theme}_01_editeur")
        cov = page.evaluate(COVER_JS, "[data-testid=keymap-editor] button")
        check(f"{tag} : éditeur de macros : aucun bouton recouvert", cov and all(c["ok"] for c in cov), [c for c in cov if not c["ok"]][:5])
        fit = page.evaluate(FITS_JS, "[data-testid=keymap-editor] > div")
        check(f"{tag} : la fenêtre tient dans l'écran", fit and fit["inside"] and not fit["hscroll"], fit)
        page.locator("[data-testid=macro-save]").click()
        msg = page.locator("[data-testid=macros-message]").inner_text()
        check(f"{tag} : macro enregistrée (message clair)", "enregistrée" in msg and "5 commandes" in msg, msg)
        shot(page, f"macro_{vp}_{theme}_02_liste")
        page.locator("[data-testid=keymap-editor] button[aria-label=Fermer]").first.click()
        page.wait_for_timeout(300)
        n0 = st(page, "s => s.tracks.length")
        page.mouse.click(700, 500)
        page.keyboard.press("Control+Alt+Shift+M")
        page.wait_for_function("() => window.__novaLastMacro", timeout=8000)
        page.wait_for_timeout(600)
        last = page.evaluate("() => window.__novaLastMacro")
        n1 = st(page, "s => s.tracks.length")
        check(f"{tag} : la touche joue les 5 commandes (5 pistes créées en {round(last['ms'])} ms)", last["ok"] and len(last["ran"]) == 5 and n1 >= n0 + 5, {"avant": n0, "apres": n1, "run": last})
        R[f"ms_{tag}"] = round(last["ms"], 1)
        mid_main = last["id"]
        shot(page, f"macro_{vp}_{theme}_03_jouee")
        page.keyboard.press("Control+z"); page.wait_for_timeout(600)
        n2 = st(page, "s => s.tracks.length")
        check(f"{tag} : UN seul Ctrl+Z annule toute la macro", n2 == n0, {"avant": n0, "apres_macro": n1, "apres_ctrl_z": n2})
        if main_run:
            # Macro d'édition « légère » (5 commandes de la table) : durée mesurée.
            # Commandes indépendantes (express) : repère, mesure suivante, repère, muet de la piste, mesure suivante.
            light = ["nova.marker", "nova.barNext", "nova.marker", "pt.muteSelected", "nova.barNext"]
            mid = page.evaluate("""async (steps) => { const M = await window.__novaAppModule('/utils/macros.ts');
              return M.saveMacro({ id: 'qa-leger', name: 'Édition rapide', steps, keys: 'ctrl+alt+shift+l', express: true }).id; }""", light)
            sig0 = st(page, "s => JSON.stringify([s.markers.length, s.tracks.map(t => [t.isMuted, t.clips.map(c => [c.fadeIn, c.fadeOut])])])")
            page.mouse.click(700, 500)
            page.evaluate("() => { window.__novaLastMacro = null; }")
            page.keyboard.press("Control+Alt+Shift+L")
            page.wait_for_function("() => window.__novaLastMacro && window.__novaLastMacro.id === 'qa-leger'", timeout=8000)
            lr = page.evaluate("() => window.__novaLastMacro")
            page.wait_for_timeout(400)
            sig1 = st(page, "s => JSON.stringify([s.markers.length, s.tracks.map(t => [t.isMuted, t.clips.map(c => [c.fadeIn, c.fadeOut])])])")
            R["leger_ms"] = round(lr["ms"], 1)
            R["leger_run_ms"] = round(lr["runMs"], 1)
            check(f"macro express de 5 commandes jouée en moins de 100 ms ({round(lr['runMs'])} ms, écran à jour à {round(lr['ms'])} ms)", lr["ok"] and len(lr["ran"]) == 5 and lr["runMs"] < 100 and sig1 != sig0, {"run": lr, "avant": sig0, "apres": sig1})
            page.keyboard.press("Control+z"); page.wait_for_timeout(500)
            sig2 = st(page, "s => JSON.stringify([s.markers.length, s.tracks.map(t => [t.isMuted, t.clips.map(c => [c.fadeIn, c.fadeOut])])])")
            check("macro d'édition : un seul Ctrl+Z revient à l'état d'avant", sig2 == sig0, [sig0, sig1, sig2])
            page.evaluate("async () => (await window.__novaAppModule('/utils/macros.ts')).deleteMacro('qa-leger')")
            palette(page, "macro préparer", "macro:" + mid_main)
            page.wait_for_timeout(800)
            check("la macro est aussi dans la palette Ctrl+K (« ▶ Macro : … »)", st(page, "s => s.tracks.length") >= n0 + 5)
            page.keyboard.press("Control+z"); page.wait_for_timeout(500)
            # Export puis import du fichier .novamacros.
            palette(page, "macros enchaîner", "pal.macros")
            page.locator("[data-testid=macros-panel]").wait_for(timeout=8000)
            with page.expect_download(timeout=30000) as dl:
                page.locator("[data-testid=macros-export]").click()
            mf = OUT / "macros.novamacros"
            dl.value.save_as(str(mf))
            data = json.loads(mf.read_text(encoding="utf-8"))
            check("export .novamacros : 1 macro, 5 commandes, touche", data.get("format") == "novamacros" and len(data["macros"]) == 1 and len(data["macros"][0]["steps"]) == 5 and data["macros"][0]["keys"] == "ctrl+alt+shift+m", data)
            page.once("dialog", lambda d: d.accept())
            page.locator("[data-testid=macros-list] button", has_text="Supprimer").first.click()
            page.wait_for_timeout(300)
            page.set_input_files("[data-testid=macros-import-file]", str(mf))
            page.wait_for_timeout(500)
            imp = page.locator("[data-testid=macros-message]").inner_text()
            check("import .novamacros : la macro revient", "1 macro importée" in imp and page.locator("[data-testid=macros-list] [data-macro]").count() == 1, imp)
        errs = log.errors()
        check(f"{tag} : aucune erreur dans la console", not errs, errs[:5])
        save_log(log)
        ctx.close()


# ── Console sur un 2e écran ─────────────────────────────────────────────────────────────
METER_JS = """async () => { const cv = [...document.querySelectorAll('[data-testid=popout-console] canvas')].filter(c => c.width > 0 && c.height > 0);
  const sig = () => cv.map(c => { try { return c.toDataURL().length + ':' + c.toDataURL().slice(-40); } catch (e) { return ''; } }).join('|');
  let last = sig(), changes = 0; const t0 = performance.now();
  while (performance.now() - t0 < 1000) { await new Promise(r => setTimeout(r, 15)); const s = sig(); if (s !== last) { changes++; last = s; } }
  return { canvases: cv.length, changes }; }"""


def shot_cdp(page, name):
    """Capture d'une fenêtre détachée (about:blank) : sans attendre ses polices (Page.captureScreenshot)."""
    import base64
    cdp = page.context.new_cdp_session(page)
    data = cdp.send("Page.captureScreenshot", {"format": "png"})["data"]
    (OUT / f"{name}.png").write_bytes(base64.b64decode(data))
    cdp.detach()


def deuxieme_ecran(b):
    R = res.setdefault("deuxieme_ecran", {})
    zp = OUT / "console_projet.zip"
    write_project(zp, make_state("Console QA", [track("lead", "Lead", [aclip("c0", "Prise", 0, 12, "audio/son.wav")], color="#a78bfa"),
                                                track("beat", "Beat", [aclip("c1", "Beat", 0, 12, "audio/beat.wav")], color="#34d399")]),
                  {"audio/son.wav": wav([tone(SR * 12, 330, amp=0.5)]), "audio/beat.wav": wav([tone(SR * 12, 110, amp=0.5), tone(SR * 12, 111, amp=0.5)])})
    for theme in ("dark", "light"):
        log = Log(f"ergo_console_{theme}")
        ctx, page = new_page(b, "pc1366", log=log, touch=False)
        page.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); }} catch (e) {{}}")
        open_project(page, zp, f"console_{theme}_00")
        with ctx.expect_page(timeout=15000) as pop_info:
            palette(page, "console 2e écran", "pal.consolePopout")
        pop = pop_info.value
        pop.wait_for_selector("[data-testid=popout-console]", timeout=15000)
        pop.wait_for_selector("[role=slider][aria-label='Volume Lead']", timeout=20000)
        pop.wait_for_timeout(800)
        check(f"{theme} : la console s'ouvre dans une 2e fenêtre (portail, même studio)", pop.locator("[role=slider][aria-label='Volume Lead']").count() == 1
              and pop.evaluate("() => document.title") == "Console · NOVA", pop.evaluate("() => document.title"))
        th = pop.evaluate("() => [document.documentElement.className, getComputedStyle(document.body).backgroundColor]")
        main_th = page.evaluate("() => document.documentElement.className")
        check(f"{theme} : la fenêtre détachée suit le thème et les styles du studio", th[0] == main_th, [th, main_th])
        if theme == "dark":
            # Mixer dans la fenêtre principale : remplacé par « La console est sur l'autre écran ».
            page.evaluate("() => window.DAW_CONTROL.setView('MIXER')"); page.wait_for_timeout(500)
            check("fenêtre principale en vue Mixer : « La console est sur l'autre écran »", page.locator("[data-testid=console-elsewhere]").count() == 1)
            shot(page, "console_dark_01_principale_mixer")
            page.evaluate("() => window.DAW_CONTROL.setView('ARRANGEMENT')"); page.wait_for_timeout(400)
            # Fader déplacé dans la fenêtre détachée : l'état du studio suit.
            v0 = st(page, "s => s.tracks.find(t => t.id === 'lead').volume")
            f = pop.locator("[role=slider][aria-label='Volume Lead']").bounding_box()
            pop.mouse.move(f["x"] + f["width"] / 2, f["y"] + f["height"] * 0.5)
            pop.mouse.down(); pop.mouse.move(f["x"] + f["width"] / 2, f["y"] + f["height"] * 0.5 - 60, steps=6); pop.mouse.up()
            pop.wait_for_timeout(300)
            v1 = st(page, "s => s.tracks.find(t => t.id === 'lead').volume")
            check("fader glissé dans la 2e fenêtre : volume du studio changé", v1 != v0, [v0, v1])
            # Automation : piste en « latch », lecture, fader bougé → points écrits.
            page.evaluate("() => { const t = window.DAW_CONTROL.getState().tracks.find(x => x.id === 'lead'); window.DAW_CONTROL.updateTrack({ ...t, automationMode: 'latch' }); }")
            page.wait_for_timeout(300)
            page.evaluate("() => window.DAW_CONTROL.togglePlay()")
            pop.wait_for_timeout(900)
            met = pop.evaluate(METER_JS)
            R["vumetres"] = met
            check(f"vumètres de la 2e fenêtre animés pendant la lecture (~30 images/s : {met['changes']} images en 1 s)", met["canvases"] >= 2 and met["changes"] >= 20, met)
            f = pop.locator("[role=slider][aria-label='Volume Lead']").bounding_box()
            pop.mouse.move(f["x"] + f["width"] / 2, f["y"] + f["height"] * 0.45)
            pop.mouse.down()
            for k in range(8):
                pop.mouse.move(f["x"] + f["width"] / 2, f["y"] + f["height"] * (0.45 - 0.03 * k)); pop.wait_for_timeout(80)
            pop.mouse.up()
            pop.wait_for_timeout(400)
            page.evaluate("() => window.DAW_CONTROL.stop()")
            page.wait_for_timeout(600)
            pts = st(page, "s => { const l = (s.tracks.find(t => t.id === 'lead').automationLanes || []).find(l => l.parameterName === 'volume'); return l ? l.points.length : 0; }")
            check("fader bougé pendant la lecture dans la 2e fenêtre : automation de volume écrite", pts >= 2, pts)
            shot(pop, "console_dark_02_fenetre_detachee")
            # Touche dans la 2e fenêtre : Espace lance la lecture du studio.
            pop.keyboard.press("Space"); page.wait_for_timeout(500)
            playing = st(page, "s => s.isPlaying")
            page.evaluate("() => window.DAW_CONTROL.stop()")
            check("Espace dans la 2e fenêtre : lecture du studio", playing is True, playing)
        else:
            shot(pop, "console_light_02_fenetre_detachee")
        cov = pop.evaluate(COVER_JS, "[data-testid=popout-console] > div:first-child button")
        check(f"{theme} : barre de la 2e fenêtre : rien de recouvert", cov and all(c["ok"] for c in cov), cov)
        # Fermer la 2e fenêtre : la console revient dans la fenêtre principale.
        pop.evaluate("() => { window.resizeTo && window.resizeTo(1500, 820); }")
        pop.close()
        page.wait_for_timeout(1200)
        is_open = page.evaluate("async () => (await window.__novaAppModule('/utils/popoutWindow.ts')).popoutStore.isOpen('console')")
        page.evaluate("() => window.DAW_CONTROL.setView('MIXER')"); page.wait_for_timeout(800)
        back = page.locator("[role=slider][aria-label='Volume Lead']").count()
        check(f"{theme} : fermer la 2e fenêtre ramène la console dans la fenêtre principale", not is_open and back == 1 and page.locator("[data-testid=console-elsewhere]").count() == 0, [is_open, back])
        shot(page, f"console_{theme}_03_retour")
        geo = page.evaluate("() => JSON.parse(localStorage.getItem('nova_popout_geometry_v1') || '{}')")
        check(f"{theme} : place et taille de la fenêtre retenues pour la réouverture", bool(geo.get("console")) and geo["console"]["w"] >= 320, geo)
        if theme == "dark":
            # Disposition de fenêtres : enregistrée avec la console détachée, rappelée → la fenêtre se rouvre.
            page.evaluate("() => window.DAW_CONTROL.setView('ARRANGEMENT')")
            with ctx.expect_page(timeout=15000) as p2:
                palette(page, "dispositions de fenêtres", "layout.list")
                page.locator("[data-testid=layouts-popout-console]").click()
            pop2 = p2.value
            pop2.wait_for_selector("[data-testid=popout-console]", timeout=15000)
            page.once("dialog", lambda d: d.accept())
            page.locator("[data-testid=layout-save-4]").click(); page.wait_for_timeout(300)
            shot(page, "console_dark_04_dispositions")
            page.locator("[data-testid=layouts-panel] button[aria-label=Fermer]").click()
            pop2.close(); page.wait_for_timeout(800)
            with ctx.expect_page(timeout=15000) as p3:
                page.keyboard.press("Control+Shift+4")
            pop3 = p3.value
            pop3.wait_for_selector("[data-testid=popout-console]", timeout=15000)
            check("disposition 4 rappelée (Ctrl+Maj+4) : la console se rouvre sur le 2e écran", pop3.locator("[role=slider][aria-label='Volume Lead']").count() == 1)
            pop3.close()
        errs = [e for e in log.errors()]
        check(f"{theme} : aucune erreur dans la console", not errs, errs[:5])
        save_log(log)
        ctx.close()


SECTIONS = {"dawproject": dawproject, "epingler": epingler, "macros": macros, "deuxieme_ecran": deuxieme_ecran}

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
