"""Piano roll pro (15/10/2026) : une piste « 🎹 Synthé NOVA » écrite de bout en bout au piano roll.

Headless, aucune fenêtre, 100 % hors production (qalib importe qa_hors_prod). Bureau (1600 × 900)
au clavier et à la souris, téléphone (390 × 844) AU DOIGT (évènements tactiles), thèmes sombre
et clair. Pour chaque écran :
  1. projet en mode instru (La mineur, 140 BPM) → « 🎹 Synthé NOVA » → son « Reese drill » → piano roll ;
     clip vide : l'aide « Clique dans la grille… » s'affiche ;
  2. beat de 808 : deux notes longues (crayon + longueur au tracé / poignée au doigt), puis des
     GLISSÉS posés pendant la note tenue (bouton « Glissé ») : notes marquées, portées, courbe dessinée ;
  3. pinceau (bureau) : une rangée de notes peinte en un geste ;
  4. accords dans la gamme : « Accord de la gamme », 1er renversement, un clic = 3 notes de La mineur ;
  5. vélocité : rampe au couloir (bureau : outil ligne ; téléphone : crayon au doigt), Maj + Alt + molette (bureau) ;
  6. humaniser puis quantifier (grille 1/16, force 100 %) : toutes les notes retombent sur la grille ;
  7. dupliquer à la suite (Ctrl+B / bouton « 2x ») ; pincer pour zoomer (téléphone) ;
  8. écouter (▶ : la tête avance, le synthé sonne), exporter le clip en .mid (fichier MThd) ;
  9. contrôles : aucune erreur console, aucun défilement horizontal, cibles ≥ 44 px au téléphone,
     contrastes et mots anglais (qa/ux_audit.js), captures regardées.
Bureau sombre en plus : preuve audio du glissé (rendu = export : la hauteur passe de La0 à Mi1
sans nouvelle attaque) et écart lecture réelle / export sur un clip avec glissés.

NOVA_URL=http://127.0.0.1:3471/ python qa/pianoroll_pro.py [pc_dark tel390_light …]
Captures : QA_OUT ou D:\\1 WORK\\CONTENU\\nova-pianoroll\\captures
"""
import json, os, sys, zipfile
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3471/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-pianoroll\captures")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402
from qalib import OUT, BASE, Log, new_page, shot  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

PROJ = OUT / "projet_pianoroll_pro.zip"
RUNS = [("pc", "dark"), ("tel390", "dark"), ("pc", "light"), ("tel390", "light")]
BPM = 140
BEAT = 60 / BPM
KO = []
AUDIT_JS = "\n".join(l for l in (Path(__file__).parent / "ux_audit.js").read_text(encoding="utf-8").splitlines() if not l.startswith("//"))


def ok(name, cond, detail=None):
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False)[:500]}"), flush=True)
    if not cond:
        KO.append(name)
    return cond


def make_project():
    # Une mélodie existante (notes fantômes), tonalité La mineur, mode instru.
    notes = [{"id": f"m{i}", "pitch": p, "start": i * BEAT, "duration": BEAT * 0.9, "velocity": 0.8} for i, p in enumerate([69, 72, 76, 74, 72, 71, 69, 64])]
    track = {"id": "melodie", "name": "Mélodie", "type": "MIDI", "color": "#a78bfa", "isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False,
             "volume": 1.0, "pan": 0, "outputTrackId": "master", "sends": [], "clips": [{"id": "c1", "name": "Mélodie", "start": 0, "duration": 8 * BEAT, "offset": 0,
             "fadeIn": 0, "fadeOut": 0, "color": "#a78bfa", "type": "MIDI", "notes": notes, "gain": 1}], "plugins": [], "automationLanes": [], "totalLatency": 0}
    state = {"id": "proj-pr-pro", "name": "Piano roll pro", "bpm": BPM, "timeSignature": {"numerator": 4, "denominator": 4}, "isPlaying": False, "isRecording": False,
             "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8, "tracks": [track], "trackGroups": [], "markers": [], "selectedTrackId": "melodie",
             "currentView": "ARRANGEMENT", "projectPhase": "RECORDING", "projectMode": "BEATMAKING", "isLowLatencyMode": False, "isRecModeActive": False,
             "systemMaxLatency": 0, "recStartTime": None, "isDelayCompEnabled": True, "projectKey": 9, "projectScale": "MINOR",
             "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
             "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0}}
    with zipfile.ZipFile(PROJ, "w") as z:
        z.writestr("project.json", json.dumps(state))


def open_project(page):
    page.add_init_script("try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_count_in', '0'); localStorage.setItem('nova_auto_clean', '0'); localStorage.removeItem('nova.pianoroll.prefs'); } catch (e) {}")
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
    page.wait_for_function("() => !!window.__novaEdit", timeout=20000)


STATE_NOTES = """(tid) => { const t = window.__novaEdit.getState().tracks.find(x => x.id === tid); if (!t) return null;
  const c = t.clips[0]; return { start: c.start, duration: c.duration, notes: (c.notes || []).map(n => ({ p: n.pitch, s: Math.round(n.start * 1e5) / 1e5, d: Math.round(n.duration * 1e5) / 1e5, v: Math.round(n.velocity * 127), slide: !!n.slide })) }; }"""

GEOM = """() => { const g = document.querySelector('[data-nova-roll-grid]'); const r = g.getBoundingClientRect();
  return { left: r.left, top: r.top, w: r.width, h: r.height, sl: g.scrollLeft, st: g.scrollTop, zoom: +g.dataset.novaZoom, rowH: +g.dataset.novaRowH, cs: +g.dataset.novaClipStart }; }"""

# Glisser au doigt : évènements pointeur « touch » (le piano roll écoute pointerdown sur la grille, puis la fenêtre).
TOUCH_DRAG = """async ([x0, y0, x1, y1, steps]) => {
  const el = document.elementFromPoint(x0, y0); if (!el) return 'rien sous le doigt';
  const opt = (x, y, b) => ({ bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, button: 0, buttons: b });
  // Un vrai doigt laisse passer des images entre deux évènements (l'appli se met à jour entre-temps).
  const frame = () => new Promise(r => setTimeout(r, 20));
  el.dispatchEvent(new PointerEvent('pointerdown', opt(x0, y0, 1))); await frame();
  for (let i = 1; i <= steps; i++) { const x = x0 + (x1 - x0) * i / steps, y = y0 + (y1 - y0) * i / steps; el.dispatchEvent(new PointerEvent('pointermove', opt(x, y, 1))); await frame(); }
  el.dispatchEvent(new PointerEvent('pointerup', opt(x1, y1, 0))); await frame();
  return el.tagName + '.' + (el.className || '').toString().slice(0, 30);
}"""

PINCH = """([cx, cy, d0, d1]) => {
  const g = document.querySelector('[data-nova-roll-grid]');
  const mk = (id, x, y) => new Touch({ identifier: id, target: g, clientX: x, clientY: y });
  const ev = (type, d) => { const a = mk(1, cx - d / 2, cy), b = mk(2, cx + d / 2, cy); const list = type === 'touchend' ? [] : [a, b];
    g.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: list, targetTouches: list, changedTouches: [a, b] })); };
  const z0 = +g.dataset.novaZoom;
  ev('touchstart', d0); for (let i = 1; i <= 6; i++) ev('touchmove', d0 + (d1 - d0) * i / 6); ev('touchend', d1);
  return new Promise(r => setTimeout(() => r([z0, +document.querySelector('[data-nova-roll-grid]').dataset.novaZoom]), 250));
}"""

TARGETS = """() => {
  const p = document.querySelector('[data-nova-pianoroll]'); if (!p) return null;
  const vis = e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  // Barres d'outils et menus (le clavier vertical et les notes sont des surfaces de jeu, pas des boutons).
  const zones = [...p.querySelectorAll('[data-nova-roll="barre"], [data-nova-roll="barre-avancee"]'), ...document.querySelectorAll('[data-nova-roll-menu]')];
  const t = zones.flatMap(z => [...z.querySelectorAll('button, select, input[type=checkbox], input[type=range]')]).filter(vis)
    .filter(e => { const r = e.getBoundingClientRect(); return r.right > 0 && r.left < innerWidth; });
  const small = t.map(e => { const r = e.getBoundingClientRect(); return { t: (e.getAttribute('aria-label') || e.innerText || e.title || '').toString().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter(x => Math.min(x.w, x.h) < 43.5 && !(x.w === 0));
  return { cibles: t.length, petites: small.slice(0, 12), n_petites: small.length, defilement_horizontal: document.documentElement.scrollWidth > innerWidth + 1 };
}"""

AUDIO_JS = r"""
async () => {
  const M = p => window.__novaAppModule(p);
  const { audioEngine: E } = await M('/engine/AudioEngine.ts');
  const { TrackType } = await M('/types.ts');
  const P = await M('/utils/novaSynthPresets.ts');
  const SR = 48000, B = 60 / 140;
  const s = P.presetSettings('reese-drill');
  const track = (id, notes, dur) => ({ id, name: id, type: TrackType.MIDI, volume: 1, pan: 0, isMuted: false, isSolo: false,
    clips: [{ id: id + '-c', type: TrackType.MIDI, start: 0, duration: dur, offset: 0, name: 'm', notes }], plugins: [], sends: [], automationLanes: [], outputTrackId: 'master', novaSynth: s });
  // La0 (note 33) tenu 2 temps, glissé vers Mi1 (note 40) au 2e temps (durée 1/4 de temps), sans autre note.
  const notes = [{ id: 'h', pitch: 33, start: 0, duration: 2 * B, velocity: 0.9 }, { id: 's', pitch: 40, start: B, duration: B / 4, velocity: 0.9, slide: true }];
  const plain = [{ id: 'h', pitch: 33, start: 0, duration: 2 * B, velocity: 0.9 }];
  const DUR = 2 * B + 0.4;
  const mono = b => { const L = b.getChannelData(0), R = b.getChannelData(1); const x = new Float32Array(L.length); for (let i = 0; i < x.length; i++) x[i] = (L[i] + R[i]) / 2; return x; };
  // Fréquence fondamentale par autocorrélation (18-200 Hz) : le PREMIER pic à 90 % du maximum
  // (les multiples de la période corrèlent presque autant : sinon on lit l'octave du dessous).
  const f0 = (x, a, b) => { const i0 = Math.floor(a * SR), n = Math.floor((b - a) * SR), lo = Math.floor(SR / 200), hi = Math.floor(SR / 18);
    const c = new Float64Array(hi + 2); let best = 0;
    for (let lag = lo; lag <= hi + 1; lag++) { let s = 0; for (let i = 0; i < n; i++) s += x[i0 + i] * x[i0 + i + lag]; c[lag] = s; if (lag <= hi && s > best) best = s; }
    for (let lag = lo + 1; lag <= hi; lag++) if (c[lag] >= 0.9 * best && c[lag] >= c[lag - 1] && c[lag] >= c[lag + 1]) return Math.round(SR / lag * 10) / 10;
    return 0; };
  const env = (x, a, b) => { let m = 0; for (let i = Math.floor(a * SR); i < Math.floor(b * SR); i++) m = Math.max(m, Math.abs(x[i])); return m; };
  const withSlide = mono(await E.renderProject([track('ps', notes, DUR)], DUR, 0, SR));
  const without = mono(await E.renderProject([track('pp', plain, DUR)], DUR, 0, SR));
  const out = {
    f_avant_glisse_Hz: f0(withSlide, 0.25 * B, 0.95 * B), f_apres_glisse_Hz: f0(withSlide, 1.4 * B, 1.95 * B),
    f_sans_glisse_Hz: f0(without, 1.4 * B, 1.95 * B), rapport_attendu_quinte: 1.4983,
    // Pas de nouvelle attaque : l'enveloppe autour du glissé ne remonte pas au-dessus du niveau tenu.
    crete_avant: Math.round(env(withSlide, 0.6 * B, 0.98 * B) * 1000) / 1000, crete_pendant: Math.round(env(withSlide, B, 1.3 * B) * 1000) / 1000,
  };
  // Lecture réelle contre export sur le même clip (enregistreur à l'échantillon près, comme qa/synth_v24_preuve.py).
  await E.init(); await E.resume();
  const ctx = E.ctx, SRL = ctx.sampleRate;
  try { await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([`class R extends AudioWorkletProcessor { process(i){ const a = i[0]; if (a && a.length) this.port.postMessage({ f: currentFrame, l: new Float32Array(a[0]), r: new Float32Array(a[1] || a[0]) }); return true; } } registerProcessor('pr-rec', R);`], { type: 'application/javascript' }))); } catch (e) {}
  const live = async (id, ns) => {
    const tr = [track(id, ns, DUR)];
    const rb = await E.renderProject(tr, DUR, 0, SRL);
    tr.forEach(t => E.updateTrack(t, tr));
    await new Promise(r => setTimeout(r, 400));
    const dsp = E.tracksDSP.get(id);
    const rec = new AudioWorkletNode(ctx, 'pr-rec', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
    const chunks = []; rec.port.onmessage = e => chunks.push(e.data);
    dsp.output.connect(rec);
    E.startPlayback(0, tr);
    const fs = Math.round(E.playbackStartTime * SRL);
    await new Promise(r => setTimeout(r, (DUR + 0.6) * 1000));
    E.stopAll?.(); dsp.output.disconnect(rec);
    const n = Math.floor(DUR * SRL), L = [new Float32Array(n), new Float32Array(n)], seen = new Uint8Array(n);
    for (const c of chunks) for (let i = 0; i < c.l.length; i++) { const k = c.f - fs + i; if (k >= 0 && k < n) { L[0][k] = c.l[i]; L[1][k] = c.r[i]; seen[k] = 1; } }
    const okm = Uint8Array.from(seen); for (let i = 0; i < n; i++) if (!seen[i]) for (let k = Math.max(0, i - 256); k < Math.min(n, i + 256); k++) okm[k] = 0;
    let e = 0, sref = 0, missing = 0; for (let i = 0; i < n; i++) if (!seen[i]) missing++;
    for (const ch of [0, 1]) { const x = rb.getChannelData(ch); for (let i = 0; i < n; i++) { if (!okm[i]) continue; const d = x[i] - L[ch][i]; e += d * d; sref += x[i] * x[i]; } }
    return { ecart_dB: sref > 0 ? Math.round(20 * Math.log10(Math.sqrt(e / sref) || 1e-12) * 10) / 10 : null, echantillons_non_recus: missing };
  };
  out.lecture_vs_export_avec_glisse = await live('live-slide', notes);
  out.lecture_vs_export_sans_glisse = await live('live-plain', plain);
  return out;
}
"""


class Roll:
    """Positions dans la grille : temps (en temps musicaux) et hauteur → coordonnées écran."""

    def __init__(self, page, phone):
        self.page, self.phone = page, phone

    def geom(self):
        return self.page.evaluate(GEOM)

    def show_pitch(self, pitch):
        self.page.evaluate("(p) => { const g = document.querySelector('[data-nova-roll-grid]'); const h = +g.dataset.novaRowH; g.scrollTop = (127 - p) * h - g.clientHeight / 2; g.scrollLeft = 0; }", pitch)
        self.page.wait_for_timeout(150)

    def xy(self, beat, pitch, dx=4):
        g = self.geom()
        x = g["left"] + beat * BEAT * g["zoom"] - g["sl"] + dx
        if x < g["left"] + 8 or x > g["left"] + g["w"] - 24:  # hors de l'écran : on fait défiler la grille
            self.page.evaluate("(v) => { document.querySelector('[data-nova-roll-grid]').scrollLeft = v; }", max(0, beat * BEAT * g["zoom"] - g["w"] / 3))
            self.page.wait_for_timeout(120)
            g = self.geom()
            x = g["left"] + beat * BEAT * g["zoom"] - g["sl"] + dx
        y = g["top"] + (127 - pitch) * g["rowH"] - g["st"] + g["rowH"] / 2
        return x, y

    def tap(self, beat, pitch, dx=4):
        x, y = self.xy(beat, pitch, dx)
        if self.phone:
            self.page.touchscreen.tap(x, y)
        else:
            self.page.mouse.click(x, y)
        self.page.wait_for_timeout(160)

    def drag(self, b0, p0, b1, p1, dx0=4, dx1=4):
        g = self.geom()
        vis = lambda b: g["left"] + 8 <= g["left"] + b * BEAT * g["zoom"] - g["sl"] <= g["left"] + g["w"] - 24  # noqa: E731
        if not (vis(b0) and vis(b1)):
            self.page.evaluate("(v) => { document.querySelector('[data-nova-roll-grid]').scrollLeft = v; }", max(0, min(b0, b1) * BEAT * g["zoom"] - 30))
            self.page.wait_for_timeout(120)
            g = self.geom()
        X = lambda b, d: g["left"] + b * BEAT * g["zoom"] - g["sl"] + d  # noqa: E731
        Y = lambda p: g["top"] + (127 - p) * g["rowH"] - g["st"] + g["rowH"] / 2  # noqa: E731
        x0, y0, x1, y1 = X(b0, dx0), Y(p0), X(b1, dx1), Y(p1)
        if self.phone:
            self.page.evaluate(TOUCH_DRAG, [x0, y0, x1, y1, 8])
        else:
            self.page.mouse.move(x0, y0); self.page.mouse.down()
            self.page.mouse.move(x1, y1, steps=8); self.page.mouse.up()
        self.page.wait_for_timeout(200)


def click(page, sel, phone):
    # Piano roll pratique : une commande rangée dans un menu (Outils ▾, Notes ▾…) est d'abord rendue visible.
    loc = qalib.roll_reveal(page, sel) if ("data-nova-roll=" in sel or "data-nova-roll-tool" in sel) else page.locator(sel).first
    loc.scroll_into_view_if_needed()
    if phone:
        b = loc.bounding_box(); page.touchscreen.tap(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)
    else:
        loc.click()
    page.wait_for_timeout(250)


def run(vp, theme, res):
    os.environ["QA_THEME"] = theme
    tag = f"{vp}_{theme}"
    phone = vp.startswith("tel")
    log = Log(f"pianoroll_pro_{tag}")
    r = {}
    with sync_playwright() as p:
        b = qalib.launch(p)
        ctx, page = new_page(b, vp, log)
        try:
            open_project(page)
            before = {t for t in page.evaluate("() => window.__novaEdit.getState().tracks.map(t => t.id)")}
            # 1. Piste « Synthé NOVA », son Reese drill
            btn = page.locator("[data-testid=new-synth-track]").first
            btn.wait_for(timeout=15000)
            click(page, "[data-testid=new-synth-track]", phone)
            page.locator("[data-testid=synth-panel]").wait_for(timeout=10000)
            page.get_by_label("Chercher un son").fill("reese"); page.wait_for_timeout(300)
            click(page, "[data-testid=synth-presets] [data-preset=reese-drill]", phone)
            page.get_by_label("Chercher un son").fill("")
            page.get_by_role("button", name="Fermer le synthé").click(); page.wait_for_timeout(500)
            tid = [t for t in page.evaluate("() => window.__novaEdit.getState().tracks.map(t => t.id)") if t not in before][0]
            r["preset"] = page.evaluate("(tid) => window.__novaEdit.getState().tracks.find(x => x.id === tid).novaSynth.presetId", tid)
            page.locator("[data-nova-pianoroll]").wait_for(timeout=8000)
            r["aide_clip_vide"] = page.locator("[data-nova-roll=vide]").is_visible()
            # Piano roll pratique : l'outil actif dans la barre, la liste des outils dans son menu.
            page.locator("[data-nova-roll-menu-btn=outil]").first.click(); page.wait_for_timeout(200)
            r["outils"] = page.locator("[data-nova-roll-tool]").count()
            page.keyboard.press("Escape"); page.wait_for_timeout(150)
            ok(f"{tag} : piste Synthé NOVA (Reese drill), piano roll avec ses outils (menu « Outil ») et l'aide du clip vide",
               r["preset"] == "reese-drill" and r["outils"] >= 7 and r["aide_clip_vide"], r)
            shot(page, f"{tag}_01_vide")
            roll = Roll(page, phone)

            # 2. Beat de 808 + glissés
            roll.show_pitch(36)
            if phone:
                roll.tap(0, 33)                                # pose (1/16)
                n = page.evaluate(STATE_NOTES, tid)["notes"]
                r["tap_pose"] = len(n)
                L = n[0]["d"] / BEAT if n else 0.25
                roll.drag(L, 33, 2, 33, dx0=-5, dx1=0)        # poignée de durée au doigt → 2 temps
                roll.tap(2.5, 33)
                n2len = page.evaluate(STATE_NOTES, tid)["notes"]
                L2 = max(x["d"] for x in n2len if abs(x["s"] - 2.5 * BEAT) < 1e-3) / BEAT
                roll.drag(2.5 + L2, 33, 4.5, 33, dx0=-5, dx1=0)
                roll.tap(3, 40)                                 # le futur glissé (longueur = dernière : 2 temps)
                roll.drag(5, 40, 3.25, 40, dx0=-5, dx1=0)       # raccourci à 1/4 de temps
                roll.tap(3, 40, dx=3)                           # sélectionné
                click(page, "[data-nova-roll=glisse]", phone)   # → glissé
            else:
                roll.drag(0, 33, 2, 33, dx1=0)                  # crayon : clic + longueur au tracé
                roll.drag(2.5, 33, 4.5, 33, dx1=0)
                click(page, "[data-nova-roll=glisse]", phone)   # mode glissé (aucune sélection ? la dernière note l'est)
                st = page.evaluate(STATE_NOTES, tid)["notes"]
                if any(x["slide"] for x in st):                  # la note sélectionnée a basculé : on revient et on vide la sélection
                    click(page, "[data-nova-roll=glisse]", phone)
                    page.keyboard.press("e"); roll.tap(7, 60); page.keyboard.press("p")
                    click(page, "[data-nova-roll=glisse]", phone)
                x0, y0 = roll.xy(3, 40)
                page.mouse.move(x0, y0); page.mouse.down()
                page.mouse.move(x0 - (2 - 0.25) * BEAT * roll.geom()["zoom"], y0, steps=6); page.mouse.up(); page.wait_for_timeout(150)
                roll.tap(3.75, 28)                              # 2e glissé, enchaîné (longueur 1/4 reprise)
                click(page, "[data-nova-roll=glisse]", phone)   # mode glissé coupé
            st = page.evaluate(STATE_NOTES, tid)
            slides = [x for x in st["notes"] if x["slide"]]
            r["notes_808"] = st["notes"]
            r["courbes_glisse"] = page.locator("[data-nova-slide-curve]").count()
            want = 1 if phone else 2
            ok(f"{tag} : beat de 808 avec {want} glissé(s) portés par la note tenue (courbe dessinée)",
               len(slides) == want and r["courbes_glisse"] == want and any(abs(x["d"] - 2 * BEAT) < 0.01 for x in st["notes"] if not x["slide"]), st["notes"])
            shot(page, f"{tag}_02_808_glisses")

            # 3. Pinceau (bureau) : une rangée peinte en un geste
            if not phone:
                n0 = len(st["notes"])
                page.keyboard.press("b"); page.wait_for_timeout(100)
                roll.show_pitch(45)
                roll.drag(4.5, 45, 5.6, 45, dx1=0)
                page.keyboard.press("p")
                n1 = len(page.evaluate(STATE_NOTES, tid)["notes"])
                r["pinceau_notes"] = n1 - n0
                ok(f"{tag} : pinceau, une note par 1/16 en un geste", n1 - n0 >= 4, r["pinceau_notes"])

            # 4. Accords dans la gamme (La mineur), 1er renversement
            roll.show_pitch(60)
            click(page, "[data-nova-roll=accords]", phone)
            click(page, "[data-nova-chord-inv='1']", phone)
            page.get_by_role("button", name=__import__("re").compile("^Accord de la gamme")).first.click(); page.wait_for_timeout(250)
            n0 = page.evaluate(STATE_NOTES, tid)["notes"]
            roll.tap(6, 57)
            n1 = page.evaluate(STATE_NOTES, tid)["notes"]
            added = sorted(x["p"] for x in n1 if x not in n0)
            r["accord"] = added
            in_a_minor = all(((p - 9) % 12) in (0, 2, 3, 5, 7, 8, 10) for p in added)
            ok(f"{tag} : un clic pose l'accord de la gamme, 1er renversement (Do Mi La)", added == [60, 64, 69] and in_a_minor, added)
            shot(page, f"{tag}_03_accord")
            click(page, "[data-nova-roll=accords]", phone)
            page.get_by_role("button", name="Notes simples (couper l'outil accords)").click(); page.wait_for_timeout(200)

            # 5. Vélocité : rampe au couloir, Alt + molette
            roll.show_pitch(36)
            v0 = [x["v"] for x in page.evaluate(STATE_NOTES, tid)["notes"]]
            area = page.locator("[data-nova-cc-area]").first.bounding_box()
            g = roll.geom()
            xa = g["left"] + 0.1 * BEAT * g["zoom"] - g["sl"]; xb = min(g["left"] + g["w"] - 10, g["left"] + 4.4 * BEAT * g["zoom"] - g["sl"])
            if phone:
                page.evaluate(TOUCH_DRAG, [xa, area["y"] + area["height"] * 0.6, xb, area["y"] + area["height"] * 0.6, 20])
            else:
                page.locator("[data-nova-cc-tool=line]").click()
                page.mouse.move(xa, area["y"] + area["height"] * 0.9); page.mouse.down()
                page.mouse.move(xb, area["y"] + area["height"] * 0.1, steps=10); page.mouse.up()
                page.locator("[data-nova-cc-tool=pencil]").click()
            page.wait_for_timeout(250)
            v1 = [x["v"] for x in page.evaluate(STATE_NOTES, tid)["notes"]]
            r["velocites"] = [v0, v1]
            ok(f"{tag} : vélocité réglée au couloir ({'crayon au doigt' if phone else 'rampe'})", v1 != v0 and len(set(v1)) >= 2, r["velocites"])
            if not phone:
                roll.show_pitch(36)
                x, y = roll.xy(0.5, 33)
                va = page.evaluate(STATE_NOTES, tid)["notes"]
                page.mouse.move(x, y); page.keyboard.down("Shift"); page.keyboard.down("Alt"); page.mouse.wheel(0, -100); page.mouse.wheel(0, -100); page.keyboard.up("Alt"); page.keyboard.up("Shift")
                page.wait_for_timeout(200)
                vb = page.evaluate(STATE_NOTES, tid)["notes"]
                da = [x["v"] for x in va if x["p"] == 33 and x["s"] == 0]; db = [x["v"] for x in vb if x["p"] == 33 and x["s"] == 0]
                r["alt_molette"] = [da, db]
                ok(f"{tag} : Maj + Alt + molette sur une note monte sa vélocité", da and db and db[0] > da[0], r["alt_molette"])
            shot(page, f"{tag}_04_velocite")

            # 6. Humaniser puis quantifier (1/16, 100 %)
            if phone:
                click(page, "[data-nova-roll=humaniser]", phone)
            else:
                page.keyboard.press("Control+a"); page.keyboard.press("h")
            page.wait_for_timeout(200)
            hum = page.evaluate(STATE_NOTES, tid)
            grid = BEAT / 4
            off = lambda notes: sum(1 for x in notes if abs(round((hum["start"] + x["s"]) / grid) * grid - (hum["start"] + x["s"])) > 1e-4)  # noqa: E731
            r["hors_grille_apres_humaniser"] = off(hum["notes"])
            if phone:
                click(page, "[data-nova-roll=quantifier]", phone)
            else:
                page.keyboard.press("q")
            page.wait_for_timeout(250)
            q = page.evaluate(STATE_NOTES, tid)
            r["hors_grille_apres_quantifier"] = off(q["notes"])
            ok(f"{tag} : humaniser décale, quantifier (1/16, 100 %) remet tout sur la grille",
               r["hors_grille_apres_humaniser"] > 0 and r["hors_grille_apres_quantifier"] == 0, [r["hors_grille_apres_humaniser"], r["hors_grille_apres_quantifier"]])

            # 7. Dupliquer à la suite (Ctrl+B / « 2x ») ; pincer pour zoomer
            nq = len(q["notes"])
            if phone:
                click(page, "[data-nova-roll=tout]", phone)
                click(page, "[data-nova-roll=dupliquer]", phone)
            else:
                page.keyboard.press("Control+a"); page.keyboard.press("Control+b")
            page.wait_for_timeout(250)
            d = page.evaluate(STATE_NOTES, tid)
            r["dupliquer"] = [nq, len(d["notes"]), d["duration"]]
            ok(f"{tag} : dupliquer à la suite double les notes (clip allongé)", len(d["notes"]) == 2 * nq and d["duration"] >= 8 * BEAT - 1e-6, r["dupliquer"])
            if phone:
                g = roll.geom()
                z = page.evaluate(PINCH, [g["left"] + g["w"] / 2, g["top"] + g["h"] / 2, 80, 200])
                r["pincer_zoom"] = z
                ok(f"{tag} : pincer à deux doigts zoome", z[1] > z[0] * 1.5, z)
            shot(page, f"{tag}_05_complet")

            # 8. Écouter, exporter (.mid)
            click(page, "[data-nova-pianoroll] button[aria-label='Lecture']", phone)
            page.wait_for_timeout(1600)
            r["ecoute"] = page.evaluate("""async (tid) => { const { audioEngine: E } = await window.__novaAppModule('/engine/AudioEngine.ts');
              const s = E.tracksDSP.get(tid)?.synth; return { t: Math.round(E.getCurrentTime() * 100) / 100, voix: s && s.activeVoiceCount ? s.activeVoiceCount() : -1 }; }""", tid)
            click(page, "[data-nova-pianoroll] button[aria-label='Pause']", phone)
            ok(f"{tag} : ▶ la lecture avance et le synthé joue", r["ecoute"]["t"] > 0.5, r["ecoute"])
            with page.expect_download(timeout=10000) as dl:
                click(page, "[data-nova-roll=mid-export]", phone)
            path = dl.value.path()
            data = Path(path).read_bytes() if path else b""
            r["export_mid"] = {"nom": dl.value.suggested_filename, "octets": len(data), "entete": data[:4].decode("latin-1")}
            ok(f"{tag} : export du clip en .mid", data[:4] == b"MThd" and len(data) > 100, r["export_mid"])

            # 9. Audit : cibles, débordement, contrastes, anglais
            r["cibles"] = page.evaluate(TARGETS)
            ok(f"{tag} : aucun défilement horizontal", not r["cibles"]["defilement_horizontal"], r["cibles"])
            if phone:
                ok(f"{tag} : cibles des barres ≥ 44 px au doigt", r["cibles"]["n_petites"] == 0, r["cibles"]["petites"])
            a = page.evaluate(AUDIT_JS, {"touch": phone, "root": "[data-nova-pianoroll]"})
            r["audit"] = {k: v for k, v in a.items() if v and k in ("contraste", "anglais")}
            ok(f"{tag} : contrastes et mots anglais (ux_audit)", not a.get("contraste") and not a.get("anglais"), r["audit"])
            # Menu de la grille (ouvert pour la capture)
            click(page, "[data-nova-roll=grille]", phone)
            shot(page, f"{tag}_06_menu_grille")
            r["menu_grille"] = page.evaluate(TARGETS)
            if phone:
                ok(f"{tag} : menu de la grille ≥ 44 px au doigt", r["menu_grille"]["n_petites"] == 0, r["menu_grille"]["petites"])
            vs = page.viewport_size
            page.mouse.click(vs["width"] // 2, vs["height"] - 4); page.wait_for_timeout(200)

            if tag == "pc_dark":
                r["audio"] = page.evaluate(AUDIO_JS)
                au = r["audio"]
                # Reese drill joue une octave sous la note (La0 = 55 Hz → 27,5 Hz) : on vérifie l'intervalle, une quinte (La → Mi).
                ratio = au["f_apres_glisse_Hz"] / au["f_avant_glisse_Hz"] if au["f_avant_glisse_Hz"] else 0
                au["rapport_mesure"] = round(ratio, 4)
                ok("pc_dark : le glissé monte d'une quinte (La0 → Mi1) dans l'export, sans glissé la note reste en place",
                   abs(ratio - 1.4983) < 0.03 and abs(au["f_sans_glisse_Hz"] - au["f_avant_glisse_Hz"]) < 1, au)
                ok("pc_dark : pas de nouvelle attaque au glissé", au["crete_pendant"] <= au["crete_avant"] * 1.15, au)
                lv = au["lecture_vs_export_avec_glisse"]
                ok("pc_dark : lecture réelle ≈ export avec glissés (≤ -30 dB)", lv["ecart_dB"] is not None and lv["ecart_dB"] <= -30, au)
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
    sys.stdout.reconfigure(encoding="utf-8")
    make_project()
    res = {}
    only = [a for a in sys.argv[1:] if not a.startswith("--")]
    for vp, theme in RUNS:
        if only and f"{vp}_{theme}" not in only:
            continue
        run(vp, theme, res)
    res["KO"] = KO
    (OUT / "pianoroll_pro.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{'KO' if KO else 'OK'} : {len(KO)} échec(s)")
    sys.exit(1 if KO else 0)


if __name__ == "__main__":
    main()
