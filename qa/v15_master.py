"""Scénario V15 (Master Nova + référence) dans un Chrome headless, avec captures.

1. Projet « Faire une instru » (mélodie + batterie), ouverture de Master Nova.
2. Cible Spotify (−14 LUFS) : analyse, rapport avant / après, application.
3. Export : le projet rendu par le moteur d'export (vérification affichée).
4. Lecture : la sortie réelle du master est enregistrée pendant tout le morceau,
   loudness et crête vraie mesurées.
5. A/B avec / sans, puis morceau de référence importé et écouté à niveau égal.
Critère : cible à ±0,5 LU en lecture ET à l'export, crête vraie ≤ plafond.
Usage : NOVA_URL=http://localhost:3417/ python qa/v15_master.py [cible]
"""
import json, math, os, random, re, struct, sys, time, wave
sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault("NOVA_URL", "http://localhost:3417/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-v14-v15")
from qalib import launch, new_page, shot, overflow_report, BASE, OUT  # noqa: E402
from scenarios import close_welcome, wait_text_gone  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

CIBLE = sys.argv[1] if len(sys.argv) > 1 else "spotify"
CIBLES = {"spotify": -14, "apple": -16, "youtube": -14, "deezer": -15, "tiktok": -14, "club": -9}
res = {"cible": CIBLE, "lufs_cible": CIBLES[CIBLE], "etapes": {}}


def ok(k, v, note=None):
    res["etapes"][k] = {"ok": bool(v), **({"detail": note} if note is not None else {})}
    print(("OK  " if v else "KO  ") + k, "" if note is None else note)


def make_reference(path):
    """Référence synthétique « très fort » et stable : bruit rose filtré + accords, 12 s."""
    sr, n = 44100, 44100 * 12
    rnd = random.Random(5)
    b = [0.0] * 7
    with wave.open(path, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr)
        frames = bytearray()
        for i in range(n):
            x = rnd.uniform(-1, 1)
            b[0] = 0.99886 * b[0] + x * 0.0555179; b[1] = 0.99332 * b[1] + x * 0.0750759
            b[2] = 0.96900 * b[2] + x * 0.1538520; b[3] = 0.86650 * b[3] + x * 0.3104856
            pink = (b[0] + b[1] + b[2] + b[3] + x * 0.5362) * 0.11
            t = i / sr
            tone = 0.18 * (math.sin(2 * math.pi * 110 * t) + math.sin(2 * math.pi * 220 * t) + 0.5 * math.sin(2 * math.pi * 330 * t))
            v = max(-0.95, min(0.95, 1.6 * pink + tone))
            s = int(v * 32767)
            frames += struct.pack("<hh", s, s)
        w.writeframes(bytes(frames))


TAP = """async () => {
  // Instance du moteur de l'APPLI (robuste aux rechargements à chaud de Vite, voir qalib).
  const { audioEngine } = await (window.__novaAppModule ? window.__novaAppModule('/engine/AudioEngine.ts') : import('/engine/AudioEngine.ts'));
  const ctx = audioEngine.getAudioContext(), tap = audioEngine.getMasterMeterInput();
  if (!ctx || !tap) return 'pas de moteur';
  if (!window.__cap) {
    const sp = ctx.createScriptProcessor(4096, 2, 2), z = ctx.createGain(); z.gain.value = 0;
    window.__cap = { L: [], R: [], on: false, sr: ctx.sampleRate };
    sp.onaudioprocess = e => { if (!window.__cap.on) return; window.__cap.L.push(new Float32Array(e.inputBuffer.getChannelData(0))); window.__cap.R.push(new Float32Array(e.inputBuffer.getChannelData(1))); };
    tap.connect(sp); sp.connect(z); z.connect(ctx.destination); window.__capNode = sp;
  }
  window.__cap.L = []; window.__cap.R = [];
  return 'ok';
}"""
MEASURE = """async () => {
  const { lufsOf, truePeakOf } = await import('/utils/audioMeasure.ts');
  const c = window.__cap; const n = c.L.reduce((a, x) => a + x.length, 0);
  const L = new Float32Array(n), R = new Float32Array(n); let o = 0;
  c.L.forEach((x, i) => { L.set(x, o); R.set(c.R[i], o); o += x.length; });
  return { secondes: n / c.sr, lufs: lufsOf([L, R], c.sr), crete_vraie: truePeakOf([L, R], 4, 48) };
}"""

with sync_playwright() as p:
    b = launch(p)
    ctx, pg = new_page(b, "pc")
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
    t0 = time.time()
    pg.goto(BASE, wait_until="domcontentloaded")
    pg.get_by_text("Mélodies", exact=False).first.click(timeout=30000); pg.wait_for_timeout(1500)
    pg.get_by_text("Neon Storm", exact=False).first.click(); pg.wait_for_timeout(1500)
    close_welcome(pg); wait_text_gone(pg, "Chargement", 60); pg.wait_for_timeout(1500); close_welcome(pg)
    drums = pg.locator("[aria-labelledby='drums-title']")
    if drums.count():
        cl = drums.locator("button[aria-label^='Fermer'], button[title^='Fermer']")
        (cl.first.click() if cl.count() else pg.keyboard.press("Escape")); pg.wait_for_timeout(600)
    # Boucle coupée : la lecture doit couvrir tout le morceau.
    loop = pg.get_by_role("button", name="Boucle", exact=True)
    if loop.count() and loop.first.get_attribute("aria-pressed") == "true":
        loop.first.click(); pg.wait_for_timeout(300)

    pg.locator("[data-nova-open-master]").first.click(); pg.wait_for_timeout(800)
    shot(pg, "v15_pc_01_master_nova")
    pg.locator(f"[data-nova-cible='{CIBLE}']").first.click()
    pg.locator("[data-nova-master-run]").first.click()
    pg.wait_for_timeout(1500)
    shot(pg, "v15_pc_02_analyse_en_cours")
    pg.locator("[data-nova-master-rapport]").first.wait_for(timeout=240000)
    pg.wait_for_timeout(500)
    rapport = pg.locator("[data-nova-master-rapport]").first.inner_text()
    res["rapport"] = rapport
    m = re.search(r"Loudness.*?\n?.*?([−-]?\d+,\d) LUFS\s+([−-]?\d+,\d) LUFS", rapport.replace("\t", " "), re.S)
    pg.locator("[data-nova-master-rapport] details summary").first.click(); pg.wait_for_timeout(300)
    shot(pg, "v15_pc_03_rapport_avant_apres")
    ok("rapport_cible_atteinte", "Cible atteinte" in rapport, rapport.split("\n")[-6:-3] if rapport else None)

    pg.locator("[data-nova-master-apply]").first.click(); pg.wait_for_timeout(1000)
    chk = pg.locator("[data-nova-master-export]").first
    chk.wait_for(timeout=60000)
    for _ in range(240):
        if chk.get_attribute("data-lufs") and "Vérification" not in chk.inner_text(): break
        pg.wait_for_timeout(500)
    ex_lufs = float(chk.get_attribute("data-lufs")); ex_tp = float(chk.get_attribute("data-tp")); duree = float(chk.get_attribute("data-duree"))
    res["export"] = {"lufs": ex_lufs, "crete_vraie": ex_tp, "duree_s": duree}
    ok("export_a_la_cible_0_5", abs(ex_lufs - CIBLES[CIBLE]) <= 0.5, res["export"])
    ok("export_crete_sous_plafond", ex_tp <= (-0.5 if CIBLE == "club" else -1.0), ex_tp)
    shot(pg, "v15_pc_04_applique_verif_export")

    # A/B
    pg.get_by_role("radio", name=re.compile("B · Sans")).first.click(); pg.wait_for_timeout(800)
    shot(pg, "v15_pc_05_ab_sans")
    ok("ab_sans", pg.get_by_role("radio", name=re.compile("B · Sans")).first.get_attribute("aria-checked") == "true")
    pg.get_by_role("radio", name=re.compile("A · Avec")).first.click(); pg.wait_for_timeout(800)

    # Référence
    ref_path = str(OUT / "reference_synthetique.wav")
    make_reference(ref_path)
    pg.locator("[data-nova-reference] input[type=file]").set_input_files(ref_path)
    info = pg.locator("[data-nova-ref-info]").first
    info.wait_for(timeout=60000)
    for _ in range(120):
        if "écoutée à" in info.inner_text(): break
        pg.wait_for_timeout(500)
    res["reference"] = info.inner_text()
    shot(pg, "v15_pc_06_reference_importee")

    # Écoute de la référence : niveau mesuré à la sortie
    pg.evaluate(TAP)
    pg.locator("[data-nova-ref-play]").first.click(); pg.wait_for_timeout(500)
    pg.evaluate("() => { window.__cap.L = []; window.__cap.R = []; window.__cap.on = true; }")
    pg.wait_for_timeout(6000)
    pg.evaluate("() => { window.__cap.on = false; }")
    ref_live = pg.evaluate(MEASURE)
    shot(pg, "v15_pc_07_ecoute_reference")
    pg.get_by_role("radio", name="Mon mix").first.click(); pg.wait_for_timeout(300)
    res["reference_ecoutee"] = ref_live
    heard = float(info.get_attribute("data-mix-lufs"))
    ok("reference_au_niveau_du_mix", abs(ref_live["lufs"] - heard) <= 0.5, {"reference_lufs_sortie": round(ref_live["lufs"], 2), "mix_entendu_lufs": heard, "mix_export_lufs": ex_lufs})

    # Lecture réelle de tout le morceau (panneau fermé : écoute normale)
    pg.get_by_role("button", name="Fermer", exact=True).last.click(); pg.wait_for_timeout(800)
    pg.evaluate(TAP)
    pg.keyboard.press("Home"); pg.wait_for_timeout(400)
    pg.evaluate("() => { window.__cap.L = []; window.__cap.R = []; window.__cap.on = true; }")
    pg.keyboard.press("Space")
    pg.wait_for_timeout(int((duree + 1.0) * 1000))
    pg.keyboard.press("Space"); pg.wait_for_timeout(300)
    pg.evaluate("() => { window.__cap.on = false; }")
    live = pg.evaluate(MEASURE)
    res["lecture"] = live
    ok("lecture_a_la_cible_0_5", abs(live["lufs"] - CIBLES[CIBLE]) <= 0.5, {k: round(v, 2) for k, v in live.items()})
    ok("lecture_crete_sous_plafond", live["crete_vraie"] <= (-0.5 if CIBLE == "club" else -1.0), round(live["crete_vraie"], 2))
    shot(pg, "v15_pc_08_console_apres")
    res["debordements"] = overflow_report(pg)
    res["erreurs_page"] = errs[:5]
    ctx.close()

    # Téléphone : la fenêtre s'ouvre par le menu et tient dans l'écran
    ctx2, ph = new_page(b, "tel")
    ph.goto(BASE, wait_until="domcontentloaded")
    ph.get_by_text("Mélodies", exact=False).first.click(timeout=30000); ph.wait_for_timeout(1500)
    ph.get_by_text("Neon Storm", exact=False).first.click(); ph.wait_for_timeout(1500)
    close_welcome(ph); wait_text_gone(ph, "Chargement", 60); ph.wait_for_timeout(1200); close_welcome(ph)
    dr = ph.locator("[aria-labelledby='drums-title']")
    if dr.count():
        cl = dr.locator("button[aria-label^='Fermer'], button[title^='Fermer']")
        (cl.first.click() if cl.count() else ph.keyboard.press("Escape")); ph.wait_for_timeout(600)
    menu = ph.locator("button[aria-label*='enu']").first
    try:
        menu.click(timeout=5000); ph.wait_for_timeout(500)
        ph.get_by_role("button", name=re.compile("Master Nova")).first.click(); ph.wait_for_timeout(800)
        shot(ph, "v15_tel_01_master_nova")
        res["tel_debordements"] = overflow_report(ph)
        dlg = ph.locator("[data-nova-master]").first.inner_text()
        mine = [d for d in res["tel_debordements"] if d.get("kind") == "page-hscroll" or (d.get("t") and d["t"][:20] in dlg)]
        ok("telephone_sans_debordement", not mine, mine[:5])
    except Exception as e:  # noqa
        shot(ph, "v15_tel_ECHEC"); ok("telephone_ouverture", False, str(e)[:200])
    ctx2.close()
    b.close()
    res["secs"] = round(time.time() - t0, 1)

open(os.path.join(os.environ["QA_OUT"], f"v15_master_{CIBLE}.json"), "w", encoding="utf-8").write(json.dumps(res, ensure_ascii=False, indent=1))
print("TOTAL", sum(1 for v in res["etapes"].values() if v["ok"]), "/", len(res["etapes"]), "| erreurs page :", res.get("erreurs_page"))
