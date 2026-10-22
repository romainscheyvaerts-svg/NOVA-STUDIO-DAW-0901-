"""Loi de pan pro et double pan des pistes stéréo (22/10/2026), dans le vrai Chrome.

Chrome headless (aucune fenêtre), 100 % hors production (qa_hors_prod via qalib).

A. Son (vrai Web Audio de Chrome, chemin de l'export `AudioEngine.renderProject`) :
   - piste mono : loi −3 dB (centre −3,01 dB, bords 0 dB / rien, somme de puissance 0 dB),
     lois −4,5 / −6 / 0 dB au centre ;
   - piste stéréo G 100 / D 100 : sortie = entrée au BIT près ; G et D au centre = mono −3,01 dB ;
   - ancien projet : pan unique d'une piste stéréo converti en G / D = ancien StereoPannerNode
     de Chrome (même entrée), échantillon par échantillon.
B. Interface (projet de mix ouvert, mode avancé) :
   - PC 1600 × 900 sombre et 1366 × 768 clair : tranche stéréo = boutons G / D, tranche mono =
     un pan ; glisser, double-clic (100G), saisie « 30D », lien en miroir, loi de pan dans
     « Options ▾ » (et Ctrl+Z), en-tête de piste G / D, mode simple = un seul pan ;
   - tablette 1024 × 768 sombre, au doigt : zones de toucher ≥ 44 px ;
   - téléphone 390 × 844 clair : console du téléphone, deux curseurs G / D.

  NOVA_URL=http://127.0.0.1:3550/ PYTHONIOENCODING=utf-8 python qa/pan_console.py
Sorties : D:\\1 WORK\\CONTENU\\nova-pan\\pan_console\\ (pan_console.json + captures)
"""
import io, json, math, os, re, struct, sys, time, wave, zipfile
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3550/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-pan\pan_console")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, OUT, Log, BASE, APP_MODULE_INIT  # noqa: E402  (qa_hors_prod : Supabase simulé, prod bloquée)
from desktop_gate import install_mocks, SUPERADMIN  # noqa: E402
from scenarios import close_welcome  # noqa: E402
from projet_mix import make_mix_project, SR, DUR  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

N = 6
STEREO = "t5"   # « Synthé » : son stéréo (deux canaux différents)
MONO = "t0"     # « Kick » : prise mono
checks = []
res = {"son": {}, "ui": {}}


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("  OK  " if cond else "  KO  ") + name + (f" — {json.dumps(detail, ensure_ascii=False, default=str)[:300]}" if detail is not None else ""), flush=True)


def st(page, expr):
    return page.evaluate(f"() => {{ const s = window.__novaEdit && window.__novaEdit.getState(); return s ? ({expr})(s) : null; }}")


def make_project(path):
    make_mix_project(path, N, name="Pan pro")
    # « Synthé » en stéréo : deux canaux différents (accord à gauche, quinte à droite).
    n = int(SR * DUR)
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(b"".join(struct.pack("<hh", int(9000 * math.sin(2 * math.pi * 330 * i / SR)), int(9000 * math.sin(2 * math.pi * 495 * i / SR))) for i in range(n)))
    src = zipfile.ZipFile(path).read
    names = zipfile.ZipFile(path).namelist()
    files = {k: src(k) for k in names}
    files[f"audio/{STEREO}.wav"] = b.getvalue()
    with zipfile.ZipFile(path, "w") as z:
        for k, v in files.items(): z.writestr(k, v)


SOUND_JS = r"""
async () => {
  const M = p => window.__novaAppModule(p);
  const { audioEngine: e } = await M('/engine/AudioEngine.ts');
  const PL = await M('/utils/panLaw.ts');
  await e.init();
  const sr = 48000, n = sr, A = 0.25, B = 0.1;
  const buf = (chs) => { const b = new AudioBuffer({ numberOfChannels: chs.length, length: n, sampleRate: sr }); chs.forEach((c, i) => b.copyToChannel(c, i)); return b; };
  const sine = (f, a) => Float32Array.from({ length: n }, (_, i) => a * Math.sin(2 * Math.PI * f * i / sr));
  const xl = sine(1000, A), xr = sine(1500, B);
  const tone = (x, f, ref) => { let sc = 0, ss = 0, cc = 0, cs = 0; for (let i = Math.round(0.2 * sr); i < Math.round(0.9 * sr); i++) { const w = 2 * Math.PI * f * i / sr, c = Math.cos(w), s = Math.sin(w); sc += x[i] * c; ss += x[i] * s; cc += c * c; cs += s * s; } const a = Math.hypot(sc / cc, ss / cs) / ref; return a > 1e-9 ? 20 * Math.log10(a) : -Infinity; };
  let k = 0;
  const track = (chs, over) => ({ id: `qa-pan-${++k}`, name: 'P', type: 'AUDIO', color: '#fff', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false, volume: 1, pan: 0,
    outputTrackId: 'master', sends: [], plugins: [], automationLanes: [], totalLatency: 0,
    clips: [{ id: `qa-c-${k}`, name: 'c', type: 'AUDIO', start: 0, duration: 1, offset: 0, buffer: buf(chs), gain: 1, fadeIn: 0, fadeOut: 0, color: '#fff' }], ...over });
  const render = async (t) => { const o = await e.renderProject([t], 1, 0, sr); return [o.getChannelData(0), o.getChannelData(1)]; };
  const out = { mono: [], centres: {}, stereo: {}, ancien: [] };
  const law0 = e.getPanLaw();
  try {
    e.setPanLaw(-3);
    for (const p of [-1, -0.5, 0, 0.5, 1]) {
      const [L, R] = await render(track([xl], { pan: p }));
      const [wl, wr] = PL.panGains(p, -3).map(g => g > 0 ? 20 * Math.log10(g) : -Infinity);
      out.mono.push({ p, gauche: tone(L, 1000, A), droite: tone(R, 1000, A), attendu: [wl, wr] });
    }
    for (const law of [-3, -4.5, -6, 0]) { e.setPanLaw(law); const [L] = await render(track([xl], { pan: 0 })); out.centres[law] = tone(L, 1000, A); }
    e.setPanLaw(-3);
    let [L, R] = await render(track([xl, xr], {}));
    let d = 0; for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(L[i] - xl[i]), Math.abs(R[i] - xr[i]));
    out.stereo.defaut_ecart_max = d;
    const c = PL.withStereoPan(track([xl, xr], {}), 0, 0);
    [L, R] = await render(c);
    out.stereo.centre = { g_gauche: tone(L, 1000, A), g_droite: tone(R, 1000, A), d_gauche: tone(L, 1500, B), d_droite: tone(R, 1500, B) };
    // Ancien pan unique d'une piste stéréo : comparé au StereoPannerNode de Chrome (l'ancien moteur).
    for (const b of [-0.6, -0.2, 0.3, 0.8]) {
      const [Ln, Rn] = await render(track([xl, xr], { pan: b }));
      const ctx = new OfflineAudioContext(2, n, sr); const s = ctx.createBufferSource(); s.buffer = buf([xl, xr]);
      const sp = ctx.createStereoPanner(); sp.pan.value = b; s.connect(sp).connect(ctx.destination); s.start(0);
      const o = await ctx.startRendering(); const Lo = o.getChannelData(0), Ro = o.getChannelData(1);
      let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(Ln[i] - Lo[i]), Math.abs(Rn[i] - Ro[i]));
      out.ancien.push({ b, ecart_max: m });
    }
  } finally { e.setPanLaw(law0); }
  return out;
}
"""


def run_sound(b):
    log = Log("pan_son")
    ctx, page = new_page(b, "pc", log=log)
    page.add_init_script(APP_MODULE_INIT)
    page.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
    install_mocks(page, "romain", SUPERADMIN, {})
    page.goto(BASE, wait_until="domcontentloaded", timeout=120000)
    page.wait_for_timeout(4000)
    page.set_default_timeout(300000)
    r = page.evaluate(SOUND_JS)
    res["son"] = r
    for m in r["mono"]:
        for side, k in (("gauche", 0), ("droite", 1)):
            want, got = m["attendu"][k], m[side]
            ok = (got is None or got < -100) if want is None or want == float("-inf") else abs(got - want) <= 0.01
            check(f"son · mono pan {m['p']:+.1f}, loi −3 dB, {side} : {got if got is None else round(got, 3)} dB (attendu {want if want is None else round(want, 3)})", ok)
        if m["gauche"] is not None and m["droite"] is not None and m["gauche"] > -100 and m["droite"] > -100:
            pw = 10 * math.log10(10 ** (m["gauche"] / 10) + 10 ** (m["droite"] / 10))
            check(f"son · mono pan {m['p']:+.1f} : somme de puissance G² + D² = 0 dB ±0,01", abs(pw) <= 0.01, round(pw, 4))
    for law, want in (("-3", -3.0103), ("-4.5", -4.5154), ("-6", -6.0206), ("0", 0.0)):
        got = r["centres"].get(law)
        check(f"son · loi {law} dB : centre {round(got, 3) if got is not None else got} dB (attendu {want})", got is not None and abs(got - want) <= 0.01)
    check("son · stéréo G 100 / D 100 : sortie = entrée au bit près", r["stereo"]["defaut_ecart_max"] == 0, r["stereo"]["defaut_ecart_max"])
    c = r["stereo"]["centre"]
    check("son · stéréo G et D au centre : chaque canal à −3,01 dB des deux côtés (mono)", all(abs(v + 3.0103) <= 0.01 for v in c.values()), c)
    for a in r["ancien"]:
        check(f"son · ancien pan {a['b']:+.1f} d'une piste stéréo = ancien son (StereoPannerNode de Chrome) : écart max {a['ecart_max']:.2e}", a["ecart_max"] <= 2e-6)
    errs = [e["text"][:200] for e in log.errors() if not re.search(r"876[56]|ERR_CONNECTION_REFUSED", e["text"])]
    check("son · aucune erreur de console", not errs, errs[:3])
    ctx.close()


def open_project(page, zpath, touch=False):
    act = (lambda l: l.tap()) if touch else (lambda l: l.click())
    page.goto(BASE, wait_until="domcontentloaded")
    page.locator("button:visible", has_text=re.compile("Nouveau Projet")).first.wait_for(timeout=90000)
    page.wait_for_function("() => !document.getElementById('loading-screen')", timeout=15000)
    page.wait_for_timeout(300)
    act(page.locator("button:visible", has_text=re.compile("Nouveau Projet")).first)
    page.wait_for_timeout(800); close_welcome(page)
    page.wait_for_function("() => !!window.__novaEdit", timeout=60000)
    act(page.get_by_role("button", name=re.compile("^Ouvrir le menu$")).first); page.wait_for_timeout(300)
    act(page.locator("[role=dialog] button", has_text=re.compile("Ouvrir un projet")).first); page.wait_for_timeout(400)
    act(page.get_by_text(re.compile("Fichier sur l.ordinateur")).first)
    page.set_input_files('input[type=file][accept=".zip,.json"]', str(zpath))
    page.wait_for_function(f"() => window.__novaEdit.getState().tracks.filter(t => t.type === 'AUDIO').length >= {N}", timeout=60000)
    page.wait_for_timeout(1500)
    for _ in range(2): page.keyboard.press("Escape"); page.wait_for_timeout(150)


def open_console(page, touch=False):
    if not touch:
        page.keyboard.press("Control+Equal"); page.wait_for_timeout(600)
    if page.locator("[data-strip-id]").count() < 3:
        act = (lambda l: l.tap()) if touch else (lambda l: l.click())
        act(page.get_by_role("button", name=re.compile("^Ouvrir le menu$")).first); page.wait_for_timeout(300)
        act(page.locator("[role=dialog] button", has_text=re.compile("^Console$")).first)
    page.wait_for_function("() => document.querySelectorAll('[data-strip-id]').length > 3", timeout=15000)
    page.wait_for_timeout(600)


def show_strip(page, tid):
    """Tranche au milieu de la console (le master collé à droite ne la recouvre pas)."""
    page.evaluate(f"() => document.querySelector('[data-strip-id={tid}]').scrollIntoView({{ block: 'nearest', inline: 'center' }})")
    page.wait_for_timeout(400)


def sp(page, tid):
    return st(page, f"s => {{ const t = s.tracks.find(x => x.id === '{tid}'); return t ? {{ pan: t.pan, sp: t.stereoPan || null, link: t.panLink || null }} : null; }}")


def run_pc(page, theme, vp, zpath):
    tag = f"{vp}_{theme}"
    open_project(page, zpath)
    open_console(page)
    page.locator(f"[data-testid=dual-pan-{STEREO}]").first.wait_for(timeout=20000)
    show_strip(page, STEREO)
    page.screenshot(path=str(OUT / f"{tag}_01_console.png"))
    check(f"{tag} · tranche stéréo (Synthé) : boutons G et D", page.locator(f"[data-testid=pan-g-{STEREO}]").count() >= 1 and page.locator(f"[data-testid=pan-d-{STEREO}]").count() >= 1)
    check(f"{tag} · tranche mono (Kick) : un seul pan", page.locator(f"[data-testid=strip-pan-{MONO}] [role=slider]").count() == 1 and page.locator(f"[data-testid=dual-pan-{MONO}]").count() == 0)
    check(f"{tag} · bus : double pan (stéréo)", page.locator("[data-testid=dual-pan-bus-drums]").count() >= 1)
    # Hauteur identique : faders alignés.
    hs = page.evaluate(f"() => ['{STEREO}', '{MONO}'].map(id => Math.round(document.querySelector(`[data-testid=strip-pan-${{id}}]`).getBoundingClientRect().height))")
    check(f"{tag} · zone de pan de même hauteur (mono / stéréo) : faders alignés", hs[0] == hs[1], hs)
    g = page.locator(f"[data-strip-id={STEREO}] [data-testid=pan-g-{STEREO}]").first
    bb = g.bounding_box()
    page.mouse.move(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2); page.mouse.down()
    page.mouse.move(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2 - 60, steps=6); page.mouse.up(); page.wait_for_timeout(300)
    s1 = sp(page, STEREO)
    check(f"{tag} · glisser G vers le haut : le canal gauche va vers la droite (D ne bouge pas)", s1["sp"] and s1["sp"]["l"] > -0.8 and abs(s1["sp"]["r"] - 1) < 1e-9, s1)
    g.dblclick(); page.wait_for_timeout(300)
    s2 = sp(page, STEREO)
    check(f"{tag} · double-clic sur G : 100G (son d'origine)", s2["sp"] and s2["sp"]["l"] == -1, s2)
    page.locator(f"[data-strip-id={STEREO}] [data-testid=pan-d-value-{STEREO}]").first.click()
    inp = page.locator(f"[data-testid=pan-d-input-{STEREO}]").first
    inp.fill("30D"); inp.press("Enter"); page.wait_for_timeout(300)
    s3 = sp(page, STEREO)
    check(f"{tag} · saisie « 30D » sur D : 0,30", s3["sp"] and abs(s3["sp"]["r"] - 0.3) < 1e-9, s3)
    page.screenshot(path=str(OUT / f"{tag}_02_saisie_30D.png"))
    # Lien en miroir (menu ▾), puis glisser G : D bouge en sens inverse.
    page.locator(f"[data-strip-id={STEREO}] [data-testid=pan-menu-{STEREO}]").first.click(); page.wait_for_timeout(400)
    page.screenshot(path=str(OUT / f"{tag}_03_menu_pan.png"))
    page.locator("[data-testid=pan-reset-stereo]").first.click(); page.wait_for_timeout(300)
    page.locator(f"[data-strip-id={STEREO}] [data-testid=pan-menu-{STEREO}]").first.click(); page.wait_for_timeout(400)
    page.locator("[data-testid=pan-link-mirror]").first.click(); page.wait_for_timeout(300)
    s4 = sp(page, STEREO)
    check(f"{tag} · menu ▾ : « Remettre G 100 / D 100 » puis « Liés en miroir »", s4["link"] == "mirror" and s4["sp"] and s4["sp"]["l"] == -1 and s4["sp"]["r"] == 1, s4)
    page.locator(f"[data-strip-id={STEREO}] [data-testid=pan-g-value-{STEREO}]").first.click()
    inp = page.locator(f"[data-testid=pan-g-input-{STEREO}]").first
    inp.fill("40G"); inp.press("Enter"); page.wait_for_timeout(300)
    s5 = sp(page, STEREO)
    check(f"{tag} · lien en miroir : G à 40G met D à 40D (image resserrée)", s5["sp"] and abs(s5["sp"]["l"] + 0.4) < 1e-6 and abs(s5["sp"]["r"] - 0.4) < 1e-6, s5)
    page.screenshot(path=str(OUT / f"{tag}_04_miroir.png"))
    # Loi de pan du projet : « Options ▾ » (barre du haut), une étape d'annulation.
    page.locator("[data-testid=transport-options]").first.click(); page.wait_for_timeout(400)
    page.screenshot(path=str(OUT / f"{tag}_05_options_loi.png"))
    page.locator('[data-testid="pan-law--4.5"]').first.click(); page.wait_for_timeout(400)
    law = st(page, "s => s.panLaw ?? null")
    eng = page.evaluate("async () => (await window.__novaAppModule('/engine/AudioEngine.ts')).audioEngine.getPanLaw()")
    check(f"{tag} · Options ▾ › loi −4,5 dB : projet et moteur", law == -4.5 and eng == -4.5, [law, eng])
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    page.keyboard.press("Control+z"); page.wait_for_timeout(500)
    law2 = st(page, "s => s.panLaw ?? null")
    eng2 = page.evaluate("async () => (await window.__novaAppModule('/engine/AudioEngine.ts')).audioEngine.getPanLaw()")
    check(f"{tag} · Ctrl+Z : loi revenue à −3 dB (moteur aussi)", (law2 in (None, -3)) and eng2 == -3, [law2, eng2])
    # En-tête de piste (vue Pistes, Ctrl+= bascule console / pistes) : G / D compacts sur la piste stéréo, un pan sur la mono.
    page.keyboard.press("Control+Equal"); page.wait_for_timeout(800)
    hdr = page.locator(f"[data-testid=dual-pan-{STEREO}]")
    if hdr.count(): hdr.first.scroll_into_view_if_needed(); page.wait_for_timeout(300)
    page.screenshot(path=str(OUT / f"{tag}_06_entetes.png"))
    check(f"{tag} · en-tête de la piste stéréo : boutons G / D compacts", hdr.count() >= 1 and page.locator(f"[data-strip-id]").count() == 0, hdr.count())
    res["ui"][tag] = {"glisser": s1, "saisie": s3, "miroir": s5, "loi": [law, eng, law2, eng2], "hauteurs_pan": hs, "entete_dual": hdr.count()}


def run_simple(page, zpath):
    tag = "pc_simple"
    open_project(page, zpath)
    page.wait_for_timeout(800)
    page.screenshot(path=str(OUT / f"{tag}_01_entetes.png"))
    check(f"{tag} · mode simple : pas de double pan dans les en-têtes (un seul pan, épuré)", page.locator(f"[data-testid=dual-pan-{STEREO}]").count() == 0)


def run_tab(page, zpath):
    tag = "tab_sombre"
    open_project(page, zpath, touch=True)
    open_console(page, touch=True)
    page.locator(f"[data-testid=dual-pan-{STEREO}]").first.wait_for(timeout=20000)
    show_strip(page, STEREO)
    page.screenshot(path=str(OUT / f"{tag}_01_console.png"))
    sizes = page.evaluate(f"() => ['pan-g-{STEREO}', 'pan-d-{STEREO}'].map(id => {{ const r = document.querySelector(`[data-strip-id={STEREO}] [data-testid=${{id}}]`).getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }})")
    check(f"{tag} · au doigt : boutons G / D, zones de toucher ≥ 44 px", all(w >= 44 and h >= 44 for w, h in sizes), sizes)
    g = page.locator(f"[data-strip-id={STEREO}] [data-testid=pan-g-{STEREO}]").first
    bb = g.bounding_box()
    cdp = page.context.new_cdp_session(page)
    x, y = bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y, "id": 1}]})
    for k in range(1, 7):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y - 10 * k, "id": 1}]}); page.wait_for_timeout(30)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []}); cdp.detach(); page.wait_for_timeout(300)
    s = sp(page, STEREO)
    check(f"{tag} · glisser G au doigt", s["sp"] and s["sp"]["l"] > -0.9, s)
    page.screenshot(path=str(OUT / f"{tag}_02_apres_geste.png"))


def run_tel(page, zpath):
    tag = "tel_clair"
    open_project(page, zpath, touch=True)
    page.locator("[role=navigation] button", has_text=re.compile(r"^\s*Mixer\s*$")).first.tap()
    page.locator(f"[data-testid=mobile-dual-pan-{STEREO}]").first.wait_for(timeout=20000)
    page.locator(f"[data-testid=mobile-dual-pan-{STEREO}]").first.scroll_into_view_if_needed()
    page.wait_for_timeout(400)
    page.screenshot(path=str(OUT / f"{tag}_01_console_tel.png"))
    h = page.evaluate(f"() => Array.from(document.querySelectorAll('[data-testid=mobile-dual-pan-{STEREO}] input[type=range]')).map(i => Math.round(i.getBoundingClientRect().height))")
    check(f"{tag} · téléphone : deux curseurs G / D de 40 px", len(h) == 2 and all(x >= 40 for x in h), h)


def main():
    zpath = OUT / "pan6.zip"; make_project(zpath)
    t0 = time.time()
    with sync_playwright() as p:
        b = launch(p)
        try:
            run_sound(b)
        except Exception as e:
            check("son · déroulé complet", False, f"{type(e).__name__}: {str(e)[:300]}")
        runs = [("pc", "sombre", False), ("pc1366", "clair", False), ("pc", "simple", False), ("tab", "sombre", True), ("tel390", "clair", True)]
        for vp, theme, touch in runs:
            log = Log(f"pan_{vp}_{theme}")
            ctx, page = new_page(b, vp, log=log, touch=touch)
            page.set_default_timeout(20000)
            simple = '1' if theme == "simple" else '0'
            th = 'light' if theme == 'clair' else 'dark'
            page.add_init_script(APP_MODULE_INIT)
            page.add_init_script(f"try {{ localStorage.setItem('nova_welcome_seen', '1'); localStorage.setItem('nova_simple_mode', '{simple}'); localStorage.setItem('nova_theme', '{th}'); }} catch (e) {{}}")
            install_mocks(page, "romain", SUPERADMIN, {})
            try:
                if theme == "simple": run_simple(page, zpath)
                elif vp.startswith("pc"): run_pc(page, theme, vp, zpath)
                elif vp == "tab": run_tab(page, zpath)
                else: run_tel(page, zpath)
            except Exception as e:
                check(f"{vp}_{theme} · déroulé complet", False, f"{type(e).__name__}: {str(e)[:300]}")
                try: page.screenshot(path=str(OUT / f"{vp}_{theme}_ECHEC.png"))
                except Exception: pass
            errs = [e["text"][:200] for e in log.errors() if not re.search(r"876[56]|ERR_CONNECTION_REFUSED", e["text"])]
            check(f"{vp}_{theme} · aucune erreur de console", not errs, errs[:3])
            ctx.close()
        b.close()
    ok = sum(c["ok"] for c in checks)
    res.update({"verifs": checks, "total": f"{ok}/{len(checks)}", "secs": round(time.time() - t0, 1)})
    (OUT / "pan_console.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print(f"\n{ok}/{len(checks)} vérifications")
    sys.exit(0 if ok == len(checks) else 1)


if __name__ == "__main__":
    main()
