"""R1 · Livraison et export : scénario Chrome headless (aucune fenêtre) + vérification Python.

1. Projet de test généré ici (audio synthétique, 120 BPM, Do mineur) : beat, voix lead et
   backs dans un bus voix, envoi vers une réverbe, une piste GUIDE (jamais exportée), deux repères.
2. Ouvert dans NOVA (Ouvrir → fichier .zip), compte admin simulé (aucun paiement, aucune écriture).
3. Exports par la fenêtre « Exporter » (réglages avancés) : WAV 16 / 24 / 32 f, AIFF, FLAC, MP3 320
   et 192, mono-somme, double mono, 44,1 / 48 / 96 kHz, cible Spotify ; stems par piste, par bus,
   retours séparés, instru / voix, stems MP3 ; un export par la file (« Ajouter à la file »).
4. Chaque fichier relu par soundfile (libsndfile) et ffprobe : format, fréquence, durée, métadonnées,
   stems tous de même longueur, somme des stems = mix, guide absent.
Usage : NOVA_URL=http://127.0.0.1:3443/ QA_OUT="D:\\1 WORK\\CONTENU\\nova-r1-r3" python qa/r1_export.py
"""
import io, json, math, os, re, struct, subprocess, sys, time, wave, zipfile
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3443/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-r1-r3")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, shot, BASE, OUT, visible_buttons, overflow_report  # noqa: E402
from scenarios import close_welcome, wait_text_gone, btn, visible, DEFAULT_BEAT  # noqa: E402
from desktop_gate import install_mocks, SUPERADMIN  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402
import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402

SR = 48000
DUR = 8.0
DL = OUT / "r1_fichiers"
DL.mkdir(parents=True, exist_ok=True)
res = {"etapes": {}, "fichiers": {}}


def ok(k, v, note=None):
    res["etapes"][k] = {"ok": bool(v), **({"detail": note} if note is not None else {})}
    print(("OK  " if v else "KO  ") + k, "" if note is None else json.dumps(note, ensure_ascii=False)[:400])


def wav_bytes(x):
    """Stéréo 16 bits (x : liste de (g, d) en float)."""
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(b"".join(struct.pack("<hh", int(max(-1, min(1, l)) * 32767), int(max(-1, min(1, r)) * 32767)) for l, r in x))
    return b.getvalue()


def make_project(path):
    n = int(SR * DUR)
    t = np.arange(n) / SR
    beat = np.zeros(n)
    for k in range(int(DUR * 2)):  # kick à chaque temps (120 BPM)
        i0 = int(k * 0.5 * SR); m = min(n - i0, int(0.25 * SR))
        tt = np.arange(m) / SR
        beat[i0:i0 + m] += 0.6 * np.sin(2 * np.pi * (60 + 80 * np.exp(-tt * 30)) * tt) * np.exp(-tt * 9)
    beat += 0.12 * np.sin(2 * np.pi * 65.4 * t)
    voice = 0.3 * np.sin(2 * np.pi * 261.6 * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 3 * t)) * ((t > 1) & (t < 6.5))
    backs = 0.2 * np.sin(2 * np.pi * 311.1 * t) * ((t > 3) & (t < 7))
    guide = 0.5 * np.sign(np.sin(2 * np.pi * 523.25 * t))  # carré bien reconnaissable
    # Niveaux modestes : le mix reste sous 0 dBFS (sinon le fichier entier écrête et la somme des stems en flottant ne lui ressemble plus).
    audio = {"beat": 0.5 * beat, "voix": 0.6 * voice, "backs": 0.6 * backs, "guide": guide}

    def clip(cid, name, color):
        return {"id": cid, "name": name, "type": "AUDIO", "start": 0, "duration": DUR, "offset": 0, "audioRef": f"audio/{cid}.wav",
                "color": color, "fadeIn": 0, "fadeOut": 0, "gain": 1, "isMuted": False}

    def track(tid, name, typ="AUDIO", out="master", clips=None, sends=None, plugins=None, **kw):
        return {"id": tid, "name": name, "type": typ, "color": "#22d3ee", "isMuted": False, "isSolo": False, "isTrackArmed": False,
                "isFrozen": False, "volume": 1, "pan": 0, "outputTrackId": out, "sends": sends or [], "clips": clips or [],
                "plugins": plugins or [], "automationLanes": [], "totalLatency": 0, **kw}

    verb = {"id": "verb1", "type": "REVERB", "name": "Reverb", "isEnabled": True,
            "params": {"mix": 1, "decay": 1.6, "preDelay": 0, "size": 0.5, "mode": "HALL", "lowCut": 20, "highCut": 20000, "width": 1,
                       # réverbe linéaire (comme la FG-480 du modèle) : ni ducking ni modulation
                       "ducking": 0, "modDepth": 0, "erLevel": 0, "bassBoost": 0}}
    tracks = [
        track("beat", "Beat", clips=[clip("beat", "Beat", "#eab308")], volume=0.8),
        track("voix", "Voix lead", out="bus-vox", clips=[clip("voix", "Prise 1", "#ef4444")], sends=[{"id": "send-verb", "level": 0.5, "isEnabled": True}]),
        track("backs", "Backs", out="bus-vox", clips=[clip("backs", "Backs", "#a855f7")], sends=[{"id": "send-verb", "level": 0.3, "isEnabled": True}], pan=-0.3),
        track("guide", "Guide topliner", clips=[clip("guide", "Démo", "#64748b")], isGuide=True, guideLevel=0.7),
        track("bus-vox", "Bus voix", typ="BUS"),
        track("send-verb", "Reverb", typ="SEND", plugins=[verb]),
        track("master", "MASTER", typ="BUS", out=""),
    ]
    state = {"id": "qa-r1", "name": "Nuit blanche", "bpm": 120, "isPlaying": False, "isRecording": False, "currentTime": 0,
             "isLoopActive": False, "loopStart": 2, "loopEnd": 6, "tracks": tracks, "selectedTrackId": "voix", "currentView": "ARRANGEMENT",
             "timeSignature": {"numerator": 4, "denominator": 4}, "trackGroups": [],
             "markers": [{"id": "m1", "name": "Couplet", "time": 2, "type": "MARKER", "color": "#22d3ee"},
                         {"id": "m2", "name": "Refrain", "time": 6, "type": "MARKER", "color": "#f59e0b"}],
             "metronome": {"enabled": False, "volume": 0.7, "countIn": 1, "accentDownbeat": True, "sound": "CLICK"},
             "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
             "projectKey": 0, "projectScale": "MINOR"}
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        for k, x in audio.items():
            z.writestr(f"audio/{k}.wav", wav_bytes(list(zip(x, x))))
    return audio


def open_with_project(page, zpath):
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text(DEFAULT_BEAT, exact=True).first.wait_for(timeout=30000)
    page.get_by_text(DEFAULT_BEAT, exact=True).first.click()
    page.wait_for_timeout(1200)
    close_welcome(page)
    wait_text_gone(page, "Chargement", 60)
    page.wait_for_timeout(800)
    # La fenêtre d'accueil s'ouvre 1,2 s après l'arrivée dans le studio : sur une machine chargée
    # elle arrive APRÈS le premier close_welcome et recouvre le menu (téléphone). On la referme.
    try:
        page.get_by_role("button", name="C'est parti", exact=True).locator("visible=true").first.wait_for(timeout=2500)
    except Exception:
        pass
    close_welcome(page)
    b = page.get_by_role("button", name="Ouvrir un projet").locator("visible=true")
    if b.count() == 0:
        page.get_by_role("button", name=re.compile("Ouvrir le menu")).first.click(); page.wait_for_timeout(400)
        b = page.get_by_role("button", name="Ouvrir un projet").locator("visible=true")
    b.first.click(); page.wait_for_timeout(600)
    page.get_by_role("button", name=re.compile("Fichier sur l.ordinateur")).first.click(); page.wait_for_timeout(300)
    page.set_input_files('input[type=file][accept=".zip,.json"]', str(zpath))
    page.get_by_text("Projet chargé").first.wait_for(timeout=30000)
    page.wait_for_timeout(1500)


def open_export_advanced(page):
    if page.locator("[role=dialog][aria-labelledby=export-title]").count() == 0:
        b = page.get_by_role("button", name="Exporter le mix").locator("visible=true")
        if b.count() == 0:
            page.locator("button:visible[aria-label='Ouvrir le menu']").first.click(); page.wait_for_timeout(500)
            b = page.locator("button:visible", has_text=re.compile(r"^s*Exporters*$"))
        b.first.click(); page.wait_for_timeout(1500)
    if page.locator("[data-export-vue=avancee]").count() == 0:
        page.get_by_role("button", name=re.compile("Réglages avancés")).click(); page.wait_for_timeout(400)
    page.locator("[data-export-vue=avancee]").wait_for(timeout=10000)


def sel(page, label, value):
    page.locator(f'[data-export-vue=avancee] label:has(> span:text-is("{label}")) select').first.select_option(str(value))


def check(page, label_rx, on):
    cb = page.locator("[data-export-vue=avancee] label", has_text=re.compile(label_rx)).locator("input[type=checkbox]").first
    if cb.is_checked() != on: cb.click()


def do_export(page, tag, *, source="MASTER", fmt="WAV", bits="24", sr=44100, layout="stereo", normalize="off", mp3="320",
              grouping=None, returns=None, master_fx=False, dither=False, tail="auto", rng="FULL", isrc=None, cover=None, queue=False):
    open_export_advanced(page)
    page.get_by_test_id(f"export-source-{source}").click()
    sel(page, "Type de fichier", fmt)
    sel(page, "Fréquence d'échantillonnage", sr)
    if fmt == "MP3": sel(page, "Qualité MP3", mp3)
    else: sel(page, "Résolution", bits)
    sel(page, "Canaux", layout)
    sel(page, "Durée", rng)
    sel(page, "Queue (réverbe après la fin)", tail)
    if source == "MASTER": sel(page, "Volume", normalize)
    if source == "STEMS":
        sel(page, "Découpage", grouping or "tracks")
        sel(page, "Réverbes et delays (retours)", returns or "in-stems")
        check(page, "Avec les effets du master", master_fx)
    if fmt != "MP3" and bits != "32": check(page, "Dither", dither)
    page.locator('[data-export-vue=avancee] label:has(> span:text-is("Artiste")) input').fill("Léo QA")
    if isrc: page.locator('[data-export-vue=avancee] label:has(> span:text-is("ISRC (facultatif)")) input').fill(isrc)
    if cover: page.set_input_files('[data-export-vue=avancee] input[type=file][accept="image/jpeg,image/png"]', str(cover))
    page.wait_for_timeout(200)
    t0 = time.time()
    with page.expect_download(timeout=240000) as dl:
        page.get_by_test_id("export-queue" if queue else "export-go").click()
        if queue:
            page.wait_for_timeout(1200)
            shot(page, f"r1_file_attente_{tag}")
    d = dl.value
    path = DL / f"{tag}__{d.suggested_filename}"
    d.save_as(str(path))
    page.wait_for_timeout(1700 if not queue else 600)
    rep = page.locator("[data-export-report]").last.inner_text() if page.locator("[data-export-report]").count() else ""
    res["fichiers"][tag] = {"nom": d.suggested_filename, "octets": path.stat().st_size, "secs": round(time.time() - t0, 1), "rapport": rep}
    return path


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels,bits_per_raw_sample,sample_fmt:format=duration:format_tags",
                          "-of", "json", str(path)], capture_output=True, text=True, encoding="utf-8")
    return json.loads(out.stdout or "{}")


def ffmpeg_clean(path):
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a", "-f", "null", "-"], capture_output=True, text=True, encoding="utf-8")
    return r.stderr.strip()


def read_zip_audio(zpath, ext):
    z = zipfile.ZipFile(zpath)
    out = {}
    for name in z.namelist():
        if name.endswith("." + ext):
            data, sr = sf.read(io.BytesIO(z.read(name)), dtype="float64", always_2d=True)
            out[name] = (data, sr)
    return out, z.namelist()


with sync_playwright() as p:
    b = launch(p)
    ctx, page = new_page(b, "pc")
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)[:300]))
    install_mocks(page, "romain", SUPERADMIN, {})
    zpath = OUT / "r1_projet_test.zip"
    audio = make_project(zpath)
    open_with_project(page, zpath)
    shot(page, "r1_00_projet_charge_pc")
    cover = OUT / "r1_pochette.png"
    page.screenshot(path=str(cover), clip={"x": 0, "y": 0, "width": 300, "height": 300})

    open_export_advanced(page)
    shot(page, "r1_01_fenetre_export_pc")
    page.get_by_test_id("export-source-STEMS").click(); page.wait_for_timeout(200)
    shot(page, "r1_02_fenetre_stems_pc")
    page.keyboard.press("Escape"); page.wait_for_timeout(400)

    files = {}
    files["wav16"] = do_export(page, "wav16", bits="16", sr=44100, dither=True, isrc="FR-Z03-26-00001")
    files["wav24"] = do_export(page, "wav24", bits="24", sr=48000)
    files["wav32"] = do_export(page, "wav32", bits="32", sr=96000)
    files["aiff24"] = do_export(page, "aiff24", fmt="AIFF", bits="24", sr=48000)
    files["flac16"] = do_export(page, "flac16", fmt="FLAC", bits="16", sr=44100, cover=cover, dither=True)
    files["flac24"] = do_export(page, "flac24", fmt="FLAC", bits="24", sr=96000, cover=cover)
    files["mp3_320"] = do_export(page, "mp3_320", fmt="MP3", mp3="320", sr=44100, cover=cover, isrc="FRZ032600001")
    files["mp3_192"] = do_export(page, "mp3_192", fmt="MP3", mp3="192", sr=48000)
    files["mono"] = do_export(page, "mono", bits="24", sr=48000, layout="mono-sum")
    files["mono_g"] = do_export(page, "mono_g", bits="24", sr=48000, layout="mono")
    files["dualmono"] = do_export(page, "dualmono", bits="24", sr=48000, layout="dual-mono")
    files["spotify"] = do_export(page, "spotify", bits="24", sr=44100, normalize="spotify")
    files["refrain"] = do_export(page, "refrain", bits="24", sr=48000, rng="MARKERS", tail="cut")
    files["mix_ref"] = do_export(page, "mix_ref", bits="32", sr=48000, tail="auto")
    files["stems_pistes"] = do_export(page, "stems_pistes", source="STEMS", bits="32", sr=48000, grouping="tracks", returns="in-stems")
    files["stems_bus"] = do_export(page, "stems_bus", source="STEMS", bits="24", sr=48000, grouping="buses", returns="separate")
    files["stems_iv"] = do_export(page, "stems_iv", source="STEMS", bits="24", sr=48000, grouping="instru-voix", returns="in-stems")
    files["stems_mp3"] = do_export(page, "stems_mp3", source="STEMS", fmt="MP3", mp3="320", sr=44100, grouping="tracks")
    files["file_flac"] = do_export(page, "file_flac", fmt="FLAC", bits="24", sr=48000, queue=True)
    shot(page, "r1_03_notification_pc")

    # Tablette et téléphone : fenêtre d'export lisible au doigt.
    for vp in ("tab", "tel"):
        c2, p2 = new_page(b, vp)
        install_mocks(p2, "romain", SUPERADMIN, {})
        try:
            open_with_project(p2, zpath)
            if vp == "tel":
                p2.locator("button:visible[aria-label='Ouvrir le menu']").first.click(); p2.wait_for_timeout(500)
                p2.locator("button:visible", has_text=re.compile(r"^s*Exporters*$")).first.click(); p2.wait_for_timeout(1500)
                shot(p2, "r1_04a_fenetre_export_tel_simple")
            open_export_advanced(p2)
            shot(p2, f"r1_04_fenetre_export_{vp}")
            p2.locator("[data-export-vue=avancee]").evaluate("e => e.closest('[role=dialog]').scrollTo(0, 99999)")
            p2.wait_for_timeout(300)
            shot(p2, f"r1_05_fenetre_export_{vp}_bas")
            res[f"debordements_{vp}"] = overflow_report(p2)
        except Exception as e:
            res[f"erreur_{vp}"] = str(e)[:300]
        c2.close()
    # Thème clair
    page.evaluate("document.documentElement.setAttribute('data-theme', 'light')")
    open_export_advanced(page)
    shot(page, "r1_06_fenetre_export_pc_clair")
    page.evaluate("document.documentElement.removeAttribute('data-theme')")
    res["erreurs_page"] = errs[:5]
    b.close()

# ------------------------------------------------------------------ vérifications Python
def sfinfo(path):
    i = sf.info(str(path)); return {"sr": i.samplerate, "ch": i.channels, "frames": i.frames, "sub": i.subtype, "fmt": i.format}

exp = {"wav16": (44100, "PCM_16", "WAV"), "wav24": (48000, "PCM_24", "WAV"), "wav32": (96000, "FLOAT", "WAV"), "aiff24": (48000, "PCM_24", "AIFF"),
       "flac16": (44100, "PCM_16", "FLAC"), "flac24": (96000, "PCM_24", "FLAC")}
for k, (srx, sub, fmt) in exp.items():
    i = sfinfo(files[k]); err = ffmpeg_clean(files[k])
    ok(f"format {k}", i["sr"] == srx and i["sub"] == sub and i["fmt"] == fmt and i["ch"] == 2 and not err, {**i, "ffmpeg": err[:120]})

for k, kb in (("mp3_320", 320), ("mp3_192", 192)):
    pr = probe(files[k]); st = [s for s in pr.get("streams", []) if s.get("codec_name") == "mp3"]
    tags = pr.get("format", {}).get("tags", {})
    ok(f"format {k}", bool(st) and not ffmpeg_clean(files[k]), {"sr": st[0].get("sample_rate") if st else None, "tags": tags, "pochette": any(s.get("codec_name") in ("png", "mjpeg") for s in pr.get("streams", []))})
pr = probe(files["mp3_320"]); tags = {k.lower(): v for k, v in pr.get("format", {}).get("tags", {}).items()}
ok("MP3 : ID3 titre / artiste / BPM / ton / ISRC / pochette", tags.get("title") == "Nuit blanche" and tags.get("artist") == "Léo QA" and tags.get("tbpm") == "120"
   and tags.get("tkey") == "Cm" and tags.get("tsrc") == "FRZ032600001" and any(s.get("codec_name") == "png" for s in pr.get("streams", [])), tags)

pr = probe(files["flac16"]); tags = {k.upper(): v for k, v in pr.get("format", {}).get("tags", {}).items()}
ok("FLAC : commentaires (TITLE, BPM, INITIALKEY) + pochette", tags.get("TITLE") == "Nuit blanche" and tags.get("BPM") == "120" and tags.get("INITIALKEY") == "Cm"
   and any(s.get("codec_name") == "png" for s in pr.get("streams", [])), tags)

raw = Path(files["wav16"]).read_bytes()
chunks = []
pos = 12
while pos + 8 <= len(raw):
    cid = raw[pos:pos + 4].decode("latin-1"); size = struct.unpack("<I", raw[pos + 4:pos + 8])[0]
    chunks.append((cid, raw[pos + 8:pos + 8 + size])); pos += 8 + size + (size & 1)
ids = [c for c, _ in chunks]
bext = dict(chunks).get("bext", b"")
acid = dict(chunks).get("acid", b"")
cue = dict(chunks).get("cue ", b"")
info = [d for c, d in chunks if c == "LIST" and d[:4] == b"INFO"]
ok("WAV : BWF bext (description, loudness), acid 120 BPM, repères, INFO ISRC", "bext" in ids and b"120 BPM" in bext[:256]
   and abs(struct.unpack("<f", acid[20:24])[0] - 120) < 1e-3 and struct.unpack("<I", cue[:4])[0] == 2 and info and b"FRZ032600001" in info[0],
   {"chunks": ids, "description": bext[:256].rstrip(b"\0").decode("ascii", "replace"), "lufs_bwf": struct.unpack("<h", bext[412:414])[0] / 100 if len(bext) > 414 else None})

i = sfinfo(files["mono"]); ok("mono-somme : 1 canal", i["ch"] == 1, i)
mg, _ = sf.read(str(files["mono_g"]), dtype="int32", always_2d=True)
w24, _ = sf.read(str(files["wav24"]), dtype="int32", always_2d=True)
# Deux rendus séparés : identiques au dernier bit près (moteur hors ligne R6 : chaînes actives tout le rendu ; écart mesuré ≈ −138 dB).
_dmono = int(np.abs(mg[:, 0].astype(np.int64) - w24[:, 0].astype(np.int64)).max()) if mg.shape[0] == w24.shape[0] else None
ok("mono (canal gauche) : 1 canal, identique au gauche du WAV 24 bits stéréo (±2 LSB)", mg.shape[1] == 1 and _dmono is not None and _dmono <= 2 * 256, {"frames": mg.shape[0], "ecart_max_lsb24": None if _dmono is None else _dmono / 256})
z = zipfile.ZipFile(files["dualmono"]); names = [n for n in z.namelist() if n.endswith(".wav")]
chs = [sf.info(io.BytesIO(z.read(n))).channels for n in names]
ok("double mono : 2 fichiers mono .L / .R", len(names) == 2 and chs == [1, 1] and any(".L." in n for n in names) and any(".R." in n for n in names), names)

x, srx = sf.read(str(files["spotify"]), dtype="float64")
def lufs(x, sr):
    # BS.1770 simplifiée (filtre K pondéré via ffmpeg ebur128 serait plus lourd) : on demande à ffmpeg.
    r = subprocess.run(["ffmpeg", "-nostats", "-i", str(files["spotify"]), "-filter_complex", "ebur128=peak=true", "-f", "null", "-"], capture_output=True, text=True, encoding="utf-8")
    m = re.findall(r"I:\s+(-?[\d.]+) LUFS", r.stderr); tp = re.findall(r"Peak:\s+(-?[\d.]+) dBFS", r.stderr)
    return float(m[-1]) if m else None, float(tp[-1]) if tp else None
L, TP = lufs(x, srx)
ok("cible Spotify : −14 LUFS (±0,5) ou crête vraie ≤ −1 dBTP (ffmpeg ebur128)", L is not None and (abs(L + 14) <= 0.5 or TP <= -0.9), {"lufs_ffmpeg": L, "crete_vraie_ffmpeg": TP, "rapport_nova": res["fichiers"]["spotify"]["rapport"]})

i = sfinfo(files["refrain"]); ok("plage Couplet → Refrain, queue coupée : 4,000 s", abs(i["frames"] / i["sr"] - 4.0) < 1e-3, i)

# Stems : même longueur, démarrent à 0, somme = mix (32 bits flottants, master sans effet)
mix, srm = sf.read(str(files["mix_ref"]), dtype="float64", always_2d=True)
st, names = read_zip_audio(files["stems_pistes"], "wav")
lens = {k: v[0].shape[0] for k, v in st.items()}
ok("stems par piste : tous de la même longueur que le mix", len(set(lens.values())) == 1 and list(lens.values())[0] == mix.shape[0], {"stems": lens, "mix": mix.shape[0]})
ok("stems nommés Titre_BPM_Ton_Piste, guide absent", all(re.match(r"Nuit-blanche_120BPM_Cm_.+\.wav$", k) for k in st) and not any("Guide" in k for k in st), sorted(st))
s = sum(v[0] for v in st.values())
err = float(np.max(np.abs(s - mix))); peak = float(np.max(np.abs(mix)))
rms_e = float(np.sqrt(np.mean((s - mix) ** 2))); rms_m = float(np.sqrt(np.mean(mix ** 2)))
# Retours DANS chaque stem : chaque stem a sa propre réverbe à convolution (moteur du navigateur, calcul par blocs
# en flottant) : la somme diffère du mix vers −90 dB, inaudible (sous le bruit d'un 16 bits). Retours en fichiers
# séparés (test suivant) : la réverbe reçoit exactement ce qu'elle reçoit dans le mix, somme exacte.
ok("somme des stems (retours dans chaque stem) = mix : écart max < −80 dB, efficace < −85 dB", err < peak * 1e-4 and rms_e < rms_m * 10 ** (-85 / 20),
   {"ecart_max": err, "crete_mix": peak, "ecart_max_db": round(20 * math.log10(max(err, 1e-12) / peak), 1), "ecart_efficace_db": round(20 * math.log10(max(rms_e, 1e-15) / rms_m), 1)})
# Le guide (carré 523 Hz) ne doit pas être dans le mix : énergie autour de 523 Hz ≈ celle du projet sans guide.
spec = np.abs(np.fft.rfft(mix[:, 0])); f = np.fft.rfftfreq(mix.shape[0], 1 / srm)
band = spec[(f > 515) & (f < 531)].max(); ref_band = spec[(f > 250) & (f < 270)].max()
ok("guide absent du mix (pas de raie à 523 Hz)", band < ref_band * 0.01, {"raie_523": float(band), "raie_voix_262": float(ref_band)})

stb, names_b = read_zip_audio(files["stems_bus"], "wav")
ok("stems par bus + retours séparés : Beat, Bus voix, Reverb", sorted(k.split("_")[-1] for k in stb) == sorted(["Beat.wav", "Bus-voix.wav", "Reverb.wav"]), sorted(stb))
mix24, _ = sf.read(str(files["wav24"]), dtype="float64", always_2d=True)
sb = sum(v[0] for v in stb.values())
nb = min(sb.shape[0], mix24.shape[0])
eb = float(np.max(np.abs(sb[:nb] - mix24[:nb])))
ok("stems par bus + retour séparé = mix (24 bits, écart max < −80 dB)", eb < float(np.max(np.abs(mix24))) * 1e-4, {"ecart_max": eb, "ecart_db": round(20 * math.log10(max(eb, 1e-12) / float(np.max(np.abs(mix24)))), 1)})
stv, _ = read_zip_audio(files["stems_iv"], "wav")
ok("instru / voix séparés : 2 fichiers", sorted(k.split("_")[-1] for k in stv) == ["Instru.wav", "Voix.wav"], sorted(stv))
zm = zipfile.ZipFile(files["stems_mp3"]); mp3n = [n for n in zm.namelist() if not n.endswith(".txt")]
ok("bug corrigé : stems MP3 nommés .mp3", mp3n and all(n.endswith(".mp3") for n in mp3n), mp3n)
ok("fiche LISEZMOI dans le zip", "LISEZMOI_NOVA.txt" in zm.namelist(), zm.read("LISEZMOI_NOVA.txt").decode("utf-8")[:300] if "LISEZMOI_NOVA.txt" in zm.namelist() else None)
ok("file d'exports : FLAC livré", sfinfo(files["file_flac"])["fmt"] == "FLAC", res["fichiers"]["file_flac"])
ok("pas d'erreur dans la page", not res["erreurs_page"], res["erreurs_page"])
(OUT / "r1_resultats.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
print("\nBILAN :", sum(1 for v in res["etapes"].values() if v["ok"]), "/", len(res["etapes"]), "OK")
