"""Scénario R17 (raccourcis personnalisables, scrub audible, dispositions) dans un Chrome headless.

Projet : une piste « Voix » qui contient une sinusoïde pure de 440 Hz (8 s). Une
sinusoïde rend les mesures sans appel : sa hauteur dit la vitesse de lecture, et
toute discontinuité (clic) se voit comme un saut d'échantillon à échantillon.

PC :
  1. Éditeur de raccourcis : « Poser un repère » remappé sur J par capture de touche,
     puis utilisé (J pose un repère, K plus rien) ; conflit proposé (Ctrl+E) et résolu ;
  2. préréglage « Pro Tools (Windows) » appliqué : 10+ raccourcis vérifiés en vrai ;
  3. scrub à la souris (outil Scrubber F9), lent (×0,5) puis rapide (×2) : son
     enregistré au master, hauteur mesurée (220 / 880 Hz), aucun clic, position suivie ;
     comparaison avec des grains SANS fenêtre (ce que donnerait un scrub naïf) ;
  4. shuttle au clavier (Alt+L / Alt+K) ;
  5. dispositions : Mix (Ctrl+Maj+3), Enregistrement (Ctrl+Maj+1), Édition (pavé . 2 *),
     disposition 4 enregistrée puis rappelée (zoom compris) ;
  6. export / import .novakeys depuis l'éditeur ; thème clair.
Tablette : éditeur ouvert, scrub au doigt (outil Scrubber). Téléphone : pas d'éditeur,
scrub au doigt sur la règle. Aucune erreur de page.

Usage : python qa/r17_raccourcis_scrub.py [pc|tab|tel|tout]   (NOVA_URL=http://127.0.0.1:3456/)
"""
import json, math, os, re, struct, sys, wave, zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3456/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-r17")
from qalib import launch, new_page, shot, overflow_report, Log, BASE, OUT  # noqa: E402
from gel_pre_effet import prepare, open_project_file  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

WHICH = sys.argv[1] if len(sys.argv) > 1 else "tout"
RES = {"etapes": {}, "mesures": {}}
SR = 48000


def ok(k, v, note=None):
    RES["etapes"][k] = {"ok": bool(v), **({"detail": note} if note is not None else {})}
    print(("OK  " if v else "KO  ") + k, "" if note is None else json.dumps(note, ensure_ascii=False)[:500], flush=True)


def make_project(path: Path):
    wav = OUT / "sinus_440.wav"
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(b"".join(struct.pack("<h", int(16000 * math.sin(2 * math.pi * 440 * i / SR))) for i in range(SR * 8)))
    clip = {"id": "prise", "name": "Sinus 440", "start": 0, "duration": 8, "offset": 0, "fadeIn": 0, "fadeOut": 0,
            "color": "#22d3ee", "type": "AUDIO", "audioRef": "audio/voix.wav", "gain": 1, "takeNumber": 1}
    base = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0,
            "outputTrackId": "master", "sends": [], "plugins": []}
    tracks = [{**base, "id": "voix", "name": "Voix", "type": "AUDIO", "color": "#22d3ee", "volume": 1.0, "clips": [clip]}]
    state = {
        "id": "proj-r17", "name": "R17 scrub", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": "voix", "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.write(wav, "audio/voix.wav")


ST = """() => { const s = window.DAW_CONTROL.getState(); return { t: s.currentTime, view: s.currentView, loop: s.isLoopActive, rec: s.isRecording,
  qp: !!(s.punch && s.punch.quickPunch), markers: s.markers.length,
  clips: s.tracks.find(t => t.id === 'voix').clips.map(c => ({ id: c.id, start: Math.round(c.start*1000)/1000, dur: Math.round(c.duration*1000)/1000, muted: !!c.isMuted })) }; }"""


def st(pg):
    return pg.evaluate(ST)


def blur(pg):
    pg.evaluate("() => document.activeElement && document.activeElement.blur && document.activeElement.blur()")


def press(pg, key, wait=350):
    blur(pg); pg.keyboard.press(key); pg.wait_for_timeout(wait)


def tool_on(pg, testid=None, label=None):
    loc = pg.locator(f'[data-testid="{testid}"]') if testid else pg.get_by_role("button", name=label, exact=True)
    return loc.first.get_attribute("aria-pressed") == "true"


# --- Enregistrement du master (AudioWorklet) + mesures -------------------------------
REC_INIT = r"""
async () => {
  const { audioEngine: E } = await window.__novaAppModule('/engine/AudioEngine.ts');
  await E.init?.(); await E.resume?.();
  const ctx = E.ctx;
  if (!window.__qaRec) {
    const code = `class R extends AudioWorkletProcessor { process(i) { const x = i[0] && i[0][0]; if (x) this.port.postMessage({ f: currentFrame, d: x.slice(0) }); return true; } } registerProcessor('nova-qa-rec-r17', R);`;
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
    const rec = new AudioWorkletNode(ctx, 'nova-qa-rec-r17', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const chunks = []; rec.port.onmessage = e => { if (window.__qaRec.on) chunks.push(e.data); };
    const sink = ctx.createGain(); sink.gain.value = 0; rec.connect(sink); sink.connect(ctx.destination);
    E.masterOutput.connect(rec);
    window.__qaRec = { on: false, chunks, E, ctx,
      start() { this.chunks.length = 0; this.on = true; this.f0 = Math.round(ctx.currentTime * ctx.sampleRate); },
      // Les blocs sont mis bout à bout dans l'ordre d'arrivée. Sur cette machine chargée, le faux
      // périphérique audio du Chrome headless saute ou rejoue parfois un bloc de 128 échantillons
      // (currentFrame non contigu) : ces jonctions sont notées et exclues de la mesure des clics.
      stop() { this.on = false; const n = this.chunks.length; const o = new Float32Array(n * 128); const breaks = new Set();
        this.chunks.forEach((c, k) => { o.set(c.d, k * 128); if (k && c.f !== this.chunks[k - 1].f + 128) breaks.add(k * 128); });
        o.breaks = breaks; this.breaks = breaks.size; return o; },
    };
    // Mesures sur un enregistrement : niveau, sauts d'échantillon (clics), hauteur par passages à zéro.
    window.__qaStats = (x, sr, a = 0, b = 1) => {
      const i0 = Math.floor(x.length * a), i1 = Math.floor(x.length * b);
      let peak = 0, sum = 0, maxDiff = 0, zc = 0, active = 0, lastSign = 0, firstZ = -1, lastZ = -1;
      for (let i = i0; i < i1; i++) {
        const v = x[i]; peak = Math.max(peak, Math.abs(v)); sum += v * v;
        if (i > i0 && !(x.breaks && x.breaks.has(i))) maxDiff = Math.max(maxDiff, Math.abs(v - x[i - 1]));
        if (Math.abs(v) > 0.01) active++;
        const s = v > 0.003 ? 1 : v < -0.003 ? -1 : 0;
        if (s && lastSign && s !== lastSign) { zc++; if (firstZ < 0) firstZ = i; lastZ = i; }
        if (s) lastSign = s;
      }
      const n = Math.max(1, i1 - i0);
      return { breaks: x.breaks ? x.breaks.size : 0, seconds: n / sr, rms: Math.sqrt(sum / n), peak, maxDiff, clickRatio: peak > 0 ? maxDiff / peak : 0,
        freq: lastZ > firstZ ? ((zc - 1) / 2) / ((lastZ - firstZ) / sr) : 0, activeShare: active / n };
    };
  }
  return ctx.state;
}
"""

# Glissement du Scrubber, rythmé DANS la page (requestAnimationFrame) : vitesse de souris exacte.
DRAG_JS = r"""
async ({ x0, y, pxPerSec, ms, zoom, xZero, touch }) => {
  const R = window.__qaRec, E = R.E;
  const target = document.elementFromPoint(x0, y);
  const fire = (type, x) => {
    if (touch) target.dispatchEvent(new PointerEvent(type.replace('mouse', 'pointer'), { clientX: x, clientY: y, bubbles: true, pointerType: 'touch', pointerId: 7, isPrimary: true, buttons: type === 'mouseup' ? 0 : 1 }));
    else target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0, buttons: type === 'mouseup' ? 0 : 1 }));
  };
  R.start();
  fire('mousedown', x0);
  const t0 = performance.now(); const follow = [];
  await new Promise(res => { const step = () => { const el = performance.now() - t0; const x = x0 + pxPerSec * Math.min(el, ms) / 1000; fire('mousemove', x);
    follow.push([el, (x - xZero) / zoom, E.getScrubPosition()]); if (el < ms) requestAnimationFrame(step); else res(); }; requestAnimationFrame(step); });
  const xEnd = x0 + pxPerSec * ms / 1000;
  await new Promise(r => setTimeout(r, 120));
  fire('mouseup', xEnd);
  await new Promise(r => setTimeout(r, 400));
  const x = R.stop();
  const fr = R.chunks.map(c => c.f); let gaps = 0, dups = 0; for (let i = 1; i < fr.length; i++) { const d = fr[i] - fr[i - 1]; if (d > 128) gaps++; if (d < 128) dups++; }
  const s = window.__qaStats;
  const errs = follow.filter(f => f[0] > 300).map(f => Math.abs(f[2] - f[1])).sort((a, b) => a - b);
  let md = 0, at = 0; for (let i = 1; i < x.length; i++) { if (x.breaks.has(i)) continue; const d = Math.abs(x[i] - x[i - 1]); if (d > md) { md = d; at = i; } }
  const dbg = { maxAt_s: at / R.ctx.sampleRate, len_s: x.length / R.ctx.sampleRate, around: Array.from(x.slice(Math.max(0, at - 4), at + 4)).map(v => Math.round(v * 1000) / 1000), playing: E.getIsPlaying(), chunkGaps: gaps, chunkDups: dups, chunks: fr.length, sampleAtBlock: at % 128 };
  return { dbg, all: s(x, R.ctx.sampleRate), mid: s(x, R.ctx.sampleRate, 0.3, 0.8), stats: E.getScrubStats(), endMouse: (xEnd - xZero) / zoom,
    followMedian: errs[errs.length >> 1] || 0, followMax: errs[errs.length - 1] || 0, samples: follow.length };
}
"""

# Grains SANS fenêtre (coupés net) : le scrub naïf qu'on évite. Même sinusoïde, même niveau.
NAIVE_JS = r"""
async () => {
  const R = window.__qaRec, E = R.E, ctx = R.ctx;
  const st = window.DAW_CONTROL.getState(); const clip = st.tracks.find(t => t.id === 'voix').clips[0];
  const buf = E.getAudioBuffer(clip.bufferId);
  R.start();
  const t = ctx.currentTime + 0.05;
  for (let i = 0; i < 40; i++) { const s = ctx.createBufferSource(); s.buffer = buf; s.playbackRate.value = 1 + (i % 3) * 0.5; s.connect(E.masterOutput); s.start(t + i * 0.02, 0.5 + i * 0.0137, 0.02); }
  await new Promise(r => setTimeout(r, 1300));
  return window.__qaStats(R.stop(), ctx.sampleRate);
}
"""


def open_project(pg, label):
    src = OUT / "00_projet_r17.novaproj.zip"
    make_project(src)
    open_project_file(pg, src, RES, label)
    pg.wait_for_function("() => !!window.DAW_CONTROL && window.DAW_CONTROL.getState().tracks.some(t => t.id === 'voix' && t.clips[0] && t.clips[0].bufferId)", timeout=40000)
    adv = pg.get_by_role("button", name=re.compile("mode avancé", re.I)).locator("visible=true").first
    if adv.count() and adv.is_visible():
        adv.click(); pg.wait_for_timeout(800)
    pg.wait_for_timeout(800)


def lane_geom(pg):
    hb = pg.locator('[data-nova-target="track-voix"]').first.bounding_box()
    zoom = float(pg.locator('input[type=range][max="300"]').first.input_value())
    return hb, zoom


def set_zoom(pg, value):
    pg.evaluate("""(v) => { const el = document.querySelector('input[type=range][max="300"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, String(v)); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }""", value)
    pg.wait_for_timeout(400)


def open_editor(pg):
    press(pg, "Control+Alt+k", 700)
    if not pg.locator('[data-testid="keymap-editor"]').count():
        press(pg, "?", 500)
        pg.locator('[data-testid="shortcuts-customize"]').click(); pg.wait_for_timeout(600)
    return pg.locator('[data-testid="keymap-editor"]').count() > 0


def close_dialog(pg):
    pg.locator('[role=dialog] button[aria-label="Fermer"]').last.click(); pg.wait_for_timeout(400)


def scrub_measures(pg, prefix, touch=False):
    pg.evaluate(REC_INIT)
    hb, zoom = lane_geom(pg)
    y = hb["y"] + hb["height"] * 0.6
    x_zero = hb["x"] + hb["width"]
    out = {}
    # Lent : ×0,5 (de 0,5 s à ~1,5 s), rapide : ×2 (de 2 s à ~5 s).
    for name, t_start, speed, ms in (("lent", 0.5, 0.5, 2000), ("rapide", 2.0, 2.0, 1500)):
        r = pg.evaluate(DRAG_JS, {"x0": x_zero + t_start * zoom, "y": y, "pxPerSec": speed * zoom, "ms": ms, "zoom": zoom, "xZero": x_zero, "touch": touch})
        r["attendu_hz"] = 440 * speed
        r["fin_etat"] = st(pg)["t"]
        out[name] = r
    return out


def run_pc(b):
    log = Log("r17_pc")
    ctx, pg = new_page(b, "pc", log)
    prepare(pg, None, desktop=False)
    try:
        ctx.add_init_script("try { localStorage.removeItem('nova_keymap_v1'); localStorage.removeItem('nova_window_layouts_v1'); } catch (e) {}")
        open_project(pg, "r17_01_projet_ouvert")

        # --- 1. Remappage par capture, puis utilisation -------------------------------
        ok("PC · éditeur de raccourcis ouvert (Ctrl+Alt+K)", open_editor(pg))
        n_cmds = pg.locator('[data-testid="keymap-list"] li').count()
        ok("PC · toutes les commandes listées", n_cmds >= 100, n_cmds)
        pg.locator('[data-testid="keymap-search"]').fill("repère à la tête"); pg.wait_for_timeout(300)
        pg.locator('[data-testid="keymap-key-nova.marker-0"]').click(); pg.wait_for_timeout(300)
        shot(pg, "r17_02_capture_touche")
        pg.keyboard.press("j"); pg.wait_for_timeout(400)
        msg = pg.locator('[data-testid="keymap-message"]').inner_text() if pg.locator('[data-testid="keymap-message"]').count() else ""
        ok("PC · « Poser un repère » remappé sur J par capture", "J" in msg, msg)
        shot(pg, "r17_03_remappe")
        # Conflit : Ctrl+E est déjà « Séparer » → proposition, puis « Annuler ».
        pg.locator('[data-testid="keymap-add-nova.marker"]').click(); pg.wait_for_timeout(300)
        pg.keyboard.press("Control+e"); pg.wait_for_timeout(400)
        conflict = pg.locator('[data-testid="keymap-conflict"]')
        ok("PC · conflit détecté avec une résolution proposée", conflict.count() > 0 and "Séparer" in conflict.inner_text(), conflict.inner_text()[:160] if conflict.count() else None)
        shot(pg, "r17_04_conflit_propose")
        conflict.get_by_role("button", name="Annuler").click(); pg.wait_for_timeout(300)
        close_dialog(pg)
        before = st(pg)["markers"]
        pg.evaluate("() => window.DAW_CONTROL.seek(1.5)"); pg.wait_for_timeout(300)
        press(pg, "j", 500)
        after_j = st(pg)["markers"]
        press(pg, "k", 500)
        after_k = st(pg)["markers"]
        ok("PC · J pose un repère, K ne le fait plus", after_j == before + 1 and after_k == after_j, {"avant": before, "J": after_j, "K": after_k})
        press(pg, "?", 600)
        pg.locator('[data-testid="shortcuts-search"]').fill("repère à la tête"); pg.wait_for_timeout(300)
        rows = pg.locator('[role=dialog] li').all_inner_texts()
        ok("PC · l'aide « ? » montre le raccourci actif (J)", any(r.strip().endswith("J") for r in rows), rows[:3])
        shot(pg, "r17_05_aide_reflete_J")
        pg.keyboard.press("Escape"); pg.wait_for_timeout(300)

        # --- 2. Préréglage Pro Tools : 10+ raccourcis vérifiés en vrai ----------------------
        open_editor(pg)
        pg.locator('[data-testid="keymap-preset-protools"]').click(); pg.wait_for_timeout(300)
        pg.once("dialog", lambda d: d.accept())
        pg.locator('[data-testid="keymap-apply-preset"]').click(); pg.wait_for_timeout(600)
        shot(pg, "r17_06_preset_protools")
        conflicts = pg.locator('[data-testid="keymap-conflict-count"]').inner_text()
        ok("PC · préréglage Pro Tools appliqué, aucun conflit", "aucun conflit" in conflicts, conflicts)
        close_dialog(pg)
        pt = {}
        press(pg, "F9"); pt["F9 = Scrubber"] = tool_on(pg, "tool-scrub")
        press(pg, "F5"); pt["F5 = Zoom"] = tool_on(pg, "tool-zoom")
        press(pg, "F7"); pt["F7 = Sélecteur"] = pg.get_by_role("button", name="Sélecteur de plage").first.get_attribute("aria-pressed") == "true"
        press(pg, "F8"); pt["F8 = Main (Grabber)"] = pg.get_by_role("button", name="Outil sélection").first.get_attribute("class").find("bg-[#38bdf8]") >= 0
        l0 = st(pg)["loop"]; press(pg, "Control+Shift+l"); pt["Ctrl+Maj+L = boucle"] = st(pg)["loop"] != l0
        pg.evaluate("() => window.DAW_CONTROL.seek(3)"); pg.wait_for_timeout(300)
        press(pg, "Control+e", 700); n_split = len(st(pg)["clips"]); pt["Ctrl+E = séparer"] = n_split == 2
        press(pg, "Control+z", 700); pt["Ctrl+Z = annuler (touche Z US = W en AZERTY)"] = len(st(pg)["clips"]) == 1
        press(pg, "Control+Shift+z", 700); pt["Ctrl+Maj+Z = rétablir"] = len(st(pg)["clips"]) == 2
        press(pg, "Control+z", 700)
        m0 = st(pg)["markers"]; press(pg, "NumpadEnter"); pt["Entrée du pavé = repère"] = st(pg)["markers"] == m0 + 1
        press(pg, "Control+Equal", 700); v1 = st(pg)["view"]; press(pg, "Control+Equal", 700); v2 = st(pg)["view"]
        pt["Ctrl+= = console / édition"] = v1 == "MIXER" and v2 == "ARRANGEMENT"
        q0 = st(pg)["qp"]; press(pg, "Control+Shift+p"); q1 = st(pg)["qp"]; press(pg, "Numpad6"); q2 = st(pg)["qp"]
        pt["Ctrl+Maj+P et pavé 6 = QuickPunch"] = q1 != q0 and q2 == q0
        press(pg, "r", 600); pt["R n'enregistre plus (comme Pro Tools)"] = not st(pg)["rec"]
        # Ctrl+M = muter le clip (sélection de la piste : le clip sous la tête de lecture).
        hb, zoom = lane_geom(pg)
        press(pg, "F8")
        pg.mouse.click(hb["x"] + hb["width"] + 3 * zoom, hb["y"] + hb["height"] * 0.7); pg.wait_for_timeout(400)
        press(pg, "Control+m", 600); pt["Ctrl+M = clip muet"] = st(pg)["clips"][0]["muted"]
        press(pg, "Control+m", 400)
        shot(pg, "r17_07_protools_raccourcis")
        good = [k for k, v in pt.items() if v]
        ok(f"PC · Pro Tools : {len(good)} raccourcis vérifiés en vrai", len(good) >= 10, pt)
        RES["mesures"]["protools_raccourcis"] = pt

        # --- 3. Scrub audible mesuré ----------------------------------------------------------
        set_zoom(pg, 100)
        press(pg, "F9")
        ok("PC · outil Scrubber actif (F9)", tool_on(pg, "tool-scrub"))
        sc = scrub_measures(pg, "pc")
        RES["mesures"]["scrub"] = sc
        for name, r in sc.items():
            m = r["mid"]
            ok(f"PC · scrub {name} : du son au master", r["all"]["rms"] > 0.02 and r["stats"]["grains"] > 20, {"rms": round(r["all"]["rms"], 4), "grains": r["stats"]["grains"]})
            ok(f"PC · scrub {name} : hauteur = vitesse du geste ({r['attendu_hz']:.0f} Hz)", abs(m["freq"] - r["attendu_hz"]) / r["attendu_hz"] < 0.15, round(m["freq"], 1))
            ok(f"PC · scrub {name} : aucun clic (saut max / crête)", r["all"]["clickRatio"] < 0.35, round(r["all"]["clickRatio"], 3))
            ok(f"PC · scrub {name} : la position suit la souris", r["followMedian"] < 0.15, {"médiane_s": round(r["followMedian"], 3), "max_s": round(r["followMax"], 3)})
            ok(f"PC · scrub {name} : la tête de lecture reste où le geste s'arrête", abs(r["fin_etat"] - r["endMouse"]) < 0.08, {"etat": r["fin_etat"], "souris": round(r["endMouse"], 3)})
        naive = pg.evaluate(NAIVE_JS)
        RES["mesures"]["grains_sans_fenetre"] = naive
        ok("PC · témoin : des grains coupés net font des clics (la mesure les voit)", naive["clickRatio"] > sc["rapide"]["all"]["clickRatio"] * 2, round(naive["clickRatio"], 3))
        shot(pg, "r17_08_scrub")

        # Ctrl+glisser avec le Sélecteur = scrub temporaire (Pro Tools).
        press(pg, "F7")
        hb, zoom = lane_geom(pg)
        pg.evaluate(REC_INIT)
        g0 = pg.evaluate("() => (window.__qaRec.E.getScrubStats() || { grains: 0 }).grains")
        x0 = hb["x"] + hb["width"] + 1 * zoom; y0 = hb["y"] + hb["height"] * 0.3
        pg.keyboard.down("Control"); pg.mouse.move(x0, y0); pg.mouse.down()
        for i in range(20): pg.mouse.move(x0 + i * 6, y0); pg.wait_for_timeout(25)
        pg.mouse.up(); pg.keyboard.up("Control"); pg.wait_for_timeout(500)
        g1 = pg.evaluate("() => (window.__qaRec.E.getScrubStats() || { grains: 0 }).grains")
        ok("PC · Ctrl+glisser avec le Sélecteur = scrub", g1 > g0 + 5, {"grains": g1 - g0})

        # --- 4. Shuttle au clavier ---------------------------------------------------------------
        pg.evaluate("() => window.DAW_CONTROL.seek(0)"); pg.wait_for_timeout(300)
        # Touches envoyées DANS la page, minutées par performance.now() (sans le délai de Playwright).
        shres = pg.evaluate(r"""async () => {
          const R = window.__qaRec; const key = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: 'Key' + k.toUpperCase(), altKey: true, bubbles: true, cancelable: true }));
          const sc = (await window.__novaAppModule('/utils/scrubControl.ts')).scrubControl;
          const pre = { t: window.DAW_CONTROL.getState().currentTime, stats: R.E.getScrubStats(), speed: sc.shuttleSpeed, playing: R.E.getIsPlaying() };
          R.start(); const t0 = performance.now(); const a0 = R.ctx.currentTime; key('l');
          await new Promise(r => setTimeout(r, 500)); const mid = { pos: R.E.getScrubPosition(), speed: sc.shuttleSpeed };
          await new Promise(r => setTimeout(r, 500)); key('k'); const el = (performance.now() - t0) / 1000; const audioEl = R.ctx.currentTime - a0;
          await new Promise(r => setTimeout(r, 300));
          return { pre, mid, s: window.__qaStats(R.stop(), R.ctx.sampleRate, 0.2, 0.6), elapsed: el, audioElapsed: audioEl, t: window.DAW_CONTROL.getState().currentTime };
        }""")
        sh = shres["s"]; t_sh = shres["t"]
        RES["mesures"]["shuttle"] = {"position": t_sh, "duree_reelle": shres["elapsed"], "duree_horloge_audio": shres["audioElapsed"], "avant": shres["pre"], "milieu": shres["mid"], **sh}
        # Référence : l'horloge AUDIO (en headless, le faux périphérique de sortie peut tourner plus vite que la montre).
        ok("PC · shuttle Alt+L (×1) puis Alt+K : la tête avance au temps réel, son à 440 Hz",
           abs(t_sh - shres["audioElapsed"]) < 0.15 and abs(sh["freq"] - 440) < 30 and sh["clickRatio"] < 0.35,
           {"t": round(t_sh, 3), "duree_audio": round(shres["audioElapsed"], 3), "duree_montre": round(shres["elapsed"], 3), "freq": round(sh["freq"], 1), "clic": round(sh["clickRatio"], 3)})

        # --- 5. Dispositions ---------------------------------------------------------------------
        press(pg, "Control+Shift+3", 900)
        v_mix = st(pg)["view"]
        shot(pg, "r17_09_disposition_mix")
        press(pg, "Control+Shift+1", 900)
        v_rec = st(pg)["view"]
        ok("PC · dispositions livrées : Mix (Ctrl+Maj+3) puis Enregistrement (Ctrl+Maj+1)", v_mix == "MIXER" and v_rec == "ARRANGEMENT", {"mix": v_mix, "rec": v_rec})
        blur(pg); pg.keyboard.press("NumpadDecimal"); pg.keyboard.press("Numpad2"); pg.keyboard.press("NumpadMultiply"); pg.wait_for_timeout(900)
        edit_zoom = lane_geom(pg)[1]
        tracks_panel = pg.locator('[data-testid="dock-track-list"]').first.get_attribute("aria-pressed")
        ok("PC · pavé . 2 * = disposition Édition (zoom 120, liste des pistes)", abs(edit_zoom - 120) < 1 and tracks_panel == "true", {"zoom": edit_zoom, "liste": tracks_panel})
        shot(pg, "r17_10_disposition_edition")
        set_zoom(pg, 222)
        press(pg, "Control+Alt+j", 700)
        pg.once("dialog", lambda d: d.accept())
        pg.locator('[data-testid="layout-save-4"]').click(); pg.wait_for_timeout(500)
        shot(pg, "r17_11_liste_dispositions")
        close_dialog(pg)
        set_zoom(pg, 40)
        press(pg, "Control+Shift+4", 900)
        z4 = lane_geom(pg)[1]
        ok("PC · disposition 4 enregistrée puis rappelée (zoom 222 retrouvé)", abs(z4 - 222) < 1, z4)

        # --- 6. Export / import .novakeys, thème clair ----------------------------------------------
        open_editor(pg)
        with pg.expect_download(timeout=15000) as dl:
            pg.locator('[data-testid="keymap-export"]').click()
        dest = OUT / "raccourcis-protools.novakeys"
        dl.value.save_as(str(dest))
        data = json.loads(dest.read_text(encoding="utf-8"))
        ok("PC · export .novakeys (Pro Tools)", data.get("format") == "novakeys" and data.get("preset") == "protools" and data["bindings"].get("pt.split") == ["ctrl+e"], {"commandes": len(data.get("bindings", {}))})
        pg.locator('[data-testid="keymap-preset-nova"]').click()
        pg.locator('[data-testid="keymap-apply-preset"]').click(); pg.wait_for_timeout(400)
        pg.locator('[data-testid="keymap-import-file"]').set_input_files(str(dest)); pg.wait_for_timeout(700)
        msg = pg.locator('[data-testid="keymap-message"]').inner_text()
        active = pg.evaluate("() => JSON.parse(localStorage.getItem('nova_keymap_v1')).preset")
        ok("PC · import .novakeys : le jeu Pro Tools revient", active == "protools" and "importés" in msg, msg)
        shot(pg, "r17_12_editeur_sombre")
        pg.evaluate("() => { document.documentElement.setAttribute('data-theme', 'light'); }"); pg.wait_for_timeout(400)
        shot(pg, "r17_13_editeur_clair")
        pg.evaluate("() => { document.documentElement.setAttribute('data-theme', 'dark'); }")
        close_dialog(pg)
        errs = log.errors()
        ok("PC · aucune erreur de page", not errs, errs[:3])
    except Exception as e:
        shot(pg, "r17_99_echec_pc")
        ok("PC · scénario sans exception", False, repr(e)[:400])
    finally:
        ctx.close()


def run_tab(b):
    log = Log("r17_tab")
    ctx, pg = new_page(b, "tab", log)
    prepare(pg, None, desktop=False)
    try:
        ctx.add_init_script("try { localStorage.removeItem('nova_keymap_v1'); } catch (e) {}")
        open_project(pg, "r17_20_tablette_projet")
        pg.locator('[data-testid="tool-scrub"]').first.tap(); pg.wait_for_timeout(300)
        ok("Tablette · outil Scrubber au doigt", tool_on(pg, "tool-scrub"))
        set_zoom(pg, 100)
        sc = scrub_measures(pg, "tab", touch=True)
        RES["mesures"]["scrub_tablette"] = sc
        r = sc["rapide"]
        ok("Tablette · scrub au doigt : son, hauteur, sans clic", r["all"]["rms"] > 0.02 and abs(r["mid"]["freq"] - 880) / 880 < 0.15 and r["all"]["clickRatio"] < 0.35,
           {"rms": round(r["all"]["rms"], 4), "hz": round(r["mid"]["freq"], 1), "clic": round(r["all"]["clickRatio"], 3)})
        shot(pg, "r17_21_tablette_scrub")
        pg.evaluate("() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', code: 'Slash', shiftKey: true, bubbles: true }))"); pg.wait_for_timeout(500)
        has = pg.locator('[data-testid="shortcuts-customize"]').count() > 0
        if has:
            pg.locator('[data-testid="shortcuts-customize"]').tap(); pg.wait_for_timeout(600)
        ok("Tablette · éditeur de raccourcis disponible", pg.locator('[data-testid="keymap-editor"]').count() > 0)
        shot(pg, "r17_22_tablette_editeur")
        # La barre d'outils d'édition coupait déjà « 1/4 (temps) » à 1024 px avec le navigateur ouvert
        # (avant R17) : on vérifie que la page ne défile pas en largeur et que le bouton Scrub est visible.
        ov = [o for o in overflow_report(pg) if o["kind"] == "page-hscroll"]
        sb = pg.locator('[data-testid="tool-scrub"]').first.bounding_box()
        ok("Tablette · pas de défilement horizontal, bouton Scrub visible", not ov and sb and sb["x"] + sb["width"] <= 1024, {"page": ov[:2], "scrub_droite": sb and round(sb["x"] + sb["width"])})
        errs = log.errors()
        ok("Tablette · aucune erreur de page", not errs, errs[:3])
    except Exception as e:
        shot(pg, "r17_99_echec_tab")
        ok("Tablette · scénario sans exception", False, repr(e)[:400])
    finally:
        ctx.close()


def run_tel(b):
    log = Log("r17_tel")
    ctx, pg = new_page(b, "tel", log)
    prepare(pg, None, desktop=False)
    try:
        open_project(pg, "r17_30_telephone_projet")
        pg.evaluate(REC_INIT)
        ruler = pg.locator('[data-testid="mobile-ruler"]').first
        ruler.wait_for(timeout=15000)
        box = ruler.bounding_box()
        zoom = pg.evaluate("""() => { const r = document.querySelector('[data-testid="mobile-ruler"]'); return r.getBoundingClientRect().width / Math.max(1, r.scrollWidth); }""")
        # Doigt posé sur la règle puis glissé : scrub audible, puis la tête de lecture reste là.
        res = pg.evaluate(r"""async ({ x0, y, dx, ms }) => {
          const el = document.querySelector('[data-testid="mobile-ruler"]');
          const fire = (type, x) => el.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerType: 'touch', pointerId: 9, isPrimary: true, buttons: type === 'pointerup' ? 0 : 1 }));
          const R = window.__qaRec; R.start();
          fire('pointerdown', x0); const t0 = performance.now();
          await new Promise(res => { const step = () => { const e = performance.now() - t0; fire('pointermove', x0 + dx * Math.min(1, e / ms)); if (e < ms) requestAnimationFrame(step); else res(); }; requestAnimationFrame(step); });
          fire('pointerup', x0 + dx); await new Promise(r => setTimeout(r, 500));
          return { s: window.__qaStats(R.stop(), R.ctx.sampleRate), stats: R.E.getScrubStats(), t: window.DAW_CONTROL.getState().currentTime };
        }""", {"x0": box["x"] + 20, "y": box["y"] + box["height"] / 2, "dx": 160, "ms": 1500})
        RES["mesures"]["scrub_telephone"] = res
        ok("Téléphone · scrub au doigt sur la règle : son sans clic, tête de lecture déplacée",
           res["s"]["rms"] > 0.02 and res["s"]["clickRatio"] < 0.35 and res["t"] > 0.3, {"rms": round(res["s"]["rms"], 4), "clic": round(res["s"]["clickRatio"], 3), "t": round(res["t"], 3)})
        shot(pg, "r17_31_telephone_scrub")
        pg.evaluate("() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', code: 'Slash', shiftKey: true, bubbles: true }))"); pg.wait_for_timeout(500)
        ok("Téléphone · pas d'éditeur de raccourcis", pg.locator('[data-testid="shortcuts-customize"]').count() == 0 and pg.locator('[data-testid="keymap-editor"]').count() == 0)
        shot(pg, "r17_32_telephone_aide")
        ov = [o for o in overflow_report(pg) if o["kind"] in ("page-hscroll", "off-right")]
        ok("Téléphone · pas de débordement horizontal", not ov, ov[:3])
        errs = log.errors()
        ok("Téléphone · aucune erreur de page", not errs, errs[:3])
    except Exception as e:
        shot(pg, "r17_99_echec_tel")
        ok("Téléphone · scénario sans exception", False, repr(e)[:400])
    finally:
        ctx.close()


if __name__ == "__main__":
    with sync_playwright() as p:
        b = launch(p)
        try:
            if WHICH in ("pc", "tout"): run_pc(b)
            if WHICH in ("tab", "tout"): run_tab(b)
            if WHICH in ("tel", "tout"): run_tel(b)
        finally:
            b.close()
    total = len(RES["etapes"]); good = sum(1 for v in RES["etapes"].values() if v["ok"])
    RES["bilan"] = f"{good}/{total}"
    (OUT / f"r17_resultats_{WHICH}.json").write_text(json.dumps(RES, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nBilan R17 : {good}/{total}")
    sys.exit(0 if good == total else 1)
