"""Séquenceur de batterie pro (22/10/2026) : gestes réels, mesures sur le rendu d'export, captures.

Headless (aucune fenêtre), 100 % hors production (qalib importe qa_hors_prod).

PC 1600 × 900, mode avancé (projet « Nouveau beat ») :
  1. clic droit sur un pas → menu du pas : probabilité, décalage fin, longueur, hauteur, glisse (état vérifié) ;
  2. graphe par pas : « Probabilité » réglée au glisser ;
  3. clic droit sur un pad → résolution 1/32, nombre de pas 24 (polymétrie), M / S de la rangée ;
  4. raccourcis : Maj + → décale la rangée, Suppr l'efface, Ctrl+Z la rend ;
  5. menu ⋯ du motif : doubler (1 → 8 mesures), copier / coller (Ctrl+C / Ctrl+V), motif suivant (]) ;
  6. rythmes publiés : une recette sourcée posée dans un nouveau motif (pas = la recette) ;
  7. fill toutes les 4 mesures : toms + roulement, crash après le fill ;
  8. enregistrement en direct (pads au clavier pendant la lecture), métronome par ⋯ ;
  9. mesures sur le RENDU D'EXPORT (moteur hors ligne, le même code que la lecture) : décalage +25 % = +31,25 ms,
     longueur 2 pas = 250 ms, probabilité 50 % (deux rendus identiques au bit près), décalage de rangée,
     rampe de tempo (chaque coup sur sa position musicale) ;
 10. beat de 8 mesures (couplet + variation + fill + crash) : gestes et temps, comparés aux gestes d'avant.
Tablette 1024 (clair) et téléphone 390 (sombre puis clair) : panneau, menu du pas, menu du pad ; rien de coupé,
rien qui se chevauche, taille des cibles tactiles relevée. Aucune erreur de page.

NOVA_URL=http://127.0.0.1:3543/ PYTHONIOENCODING=utf-8 python qa/sequenceur_pro.py
Sorties : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-drumseq) : sequenceur_pro.json + captures
"""
import json, os, re, sys, time
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3543/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-drumseq")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, Log, BASE, OUT, balayage_chevauchement  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

DR = "[aria-labelledby='drums-title']"
KO, RES = [], {}
INIT = ("try { localStorage.setItem('nova_headphones','1'); localStorage.setItem('nova_welcome_seen','1'); localStorage.setItem('nova_count_in','0');"
        " localStorage.setItem('nova_simple_mode','0'); localStorage.setItem('nova_theme','%s'); } catch(e) {}")
DM = "() => { const t = window.__novaEdit.getState().tracks.find(t => t.id === 'track-drums'); return t ? t.drumMachine : null; }"
ROW = "(n) => { const t = window.__novaEdit.getState().tracks.find(t => t.id === 'track-drums'); return t ? t.drumMachine.rows.find(r => r.name === n) : null; }"
PAT = "(r) => r.steps.slice(0, 16).map(v => v >= 100 ? 'X' : v > 0 ? 'x' : '.').join('')"


def ok(name, cond, detail=None):
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False)[:500]}"), flush=True)
    if not cond: KO.append(name)
    return cond


def row(page, name):
    return page.evaluate(ROW, name)


def steps16(page, name):
    r = row(page, name)
    return "".join("X" if v >= 100 else "x" if v > 0 else "." for v in r["steps"][:16]) if r else None


def open_beat(p, vp="pc", theme="dark"):
    b = launch(p); log = Log("sequenceur_pro")
    ctx, page = new_page(b, vp, log)
    page.add_init_script(INIT % theme)
    page.goto(BASE, wait_until="domcontentloaded")
    page.locator("[data-testid=landing-new-beat]").first.click(timeout=60000)
    page.wait_for_selector(DR, timeout=20000); page.wait_for_timeout(500)
    page.get_by_role("button", name="🔥 Trap").first.click(); page.wait_for_timeout(1500)
    return b, page, log


def menu_click(page, label, exact=True):
    m = page.locator("[data-testid=drum-menu]").last
    btn = m.get_by_role("menuitemradio", name=label, exact=exact)
    if not btn.count(): btn = m.get_by_role("menuitem", name=label, exact=exact)
    if not btn.count(): btn = m.get_by_role("menuitemcheckbox", name=label, exact=exact)
    btn.first.click(); page.wait_for_timeout(250)


def close_menu(page):
    if page.locator("[data-testid=drum-menu]").count(): page.keyboard.press("Escape"); page.wait_for_timeout(200)


def right_click(page, sel):
    el = page.locator(sel).first
    bb = el.bounding_box()
    page.mouse.click(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2, button="right"); page.wait_for_timeout(300)


# Outils de mesure (rendu d'export du moteur, comme qa/r18_beatmaker.py).
MEASURE = r"""
window.__qa = {
  async render(tracks, dur, start = 0) {
    const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts');
    const one = tracks.map(t => ({ ...t, outputTrackId: undefined, volume: 1, pan: 0, isMuted: false, isSolo: false, sends: [], plugins: [] }));
    return audioEngine.renderProject(one, dur, start, 48000);
  },
  onsets(buf, thr = 0.02) { const x = buf.getChannelData(0), out = []; let quiet = true, q = 0;
    for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (quiet && a > thr) { out.push(i / buf.sampleRate); quiet = false; q = 0; } else if (!quiet) { if (a < thr * 0.25) { if (++q > 480) quiet = true; } else q = 0; } }
    return out; },
  lastLoud(buf, a, b, thr = 0.003) { const x = buf.getChannelData(0), SR = buf.sampleRate; let last = -1; for (let i = Math.floor(a * SR); i < Math.min(x.length, b * SR); i++) if (Math.abs(x[i]) > thr) last = i; return last / SR; },
  same(a, b) { if (a.length !== b.length) return false; for (let c = 0; c < a.numberOfChannels; c++) { const x = a.getChannelData(c), y = b.getChannelData(c); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false; } return true; },
};
"""

# Batterie de mesure : un pad = un son de test (clic court, 2 kHz, 40 ms), tout le reste éteint.
SETUP = r"""async (opts) => {
  const P = await window.__novaAppModule('/utils/drumPatterns.ts');
  const PB = await window.__novaAppModule('/utils/padBuffers.ts');
  const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const ctx = audioEngine.ctx, SR = ctx.sampleRate;
  const len = Math.round(SR * (opts.dur || 0.6));
  const b = ctx.createBuffer(1, len, SR); const x = b.getChannelData(0);
  for (let i = 0; i < len; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * 2000 * i / SR);
  const s = PB.registerPadSample(b, 'Test 2 kHz');
  let dm = window.__novaMidi.rawTracks().find(t => t.id === 'track-drums').drumMachine;
  dm = { ...dm, swing: 0, groove: undefined, fill: undefined, patterns: undefined, song: undefined, activePattern: undefined, bars: 1, seed: 0,
    samples: { ...(dm.samples || {}), [s.id]: s.info },
    rows: dm.rows.map((r, i) => i === 0
      ? { id: r.id, name: r.name, sound: 'user:' + s.id, volume: 1, pan: 0, tune: 0, decay: 1, steps: opts.steps, ratchet: new Array(16).fill(1), ...(opts.row || {}) }
      : { ...r, steps: r.steps.map(() => 0), ratchet: r.ratchet.map(() => 1), stepProb: undefined, stepNudge: undefined, stepGate: undefined, stepGlide: undefined, stepPan: undefined, stepPitch: undefined }) };
  for (const [k, i, param, v] of (opts.params || [])) dm = P.setStepParam(dm, k, i, param, v);
  window.dispatchEvent(new CustomEvent('nova:apply-drum-machine', { detail: { dm } }));
  await new Promise(r => setTimeout(r, 900));
  return { bpm: window.__novaMidi.bpm() };
}"""


def mesures_export(page):
    page.evaluate("(src) => { eval(src); return true; }", MEASURE)
    page.evaluate("async () => { const { audioEngine } = await window.__novaAppModule('/engine/AudioEngine.ts'); await audioEngine.init?.(); await audioEngine.resume?.(); }")
    one = [0] * 16
    # Décalage fin : pas 5 à +25 % (à 120 BPM : +31,25 ms), pas 9 à −50 %.
    steps = one[:]; steps[4] = 110; steps[8] = 110
    m = page.evaluate(SETUP, {"steps": steps, "dur": 0.04, "params": [[0, 4, "nudge", 25], [0, 8, "nudge", -50]]})
    bpm = m["bpm"]; step = 60 / bpm / 4
    on = page.evaluate("async () => { const tr = window.__novaMidi.rawTracks().find(t => t.id === 'track-drums'); const b = await window.__qa.render([tr], 2.2, 0); return window.__qa.onsets(b); }")
    exp = [4 * step + 0.25 * step, 8 * step - 0.5 * step]
    err = [round((on[i] - exp[i]) * 1000, 3) for i in range(min(2, len(on)))]
    RES["mesure_decalage"] = {"bpm": bpm, "attendu_s": [round(e, 5) for e in exp], "mesure_s": [round(o, 5) for o in on[:2]], "ecart_ms": err}
    ok(f"décalage fin mesuré à l'export : +25 % = +{round(0.25 * step * 1000, 2)} ms, −50 % = −{round(0.5 * step * 1000, 2)} ms (écart ≤ 0,1 ms)", len(on) >= 2 and all(abs(e) <= 0.1 for e in err), RES["mesure_decalage"])
    # Décalage de toute la rangée : −20 % d'une double-croche.
    steps = one[:]; steps[4] = 110
    page.evaluate(SETUP, {"steps": steps, "dur": 0.04, "row": {"shift": -20}})
    on = page.evaluate("async () => { const tr = window.__novaMidi.rawTracks().find(t => t.id === 'track-drums'); return window.__qa.onsets(await window.__qa.render([tr], 2.2, 0)); }")
    e = round((on[0] - (4 * step - 0.2 * step)) * 1000, 3) if on else None
    RES["mesure_decalage_rangee_ms"] = e
    ok("décalage de rangée −20 % mesuré à l'export (écart ≤ 0,1 ms)", e is not None and abs(e) <= 0.1, on)
    # Longueur de note : 2 pas (250 ms à 120 BPM) sur un son de 0,6 s → coupé à 250 ms + relâchement (5 ms).
    steps = one[:]; steps[0] = 110
    page.evaluate(SETUP, {"steps": steps, "dur": 0.6, "params": [[0, 0, "gate", 2]]})
    end = page.evaluate("async () => { const tr = window.__novaMidi.rawTracks().find(t => t.id === 'track-drums'); const b = await window.__qa.render([tr], 1.0, 0); return window.__qa.lastLoud(b, 0, 1.0); }")
    RES["mesure_longueur_2_pas_s"] = {"fin_du_son_s": round(end, 4), "attendu_s": round(2 * step, 4), "relachement_s": 0.005}
    ok(f"longueur de note 2 pas mesurée à l'export : le son s'arrête à {round(2 * step * 1000)} ms (+5 ms de relâchement)", 2 * step - 0.002 <= end <= 2 * step + 0.007, RES["mesure_longueur_2_pas_s"])
    # Probabilité 50 % sur 16 pas × 4 mesures : deux rendus identiques au bit près, coups = notes du clip.
    steps = [110] * 16
    page.evaluate(SETUP, {"steps": steps, "dur": 0.03, "params": [[0, i, "prob", 50] for i in range(16)]})
    pr = page.evaluate("""async () => { const tr = window.__novaMidi.rawTracks().find(t => t.id === 'track-drums');
      const a = await window.__qa.render([tr], 8, 0), b = await window.__qa.render([tr], 8, 0);
      const notes = tr.clips.flatMap(c => (c.notes || []).filter(n => n.pitch === 60 && c.start + n.start < 8)).length;
      return { identiques: window.__qa.same(a, b), coups: window.__qa.onsets(a, 0.02).length, notes }; }""")
    RES["mesure_probabilite"] = pr
    ok(f"probabilité 50 % : deux rendus identiques au bit près, {pr['coups']} coups entendus = {pr['notes']} notes sur 64 pas", pr["identiques"] and pr["coups"] == pr["notes"] and 20 <= pr["notes"] <= 44, pr)
    # Rampe de tempo : 120 → 90 BPM (rampe sur les mesures 2-3) : chaque coup du kick sur sa position musicale.
    steps = one[:]; steps[0] = 110; steps[8] = 110
    page.evaluate(SETUP, {"steps": steps, "dur": 0.02})
    rp = page.evaluate("""async () => {
      const T = await window.__novaAppModule('/utils/tempoMap.ts');
      const st = window.__novaEdit.getState();
      window.__novaTest.update(d => { d.tempoEvents = [{ id: 'qa1', bar: 3, bpm: 90, ramp: true }]; });
      await new Promise(r => setTimeout(r, 1500));
      const s2 = window.__novaEdit.getState();
      const map = T.buildTempoMap(s2.bpm, s2.timeSignature, s2.tempoEvents);
      const tr = s2.tracks.find(t => t.id === 'track-drums');
      const hits = tr.clips.flatMap(c => (c.notes || []).filter(n => n.pitch === 60).map(n => c.start + n.start)).sort((a, b) => a - b).slice(0, 10);
      const err = hits.map((t, k) => (t - T.quartersToTime(map, k * 2)) * 1000);
      window.__novaTest.update(d => { d.tempoEvents = []; });
      return { coups_s: hits.map(t => +t.toFixed(4)), ecart_max_ms: Math.max(...err.map(Math.abs)) };
    }""")
    RES["mesure_rampe_tempo"] = rp
    ok("rampe de tempo (120 → 90 BPM) : chaque coup sur sa position musicale (écart ≤ 0,01 ms)", rp["ecart_max_ms"] <= 0.01 and len(rp["coups_s"]) == 10, rp)


def pc(p):
    b, page, log = open_beat(p)
    t_start = time.time()
    # 1. Menu du pas.
    right_click(page, "button[aria-label^='Snare, pas 5']")
    ok("clic droit sur un pas : menu du pas ouvert", page.locator("[data-testid=drum-menu]").count() == 1)
    page.screenshot(path=str(OUT / "seq_pc_01_menu_pas.png"))
    menu_click(page, "50 %")
    nudge = page.locator("[data-testid=step-nudge] [role=menuitemradio]").nth(3)
    nudge.click(); page.wait_for_timeout(200)
    menu_click(page, "2 pas"); menu_click(page, "+7")
    page.locator("[data-testid=step-glide]").click(); page.wait_for_timeout(200)
    close_menu(page)
    r = row(page, "Snare")
    got = {"pas": r["steps"][4], "prob": (r.get("stepProb") or [None] * 16)[4], "decalage": (r.get("stepNudge") or [None] * 16)[4],
           "longueur": (r.get("stepGate") or [None] * 16)[4], "hauteur": (r.get("stepPitch") or [None] * 16)[4], "glisse": (r.get("stepGlide") or [None] * 16)[4]}
    RES["menu_pas"] = got
    ok("menu du pas : allumé, 50 %, +10 % (13 ms), 2 pas, +7 dt, glisse", got == {"pas": 110, "prob": 50, "decalage": 10, "longueur": 2, "hauteur": 7, "glisse": 1}, got)
    lab = page.locator("button[aria-label^='Snare, pas 5']").first.get_attribute("aria-label")
    ok("le pas l'annonce (lecteur d'écran) : « 50 % », « décalé », « 2 pas », « +7 dt », « glisse »", all(k in lab for k in ("50 %", "décalé", "2 pas", "+7 dt", "glisse")), lab)
    # 2. Graphe : probabilité au glisser sur le kick.
    page.locator(f"{DR} button", has_text=re.compile(r"Kick$")).first.click(); page.wait_for_timeout(200)
    page.locator("[data-testid=graph-param]").select_option("prob"); page.wait_for_timeout(200)
    page.locator("[data-testid=step-graph] [role=slider]").first.scroll_into_view_if_needed(); page.wait_for_timeout(200)
    g = page.locator("[data-testid=step-graph] [role=slider]").first.bounding_box()
    page.mouse.move(g["x"] + 3, g["y"] + g["height"] * 0.75); page.mouse.down(); page.mouse.move(g["x"] + g["width"] - 3, g["y"] + g["height"] * 0.75, steps=20); page.mouse.up(); page.wait_for_timeout(300)
    k = row(page, "Kick")
    probs = [v for i, v in enumerate(k.get("stepProb") or []) if k["steps"][i] > 0]
    RES["graphe_probabilite"] = probs
    ok("graphe « Probabilité » : les pas allumés du kick passent à ~25 % au glisser", bool(probs) and all(20 <= v <= 30 for v in probs), probs)
    page.screenshot(path=str(OUT / "seq_pc_02_graphe_probabilite.png"))
    # 3. Menu du pad : 1/32, 24 pas, M / S.
    right_click(page, f"{DR} [data-row=hatc] button >> nth=0")
    page.screenshot(path=str(OUT / "seq_pc_03_menu_pad.png"))
    page.locator("[data-testid=row-rate] [role=menuitemradio]", has_text="1/32").click(); page.wait_for_timeout(300)
    page.locator("[data-testid=row-steps] [role=menuitemradio]", has_text=re.compile(r"^24$")).click(); page.wait_for_timeout(300)
    close_menu(page)
    h = page.evaluate(ROW, page.evaluate("() => window.__novaEdit.getState().tracks.find(t => t.id === 'track-drums').drumMachine.rows.find(r => r.id === 'hatc').name"))
    ok("menu du pad : résolution 1/32 et 24 pas (polymétrie)", h["rate"] == "32" and h.get("len") == 24 and len(h["steps"]) == 24, {"rate": h.get("rate"), "len": h.get("len")})
    page.locator(f"{DR} button[aria-label='Muet : Kick']").click(); page.wait_for_timeout(200)
    m1 = row(page, "Kick").get("muted")
    page.locator(f"{DR} button[aria-label='Muet : Kick']").click(); page.wait_for_timeout(200)
    ok("bouton M de la rangée : muet puis rétabli", m1 is True and not row(page, "Kick").get("muted"))
    # 4. Raccourcis : Maj + →, Suppr, Ctrl+Z.
    page.locator(f"{DR} button", has_text=re.compile(r"Clap$")).first.click(); page.wait_for_timeout(200)
    a0 = steps16(page, "Clap")
    page.keyboard.press("Shift+ArrowRight"); page.wait_for_timeout(250); a1 = steps16(page, "Clap")
    page.keyboard.press("Delete"); page.wait_for_timeout(250); a2 = steps16(page, "Clap")
    page.keyboard.press("Control+z"); page.wait_for_timeout(300); a3 = steps16(page, "Clap")
    RES["raccourcis_rangee"] = [a0, a1, a2, a3]
    ok("Maj + → décale la rangée d'un pas, Suppr l'efface, Ctrl+Z la rend", a1 == a0[-1] + a0[:-1] and a2 == "." * 16 and a3 == a1, RES["raccourcis_rangee"])
    # 5. Menu ⋯ du motif : doubler jusqu'à 8 mesures, copier / coller, motif suivant.
    for _ in range(3):
        page.locator("[data-testid=pattern-more]").click(); page.wait_for_timeout(200)
        page.locator("[data-testid=pattern-double]").click(); page.wait_for_timeout(300)
    bars = page.evaluate(DM)["bars"]
    ok("⋯ › Doubler la longueur ×3 : motif de 8 mesures (128 pas)", bars == 8 and len(row(page, "Kick")["steps"]) == 128, bars)
    page.screenshot(path=str(OUT / "seq_pc_04_8_mesures.png"))
    page.locator(f"{DR} button", has_text=re.compile(r"Kick$")).first.click()
    page.keyboard.press("Control+c"); page.wait_for_timeout(200)
    kick_a = row(page, "Kick")["steps"]
    page.locator(f"{DR} button", has_text=re.compile(r"^\s*Motif$")).first.click(); page.wait_for_timeout(300)
    empty = sum(1 for v in row(page, "Kick")["steps"] if v)
    page.locator(f"{DR} button", has_text=re.compile(r"Kick$")).first.click()
    page.keyboard.press("Control+v"); page.wait_for_timeout(300)
    ok("Ctrl+C / nouveau motif / Ctrl+V : le motif B reçoit les pas du motif A", empty == 0 and row(page, "Kick")["steps"] == kick_a)
    page.keyboard.press("BracketLeft"); page.wait_for_timeout(250)
    act = page.evaluate("() => { const d = window.__novaEdit.getState().tracks.find(t => t.id === 'track-drums').drumMachine; return d.patterns.find(p => p.id === d.activePattern).name; }")
    ok("[ : motif précédent (A)", act == "A", act)
    # 6. Rythmes publiés.
    page.locator("[data-testid=pattern-more]").click(); page.wait_for_timeout(200)
    page.locator("[data-testid=pattern-recipes]").click(); page.wait_for_timeout(300)
    page.screenshot(path=str(OUT / "seq_pc_05_rythmes_publies.png"))
    page.locator("[data-testid=recipe-boombap-0]").click(); page.wait_for_timeout(400)
    d = page.evaluate(DM)
    kick = "".join("x" if v >= 100 else "o" if v > 0 else "." for v in row(page, "Kick")["steps"][:32])
    RES["recette_boombap"] = {"motifs": len(d["patterns"]), "kick": kick, "swing": d["swing"]}
    ok("rythme publié « Boom bap : kick 1, 7, 11 » [27] dans un nouveau motif : pas identiques à la recette, swing 30 %",
       kick == "x.o...x...x.....x.....x...x....." and d["swing"] == 0.3 and len(d["patterns"]) == 3, RES["recette_boombap"])
    # 7. Fill.
    page.locator("[data-testid=fill-every]").select_option("4"); page.wait_for_timeout(300)
    page.locator("[data-testid=fill-more]").click(); page.wait_for_timeout(200)
    page.screenshot(path=str(OUT / "seq_pc_06_fill.png"))
    page.locator("[data-testid=fill-style] [role=menuitemradio]", has_text="Toms").click(); page.wait_for_timeout(250)
    page.locator("[data-testid=fill-more]").click(); page.wait_for_timeout(200)
    page.locator("[data-testid=fill-crash]").click(); page.wait_for_timeout(250)
    close_menu(page)
    f = page.evaluate(DM)["fill"]
    ok("fill toutes les 4 mesures : toms + roulement, crash après le fill", f == {"every": 4, "style": "toms", "crash": True} or (f.get("every") == 4 and f.get("style") == "toms" and f.get("crash") is True), f)
    # 8. Enregistrement en direct + métronome.
    page.locator("[data-testid=drum-more]").click(); page.wait_for_timeout(200)
    page.locator("[data-testid=drum-metronome]").click(); page.wait_for_timeout(300)
    met = page.evaluate("() => window.__novaEdit.getState().metronome.enabled")
    page.locator("[data-testid=drum-more]").click(); page.wait_for_timeout(200)
    page.locator("[data-testid=drum-metronome]").click(); page.wait_for_timeout(300)
    ok("⋯ › Métronome : allumé puis éteint (la touche O joue un pad quand la batterie est ouverte)", met is True and page.evaluate("() => window.__novaEdit.getState().metronome.enabled") is False)
    page.locator(f"{DR} button", has_text=re.compile(r"Perc$")).first.click()
    page.keyboard.press("Delete"); page.wait_for_timeout(200)
    page.locator("[data-testid=drum-rec]").click(); page.wait_for_timeout(600)
    perc_key = page.evaluate("""() => { const d = window.__novaEdit.getState().tracks.find(t => t.id === 'track-drums').drumMachine;
      const vis = d.rows.filter(r => r.id !== '808' || r.steps.some(v => v > 0)); return ['KeyA','KeyS','KeyD','KeyF','KeyG','KeyH','KeyJ','KeyK','KeyL'][vis.findIndex(r => r.name === 'Perc')]; }""")
    for _ in range(6):
        page.keyboard.press(perc_key); page.wait_for_timeout(330)
    page.keyboard.press("Space"); page.wait_for_timeout(400)
    page.locator("[data-testid=drum-rec]").click(); page.wait_for_timeout(200)
    rec = row(page, "Perc")
    hits = sum(1 for v in rec["steps"] if v > 0)
    RES["enregistrement"] = {"touche": perc_key, "coups_ecrits": hits, "decalages": [v for v in (rec.get("stepNudge") or []) if v]}
    ok("enregistrement en direct : 6 frappes au clavier pendant la lecture → pas écrits, calés sur la grille", hits >= 4 and not RES["enregistrement"]["decalages"], RES["enregistrement"])
    page.screenshot(path=str(OUT / "seq_pc_07_enregistrement.png"))
    # 9. Mesures à l'export.
    mesures_export(page)
    # 10. Beat de 8 mesures : couplet A (recette), variation B (charleys décalés), fill + crash, placement.
    page.locator(f"{DR} button[aria-label='Fermer la batterie']").click(); page.wait_for_timeout(400)
    b.close()
    b, page, log2 = open_beat(p)
    clicks = 1  # le style Trap (déjà cliqué par open_beat)
    t0 = time.time()
    page.locator("[data-testid=pattern-more]").click(); page.locator("[data-testid=pattern-recipes]").click(); page.wait_for_timeout(200)
    page.locator("[data-drum-x], [data-testid=drum-menu] [role=menuitemradio]", has_text=re.compile(r"^Motif A$")).first.click(); page.wait_for_timeout(150)
    page.locator("[data-testid=recipe-trap-0]").click(); clicks += 4; page.wait_for_timeout(300)
    page.locator("[data-testid=pattern-more]").click(); page.locator("[data-testid=pattern-duplicate]").click(); clicks += 2; page.wait_for_timeout(300)
    page.locator(f"{DR} [data-row=hatc] button >> nth=0").click(); page.keyboard.press("Shift+ArrowRight"); clicks += 2; page.wait_for_timeout(250)
    page.locator("[data-testid=fill-every]").select_option("4"); clicks += 1
    page.locator("[data-testid=fill-more]").click(); page.locator("[data-testid=fill-crash]").click(); clicks += 2; page.wait_for_timeout(250)
    close_menu(page)
    # Mesures 5 à 8 peintes avec B (un geste).
    b5 = page.locator("[data-bar='4']").first.bounding_box(); b8 = page.locator("[data-bar='7']").first.bounding_box()
    page.mouse.move(b5["x"] + 8, b5["y"] + 10); page.mouse.down(); page.mouse.move(b8["x"] + 8, b8["y"] + 10, steps=8); page.mouse.up(); clicks += 1
    page.wait_for_timeout(400)
    secs = round(time.time() - t0, 1)
    d = page.evaluate(DM)
    song = [next((p["name"] for p in d["patterns"] if p["id"] == x), "·") for x in (d.get("song") or [])[:8]]
    RES["beat_8_mesures"] = {"gestes_apres": clicks, "secondes_apres_robot": secs, "mesures": song, "fill": d.get("fill"),
                             "gestes_avant_estimes": {"motif publié": "impossible dans la batterie (Démarrer un beat seulement)", "charleys décalés d'un pas": "≈ 12 clics (éteindre / rallumer chaque coup)",
                                                      "crash après le fill": "impossible", "total": "≈ 20 clics et un motif inventé à la main"}}
    ok(f"beat de 8 mesures (A A A A B B B B, fill toutes les 4 mesures + crash) en {clicks} gestes", song == ["A"] * 4 + ["B"] * 4 and d["fill"].get("crash"), RES["beat_8_mesures"])
    page.screenshot(path=str(OUT / "seq_pc_08_beat_8_mesures.png"))
    errs = [e["text"][:160] for e in log.errors() + log2.errors() if not re.search(r"876[56]|ERR_CONNECTION_REFUSED|status of 400", e["text"])]
    ok("PC : aucune erreur de page", not errs, errs)
    b.close()


def petits(p, vp, theme):
    b, page, log = open_beat(p, vp, theme)
    tag = f"seq_{vp}_{theme}"
    page.screenshot(path=str(OUT / f"{tag}_01_panneau.png"))
    over = page.evaluate("() => document.documentElement.scrollWidth - innerWidth")
    ok(f"{vp} {theme} : pas de défilement horizontal de la page", over <= 1, over)
    bal = balayage_chevauchement(page, DR)
    # Le toast de l'appli (« Batterie posée… ») disparaît tout seul : il n'est pas compté.
    rec = [x for x in bal.get("recouverts", []) if "posée" not in json.dumps(x, ensure_ascii=False)]
    ok(f"{vp} {theme} : aucun bouton de la batterie recouvert ({bal.get('boutons')} vérifiés)", not rec, rec[:4])
    sz = page.evaluate(f"""() => {{ const el = document.querySelector("{DR} button[aria-label^='Snare, pas 5']"); const r = el.getBoundingClientRect();
      const nm = document.querySelector("{DR} [data-row=snare] button").getBoundingClientRect(); return {{ pas: [Math.round(r.width), Math.round(r.height)], pad: [Math.round(nm.width), Math.round(nm.height)] }}; }}""")
    RES[f"cibles_{vp}"] = sz
    ok(f"{vp} : cible d'un pas au doigt ≥ 40 × 44 px (relevé {sz['pas'][0]} × {sz['pas'][1]} px), nom du pad {sz['pad'][0]} × {sz['pad'][1]} px", sz["pas"][1] >= 44 and sz["pas"][0] >= 40 and sz["pad"][1] >= 44, sz)
    el = page.locator("button[aria-label^='Snare, pas 5']").first
    el.dispatch_event("contextmenu", {"clientX": 120, "clientY": 300}); page.wait_for_timeout(400)
    page.screenshot(path=str(OUT / f"{tag}_02_menu_pas.png"))
    mb = page.evaluate("() => { const m = document.querySelector('[data-testid=drum-menu]'); if (!m) return null; const r = m.getBoundingClientRect(); const bs = [...m.querySelectorAll('button')].map(b => b.getBoundingClientRect()); return { dans_ecran: r.left >= -1 && r.right <= innerWidth + 1 && r.top >= -1, min_h: Math.min(...bs.map(b => Math.round(b.height))), min_w: Math.min(...bs.map(b => Math.round(b.width))) }; }")
    ok(f"{vp} {theme} : menu du pas dans l'écran, boutons d'au moins 44 px", mb and mb["dans_ecran"] and mb["min_h"] >= 44 and mb["min_w"] >= 44, mb)
    page.locator("[data-testid=step-prob] [role=menuitemradio]", has_text="25 %").click(); page.wait_for_timeout(250)
    ok(f"{vp} : probabilité réglée au doigt (25 %)", (row(page, "Snare").get("stepProb") or [0] * 16)[4] == 25)
    close_menu(page)
    page.locator(f"{DR} [data-row=kick] button").first.dispatch_event("contextmenu", {"clientX": 60, "clientY": 400}); page.wait_for_timeout(400)
    page.screenshot(path=str(OUT / f"{tag}_03_menu_pad.png"))
    ok(f"{vp} : appui long / clic droit sur un pad → menu du pad (mute, solo, résolution…)", page.locator("[data-testid=row-mute]").count() == 1)
    close_menu(page)
    errs = [e["text"][:160] for e in log.errors() if not re.search(r"876[56]|ERR_CONNECTION_REFUSED|status of 400", e["text"])]
    ok(f"{vp} {theme} : aucune erreur de page", not errs, errs)
    b.close()


if __name__ == "__main__":
    with sync_playwright() as p:
        pc(p)
        petits(p, "tab", "light")
        petits(p, "tel390", "dark")
        petits(p, "tel390", "light")
    (OUT / "sequenceur_pro.json").write_text(json.dumps({"resultats": RES, "ko": KO}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n{len(KO)} KO" + (f" : {KO}" if KO else ""))
    sys.exit(1 if KO else 0)
