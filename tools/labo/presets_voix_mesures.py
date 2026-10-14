"""Labo des presets voix (lot 8a) : calage et mesures sur 3 vraies prises rap du studio,
avec le MOTEUR DE NOVA (rendu hors ligne de l'appli dans Chrome headless, aucune fenêtre,
Supabase simulé par qa_hors_prod).

  NOVA_URL=http://127.0.0.1:3455/ python tools/labo/presets_voix_mesures.py --caler      # écrit utils/voicePresetCalib.ts
  NOVA_URL=http://127.0.0.1:3455/ python tools/labo/presets_voix_mesures.py --mesurer    # mesures finales (JSON + tableau)
  NOVA_URL=http://127.0.0.1:3455/ python tools/labo/presets_voix_mesures.py --macros trap-lead
  NOVA_URL=http://127.0.0.1:3455/ python tools/labo/presets_voix_mesures.py --demos

Prises : séance « 13 mini 22 04 vs 2 » (cabine Make Music), une par couplet, sèches, telles
qu'enregistrées (niveaux d'origine) : REC_220 (couplet A), REC_70 (B), REC_201 (C).
Sortie : D:\\1 WORK\\CONTENU\\nova-bandlab\\lot8_presets\\mesures
"""
import argparse, base64, json, os, sys, time, wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "qa"))
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3455/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-bandlab\lot8_presets\mesures")
from qalib import launch, new_page, BASE, Log  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SESSION = Path(r"D:\1 WORK\2 SESSIONS PROTOOLS\OneDrive\13 mini 22 04 vs 2\Audio Files")
TAKES = ["REC_220.wav", "REC_70.wav", "REC_201.wav"]
# Les prises de la séance sont enregistrées très bas (−49 à −61 LUFS) : gain de clip, comme un ingé
# avant de mixer, à trois niveaux différents d'une prise maison (le calage d'entrée NOVA les ramène).
CLIP_LUFS = [-18.0, -24.0, -21.0]
OUT = Path(os.environ["QA_OUT"])
OUT.mkdir(parents=True, exist_ok=True)
CALIB_TS = ROOT / "utils" / "voicePresetCalib.ts"


def read_wav(path: Path):
    with wave.open(str(path)) as w:
        sr, n, ch, sw = w.getframerate(), w.getnframes(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(n)
    if sw == 2:
        y = np.frombuffer(raw, "<i2").astype(np.float32) / 32768
    elif sw == 3:
        b = np.frombuffer(raw, np.uint8).reshape(-1, 3)
        v = (b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16))
        y = (np.where(v & 0x800000, v - 0x1000000, v) / 8388608).astype(np.float32)
    else:
        y = np.frombuffer(raw, "<f4").astype(np.float32)
    return y.reshape(-1, ch).mean(1).astype(np.float32), sr


def open_lab(p, log):
    browser = launch(p)
    ctx, page = new_page(browser, "pc", log)
    page.set_default_timeout(600000)
    page.goto(BASE, wait_until="domcontentloaded")
    page.wait_for_timeout(2500)
    page.evaluate("async () => { window.__lab = await window.__novaAppModule('/tools/labo/presetsVoixLab.ts'); }")
    for f, lv in zip(TAKES, CLIP_LUFS):
        y, sr = read_wav(SESSION / f)
        info = page.evaluate("([n, b, sr, lv]) => window.__lab.addTake(n, b, sr, lv)", [f[:-4], base64.b64encode(y.tobytes()).decode(), sr, lv])
        print("prise", info, flush=True)
    return browser, page


def write_calib(calibs: dict):
    keep = {}
    if CALIB_TS.exists():
        txt = CALIB_TS.read_text(encoding="utf-8")
        i = txt.find("export const VOICE_PRESET_CALIB")
        try:
            keep = json.loads(txt[txt.index("{", i): txt.rindex("}") + 1])
        except Exception:
            keep = {}
    keep.update(calibs)
    head = CALIB_TS.read_text(encoding="utf-8").split("export const VOICE_PRESET_CALIB")[0]
    body = json.dumps(keep, ensure_ascii=False, indent=1)
    CALIB_TS.write_text(head + "export const VOICE_PRESET_CALIB: Record<string, VoicePresetCalib> = " + body + ";\n", encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--caler", action="store_true")
    ap.add_argument("--mesurer", action="store_true")
    ap.add_argument("--macros", nargs="*")
    ap.add_argument("--demos", action="store_true")
    ap.add_argument("--presets", nargs="*")
    a = ap.parse_args()
    log = Log("presets_voix_labo")
    t0 = time.time()
    with sync_playwright() as p:
        browser, page = open_lab(p, log)
        ids = a.presets or page.evaluate("() => window.__lab.presetIds()")
        if a.caler:
            res = {}
            for pid in ids:
                r = page.evaluate("(id) => window.__lab.calibrate(id)", pid)
                res[pid] = r
                print(json.dumps(r, ensure_ascii=False), flush=True)
                (OUT / "calage_en_cours.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
            # Fusion avec le calage précédent (un recalage partiel garde les autres presets).
            prev = {}
            try: prev = json.loads((OUT / "calage.json").read_text(encoding="utf-8"))
            except Exception: pass
            prev.update(res)
            (OUT / "calage.json").write_text(json.dumps(prev, ensure_ascii=False, indent=1), encoding="utf-8")
        if a.mesurer:
            rows = {}
            for pid in ids:
                rows[pid] = page.evaluate("(id) => window.__lab.measure(id)", pid)
                print(json.dumps(rows[pid], ensure_ascii=False), flush=True)
            (OUT / "mesures_presets.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
        if a.macros is not None:
            res = {}
            for pid in (a.macros or ["trap-lead"]):
                res[pid] = page.evaluate("(id) => window.__lab.measureMacros(id, 1)", pid)
                for r in res[pid]:
                    print(json.dumps(r, ensure_ascii=False), flush=True)
            (OUT / "mesures_macros.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
        if a.demos:
            demos_dir = OUT.parent / "demos"
            demos_dir.mkdir(exist_ok=True)
            plan = [("trap-lead", 0, {}), ("rnb-doux-lead", 2, {}), ("adlib-telephone", 1, {}), ("trap-lead", 0, {"presence": 0.6, "espace": 0.5})]
            for pid, k, macros in plan:
                try:
                    r = page.evaluate("([id, k, m]) => window.__lab.demo(id, k, m)", [pid, k, macros])
                except Exception as e:
                    print("démo impossible", pid, e)
                    continue
                tag = pid + ("_" + "_".join(f"{m}{int(v * 100)}" for m, v in macros.items()) if macros else "")
                (demos_dir / f"{tag}_{TAKES[k][:-4]}_1_avant.wav").write_bytes(base64.b64decode(r["before"]))
                (demos_dir / f"{tag}_{TAKES[k][:-4]}_2_apres.wav").write_bytes(base64.b64decode(r["after"]))
                print("démo", tag, r["lufs"], r["chain"], flush=True)
        browser.close()
    # Écrit APRÈS la fermeture : modifier un module de l'appli recharge la page (Vite).
    if a.caler:
        write_calib({pid: r["calib"] for pid, r in json.loads((OUT / "calage.json").read_text(encoding="utf-8")).items() if pid in ids})
    errs = log.errors()
    (OUT / "journal_labo.json").write_text(json.dumps({"secs": round(time.time() - t0), "erreurs": errs[:50]}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"fini en {round(time.time() - t0)} s, {len(errs)} erreurs console")


if __name__ == "__main__":
    main()
