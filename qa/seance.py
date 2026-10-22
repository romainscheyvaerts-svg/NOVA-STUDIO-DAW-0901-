"""🥁 Musiciens de séance (L3, écart 16) : batteur, basse 808 et claviers qui suivent les accords (bout en bout, hors production).

Navigateur headless (aucune fenêtre), Supabase simulé (qa_hors_prod), aucun micro, aucune carte son réelle.

Projet à 140 BPM, La mineur : piste d'accords Am – F – C – G (8 mesures), repères Intro (2 mesures), Refrain (4), Couplet (2).
Bureau 1600 × 900 (sombre puis clair) :
  1. clic droit sur une piste → « Ajouter un musicien de séance… » ; panneau de création (rôles, styles, motifs) ;
     basse choisie sans accords ? (non : le projet en a) ; « Ajouter le batteur » Trap, une région par section ;
  2. batteur : 3 régions nommées par section ; kick sur le 1 et clap sur le 3 de chaque mesure hors remplissage, à ±1 ms
     à 140 BPM ; intro moins dense que le refrain ; notes jouées par le moteur (lecture = export) = notes du clip ;
  3. bassiste 808 (palette d'événement) : 100 % des changements d'accord ont la fondamentale (±1 ms), 100 % des notes
     dans l'accord ou la gamme ;
  4. un accord change (F → Dm) : la basse suit, et Ctrl+Z ramène accord ET basse en une étape ;
  5. complexité d'une région au curseur : plus de notes ; intensité : vélocités plus fortes ;
  6. export (rendu hors ligne) de la basse = rendu après « Figer en notes MIDI » (écart ≤ 1e-6) ; figer = mêmes notes ;
  7. tempo 140 → 150 : mêmes positions musicales, régions non figées ;
  8. sauvegarde (.zip) → rechargement : réglages et notes identiques.
Téléphone 390 × 844 (sombre, clair) : le panneau s'affiche sans défilement horizontal.

NOVA_URL=http://127.0.0.1:3527/ python qa/seance.py
Sorties : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-pro-2026\\seance\\qa) : seance.json + captures.
"""
import json, os, re, sys, zipfile
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3527/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-pro-2026\seance\qa")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402,F401  (Supabase simulé avant tout navigateur)
from qalib import BASE, OUT, Log, new_page, shot, save_log, launch, menu_pick  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BPM = 140
BAR = 4 * 60 / BPM
SIX = BAR / 16
checks = []
res = {"bureau": {}, "rechargement": {}, "telephone": {}}


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:700]}"), flush=True)


PROG = [(9, "min"), (5, "maj"), (0, "maj"), (7, "maj")]


def chords(prog=PROG):
    return [{"id": f"c{i}", "start": i * BAR, "end": (i + 1) * BAR, "root": prog[i % 4][0], "quality": prog[i % 4][1]} for i in range(8)]


def make_project(path: Path):
    synth = {"id": "synth", "name": "Synth", "type": "MIDI", "color": "#a78bfa", "isMuted": False, "isSolo": False, "isTrackArmed": False,
             "isFrozen": False, "volume": 0.9, "pan": 0, "outputTrackId": "master", "sends": [], "plugins": [], "automationLanes": [], "totalLatency": 0, "clips": []}
    markers = [
        {"id": "m1", "name": "Intro", "time": 0, "endTime": 2 * BAR, "type": "REGION", "color": "#94a3b8"},
        {"id": "m2", "name": "Refrain", "time": 2 * BAR, "endTime": 6 * BAR, "type": "REGION", "color": "#f472b6"},
        {"id": "m3", "name": "Couplet", "time": 6 * BAR, "endTime": 8 * BAR, "type": "REGION", "color": "#22d3ee"},
    ]
    state = {
        "id": "proj-seance", "name": "Musiciens de séance", "bpm": BPM, "timeSignature": {"numerator": 4, "denominator": 4},
        "projectKey": 9, "projectScale": "MINOR", "chords": chords(),
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8 * BAR,
        "tracks": [synth], "trackGroups": [], "markers": markers, "selectedTrackId": "synth", "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "projectMode": "BEATMAKING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))


INIT = """
try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_count_in', '0'); localStorage.setItem('nova_auto_clean', '0');
      localStorage.setItem('nova_welcome_seen', '1'); localStorage.setItem('nova_chord_lane', '1'); } catch (e) {}
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


STATE_JS = """async () => {
  const st = window.DAW_CONTROL.getState();
  const F = await window.__novaAppModule('/engine/midiFx/index.ts');
  const out = [];
  for (const t of st.tracks) {
    if (!t.clips.some(c => c.seance)) continue;
    const played = F.clipsWithMidiFx(t, t.clips);
    out.push({ id: t.id, name: t.name, type: t.type, rows: (t.drumMachine?.rows || []).map(r => r.id), bass808: !!t.bass808,
      clips: t.clips.map((c, i) => ({ id: c.id, name: c.name, start: c.start, duration: c.duration, seance: c.seance || null,
        notes: (c.notes || []).map(n => ({ p: n.pitch, s: +(c.start + n.start).toFixed(6), d: +n.duration.toFixed(6), v: +n.velocity.toFixed(4) })),
        sameAsPlayed: JSON.stringify(played[i].notes) === JSON.stringify(c.notes) })) });
  }
  return { tracks: out, chords: st.chords, bpm: st.bpm, frozen: st.tracks.flatMap(t => t.clips.filter(c => / \\(figé\\)$/.test(c.name)).map(c => ({ t: t.id, n: c.notes.length }))) };
}"""


def seance_state(page):
    return page.evaluate(STATE_JS)


def pc(n):
    return n % 12


TONES = {"min": [0, 3, 7], "maj": [0, 4, 7]}
SCALE_AM = {9, 11, 0, 2, 4, 5, 7}


def chord_at(chs, t):
    for c in chs:
        if c["start"] - 1e-6 <= t < c["end"] - 1e-6:
            return c
    return None


RENDER_JS = """async (id) => {
  const { audioEngine: E } = await window.__novaAppModule('/engine/AudioEngine.ts');
  await E.init();
  const t = window.DAW_CONTROL.getState().tracks.find(x => x.id === id);
  const b = await E.renderProject([t], 4 * %f, 0, 48000);
  return Array.from(b.getChannelData(0));
}""" % BAR


def desktop(b):
    R = res["bureau"]
    log = Log("seance_bureau")
    ctx, page = new_page(b, "pc", log=log, touch=False)
    src = OUT / "projet_seance.zip"
    make_project(src)
    open_project(page, src, "pc_00_ouvert")

    # 1. Menu de la piste → Ajouter un musicien de séance.
    hdr = page.locator("[data-track-header='synth']").first
    hdr.click(button="right"); page.wait_for_timeout(400)
    shot(page, "pc_01_menu_piste")
    menu_pick(page, "Ajouter un musicien de séance"); page.wait_for_timeout(700)
    panel = page.locator('[data-testid="seance-panel"]')
    check("menu de la piste : le panneau « Musiciens de séance » s'ouvre en création (3 musiciens, 6 styles)",
          panel.count() == 1 and page.locator('[data-testid^="seance-role-"]').count() == 3 and page.locator('[data-testid^="seance-style-"]').count() == 6)
    page.locator('[data-testid="seance-role-drums"]').click()
    page.locator('[data-testid="seance-style-trap"]').click()
    page.wait_for_timeout(200)
    shot(page, "pc_02_creation")
    check("création : « Une région par section (3) » proposé et coché", page.locator('[data-testid="seance-by-section"]').is_checked())
    page.locator('[data-testid="seance-add"]').click(); page.wait_for_timeout(1500)
    shot(page, "pc_03_batteur_ajoute")

    # 2. Batteur.
    s = seance_state(page)
    drums = [t for t in s["tracks"] if t["type"] == "DRUM_RACK"]
    check("batteur : une piste BATTEUR, 3 régions nommées par section", len(drums) == 1 and [c["name"] for c in drums[0]["clips"]] == [
        "Batteur · Trap · Intro", "Batteur · Trap · Refrain", "Batteur · Trap · Couplet"], [c["name"] for c in drums[0]["clips"]] if drums else s)
    d = drums[0]
    R["batteur"] = {"regions": [{"nom": c["name"], "notes": len(c["notes"]), "reglages": c["seance"]} for c in d["clips"]]}
    kick = 60 + d["rows"].index("kick")
    clap = 60 + (d["rows"].index("clap") if "clap" in d["rows"] else d["rows"].index("snare"))
    allnotes = [n for c in d["clips"] for n in c["notes"]]
    # Mesures sans remplissage : toutes sauf la dernière de chaque région (intro 1, refrain 5, couplet 7) et la 3 (phrase de 4 au refrain).
    fill_bars = set()
    for c in d["clips"]:
        last = round((c["start"] + c["duration"]) / BAR) - 1
        fill_bars.add(last)
        every = 4 if c["seance"]["fills"] >= 8 else 8 if c["seance"]["fills"] >= 4 else 0
        if every:
            for bb in range(round(c["start"] / BAR), last + 1):
                if (bb + 1) % every == 0: fill_bars.add(bb)
    miss = []
    for bar in range(8):
        t1 = bar * BAR
        # Motif A de la trap sur 2 mesures : kick sur le 1 de la 1re mesure du motif (la 2e commence au pas 3).
        if bar % 2 == 0 and not any(n["p"] == kick and abs(n["s"] - t1) * 1000 < 1 for n in allnotes): miss.append(("kick", bar))
        if bar not in fill_bars and not any(n["p"] == clap and abs(n["s"] - (t1 + 2 * BAR / 4)) * 1000 < 1 for n in allnotes): miss.append(("clap", bar))
    check("batteur à 140 BPM : kick sur le 1 (1re mesure du motif) et clap sur le 3 (hors remplissage), à ±1 ms", not miss, {"manque": miss, "fills": sorted(fill_bars)})
    dens = [len(c["notes"]) / c["duration"] for c in d["clips"]]
    check("intro plus calme que le refrain (densité de notes)", dens[0] < dens[1], dens)
    check("lecture = export : le moteur joue exactement les notes des régions", all(c["sameAsPlayed"] for c in d["clips"]))

    # 3. Bassiste (palette / événement) : 808 trap.
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    page.evaluate("() => window.dispatchEvent(new CustomEvent('nova:open-seance', { detail: {} }))"); page.wait_for_timeout(500)
    page.locator('[data-testid="seance-role-bass"]').click()
    page.locator('[data-testid="seance-style-trap"]').click()
    page.locator('[data-testid="seance-by-section"]').uncheck()
    page.locator('[data-testid="seance-add"]').click(); page.wait_for_timeout(1500)
    shot(page, "pc_04_basse_ajoutee")
    s = seance_state(page)
    bass = [t for t in s["tracks"] if t["bass808"]]
    check("bassiste : piste BASSE 808, une région sur les 8 mesures d'accords", len(bass) == 1 and len(bass[0]["clips"]) == 1 and abs(bass[0]["clips"][0]["duration"] - 8 * BAR) < 1e-6,
          [(t["name"], len(t["clips"])) for t in s["tracks"]])
    bid = bass[0]["id"]

    def bass_checks(st, label):
        bt = [t for t in st["tracks"] if t["id"] == bid][0]
        notes = [n for c in bt["clips"] for n in c["notes"]]
        roots_ok = all(any(abs(n["s"] - c["start"]) * 1000 < 1 and pc(n["p"]) == c["root"] for n in notes) for c in st["chords"])
        bad = [n for n in notes if pc(n["p"]) not in SCALE_AM | {(chord_at(st["chords"], n["s"])["root"] + i) % 12 for i in TONES[chord_at(st["chords"], n["s"])["quality"]]}]
        check(f"{label} : 100 % des changements d'accord ont la fondamentale (±1 ms), 100 % des notes dans l'accord ou la gamme", roots_ok and not bad and notes,
              {"fondamentales": roots_ok, "hors": bad[:5], "n": len(notes)})
        return notes

    R["basse"] = bass_checks(s, "basse 808")

    # 4. Un accord change : la basse suit ; Ctrl+Z ramène les deux en une étape.
    new = chords([(9, "min"), (2, "min"), (0, "maj"), (7, "maj")])
    page.evaluate("(c) => window.DAW_CONTROL.setChords(c)", new); page.wait_for_timeout(600)
    s2 = seance_state(page)
    bar2 = [n for c in [t for t in s2["tracks"] if t["id"] == bid][0]["clips"] for n in c["notes"] if BAR - 1e-6 <= n["s"] < 2 * BAR - 1e-6]
    check("accord F → Dm (mesure 2) : la basse joue Ré au changement, dans la même mise à jour", any(abs(n["s"] - BAR) < 1e-3 and pc(n["p"]) == 2 for n in bar2), bar2)
    bass_checks(s2, "après le changement d'accord")
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    page.mouse.click(1200, 820); page.wait_for_timeout(200)
    page.keyboard.press("Control+z"); page.wait_for_timeout(800)
    s3 = seance_state(page)
    b3 = [n for c in [t for t in s3["tracks"] if t["id"] == bid][0]["clips"] for n in c["notes"] if BAR - 1e-6 <= n["s"] < 2 * BAR - 1e-6]
    check("Ctrl+Z : l'accord (Fa) ET la basse reviennent en une seule étape", s3["chords"][1]["root"] == 5 and any(abs(n["s"] - BAR) < 1e-3 and pc(n["p"]) == 5 for n in b3), {"accord": s3["chords"][1], "basse": b3[:3]})

    # 5. Réglages d'une région au curseur (panneau du batteur, via le clic droit sur la région du refrain).
    page.evaluate("(id) => window.dispatchEvent(new CustomEvent('nova:open-seance', { detail: { trackId: id, clipId: %s } }))" % json.dumps(d["clips"][1]["id"]), d["id"])
    page.wait_for_timeout(600)
    shot(page, "pc_05_reglages_batteur")
    refrain = page.locator('[data-testid="seance-region"]').nth(1)
    before = len(seance_state(page)["tracks"][0]["clips"][1]["notes"])
    refrain.locator('[data-testid="seance-complexity"]').fill("10"); page.wait_for_timeout(500)
    after = seance_state(page)["tracks"][0]["clips"][1]
    vel_before = sum(n["v"] for n in after["notes"]) / len(after["notes"])
    refrain.locator('[data-testid="seance-intensity"]').fill("3"); page.wait_for_timeout(500)
    soft = seance_state(page)["tracks"][0]["clips"][1]
    vel_after = sum(n["v"] for n in soft["notes"]) / len(soft["notes"])
    shot(page, "pc_06_refrain_complexe")
    intro_same = seance_state(page)["tracks"][0]["clips"][0]["seance"]["complexity"] == d["clips"][0]["seance"]["complexity"]
    check("curseur Complexité 10 sur le refrain : plus de notes ; l'intro ne bouge pas", len(after["notes"]) > before and after["seance"]["complexity"] == 10 and intro_same,
          {"avant": before, "apres": len(after["notes"])})
    check("curseur Intensité 3 : coups plus doux", vel_after < vel_before, {"avant": vel_before, "apres": vel_after})
    R["reglages"] = {"notes_refrain": [before, len(after["notes"])], "velocite": [vel_before, vel_after]}
    page.keyboard.press("Escape"); page.wait_for_timeout(300)

    # 6. Export = figé.
    a = page.evaluate(RENDER_JS, bid)
    a2 = page.evaluate(RENDER_JS, bid)
    base = max(abs(x - y) for x, y in zip(a, a2)) if a and a2 else 99
    heard = [c["notes"] for c in [t for t in seance_state(page)["tracks"] if t["id"] == bid][0]["clips"]]
    page.evaluate("(id) => window.dispatchEvent(new CustomEvent('nova:open-seance', { detail: { trackId: id } }))", bid); page.wait_for_timeout(500)
    page.locator('[data-testid="seance-freeze"]').click(); page.wait_for_timeout(700)
    shot(page, "pc_07_basse_figee")
    st = page.evaluate("(id) => { const t = window.DAW_CONTROL.getState().tracks.find(x => x.id === id); return t.clips.map(c => ({ seance: !!c.seance, name: c.name, notes: c.notes.map(n => ({ p: n.pitch, s: +(c.start + n.start).toFixed(6), d: +n.duration.toFixed(6), v: +n.velocity.toFixed(4) })) })); }", bid)
    check("« Figer en notes MIDI » : mêmes notes, réglages retirés, clip « (figé) »", [c["notes"] for c in st] == heard and not any(c["seance"] for c in st) and st[0]["name"].endswith("(figé)"),
          [c["name"] for c in st])
    bb = page.evaluate(RENDER_JS, bid)
    diff = max(abs(x - y) for x, y in zip(a, bb)) if a and bb else 99
    rms = (sum(x * x for x in a) / max(1, len(a))) ** 0.5
    R["export"] = {"diff": diff, "rms": rms, "ecart_deux_rendus": base}
    check("export de la basse musicien = export des notes figées (écart ≤ 1e-6 ; son présent)", diff <= 1e-6 and rms > 1e-4, R["export"])
    page.keyboard.press("Control+z"); page.wait_for_timeout(700)
    back = page.evaluate("(id) => window.DAW_CONTROL.getState().tracks.find(x => x.id === id).clips.every(c => !!c.seance)", bid)
    check("Ctrl+Z : la basse redevient un musicien", back)

    # 7. Tempo 140 → 150 : mêmes positions musicales.
    pre = seance_state(page)
    page.evaluate("() => window.DAW_CONTROL.setBpm(150)"); page.wait_for_timeout(1200)
    post = seance_state(page)
    def quarters(st, bpm):
        return [[round(n["s"] * bpm / 60, 4) for n in c["notes"]] for t in st["tracks"] for c in t["clips"]]
    still = all(c["seance"] for t in post["tracks"] for c in t["clips"])
    check("tempo 140 → 150 : chaque note garde sa position musicale ; régions toujours « musicien »", post["bpm"] == 150 and quarters(pre, 140) == quarters(post, 150) and still,
          {"bpm": post["bpm"], "toujours_musicien": still})
    page.evaluate("() => window.DAW_CONTROL.setBpm(140)"); page.wait_for_timeout(1000)

    # Thème clair.
    page.evaluate("(id) => window.dispatchEvent(new CustomEvent('nova:open-seance', { detail: { trackId: id } }))", d["id"]); page.wait_for_timeout(500)
    page.evaluate("() => window.DAW_CONTROL.setTheme('light')"); page.wait_for_timeout(600)
    shot(page, "pc_08_theme_clair")
    page.evaluate("() => window.DAW_CONTROL.setTheme('dark')"); page.wait_for_timeout(300)
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    shot(page, "pc_09_arrangement")

    # 8. Sauvegarde.
    dest = OUT / "seance_musiciens.zip"
    page.mouse.click(1200, 820); page.wait_for_timeout(200)
    page.keyboard.press("Control+s"); page.wait_for_timeout(900)
    loc = page.get_by_role("button", name=re.compile("(Export local|cet appareil)", re.I)).first
    with page.expect_download(timeout=90000) as dl:
        loc.click()
    dl.value.save_as(str(dest))
    page.wait_for_timeout(800)
    with zipfile.ZipFile(dest) as z:
        pj = json.loads(z.read("project.json"))
    n_seance = sum(1 for t in pj["tracks"] for c in t["clips"] if c.get("seance"))
    check("sauvegarde : project.json porte les régions musicien et leurs réglages", n_seance == 4, n_seance)
    R["final"] = seance_state(page)
    errs = log.errors()
    check("bureau : aucune erreur dans la console", not errs, errs[:5])
    save_log(log)
    ctx.close()
    return dest


def reload_desktop(b, f: Path):
    log = Log("seance_rechargement")
    ctx, page = new_page(b, "pc", log=log, touch=False)
    open_project(page, f, "pc_10_rechargement")
    page.wait_for_timeout(800)
    s = seance_state(page)
    res["rechargement"] = {"pistes": [t["name"] for t in s["tracks"]], "etat": s}
    before = res["bureau"]["final"]
    strip = lambda st: [[(c["name"], c["notes"], {k: v for k, v in (c["seance"] or {}).items()}) for c in t["clips"]] for t in st["tracks"]]
    check("rechargement : mêmes régions, mêmes réglages, mêmes notes", strip(s) == strip(before), {"avant": len(before["tracks"]), "apres": len(s["tracks"])})
    errs = log.errors()
    check("rechargement : aucune erreur dans la console", not errs, errs[:5])
    save_log(log)
    ctx.close()


def phone(b, f: Path):
    for theme in ("dark", "light"):
        log = Log(f"seance_tel_{theme}")
        ctx, page = new_page(b, "tel390", log=log, touch=True)
        page.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); }} catch (e) {{}}")
        open_project(page, f, f"tel_{theme}_00_ouvert", touch=True)
        tid = page.evaluate("() => window.DAW_CONTROL.getState().tracks.find(t => t.clips.some(c => c.seance))?.id")
        page.evaluate("(id) => window.dispatchEvent(new CustomEvent('nova:open-seance', { detail: { trackId: id } }))", tid); page.wait_for_timeout(700)
        ok = page.locator('[data-testid="seance-panel"]').is_visible()
        shot(page, f"tel_{theme}_01_musicien")
        hs = page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1")
        check(f"téléphone ({theme}) : le panneau du musicien s'affiche, sans défilement horizontal", ok and hs, {"ok": ok, "hs": hs})
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
(OUT / "seance.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
print("\nBILAN :", json.dumps(res["bilan"], ensure_ascii=False))
sys.exit(0 if all(c["ok"] for c in checks) else 1)
