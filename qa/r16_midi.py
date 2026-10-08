"""Scénario R16 (MIDI pro) dans un Chrome headless, avec un FAUX clavier MIDI.

Le clavier matériel est simulé : navigator.requestMIDIAccess renvoie un faux
MIDIInput dont on contrôle les horodatages (event.timeStamp, horloge
performance.now()) ET l'instant d'arrivée (gigue de 2 à 30 ms).

PC :
  1. piste MIDI armée (bouton ●), REC avec décompte, 16 notes avec une gigue
     d'arrivée connue → positions mesurées à ±1 ms ;
  2. sustain (CC64) + pitch bend enregistrés, puis rendus à l'export :
     note tenue par la pédale (énergie mesurée) et hauteur mesurée (440 → 493,9 Hz) ;
  3. boucle de 4 tours (« une prise par tour ») : 4 prises, la dernière joue ;
  4. MIDI Learn : un fader (CC7) relié au volume du BEAT le fait bouger ;
  5. piano roll : couloir pitch bend, notes muettes (Ctrl+M), saisie pas à pas ;
  6. clavier de l'ordinateur sur la piste sélectionnée sans piano roll (Ctrl+Maj+K).
Tablette et téléphone : fenêtre MIDI (menu ☰ au téléphone), prise depuis le
clavier MIDI. Thème clair et sombre. Aucune erreur de page.

Usage : python qa/r16_midi.py [pc|tab|tel|tout]   (NOVA_URL=http://127.0.0.1:3462/)
"""
import json, os, sys, time
from pathlib import Path
sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3462/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-r16")
from qalib import launch, new_page, shot, overflow_report, BASE, OUT  # noqa: E402
from scenarios import close_welcome, wait_text_gone  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

WHICH = sys.argv[1] if len(sys.argv) > 1 else "tout"
RES = {"etapes": {}, "mesures": {}}


def ok(k, v, note=None):
    RES["etapes"][k] = {"ok": bool(v), **({"detail": note} if note is not None else {})}
    print(("OK  " if v else "KO  ") + k, "" if note is None else json.dumps(note, ensure_ascii=False)[:600], flush=True)


# Faux clavier MIDI : un seul MIDIInput, horodatages et arrivées contrôlés par le test.
FAKE_MIDI = r"""
(() => {
  const input = { id: 'qa-keys', name: 'QA Keys 49', manufacturer: 'NOVA QA', state: 'connected', connection: 'open', type: 'input', onmidimessage: null,
    addEventListener() {}, removeEventListener() {} };
  const access = { inputs: new Map([['qa-keys', input]]), outputs: new Map(), sysexEnabled: false, onstatechange: null };
  Object.defineProperty(navigator, 'requestMIDIAccess', { value: async () => access, configurable: true });
  window.__qaMidi = {
    input,
    send(bytes, ts) { if (input.onmidimessage) input.onmidimessage({ data: new Uint8Array(bytes), timeStamp: ts }); },
  };
})();
"""

# Programme des messages : chaque message a son horodatage (= instant voulu) et
# arrive `late` ms plus tard (gigue). Les positions sont en temps du MORCEAU.
SCHEDULE_JS = r"""
async ({ events }) => {
  const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const ac = audioEngine.ctx;
  const origin = audioEngine.getPlaybackOrigin();
  // Vérité du test : écart entre l'horloge du son entendu et performance.now(),
  // relevé par le TEST lui-même toutes les 10 ms (médiane de la dernière seconde ;
  // un relevé seul tremble de ±1,4 ms).
  if (!window.__qaClock) throw new Error('horloge du test non démarrée');
  const offNow = () => { const now = performance.now(); const v = window.__qaClock.filter(x => x[0] > now - 1000).map(x => x[1]).sort((a, b) => a - b); return v[v.length >> 1]; };
  // Temps du morceau → horloge performance.now() du son entendu.
  const perfOf = (songPos) => (origin + songPos - offNow()) * 1000;
  const sent = [];
  // L'horodatage est calculé ~80 ms avant l'instant voulu (horloges du son et de
  // performance.now() qui dérivent un peu l'une par rapport à l'autre sur 30 s),
  // puis le message arrive `late` ms APRÈS cet instant (gigue).
  await Promise.all(events.map(ev => new Promise(res => {
    const early = Math.max(0, perfOf(ev.pos) - performance.now() - 80);
    setTimeout(() => {
      const ts = perfOf(ev.pos);
      const wait = Math.max(0, ts - performance.now() + (ev.late || 0));
      setTimeout(() => { window.__qaMidi.send(ev.bytes, ts); sent.push({ pos: ev.pos, ts, arrival: performance.now(), late: performance.now() - ts }); res(); }, wait);
    }, early);
  })));
  return { origin, sent: sent.length, lateMs: sent.map(s => Math.round(s.late * 10) / 10), stamp: (() => { try { const s = ac.getOutputTimestamp(); return { c: s.contextTime, p: s.performanceTime }; } catch (e) { return null; } })() };
}
"""

STATE = "() => window.__novaMidi.state()"

# Relevés d'horloge du TEST (démarrés avant REC) : écart son / performance.now() toutes les 10 ms.
CLOCK_INIT = r"""
async () => {
  const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts');
  await audioEngine.init?.(); await audioEngine.resume?.();
  const ac = audioEngine.ctx;
  if (!window.__qaClock) {
    window.__qaClock = [];
    setInterval(() => { try { const s = ac.getOutputTimestamp(); if (s.performanceTime > 0) window.__qaClock.push([performance.now(), s.contextTime - s.performanceTime / 1000]); } catch (e) {} if (window.__qaClock.length > 400) window.__qaClock.splice(0, 100); }, 10);
    await new Promise(r => setTimeout(r, 1200));
  }
  return window.__qaClock.length;
}
"""


def tracks(pg):
    return pg.evaluate("() => window.__novaMidi.tracks()")


def midi_track(pg, tid):
    return next((t for t in tracks(pg) if t["id"] == tid), None)


def wait_state(pg, key, val, timeout=20):
    t = time.time()
    while time.time() - t < timeout:
        st = pg.evaluate(STATE)
        if st.get(key) == val:
            return st
        pg.wait_for_timeout(100)
    return pg.evaluate(STATE)


def open_studio(pg):
    pg.goto(BASE, wait_until="domcontentloaded")
    pg.get_by_text("Mélodies", exact=False).first.click(timeout=40000)
    pg.wait_for_timeout(1500)
    pg.get_by_text("Neon Storm", exact=False).first.click()
    pg.wait_for_timeout(1500)
    close_welcome(pg)
    wait_text_gone(pg, "Chargement", 60)
    pg.wait_for_timeout(1500)
    close_welcome(pg)
    drums = pg.locator("[aria-labelledby='drums-title']")
    if drums.count():
        cl = drums.locator("button[aria-label^='Fermer'], button[title^='Fermer']")
        if cl.count(): cl.first.click()
        else: pg.keyboard.press("Escape")
        pg.wait_for_timeout(600)
    pg.wait_for_function("() => !!window.__novaMidi && !!window.__novaMidi.state", timeout=20000)


def new_midi_track(pg):
    before = {t["id"] for t in tracks(pg)}
    pg.locator("button[title^='Nouvelle piste MIDI']").first.click()
    pg.wait_for_timeout(1200)
    tid = next(t["id"] for t in tracks(pg) if t["id"] not in before)
    return tid


def close_roll(pg):
    if pg.locator("[data-nova-pianoroll]").count():
        pg.keyboard.press("Escape")
        pg.wait_for_timeout(500)


def record(pg, events, stop_after, tid):
    """REC (touche R) avec décompte, programme les messages, s'arrête `stop_after` s après le début de la prise."""
    pg.evaluate(CLOCK_INIT)
    pg.keyboard.press("r")
    st = wait_state(pg, "isRecording", True, 30)
    if not st.get("isRecording"):
        return None, st
    rec_start = st["recStartTime"]
    evs = [{**e, "pos": rec_start + e["pos"]} for e in events]
    info = pg.evaluate(SCHEDULE_JS, {"events": evs})
    # Attente : jusqu'à `stop_after` s de morceau après le début de la prise.
    pg.wait_for_function("(t) => window.__novaAppModule && true", arg=0)
    t0 = time.time()
    while time.time() - t0 < stop_after + 15:
        cur = pg.evaluate("async () => (await window.__novaAppModule('/engine/AudioEngine.ts')).audioEngine.getCurrentTime()")
        lin = pg.evaluate("async () => { const { audioEngine: e } = await window.__novaAppModule('/engine/AudioEngine.ts'); return e.ctx.currentTime - e.getPlaybackOrigin(); }")
        if lin >= rec_start + stop_after:
            break
        pg.wait_for_timeout(50)
    pg.keyboard.press("r")
    wait_state(pg, "isRecording", False, 20)
    pg.wait_for_timeout(500)
    return rec_start, info


def run_pc(b, theme="dark"):
    ctx, pg = new_page(b, "pc")
    ctx.add_init_script(FAKE_MIDI)
    if theme == "light":
        ctx.add_init_script("try { localStorage.setItem('nova_theme', 'light'); } catch (e) {}")
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:300]))
    open_studio(pg)
    shot(pg, "r16_pc_00_projet")
    tid = new_midi_track(pg)
    close_roll(pg)
    ok("piste MIDI créée", bool(tid), tid)

    # Armement : bouton ● de la piste (pas de micro), fenêtre MIDI : mode Fusionner.
    pg.locator(f"[data-nova-arm-midi='{tid}']").first.click()
    pg.wait_for_timeout(800)
    st = pg.evaluate(STATE)
    ok("piste armée sans micro", tid in st["armed"], st["armed"])
    pg.locator("[data-nova-midi-button]").first.click()
    pg.wait_for_timeout(600)
    pg.locator("[data-nova-midi-mode='merge']").first.click()
    pg.wait_for_timeout(300)
    shot(pg, "r16_pc_01_fenetre_midi")
    pg.keyboard.press("Escape")
    pg.mouse.click(5, 300)
    pg.wait_for_timeout(300)

    # 1. 16 notes, gigue connue.
    jitter_ms = [3.0, -7.0, 1.1, 0.0, 12.0, -4.5, 6.2, -9.9, 2.4, -1.3, 8.8, -6.0, 4.4, -2.2, 0.7, 10.0]
    late_ms = [2, 30, 7, 18, 25, 4, 12, 29, 9, 21, 3, 15, 27, 6, 11, 24]
    events = []
    targets = []
    for k in range(16):
        pos = 0.5 + k * 0.25 + jitter_ms[k] / 1000
        targets.append(pos)
        pitch = 60 + (k % 8)
        events.append({"pos": pos, "late": late_ms[k], "bytes": [0x90, pitch, 90 + k]})
        events.append({"pos": pos + 0.12, "late": late_ms[(k + 5) % 16], "bytes": [0x80, pitch, 0]})
    rec_start, info = record(pg, events, 0.5 + 16 * 0.25 + 0.5, tid)
    ok("prise lancée (avec décompte)", rec_start is not None, {"debut_prise_s": rec_start, "arrivees_tardives_ms": (info or {}).get("lateMs") if isinstance(info, dict) else None})
    t = midi_track(pg, tid)
    notes = sorted([(c["start"] + n["s"], n["p"], n["d"], n["v"]) for c in t["clips"] for n in c["notes"]])
    errors = [round((notes[k][0] - (rec_start + targets[k])) * 1000, 3) for k in range(min(16, len(notes)))]
    RES["mesures"]["16_notes_ecart_ms"] = errors
    ok("16 notes enregistrées", len(notes) == 16, len(notes))
    ok("positions à ±1 ms malgré une gigue d’arrivée de 5 à 45 ms", len(errors) == 16 and max(abs(e) for e in errors) <= 1.0, {"max_ecart_ms": max([abs(e) for e in errors] or [99]), "ecarts_ms": errors})
    durs = [round(n[2], 3) for n in notes]
    ok("durées gardées (0,12 s)", all(abs(d - 0.12) < 0.0015 for d in durs), durs[:6])
    pg.wait_for_timeout(600)
    shot(pg, "r16_pc_02_prise_16_notes")

    # 2. Sustain + pitch bend, puis rendu d'export.
    base = 7.0
    ev2 = [
        {"pos": base - 0.05, "late": 5, "bytes": [0xB0, 64, 127]},           # pédale enfoncée
        {"pos": base, "late": 9, "bytes": [0x90, 69, 110]},                   # La 440
        {"pos": base + 0.25, "late": 14, "bytes": [0x80, 69, 0]},             # touche relâchée (pédale tenue)
    ]
    for i in range(11):                                                       # bend 0 → +2 demi-tons
        v = round(8192 + i * 819.1)
        v = min(16383, v)
        ev2.append({"pos": base + 0.6 + i * 0.01, "late": 3 + i, "bytes": [0xE0, v & 0x7F, v >> 7]})
    ev2.append({"pos": base + 1.2, "late": 6, "bytes": [0xE0, 0, 64]})        # retour au centre
    ev2.append({"pos": base + 1.5, "late": 8, "bytes": [0xB0, 64, 0]})        # pédale relâchée
    rec2, _ = record(pg, ev2, base + 1.8, tid)
    t = midi_track(pg, tid)
    ccs = [c["cc"] for c in t["clips"] if c.get("cc")]
    ok("sustain et pitch bend enregistrés", bool(ccs) and any("cc64" in c and "pb" in c for c in ccs), {k: len(v) for c in ccs for k, v in c.items()})
    measure = pg.evaluate(r"""async ({ tid, at }) => {
      const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts');
      const all = window.__novaMidi.rawTracks();
      const tr = all.find(t => t.id === tid);
      const SR = 48000;
      const P = await window.__novaAppModule('/utils/novaSynthPresets.ts');
      let synthOver = {};
      const one = (clips) => [{ ...tr, ...synthOver, outputTrackId: undefined, volume: 1, pan: 0, isMuted: false, isSolo: false, sends: [], plugins: [], clips }];
      const render = async (clips) => audioEngine.renderProject(one(clips), 2.2, at - 0.2, SR);
      const strip = (c) => ({ ...c, cc: undefined });
      const withCc = await render(tr.clips);
      const noCc = await render(tr.clips.map(strip));
      const rms = (buf, a, b) => { const x = buf.getChannelData(0); let s = 0, n = 0; for (let i = Math.floor((a + 0.2) * SR); i < Math.floor((b + 0.2) * SR); i++) { s += x[i] * x[i]; n++; } return Math.sqrt(s / Math.max(1, n)); };
      const db = v => Math.round(20 * Math.log10(Math.max(1e-9, v)) * 10) / 10;
      // Hauteur : autocorrélation normalisée (fondamentale entre 300 et 700 Hz).
      const pitch = (buf, a, b) => {
        const x = buf.getChannelData(0).slice(Math.floor((a + 0.2) * SR), Math.floor((b + 0.2) * SR));
        let best = 0, bestLag = 0;
        for (let lag = Math.floor(SR / 700); lag <= Math.ceil(SR / 300); lag++) {
          let s = 0, e1 = 0, e2 = 0;
          for (let i = 0; i + lag < x.length; i++) { s += x[i] * x[i + lag]; e1 += x[i] * x[i]; e2 += x[i + lag] * x[i + lag]; }
          const r = s / Math.sqrt(e1 * e2 + 1e-12);
          if (r > best) { best = r; bestLag = lag; }
        }
        // Affinage parabolique.
        const R = (lag) => { let s = 0, e1 = 0, e2 = 0; for (let i = 0; i + lag < x.length; i++) { s += x[i] * x[i + lag]; e1 += x[i] * x[i]; e2 += x[i + lag] * x[i + lag]; } return s / Math.sqrt(e1 * e2 + 1e-12); };
        const y0 = R(bestLag - 1), y1 = R(bestLag), y2 = R(bestLag + 1);
        const d = (y0 - y2) / (2 * (y0 - 2 * y1 + y2) || 1);
        return Math.round(SR / (bestLag + d) * 10) / 10;
      };
      const out = {
        tenue_avec_pedale_dB: db(rms(withCc, 0.5, 1.0)), tenue_sans_pedale_dB: db(rms(noCc, 0.5, 1.0)),
        hauteur_avant_bend_Hz: pitch(withCc, 0.3, 0.55), hauteur_bend_Hz: pitch(withCc, 0.75, 1.15), hauteur_apres_retour_Hz: pitch(withCc, 1.25, 1.45),
      };
      // Même prise sur le synthé NOVA (V24), son « Son vierge ».
      synthOver = { novaSynth: P.presetSettings('init') };
      const n1 = await render(tr.clips), n0 = await render(tr.clips.map(strip));
      out.nova = { tenue_avec_pedale_dB: db(rms(n1, 0.5, 1.0)), tenue_sans_pedale_dB: db(rms(n0, 0.5, 1.0)),
        hauteur_avant_bend_Hz: pitch(n1, 0.3, 0.55), hauteur_bend_Hz: pitch(n1, 0.75, 1.15), hauteur_apres_retour_Hz: pitch(n1, 1.25, 1.45) };
      return out;
    }""", {"tid": tid, "at": rec2 + base})
    RES["mesures"]["export_sustain_pitch_bend"] = measure
    ok("sustain entendu à l'export (note tenue par la pédale)", measure["tenue_avec_pedale_dB"] > measure["tenue_sans_pedale_dB"] + 30 and measure["tenue_avec_pedale_dB"] > -45, measure)
    nv = measure.get("nova") or {}
    ok("synthé NOVA (V24) : sustain et pitch bend à l'export", nv.get("tenue_avec_pedale_dB", -200) > nv.get("tenue_sans_pedale_dB", 0) + 30 and abs(nv.get("hauteur_avant_bend_Hz", 0) - 440) < 3 and abs(nv.get("hauteur_bend_Hz", 0) - 493.88) < 4 and abs(nv.get("hauteur_apres_retour_Hz", 0) - 440) < 3, nv)
    ok("pitch bend entendu à l'export (440 → 493,9 Hz → 440)", abs(measure["hauteur_avant_bend_Hz"] - 440) < 3 and abs(measure["hauteur_bend_Hz"] - 493.88) < 4 and abs(measure["hauteur_apres_retour_Hz"] - 440) < 3, measure)

    # 3. Boucle de 4 tours : une prise par tour.
    pg.locator("[data-nova-midi-button]").first.click()
    pg.wait_for_timeout(500)
    pg.locator("[data-nova-midi-mode='loop']").first.click()
    pg.wait_for_timeout(200)
    pg.locator("[data-nova-loop-style='takes']").first.click()
    pg.wait_for_timeout(200)
    shot(pg, "r16_pc_03_mode_boucle")
    pg.keyboard.press("Escape")
    pg.mouse.click(5, 300)
    # Tête de lecture sur une mesure libre (mesure 9).
    bpm = pg.evaluate("() => window.__novaMidi.bpm()")
    bar = 240 / bpm
    pg.evaluate("async (t) => { const { audioEngine: e } = await window.__novaAppModule('/engine/AudioEngine.ts'); const ps = await window.__novaAppModule('/utils/playheadStore.ts'); ps.playheadStore.set(t); e.seekTo(t, window.__novaMidi.rawTracks(), false); }", 8 * bar)
    pg.wait_for_timeout(300)
    L = 4 * bar
    ev3 = []
    for k in range(4):
        ev3.append({"pos": k * L + 0.5, "late": 10 + k, "bytes": [0x90, 60 + k, 100]})
        ev3.append({"pos": k * L + 0.8, "late": 4 + k, "bytes": [0x80, 60 + k, 0]})
    rec3, _ = record(pg, ev3, 4 * L + 0.3, tid)
    st = pg.evaluate(STATE)
    t = midi_track(pg, tid)
    takes = [c for c in t["clips"] if abs(c["start"] - st["loopStart"]) < 1e-6 and abs(c["duration"] - (st["loopEnd"] - st["loopStart"])) < 1e-6]
    takes.sort(key=lambda c: c["takeNumber"] or 0)
    desc = [{"nom": c["name"], "muet": c["muted"], "notes": [n["p"] for n in c["notes"]], "pos": [round(n["s"], 4) for n in c["notes"]]} for c in takes]
    RES["mesures"]["boucle_4_tours"] = desc
    ok("boucle de 4 tours : 4 prises", len(takes) == 4, desc)
    ok("la dernière prise joue, les 3 autres sont muettes", len(takes) == 4 and [c["muted"] for c in takes] == [True, True, True, False] and takes[-1]["notes"][0]["p"] == 63, desc)
    ok("chaque tour à la même place dans la boucle (±1 ms)", all(abs(c["notes"][0]["s"] - 0.5) < 0.001 for c in takes if c["notes"]), [c["notes"][0]["s"] for c in takes if c["notes"]])
    shot(pg, "r16_pc_04_boucle_4_prises")

    # 4. MIDI Learn : le fader CC7 pilote le volume du BEAT.
    pg.locator("[data-nova-midi-button]").first.click()
    pg.wait_for_timeout(500)
    pg.locator("[data-nova-midi-mode='merge']").first.click()
    beat = pg.evaluate("() => { const ts = window.__novaMidi.rawTracks(); const t = ts.find(x => x.id === 'instrumental') || ts.find(x => x.type === 'AUDIO' && x.clips.length) || ts[0]; return { id: t.id, name: t.name }; }")
    pg.get_by_label("Piste du réglage").select_option(beat["id"])
    pg.get_by_label("Réglage à piloter").select_option("volume")
    pg.locator("[data-nova-midi-learn]").first.click()
    pg.wait_for_timeout(200)
    shot(pg, "r16_pc_05_midi_learn_attente")
    pg.evaluate("() => window.__qaMidi.send([0xB0, 7, 100], performance.now())")
    pg.wait_for_timeout(400)
    vol0 = pg.evaluate(STATE)["volumes"][beat["id"]]
    for v in (90, 70, 50, 30):
        pg.evaluate("(v) => window.__qaMidi.send([0xB0, 7, v], performance.now())", v)
        pg.wait_for_timeout(120)
    pg.wait_for_timeout(400)
    vol1 = pg.evaluate(STATE)["volumes"][beat["id"]]
    eng = pg.evaluate("async (id) => { const { audioEngine: e } = await window.__novaAppModule('/engine/AudioEngine.ts'); const d = e.tracksDSP.get(id); return d && d.gain ? Math.round(d.gain.gain.value * 1e4) / 1e4 : null; }", beat["id"])
    RES["mesures"]["midi_learn"] = {"volume_apres_apprentissage": vol0, "volume_apres_fader_CC30": vol1, "attendu": round((30 / 100) ** 2, 4), "gain_moteur": eng}
    ok("MIDI Learn : le fader bouge le volume du BEAT", abs(vol1 - 0.09) < 1e-6 and abs(vol0 - 1.0) < 1e-6, RES["mesures"]["midi_learn"])
    shot(pg, "r16_pc_06_midi_learn_relie")
    pg.keyboard.press("Escape")
    pg.mouse.click(5, 300)

    # 5. Piano roll : couloir pitch bend, notes muettes, saisie pas à pas.
    clip = next(c for c in midi_track(pg, tid)["clips"] if c.get("cc"))
    pg.evaluate("(a) => window.dispatchEvent(new CustomEvent('nova:open-piano-roll', { detail: a }))", {"trackId": tid, "clipId": clip["id"]})
    pg.wait_for_timeout(300)
    if not pg.locator("[data-nova-pianoroll]").count():
        # Double-clic sur le clip dans l'arrangement.
        el = pg.locator(f"[data-clip-id='{clip['id']}']").first
        if el.count(): el.dblclick()
        pg.wait_for_timeout(800)
    has_roll = pg.locator("[data-nova-pianoroll]").count() > 0
    ok("piano roll ouvert sur la prise", has_roll)
    if has_roll:
        pg.get_by_label("Couloir affiché").select_option("pb")
        pg.wait_for_timeout(400)
        shot(pg, "r16_pc_07_couloir_pitch_bend")
        # Crayon : dessine une montée de modulation (CC1) à la ligne.
        pg.get_by_label("Couloir affiché").select_option("cc1")
        pg.locator("[data-nova-cc-tool='line']").first.click()
        area = pg.locator("[data-nova-cc-area='cc1']").first.bounding_box()
        pg.mouse.move(area["x"] + 40, area["y"] + area["height"] - 4)
        pg.mouse.down(); pg.mouse.move(area["x"] + 240, area["y"] + 6, steps=8); pg.mouse.up()
        pg.wait_for_timeout(400)
        c2 = next(c for c in midi_track(pg, tid)["clips"] if c["id"] == clip["id"])
        mod = (c2.get("cc") or {}).get("cc1") or []
        ok("couloir CC1 dessiné à la ligne", len(mod) >= 3 and mod[0]["v"] < 10 and mod[-1]["v"] > 115, [p["v"] for p in mod][:12])
        shot(pg, "r16_pc_08_couloir_modulation")
        # Notes muettes : sélection de toutes les notes (Ctrl+A), Ctrl+M.
        grid = pg.locator("[data-nova-pianoroll] .custom-scroll").first.bounding_box()
        pg.mouse.click(grid["x"] + 5, grid["y"] + 5)
        pg.keyboard.press("Control+a"); pg.wait_for_timeout(200)
        pg.keyboard.press("Control+m"); pg.wait_for_timeout(400)
        muted = pg.evaluate("() => document.querySelectorAll('[data-nova-pianoroll] [data-muette=\"1\"]').length")
        c3 = next(c for c in midi_track(pg, tid)["clips"] if c["id"] == clip["id"])
        ok("notes muettes (Ctrl+M) : gardées, grisées", muted > 0 and all(n.get("m") for n in c3["notes"]), {"grisees": muted, "notes": len(c3["notes"])})
        shot(pg, "r16_pc_09_notes_muettes")
        pg.keyboard.press("Control+m"); pg.wait_for_timeout(300)
        # Saisie pas à pas : 4 notes au clavier MIDI, un silence, un accord.
        pg.locator("[data-nova-roll='pas-a-pas']").first.click(); pg.wait_for_timeout(300)
        pg.locator("[data-nova-step-value='1/8']").first.click(); pg.wait_for_timeout(100)
        pg.locator("button:has-text('↺ Début')").first.click(); pg.wait_for_timeout(100)
        n_before = len(next(c for c in midi_track(pg, tid)["clips"] if c["id"] == clip["id"])["notes"])
        for p in (48, 50, 52):
            pg.evaluate("(p) => { window.__qaMidi.send([0x90, p, 100], performance.now()); }", p); pg.wait_for_timeout(60)
            pg.evaluate("(p) => { window.__qaMidi.send([0x80, p, 0], performance.now()); }", p); pg.wait_for_timeout(60)
        pg.locator("[data-nova-step='rest']").first.click(); pg.wait_for_timeout(80)
        for p in (48, 52, 55):
            pg.evaluate("(p) => window.__qaMidi.send([0x90, p, 100], performance.now())", p); pg.wait_for_timeout(30)
        for p in (48, 52, 55):
            pg.evaluate("(p) => window.__qaMidi.send([0x80, p, 0], performance.now())", p); pg.wait_for_timeout(30)
        pg.wait_for_timeout(400)
        c4 = next(c for c in midi_track(pg, tid)["clips"] if c["id"] == clip["id"])
        new = sorted([(round(n["s"], 4), n["p"]) for n in c4["notes"]][n_before:]) if False else None
        step_notes = sorted([(round(n["s"], 4), n["p"]) for n in c4["notes"] if n["s"] < 3 and n["p"] in (48, 50, 52, 55)])
        eighth = 30 / bpm
        expect = sorted([(round(0 * eighth, 4), 48), (round(1 * eighth, 4), 50), (round(2 * eighth, 4), 52), (round(4 * eighth, 4), 48), (round(4 * eighth, 4), 52), (round(4 * eighth, 4), 55)])
        ok("saisie pas à pas : croches, silence, accord", step_notes == expect, {"obtenu": step_notes, "attendu": expect})
        shot(pg, "r16_pc_10_pas_a_pas")
        pg.locator("[data-nova-roll='pas-a-pas']").first.click()
        pg.keyboard.press("Escape"); pg.wait_for_timeout(400)

    # 6. Clavier de l'ordinateur sur la piste sélectionnée, sans piano roll.
    pg.evaluate("""async () => { const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts');
      window.__qaAttacks = []; const o = audioEngine.triggerTrackAttack.bind(audioEngine);
      audioEngine.triggerTrackAttack = (id, p, v, t) => { window.__qaAttacks.push({ id, p, t: t || 0, at: performance.now() }); return o(id, p, v, t); }; }""")
    thru = pg.evaluate("""async () => { const { audioEngine: e } = await window.__novaAppModule('/engine/AudioEngine.ts');
      const t0 = performance.now(); window.__qaMidi.send([0x90, 67, 100], t0); const a = window.__qaAttacks[window.__qaAttacks.length - 1];
      window.__qaMidi.send([0x80, 67, 0], performance.now());
      return { appel_apres_ms: a ? Math.round((a.at - t0) * 1000) / 1000 : null, programme_a: a ? (a.t === 0 ? 'tout de suite' : a.t) : null, piste: a && a.id,
        latence_sortie_ms: Math.round(((e.ctx.baseLatency || 0) + (e.ctx.outputLatency || 0)) * 1000) }; }""")
    RES["mesures"]["thru"] = thru
    ok("Thru : la piste armée joue la note du clavier MIDI tout de suite", thru["piste"] == tid and thru["programme_a"] == "tout de suite" and thru["appel_apres_ms"] is not None and thru["appel_apres_ms"] < 5, thru)
    pg.mouse.click(5, 300)
    pg.keyboard.press("Control+Shift+K"); pg.wait_for_timeout(300)
    pg.keyboard.down("KeyA" if False else "a"); pg.wait_for_timeout(120); pg.keyboard.up("a")
    pg.keyboard.press("j"); pg.wait_for_timeout(200)
    att = pg.evaluate("() => window.__qaAttacks")
    ok("clavier de l'ordinateur : joue sur la piste armée sans piano roll", any(a["id"] == tid and a["p"] == 60 for a in att) and any(a["p"] == 71 for a in att), att[:6])
    shot(pg, "r16_pc_11_clavier_ordinateur")
    pg.keyboard.press("Control+Shift+K"); pg.wait_for_timeout(200)
    ok("PC : aucune erreur de page", not errs, errs[:5])
    ctx.close()


def run_small(b, vp):
    ctx, pg = new_page(b, vp)
    ctx.add_init_script(FAKE_MIDI)
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:300]))
    open_studio(pg)
    tid = new_midi_track(pg)
    close_roll(pg)
    pg.wait_for_timeout(500)
    # Tablette et téléphone : menu ☰ → « MIDI : enregistrer depuis ton clavier ».
    pg.get_by_role("button", name="Ouvrir le menu").first.click()
    pg.wait_for_timeout(500)
    shot(pg, f"r16_{vp}_00_menu")
    pg.locator("[data-testid='menu-midi']").first.click()
    pg.wait_for_timeout(700)
    panel = pg.locator("[data-nova-midi-panel]")
    ok(f"{vp} : fenêtre MIDI ouverte", panel.count() > 0)
    pg.get_by_label("Piste qui enregistre").select_option(tid)
    pg.wait_for_timeout(500)
    shot(pg, f"r16_{vp}_01_fenetre_midi")
    ov = overflow_report(pg)
    ok(f"{vp} : rien ne déborde", not [o for o in ov if o["kind"] == "page-hscroll"], ov[:5])
    sizes = pg.evaluate("() => Array.from(document.querySelectorAll('[data-nova-midi-panel] button, [data-nova-midi-panel] select')).filter(e => e.getClientRects().length).map(e => Math.round(e.getBoundingClientRect().height))")
    ok(f"{vp} : cibles au doigt (≥ 36 px)", min(sizes) >= 36, {"min": min(sizes), "n": len(sizes)})
    pg.evaluate(CLOCK_INIT)
    pg.locator("[data-nova-midi-rec]").first.click()
    st = wait_state(pg, "isRecording", True, 30)
    ok(f"{vp} : prise lancée depuis la fenêtre MIDI", st.get("isRecording"))
    rec_start = st["recStartTime"]
    evs = []
    for k in range(4):
        evs.append({"pos": rec_start + 0.4 + k * 0.3, "late": 5 + 3 * k, "bytes": [0x90, 64 + k, 100]})
        evs.append({"pos": rec_start + 0.55 + k * 0.3, "late": 4, "bytes": [0x80, 64 + k, 0]})
    pg.evaluate(SCHEDULE_JS, {"events": evs})
    pg.wait_for_timeout(700)
    shot(pg, f"r16_{vp}_02_prise_en_cours")
    pg.wait_for_timeout(1000)
    if vp == "tel":
        pg.get_by_role("button", name="Arrêter l'enregistrement").first.click()
    else:
        pg.keyboard.press("r")
    wait_state(pg, "isRecording", False, 20)
    pg.wait_for_timeout(800)
    t = midi_track(pg, tid)
    notes = sorted([(c["start"] + n["s"], n["p"]) for c in t["clips"] for n in c["notes"]])
    errs_ms = [round((notes[k][0] - (rec_start + 0.4 + k * 0.3)) * 1000, 2) for k in range(min(4, len(notes)))]
    ok(f"{vp} : 4 notes du clavier MIDI enregistrées à ±1 ms", len(notes) == 4 and max(abs(e) for e in errs_ms) <= 1.0, errs_ms)
    shot(pg, f"r16_{vp}_03_apres_prise")
    ok(f"{vp} : aucune erreur de page", not errs, errs[:5])
    ctx.close()


def run_light(b):
    """Thème clair : fenêtre MIDI, piano roll (couloir pitch bend, pas à pas), prise en cours."""
    ctx, pg = new_page(b, "pc")
    ctx.add_init_script(FAKE_MIDI)
    ctx.add_init_script("try { localStorage.setItem('nova_theme', 'light'); } catch (e) {}")
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:300]))
    open_studio(pg)
    tid = new_midi_track(pg)
    close_roll(pg)
    pg.locator(f"[data-nova-arm-midi='{tid}']").first.click()
    pg.wait_for_timeout(600)
    pg.locator("[data-nova-midi-button]").first.click(); pg.wait_for_timeout(500)
    pg.locator("[data-nova-midi-mode='loop']").first.click(); pg.wait_for_timeout(200)
    pg.locator("[data-nova-midi-mode='merge']").first.click(); pg.wait_for_timeout(200)
    shot(pg, "r16_pc_clair_01_fenetre_midi")
    pg.keyboard.press("Escape"); pg.mouse.click(5, 300)
    evs = []
    for k in range(8):
        evs.append({"pos": 0.3 + k * 0.2, "late": 5 + k, "bytes": [0x90, 60 + (k * 3) % 12, 100]})
        evs.append({"pos": 0.45 + k * 0.2, "late": 7, "bytes": [0x80, 60 + (k * 3) % 12, 0]})
    evs += [{"pos": 0.3 + i * 0.05, "late": 3, "bytes": [0xE0, 0, 64 + i * 6]} for i in range(10)]
    pg.evaluate(CLOCK_INIT)
    pg.keyboard.press("r")
    st = wait_state(pg, "isRecording", True, 30)
    pg.evaluate(SCHEDULE_JS, {"events": [{**e, "pos": st["recStartTime"] + e["pos"]} for e in evs]})
    pg.wait_for_timeout(600)
    shot(pg, "r16_pc_clair_02_prise_en_cours")
    pg.wait_for_timeout(800)
    pg.keyboard.press("r")
    wait_state(pg, "isRecording", False, 20)
    pg.wait_for_timeout(600)
    clip = next(c for c in midi_track(pg, tid)["clips"] if c["notes"])
    pg.evaluate("(a) => window.dispatchEvent(new CustomEvent('nova:open-piano-roll', { detail: a }))", {"trackId": tid, "clipId": clip["id"]})
    pg.wait_for_timeout(800)
    pg.get_by_label("Couloir affiché").select_option("pb")
    pg.locator("[data-nova-roll='pas-a-pas']").first.click(); pg.wait_for_timeout(300)
    shot(pg, "r16_pc_clair_03_piano_roll")
    ok("thème clair : aucune erreur de page", not errs, errs[:5])
    ctx.close()


def main():
    with sync_playwright() as p:
        b = launch(p)
        try:
            if WHICH in ("pc", "tout"):
                run_pc(b)
            if WHICH in ("clair", "tout"):
                run_light(b)
            if WHICH in ("tab", "tout"):
                run_small(b, "tab")
            if WHICH in ("tel", "tout"):
                run_small(b, "tel")
        finally:
            b.close()
    (Path(OUT) / f"r16_resultats_{WHICH}.json").write_text(json.dumps(RES, ensure_ascii=False, indent=1), encoding="utf-8")
    bad = [k for k, v in RES["etapes"].items() if not v["ok"]]
    print(f"\n{len(RES['etapes']) - len(bad)}/{len(RES['etapes'])} étapes OK", "· KO :" if bad else "", bad if bad else "")


if __name__ == "__main__":
    main()
