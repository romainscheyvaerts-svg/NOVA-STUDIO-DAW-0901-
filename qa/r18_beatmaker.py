"""Scénario R18 / R20 (beatmaker FL : kits, sampler, pas, chop, instruments) dans un Chrome headless.

PC (thème sombre, puis clair pour les captures) :
  1. kit perso : batterie Trap réglée → « Enregistrer le kit » (interface) → nouveau
     projet (page rechargée) → batterie Boom Bap → kit chargé (interface) : sons et
     réglages identiques (empreinte des pads) ;
  2. pas : vélocité, pan et hauteur par pas (Graph Editor de FL) rendus à l'export et
     mesurés (niveau en dB, balance G/D en dB, fréquence) ;
  3. sampler : un son de hauteur connue (300 Hz) → note racine détectée → notes
     jouées à l'export mesurées à ±5 cents ;
  4. chop : une boucle de 8 coups → « Découper (chop)… » du menu du clip (interface),
     vers les notes d'un sampler → le clip MIDI rejoue l'original (null test) ;
  5. piano multi-échantillons (R20) : bonnes notes (cents) et couches de vélocité.
Tablette et téléphone : écran du sampler, boîte à rythmes (graphe), découpe.
Aucune erreur de page.

Usage : python qa/r18_beatmaker.py [pc|tab|tel|tout]   (NOVA_URL=http://127.0.0.1:3459/)
"""
import json, os, sys, time
from pathlib import Path
sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3459/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-r18")
from qalib import launch, new_page, shot, overflow_report, BASE, OUT  # noqa: E402
from scenarios import close_welcome, wait_text_gone  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

WHICH = sys.argv[1] if len(sys.argv) > 1 else "tout"
RES = {"etapes": {}, "mesures": {}}


def ok(k, v, note=None):
    RES["etapes"][k] = {"ok": bool(v), **({"detail": note} if note is not None else {})}
    print(("OK  " if v else "KO  ") + k, "" if note is None else json.dumps(note, ensure_ascii=False)[:700], flush=True)


def open_studio(pg):
    pg.goto(BASE, wait_until="domcontentloaded")
    pg.get_by_text("Mélodies", exact=False).first.click(timeout=60000)
    pg.wait_for_timeout(1500)
    pg.get_by_text("Neon Storm", exact=False).first.click()
    pg.wait_for_timeout(1500)
    close_welcome(pg)
    wait_text_gone(pg, "Chargement", 90)
    pg.wait_for_timeout(1500)
    close_welcome(pg)
    close_drums(pg)
    pg.wait_for_function("() => !!window.__novaMidi && !!window.__novaSampler", timeout=30000)
    pg.evaluate("async () => { const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts'); await audioEngine.init?.(); await audioEngine.resume?.(); }")


def close_drums(pg):
    drums = pg.locator("[aria-labelledby='drums-title']")
    if drums.count():
        cl = drums.locator("button[aria-label='Fermer la batterie']")
        if cl.count(): cl.first.click()
        else: pg.keyboard.press("Escape")
        pg.wait_for_timeout(500)


def open_drums(pg):
    if not pg.locator("[aria-labelledby='drums-title']").count():
        pg.locator("button[title^='Boîte à rythmes']").first.click()
        pg.wait_for_timeout(800)


# Outils de mesure communs (page) : rendu d'export, niveaux, hauteur.
MEASURE = r"""
window.__qa = {
  SR: 48000,
  async render(tracks, dur, start = 0) {
    const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts');
    const one = tracks.map(t => ({ ...t, outputTrackId: undefined, volume: 1, pan: 0, isMuted: false, isSolo: false, sends: [], plugins: [] }));
    return audioEngine.renderProject(one, dur, start, 48000);
  },
  rms(buf, a, b, ch) { const SR = buf.sampleRate; let s = 0, n = 0; const xs = ch === undefined ? [...Array(buf.numberOfChannels).keys()] : [ch];
    for (const c of xs) { const x = buf.getChannelData(c); for (let i = Math.floor(a * SR); i < Math.min(x.length, Math.floor(b * SR)); i++) { s += x[i] * x[i]; n++; } } return Math.sqrt(s / Math.max(1, n)); },
  db(v) { return Math.round(20 * Math.log10(Math.max(1e-12, v)) * 100) / 100; },
  mono(buf, a, b) { const SR = buf.sampleRate; const i0 = Math.floor(a * SR), i1 = Math.min(buf.length, Math.floor(b * SR)); const o = new Float32Array(Math.max(0, i1 - i0));
    for (let c = 0; c < buf.numberOfChannels; c++) { const x = buf.getChannelData(c); for (let i = i0; i < i1; i++) o[i - i0] += x[i] / buf.numberOfChannels; } return o; },
  // Hauteur autour d'une fréquence attendue (±1 demi-ton) : autocorrélation normalisée + interpolation parabolique.
  pitch(x, sr, expect) {
    const lo = Math.floor(sr / (expect * 1.06)), hi = Math.ceil(sr / (expect / 1.06));
    const N = x.length - hi - 1; if (N < 256) return null;
    const ac = (L) => { let s = 0, e1 = 0, e2 = 0; for (let i = 0; i < N; i++) { s += x[i] * x[i + L]; e1 += x[i] * x[i]; e2 += x[i + L] * x[i + L]; } return s / Math.sqrt(e1 * e2 + 1e-20); };
    let best = lo, bv = -2; const vals = {};
    for (let L = lo - 1; L <= hi + 1; L++) { vals[L] = ac(L); if (L >= lo && L <= hi && vals[L] > bv) { bv = vals[L]; best = L; } }
    const a = vals[best - 1], b = vals[best], c = vals[best + 1];
    const d = (a - c) / (2 * (a - 2 * b + c) || 1);
    return sr / (best + (isFinite(d) ? d : 0));
  },
  cents(f, target) { return Math.round(1200 * Math.log2(f / target) * 100) / 100; },
  centroid(x, sr) { // centre de gravité spectral approché (DFT sur 4096 points)
    const n = 4096, off = 0; let num = 0, den = 0;
    for (let k = 1; k < n / 2; k += 2) { let re = 0, im = 0; for (let i = 0; i < n; i++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); const v = (x[off + i] || 0) * w; re += v * Math.cos(2 * Math.PI * k * i / n); im -= v * Math.sin(2 * Math.PI * k * i / n); }
      const m = Math.hypot(re, im); num += m * k * sr / n; den += m; }
    return Math.round(num / Math.max(1e-9, den));
  },
};
"""


def setup_measure(pg):
    pg.evaluate("(src) => { eval(src); return true; }", MEASURE)


# ---------------------------------------------------------------- 1. Kits perso
def step_kits(pg):
    open_drums(pg)
    pg.get_by_role("button", name="🔥 Trap").first.click()
    pg.wait_for_timeout(1500)
    # Réglages propres au kit : accordage et longueur du kick, rangée hi-hat en 1/32.
    pg.evaluate(r"""async () => {
      const P = await window.__novaAppModule('/utils/drumPatterns.ts');
      const dm = window.__novaMidi.rawTracks().find(t => t.id === 'track-drums').drumMachine;
      let d = { ...dm, rows: dm.rows.map(r => r.id === 'kick' ? { ...r, tune: -3, decay: 0.55, mix: { comp: 0.35, eqLow: 2 } } : r) };
      d = P.setRowRate(d, d.rows.findIndex(r => r.id === 'hatc'), '32');
      window.dispatchEvent(new CustomEvent('nova:apply-drum-machine', { detail: { dm: d } }));
    }""")
    pg.wait_for_timeout(800)
    sig_before = pg.evaluate("async () => { const K = await window.__novaAppModule('/utils/userKits.ts'); return K.kitSignature(window.__novaMidi.rawTracks().find(t => t.id === 'track-drums').drumMachine); }")
    pg.locator("[data-testid='kit-save']").first.click()
    pg.locator("[data-testid='kit-name']").fill("Trap QA R18")
    shot(pg, "r18_pc_01_kit_nom")
    pg.locator("[data-testid='kit-name-ok']").click()
    pg.wait_for_timeout(1500)
    shot(pg, "r18_pc_02_kit_enregistre")
    ok("kit enregistré (interface)", pg.locator("[data-testid='kit-load-Trap QA R18']").count() == 1)

    # Autre projet : page rechargée (IndexedDB gardé), autre style de batterie.
    open_studio(pg)
    setup_measure(pg)
    open_drums(pg)
    pg.get_by_role("button", name="🎤 Boom Bap").first.click()
    pg.wait_for_timeout(1500)
    sig_other = pg.evaluate("async () => { const K = await window.__novaAppModule('/utils/userKits.ts'); return K.kitSignature(window.__novaMidi.rawTracks().find(t => t.id === 'track-drums').drumMachine); }")
    pg.locator("[data-testid='kit-load-Trap QA R18']").first.click()
    pg.wait_for_timeout(1500)
    sig_after = pg.evaluate("async () => { const K = await window.__novaAppModule('/utils/userKits.ts'); return K.kitSignature(window.__novaMidi.rawTracks().find(t => t.id === 'track-drums').drumMachine); }")
    shot(pg, "r18_pc_03_kit_charge_autre_projet")
    ok("kit chargé dans un autre projet : sons et réglages identiques", sig_after == sig_before and sig_other != sig_before,
       {"pads": len(json.loads(sig_after)), "identique": sig_after == sig_before, "projet_avant_different": sig_other != sig_before})


# ---------------------------------------------------------------- 2. Pas : vélocité, pan, hauteur
def step_steps(pg):
    m = pg.evaluate(r"""async () => {
      const P = await window.__novaAppModule('/utils/drumPatterns.ts');
      const PB = await window.__novaAppModule('/utils/padBuffers.ts');
      const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts');
      const ctx = audioEngine.ctx, SR = ctx.sampleRate;
      // Son de test : 440 Hz, 0,15 s, fondus de 5 ms.
      const b = ctx.createBuffer(1, Math.round(SR * 0.15), SR); const x = b.getChannelData(0);
      for (let i = 0; i < x.length; i++) { const t = i / SR; const env = Math.min(1, t / 0.005, (0.15 - t) / 0.005); x[i] = 0.5 * env * Math.sin(2 * Math.PI * 440 * t); }
      const s = PB.registerPadSample(b, 'Sinus 440');
      let dm = window.__novaMidi.rawTracks().find(t => t.id === 'track-drums').drumMachine;
      dm = { ...dm, swing: 0, groove: undefined, samples: { ...(dm.samples || {}), [s.id]: s.info },
        rows: dm.rows.map((r, i) => i === 0
          ? { ...r, sound: 'user:' + s.id, rate: undefined, len: undefined, swing: undefined, tune: 0, decay: 1, volume: 1, pan: 0, mix: {}, choke: undefined, muted: false, solo: false,
              steps: [127,0,0,0, 64,0,0,0, 127,0,0,0, 100,0,0,0], ratchet: new Array(16).fill(1), stepPan: undefined, stepPitch: undefined }
          : { ...r, steps: r.steps.map(() => 0), ratchet: r.ratchet.map(() => 1) }) };
      dm = { ...dm, patterns: undefined, song: undefined, activePattern: undefined, fill: undefined, bars: 1 };
      dm = P.setStepParam(dm, 0, 4, 'pan', -0.6);
      dm = P.setStepParam(dm, 0, 8, 'pitch', 7);
      dm = P.setStepParam(dm, 0, 12, 'pan', 0.6);
      dm = P.setStepParam(dm, 0, 12, 'pitch', -5);
      window.dispatchEvent(new CustomEvent('nova:apply-drum-machine', { detail: { dm } }));
      await new Promise(r => setTimeout(r, 1500));
      const tr = window.__novaMidi.rawTracks().find(t => t.id === 'track-drums');
      const bpm = window.__novaMidi.bpm(); const step = 60 / bpm / 4;
      const buf = await window.__qa.render([tr], step * 16 + 0.3, 0);
      const Q = window.__qa;
      const hit = (k) => { const a = k * step + 0.02, z = k * step + 0.13;
        const L = Q.rms(buf, a, z, 0), R = Q.rms(buf, a, z, 1);
        const f = Q.pitch(Q.mono(buf, a, z), buf.sampleRate, 440 * Math.pow(2, ((k === 8 ? 7 : k === 12 ? -5 : 0)) / 12));
        return { L: Q.db(L), R: Q.db(R), niveau: Q.db(Math.sqrt((L * L + R * R) / 2)), balance_RL_dB: Math.round((Q.db(R) - Q.db(L)) * 100) / 100, f: Math.round(f * 100) / 100 };
      };
      return { bpm, h0: hit(0), h4: hit(4), h8: hit(8), h12: hit(12) };
    }""")
    RES["mesures"]["pas"] = m
    lvl = round(m["h4"]["niveau"] - m["h0"]["niveau"] + (20 * __import__("math").log10(1 / 1)), 2)
    # Le pan à puissance constante change aussi le niveau moyen : on compare la vélocité en puissance totale.
    import math
    p0 = 10 ** (m["h0"]["L"] / 10) + 10 ** (m["h0"]["R"] / 10)
    p4 = 10 ** (m["h4"]["L"] / 10) + 10 ** (m["h4"]["R"] / 10)
    vel_db = round(10 * math.log10(p4 / p0), 2)
    exp_vel = round(20 * math.log10(64 / 127), 2)
    ok("vélocité par pas mesurée (64/127 → −5,95 dB)", abs(vel_db - exp_vel) < 0.2, {"mesure_dB": vel_db, "attendu_dB": exp_vel})
    exp_pan = round(20 * math.log10(math.tan(0.2 * math.pi / 2)), 2)
    ok("pan par pas mesuré (−0,6 → droite/gauche −9,77 dB ; +0,6 → +9,77 dB)",
       abs(m["h4"]["balance_RL_dB"] - exp_pan) < 0.3 and abs(m["h12"]["balance_RL_dB"] + exp_pan) < 0.3 and abs(m["h0"]["balance_RL_dB"]) < 0.1,
       {"pas_1": m["h0"]["balance_RL_dB"], "pas_5": m["h4"]["balance_RL_dB"], "pas_13": m["h12"]["balance_RL_dB"], "attendu": exp_pan})
    f7, f5 = 440 * 2 ** (7 / 12), 440 * 2 ** (-5 / 12)
    c7 = 1200 * math.log2(m["h8"]["f"] / f7); c5 = 1200 * math.log2(m["h12"]["f"] / f5); c0 = 1200 * math.log2(m["h0"]["f"] / 440)
    ok("hauteur par pas mesurée (+7 dt → 659,26 Hz ; −5 dt → 329,63 Hz)", abs(c7) < 5 and abs(c5) < 5 and abs(c0) < 5,
       {"pas_1_Hz": m["h0"]["f"], "pas_9_Hz": m["h8"]["f"], "pas_13_Hz": m["h12"]["f"], "ecarts_cents": [round(c0, 2), round(c7, 2), round(c5, 2)]})
    # Capture : graphe (pan) sous la grille.
    open_drums(pg)
    pg.wait_for_timeout(500)
    if pg.locator("[data-testid='graph-pan']").count():
        pg.locator("[data-testid='graph-pan']").first.click()
    pg.wait_for_timeout(300)
    shot(pg, "r18_pc_04_graphe_pan")
    if pg.locator("[data-testid='graph-pitch']").count():
        pg.locator("[data-testid='graph-pitch']").first.click()
    pg.wait_for_timeout(300)
    shot(pg, "r18_pc_05_graphe_hauteur")


# ---------------------------------------------------------------- 3. Sampler : note racine et justesse
def step_sampler(pg):
    m = pg.evaluate(r"""async () => {
      const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts');
      const ctx = audioEngine.ctx, SR = ctx.sampleRate;
      const F0 = 300; // D4 + 37,6 cents
      const b = ctx.createBuffer(1, Math.round(SR * 2), SR); const x = b.getChannelData(0);
      for (let i = 0; i < x.length; i++) { const t = i / SR; x[i] = 0.4 * Math.exp(-t * 0.6) * Math.min(1, t / 0.004) * (Math.sin(2 * Math.PI * F0 * t) + 0.5 * Math.sin(4 * Math.PI * F0 * t) + 0.25 * Math.sin(6 * Math.PI * F0 * t)); }
      const S = window.__novaSampler;
      const M = await window.__novaAppModule('/utils/melodicSampler.ts');
      const snd = S.registerSound(b, 'Ton 300 Hz');
      const settings = M.normalizeSampler({ ...M.DEFAULT_SAMPLER, ...snd, release: 0.05 });
      const notes = [57, 62, 69, 74, 50].map((p, i) => ({ id: 'q' + i, pitch: p, start: i * 1.0, duration: 0.8, velocity: 0.9 }));
      const { trackId } = S.createTrack({ name: 'QA Sampler', settings, notes, start: 0, duration: 6 });
      await new Promise(r => setTimeout(r, 1200));
      const tr = window.__novaMidi.rawTracks().find(t => t.id === trackId);
      const buf = await window.__qa.render([tr], 5.2, 0);
      const Q = window.__qa;
      const res = notes.map(n => { const target = 440 * Math.pow(2, (n.pitch - 69) / 12); const f = Q.pitch(Q.mono(buf, n.start + 0.1, n.start + 0.6), buf.sampleRate, target); return { note: M.noteName(n.pitch), cible_Hz: Math.round(target * 100) / 100, mesure_Hz: Math.round(f * 100) / 100, ecart_cents: Q.cents(f, target) }; });
      return { trackId, racine: M.noteName(tr.melodicSampler.rootKey), rootKey: tr.melodicSampler.rootKey, accord_fin_cents: tr.melodicSampler.fineTune, auto: !!tr.melodicSampler.rootAuto, notes: res };
    }""")
    RES["mesures"]["sampler"] = m
    import math
    exp_fine = -round(1200 * math.log2(300 / (440 * 2 ** ((62 - 69) / 12))), 1)
    ok("note racine détectée (300 Hz → D4, accord fin −37,6 cents)", m["rootKey"] == 62 and abs(m["accord_fin_cents"] - exp_fine) < 2 and m["auto"],
       {"racine": m["racine"], "accord_fin": m["accord_fin_cents"], "attendu": exp_fine})
    worst = max(abs(n["ecart_cents"]) for n in m["notes"])
    ok("notes du sampler à la bonne hauteur à l'export (±5 cents)", worst <= 5, {"pire_cents": worst, "notes": m["notes"]})
    # Écran du sampler (interface).
    pg.evaluate("async (id) => { const S = await window.__novaAppModule('/utils/samplerPanelStore.ts'); S.openSamplerPanel(id); }", m["trackId"])
    pg.wait_for_timeout(1200)
    shot(pg, "r18_pc_06_sampler")
    ok("écran du sampler ouvert, racine affichée", pg.locator("[data-testid='sampler-root']").count() == 1 and "D4" in pg.locator("[data-testid='sampler-root']").inner_text())
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(400)


# ---------------------------------------------------------------- 4. Chop : 8 tranches, null test
def step_chop(pg):
    info = pg.evaluate(r"""async () => {
      const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts');
      const R = await window.__novaAppModule('/utils/audioBufferRegistry.ts');
      const ctx = audioEngine.ctx, SR = ctx.sampleRate;
      const bpm = window.__novaMidi.bpm();
      const dur = 2 * 60 / bpm * 4 / 2; // 2 temps × 2 = une mesure : 8 croches
      const b = ctx.createBuffer(2, Math.round(SR * dur), SR);
      let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
      const hitLen = dur / 8;
      for (let c = 0; c < 2; c++) { const x = b.getChannelData(c); seed = 7 + c;
        for (let i = 0; i < x.length; i++) { const t = i / SR; const k = Math.floor(t / hitLen); const u = t - k * hitLen;
          const f = [110, 220, 165, 330, 110, 247, 196, 392][k];
          x[i] = 0.6 * Math.exp(-u * 18) * Math.sin(2 * Math.PI * f * u) + 0.25 * Math.exp(-u * 60) * rnd() + 0.02 * Math.sin(2 * Math.PI * 55 * t); } }
      const id = R.audioBufferRegistry.register(b, 'qa-boucle-r18');
      const bar = 240 / bpm;
      return { ...window.__novaSampler.addAudioClip(id, bar * 2, 'Boucle QA'), start: bar * 2, dur };
    }""")
    pg.wait_for_timeout(1200)
    # Menu du clip → « Découper (chop)… » : passe par la même demande que le menu.
    clip_el = pg.locator(f"[data-clip-id='{info['clipId']}']")
    used_menu = False
    if clip_el.count():
        clip_el.first.click(button="right")
        pg.wait_for_timeout(500)
        item = pg.get_by_text("Découper (chop)…", exact=True)
        if item.count():
            item.first.click(); used_menu = True
    if not used_menu:
        pg.evaluate("(t) => window.__novaSampler.request({ kind: 'chop-clip', trackId: t.trackId, clipId: t.clipId })", info)
    pg.wait_for_selector("[data-testid='chop-clip-dialog']", timeout=15000)
    pg.wait_for_timeout(800)
    n = pg.locator("[data-testid='chop-count']").inner_text()
    pg.locator("[data-testid='chop-dest-notes']").click()
    shot(pg, "r18_pc_07_chop")
    ok("menu du clip → découpe : 8 tranches sur les attaques", n.startswith("8 "), {"affiche": n, "menu_du_clip": used_menu})
    before = {t["id"] for t in pg.evaluate("() => window.__novaMidi.tracks()")}
    pg.locator("[data-testid='chop-apply']").click()
    pg.wait_for_timeout(2000)
    m = pg.evaluate(r"""async ({ info, before }) => {
      const all = window.__novaMidi.rawTracks();
      const sam = all.find(t => !before.includes(t.id) && t.melodicSampler);
      const orig = all.find(t => t.id === info.trackId);
      const Q = window.__qa;
      const origOn = { ...orig, clips: orig.clips.map(c => ({ ...c, isMuted: false })) };
      const end = info.start + info.dur + 0.3;
      const a = await Q.render([origOn], end, 0);
      const b = await Q.render([sam], end, 0);
      let e = 0, s = 0, peak = 0;
      for (let c = 0; c < 2; c++) { const x = a.getChannelData(c), y = b.getChannelData(c); for (let i = 0; i < x.length; i++) { const d = x[i] - y[i]; e += d * d; s += x[i] * x[i]; peak = Math.max(peak, Math.abs(d)); } }
      return { tranches: sam.melodicSampler.slices.length, notes: sam.clips[0].notes.length, origine_coupee: !!orig.clips[0].isMuted,
        residu_dB: Q.db(Math.sqrt(e / Math.max(1e-20, s))), pic_residu_dBFS: Q.db(peak), niveau_original_dBFS: Q.db(Math.sqrt(s / (a.length * 2))) };
    }""", {"info": info, "before": list(before)})
    RES["mesures"]["chop"] = m
    ok("chop en 8 tranches : le clip MIDI rejoue l'original (null test < −60 dB)", m["tranches"] == 8 and m["notes"] == 8 and m["residu_dB"] < -60, m)


# ---------------------------------------------------------------- 5. Piano multi-échantillons
def step_piano(pg):
    m = pg.evaluate(r"""async () => {
      const S = window.__novaSampler;
      const M = await window.__novaAppModule('/utils/melodicSampler.ts');
      const I = await window.__novaAppModule('/utils/instrumentPresets.ts');
      const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts');
      const settings = M.normalizeSampler({ ...M.DEFAULT_SAMPLER, ...I.settingsForInstrument('piano') });
      const plan = [[36, 0.8], [48, 0.8], [60, 0.8], [69, 0.8], [76, 0.8], [84, 0.8], [96, 0.8], [60, 0.15], [60, 0.55], [60, 1.0]];
      const notes = plan.map(([p, v], i) => ({ id: 'p' + i, pitch: p, start: i * 1.5, duration: 1.2, velocity: v }));
      const { trackId } = S.createTrack({ name: 'QA Piano', settings, notes, start: 0, duration: 16 });
      for (let k = 0; k < 100; k++) { await new Promise(r => setTimeout(r, 200)); if (audioEngine.getMelodicSamplerNode(trackId)?.hasSound()) break; }
      const tr = window.__novaMidi.rawTracks().find(t => t.id === trackId);
      const t0 = performance.now();
      const buf = await window.__qa.render([tr], 15.2, 0);
      const ms = Math.round(performance.now() - t0);
      const man = await I.loadInstrumentManifest('piano');
      const Q = window.__qa;
      const res = notes.map((n, i) => {
        const target = 440 * Math.pow(2, (n.pitch - 69) / 12);
        const x = Q.mono(buf, n.start + 0.12, n.start + 0.72);
        const f = Q.pitch(x, buf.sampleRate, target);
        const z = M.pickZone(man.zones, n.pitch, n.velocity * 127, 0);
        return { note: M.noteName(n.pitch), velocite: n.velocity, zone: z && z.file, cible_Hz: Math.round(target * 100) / 100, mesure_Hz: Math.round(f * 100) / 100,
          ecart_cents: Q.cents(f, target), niveau_dB: Q.db(Q.rms(buf, n.start + 0.01, n.start + 0.4)), brillance_Hz: Q.centroid(Q.mono(buf, n.start + 0.01, n.start + 0.2), buf.sampleRate) };
      });
      return { trackId, rendu_ms: ms, zones: man.zones.length, notes: res };
    }""")
    RES["mesures"]["piano"] = m
    pitch_notes = m["notes"][:7]
    worst = max(abs(n["ecart_cents"]) for n in pitch_notes)
    ok("piano : bonnes notes sur 5 octaves (±5 cents)", worst <= 5, {"pire_cents": worst, "notes": [(n["note"], n["mesure_Hz"], n["ecart_cents"], n["zone"]) for n in pitch_notes]})
    layers = m["notes"][7:]
    files = [n["zone"] for n in layers]
    lv = [n["niveau_dB"] for n in layers]
    br = [n["brillance_Hz"] for n in layers]
    ok("piano : 3 couches de vélocité (pp / mf / ff), plus fort et plus brillant", len(set(files)) == 3 and lv[0] < lv[1] < lv[2] and br[0] < br[2],
       {"zones": files, "niveaux_dB": lv, "brillance_Hz": br})
    # Sélecteur d'instruments (barre du piano roll).
    pg.evaluate("(id) => { const t = window.__novaMidi.rawTracks().find(x => x.id === id); window.dispatchEvent(new CustomEvent('nova:open-piano-roll', { detail: { trackId: id, clipId: t.clips[0].id } })); }", m["trackId"])
    pg.wait_for_timeout(1500)
    pk = pg.locator("[data-vst-instrument-picker] > button").first
    if pk.count():
        pk.click(); pg.wait_for_timeout(600)
        shot(pg, "r18_pc_08_selecteur_instruments")
        ok("instruments NOVA dans le sélecteur d'instruments", pg.locator("[data-testid='picker-nova-instruments'] [data-nova-instrument]").count() == 6)
        pg.keyboard.press("Escape"); pg.mouse.click(5, 450); pg.wait_for_timeout(300)
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(500)


def run_pc(b):
    ctx, pg = new_page(b, "pc")
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:300]))
    open_studio(pg)
    setup_measure(pg)
    for name, fn in (("kits", step_kits), ("pas", step_steps), ("sampler", step_sampler), ("chop", step_chop), ("piano", step_piano)):
        try:
            fn(pg)
        except Exception as e:  # une étape en échec n'empêche pas les suivantes
            ok(f"étape {name} sans exception", False, str(e)[:500])
            try: shot(pg, f"r18_pc_erreur_{name}")
            except Exception: pass
    shot(pg, "r18_pc_09_session")
    ok("PC : aucune erreur de page", not errs, errs[:5])
    ctx.close()
    # Thème clair : sampler et batterie.
    ctx, pg = new_page(b, "pc")
    ctx.add_init_script("try { localStorage.setItem('nova_theme', 'light'); } catch (e) {}")
    open_studio(pg)
    pg.evaluate("() => window.__novaSampler.request({ kind: 'new', instrument: 'rhodes' })")
    pg.wait_for_timeout(2500)
    shot(pg, "r18_pc_10_sampler_clair")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    open_drums(pg)
    pg.get_by_role("button", name="🔪 Drill").first.click()
    pg.wait_for_timeout(1200)
    shot(pg, "r18_pc_11_batterie_clair")
    ctx.close()


def run_small(b, vp):
    ctx, pg = new_page(b, vp)
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:300]))
    open_studio(pg)
    setup_measure(pg)
    pg.evaluate("() => window.__novaSampler.request({ kind: 'new', instrument: 'piano' })")
    pg.wait_for_timeout(3000)
    shot(pg, f"r18_{vp}_01_sampler")
    ok(f"{vp} : écran du sampler (instruments, micro, clavier)", pg.locator("[data-testid='sampler-panel']").count() == 1 and pg.locator("[data-testid='sampler-rec']").count() == 1)
    # Débordement réel : la page défile en largeur, ou un élément sort de l'écran hors d'une
    # barre qui défile exprès (barre de création des pistes : overflow-x auto, déjà ainsi avant R18).
    bad = pg.evaluate(r"""() => {
      const vw = window.innerWidth, out = [];
      if (document.documentElement.scrollWidth > vw + 1) out.push({ kind: 'page-hscroll', w: document.documentElement.scrollWidth });
      const inScroller = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; };
      for (const el of document.querySelectorAll('[data-testid=sampler-panel] *')) {
        const r = el.getBoundingClientRect(); if (r.width < 4 || !el.getClientRects().length) continue;
        if (r.right > vw + 2 && !inScroller(el)) out.push({ kind: 'off-right', t: (el.innerText || el.tagName).slice(0, 40) });
      }
      return out.slice(0, 10);
    }""")
    ok(f"{vp} : sampler sans débordement horizontal", not bad, bad[:5])
    # Micro dans le sampler (faux micro de Chrome) : 1,5 s puis stop.
    try:
        pg.locator("[data-testid='sampler-rec']").click()
        pg.wait_for_timeout(1800)
        shot(pg, f"r18_{vp}_02_sampler_micro")
        pg.locator("[data-testid='sampler-rec-stop']").click()
        pg.wait_for_timeout(1500)
        src = pg.locator("[data-testid='sampler-source']").inner_text()
        ok(f"{vp} : son enregistré au micro dans le sampler", "Micro" in src, src)
        shot(pg, f"r18_{vp}_03_sampler_son_micro")
    except Exception as e:
        ok(f"{vp} : micro dans le sampler", False, str(e)[:300])
    pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
    close_btn = pg.locator("button[aria-label='Fermer le sampler']")
    if close_btn.count(): close_btn.first.click(); pg.wait_for_timeout(300)
    try:
        open_drums(pg)
        pg.get_by_role("button", name="🔥 Trap").first.click()
        pg.wait_for_timeout(1500)
        shot(pg, f"r18_{vp}_04_batterie_kits_graphe")
        ok(f"{vp} : kits et graphe dans la batterie", pg.locator("[data-testid='kit-bar']").count() == 1 and pg.locator("[data-testid='step-graph']").count() == 1)
    except Exception as e:
        ok(f"{vp} : batterie", False, str(e)[:300])
    ok(f"{vp} : aucune erreur de page", not errs, errs[:5])
    ctx.close()


def main():
    with sync_playwright() as p:
        b = launch(p)
        try:
            if WHICH in ("pc", "tout"): run_pc(b)
            if WHICH in ("tab", "tout"): run_small(b, "tab")
            if WHICH in ("tel", "tout"): run_small(b, "tel")
        finally:
            b.close()
    out = Path(OUT) / f"r18_resultats_{WHICH}.json"
    out.write_text(json.dumps(RES, ensure_ascii=False, indent=1), encoding="utf-8")
    kos = [k for k, v in RES["etapes"].items() if not v["ok"]]
    print(f"\n{len(RES['etapes']) - len(kos)}/{len(RES['etapes'])} OK", "" if not kos else f"— KO : {kos}")


if __name__ == "__main__":
    main()
