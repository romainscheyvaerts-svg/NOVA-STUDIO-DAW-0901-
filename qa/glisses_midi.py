"""Glissés par note dans les fichiers .mid (16/10/2026, chantier fixes-midi de la 1.5.1).

Headless, aucune fenêtre, 100 % hors production (qalib importe qa_hors_prod). Bureau (1600 × 900)
et téléphone (390 × 844, au doigt), thèmes sombre et clair. Pour chaque écran :
  1. projet : une piste « Synthé NOVA » avec un beat de 808 et des GLISSÉS posés pendant la note tenue
     (dont un sous un accord : la note glissée doit partir sur son propre canal) ;
  2. piano roll ouvert sur le clip : les courbes de glissé sont dessinées ;
  3. « .mid » du piano roll : le fichier contient le RPN 0 (plage ±24 demi-tons) en tête de piste,
     des pitch bends sur le canal de la note tenue, AUCUNE Note On pour les glissés ;
     relu par le lecteur de NOVA : mêmes notes, mêmes positions, glissés retrouvés ;
  4. import du même fichier sur la piste (bouton d'import du piano roll) : le nouveau clip a les mêmes
     notes, aux mêmes places (relatives au clip), avec les mêmes glissés ; ses courbes sont dessinées ;
  5. aucun bouton recouvert (qalib.balayage_chevauchement), aucune erreur de console.

NOVA_URL=http://127.0.0.1:3420/ python qa/glisses_midi.py [pc_dark tel390_light …]
Captures : QA_OUT ou D:\\1 WORK\\CONTENU\\nova-151\\fixes-midi\\captures
"""
import json, os, sys, zipfile
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3420/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-151\fixes-midi\captures")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402
from qalib import OUT, BASE, Log, new_page, shot  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

RUNS = [("pc", "dark"), ("tel390", "dark"), ("pc", "light"), ("tel390", "light")]
BPM = 120
BEAT = 60 / BPM
PPQ = 960
KO = []
PROJ = OUT / "projet_glisses_midi.zip"
# Beat de 808 (La0 tenue, glissés vers Mi1 puis Sol0) + accord avec un glissé + une note seule.
NOTES = [
    {"id": "h1", "pitch": 33, "start": 0, "duration": 2 * BEAT, "velocity": 0.9},
    {"id": "s1", "pitch": 40, "start": 0.5 * BEAT, "duration": 0.25 * BEAT, "velocity": 0.8, "slide": True},
    {"id": "s2", "pitch": 31, "start": 1.25 * BEAT, "duration": 0.5 * BEAT, "velocity": 0.8, "slide": True},
    {"id": "n2", "pitch": 36, "start": 2 * BEAT, "duration": 1 * BEAT, "velocity": 0.7},
    {"id": "a1", "pitch": 57, "start": 4 * BEAT, "duration": 2 * BEAT, "velocity": 0.6},
    {"id": "a2", "pitch": 60, "start": 4 * BEAT, "duration": 2 * BEAT, "velocity": 0.6},
    {"id": "s3", "pitch": 64, "start": 5 * BEAT, "duration": 0.5 * BEAT, "velocity": 0.6, "slide": True},
]
SLIDES = {"s1", "s2", "s3"}


def ok(name, cond, detail=None):
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False)[:500]}"), flush=True)
    if not cond:
        KO.append(name)
    return cond


def make_project():
    track = {"id": "synth808", "name": "808 GLISSÉ", "type": "MIDI", "color": "#22d3ee", "isMuted": False, "isSolo": False, "isTrackArmed": False,
             "isFrozen": False, "volume": 0.8, "pan": 0, "outputTrackId": "master", "sends": [], "plugins": [], "automationLanes": [], "totalLatency": 0,
             "novaSynth": {"presetId": "init"},
             "clips": [{"id": "c808", "name": "808", "start": 0, "duration": 8 * BEAT, "offset": 0, "fadeIn": 0, "fadeOut": 0, "color": "#22d3ee",
                        "type": "MIDI", "notes": NOTES, "gain": 1}]}
    state = {"id": "proj-glisses-midi", "name": "Glissés MIDI", "bpm": BPM, "timeSignature": {"numerator": 4, "denominator": 4}, "isPlaying": False,
             "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8, "tracks": [track], "trackGroups": [], "markers": [],
             "selectedTrackId": "synth808", "currentView": "ARRANGEMENT", "projectPhase": "RECORDING", "projectMode": "BEATMAKING", "isLowLatencyMode": False,
             "isRecModeActive": False, "systemMaxLatency": 0, "recStartTime": None, "isDelayCompEnabled": True,
             "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
             "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0}}
    with zipfile.ZipFile(PROJ, "w") as z:
        z.writestr("project.json", json.dumps(state))


def open_project(page):
    page.add_init_script("try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_count_in', '0'); localStorage.removeItem('nova.pianoroll.prefs'); } catch (e) {}")
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=30000)
    page.get_by_text("Charger Projet").first.click(); page.wait_for_timeout(700)
    with page.expect_file_chooser(timeout=8000) as fc:
        page.get_by_text("Charger depuis l'ordinateur").first.click()
    fc.value.set_files(str(PROJ))
    page.wait_for_timeout(5000)
    for name in ("C'est parti", "Plus tard"):
        b = page.get_by_role("button", name=name, exact=True).locator("visible=true").first
        try:
            if b.is_visible(): b.click(); page.wait_for_timeout(300)
        except Exception:
            pass
    page.wait_for_function("() => !!window.__novaMidi", timeout=20000)


def click(page, sel, phone):
    loc = page.locator(sel).locator("visible=true").first
    loc.scroll_into_view_if_needed()
    if phone:
        b = loc.bounding_box(); page.touchscreen.tap(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)
    else:
        loc.click()
    page.wait_for_timeout(250)


def open_roll(page, clip_id):
    page.evaluate("(a) => window.dispatchEvent(new CustomEvent('nova:open-piano-roll', { detail: a }))", {"trackId": "synth808", "clipId": clip_id})
    page.locator("[data-nova-pianoroll]").wait_for(timeout=8000)
    page.wait_for_timeout(600)


def close_roll(page):
    page.keyboard.press("Escape"); page.wait_for_timeout(500)


def show_advanced(page, phone):
    if not page.locator("[data-nova-roll=mid-export]").locator("visible=true").count():
        click(page, "[data-nova-roll=plus]", phone)
        page.wait_for_timeout(300)


def raw_events(data: bytes):
    """Événements de canal de chaque piste (statut, d1, d2, tick), running status compris."""
    out = []
    p = 14
    while p + 8 <= len(data):
        ln = int.from_bytes(data[p + 4:p + 8], "big")
        q, end, tick, st, evs = p + 8, p + 8 + ln, 0, 0, []
        while q < end:
            v = 0
            while True:
                c = data[q]; q += 1; v = (v << 7) | (c & 0x7f)
                if not c & 0x80: break
            tick += v
            s = data[q]
            if s & 0x80: q += 1
            else: s = st
            if s == 0xff:
                q += 1; l = 0
                while True:
                    c = data[q]; q += 1; l = (l << 7) | (c & 0x7f)
                    if not c & 0x80: break
                q += l; continue
            st = s
            d1 = data[q]; q += 1
            d2 = 0
            if (s & 0xf0) not in (0xc0, 0xd0): d2 = data[q]; q += 1
            evs.append((tick, s, d1, d2))
        out.append(evs)
        p = end
    return out


PARSE_JS = """async (b64) => {
  const { parseMidi } = await import('/utils/midiFile.ts');
  const d = parseMidi(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
  return d.tracks.flatMap(t => t.notes.map(n => ({ p: n.pitch, s: n.startTick, d: n.durationTicks, slide: !!n.slide, ch: n.channel })));
}"""


def expected_ticks():
    return sorted((n["pitch"], round(n["start"] / BEAT * PPQ), round(n["duration"] / BEAT * PPQ), n["id"] in SLIDES) for n in NOTES)


def run(vp, theme, res):
    os.environ["QA_THEME"] = theme
    tag = f"{vp}_{theme}"
    phone = vp.startswith("tel")
    log = Log(f"glisses_{tag}")
    r = {}
    with sync_playwright() as p:
        b = qalib.launch(p)
        ctx, page = new_page(b, vp, log)
        try:
            open_project(page)
            # 2. Piano roll : courbes des glissés
            open_roll(page, "c808")
            r["courbes"] = page.locator("[data-nova-slide-curve]").count()
            ok(f"{tag} : piano roll, 3 glissés dessinés", r["courbes"] == 3, r)
            shot(page, f"{tag}_01_piano_roll_glisses")
            show_advanced(page, phone)
            # 3. Export .mid du clip
            with page.expect_download(timeout=15000) as dl:
                click(page, "[data-nova-roll=mid-export]", phone)
            path = OUT / f"glisses_{tag}.mid"
            dl.value.save_as(str(path))
            data = path.read_bytes()
            evs = raw_events(data)
            notes_trk = evs[1] if len(evs) > 1 else []
            ons = sorted(d1 for (_, s, d1, d2) in notes_trk if (s & 0xf0) == 0x90 and d2 > 0)
            cc = [(t, s & 0x0f, d1, d2) for (t, s, d1, d2) in notes_trk if (s & 0xf0) == 0xb0]
            bends = [(t, s & 0x0f, (d2 << 7) | d1) for (t, s, d1, d2) in notes_trk if (s & 0xf0) == 0xe0]
            rpn_chans = {ch for (t, ch, c, v) in cc if t == 0 and c == 6 and v == 24}
            bend_chans = {ch for (_, ch, _) in bends}
            r["fichier"] = {"octets": len(data), "note_on": ons, "canaux_bend": sorted(bend_chans), "canaux_rpn_24": sorted(rpn_chans), "bends": len(bends)}
            ok(f"{tag} : .mid avec RPN 0 (±24) en tête de piste sur chaque canal qui glisse",
               data[:4] == b"MThd" and bend_chans and bend_chans <= rpn_chans, r["fichier"])
            ok(f"{tag} : aucune Note On pour les glissés (seulement les notes jouées)", ons == sorted([33, 36, 57, 60]), r["fichier"])
            ok(f"{tag} : l'accord glissé part sur son propre canal (une note par canal)", len(bend_chans) == 2, r["fichier"])
            import base64
            back = page.evaluate(PARSE_JS, base64.b64encode(data).decode())
            got = sorted((n["p"], n["s"], n["d"], n["slide"]) for n in back)
            r["relu"] = got
            ok(f"{tag} : relu par NOVA : mêmes notes, positions et hauteurs exactes, glissés retrouvés", got == expected_ticks(), {"relu": got, "attendu": expected_ticks()})
            # 4. Import du même fichier sur la piste (bouton du piano roll)
            before = {c["id"] for t in page.evaluate("() => window.__novaMidi.rawTracks()") for c in t["clips"]}
            with page.expect_file_chooser(timeout=8000) as fc:
                click(page, "[data-nova-roll=mid-import]", phone)
            fc.value.set_files(str(path))
            page.wait_for_timeout(1500)
            tracks = page.evaluate("() => window.__novaMidi.rawTracks()")
            new = [(t["id"], c) for t in tracks for c in t["clips"] if c["id"] not in before]
            r["import"] = {"nouveaux_clips": [(tid, c["id"]) for tid, c in new]}
            if new:
                tid, c = new[0]
                imp = sorted((n["pitch"], round(n["start"] / BEAT * PPQ), round(n["duration"] / BEAT * PPQ), bool(n.get("slide"))) for n in c["notes"])
                r["import"]["notes"] = imp
                ok(f"{tag} : réimporté sur la piste Synthé NOVA : mêmes notes, mêmes places, mêmes glissés",
                   tid == "synth808" and imp == expected_ticks(), {"import": imp, "attendu": expected_ticks(), "piste": tid})
                close_roll(page)
                open_roll(page, c["id"])
                r["courbes_import"] = page.locator("[data-nova-slide-curve]").count()
                ok(f"{tag} : clip importé : 3 glissés dessinés au piano roll", r["courbes_import"] == 3, r)
                shot(page, f"{tag}_02_import_glisses")
            else:
                ok(f"{tag} : import du .mid", False, r["import"])
            ov = qalib.balayage_chevauchement(page, "[data-nova-pianoroll]")
            r["chevauchement"] = ov
            ok(f"{tag} : aucun bouton recouvert dans le piano roll", not ov.get("recouverts"), ov)
            close_roll(page)
            shot(page, f"{tag}_03_arrangement")
        except Exception as e:  # noqa
            r["ERREUR"] = f"{type(e).__name__}: {str(e)[:400]}"
            ok(f"{tag} : scénario complet", False, r["ERREUR"])
            try: shot(page, f"{tag}_ECHEC")
            except Exception: pass
        r["erreurs_console"] = [e["text"][:200] for e in log.errors() if "status of 400" not in e["text"]][:8]
        ok(f"{tag} : aucune erreur dans la console", not r["erreurs_console"], r["erreurs_console"])
        ctx.close(); b.close()
    res[tag] = r


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    make_project()
    only = set(sys.argv[1:])
    res = {}
    for vp, theme in RUNS:
        if only and f"{vp}_{theme}" not in only:
            continue
        run(vp, theme, res)
    (OUT / "resultat_glisses_midi.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\nKO :", KO if KO else "aucun")
    sys.exit(1 if KO else 0)


if __name__ == "__main__":
    main()
