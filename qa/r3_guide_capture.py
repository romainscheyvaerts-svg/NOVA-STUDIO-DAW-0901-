"""R3 · Piste guide et capture audio après coup : scénario Chrome headless (aucune fenêtre).

1. Projet : un beat, une voix, une piste GUIDE (carré à 523 Hz, reconnaissable dans le spectre).
2. Guide : entendu à la lecture (sortie réelle du master), coupé d'un geste (G), niveau à part
   (+4,7 dB de 0,7 à 1,2), absent de l'export.
3. Capture après coup (micro simulé de Chrome) : piste armée, lecture depuis 2,0 s SANS REC,
   « Capturer » → prise posée au même endroit qu'une vraie prise REC faite au même point
   (même compensation de latence) ; en boucle, le dernier tour complet est capturé.
4. Captures PC, tablette, téléphone.
Usage : NOVA_URL=http://127.0.0.1:3443/ QA_OUT="D:\\1 WORK\\CONTENU\\nova-r1-r3" python qa/r3_guide_capture.py
"""
import io, json, math, os, re, sys, time, zipfile
from pathlib import Path

MARK = "\nwith sync_playwright() as p:"
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3443/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-r1-r3")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, shot, OUT, overflow_report  # noqa: E402
from desktop_gate import install_mocks, SUPERADMIN  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402
import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402

_r1 = (Path(__file__).parent / "r1_export.py").read_text(encoding="utf-8").split(MARK)[0]
exec(compile(_r1, "r1_export.py", "exec"))   # make_project, open_with_project, open_export_advanced, sel, check, do_export…
_r2 = (Path(__file__).parent / "r2_tempo.py").read_text(encoding="utf-8").split(MARK)[0]
_r2 = _r2.split("res = {")[0] + "\n" + _r2[_r2.index("TAP = "):]  # TAP / ONSETS (capture du master), sans réinitialiser res
exec(compile(_r2, "r2_tempo.py", "exec"))

res = {"etapes": {}, "fichiers": {}}


def ok(k, v, note=None):
    res["etapes"][k] = {"ok": bool(v), **({"detail": note} if note is not None else {})}
    print(("OK  " if v else "KO  ") + k, "" if note is None else json.dumps(note, ensure_ascii=False)[:500])


MASTER_SPECTRUM = """async () => {
  const c = window.__cap; c.node.port.postMessage('off');
  for (let i = 0; i < 100 && !c.blocks; i++) await new Promise(r => setTimeout(r, 20));
  const n = (c.blocks || []).reduce((a, b) => a + b.x.length, 0);
  const x = new Float32Array(n); let o = 0; for (const b of c.blocks || []) { x.set(b.x, o); o += b.x.length; }
  // Énergie à 523,25 Hz (Goertzel) et énergie totale.
  const g = f => { const w = 2 * Math.PI * f / c.sr, k = 2 * Math.cos(w); let s1 = 0, s2 = 0; for (let i = 0; i < n; i++) { const s0 = x[i] + k * s1 - s2; s2 = s1; s1 = s0; } return Math.sqrt(s1 * s1 + s2 * s2 - k * s1 * s2) / Math.max(1, n); };
  let e = 0; for (let i = 0; i < n; i++) e += x[i] * x[i];
  return { guide523: g(523.25), ref262: g(261.6), rms: Math.sqrt(e / Math.max(1, n)), secondes: n / c.sr };
}"""


def clips_of(page, label):
    """Sauvegarde locale du projet et lecture de project.json (positions exactes des clips)."""
    page.keyboard.press("Control+s"); page.wait_for_timeout(800)
    loc = page.get_by_role("button", name=re.compile("(Export local|cet appareil)", re.I)).first
    with page.expect_download(timeout=60000) as dl:
        loc.click()
    path = OUT / f"r3_{label}.zip"
    dl.value.save_as(str(path))
    page.wait_for_timeout(500)
    if page.get_by_role("button", name="Fermer").count():
        page.keyboard.press("Escape")
    z = zipfile.ZipFile(path)
    proj = json.loads(z.read("project.json"))
    return proj, z


def db(x):
    return 20 * math.log10(max(x, 1e-12))


with sync_playwright() as p:
    b = launch(p)
    ctx, page = new_page(b, "pc")
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)[:300]))
    install_mocks(page, "romain", SUPERADMIN, {})
    # Prises brutes (sans « retirer les blancs ») : on compare des positions et des durées.
    page.add_init_script("try { localStorage.setItem('nova_auto_clean', '0'); } catch (e) {}")
    zpath = OUT / "r3_projet_test.zip"
    make_project(zpath)   # beat, voix lead, backs, GUIDE (carré 523 Hz), bus voix, réverbe
    open_with_project(page, zpath)
    page.mouse.click(900, 600)
    shot(page, "r3_00_guide_pc")
    ok("pastille GUIDE sur la piste et bouton GUIDE dans la barre", page.get_by_test_id("guide-pill-guide").count() == 1 and page.get_by_test_id("guide-toggle").count() == 1)

    # --- Guide entendu, coupé d'un geste, niveau à part ---
    def play_measure(secs=2.0):
        page.keyboard.press("Home"); page.wait_for_timeout(150)
        page.evaluate(TAP)
        page.keyboard.press("Space"); page.wait_for_timeout(int(secs * 1000)); page.keyboard.press("Space"); page.wait_for_timeout(200)
        return page.evaluate(MASTER_SPECTRUM)
    on = play_measure()
    page.keyboard.press("g"); page.wait_for_timeout(300)
    off = play_measure()
    ok("guide entendu à la lecture puis coupé par G (raie à 523 Hz : présente, puis −40 dB au moins)", on["guide523"] > 1e-3 and db(off["guide523"]) < db(on["guide523"]) - 40,
       {"avec_guide_dB": round(db(on["guide523"]), 1), "guide_coupe_dB": round(db(off["guide523"]), 1)})
    page.keyboard.press("g"); page.wait_for_timeout(300)
    page.get_by_test_id("guide-level-open").click(); page.wait_for_timeout(300)
    shot(page, "r3_01_niveau_guide_pc")
    page.evaluate("""() => { const el = document.querySelector('[data-testid=guide-level]');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, '1.0');
      el.dispatchEvent(new Event('input', { bubbles: true })); }""")
    page.wait_for_timeout(300)
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    loud = play_measure()
    gain = db(loud["guide523"]) - db(on["guide523"])
    ok("niveau du guide réglé à part : 0,7 → 1,0 = +3,1 dB (±0,3), la voix du mix ne bouge pas (±0,5 dB, limiteur du master)", abs(gain - 20 * math.log10(1.0 / 0.7)) < 0.3 and abs(db(loud["ref262"]) - db(on["ref262"])) < 0.5,
       {"gain_guide_dB": round(gain, 2), "voix_262_dB_avant": round(db(on["ref262"]), 1), "apres": round(db(loud["ref262"]), 1)})

    # --- Guide absent de l'export (mix WAV) même rallumé et fort ---
    f = do_export(page, "r3_mix_avec_guide_allume", bits="24", sr=48000, tail="cut")
    x, srx = sf.read(str(f), dtype="float64", always_2d=True)
    spec = np.abs(np.fft.rfft(x[:, 0])); fr = np.fft.rfftfreq(x.shape[0], 1 / srx)
    ok("export : guide absent même allumé (pas de raie à 523 Hz)", spec[(fr > 515) & (fr < 531)].max() < spec[(fr > 250) & (fr < 270)].max() * 0.01)

    # --- Capture après coup ---
    page.evaluate("() => { window.__aligned = []; window.addEventListener('nova:take-aligned', e => window.__aligned.push(e.detail)); }")
    page.get_by_role("button", name="Armer l'enregistrement : Voix lead").first.click(); page.wait_for_timeout(1500)
    shot(page, "r3_02_piste_armee_bouton_capturer_pc")
    ok("bouton CAPTURER visible quand une piste est armée", page.get_by_test_id("capture-take").count() == 1)
    # Vraie prise REC depuis 2,0 s (référence de placement)
    page.keyboard.press("Home"); page.keyboard.press("."); page.wait_for_timeout(200)
    page.keyboard.press("r"); page.wait_for_timeout(400)
    if page.get_by_role("button", name=re.compile("Non, haut-parleurs")).count():
        page.get_by_role("button", name=re.compile("Non, haut-parleurs")).first.click()
    page.wait_for_timeout(7000)   # décompte d'une mesure (2 s) + prise ~4 s
    page.keyboard.press("r"); page.wait_for_timeout(2500)
    # Freestyle SANS REC depuis 2,0 s, puis « Capturer »
    page.keyboard.press("Home"); page.keyboard.press("."); page.wait_for_timeout(200)
    page.keyboard.press("Space"); page.wait_for_timeout(3000); page.keyboard.press("Space"); page.wait_for_timeout(500)
    page.get_by_test_id("capture-take").click(); page.wait_for_timeout(2500)
    shot(page, "r3_03_prise_capturee_pc")
    note = page.evaluate("() => document.body.innerText.match(/Capturée[^\\n]*/)?.[0] || null")
    proj, z = clips_of(page, "apres_capture")
    voix = next(t for t in proj["tracks"] if t["id"] == "voix")
    takes = sorted([c for c in voix["clips"] if c.get("takeNumber")], key=lambda c: c["takeNumber"])
    rec_take, cap_take = (takes[-2], takes[-1]) if len(takes) >= 2 else (None, None)
    al = page.evaluate("() => window.__aligned")
    rec_al = next((a for a in al if not a.get("capture")), None); cap_al = next((a for a in al if a.get("capture")), None)
    # Même règle de placement : position de lecture (2,000 s) moins la latence mesurée pendant le passage.
    ok("capture posée comme une prise : lecture à 2,000 s moins sa latence mesurée (±1 ms), comme la vraie prise REC", rec_take and cap_take and rec_al and cap_al
       and abs(rec_take["start"] + rec_al["sec"] - 2.0) < 0.001 and abs(cap_take["start"] + cap_al["sec"] - 2.0) < 0.001,
       {"prise_REC": {"debut": rec_take and round(rec_take["start"], 5), "latence_ms": rec_al and round(rec_al["sec"] * 1000, 2)},
        "capture": {"debut": cap_take and round(cap_take["start"], 5), "latence_ms": cap_al and round(cap_al["sec"] * 1000, 2)},
        "ecart_entre_les_deux_ms": rec_take and cap_take and round((cap_take["start"] - rec_take["start"]) * 1000, 2), "notification": note})
    ok("capture : durée du passage joué (≈ 3 s), rangée en nouvelle prise (couloir)", cap_take and 2.5 < cap_take["duration"] < 3.6 and cap_take["takeNumber"] == rec_take["takeNumber"] + 1,
       {"duree": cap_take and round(cap_take["duration"], 3), "prise": cap_take and cap_take["takeNumber"]})
    if cap_take:
        a, srr = sf.read(io.BytesIO(z.read(cap_take["audioRef"])), dtype="float64", always_2d=True)
        ok("capture : le son du micro est bien là (pas un silence)", float(np.sqrt(np.mean(a ** 2))) > 1e-3, {"rms_dBFS": round(db(float(np.sqrt(np.mean(a ** 2)))), 1)})

    # Boucle 2,0 → 6,0 s : un tour complet + 0,25 s, puis capture → le dernier tour complet (4,0 s)
    page.keyboard.press("l"); page.wait_for_timeout(200)
    page.keyboard.press("Home"); page.keyboard.press("."); page.wait_for_timeout(200)
    page.keyboard.press("Space"); page.wait_for_timeout(4250); page.keyboard.press("Space"); page.wait_for_timeout(400)
    page.get_by_test_id("capture-take").click(); page.wait_for_timeout(2500)
    page.keyboard.press("l")
    proj2, _ = clips_of(page, "apres_capture_boucle")
    voix2 = next(t for t in proj2["tracks"] if t["id"] == "voix")
    loop_al = [a for a in page.evaluate("() => window.__aligned") if a.get("capture")][-1]
    last = max((c for c in voix2["clips"] if c.get("takeNumber")), key=lambda c: c["takeNumber"])
    ok("en boucle : le dernier tour complet est capturé (4,0 s, posé au début de la boucle moins la latence)", abs(last["duration"] - 4.0) < 0.01 and abs(last["start"] + loop_al["sec"] - 2.0) < 0.001,
       {"debut": round(last["start"], 5), "duree": round(last["duration"], 3), "latence_ms": round(loop_al["sec"] * 1000, 2)})

    # --- Tablette / téléphone ---
    for vp in ("tab", "tel"):
        c2, p2 = new_page(b, vp)
        install_mocks(p2, "romain", SUPERADMIN, {})
        try:
            open_with_project(p2, zpath)
            shot(p2, f"r3_04_guide_{vp}")
            if vp == "tel":
                p2.locator("button[aria-label='Activer le micro']").nth(1).click(); p2.wait_for_timeout(1500)
                p2.locator("button:visible[aria-label='Ouvrir le menu']").first.click(); p2.wait_for_timeout(500)
                shot(p2, "r3_05_menu_capture_guide_tel")
                res["menu_tel"] = {"capture": p2.get_by_test_id("menu-capture").count(), "guide": p2.get_by_test_id("menu-guide").count()}
            res[f"debordements_{vp}"] = overflow_report(p2)
        except Exception as e:
            res[f"erreur_{vp}"] = str(e)[:300]
        c2.close()
    ok("téléphone : « Capturer la dernière prise » et « Couper le guide » dans le menu", res.get("menu_tel") == {"capture": 1, "guide": 1}, res.get("menu_tel"))
    page.evaluate("document.documentElement.setAttribute('data-theme', 'light')")
    page.wait_for_timeout(300)
    shot(page, "r3_06_guide_capture_pc_clair")
    res["erreurs_page"] = errs[:5]
    ok("pas d'erreur dans la page", not errs, errs[:3])
    b.close()

(OUT / "r3_resultats.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
print("\nBILAN :", sum(1 for v in res["etapes"].values() if v["ok"]), "/", len(res["etapes"]), "OK")
