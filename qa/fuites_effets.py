"""Fuites de nœuds audio : changer d'effet 120 fois et enregistrer 6 prises, puis compter
les nœuds audio encore vivants après un ramasse-miettes forcé (CDP).

Passe par l'interface de l'appli (DAW_CONTROL), donc comparable entre deux versions
construites (avant : port 3443, après : port 3444).

  PYTHONIOENCODING=utf-8 python qa/fuites_effets.py http://127.0.0.1:3443/ avant
  PYTHONIOENCODING=utf-8 python qa/fuites_effets.py http://127.0.0.1:3444/ apres
Résultat : D:\\1 WORK\\CONTENU\\nova-stabilite\\fuites_effets_<label>.json
"""
import json, os, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-stabilite")
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3442/"
LABEL = sys.argv[2] if len(sys.argv) > 2 else "essai"
os.environ["NOVA_URL"] = URL
from qalib import OUT, CHROME, FAKE_WAV, Log, new_page  # noqa: E402
from gel_pre_effet import prepare  # noqa: E402
from endurance import INIT, CTX_HOOK, open_project as open_heavy  # noqa: E402
from recuperation_plantage import make_project  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

POOL = ["LOFI", "DJFILTER", "GATEFX", "CHORUS", "DELAY", "VOCALSATURATOR", "COMPRESSOR", "PROEQ12", "REVERB", "DOUBLER", "STEREOSPREADER", "DEESSER", "FLANGER", "HARMONIZER", "TIMEFX"]

COUNT = """() => { const S = window.__soak; return { vivants: S.created - S.finalized,
  par_type: Object.fromEntries(Object.entries(S.liveByType).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])) }; }"""


def run():
    proj = OUT / "recuperation_projet.novaproj.zip"
    make_project(proj)
    res = {"url": URL, "label": LABEL, "date": time.strftime("%Y-%m-%d %H:%M")}
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, executable_path=CHROME, args=[
            "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={FAKE_WAV}",
            "--autoplay-policy=no-user-gesture-required"])
        log = Log(f"fuites_{LABEL}")
        ctx, page = new_page(b, "pc", log)
        prepare(page, None, desktop=False)
        ctx.add_init_script(INIT)
        ctx.add_init_script(CTX_HOOK)
        cdp = ctx.new_cdp_session(page)

        def gc():
            for _ in range(3):
                cdp.send("HeapProfiler.collectGarbage"); page.wait_for_timeout(500)

        page.goto(URL, wait_until="domcontentloaded")
        page.get_by_text("Charger Projet").first.wait_for(timeout=40000)
        page.get_by_text("Charger Projet").first.click(); page.wait_for_timeout(700)
        with page.expect_file_chooser(timeout=8000) as fc:
            page.get_by_text("Charger depuis l'ordinateur").first.click()
        fc.value.set_files(str(proj))
        for _ in range(40):
            page.wait_for_timeout(500)
            if page.evaluate("() => !!(window.DAW_CONTROL && window.DAW_CONTROL.getState().tracks.some(t => t.id === 'rec'))"): break
        page.wait_for_timeout(2000)
        gc(); res["depart"] = page.evaluate(COUNT)
        for i in range(120):
            page.evaluate("""([i, pool]) => { const s = window.DAW_CONTROL.getState(); const t = s.tracks.find(x => x.id === 'guitare');
              const pl = [0, 1, 2].map(k => ({ id: 'fx-' + i + '-' + k, type: pool[(i + k * 5) % pool.length], name: pool[(i + k * 5) % pool.length], isEnabled: true, params: {} }));
              window.DAW_CONTROL.updateTrack({ ...t, plugins: pl }); }""", [i, POOL])
            page.wait_for_timeout(40)
        page.wait_for_timeout(1500)
        gc(); res["apres_120_changements_effet"] = page.evaluate(COUNT)
        page.evaluate("() => { const s = window.DAW_CONTROL.getState(); const t = s.tracks.find(x => x.id === 'rec'); window.DAW_CONTROL.updateTrack({ ...t, isTrackArmed: true }); }")
        page.wait_for_timeout(1500)
        ok = 0
        for _ in range(6):
            page.evaluate("() => window.DAW_CONTROL.toggleRecord()"); page.wait_for_timeout(1500)
            ok += 1 if page.evaluate("() => window.DAW_CONTROL.getState().isRecording") else 0
            page.evaluate("() => window.DAW_CONTROL.toggleRecord()"); page.wait_for_timeout(1200)
        res["prises_demarrees"] = ok
        page.wait_for_timeout(1500)
        gc(); res["apres_6_prises"] = page.evaluate(COUNT)
        res["erreurs"] = [e["text"][:200] for e in log.errors()][:10]
        ctx.close(); b.close()
    d, a = res["depart"], res["apres_120_changements_effet"]
    res["fuite_par_changement"] = round((a["vivants"] - d["vivants"]) / 120, 2)
    res["worklets_vivants"] = {k: v["par_type"].get("AudioWorklet", 0) for k, v in res.items() if isinstance(v, dict) and "par_type" in v}
    (OUT / f"fuites_effets_{LABEL}.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: res[k] for k in ("label", "fuite_par_changement", "worklets_vivants", "prises_demarrees")}, ensure_ascii=False))
    print({k: v["vivants"] for k, v in res.items() if isinstance(v, dict) and "vivants" in v})


if __name__ == "__main__":
    run()
