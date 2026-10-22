"""Voix et flow (lot 11 BandLab) : accordeur + échauffement de la voix et du flow (headless, aucune fenêtre, hors production).

Micro SIMULÉ branché sur l'horloge de l'appli (pas de vraie carte, pas d'ASIO) : le constructeur
AudioContext est observé ; getUserMedia rend un vrai MediaStream (que l'appli doit rendre en fermant),
et createMediaStreamSource de ce flux rend directement le nœud de la « voix » de test (comme un
AudioWorklet simulé : le passage par un MediaStream ajoutait 20 à 40 ms de tampon variable). La voix
joue des sinus, des syllabes « ta », un souffle, des glissandos, calés sur le plan que l'appli publie
(évènement « nova:echauffement » : clics, grille, notes) ; elle arrive avec la latence d'entrée que
l'appli suppose, comme un micro bien calibré.

Bureau 1600 × 900 et téléphone 390 × 844, thèmes sombre et clair :
  1. accordeur : sinus 440 Hz +3 cents → « La3 », +3 cents ; guitare 110 Hz → A2, corde 5 ;
     basse 41,2 Hz → E1, corde 4 ; note tenue notée ; micro rendu en quittant l'onglet ;
  2. flow 90 BPM croches : syllabes à 0 puis 50 ms de retard → écart mesuré (différence ≈ 50 ms),
     tendance « en retard » ; 140 BPM croches et doubles croches ; diction (virelangue) ;
  3. gamme de 5 notes juste puis 30 cents trop bas ; tenue de note ; trilles ; souffle « sss » de 10 s ;
     sirène ; test de tessiture (enregistrée sur l'appareil) ;
  4. démarrage du programme en 1 clic, historique (onglet Progrès), Échap, micro rendu à la fermeture ;
  5. entrées : palette Ctrl+K et barre (bureau), menu du téléphone ;
  6. aucun défilement horizontal, cibles ≥ 44 px au téléphone, aucune erreur console.

NOVA_URL=http://127.0.0.1:3456/ python qa/echauffement.py   (captures : QA_OUT ou D:\\1 WORK\\CONTENU\\nova-bandlab\\lot11_echauffement\\captures)
"""
import json, os, sys, time
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3456/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-bandlab\lot11_echauffement\captures")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402
from qalib import OUT, BASE, Log, new_page, shot  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

RUNS = [("pc", "dark"), ("tel390", "dark"), ("pc", "light"), ("tel390", "light")]
KO = []
MESURES = {}


def ok(name, cond, detail=None):
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:500]}"), flush=True)
    if not cond:
        KO.append(name)


# Micro simulé, sur l'horloge de l'appli.
FAKE_MIC = r"""
(() => {
  const Orig = window.AudioContext;
  if (!Orig || window.__qaCtxs) return;
  const ctxs = [];
  // Le faux micro entre DIRECTEMENT dans le graphe de l'appli (comme un AudioWorklet simulé) : le passage
  // MediaStreamDestination → MediaStreamSource ajoutait 20 à 40 ms de tampon, variable d'une ouverture à l'autre.
  class QACtx extends Orig {
    constructor(...a) { super(...a); ctxs.push(this); }
    createMediaStreamSource(stream) { const m = window.__qaMic; return m && m.stream === stream && m.ctx === this ? m.bus : super.createMediaStreamSource(stream); }
  }
  window.AudioContext = QACtx; window.webkitAudioContext = QACtx;
  window.__qaCtxs = ctxs;
  window.__qaEvents = [];
  window.addEventListener('nova:echauffement', e => window.__qaEvents.push(e.detail));
  window.__qaGum = 0;
  navigator.mediaDevices.getUserMedia = async () => {
    const ctx = ctxs[ctxs.length - 1];
    const dest = ctx.createMediaStreamDestination();
    const bus = ctx.createGain(); bus.connect(dest);
    // Bruit de pièce très faible, en boucle : le « micro » reste actif comme un vrai (un nœud muet
    // n'envoie aucun canal à l'enregistreur, qui sauterait alors les silences).
    const room = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate); const rx = room.getChannelData(0);
    for (let i = 0; i < rx.length; i++) rx[i] = 0.0004 * (Math.random() * 2 - 1);
    const air = ctx.createBufferSource(); air.buffer = room; air.loop = true; air.connect(bus); air.start();
    window.__qaMic = { ctx, bus, stream: dest.stream, nodes: [] };
    window.__qaGum++;
    return dest.stream;
  };
  const M = () => window.__qaMic;
  const outLat = () => { const c = M().ctx; return (c.baseLatency || 0) + (c.outputLatency || 0); };
  const keep = n => { M().nodes.push(n); return n; };
  // Voix : 5 harmoniques (spectre de voyelle grossier).
  const wave = c => c.createPeriodicWave(new Float32Array([0, 0, 0, 0, 0, 0]), new Float32Array([0, 1, 0.5, 0.3, 0.15, 0.08]));
  window.__qaStop = () => { const m = M(); if (!m) return; for (const n of m.nodes) { try { n.stop(); } catch (e) {} } m.nodes = []; };
  /** Son tenu : fréquence fixe (sinus pur, ou dent de scie pour une corde). */
  window.__qaTone = (hz, dur = 30, type = 'sine', amp = 0.3) => {
    const m = M(); const c = m.ctx; const o = keep(c.createOscillator()), g = c.createGain();
    if (type === 'voix') o.setPeriodicWave(wave(c)); else o.type = type;
    o.frequency.value = hz; g.gain.value = amp; o.connect(g); g.connect(m.bus); o.start(); o.stop(c.currentTime + dur);
  };
  /** Chante des notes {t0, t1, midi} (horloge de l'appli), décalées de `cents`. */
  window.__qaSing = (notes, cents = 0, amp = 0.25) => {
    const m = M(); const c = m.ctx; const L = outLat();
    for (const n of notes) {
      const o = keep(c.createOscillator()), g = c.createGain();
      o.setPeriodicWave(wave(c));
      o.frequency.value = 440 * Math.pow(2, (n.midi - 69 + cents / 100) / 12);
      const a = Math.max(c.currentTime, n.t0 + L + 0.04), b = n.t1 + L - 0.02;
      if (b <= a) continue;
      g.gain.setValueAtTime(0, a); g.gain.linearRampToValueAtTime(amp, a + 0.03); g.gain.setValueAtTime(amp, b - 0.03); g.gain.linearRampToValueAtTime(0, b);
      o.connect(g); g.connect(m.bus); o.start(a); o.stop(b + 0.01);
    }
  };
  /** Glissando (sirène) de midi a → b → a sur `dur` s. */
  window.__qaGlide = (at, a, b, dur, amp = 0.25) => {
    const m = M(); const c = m.ctx; const t = Math.max(c.currentTime + 0.05, at);
    const o = keep(c.createOscillator()), g = c.createGain();
    o.setPeriodicWave(wave(c));
    const hz = x => 440 * Math.pow(2, (x - 69) / 12);
    o.frequency.setValueAtTime(hz(a), t); o.frequency.exponentialRampToValueAtTime(hz(b), t + dur / 2); o.frequency.exponentialRampToValueAtTime(hz(a), t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(amp, t + 0.05); g.gain.setValueAtTime(amp, t + dur - 0.05); g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(g); g.connect(m.bus); o.start(t); o.stop(t + dur + 0.02);
  };
  /** Syllabes « ta » aux instants (horloge des clics) + `offset` s, comme l'artiste les entend. */
  window.__qaSyllables = (times, offset = 0, appLatency = null) => {
    const m = M(); const c = m.ctx, sr = c.sampleRate;
    // L'artiste entend le clic avec la latence de sortie, et sa voix arrive avec la latence d'entrée
    // que l'appli suppose (appLatency = sortie + entrée) : la voix part donc à t + appLatency + offset.
    const L = appLatency === null ? outLat() : appLatency;
    const n = Math.round(0.085 * sr), cons = Math.round(0.012 * sr);
    const buf = c.createBuffer(1, n, sr); const x = buf.getChannelData(0);
    let s = 7; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
    for (let i = 0; i < n; i++) {
      if (i < cons) x[i] = 0.35 * rnd() * Math.min(1, i / 48);
      else { const k = i - cons; x[i] = 0.4 * Math.exp(-k / (0.04 * sr)) * (Math.sin(2 * Math.PI * 150 * k / sr) + 0.5 * Math.sin(4 * Math.PI * 150 * k / sr)); }
    }
    for (const t of times) { const b = keep(c.createBufferSource()); b.buffer = buf; b.connect(m.bus); b.start(Math.max(c.currentTime, t + offset + L)); }
  };
  /** Souffle « sss » (bruit filtré) de `dur` s. */
  window.__qaHiss = (at, dur, amp = 0.12) => {
    const m = M(); const c = m.ctx, sr = c.sampleRate;
    const buf = c.createBuffer(1, Math.round(sr * dur), sr); const x = buf.getChannelData(0);
    for (let i = 0; i < x.length; i++) x[i] = amp * (Math.random() * 2 - 1);
    const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 3000;
    const b = keep(c.createBufferSource()); b.buffer = buf; b.connect(f); f.connect(m.bus); b.start(Math.max(c.currentTime, at));
  };
  /** Micro rendu ? (flux arrêté, contexte fermé) */
  window.__qaMicReleased = () => { const m = M(); if (!m) return true; return m.stream.getTracks().every(t => t.readyState === 'ended') && m.ctx.state === 'closed'; };
})();
"""

METRICS = """(phone) => {
  const p = document.querySelector('[data-testid=vocal-warmup]'); if (!p) return null;
  const vis = e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const targets = Array.from(p.querySelectorAll('button, select, summary, a')).filter(vis).filter(e => !e.closest('p'));
  const small = targets.map(e => { const r = e.getBoundingClientRect(); return { t: (e.getAttribute('aria-label') || e.innerText || '').toString().trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) }; })
    .filter(x => Math.min(x.w, x.h) < 44);
  const over = Array.from(p.querySelectorAll('*')).filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > innerWidth + 1 && vis(e); })
    .map(e => (e.className || '').toString().slice(0, 40)).slice(0, 8);
  return { defilement_horizontal: document.documentElement.scrollWidth > innerWidth + 1, hors_ecran: over, cibles: targets.length, petites: small.slice(0, 10), n_petites: small.length };
}"""


def mesure(page, tag, nom, phone, r):
    m = page.evaluate(METRICS, phone)
    r.setdefault("mesures", {})[nom] = m
    if m is None:
        ok(f"{tag} : {nom} affiché", False, None)
        return
    ok(f"{tag} : {nom} sans défilement horizontal", not m["defilement_horizontal"] and not m["hors_ecran"], m)
    if phone:
        ok(f"{tag} : {nom} cibles ≥ 44 px", m["n_petites"] == 0, m["petites"])


def last_plan(page, kind, after):
    page.wait_for_function("([k, n]) => window.__qaEvents.filter(e => e.type === 'plan' && e.kind === k).length > n", arg=[kind, after], timeout=20000)
    return page.evaluate("([k, n]) => window.__qaEvents.filter(e => e.type === 'plan' && e.kind === k)[n]", [kind, after])


def count_plans(page, kind):
    return page.evaluate("(k) => window.__qaEvents.filter(e => e.type === 'plan' && e.kind === k).length", kind)


def result(page, timeout=90000):
    page.wait_for_function("() => { const e = document.querySelector('[data-testid=warmup-exercise]'); return e && e.dataset.phase === 'resultat'; }", timeout=timeout)
    page.wait_for_timeout(250)
    return page.evaluate("""() => { const e = document.querySelector('[data-testid=warmup-exercise]');
      return { id: e.dataset.exercise, score: +e.dataset.score, offset: e.dataset.offsetMs === '' ? null : +e.dataset.offsetMs, value: +e.dataset.value,
        warning: e.dataset.warning === '1', titre: (document.querySelector('[data-testid=warmup-headline]') || {}).innerText }; }""")


def home(page):
    """Retour à la liste des exercices."""
    if page.locator("[data-testid=warmup-home]").count():
        return
    b = page.get_by_role("button", name="Retour aux exercices").first
    b.click(); page.locator("[data-testid=warmup-home]").wait_for(timeout=5000)


def go_card(page, ex_id):
    home(page)
    page.locator(f"[data-exercise-card='{ex_id}'] button[aria-label^='Démarrer']").click()
    page.locator("[data-testid=warmup-exercise]").wait_for(timeout=5000)


def flow(page, ex_id, offset_ms, chips=None, kind="flow", tag="", name=None):
    home(page)
    page.locator(f"[data-exercise-card='{ex_id}'] > button").first.click()   # ouvre (consignes + réglages)
    page.locator("[data-testid=warmup-go]").wait_for(timeout=5000)
    for c in chips or []:
        page.locator(f"[data-chip='{c}']").first.click()
    n = count_plans(page, kind)
    page.locator("[data-testid=warmup-go]").click()
    plan = last_plan(page, kind, n)
    page.evaluate("([g, o, l]) => window.__qaSyllables(g, o, l)", [plan["grid"], offset_ms / 1000, plan["latency"]])
    page.wait_for_function("() => document.querySelector('[data-testid=rhythm-guide]')", timeout=5000)
    if name:
        page.wait_for_timeout(int(max(0.3, plan["rapStart"] - page.evaluate("() => window.__qaMic.ctx.currentTime") + 0.6) * 1000))
        shot(page, name)
    res = result(page)
    res["attendues"] = len(plan["grid"]); res["latence_ms"] = round(plan["latency"] * 1000, 1)
    return res


def pitch_ex(page, ex_id, cents=0, name=None):
    go_card(page, ex_id)
    kind = ex_id
    reps = 1 if ex_id == "tenue" else 3
    n = count_plans(page, kind)
    for r in range(reps):
        plan = last_plan(page, kind, n + r)
        page.evaluate("([s, c]) => window.__qaSing(s, c)", [plan["sing"], cents])
        if name and r == 0:
            page.wait_for_timeout(int((plan["sing"][0]["t0"] - page.evaluate("() => window.__qaMic.ctx.currentTime") + 1.2) * 1000))
            shot(page, name)
    return result(page)


def run(vp, theme, res):
    os.environ["QA_THEME"] = theme
    tag = f"{vp}_{theme}"
    phone = vp.startswith("tel")
    full = tag == "pc_dark"
    log = Log(f"echauffement_{tag}")
    r = {}
    with sync_playwright() as p:
        b = qalib.launch(p)
        ctx, page = new_page(b, vp, log)
        ctx.add_init_script(FAKE_MIC)
        ctx.add_init_script("try { localStorage.removeItem('nova_echauffement_v1'); localStorage.removeItem('nova_tessiture_v1'); localStorage.removeItem('nova_tuner_mode'); } catch (e) {}")
        try:
            # ---------------- Accordeur ----------------
            page.goto(BASE + "?accordeur", wait_until="domcontentloaded")
            page.locator("[data-testid=tuner-panel]").wait_for(timeout=60000)
            page.wait_for_function("() => window.__qaMic", timeout=15000)
            page.evaluate("() => window.__qaTone(440 * Math.pow(2, 3 / 1200), 30)")
            page.wait_for_function("() => document.querySelector('[data-testid=tuner-panel]').dataset.tunerNote === 'La3'", timeout=8000)
            page.wait_for_timeout(1500)
            t = page.evaluate("() => ({ ...document.querySelector('[data-testid=tuner-panel]').dataset })")
            r["accordeur_440_plus3"] = t
            ok(f"{tag} : accordeur, sinus 440 Hz +3 cents → La3 (A4), +3 cents", t.get("tunerNote") == "La3" and t.get("tunerEn") == "A4" and abs(float(t.get("tunerCents") or 99) - 3) <= 1.0, t)
            shot(page, f"{tag}_01_accordeur_la3")
            mesure(page, tag, "accordeur", phone, r)
            hold = page.evaluate("() => document.querySelector('[data-testid=tuner-hold]').dataset.holdScore")
            ok(f"{tag} : note tenue notée", hold not in ("", None) and int(hold) >= 85, hold)
            if full or phone:
                page.evaluate("() => window.__qaStop()")
                page.locator("[data-tuner-mode=guitare]").click()
                page.evaluate("() => window.__qaTone(110, 30, 'sawtooth', 0.2)")
                page.wait_for_function("() => document.querySelector('[data-testid=tuner-panel]').dataset.tunerEn === 'A2'", timeout=8000)
                page.wait_for_timeout(1200)
                g = page.evaluate("() => ({ ...document.querySelector('[data-testid=tuner-panel]').dataset })")
                r["accordeur_guitare_la2"] = g
                ok(f"{tag} : guitare, La2 (110 Hz) → A2, corde 5, juste", g.get("tunerEn") == "A2" and g.get("tunerString") == "5" and abs(float(g.get("tunerCents") or 99)) <= 2, g)
                shot(page, f"{tag}_02_accordeur_guitare")
                page.evaluate("() => window.__qaStop()")
                page.locator("[data-tuner-mode=basse]").click()
                page.evaluate("() => window.__qaTone(41.2034, 30, 'sawtooth', 0.25)")
                page.wait_for_function("() => document.querySelector('[data-testid=tuner-panel]').dataset.tunerEn === 'E1'", timeout=8000)
                page.wait_for_timeout(1000)
                bs = page.evaluate("() => ({ ...document.querySelector('[data-testid=tuner-panel]').dataset })")
                r["accordeur_basse_mi"] = bs
                ok(f"{tag} : basse, Mi grave (41,2 Hz) → E1, corde 4", bs.get("tunerEn") == "E1" and bs.get("tunerString") == "4" and abs(float(bs.get("tunerCents") or 99)) <= 3, bs)
                shot(page, f"{tag}_03_accordeur_basse")
                page.evaluate("() => window.__qaStop()")
                page.locator("[data-tuner-mode=chromatique]").click()
            # Quitter l'onglet : micro rendu
            page.locator("[data-vocal-tab=progres]").click()
            page.wait_for_timeout(600)
            rel = page.evaluate("() => window.__qaMicReleased()")
            ok(f"{tag} : micro rendu en quittant l'accordeur", rel and page.locator("[data-testid=mic-on]").count() == 0, rel)
            shot(page, f"{tag}_04_progres_vide")
            mesure(page, tag, "progres_vide", phone, r)

            # ---------------- Échauffement ----------------
            page.locator("[data-vocal-tab=echauffement]").click()
            page.locator("[data-testid=warmup-home]").wait_for(timeout=5000)
            page.wait_for_timeout(300)
            shot(page, f"{tag}_05_accueil")
            mesure(page, tag, "accueil", phone, r)
            ok(f"{tag} : micro fermé à l'accueil", page.evaluate("() => window.__qaMicReleased()"), None)

            # Flow 90 BPM croches : 0 puis 50 ms de retard
            f0 = flow(page, "flow-90-triolets", 0, chips=["90", "croches"], name=f"{tag}_06_flow_guide")
            shot(page, f"{tag}_07_flow_resultat_0ms")
            mesure(page, tag, "flow_resultat", phone, r)
            f50 = flow(page, "flow-90-triolets", 50, chips=["90", "croches"])
            shot(page, f"{tag}_08_flow_resultat_50ms")
            r["flow_90_croches"] = {"0ms": f0, "50ms": f50}
            MESURES.setdefault(tag, {})["flow_90_croches"] = r["flow_90_croches"]
            ok(f"{tag} : flow 90 BPM, prise calée : écart ≤ 20 ms, score ≥ 85, toutes les syllabes", f0["offset"] is not None and abs(f0["offset"]) <= 20 and f0["score"] >= 85 and not f0["warning"], f0)
            ok(f"{tag} : flow 90 BPM, prise 50 ms en retard : +50 ± 10 ms par rapport à la prise calée, « en retard », score plus bas",
               f50["offset"] is not None and abs((f50["offset"] - f0["offset"]) - 50) <= 10 and "retard" in (f50["titre"] or "") and f50["score"] < f0["score"], [f0, f50])
            if full:
                f20 = flow(page, "flow-90-triolets", 20, chips=["90", "croches"])
                r["flow_90_croches"]["20ms"] = f20
                ok(f"{tag} : flow 90 BPM, 20 ms en retard : +20 ± 8 ms", f20["offset"] is not None and abs((f20["offset"] - f0["offset"]) - 20) <= 8 and f0["score"] > f20["score"] > f50["score"], [f0, f20, f50])
                t3 = flow(page, "flow-90-triolets", 0)
                c140 = flow(page, "flow-140-croches", 0)
                d140 = flow(page, "flow-140-doubles", 0)
                c80 = flow(page, "flow-80-croches", 0)
                r["flow_autres"] = {"90_triolets": t3, "140_croches": c140, "140_doubles": d140, "80_croches": c80}
                MESURES[tag]["flow_autres"] = r["flow_autres"]
                for k, v in r["flow_autres"].items():
                    ok(f"{tag} : flow {k} calé : écart ≤ 20 ms, score ≥ 80", v["offset"] is not None and abs(v["offset"]) <= 20 and v["score"] >= 80, v)
                dic = flow(page, "diction", 0, chips=["chasseur", "85"], kind="diction", name=f"{tag}_09_diction_guide")
                r["diction"] = dic
                ok(f"{tag} : diction (virelangue, 85 BPM) notée", dic["offset"] is not None and abs(dic["offset"]) <= 20 and dic["score"] >= 80, dic)
                shot(page, f"{tag}_10_diction_resultat")
                # Voix
                g0 = pitch_ex(page, "gamme5", 0, name=f"{tag}_11_gamme_live")
                shot(page, f"{tag}_12_gamme_resultat")
                g30 = pitch_ex(page, "gamme5", -30)
                r["gamme5"] = {"juste": g0, "moins30": g30}
                MESURES[tag]["gamme5"] = r["gamme5"]
                ok(f"{tag} : gamme de 5 notes juste : écart ≤ 8 cents, score ≥ 85", g0["value"] <= 8 and g0["score"] >= 85, g0)
                ok(f"{tag} : gamme 30 cents trop basse : écart 30 ± 8 cents, score < 60", abs(g30["value"] - 30) <= 8 and g30["score"] < 60, g30)
                te = pitch_ex(page, "tenue", 0)
                r["tenue"] = te
                ok(f"{tag} : tenue de note juste : écart ≤ 5 cents, score ≥ 85", te["value"] <= 5 and te["score"] >= 85, te)
                tr = pitch_ex(page, "trilles", 10)
                r["trilles"] = tr
                ok(f"{tag} : trilles guidés à +10 cents : écart 10 ± 6 cents", abs(tr["value"] - 10) <= 6, tr)
                # Souffle
                go_card(page, "souffle")
                n = count_plans(page, "souffle")
                pl = last_plan(page, "souffle", n)
                page.evaluate("(t) => window.__qaHiss(t + 0.4, 10)", pl["souffle"])
                page.wait_for_timeout(int((pl["souffle"] - page.evaluate("() => window.__qaMic.ctx.currentTime") + 3) * 1000))
                shot(page, f"{tag}_13_souffle_live")
                so = result(page)
                r["souffle"] = so
                ok(f"{tag} : souffle « sss » de 10 s mesuré 10 ± 1 s", abs(so["value"] - 10) <= 1.0, so)
                shot(page, f"{tag}_14_souffle_resultat")
                # Sirène et tessiture
                go_card(page, "sirene")
                pl = last_plan(page, "sirene", count_plans(page, "sirene"))
                page.evaluate("(t) => window.__qaGlide(t + 0.5, 48, 62, 6)", pl["start"])
                si = result(page)
                r["sirene"] = si
                ok(f"{tag} : sirène de 14 demi-tons mesurée 14 ± 2", abs(si["value"] - 14) <= 2 and si["score"] >= 80, si)
                home(page)
                page.get_by_role("button", name="faire le test (20 s)").click()
                page.locator("[data-testid=warmup-go]").click()
                pl = last_plan(page, "tessiture", count_plans(page, "tessiture"))
                page.evaluate("(t) => window.__qaGlide(t + 0.5, 45, 66, 8)", pl["start"])
                ts = result(page)
                tess = page.evaluate("() => JSON.parse(localStorage.getItem('nova_tessiture_v1') || 'null')")
                r["tessiture"] = {"resultat": ts, "enregistree": tess}
                ok(f"{tag} : tessiture La1 → Fa#3 (45 → 66) retrouvée à ±2 et enregistrée", bool(tess) and abs(tess["low"] - 45) <= 2 and abs(tess["high"] - 66) <= 2, r["tessiture"])
                shot(page, f"{tag}_15_tessiture")
                # Programme en 1 clic
                home(page)
                page.locator("[data-testid=warmup-start-program]").click()
                page.wait_for_function("() => { const e = document.querySelector('[data-testid=warmup-exercise]'); return e && e.dataset.exercise === 'souffle' && e.dataset.phase === 'en-cours'; }", timeout=10000)
                ok(f"{tag} : « Démarrer l'échauffement » lance le 1er exercice en 1 clic", True)
                shot(page, f"{tag}_16_programme")
                page.keyboard.press("Escape"); page.wait_for_timeout(500)
                ok(f"{tag} : Échap arrête l'exercice, micro rendu", page.evaluate("() => window.__qaMicReleased()") and page.locator("[data-testid=vocal-warmup]").count() == 1,
                   page.evaluate("() => document.querySelector('[data-testid=warmup-exercise]')?.dataset.phase"))
            # Progrès
            page.locator("[data-vocal-tab=progres]").click()
            page.wait_for_timeout(400)
            n_prog = page.locator("[data-progress-id]").count()
            hist = page.evaluate("() => JSON.parse(localStorage.getItem('nova_echauffement_v1') || '[]').length")
            r["historique"] = {"cartes": n_prog, "resultats": hist}
            ok(f"{tag} : progrès enregistrés sur l'appareil et affichés", n_prog >= 1 and hist >= 2, r["historique"])
            shot(page, f"{tag}_17_progres")
            mesure(page, tag, "progres", phone, r)
            # Fermeture
            page.keyboard.press("Escape"); page.wait_for_timeout(600)
            ok(f"{tag} : Échap ferme, micro rendu", page.locator("[data-testid=vocal-warmup]").count() == 0 and page.evaluate("() => window.__qaMicReleased()"), None)
        except Exception as e:  # noqa
            r["ERREUR"] = f"{type(e).__name__}: {str(e)[:500]}"
            ok(f"{tag} : scénario complet", False, r["ERREUR"])
            try: shot(page, f"{tag}_ECHEC")
            except Exception: pass
        r["erreurs_console"] = [e["text"][:200] for e in log.errors() if "status of 400" not in e["text"]][:8]
        ok(f"{tag} : aucune erreur dans la console", not r["erreurs_console"], r["erreurs_console"])
        ctx.close(); b.close()
    res[tag] = r


def entrees(vp, res):
    """Entrées depuis le studio : barre et palette Ctrl+K (bureau), menu ☰ (téléphone)."""
    from synthe import make_project, open_project  # noqa
    make_project()
    tag = f"studio_{vp}"
    phone = vp.startswith("tel")
    log = Log(f"echauffement_{tag}")
    r = {}
    with sync_playwright() as p:
        b = qalib.launch(p)
        ctx, page = new_page(b, vp, log)
        ctx.add_init_script(FAKE_MIC)
        try:
            open_project(page)
            page.wait_for_timeout(800)
            if not phone:
                qalib.ouvrir_menu_range(page, "[data-testid=open-warmup]")  # « Options ▾ » (barre allégée)
                btn = page.locator("[data-testid=open-warmup]")
                vis = btn.count() > 0 and btn.first.is_visible()
                if vis:
                    btn.first.click()
                    page.locator("[data-testid=vocal-warmup]").wait_for(timeout=10000)
                    shot(page, f"{tag}_01_depuis_barre")
                    page.keyboard.press("Escape"); page.wait_for_timeout(400)
                ok(f"{tag} : bouton « Voix et flow » dans la barre", vis, vis)
                page.mouse.click(5, 300)
                page.keyboard.press("Control+k")
                page.locator("[data-testid=command-palette]").wait_for(timeout=5000)
                page.keyboard.type("accordeur", delay=20); page.wait_for_timeout(400)
                opt = page.locator("[data-testid=command-palette] [data-palette-id='pal.tuner']")
                ok(f"{tag} : Ctrl+K « Accordeur »", opt.count() > 0, None)
                shot(page, f"{tag}_02_palette")
                opt.first.click()
                page.locator("[data-testid=tuner-panel]").wait_for(timeout=10000)
                page.keyboard.press("Escape"); page.wait_for_timeout(400)
                page.keyboard.press("Control+k")
                page.keyboard.type("échauffement", delay=20); page.wait_for_timeout(400)
                opt2 = page.locator("[data-testid=command-palette] [data-palette-id='pal.warmup']")
                ok(f"{tag} : Ctrl+K « Échauffement voix et flow »", opt2.count() > 0, None)
                page.keyboard.press("Escape")
            else:
                page.locator("button:visible[aria-label='Ouvrir le menu']").first.click(); page.wait_for_timeout(600)
                m = page.locator("[data-testid=menu-warmup]").locator("visible=true")
                t = page.locator("[data-testid=menu-tuner]").locator("visible=true")
                if m.count(): m.first.scroll_into_view_if_needed()
                shot(page, f"{tag}_01_menu")
                ok(f"{tag} : menu du téléphone « Échauffement » et « Accordeur »", m.count() > 0 and t.count() > 0, None)
                if t.count():
                    t.first.click()
                    page.locator("[data-testid=tuner-panel]").wait_for(timeout=10000)
                    page.evaluate("() => window.__qaTone(220, 10)")
                    page.wait_for_timeout(1500)
                    shot(page, f"{tag}_02_accordeur")
                    ok(f"{tag} : accordeur ouvert depuis le menu, La2 lu", page.evaluate("() => document.querySelector('[data-testid=tuner-panel]').dataset.tunerNote") == "La2", None)
        except Exception as e:  # noqa
            r["ERREUR"] = f"{type(e).__name__}: {str(e)[:500]}"
            ok(f"{tag} : scénario complet", False, r["ERREUR"])
            try: shot(page, f"{tag}_ECHEC")
            except Exception: pass
        r["erreurs_console"] = [e["text"][:200] for e in log.errors() if "status of 400" not in e["text"]][:8]
        ok(f"{tag} : aucune erreur dans la console", not r["erreurs_console"], r["erreurs_console"])
        ctx.close(); b.close()
    res[tag] = r


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    res = {}
    only = [a for a in sys.argv[1:] if not a.startswith("--")]
    t0 = time.time()
    for vp, theme in RUNS:
        if only and f"{vp}_{theme}" not in only:
            continue
        run(vp, theme, res)
    for vp in ("pc", "tel390"):
        if only and f"studio_{vp}" not in only:
            continue
        entrees(vp, res)
    res["KO"] = KO
    res["mesures"] = MESURES
    res["duree_s"] = round(time.time() - t0)
    (OUT / "echauffement.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print(f"{'KO' if KO else 'OK'} : {len(KO)} échec(s)")
    sys.exit(1 if KO else 0)


if __name__ == "__main__":
    main()
