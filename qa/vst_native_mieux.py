#!/usr/bin/env python3
"""
Hôte VST3 natif : ce que pedalboard ne sait pas faire, prouvé sur les vrais plugins
par le vrai pont (vst_host : Slot.process_block, render_offline).

  sidechain   Pro-C 3 en « External », clé = kick, signal = basse 808 continue :
              réduction mesurée à chaque kick, en lecture (blocs de 128 avec la clé,
              comme les trames à 4 canaux du DAW) ET à l'export (RENDER avec la clé) ;
              lecture = export à l'échantillon près. Même chose avec pedalboard (0 dB :
              il coupe les bus side-chain).
  automation  palier de « output_level » (0 → −12 dB) à l'échantillon 96 000 (et
              96 037, hors de toute grille de bloc) : premier échantillon modifié,
              à l'export et en lecture (changement dans la trame, décalage dans le bloc).
  ruby2       RUBY2 (Acustica, fait planter pedalboard) chargé, réglé, traité : s'il
              plante, seul son processus tombe ; le pont traite encore un autre plugin.
  waves       temps de lecture du WaveShell (725 classes) et de chargement de C6.

Usage : python qa/vst_native_mieux.py all [--out DIR]
        python qa/vst_native_mieux.py run --engine native|pedalboard --test NOM --out DIR
"""

import argparse
import json
import os
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vst_native_parite as par  # noqa: E402

SR = 48000
PROC3 = par.PLUGINS["proc3"]["path"]


def bass_and_kick(seconds=4.0):
    import numpy as np
    n = int(seconds * SR)
    t = np.arange(n) / SR
    bass = 0.35 * np.sin(2 * np.pi * 49.0 * t) * (1 - np.exp(-t * 30))       # 808 tenue
    key = np.zeros(n)
    kicks = list(range(int(0.25 * SR), n - SR // 4, SR // 2))
    for k0 in kicks:
        m = min(n - k0, SR // 6)
        tt = np.arange(m) / SR
        key[k0:k0 + m] += 0.9 * np.sin(2 * np.pi * (55 + 150 * np.exp(-tt * 35)) * tt) * np.exp(-tt * 18)
    main = np.vstack([bass, bass]).astype(np.float32)
    keyst = np.vstack([key, key]).astype(np.float32)
    return main, keyst, kicks


def gr_per_kick(x, y, kicks):
    """Réduction (dB) au plus fort de chaque kick : niveau d'entrée − niveau de sortie
    (fenêtres de 5 ms), max sur les 120 ms qui suivent le kick ; et la même mesure entre deux
    kicks (250–450 ms après) pour vérifier que la basse revient."""
    import numpy as np
    w = int(0.005 * SR)

    def lvl(a, i):
        seg = a[:, i:i + w]
        return 20 * np.log10(np.sqrt(np.mean(seg.astype(np.float64) ** 2)) + 1e-12)
    out = []
    for k0 in kicks:
        hits = [lvl(x, i) - lvl(y, i) for i in range(k0, k0 + int(0.12 * SR), w)]
        rest = [lvl(x, i) - lvl(y, i) for i in range(k0 + int(0.25 * SR), k0 + int(0.45 * SR), w)]
        out.append({"at": k0, "gr_db": round(max(hits), 2), "between_db": round(float(np.median(rest)), 2)})
    return out


def first_change(a, b, tol=1e-7):
    import numpy as np
    n = min(a.shape[1], b.shape[1])
    d = np.max(np.abs(a[:, :n] - b[:, :n]), axis=0)
    idx = np.nonzero(d > tol)[0]
    return int(idx[0]) if idx.size else None


def run(engine, test, out):
    os.environ["NOVA_VST_ENGINE"] = engine
    os.environ.setdefault("NOVA_VST_HOST_PRIORITY", "below_normal")
    os.environ.setdefault("NOVA_GUARD_FILE", os.path.join(out, "plugin_guard.json"))
    sys.path.insert(0, par.BRIDGE)
    par.below_normal()
    import numpy as np
    import vst_host
    vst_host.LOAD_TIMEOUT_S = 1200.0
    # Machine très chargée (Pro Tools, autres agents) et processus en priorité « inférieure à la
    # normale » : des minutes sans processeur. Délais du banc allongés (pas ceux du pont).
    import vst_native
    vst_native.CALL_TIMEOUT_S = 1800.0
    vst_native.PROCESS_TIMEOUT_S = 1800.0
    _rs = vst_host.JuceThread.run_sync
    vst_host.JuceThread.run_sync = lambda self, fn, *a, timeout=1800.0: _rs(self, fn, *a, timeout=max(timeout, 1800.0))
    juce = vst_host.JuceThread()
    res = {"engine": engine, "test": test}
    logf = open(os.path.join(out, f"{test}.{engine}.log"), "w", encoding="utf-8")

    def log(m):
        logf.write(f"{time.strftime('%H:%M:%S')} {m}\n")
        logf.flush()
    threading.Thread(target=par.license_clicker, args=(log,), daemon=True).start()

    def proc3_slot(items):
        s = vst_host.Slot("sc", PROC3, None, SR, juce)
        s.load(None)
        r = s.set_parameters(items)
        return s, r

    def work():
        try:
            if test == "sidechain":
                main, key, kicks = bass_and_kick()
                items = [{"name": "side_chain_input", "text": "External"}, {"name": "threshold", "real": -30.0},
                         {"name": "ratio", "text": "8:1"}, {"name": "attack", "real": 0.5},
                         {"name": "release", "real": 60.0}, {"name": "auto_gain", "text": "Off"},
                         {"name": "side_chain_eq_band_1_used", "text": "Unused"}, {"name": "knee", "real": 0.0}]
                s, r = proc3_slot(items)
                res["applied"] = [(x["name"], x.get("text"), x.get("ok")) for x in r["results"]]
                res["sidechain_inputs"] = s.sidechain_inputs
                state = s.get_state()
                # Lecture : blocs de 128 avec la clé (trame à 4 canaux du DAW)
                blocks = []
                for a in range(0, main.shape[1], vst_host.BLOCK):
                    blocks.append(s.process_block(main[:, a:a + vst_host.BLOCK], None, key[:, a:a + vst_host.BLOCK]))
                live = np.concatenate(blocks, axis=1)
                lat = s.latency_samples
                res["key_blocks"] = s.key_blocks
                s.unload()
                # Export : RENDER avec la clé
                exp = vst_host.render_offline(juce, PROC3, None, state, main, SR, 0.0, None, None, key)
                live_al = live[:, lat:]
                res["latency"] = lat
                res["live_gr"] = gr_per_kick(main[:, :live_al.shape[1]], live_al, kicks)
                res["export_gr"] = gr_per_kick(main, exp, kicks)
                n = min(live_al.shape[1], exp.shape[1])
                d = float(np.max(np.abs(live_al[:, :n] - exp[:, :n])))
                res["live_vs_export"] = {"identical": d == 0.0, "peak_db": None if d == 0 else round(20 * np.log10(d), 1),
                                         "samples": n}
                np.save(os.path.join(out, f"sidechain.{engine}.live.npy"), live)
                np.save(os.path.join(out, f"sidechain.{engine}.export.npy"), exp)
            elif test == "automation":
                main, _key, _k = bass_and_kick()
                tone = main * 0 + np.vstack([0.3 * np.sin(2 * np.pi * 440 * np.arange(main.shape[1]) / SR)] * 2).astype(np.float32)
                s, r = proc3_slot([{"name": "ratio", "text": "1:1"}, {"name": "auto_gain", "text": "Off"}])
                lo = s.set_parameters([{"name": "output_level", "real": -12.0}])["results"][0]
                hi = s.set_parameters([{"name": "output_level", "real": 0.0}])["results"][0]
                res["values"] = {"0 dB": hi, "-12 dB": lo}
                state = s.get_state()
                ref = vst_host.render_offline(juce, PROC3, None, state, tone, SR, 0.0)
                for at in (96000, 96037):
                    auto = [{"name": "output_level", "frames": [0, at], "values": [hi["value"], lo["value"]]}]
                    y = vst_host.render_offline(juce, PROC3, None, state, tone, SR, 0.0, None, auto)
                    res[f"export_first_change_{at}"] = first_change(ref, y)
                    np.save(os.path.join(out, f"automation.{engine}.export{at}.npy"), y)
                    # niveau juste avant / juste après le palier (dB, rapport sortie / référence)
                    a0 = y[:, at - 480:at]
                    a1 = y[:, at + 4800:at + 9600]
                    res[f"export_level_{at}"] = [round(20 * np.log10(np.sqrt(np.mean(a0 ** 2)) / np.sqrt(np.mean(ref[:, at - 480:at] ** 2))), 2),
                                                 round(20 * np.log10(np.sqrt(np.mean(a1 ** 2)) / np.sqrt(np.mean(ref[:, at + 4800:at + 9600] ** 2))), 2)]
                # Lecture : changement porté par la trame (décalage dans le bloc), instance neuve
                s.unload()
                for at in (96000, 96037):
                    s = vst_host.Slot("live", PROC3, None, SR, juce)
                    s.load(state)
                    s.set_automation_map(["output_level"])
                    blocks = []
                    for a in range(0, tone.shape[1], vst_host.BLOCK):
                        ch = [(0, at - a, lo["value"])] if a <= at < a + vst_host.BLOCK else None
                        blocks.append(s.process_block(tone[:, a:a + vst_host.BLOCK], ch, None))
                    live = np.concatenate(blocks, axis=1)
                    lat = s.latency_samples
                    res[f"live_first_change_{at}"] = first_change(ref[:, :live.shape[1] - lat], live[:, lat:])
                    np.save(os.path.join(out, f"automation.{engine}.live{at}.npy"), live)
                    s.unload()
            elif test == "ruby2":
                path = os.path.join(par.VST3, "RUBY2.vst3")
                t = time.perf_counter()
                try:
                    s = vst_host.Slot("ruby", path, None, SR, juce)
                    s.load(None)
                    res["ruby2_load_s"] = round(time.perf_counter() - t, 2)
                    params = s.parameters()
                    res["ruby2_params"] = len(params)
                    sig = par.test_signal(1.0)
                    out_blocks = [s.process_block(sig[:, a:a + 128]) for a in range(0, sig.shape[1], 128)]
                    res["ruby2_failed"] = s.failed
                    res["ruby2_peak"] = float(np.max(np.abs(np.concatenate(out_blocks, axis=1))))
                    res["ruby2_state_bytes"] = len(s.get_state() or "")
                    s.unload()
                    res["ruby2"] = "chargé, réglages lus, son traité"
                except Exception as e:
                    res["ruby2"] = f"refusé sans faire tomber le pont : {type(e).__name__}: {e}"
                # Le pont continue : un autre plugin dans le même pont
                s2 = vst_host.Slot("after", PROC3, None, SR, juce)
                s2.load(None)
                y = s2.process_block(par.test_signal(0.1)[:, :128])
                res["bridge_alive_after"] = bool(y.shape == (2, 128))
                s2.unload()
            elif test == "waves":
                shell = par.PLUGINS["c6"]["path"]
                t = time.perf_counter()
                s = vst_host.Slot("c6", shell, "C6 Stereo", SR, juce)
                s.load(None)
                res["c6_load_s"] = round(time.perf_counter() - t, 2)
                t = time.perf_counter()
                res["c6_params"] = len(s.parameters())
                res["c6_params_s"] = round(time.perf_counter() - t, 2)
                s.unload()
                t = time.perf_counter()
                s = vst_host.Slot("c6m", shell, "C6 Mono", SR, juce)
                s.load(None)
                res["c6mono_load_s"] = round(time.perf_counter() - t, 2)
                y = s.process_block(par.test_signal(0.1)[:, :128])
                res["c6mono_out"] = list(y.shape)
                s.unload()
            res["ok"] = True
        except BaseException as e:  # noqa: BLE001
            import traceback
            res["ok"] = False
            res["error"] = f"{type(e).__name__}: {e}"
            log(traceback.format_exc())
        finally:
            json.dump(res, open(os.path.join(out, f"{test}.{engine}.json"), "w", encoding="utf-8"), indent=1, default=str)
            os._exit(0)

    threading.Thread(target=work, daemon=True).start()
    juce.run_forever()


def scan_times(out):
    """Lecture des fabriques : hôte natif (--scan) contre l'enfant Python actuel (vst_probe)."""
    sys.path.insert(0, par.BRIDGE)
    import vst_native
    shell = par.PLUGINS["c6"]["path"]
    res = {}
    exe = vst_native.find_host_exe()
    t = time.perf_counter()
    p = subprocess.run([exe, "--scan"], input=(shell + "\n").encode(), capture_output=True, creationflags=0x08000000 | 0x4000, timeout=600)
    res["native_scan_s"] = round(time.perf_counter() - t, 2)
    res["native_classes"] = sum(len(json.loads(l.split("@@NOVA@@", 1)[1]).get("classes") or [])
                                for l in p.stdout.decode("utf-8", "replace").splitlines() if "@@NOVA@@" in l)
    code = ("import sys,json,time;sys.path.insert(0,%r);import vst_probe;t=time.perf_counter();c=vst_probe.read_classes(%r);"
            "print(json.dumps({'n':len(c),'s':time.perf_counter()-t}))") % (par.BRIDGE, shell)
    t = time.perf_counter()
    p = subprocess.run([sys.executable, "-c", code], capture_output=True, creationflags=0x08000000 | 0x4000, timeout=600)
    res["python_probe_total_s"] = round(time.perf_counter() - t, 2)
    try:
        d = json.loads(p.stdout.decode().strip().splitlines()[-1])
        res["python_probe_classes"], res["python_probe_read_s"] = d["n"], round(d["s"], 2)
    except Exception as e:
        res["python_probe_error"] = str(e)
    json.dump(res, open(os.path.join(out, "scan_waves.json"), "w", encoding="utf-8"), indent=1)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["all", "run", "scan"])
    ap.add_argument("--engine", default="native")
    ap.add_argument("--test")
    ap.add_argument("--tests", default="sidechain,automation,ruby2,waves")
    ap.add_argument("--out", default=os.path.join(par.OUT_DEFAULT, "mieux"))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    par.below_normal()
    if a.cmd == "run":
        run(a.engine, a.test, a.out)
        return
    if a.cmd == "scan":
        print(json.dumps(scan_times(a.out), indent=1))
        return
    for test in a.tests.split(","):
        for engine in (["native", "pedalboard"] if test in ("sidechain", "automation", "waves") else ["native"]):
            t = time.time()
            par.spawn(["--help"]) if False else None
            subprocess.run([sys.executable, os.path.abspath(__file__), "run", "--engine", engine, "--test", test, "--out", a.out],
                           timeout=2400, creationflags=0x08000000 | 0x4000, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            print(test, engine, round(time.time() - t, 1), flush=True)
    print(json.dumps(scan_times(a.out)), flush=True)


if __name__ == "__main__":
    main()
