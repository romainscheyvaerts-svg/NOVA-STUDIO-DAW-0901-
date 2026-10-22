"""📌 Prises gardées : la zone au-dessus de la piste qu'on enregistre (bout en bout, hors production).

Navigateur headless (aucune fenêtre), micro simulé (--use-fake-device-for-media-stream : un
balayage de fréquence, chaque prise sonne différemment), Supabase simulé (qa_hors_prod).

Bureau 1600 × 900 (sombre, puis clair) :
  1. 4 prises sur « Voix lead » (REC au clavier, STOP) ;
  2. on en garde 3 par 3 chemins : le bandeau de fin de prise (« 📌 Garder Prise 1 »),
     le raccourci Ctrl+Alt+P, le clip glissé dans la zone ; la pastille « 📌 Garder » du clip
     garde la 4e puis Ctrl+Z l'enlève (annulation) ; la palette Ctrl+K connaît la commande ;
  3. la zone grandit d'une ligne (44 px) par prise gardée : 3 lignes ;
  4. renommer, noter (★), couleur ; écouter une ligne en solo (lecture directe) ;
  5. « Mettre sur la piste » la 2e (Ctrl+Z / Ctrl+Y) ; comp : un passage balayé sur la ligne de la 3e ;
  6. export : le moteur de l'export (renderProject) avec et sans les clips muets donne EXACTEMENT
     le même son (les prises gardées ne jouent pas) ; par zone, le son est celui de la bonne prise ;
  7. aucun bouton de la zone recouvert (elementFromPoint au centre de chacun) ;
  8. sauvegarde (.zip) → project.json porte les repères ; rechargement : tout revient.
Téléphone 390 × 844 (au doigt, sombre puis clair) : la carte « 📌 Prises gardées » (3 lignes),
écouter, noter, « ⤓ Piste », rien de recouvert.

NOVA_URL=http://127.0.0.1:3463/ python qa/prises_gardees.py
Sorties : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-prises-gardees\\qa) : prises_gardees.json + captures.
"""
import io, json, math, os, re, sys, time, wave, zipfile
from pathlib import Path

import numpy as np

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3463/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-prises-gardees\qa")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402,F401  (Supabase simulé avant tout navigateur)
from qalib import BASE, OUT, CHROME, Log, new_page, shot, save_log, balayage_chevauchement  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SR = 48000
MIC_WAV = OUT / "micro_balayage_150_1200hz.wav"
TID = "track-rec-main"
TAKE_S = 7.0
LANE_H = 44
HEAD_H = 30

checks = []
res = {"bureau": {}, "rechargement": {}, "telephone": {}}


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:700]}"), flush=True)


def sweep_wav(f0, f1, seconds, amp=0.25, sr=SR) -> bytes:
    t = np.arange(int(seconds * sr)) / sr
    k = (f1 - f0) / seconds
    x = amp * np.sin(2 * np.pi * (f0 * t + 0.5 * k * t * t))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def launch(p):
    if not MIC_WAV.exists():
        MIC_WAV.write_bytes(sweep_wav(150, 1200, 180))
    return p.chromium.launch(headless=True, executable_path=CHROME, args=[
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
        f"--use-file-for-fake-audio-capture={MIC_WAV}", "--autoplay-policy=no-user-gesture-required"])


def make_project(path: Path):
    track = {"id": TID, "name": "Voix lead", "type": "AUDIO", "color": "#22d3ee", "isMuted": False, "isSolo": False,
             "isTrackArmed": True, "isFrozen": False, "volume": 1.0, "pan": 0, "outputTrackId": "master",
             "sends": [], "clips": [], "plugins": [], "automationLanes": [], "totalLatency": 0}
    state = {
        "id": "proj-prises-gardees", "name": "Prises gardées", "bpm": 90, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": [track], "trackGroups": [], "markers": [], "selectedTrackId": TID, "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True, "vocalMixStyle": "voix-brute",
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))


INIT = """
try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_count_in', '0'); localStorage.setItem('nova_auto_clean', '0');
      localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}
"""


def open_project(page, f: Path, label, touch=False):
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
    if not touch:
        adv = page.get_by_role("button", name=re.compile("Mode avanc", re.I)).locator("visible=true").first
        try:
            if adv.is_visible(): adv.click(); page.wait_for_timeout(500)
        except Exception:
            pass
    shot(page, label)


def st(page, expr="s => s"):
    return page.evaluate(f"() => {{ const s = window.DAW_CONTROL.getState(); return ({expr})(s); }}")


KEPT_JS = """async (tid) => {
  const K = await window.__novaAppModule('/utils/keptTakes.ts');
  const P = await window.__novaAppModule('/utils/playlists.ts');
  const C = await window.__novaAppModule('/utils/comping.ts');
  const t = window.DAW_CONTROL.getState().tracks.find(x => x.id === tid);
  return {
    kept: K.keptLanes(t).map(l => ({ n: l.n, name: l.name, stars: l.stars, color: l.color, used: +l.used.toFixed(3), start: +l.start.toFixed(3), end: +l.end.toFixed(3) })),
    lanes: P.listLanes(t).map(l => l.n),
    audible: [...new Set(t.clips.filter(c => !c.isMuted && c.takeNumber).map(c => c.takeNumber))],
    comp: C.readComp(t.clips).map(s => ({ n: s.n, start: +s.start.toFixed(3), end: +s.end.toFixed(3) })),
    clips: t.clips.map(c => ({ id: c.id, n: c.takeNumber, start: +c.start.toFixed(4), end: +(c.start + c.duration).toFixed(4), muted: !!c.isMuted })),
    last: K.lastTakeNumber(t),
  };
}"""

GEO_JS = """(tid) => {
  const box = e => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const zone = document.querySelector(`[data-kept-zone="${tid}"]`);
  const layer = document.querySelector('[data-testid="kept-layer"]');
  return {
    zone: box(zone && zone.parentElement), count: zone ? +zone.dataset.keptCount : null, open: zone ? zone.dataset.keptOpen : null,
    layer: box(layer), strip: box(document.querySelector(`[data-kept-strip="${tid}"]`)),
    stripText: (document.querySelector(`[data-kept-strip="${tid}"]`) || {}).innerText || null,
    rows: [...document.querySelectorAll('[data-kept-row]')].map(e => ({ n: +e.getAttribute('data-kept-row'), ...box(e) })),
    headers: [...document.querySelectorAll('[data-kept-zone] [data-kept-header]')].map(e => ({ n: +e.getAttribute('data-kept-header'), ...box(e) })),
    zoomH: layer ? +layer.dataset.zoomH : null, scrollLeft: layer ? +layer.dataset.scrollLeft : null, zoomV: layer ? +layer.dataset.zoomV : null,
  };
}"""

# Chaque bouton de la zone : son centre touche bien LE bouton (rien de flottant par-dessus).
COVER_JS = """(sel) => [...document.querySelectorAll(sel)].filter(b => b.offsetParent !== null).map(b => {
  const r = b.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  const inView = x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight;
  return { label: (b.getAttribute('aria-label') || b.innerText || '').trim().slice(0, 40), ok: !inView || (!!hit && (hit === b || b.contains(hit))),
           over: hit && hit !== b && !b.contains(hit) ? (hit.getAttribute('aria-label') || hit.className || hit.tagName).toString().slice(0, 80) : null, w: Math.round(r.width), h: Math.round(r.height) };
})"""

EXPORT_JS = """async ([tid, dur, zones]) => {
  const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const { audioBufferRegistry } = await window.__novaAppModule('/utils/audioBufferRegistry.ts');
  const C = await window.__novaAppModule('/utils/comping.ts');
  const s = window.DAW_CONTROL.getState();
  const strip = t => ({ ...t, plugins: [], sends: [], volume: 1, pan: 0, outputTrackId: undefined, automationLanes: [] });
  const all = s.tracks.filter(t => t.id === tid).map(strip);
  const onlyMain = all.map(t => ({ ...t, clips: t.clips.filter(c => !c.isMuted) }));
  const SR = 48000;
  const a = (await audioEngine.renderProject(all, dur, 0, SR)).getChannelData(0);
  const b = (await audioEngine.renderProject(onlyMain, dur, 0, SR)).getChannelData(0);
  let diff = 0, e = 0;
  for (let i = 0; i < a.length; i++) { diff = Math.max(diff, Math.abs(a[i] - b[i])); e += a[i] * a[i]; }
  const spans = C.takeSpans(all[0].clips);
  const srcAt = (n, t) => {
    const sp = spans.find(q => q.n === n && t >= q.start && t < q.end);
    if (!sp) return null;
    const buf = audioBufferRegistry.get(sp.base.bufferId);
    if (!buf) return null;
    return buf.getChannelData(0)[Math.round((t - sp.anchor) * buf.sampleRate)] * (sp.base.gain ?? 1);
  };
  const ns = [...new Set(spans.map(q => q.n))];
  const zr = zones.map(([z0, z1]) => {
    const out = { start: z0, end: z1, r: {} };
    for (const n of ns) {
      let sxy = 0, sxx = 0, syy = 0, cnt = 0;
      for (let t = z0; t < z1; t += 1 / SR) { const y = srcAt(n, t); if (y === null) continue; const v = a[Math.round(t * SR)]; sxy += v * y; sxx += v * v; syy += y * y; cnt++; }
      out.r[n] = cnt ? +(sxy / Math.sqrt(sxx * syy + 1e-20)).toFixed(4) : null;
    }
    return out;
  });
  return { ecart_max: diff, rms: Math.sqrt(e / a.length), zones: zr, muets: all[0].clips.filter(c => c.isMuted).length };
}"""


def kept(page):
    return page.evaluate(KEPT_JS, TID)


def geo(page):
    return page.evaluate(GEO_JS, TID)


def rec_take(page, n_expected):
    page.evaluate("() => window.DAW_CONTROL.seek(0)")
    page.wait_for_timeout(200)
    page.keyboard.press("r")
    t0 = time.time()
    while time.time() - t0 < 15 and not st(page, "s => s.isRecording"):
        page.wait_for_timeout(50)
    started = st(page, "s => s.isRecording")
    page.wait_for_timeout(int(TAKE_S * 1000))
    page.keyboard.press("r")
    t0 = time.time()
    while time.time() - t0 < 15:
        k = kept(page)
        if not st(page, "s => s.isRecording") and len(k["lanes"]) >= n_expected:
            break
        page.wait_for_timeout(100)
    page.wait_for_timeout(800)
    return started


def x_of(g, t):
    return g["layer"]["x"] + t * g["zoomH"] - g["scrollLeft"]


def clip_row_top(g):
    return g["zone"]["y"] + g["zone"]["h"]


def close_noise(page):
    # Bulles et panneaux de Nova (coach après la prise) : on les laisse, mais rien ne doit couvrir la zone.
    page.mouse.move(5, 5)


SET_SIMPLE = """async (on) => { const { simpleModeStore } = await window.__novaAppModule('/utils/simpleMode.ts'); simpleModeStore.setPref(on); return simpleModeStore.get().simple; }"""


def balayer(page, ou, R):
    """Balayage de chevauchement de TOUT l'écran (zone Prises gardées active, piste armée), en mode simple
    puis avancé : aucun élément cliquable recouvert par un autre (qalib.balayage_chevauchement)."""
    R.setdefault("balayage", {})
    depart = page.evaluate("async () => (await window.__novaAppModule('/utils/simpleMode.ts')).simpleModeStore.get().pref")
    for simple in (True, False):
        page.evaluate(SET_SIMPLE, simple); page.wait_for_timeout(600)
        page.mouse.move(2, 2)
        b = balayage_chevauchement(page)
        mode = "simple" if simple else "avancé"
        R["balayage"][mode] = b
        shot(page, f"{ou}_balayage_{'simple' if simple else 'avance'}")
        check(f"{ou} ({mode}, zone active, piste armée) : aucun bouton recouvert sur l'écran ({b.get('boutons')} boutons)",
              not b.get("erreur") and b.get("boutons", 0) > 10 and not b["recouverts"], b.get("recouverts") or b.get("erreur"))
    page.evaluate(SET_SIMPLE, depart); page.wait_for_timeout(400)


def desktop(b):
    f = OUT / "seance_vide.zip"
    make_project(f)
    log = Log("prises_gardees_pc")
    ctx, page = new_page(b, "pc", log=log, touch=False)
    open_project(page, f, "pc_00_seance")
    page.mouse.click(420, 860); page.wait_for_timeout(200)  # zone vide du bandeau du bas (barre allégée : « Piste voix » est vers x = 700)
    page.keyboard.press("Escape")
    R = res["bureau"]
    heights = []

    # --- Avant toute prise : la playlist (en-tête vide) est déjà visible au-dessus de la piste d'enregistrement
    g = geo(page)
    check("avant la 1re prise : playlist visible (en-tête vide) au-dessus de la piste d'enregistrement",
          g["zone"] and abs(g["zone"]["h"] - HEAD_H) < 1 and g["count"] == 0 and "chacune ajoute une ligne" in (g["stripText"] or ""), g)
    shot(page, "pc_00b_playlist_vide")

    # --- Prise 1 : le bandeau de fin de prise propose « 📌 Garder Prise 1 »
    check("prise 1 : REC part (micro simulé)", rec_take(page, 1))
    g = geo(page)
    R["apres_prise1"] = {"zone": g["zone"], "bandeau": g["stripText"]}
    check("après la 1re prise : zone (en-tête) au-dessus de la piste armée, état vide clair",
          g["zone"] and abs(g["zone"]["h"] - HEAD_H) < 1 and g["count"] == 0 and "tes meilleures prises" in (g["stripText"] or "").lower(), g)
    btn = page.locator('[data-testid="kept-keep-last"]').locator("visible=true")
    check("bandeau de fin de prise : bouton « 📌 Garder Prise 1 »", btn.count() == 1 and "Prise 1" in btn.first.inner_text(), btn.count())
    shot(page, "pc_01_fin_prise1_bandeau")
    btn.first.click(); page.wait_for_timeout(500)
    g = geo(page); heights.append(g["zone"]["h"])
    check("prise 1 gardée par le bandeau : 1 ligne", g["count"] == 1 and len(g["rows"]) == 1, g["count"])
    shot(page, "pc_02_prise1_gardee")

    # --- Prise 2 : Ctrl+Alt+P
    rec_take(page, 2)
    page.keyboard.press("Control+Alt+p"); page.wait_for_timeout(500)
    g = geo(page); heights.append(g["zone"]["h"])
    check("prise 2 gardée au raccourci Ctrl+Alt+P : 2 lignes", g["count"] == 2 and [r["n"] for r in g["rows"]] == [1, 2], [r["n"] for r in g["rows"]])

    # --- Prise 3 : glissée dans la zone (le clip ne bouge pas)
    rec_take(page, 3)
    k = kept(page); g = geo(page)
    c3 = [c for c in k["clips"] if c["n"] == 3 and not c["muted"]][0]
    top = clip_row_top(g)
    y0 = top + g["zoomV"] - 14
    x0 = x_of(g, (c3["start"] + c3["end"]) / 2)
    page.mouse.move(x0, y0); page.mouse.down()
    page.mouse.move(x0 + 3, y0 - 20, steps=3)
    page.mouse.move(x0 + 3, g["zone"]["y"] + HEAD_H / 2, steps=8)
    page.wait_for_timeout(200)
    shot(page, "pc_03_glisser_dans_la_zone")
    hot = page.evaluate(f"() => (document.querySelector('[data-kept-strip=\"{TID}\"]') || {{}}).innerText || ''")
    page.mouse.up(); page.wait_for_timeout(600)
    k2 = kept(page); g = geo(page); heights.append(g["zone"]["h"])
    c3b = [c for c in k2["clips"] if c["id"] == c3["id"]][0]
    check("prise 3 glissée dans la zone : 3 lignes, le clip n'a pas bougé",
          g["count"] == 3 and abs(c3b["start"] - c3["start"]) < 1e-3 and not c3b["muted"], {"count": g["count"], "avant": c3, "apres": c3b, "bandeau_pendant": hot})
    R["bandeau_pendant_glisser"] = hot

    # --- Prise 4 : pastille « 📌 Garder » du clip, puis Ctrl+Z (annulation)
    rec_take(page, 4)
    k = kept(page); g = geo(page)
    c4 = [c for c in k["clips"] if c["n"] == 4 and not c["muted"]][0]
    top = clip_row_top(g)
    px = x_of(g, c4["end"]) - 102 - 76 + 35
    page.mouse.click(px, top + 12); page.wait_for_timeout(500)
    g4 = geo(page)
    shot(page, "pc_04_pastille_prise4")
    check("pastille « 📌 Garder » du clip : la prise 4 entre (4 lignes)", g4["count"] == 4, g4["count"])
    page.keyboard.press("Control+z"); page.wait_for_timeout(500)
    g = geo(page)
    check("Ctrl+Z : la prise 4 ressort de la zone (3 lignes)", g["count"] == 3, g["count"])
    R["hauteurs_zone"] = heights + [g4["zone"]["h"], g["zone"]["h"]]
    check("la zone grandit d'une ligne (44 px) par prise gardée : 3 lignes",
          [round(h) for h in heights] == [HEAD_H + LANE_H, HEAD_H + 2 * LANE_H, HEAD_H + 3 * LANE_H], R["hauteurs_zone"])

    # --- Palette Ctrl+K
    page.keyboard.press("Control+k"); page.wait_for_timeout(500)
    page.keyboard.type("garder prise"); page.wait_for_timeout(400)
    found = page.get_by_text(re.compile("Garder la dernière prise de côté")).locator("visible=true").count()
    shot(page, "pc_05_palette")
    check("palette Ctrl+K : « 📌 Garder la dernière prise de côté »", found >= 1, found)
    page.keyboard.press("Escape"); page.wait_for_timeout(300)

    # --- Renommer, noter, couleur
    def header(n):
        return page.locator(f'[data-kept-zone="{TID}"] [data-kept-header="{n}"]')
    header(2).locator('[data-testid="kept-name"]').click(); page.wait_for_timeout(200)
    inp = header(2).locator("input")
    inp.fill("La bonne"); inp.press("Enter"); page.wait_for_timeout(300)
    header(2).locator('[data-testid="kept-star"][data-star="3"]').click(); page.wait_for_timeout(300)
    header(1).locator('[data-testid="kept-star"][data-star="1"]').click(); page.wait_for_timeout(300)
    header(1).locator("button[aria-label^='Couleur']").click(); page.wait_for_timeout(300)
    k = kept(page)
    R["lignes"] = k["kept"]
    l2 = [l for l in k["kept"] if l["n"] == 2][0]; l1 = [l for l in k["kept"] if l["n"] == 1][0]
    check("renommer « La bonne », noter ★★★ (prise 2), ★ (prise 1), couleur changée",
          l2["name"] == "La bonne" and l2["stars"] == 3 and l1["stars"] == 1 and l1["color"] != "#f59e0b", k["kept"])

    # --- Écouter une ligne en solo (lecture directe)
    header(1).locator('[data-testid="kept-play"]').click(); page.wait_for_timeout(1200)
    aud = page.evaluate("async () => (await window.__novaAppModule('/engine/AudioEngine.ts')).audioEngine.getTakeAudition()")
    playing = st(page, "s => s.isPlaying")
    shot(page, "pc_06_ecoute_prise1")
    check("▶ sur la ligne de la prise 1 : lecture directe, prise 1 seule (solo du moteur)", playing and aud and aud.get("n") == 1, {"audition": aud, "lecture": playing})
    header(1).locator('[data-testid="kept-play"]').click(); page.wait_for_timeout(300)
    page.evaluate("() => window.DAW_CONTROL.stop()"); page.wait_for_timeout(500)
    aud2 = page.evaluate("async () => (await window.__novaAppModule('/engine/AudioEngine.ts')).audioEngine.getTakeAudition()")
    check("re-appui : retour à la voix finale", not aud2, aud2)

    # --- Mettre la 2e sur la piste (+ annulation / rétablir)
    before = kept(page)["audible"]
    header(2).locator('[data-testid="kept-put"]').click(); page.wait_for_timeout(500)
    after = kept(page)["audible"]
    shot(page, "pc_07_prise2_sur_la_piste")
    check("« Mettre sur la piste » : la prise 2 remplace la prise courante", before == [4] and after == [2], {"avant": before, "apres": after})
    page.keyboard.press("Control+z"); page.wait_for_timeout(400)
    undo = kept(page)["audible"]
    page.keyboard.press("Control+y"); page.wait_for_timeout(400)
    redo = kept(page)["audible"]
    check("Ctrl+Z / Ctrl+Y : prise 4 revient, puis prise 2", undo == [4] and redo == [2], {"annuler": undo, "retablir": redo})

    # --- Comp : balayer 2 s → 4 s sur la ligne de la prise 3
    g = geo(page)
    row3 = [r for r in g["rows"] if r["n"] == 3][0]
    y = row3["y"] + row3["h"] / 2
    page.mouse.move(x_of(g, 2.0), y); page.mouse.down()
    page.mouse.move(x_of(g, 3.0), y, steps=4); page.mouse.move(x_of(g, 4.0), y, steps=4)
    page.mouse.up(); page.wait_for_timeout(500)
    comp = kept(page)["comp"]
    R["comp"] = comp
    shot(page, "pc_08_comp_depuis_la_ligne")
    want = [[2, 0.0, 2.0], [3, 2.0, 4.0], [2, 4.0, None]]
    ok_comp = len(comp) == 3 and all(c["n"] == w[0] and (abs(c["start"] - w[1]) < 0.05 or w[1] == 0.0) and (w[2] is None or abs(c["end"] - w[2]) < 0.05) for c, w in zip(comp, want))
    check("comp depuis une ligne : prise 2 / passage de la prise 3 (2 → 4 s) / prise 2", ok_comp, comp)

    # --- Export : les prises gardées ne jouent pas
    zones = [[0.4, 1.8], [2.2, 3.8], [4.2, 6.5]]
    ex = page.evaluate(EXPORT_JS, [TID, TAKE_S + 0.5, zones])
    R["export"] = ex
    best = [max(z["r"], key=lambda k_: (z["r"][k_] if z["r"][k_] is not None else -9)) for z in ex["zones"]]
    check("export : son identique avec et sans les clips muets (prises gardées absentes du mix)", ex["ecart_max"] == 0 and ex["muets"] > 0 and ex["rms"] > 1e-3,
          {"ecart_max": ex["ecart_max"], "muets": ex["muets"], "rms": ex["rms"]})
    check("export : prise 2, puis prise 3 sur le passage compé, puis prise 2 (corrélation > 0,99)",
          best == ["2", "3", "2"] and all(z["r"][bb] > 0.99 for z, bb in zip(ex["zones"], best)), ex["zones"])

    # --- Rien de recouvert
    cov = page.evaluate(COVER_JS, f'[data-kept-zone="{TID}"] button, [data-kept-strip="{TID}"] button')
    R["recouvrement"] = cov
    check("bureau : aucun bouton de la zone recouvert", cov and all(c["ok"] for c in cov), [c for c in cov if not c["ok"]])

    # --- Replier / déplier
    page.locator(f'[data-kept-zone="{TID}"] [data-testid="kept-toggle"]').click(); page.wait_for_timeout(300)
    gz = geo(page)
    shot(page, "pc_09_zone_repliee")
    page.locator(f'[data-kept-zone="{TID}"] [data-testid="kept-toggle"]').click(); page.wait_for_timeout(300)
    gd = geo(page)
    check("replier : en-tête seul (30 px) ; déplier : 3 lignes", abs(gz["zone"]["h"] - HEAD_H) < 1 and abs(gd["zone"]["h"] - (HEAD_H + 3 * LANE_H)) < 1, [gz["zone"], gd["zone"]])

    # --- Balayage de tout l'écran : rien de cliquable recouvert (pastille « Prises (N) », « +N » des effets…)
    balayer(page, "bureau", R)

    # --- Thème clair
    page.evaluate("() => window.DAW_CONTROL.setTheme('light')"); page.wait_for_timeout(600)
    shot(page, "pc_10_theme_clair")
    page.evaluate("() => window.DAW_CONTROL.setTheme('dark')"); page.wait_for_timeout(400)
    shot(page, "pc_11_theme_sombre")

    # --- Sauvegarde (.zip)
    dest = OUT / "seance_prises_gardees.zip"
    page.keyboard.press("Control+Shift+s"); page.wait_for_timeout(900)
    loc = page.get_by_role("button", name=re.compile("(Export local|cet appareil)", re.I)).first
    with page.expect_download(timeout=90000) as dl:
        loc.click()
    dl.value.save_as(str(dest))
    page.wait_for_timeout(800)
    with zipfile.ZipFile(dest) as z:
        pj = json.loads(z.read("project.json"))
    tm = [t for t in pj["tracks"] if t["id"] == TID][0].get("takeMeta") or []
    R["sauvegarde_takeMeta"] = tm
    saved = sorted([m["n"] for m in tm if m.get("kept")])
    check("sauvegarde : project.json porte les 3 prises gardées (nom, note, couleur)",
          saved == [1, 2, 3] and any(m.get("name") == "La bonne" and m["kept"].get("stars") == 3 for m in tm), tm)
    R["etat_final"] = kept(page)
    errs = log.errors()
    R["erreurs_console"] = errs[:10]
    check("bureau : aucune erreur dans la console", not errs, errs[:5])
    save_log(log)
    ctx.close()
    return dest


def reload_desktop(b, f: Path):
    log = Log("prises_gardees_rechargement")
    ctx, page = new_page(b, "pc", log=log, touch=False)
    open_project(page, f, "pc_12_rechargement")
    page.wait_for_timeout(1500)
    k = kept(page)
    res["rechargement"] = k
    before = res["bureau"]["etat_final"]
    check("rechargement : mêmes prises gardées (n°, nom, note, couleur) et même comp",
          [(l["n"], l["name"], l["stars"], l["color"]) for l in k["kept"]] == [(l["n"], l["name"], l["stars"], l["color"]) for l in before["kept"]]
          and k["comp"] == before["comp"], {"avant": before["kept"], "apres": k["kept"]})
    g = geo(page)
    check("rechargement : la zone s'affiche avec ses 3 lignes", g["count"] == 3 and len(g["rows"]) == 3, g["count"])
    shot(page, "pc_13_rechargement_zone")
    save_log(log)
    ctx.close()


def phone(b, f: Path):
    R = res["telephone"]
    for theme in ("dark", "light"):
        log = Log(f"prises_gardees_tel_{theme}")
        ctx, page = new_page(b, "tel390", log=log, touch=True)
        page.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); }} catch (e) {{}}")
        open_project(page, f, f"tel_{theme}_00_ouvert", touch=True)
        page.wait_for_timeout(1500)
        card = page.locator(f'[data-kept-card="{TID}"]')
        n = card.get_attribute("data-kept-count") if card.count() else None
        check(f"téléphone ({theme}) : carte « 📌 Prises gardées » avec 3 lignes", n == "3" and card.locator("[data-kept-header]").count() == 3, n)
        shot(page, f"tel_{theme}_01_carte")
        sizes = page.evaluate("""(tid) => [...document.querySelectorAll(`[data-kept-card="${tid}"] button`)].filter(b => b.offsetParent).map(b => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), (b.getAttribute('aria-label') || b.innerText).trim().slice(0, 30)]; })""", TID)
        small = [s for s in sizes if s[1] < 32 and "étoile" not in s[2]]
        check(f"téléphone ({theme}) : boutons au doigt (≥ 32 px visibles, zone tactile 40 px)", not small and all(s[1] >= 32 for s in sizes), small or sizes[:6])
        cov = page.evaluate(COVER_JS, f'[data-kept-card="{TID}"] button')
        check(f"téléphone ({theme}) : rien ne recouvre la carte", cov and all(c["ok"] for c in cov), [c for c in cov if not c["ok"]])
        balayer(page, f"téléphone {theme}", R)
        if theme == "dark":
            rows = card.locator("[data-kept-header]")
            rows.nth(0).locator('[data-testid="kept-play"]').tap(); page.wait_for_timeout(1200)
            aud = page.evaluate("async () => (await window.__novaAppModule('/engine/AudioEngine.ts')).audioEngine.getTakeAudition()")
            check("téléphone : ▶ écoute la 1re prise gardée en solo", aud and aud.get("n") == 1, aud)
            shot(page, "tel_dark_02_ecoute")
            rows.nth(0).locator('[data-testid="kept-play"]').tap(); page.wait_for_timeout(300)
            page.evaluate("() => window.DAW_CONTROL.stop()")
            rows.nth(2).locator('[data-testid="kept-star"][data-star="2"]').tap(); page.wait_for_timeout(300)
            rows.nth(2).locator('[data-testid="kept-put"]').tap(); page.wait_for_timeout(600)
            k = kept(page)
            l3 = [l for l in k["kept"] if l["n"] == 3][0]
            check("téléphone : ★★ sur la prise 3 puis « ⤓ Piste » : c'est elle qu'on entend", l3["stars"] == 2 and k["audible"] == [3], {"stars": l3["stars"], "audible": k["audible"]})
            shot(page, "tel_dark_03_note_et_piste")
            R["apres_gestes"] = k
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
(OUT / "prises_gardees.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
print("\nBILAN :", json.dumps(res["bilan"], ensure_ascii=False))
sys.exit(0 if all(c["ok"] for c in checks) else 1)
