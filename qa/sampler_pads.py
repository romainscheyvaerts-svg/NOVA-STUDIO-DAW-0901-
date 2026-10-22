"""Sampler des pads de la batterie (22/10/2026) : interface au doigt et à la souris, métrologie sur le rendu d'export.

Headless (aucune fenêtre), 100 % hors production (qalib importe qa_hors_prod).

Chaque valeur affichée doit être la valeur mesurée. Les mesures passent par le RENDU D'EXPORT du moteur
(audioEngine.renderProject, contexte hors ligne) qui exécute le même code que la lecture (engine/DrumRackNode.ts) :
  - gain +6 dB = ×1,995 ; vélocité 64/127 → −5,95 dB ; vélocité → volume 0 % : 0 dB ;
  - enveloppe : attaque 10 ms (moitié à 5 ms, maximum à 10 ms), maintien 20 ms + décroissance 100 ms vers
    sustain 25 % (atteint à 130 ms), relâchement 50 ms d'une note tenue de 2 pas (fin à 300 ms) ;
  - filtre : passe-bas / passe-haut 12 et 24 dB/oct à 1 kHz = −3,01 dB à 1 kHz, passe-bande = 0 dB au centre ;
    enveloppe de filtre (brillant au début, sombre ensuite) ;
  - hauteur : +12 dt = octave exacte (880 Hz), +50 centièmes, enveloppe de hauteur (retour à 440 Hz),
    glisse depuis le pas précédent, durée gardée (étirement) ;
  - normaliser (crête 0 dBFS), polarité, 4 bits, échantillonnage ÷4, boucle tenue, mono / poly, couches de
    vélocité et alternance ;
  - deux rendus identiques au bit près ; un pad sans sampler sonne exactement comme avant (null test).
Interface (PC 1600, sombre) : double-clic sur un pad → éditeur ; onglets Sample · Enveloppes · Filtre · Hauteur ·
Modulation ; valeur affichée = état ; point de l'enveloppe glissé ; poignée de début glissée ; presets ; Échap.
Tablette 1024 (clair) et téléphone 390 (sombre / clair) : onglets au doigt, cibles ≥ 44 px, rien de coupé ni recouvert.

NOVA_URL=http://127.0.0.1:3543/ PYTHONIOENCODING=utf-8 python qa/sampler_pads.py
Sorties : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-drumseq) : sampler_pads.json + captures
"""
import json, math, os, re, sys
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3543/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-drumseq")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, Log, BASE, OUT, balayage_chevauchement  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

DR = "[aria-labelledby='drums-title']"
ED = "[data-testid=pad-sampler]"
KO, RES = [], {"mesures": {}}
INIT = ("try { localStorage.setItem('nova_headphones','1'); localStorage.setItem('nova_welcome_seen','1'); localStorage.setItem('nova_count_in','0');"
        " localStorage.setItem('nova_simple_mode','0'); localStorage.setItem('nova_theme','%s'); localStorage.setItem('nova_pad_sampler_tab','sample'); } catch(e) {}")
KICK = "() => window.__novaEdit.getState().tracks.find(t => t.id === 'track-drums').drumMachine.rows.find(r => r.id === 'kick')"


def ok(name, cond, detail=None):
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False)[:500]}"), flush=True)
    if not cond: KO.append(name)
    return cond


def open_beat(p, vp="pc", theme="dark"):
    b = launch(p); log = Log("sampler_pads")
    ctx, page = new_page(b, vp, log)
    page.add_init_script(INIT % theme)
    page.goto(BASE, wait_until="domcontentloaded")
    page.locator("[data-testid=landing-new-beat]").first.click(timeout=60000)
    page.wait_for_selector(DR, timeout=20000); page.wait_for_timeout(500)
    page.get_by_role("button", name="🔥 Trap").first.click(); page.wait_for_timeout(1500)
    return b, page, log


# ── Métrologie : un pad = un son de test, rendu par le moteur d'export ──
MEASURE = r"""
window.__m = {
  async setup(o) {
    const P = await window.__novaAppModule('/utils/drumPatterns.ts');
    const PB = await window.__novaAppModule('/utils/padBuffers.ts');
    const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts');
    await audioEngine.init?.(); await audioEngine.resume?.();
    const ctx = audioEngine.ctx, SR = ctx.sampleRate;
    const make = (s) => { const len = Math.round(SR * (s.dur || 1)); const b = ctx.createBuffer(1, len, SR); const x = b.getChannelData(0);
      for (let i = 0; i < len; i++) x[i] = s.kind === 'dc' ? (s.amp ?? 0.5) : (s.amp ?? 0.5) * Math.sin(2 * Math.PI * (s.f || 440) * i / SR);
      return PB.registerPadSample(b, 'Test'); };
    const main = make(o.sound);
    const layers = (o.layers || []).map(make);
    let dm = window.__novaMidi.rawTracks().find(t => t.id === 'track-drums').drumMachine;
    const samples = { ...(dm.samples || {}), [main.id]: main.info };
    layers.forEach(l => { samples[l.id] = l.info; });
    const smp = o.smp ? { ...o.smp, ...(layers.length ? { layers: layers.map(l => ({ sound: 'user:' + l.id, name: 'couche' })) } : {}) } : (layers.length ? { layers: layers.map(l => ({ sound: 'user:' + l.id })) } : undefined);
    const steps = new Array(16).fill(0); (o.hits || [[0, 127]]).forEach(([i, v]) => { steps[i] = v; });
    dm = { ...dm, swing: 0, groove: undefined, fill: undefined, patterns: undefined, song: undefined, activePattern: undefined, bars: 1, seed: 0, samples,
      rows: dm.rows.map((r, i) => i === 0
        ? { id: r.id, name: r.name, sound: 'user:' + main.id, volume: 1, pan: 0, tune: o.tune || 0, decay: 1, steps, ratchet: new Array(16).fill(1), ...(smp ? { smp } : {}) }
        : { ...r, steps: r.steps.map(() => 0), ratchet: r.ratchet.map(() => 1), stepProb: undefined, stepNudge: undefined, stepGate: undefined, stepGlide: undefined, stepPan: undefined, stepPitch: undefined, choke: undefined }) };
    for (const [i, param, v] of (o.params || [])) dm = P.setStepParam(dm, 0, i, param, v);
    window.dispatchEvent(new CustomEvent('nova:apply-drum-machine', { detail: { dm } }));
    await new Promise(r => setTimeout(r, 1200));
    const tr = window.__novaMidi.rawTracks().find(t => t.id === 'track-drums');
    const one = { ...tr, outputTrackId: undefined, volume: 1, pan: 0, isMuted: false, isSolo: false, sends: [], plugins: [] };
    const buf = await audioEngine.renderProject([one], o.len || 2, 0, 48000);
    window.__m.buf = buf; window.__m.SR = buf.sampleRate;
    return { bpm: window.__novaMidi.bpm(), sr: buf.sampleRate };
  },
  at(t) { return window.__m.buf.getChannelData(0)[Math.round(t * window.__m.SR)]; },
  rms(a, b) { const x = window.__m.buf.getChannelData(0), SR = window.__m.SR; let s = 0, n = 0; for (let i = Math.floor(a * SR); i < Math.floor(b * SR); i++) { s += x[i] * x[i]; n++; } return Math.sqrt(s / Math.max(1, n)); },
  peak(a, b) { const x = window.__m.buf.getChannelData(0), SR = window.__m.SR; let p = 0; for (let i = Math.floor(a * SR); i < Math.floor(b * SR); i++) p = Math.max(p, Math.abs(x[i])); return p; },
  crossing(a, b, level) { const x = window.__m.buf.getChannelData(0), SR = window.__m.SR; for (let i = Math.floor(a * SR); i < Math.floor(b * SR); i++) if (Math.abs(x[i]) >= level) { const y0 = Math.abs(x[i - 1]), y1 = Math.abs(x[i]); return (i - 1 + (level - y0) / Math.max(1e-12, y1 - y0)) / SR; } return null; },
  lastLoud(a, b, thr) { const x = window.__m.buf.getChannelData(0), SR = window.__m.SR; let last = -1; for (let i = Math.floor(a * SR); i < Math.min(x.length, b * SR); i++) if (Math.abs(x[i]) > thr) last = i; return last / SR; },
  pitch(a, b, expect) { const SR = window.__m.SR; const x = window.__m.buf.getChannelData(0).slice(Math.floor(a * SR), Math.floor(b * SR));
    const lo = Math.floor(SR / (expect * 1.06)), hi = Math.ceil(SR / (expect / 1.06)); const N = x.length - hi - 1; if (N < 256) return null;
    const ac = (L) => { let s = 0, e1 = 0, e2 = 0; for (let i = 0; i < N; i++) { s += x[i] * x[i + L]; e1 += x[i] * x[i]; e2 += x[i + L] * x[i + L]; } return s / Math.sqrt(e1 * e2 + 1e-20); };
    let best = lo, bv = -2; const v = {}; for (let L = lo - 1; L <= hi + 1; L++) { v[L] = ac(L); if (L >= lo && L <= hi && v[L] > bv) { bv = v[L]; best = L; } }
    const d = (v[best - 1] - v[best + 1]) / (2 * (v[best - 1] - 2 * v[best] + v[best + 1]) || 1); return SR / (best + (isFinite(d) ? d : 0)); },
  copy() { return Float32Array.from(window.__m.buf.getChannelData(0)); },
  // Puissance à une fréquence (Goertzel) : quelle couche a joué.
  tone(a, b, f) { const x = window.__m.buf.getChannelData(0), SR = window.__m.SR; const w = 2 * Math.PI * f / SR, c = 2 * Math.cos(w); let s1 = 0, s2 = 0;
    for (let i = Math.floor(a * SR); i < Math.floor(b * SR); i++) { const s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; } return s1 * s1 + s2 * s2 - c * s1 * s2; },
  async model(smp, t, f) { const S = await window.__novaAppModule('/utils/padSampler.ts'); const fc = S.cutoffAt(smp, 1, t, 48000);
    return { fc, dB: S.filterSections(smp.filterType, smp.filterSlope || 12, smp.reso || 0).reduce((a, sec) => a + S.sectionGainDb(sec, fc, f, 48000), 0) }; },
};
"""


def m(page, o):
    return page.evaluate("(o) => window.__m.setup(o)", o)


def ev(page, js):
    return page.evaluate(js)


def db(x):
    return 20 * math.log10(max(1e-12, x))


def metrologie(page):
    page.evaluate("(src) => { eval(src); return true; }", MEASURE)
    R = RES["mesures"]
    # Référence : pad sans sampler (son brut, chemin d'avant).
    m(page, {"sound": {"kind": "dc", "amp": 0.5, "dur": 0.5}})
    ref = ev(page, "() => window.__m.at(0.2)")
    ref_copy = ev(page, "() => Array.from(window.__m.copy().slice(0, 48000))")
    # Sampler aux valeurs par défaut : exactement le même son (null test).
    m(page, {"sound": {"kind": "dc", "amp": 0.5, "dur": 0.5}, "smp": {"cents": 0}})
    same = ev(page, "() => Array.from(window.__m.copy().slice(0, 48000))") == ref_copy
    m(page, {"sound": {"kind": "dc", "amp": 0.5, "dur": 0.5}, "smp": {"attack": 0, "sustain": 1}})
    nul = ev(page, "() => { const a = window.__m.copy(); return Math.max(...Array.from(a.slice(0, 48000)).map((v, i) => Math.abs(v))); }")
    ok("pad sans réglage du sampler : son identique au bit près au son d'avant (null test)", same, {"ref": ref})
    # Gain +6 dB.
    m(page, {"sound": {"kind": "dc", "amp": 0.25, "dur": 0.5}, "smp": {"gainDb": 6}})
    g = ev(page, "() => window.__m.at(0.2)") / (ref / 2)
    R["gain_+6dB"] = {"rapport": round(g, 5), "dB": round(db(g), 3)}
    ok(f"gain +6 dB mesuré : {round(db(g), 3)} dB (×{round(g, 4)})", abs(db(g) - 6) < 0.01, R["gain_+6dB"])
    # Vélocité 64/127 → −5,95 dB (volume suit la vélocité), 0 % → 0 dB.
    m(page, {"sound": {"kind": "dc", "amp": 0.5, "dur": 0.5}, "hits": [[0, 64]], "smp": {"velToVol": 1, "attack": 0}})
    v1 = db(ev(page, "() => window.__m.at(0.2)") / ref)
    m(page, {"sound": {"kind": "dc", "amp": 0.5, "dur": 0.5}, "hits": [[0, 64]], "smp": {"velToVol": 0}})
    v0 = db(ev(page, "() => window.__m.at(0.2)") / ref)
    R["velocite"] = {"64_sur_127_dB": round(v1, 3), "attendu": round(db(64 / 127), 3), "vel_vers_volume_0_dB": round(v0, 3)}
    ok("vélocité 64/127 → −5,95 dB ; vélocité → volume 0 % → 0 dB", abs(v1 - db(64 / 127)) < 0.01 and abs(v0) < 0.01, R["velocite"])
    # Attaque 10 ms.
    m(page, {"sound": {"kind": "dc", "amp": 0.5, "dur": 0.5}, "smp": {"attack": 0.01}})
    t50 = ev(page, f"() => window.__m.crossing(0, 0.1, {ref} * 0.5)"); t100 = ev(page, f"() => window.__m.crossing(0, 0.1, {ref} * 0.9999)")
    R["attaque_10ms"] = {"moitie_ms": round(t50 * 1000, 3), "maximum_ms": round(t100 * 1000, 3)}
    ok(f"attaque 10 ms mesurée : moitié à {round(t50 * 1000, 2)} ms, maximum à {round(t100 * 1000, 2)} ms", abs(t50 - 0.005) < 0.0002 and abs(t100 - 0.01) < 0.0002, R["attaque_10ms"])
    # Maintien 20 ms + décroissance 100 ms (droite) vers sustain 25 %.
    m(page, {"sound": {"kind": "dc", "amp": 0.5, "dur": 0.8}, "smp": {"hold": 0.02, "decay": 0.1, "sustain": 0.25, "decayCurve": 0}})
    d = {"a_20ms": ev(page, "() => window.__m.at(0.019)") / ref, "a_70ms": ev(page, "() => window.__m.at(0.07)") / ref, "a_120ms": ev(page, "() => window.__m.at(0.12)") / ref, "a_400ms": ev(page, "() => window.__m.at(0.4)") / ref}
    R["decroissance"] = {k: round(v, 4) for k, v in d.items()} | {"sustain_dB": round(db(d["a_400ms"]), 3)}
    ok("maintien 20 ms, décroissance 100 ms → sustain 25 % (−12,04 dB) atteint à 120 ms, droite au milieu (62,5 % à 70 ms)",
       abs(d["a_20ms"] - 1) < 1e-3 and abs(d["a_70ms"] - 0.625) < 2e-3 and abs(d["a_120ms"] - 0.25) < 2e-3 and abs(db(d["a_400ms"]) + 12.04) < 0.02, R["decroissance"])
    # Note tenue (2 pas = 250 ms à 120 BPM) puis relâchement 50 ms (droite) → fin à 300 ms.
    m(page, {"sound": {"kind": "dc", "amp": 0.5, "dur": 1}, "smp": {"mode": "gate", "release": 0.05, "releaseCurve": 0}, "params": [[0, "gate", 2]]})
    rel = {"a_250ms": ev(page, "() => window.__m.at(0.2499)") / ref, "a_275ms": ev(page, "() => window.__m.at(0.275)") / ref, "fin_s": ev(page, "() => window.__m.lastLoud(0, 1, 1e-4)")}
    R["relachement"] = {k: round(v, 4) for k, v in rel.items()}
    ok("note tenue de 2 pas (250 ms) + relâchement 50 ms : moitié à 275 ms, silence à 300 ms", abs(rel["a_250ms"] - 1) < 2e-3 and abs(rel["a_275ms"] - 0.5) < 3e-3 and 0.297 <= rel["fin_s"] <= 0.301, R["relachement"])
    # Filtre : sinus 1 kHz, régime établi (0,2-0,4 s).
    m(page, {"sound": {"kind": "sine", "f": 1000, "amp": 0.5, "dur": 0.6}, "len": 0.6})
    r0 = ev(page, "() => window.__m.rms(0.2, 0.4)")
    filt = {}
    for t in ("lp", "hp", "bp"):
        for sl in (12, 24):
            m(page, {"sound": {"kind": "sine", "f": 1000, "amp": 0.5, "dur": 0.6}, "len": 0.6, "smp": {"filterType": t, "filterSlope": sl, "cutoff": 1000}})
            filt[f"{t}{sl}"] = round(db(ev(page, "() => window.__m.rms(0.2, 0.4)") / r0), 3)
    R["filtre_1kHz_dB"] = filt
    ok("filtre à 1 kHz : passe-bas / passe-haut 12 et 24 dB/oct = −3,01 dB à 1 kHz, passe-bande = 0 dB au centre (±0,05 dB)",
       all(abs(filt[k] + 3.01) < 0.05 for k in ("lp12", "lp24", "hp12", "hp24")) and all(abs(filt[k]) < 0.05 for k in ("bp12", "bp24")), filt)
    # Enveloppe de filtre : passe-bas 500 Hz 12 dB/oct, +2 oct, décroissance 300 ms, sinus 2 kHz : atténuation mesurée = modèle affiché.
    sm = {"filterType": "lp", "filterSlope": 12, "cutoff": 500, "filterEnvAmt": 2, "filterDecay": 0.3, "filterSustain": 0}
    m(page, {"sound": {"kind": "sine", "f": 2000, "amp": 0.5, "dur": 0.6}, "len": 0.6, "smp": sm})
    fe = {}
    for name, a, z in (("10ms", 0.008, 0.012), ("60ms", 0.055, 0.065), ("450ms", 0.4, 0.5)):
        mod = page.evaluate("([smp, t]) => window.__m.model(smp, t, 2000)", [sm, (a + z) / 2])
        fe[name] = {"coupure_Hz": round(mod["fc"]), "modele_dB": round(mod["dB"], 2), "mesure_dB": round(db(ev(page, f"() => window.__m.rms({a}, {z})") / r0), 2)}
    R["enveloppe_filtre"] = fe
    ok("enveloppe de filtre (+2 oct, 300 ms) : atténuation de 2 kHz mesurée = modèle affiché (±1 dB) quand la coupure descend de 2 kHz à 500 Hz",
       all(abs(v["mesure_dB"] - v["modele_dB"]) <= 1.0 for v in fe.values()), fe)
    # Hauteur.
    m(page, {"sound": {"kind": "sine", "f": 440, "amp": 0.5, "dur": 1}, "tune": 12, "len": 1})
    f12 = ev(page, "() => window.__m.pitch(0.05, 0.4, 880)")
    m(page, {"sound": {"kind": "sine", "f": 440, "amp": 0.5, "dur": 1}, "smp": {"cents": 50}, "len": 1})
    f50 = ev(page, "() => window.__m.pitch(0.05, 0.4, 452.9)")
    c12 = 1200 * math.log2(f12 / 880); c50 = 1200 * math.log2(f50 / (440 * 2 ** (50 / 1200)))
    R["hauteur"] = {"plus_12dt_Hz": round(f12, 3), "ecart_cents": round(c12, 3), "plus_50_centiemes_Hz": round(f50, 3), "ecart_50_cents": round(c50, 3)}
    ok(f"+12 demi-tons = octave exacte ({round(f12, 2)} Hz pour 880) ; +50 centièmes ({round(f50, 2)} Hz)", abs(c12) < 1 and abs(c50) < 1, R["hauteur"])
    # Durée gardée : +12 dt avec étirement → même durée (0,5 s) ; sans : moitié.
    m(page, {"sound": {"kind": "sine", "f": 440, "amp": 0.5, "dur": 0.5}, "tune": 12, "len": 1})
    d_sans = ev(page, "() => window.__m.lastLoud(0, 1, 0.01)")
    m(page, {"sound": {"kind": "sine", "f": 440, "amp": 0.5, "dur": 0.5}, "tune": 12, "smp": {"stretch": True}, "len": 1})
    d_avec = ev(page, "() => window.__m.lastLoud(0, 1, 0.01)"); f_avec = ev(page, "() => window.__m.pitch(0.1, 0.4, 880)")
    R["duree_gardee"] = {"sans_s": round(d_sans, 3), "avec_s": round(d_avec, 3), "hauteur_avec_Hz": round(f_avec, 2)}
    ok("+12 dt : durée 0,25 s comme une platine ; « garder la durée » : 0,5 s et toujours 880 Hz", abs(d_sans - 0.25) < 0.005 and abs(d_avec - 0.5) < 0.03 and abs(1200 * math.log2(f_avec / 880)) < 10, R["duree_gardee"])
    # Enveloppe de hauteur : +12 dt, retour en 100 ms.
    m(page, {"sound": {"kind": "sine", "f": 440, "amp": 0.5, "dur": 1}, "smp": {"pitchEnvAmt": 12, "pitchEnvDecay": 0.1}, "len": 1})
    pe = {"apres_Hz": round(ev(page, "() => window.__m.pitch(0.15, 0.45, 440)"), 3), "debut_Hz": round(ev(page, "() => window.__m.pitch(0.0, 0.012, 830)") or 0, 1)}
    R["enveloppe_hauteur"] = pe
    ok("enveloppe de hauteur +12 dt / 100 ms : départ vers 830-880 Hz, retour pile à 440 Hz", abs(1200 * math.log2(pe["apres_Hz"] / 440)) < 1 and pe["debut_Hz"] > 760, pe)
    # Glisse : pas 1 à −12 dt, pas 9 à 0 dt avec glisse (temps 200 ms).
    m(page, {"sound": {"kind": "sine", "f": 440, "amp": 0.5, "dur": 0.6}, "hits": [[0, 127], [8, 127]], "smp": {"glideMs": 200}, "params": [[0, "pitch", -12], [8, "glide", 1]], "len": 2})
    gl = {"debut_glisse_Hz": round(ev(page, "() => window.__m.pitch(1.0, 1.03, 240)") or 0, 1), "apres_Hz": round(ev(page, "() => window.__m.pitch(1.25, 1.5, 440)"), 3)}
    R["glisse"] = gl
    ok("glisse : le pas part de la hauteur du coup précédent (≈ 220-260 Hz) et arrive à 440 Hz en 200 ms", 200 < gl["debut_glisse_Hz"] < 300 and abs(1200 * math.log2(gl["apres_Hz"] / 440)) < 2, gl)
    # Normaliser : son à 0,25 → crête à 0 dBFS (×4 = +12,04 dB) ; polarité ; 4 bits ; ÷4.
    m(page, {"sound": {"kind": "dc", "amp": 0.25, "dur": 0.5}, "smp": {"normalize": True}})
    nrm = ev(page, "() => window.__m.at(0.2)") / (ref / 2)
    m(page, {"sound": {"kind": "dc", "amp": 0.5, "dur": 0.5}, "smp": {"invert": True}})
    inv = ev(page, "() => window.__m.at(0.2)") / ref
    m(page, {"sound": {"kind": "dc", "amp": 0.3, "dur": 0.5}, "smp": {"crushBits": 4}})
    bits = ev(page, "() => window.__m.at(0.2)") / (ref * 2)
    m(page, {"sound": {"kind": "sine", "f": 1000, "amp": 0.5, "dur": 0.5}, "smp": {"crushDown": 4}})
    held = ev(page, "() => { const x = window.__m.buf.getChannelData(0); let same = 0, n = 0; for (let i = 4800; i < 9600; i++) { if (i % 4) { n++; if (x[i] === x[i - 1]) same++; } } return same / n; }")
    R["traitements"] = {"normaliser_dB": round(db(nrm), 3), "polarite": round(inv, 4), "4_bits_valeur": round(bits, 4), "ech_div4_paliers": round(held, 4)}
    ok("normaliser +12,04 dB (crête 0 dBFS), polarité −1, 4 bits (0,3 → 0,25), échantillonnage ÷4 (paliers de 4 échantillons)",
       abs(db(nrm) - 12.04) < 0.02 and abs(inv + 1) < 1e-4 and abs(bits - 0.25) < 1e-4 and held > 0.999, R["traitements"])
    # Boucle tenue : son de 0,1 s en boucle, note de 4 pas (0,5 s) + relâchement 10 ms.
    m(page, {"sound": {"kind": "sine", "f": 440, "amp": 0.5, "dur": 0.1}, "smp": {"loop": True, "release": 0.01}, "params": [[0, "gate", 4]], "len": 1})
    lp = ev(page, "() => window.__m.lastLoud(0, 1, 0.005)")
    R["boucle_fin_s"] = round(lp, 4)
    ok("boucle : un son de 0,1 s tenu 4 pas (0,5 s) sonne jusqu'à 0,5 s + relâchement", 0.495 <= lp <= 0.511, lp)
    # Mono / poly : deux coups de 0,5 s à 125 ms d'écart.
    m(page, {"sound": {"kind": "dc", "amp": 0.25, "dur": 0.5}, "hits": [[0, 127], [1, 127]]})
    poly = ev(page, "() => window.__m.at(0.2)") / (ref / 2)
    m(page, {"sound": {"kind": "dc", "amp": 0.25, "dur": 0.5}, "hits": [[0, 127], [1, 127]], "smp": {"poly": "mono"}})
    mono = ev(page, "() => window.__m.at(0.2)") / (ref / 2)
    R["voix"] = {"poly_x": round(poly, 4), "mono_x": round(mono, 4)}
    ok("polyphonie : 2 coups superposés (×2) ; mono : le 2e coupe le 1er (×1)", abs(poly - 2) < 1e-3 and abs(mono - 1) < 1e-3, R["voix"])
    # Couches de vélocité (440 doux, 660 fort) et alternance.
    m(page, {"sound": {"kind": "sine", "f": 440, "amp": 0.5, "dur": 0.4}, "layers": [{"kind": "sine", "f": 660, "amp": 0.5, "dur": 0.4}], "hits": [[0, 40], [8, 120]], "smp": {"layerMode": "vel"}, "len": 2})
    which = lambda t: 440 if ev(page, f"() => window.__m.tone({t + 0.05}, {t + 0.3}, 440)") > ev(page, f"() => window.__m.tone({t + 0.05}, {t + 0.3}, 660)") else 660
    lv = [which(0), which(1)]
    m(page, {"sound": {"kind": "sine", "f": 440, "amp": 0.5, "dur": 0.4}, "layers": [{"kind": "sine", "f": 660, "amp": 0.5, "dur": 0.4}], "hits": [[0, 127], [8, 127]], "smp": {"layerMode": "rr"}, "len": 4})
    rr = [which(t) for t in (0, 1, 2, 3)]
    R["couches"] = {"velocite_40_puis_120_Hz": lv, "alternance_Hz": rr}
    ok("couches : vélocité 40 → son doux (440 Hz), 120 → son fort (660 Hz) ; alternance 440 / 660 / 440 / 660", lv == [440, 660] and rr == [440, 660, 440, 660], R["couches"])
    # Deux rendus identiques au bit près (enveloppes, filtre, hauteur).
    m(page, {"sound": {"kind": "sine", "f": 440, "amp": 0.5, "dur": 0.5}, "smp": {"attack": 0.01, "decay": 0.2, "sustain": 0.3, "filterType": "lp", "cutoff": 900, "filterEnvAmt": 1, "pitchEnvAmt": 5}, "len": 1})
    a1 = ev(page, "() => { window.__m.keep = window.__m.copy(); return true; }")
    m(page, {"sound": {"kind": "sine", "f": 440, "amp": 0.5, "dur": 0.5}, "smp": {"attack": 0.01, "decay": 0.2, "sustain": 0.3, "filterType": "lp", "cutoff": 900, "filterEnvAmt": 1, "pitchEnvAmt": 5}, "len": 1})
    same2 = ev(page, "() => { const b = window.__m.copy(), a = window.__m.keep; if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }")
    ok("deux rendus d'export identiques au bit près (enveloppes, filtre, hauteur)", a1 and same2)


def set_range(page, sel, value):
    page.evaluate("""([sel, v]) => { const el = document.querySelector(sel); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, String(v)); el.dispatchEvent(new Event('input', { bubbles: true })); }""", [sel, value])
    page.wait_for_timeout(250)


def shown(page, test_id):
    return page.locator(f"[data-testid={test_id}] [data-value]").first.inner_text().strip()


def interface_pc(page):
    page.locator(f"{DR} [data-row=kick] button").first.dblclick(); page.wait_for_timeout(600)
    ok("double-clic sur le nom d'un pad : éditeur de son ouvert", page.locator(ED).count() == 1)
    page.locator(ED).scroll_into_view_if_needed()
    page.screenshot(path=str(OUT / "smp_pc_01_sample.png"))
    # Poignée de début glissée sur la forme d'onde.
    w = page.locator("[data-testid=pad-wave]").bounding_box()
    page.mouse.move(w["x"] + 2, w["y"] + w["height"] / 2); page.mouse.down(); page.mouse.move(w["x"] + w["width"] * 0.1, w["y"] + w["height"] / 2, steps=8); page.mouse.up(); page.wait_for_timeout(300)
    k = page.evaluate(KICK)
    ok("poignée de début glissée : le son commence plus loin (≈ 10 %)", 0.05 < (k.get("start") or 0) < 0.15, k.get("start"))
    page.keyboard.press("Control+z"); page.wait_for_timeout(300)
    # Gain : valeur affichée = réglage.
    set_range(page, "[data-testid=pad-gain] input", 6)
    k = page.evaluate(KICK)
    ok("gain réglé à +6 dB : affiché « +6,0 dB », état 6", shown(page, "pad-gain") == "+6,0 dB" and k["smp"]["gainDb"] == 6, [shown(page, "pad-gain"), k.get("smp")])
    # Enveloppes : attaque 10 ms au curseur, puis point d'attaque glissé.
    page.locator("[data-testid=pad-tab-env]").click(); page.wait_for_timeout(300)
    set_range(page, "[data-testid=pad-attack] input", 0.01)
    k = page.evaluate(KICK)
    ok("attaque réglée : affiché « 10 ms », état 0,01 s", shown(page, "pad-attack") == "10 ms" and abs(k["smp"]["attack"] - 0.01) < 1e-9, [shown(page, "pad-attack"), k["smp"].get("attack")])
    set_range(page, "[data-testid=pad-sustain] input", 0.5)
    set_range(page, "[data-testid=pad-decay] input", 0.2)
    page.screenshot(path=str(OUT / "smp_pc_02_enveloppes.png"))
    g = page.locator("[data-testid=pad-env-graph]").bounding_box()
    a_before = page.evaluate(KICK)["smp"]["attack"]
    # Point d'attaque : x = attaque / total (total = (A + H + D + note + R) × 1,1).
    k = page.evaluate(KICK)["smp"]; A, H, D, R = k.get("attack", 0), k.get("hold", 0), k.get("decay", 0), k.get("release", 0.005)
    note = A + H + D + max(0.15, (A + H + D) * 0.4); total = max(0.3, note + R) * 1.1
    x = g["x"] + (10 + (A / total) * 580) / 600 * g["width"]; y = g["y"] + 10 / 140 * g["height"]
    page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + g["width"] * 0.08, y, steps=6); page.mouse.up(); page.wait_for_timeout(300)
    a_after = page.evaluate(KICK)["smp"]["attack"]
    ok(f"point d'attaque glissé sur le graphe : {round(a_before * 1000)} → {round(a_after * 1000)} ms", a_after > a_before + 0.01, [a_before, a_after])
    # Filtre.
    page.locator("[data-testid=pad-tab-filter]").click(); page.wait_for_timeout(300)
    page.locator("[data-testid=pad-filter-type] [role=radio]", has_text="Passe-bas").click(); page.wait_for_timeout(200)
    page.locator("[data-testid=pad-filter-slope] [role=radio]", has_text="24").click(); page.wait_for_timeout(200)
    set_range(page, "[data-testid=pad-cutoff] input", math.log(1000))
    k = page.evaluate(KICK)["smp"]
    ok("filtre : passe-bas 24 dB/oct, coupure affichée « 1,00 kHz » = 1000 Hz", k.get("filterType") == "lp" and k.get("filterSlope") == 24 and (k.get("cutoff") or 1000) == 1000 and shown(page, "pad-cutoff") == "1,00 kHz", [k, shown(page, "pad-cutoff")])
    page.screenshot(path=str(OUT / "smp_pc_03_filtre.png"))
    # Hauteur : +12 dt → ×2.
    page.locator("[data-testid=pad-tab-pitch]").click(); page.wait_for_timeout(300)
    set_range(page, "[data-testid=pad-tune] input", 12)
    ratio = page.locator("[data-testid=pad-ratio]").inner_text()
    ok("hauteur +12 dt : « ×2,0000 (1 octave au-dessus) »", "×2,0000" in ratio and "1 octave" in ratio, ratio)
    page.screenshot(path=str(OUT / "smp_pc_04_hauteur.png"))
    set_range(page, "[data-testid=pad-tune] input", 0)
    # Modulation : mono, 8 bits.
    page.locator("[data-testid=pad-tab-mod]").click(); page.wait_for_timeout(300)
    page.locator("[data-testid=pad-poly] [role=radio]", has_text="Mono").click(); page.wait_for_timeout(200)
    set_range(page, "[data-testid=pad-bits] input", 8)
    k = page.evaluate(KICK)["smp"]
    ok("modulation : mono et 8 bits", k.get("poly") == "mono" and k.get("crushBits") == 8, k)
    page.screenshot(path=str(OUT / "smp_pc_05_modulation.png"))
    # Presets : enregistrer, remettre à zéro, rappeler.
    before = page.evaluate(KICK)["smp"]
    page.locator("[data-testid=pad-presets]").click(); page.wait_for_timeout(200)
    page.locator("[data-testid=pad-preset-save]").click(); page.wait_for_timeout(200)
    page.locator("[data-testid=pad-preset-name]").fill("Kick QA"); page.locator("[data-testid=pad-preset-ok]").click(); page.wait_for_timeout(300)
    page.locator(f"{ED} button[aria-label='Remettre le sampler à zéro']").click(); page.wait_for_timeout(300)
    reset = page.evaluate(KICK).get("smp")
    page.locator("[data-testid=pad-presets]").click(); page.wait_for_timeout(200)
    page.locator("[data-testid='pad-preset-Kick QA']").click(); page.wait_for_timeout(300)
    after = page.evaluate(KICK)["smp"]
    ok("preset de pad : enregistré, sampler remis à zéro (son brut), preset rappelé à l'identique", reset is None and after == before, {"avant": before, "apres": after, "zero": reset})
    # Échap : ferme l'éditeur, pas la batterie.
    page.locator("[data-testid=pad-tab-sample]").click(); page.wait_for_timeout(200)
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    ok("Échap (focus dans l'éditeur) : l'éditeur se ferme, la batterie reste ouverte", page.locator(ED).count() == 0 and page.locator(DR).count() == 1)
    # Menu du pad › Éditer le son.
    b = page.locator(f"{DR} [data-row=snare] button").first.bounding_box()
    page.mouse.click(b["x"] + 10, b["y"] + 10, button="right"); page.wait_for_timeout(300)
    page.locator("[data-testid=row-edit-sound]").click(); page.wait_for_timeout(400)
    ok("menu du pad › « Éditer le son (sampler)… » : éditeur ouvert sur la caisse claire", page.locator(ED).count() == 1 and "Snare" in page.locator(ED).inner_text())


def petits(p, vp, theme):
    b, page, log = open_beat(p, vp, theme)
    tag = f"smp_{vp}_{theme}"
    page.locator(f"{DR} [data-row=kick] button").first.dispatch_event("contextmenu", {"clientX": 60, "clientY": 300}); page.wait_for_timeout(300)
    page.locator("[data-testid=row-edit-sound]").click(); page.wait_for_timeout(500)
    ok(f"{vp} {theme} : éditeur ouvert par le menu du pad (appui long)", page.locator(ED).count() == 1)
    for t in ("sample", "env", "filter", "mod"):
        page.locator(f"[data-testid=pad-tab-{t}]").click(); page.wait_for_timeout(250)
        page.locator(ED).scroll_into_view_if_needed()
        page.screenshot(path=str(OUT / f"{tag}_{t}.png"))
        small = page.evaluate(f"""() => [...document.querySelectorAll('{ED} button, {ED} input[type=range], {ED} [role=radio]')].filter(e => e.getClientRects().length && !e.disabled)
          .map(e => {{ const r = e.getBoundingClientRect(); return {{ t: (e.innerText || e.getAttribute('aria-label') || e.tagName).trim().slice(0, 24), w: Math.round(r.width), h: Math.round(r.height) }}; }})
          .filter(x => x.h < 44 || x.w < 44)""")
        over = page.evaluate(f"() => {{ const e = document.querySelector('{ED}'); const r = e.getBoundingClientRect(); return {{ page: document.documentElement.scrollWidth - innerWidth, droite: Math.round(r.right - innerWidth) }}; }}")
        bal = balayage_chevauchement(page, ED)
        rec = [x for x in bal.get("recouverts", []) if "posée" not in json.dumps(x, ensure_ascii=False)]
        ok(f"{vp} {theme} · {t} : cibles ≥ 44 px, rien de coupé, rien de recouvert", not small and over["page"] <= 1 and over["droite"] <= 1 and not rec, {"petites": small[:6], "debord": over, "recouverts": rec[:3]})
    errs = [e["text"][:160] for e in log.errors() if not re.search(r"876[56]|ERR_CONNECTION_REFUSED|status of 400", e["text"])]
    ok(f"{vp} {theme} : aucune erreur de page", not errs, errs)
    b.close()


if __name__ == "__main__":
    with sync_playwright() as p:
        b, page, log = open_beat(p)
        interface_pc(page)
        metrologie(page)
        errs = [e["text"][:160] for e in log.errors() if not re.search(r"876[56]|ERR_CONNECTION_REFUSED|status of 400", e["text"])]
        ok("PC : aucune erreur de page", not errs, errs)
        b.close()
        petits(p, "tab", "light")
        petits(p, "tel390", "dark")
        petits(p, "tel390", "light")
    (OUT / "sampler_pads.json").write_text(json.dumps({"resultats": RES, "ko": KO}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n{len(KO)} KO" + (f" : {KO}" if KO else ""))
    sys.exit(1 if KO else 0)
