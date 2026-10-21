"""🎼 Temps musical (L3, écart 4) : le contenu garde sa mesure quand le tempo change (bout en bout, hors production).

Navigateur headless (aucune fenêtre), Supabase simulé (qa_hors_prod), aucun micro réel.

Projet à 90 BPM : piste MIDI « Piano » (16 notes en doubles-croches à partir de la mesure 2), piste audio « Sample »
(clip non calé à la mesure 3), un repère à la mesure 5, une boucle mesures 2 → 4.

Bureau 1600 × 900 (sombre puis clair) :
  1. tempo 90 → 140 par la fenêtre « Tempo et mesure » : 100 % des notes, débuts de clips, repère et boucle sur la
     même mesure | temps | tick ; message « … même mesure qu'avant » ; Ctrl+Z : UNE étape ramène tout (90 BPM) ;
  2. export après le changement = rendu d'un projet construit directement à 140 BPM (écart maximal mesuré) ;
  3. « Garder les clips audio à leur place » : le clip audio ne bouge plus, les notes suivent ;
  4. rampe 120 → 100 BPM des mesures 1 à 9 (case « Rampe ») : bande de la piste tempo, clics de la carte à
     ±1 ms de la position théorique, notes qui gardent leur mesure ;
  5. sauvegarde (.zip) → project.json porte la rampe et l'option ; rechargement : mêmes positions ;
Téléphone 390 × 844 (sombre et clair) : la fenêtre « Tempo et mesure » s'ouvre au doigt, rampe et option lisibles.

NOVA_URL=http://127.0.0.1:3521/ python qa/tempo_musical.py
Sorties : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-pro-2026\\qa-tempo) : tempo_musical.json + captures.
"""
import io, json, math, os, re, sys, wave, zipfile
from pathlib import Path

import numpy as np

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3521/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-pro-2026\qa-tempo")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402,F401  (Supabase simulé avant tout navigateur)
from qalib import BASE, OUT, Log, new_page, shot, save_log, launch  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SR = 48000
BPM0 = 90.0
BEAT0 = 60 / BPM0
checks = []
res = {"bureau": {}, "rechargement": {}, "telephone": {}}


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:700]}"), flush=True)


def tone_wav(seconds=0.5, f=440.0, sr=SR) -> bytes:
    t = np.arange(int(seconds * sr)) / sr
    x = 0.3 * np.sin(2 * np.pi * f * t) * np.exp(-t * 6)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def make_project(path: Path):
    base = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "volume": 0.9, "pan": 0,
            "outputTrackId": "master", "sends": [], "plugins": [], "automationLanes": [], "totalLatency": 0}
    notes = [{"id": f"n{i}", "pitch": 60 + (i * 5) % 12, "start": i * BEAT0 / 4, "duration": BEAT0 / 4 * (1 + i % 3) * 0.9, "velocity": 0.8} for i in range(16)]
    piano = {**base, "id": "piano", "name": "Piano", "type": "MIDI", "color": "#22d3ee",
             "clips": [{"id": "c-piano", "start": 4 * BEAT0, "duration": 8 * BEAT0, "offset": 0, "fadeIn": 0, "fadeOut": 0,
                        "name": "Motif", "color": "#22d3ee", "type": "MIDI", "notes": notes}]}
    sample = {**base, "id": "sample", "name": "Sample", "type": "AUDIO", "color": "#f472b6",
              "clips": [{"id": "c-sample", "start": 8 * BEAT0, "duration": 0.5, "offset": 0, "fadeIn": 0, "fadeOut": 0,
                         "name": "Tom", "color": "#f472b6", "type": "AUDIO", "audioRef": "audio/tom.wav"}]}
    state = {
        "id": "proj-tempo-musical", "name": "Tempo musical", "bpm": BPM0, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": True, "loopStart": 4 * BEAT0, "loopEnd": 12 * BEAT0,
        "tracks": [piano, sample], "trackGroups": [],
        "markers": [{"id": "mk", "name": "Refrain", "time": 16 * BEAT0, "type": "MARKER", "color": "#facc15"}],
        "selectedTrackId": "piano", "currentView": "ARRANGEMENT", "projectPhase": "RECORDING", "projectMode": "BEATMAKING",
        "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0, "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/tom.wav", tone_wav())


INIT = """
try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_count_in', '0'); localStorage.setItem('nova_auto_clean', '0');
      localStorage.setItem('nova_welcome_seen', '1'); localStorage.setItem('nova_tempo_lane', '1'); } catch (e) {}
"""


def open_project(page, f: Path, label, touch=False):
    page.add_init_script(INIT)
    page.route("**/functions/v1/nova-billing", lambda r: r.fulfill(status=200, content_type="application/json",
               body=json.dumps({"plans": [], "admin": True, "unlocked": True, "free_exports_left": 10})))
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=90000)
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
    page.wait_for_function("() => !!window.DAW_CONTROL", timeout=30000)
    page.evaluate("async () => { const m = await window.__novaAppModule('/utils/simpleMode.ts'); m.simpleModeStore.setPref(false); }")
    page.wait_for_timeout(600)
    shot(page, label)


# Positions musicales de tout ce qui doit suivre (mesure | temps | tick, 960 ticks par temps), lues avec la carte de l'appli.
POS_JS = """async () => {
  const T = await window.__novaAppModule('/utils/tempoMap.ts');
  const s = window.DAW_CONTROL.getState();
  const m = T.buildTempoMap(s.bpm, s.timeSignature, s.tempoEvents);
  const p = t => { const x = T.timeToPosition(m, t + 1e-7); return `${x.bar + 1}|${x.beat + 1}|${String(Math.min(959, Math.floor(x.frac * 960 + 1e-4))).padStart(3, "0")}`; };
  const piano = s.tracks.find(t => t.id === 'piano'), sample = s.tracks.find(t => t.id === 'sample');
  const c = piano.clips[0];
  return {
    bpm: s.bpm, events: s.tempoEvents || [], audioMode: s.tempoAudioMode ?? null,
    clip: p(c.start), clipEnd: p(c.start + c.duration),
    notes: c.notes.map(n => p(c.start + n.start) + ' → ' + p(c.start + n.start + n.duration)),
    sample: p(sample.clips[0].start), sampleSec: +sample.clips[0].start.toFixed(6),
    marker: p(s.markers[0].time), loop: [p(s.loopStart), p(s.loopEnd)],
    noteSec: c.notes.map(n => +(c.start + n.start).toFixed(6)),
  };
}"""


def pos(page):
    return page.evaluate(POS_JS)


def open_tempo(page):
    el = page.locator('[data-testid="transport-bpm"]').first
    if el.count() and el.is_visible():
        el.focus(); page.keyboard.press("Enter")
    else:
        page.keyboard.press("Control+k"); page.wait_for_timeout(400)
        page.keyboard.type("Tempo, mesure"); page.wait_for_timeout(400); page.keyboard.press("Enter")
    page.locator('[data-testid="tempo-dialog"]').wait_for(timeout=8000)
    page.wait_for_timeout(300)


def close_tempo(page):
    page.keyboard.press("Escape"); page.wait_for_timeout(400)


RENDER_JS = """async ({ bpm }) => {
  const { audioEngine: E } = await window.__novaAppModule('/engine/AudioEngine.ts');
  await E.init();
  const s = window.DAW_CONTROL.getState();
  const tracks = JSON.parse(JSON.stringify(s.tracks.filter(t => t.id === 'piano' || t.id === 'sample')));
  const dur = 14;
  const a = (await E.renderProject(s.tracks.filter(t => t.id === 'piano' || t.id === 'sample'), dur, 0, 48000)).getChannelData(0);
  // Référence : le même projet écrit DIRECTEMENT à `bpm` (positions calculées en secondes, sans passer par le changement).
  const k = 90 / bpm, beat = 60 / 90;
  const ref = tracks.map(t => {
    if (t.id === 'piano') { const c = t.clips[0]; c.start = 4 * beat * k; c.duration = 8 * beat * k;
      c.notes = c.notes.map((n, i) => ({ ...n, start: i * beat / 4 * k, duration: beat / 4 * (1 + i % 3) * 0.9 * k })); }
    if (t.id === 'sample') t.clips[0].start = 8 * beat * k;
    return t;
  });
  const b = (await E.renderProject(ref, dur, 0, 48000)).getChannelData(0);
  let diff = 0, rms = 0;
  for (let i = 0; i < a.length; i++) { diff = Math.max(diff, Math.abs(a[i] - b[i])); rms += a[i] * a[i]; }
  return { diff, rms: Math.sqrt(rms / a.length), n: a.length };
}"""


ROLL_JS = """async () => {
  const T = await window.__novaAppModule('/utils/tempoMap.ts');
  const m = T.tempoMapStore.get();
  const svg = document.querySelector('[data-nova-roll-grid-tempo]');
  const ruler = document.querySelector('[data-nova-roll-tempo]');
  if (!svg) return { grille_carte: false, regle: ruler && ruler.dataset.novaRollTempo };
  const zoom = +svg.dataset.novaRollZoom, start = +svg.dataset.novaRollStart;
  const xs = svg.querySelector('[data-nova-roll-bars]').dataset.novaRollBars.split(' ').map(Number);
  const p0 = T.timeToPosition(m, start - 1e-9), first = p0.bar + (p0.beat || p0.frac > 1e-6 ? 1 : 0);
  let pire = 0, pireAncien = 0;
  const bpm0 = T.tempoAt(m, start), barSec0 = 240 / bpm0;   // grille d'avant : tempo du début du clip, régulière
  xs.forEach((x, i) => { const t = T.barToTime(m, first + i); pire = Math.max(pire, Math.abs(x - (t - start) * zoom));
    pireAncien = Math.max(pireAncien, Math.abs(t - (first + i) * barSec0) * 1000); });
  return { grille_carte: true, regle: ruler && ruler.dataset.novaRollTempo, traits: xs.length, pire_px: +pire.toFixed(3), zoom, start,
           ecart_grille_ancienne_ms: +pireAncien.toFixed(1), tempo_coin: document.querySelector('[data-nova-pianoroll] .pr-ruler')?.textContent || '' };
}"""


def piano_roll_rampe(page, R):
    """Piano roll ouvert sur le clip MIDI pris dans la rampe : grille, règle et aimantation suivent la carte."""
    page.evaluate("() => { try { localStorage.setItem('nova.pianoroll.prefs', JSON.stringify({ gridId: '1/16', magnet: true })); } catch (e) {} }")
    page.evaluate("() => window.dispatchEvent(new CustomEvent('nova:open-piano-roll', { detail: { trackId: 'piano', clipId: 'c-piano' } }))")
    page.locator('[data-nova-pianoroll]').first.wait_for(timeout=8000)
    page.wait_for_timeout(800)
    g = page.evaluate(ROLL_JS)
    R["piano_roll_rampe"] = g
    check("piano roll dans la rampe : grille et règle calculées sur la carte de tempo", g.get("grille_carte") and g.get("regle") == "carte", g)
    check("piano roll dans la rampe : chaque trait de mesure à ±0,01 px de l'arrangement (barToTime)", g.get("traits", 0) >= 3 and g.get("pire_px", 9) <= 0.01, g)
    # Aimantation : clic au crayon à 40 % d'une double-croche prise au milieu de la rampe → note posée au début exact de la case.
    snap = page.evaluate("""async () => {
      const T = await window.__novaAppModule('/utils/tempoMap.ts');
      const m = T.tempoMapStore.get();
      const s = window.DAW_CONTROL.getState(); const c = s.tracks.find(t => t.id === 'piano').clips.find(x => x.id === 'c-piano');
      const q0 = T.timeToQuarters(m, c.start) + 4 * 1 + 0.25 * 5;   // mesure suivante + 5 doubles-croches
      const t = T.quartersToTime(m, q0 + 0.1), attendu = T.quartersToTime(m, q0);
      const g = document.querySelector('[data-nova-roll-grid]'); const r = g.getBoundingClientRect();
      const zoom = +document.querySelector('[data-nova-roll-grid-tempo]').dataset.novaRollZoom;
      const x = r.left + (t - c.start) * zoom - g.scrollLeft, y = r.top + Math.min(200, r.height / 2);
      return { x, y, attendu_rel: attendu - c.start, n: c.notes.length, ancienne: Math.floor(t / (15 / T.tempoAt(m, c.start)) + 1e-9) * (15 / T.tempoAt(m, c.start)) - c.start };
    }""")
    page.mouse.click(snap["x"], snap["y"]); page.wait_for_timeout(600)
    got = page.evaluate("""(n0) => { const s = window.DAW_CONTROL.getState(); const c = s.tracks.find(t => t.id === 'piano').clips.find(x => x.id === 'c-piano');
      return c.notes.length > n0 ? c.notes.map(n => n.start) : []; }""", snap["n"])
    best = min((abs(x - snap["attendu_rel"]) for x in got), default=9)
    snap["ecart_ms"] = round(best * 1000, 4)
    snap["ecart_grille_ancienne_ms"] = round(abs(snap["ancienne"] - snap["attendu_rel"]) * 1000, 2)
    R["piano_roll_aimantation"] = snap
    check("piano roll dans la rampe : note posée au crayon au début exact de sa double-croche (±0,001 ms)", len(got) == snap["n"] + 1 and best * 1000 <= 0.001, snap)
    shot(page, "pc_06b_piano_roll_rampe")
    page.keyboard.press("Escape"); page.wait_for_timeout(500)
    page.mouse.click(800, 450); page.wait_for_timeout(200)
    page.keyboard.press("Control+z"); page.wait_for_timeout(700)
    n_after = page.evaluate("() => window.DAW_CONTROL.getState().tracks.find(t => t.id === 'piano').clips[0].notes.length")
    check("piano roll : Ctrl+Z retire la note d'essai", n_after == snap["n"], n_after)


def desktop(b):
    R = res["bureau"]
    log = Log("tempo_musical_bureau")
    ctx, page = new_page(b, "pc", log=log, touch=False)
    src = OUT / "projet_tempo_musical.zip"
    make_project(src)
    open_project(page, src, "pc_00_ouvert")
    p0 = pos(page)
    R["avant"] = p0
    check("ouverture : 90 BPM, 16 notes, clip MIDI mesure 2, clip audio mesure 3, repère mesure 5",
          p0["bpm"] == 90 and len(p0["notes"]) == 16 and p0["clip"] == "2|1|000" and p0["sample"] == "3|1|000" and p0["marker"] == "5|1|000", p0)

    # 1. 90 → 140 par la fenêtre Tempo et mesure.
    open_tempo(page)
    shot(page, "pc_01_fenetre_tempo")
    keep = page.locator('[data-testid="tempo-keep-audio"]')
    check("option « Garder les clips audio à leur place » visible, décochée d'office (pas de beat importé)", keep.count() == 1 and not keep.is_checked())
    inp = page.locator('[data-testid="tempo-bpm-input"]')
    inp.fill("140"); inp.press("Enter"); page.wait_for_timeout(700)
    shot(page, "pc_02_tempo_140")
    close_tempo(page)
    p1 = pos(page)
    R["apres_140"] = p1
    same = [k for k in ("clip", "clipEnd", "notes", "sample", "marker", "loop") if p1[k] != p0[k]]
    check("140 BPM : 100 % des notes, débuts / fins de clips, repère et boucle sur la même mesure | temps | tick", p1["bpm"] == 140 and not same, {"differents": same, "avant": p0["notes"][:4], "apres": p1["notes"][:4]})
    msg = page.evaluate("() => document.body.innerText")
    check("message : « … même mesure qu'avant » et Ctrl+Z", "même mesure qu'avant" in msg and "Ctrl+Z" in msg)
    shot(page, "pc_03_arrangement_140")

    # 2. Export = projet écrit directement à 140.
    ex = page.evaluate(RENDER_JS, {"bpm": 140})
    R["export_140"] = ex
    check("export après le changement = projet écrit directement à 140 BPM (écart ≤ 1e-6, son présent)", ex["diff"] <= 1e-6 and ex["rms"] > 1e-4, ex)

    # Annulation : une seule étape.
    page.mouse.click(800, 450); page.wait_for_timeout(200)
    page.keyboard.press("Control+z"); page.wait_for_timeout(900)
    pu = pos(page)
    check("Ctrl+Z : UNE étape ramène 90 BPM et toutes les positions en secondes", pu["bpm"] == 90 and pu["noteSec"] == p0["noteSec"] and pu["sampleSec"] == p0["sampleSec"], {"bpm": pu["bpm"], "notes": pu["noteSec"][:3]})

    # 3. Garder l'audio à sa place.
    open_tempo(page)
    page.locator('[data-testid="tempo-keep-audio"]').check(); page.wait_for_timeout(300)
    inp = page.locator('[data-testid="tempo-bpm-input"]')
    inp.fill("120"); inp.press("Enter"); page.wait_for_timeout(700)
    shot(page, "pc_04_garder_audio")
    close_tempo(page)
    p2 = pos(page)
    R["garder_audio_120"] = p2
    check("« Garder l'audio » : le clip audio reste à la même seconde, les notes gardent leur mesure",
          p2["bpm"] == 120 and p2["audioMode"] == "keep" and p2["sampleSec"] == p0["sampleSec"] and p2["notes"] == p0["notes"], {"sample": [p0["sampleSec"], p2["sampleSec"]], "mode": p2["audioMode"]})

    # 4. Rampe 120 → 100 sur les mesures 5 à 9 (changement à la mesure 9, en rampe).
    open_tempo(page)
    page.locator('[data-testid="tempo-new-bar"]').fill("9")
    page.locator('[data-testid="tempo-new-bpm"]').fill("100")
    page.locator('[data-testid="tempo-new-ramp"]').check()
    page.locator('[data-testid="tempo-new-bar"]').fill("9")
    page.wait_for_timeout(200)
    page.locator('[data-testid="tempo-add"]').click(); page.wait_for_timeout(700)
    shot(page, "pc_05_rampe_fenetre")
    rampe_txt = page.locator('[data-testid="tempo-ramp-8"]').inner_text() if page.locator('[data-testid="tempo-ramp-8"]').count() else ""
    check("fenêtre : le changement de la mesure 9 est marqué « ↘ rampe depuis la mesure 1 »", "rampe depuis la mesure 1" in rampe_txt, rampe_txt)
    close_tempo(page)
    p3 = pos(page)
    R["rampe"] = p3
    check("rampe : notes, clip MIDI, repère et boucle gardent leur mesure", p3["notes"] == p0["notes"] and p3["clip"] == p0["clip"] and p3["marker"] == p0["marker"] and p3["loop"] == p0["loop"],
          {"notes": p3["notes"][:3], "marker": p3["marker"]})
    clicks = page.evaluate("""async () => {
      const T = await window.__novaAppModule('/utils/tempoMap.ts');
      const m = T.tempoMapStore.get();
      const L = 32, b0 = 120, b1 = 100, k = (b1 - b0) / L;
      const theo = x => 60 / k * Math.log((b0 + k * x) / b0);
      const c = T.beatsInRange(m, 0, T.barToTime(m, 8) - 1e-6);
      return { n: c.length, pire_ms: Math.max(...c.map((x, i) => Math.abs(x.time - theo(i)) * 1000)), fin: T.barToTime(m, 8), tempo_mi: T.tempoAt(m, theo(16)) };
    }""")
    R["clics_rampe"] = clicks
    check("clic de la rampe : 32 temps à ±1 ms de la position théorique (tempo 110 BPM à mi-chemin)", clicks["n"] == 32 and clicks["pire_ms"] < 1 and abs(clicks["tempo_mi"] - 110) < 1e-6, clicks)
    band = page.locator('[data-testid="tempo-ramp-band-0"]')
    check("piste tempo : bande de rampe affichée", band.count() == 1 and band.is_visible())
    shot(page, "pc_06_rampe_piste_tempo")
    piano_roll_rampe(page, R)
    page.evaluate("() => window.DAW_CONTROL.setTheme('light')"); page.wait_for_timeout(600)
    shot(page, "pc_07_rampe_theme_clair")
    open_tempo(page)
    shot(page, "pc_08_fenetre_theme_clair")
    close_tempo(page)
    page.evaluate("() => window.DAW_CONTROL.setTheme('dark')"); page.wait_for_timeout(400)

    # 5. Sauvegarde.
    dest = OUT / "seance_tempo_musical.zip"
    page.mouse.click(800, 450); page.wait_for_timeout(200)
    page.keyboard.press("Control+s"); page.wait_for_timeout(900)
    loc = page.get_by_role("button", name=re.compile("(Export local|cet appareil)", re.I)).first
    with page.expect_download(timeout=90000) as dl:
        loc.click()
    dl.value.save_as(str(dest))
    page.wait_for_timeout(800)
    with zipfile.ZipFile(dest) as z:
        pj = json.loads(z.read("project.json"))
    R["sauvegarde"] = {"bpm": pj.get("bpm"), "tempoEvents": pj.get("tempoEvents"), "tempoAudioMode": pj.get("tempoAudioMode")}
    check("sauvegarde : project.json porte la rampe (mesure 9, 100 BPM) et l'option audio",
          any(e.get("bar") == 8 and e.get("bpm") == 100 and e.get("ramp") is True for e in (pj.get("tempoEvents") or [])) and pj.get("tempoAudioMode") == "keep", R["sauvegarde"])
    R["final"] = pos(page)
    errs = log.errors()
    check("bureau : aucune erreur dans la console", not errs, errs[:5])
    save_log(log)
    ctx.close()
    return dest


def reload_desktop(b, f: Path):
    log = Log("tempo_musical_rechargement")
    ctx, page = new_page(b, "pc", log=log, touch=False)
    open_project(page, f, "pc_09_rechargement")
    page.wait_for_timeout(1000)
    p = pos(page)
    res["rechargement"] = p
    before = res["bureau"]["final"]
    check("rechargement : même tempo, même rampe, mêmes positions (secondes et mesures)",
          p["bpm"] == before["bpm"] and p["noteSec"] == before["noteSec"] and p["notes"] == before["notes"] and p["events"] == before["events"], {"avant": before["events"], "apres": p["events"]})
    errs = log.errors()
    check("rechargement : aucune erreur dans la console", not errs, errs[:5])
    save_log(log)
    ctx.close()


def phone(b, f: Path):
    for theme in ("dark", "light"):
        log = Log(f"tempo_musical_tel_{theme}")
        ctx, page = new_page(b, "tel390", log=log, touch=True)
        page.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); }} catch (e) {{}}")
        open_project(page, f, f"tel_{theme}_00_ouvert", touch=True)
        # Menu ☰ du téléphone → « Tempo et mesure ».
        opened = False
        try:
            page.get_by_role("button", name=re.compile("menu", re.I)).locator("visible=true").first.tap(); page.wait_for_timeout(500)
            page.get_by_role("button", name="Tempo et mesure").locator("visible=true").first.tap(); page.wait_for_timeout(500)
            opened = page.locator('[data-testid="tempo-dialog"]').is_visible()
        except Exception as e:
            log.add("note", f"menu : {e}")
        if not opened:
            page.keyboard.press("Control+k"); page.wait_for_timeout(400)
            page.keyboard.type("Tempo, mesure"); page.wait_for_timeout(400); page.keyboard.press("Enter"); page.wait_for_timeout(600)
            opened = page.locator('[data-testid="tempo-dialog"]').is_visible()
        check(f"téléphone ({theme}) : la fenêtre « Tempo et mesure » s'ouvre", opened)
        if opened:
            shot(page, f"tel_{theme}_01_tempo")
            page.locator('[data-testid="tempo-follow"]').scroll_into_view_if_needed(); page.wait_for_timeout(300)
            shot(page, f"tel_{theme}_02_option_audio")
            hs = page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1")
            check(f"téléphone ({theme}) : pas de défilement horizontal", hs)
            rp = page.locator('[data-testid="tempo-ramp-8"]')
            check(f"téléphone ({theme}) : la rampe est lisible dans la liste", rp.count() == 1 and rp.is_visible())
        errs = log.errors()
        check(f"téléphone ({theme}) : aucune erreur dans la console", not errs, errs[:5])
        save_log(log)
        ctx.close()


with sync_playwright() as p:
    b = launch(p)
    try:
        saved = desktop(b)
        reload_desktop(b, saved)
        phone(b, saved)
    finally:
        b.close()

res["verifications"] = checks
res["bilan"] = {"ok": sum(c["ok"] for c in checks), "total": len(checks)}
(OUT / "tempo_musical.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
print("\nBILAN :", json.dumps(res["bilan"], ensure_ascii=False))
sys.exit(0 if all(c["ok"] for c in checks) else 1)
