#!/usr/bin/env python3
"""
Inventaire des plugins : lecture des fabriques par l'hôte natif (NovaVSTHost --scan)
contre la lecture actuelle (enfant Python de vst_probe), sur tous les VST3 du PC.

Chaque mode tourne dans son propre processus avec un cache vide (LOCALAPPDATA
temporaire) : scan_vst3() + vst_probe.probe_bundles() + apply_classes(), comme le pont
au démarrage. Comparaison : mêmes entrées (nom, éditeur, instrument, plugin_name des
shells Waves), mêmes statuts ; temps total.

Usage : python qa/vst_native_scan.py [--out DIR]
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.join(HERE, "..", "bridge-python")


def child(engine, out_json):
    os.environ["NOVA_VST_ENGINE"] = engine
    sys.path.insert(0, BRIDGE)
    import ctypes
    ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x4000)
    import vst_host
    import vst_probe
    assert vst_host.ENGINE == engine
    t = time.perf_counter()
    plugins = vst_host.scan_vst3()
    todo = [p["path"] for p in plugins if p.get("is_instrument") is None]
    results = vst_probe.probe_bundles(todo, os.path.join(BRIDGE, "nova_bridge_server.py"))
    final = vst_probe.apply_classes(plugins, results)
    dt = time.perf_counter() - t
    json.dump({"engine": engine, "seconds": round(dt, 1), "bundles_read": len(todo), "plugins": final,
               "status": {k: v.get("st") for k, v in results.items()}},
              open(out_json, "w", encoding="utf-8"), default=str)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--child")
    ap.add_argument("--json")
    ap.add_argument("--out", default=r"D:\1 WORK\CONTENU\nova-hote-vst\scan")
    a = ap.parse_args()
    if a.child:
        child(a.child, a.json)
        return
    os.makedirs(a.out, exist_ok=True)
    res = {}
    for engine in ("pedalboard", "native"):
        tmp = tempfile.mkdtemp(prefix=f"novascan-{engine}-")
        env = dict(os.environ, LOCALAPPDATA=tmp)
        js = os.path.join(a.out, f"scan.{engine}.json")
        t = time.time()
        subprocess.run([sys.executable, os.path.abspath(__file__), "--child", engine, "--json", js], env=env,
                       timeout=3600, creationflags=0x08000000 | 0x4000)
        res[engine] = json.load(open(js, encoding="utf-8"))
        print(engine, round(time.time() - t, 1), "s", len(res[engine]["plugins"]), "plugins", flush=True)

    def key(p):
        return (p["name"].lower(), (p.get("vendor") or "").lower())
    A = {key(p): p for p in res["pedalboard"]["plugins"]}
    B = {key(p): p for p in res["native"]["plugins"]}
    only_a = sorted(set(A) - set(B))
    only_b = sorted(set(B) - set(A))
    diffs = []
    for k in sorted(set(A) & set(B)):
        for f in ("is_instrument", "category", "plugin_name", "path", "shell", "channels"):
            if A[k].get(f) != B[k].get(f):
                diffs.append(f"{k[0]} : {f} {A[k].get(f)} ≠ {B[k].get(f)}")
    st_a, st_b = res["pedalboard"]["status"], res["native"]["status"]
    st_diff = [f"{os.path.basename(p)} : {st_a.get(p)} ≠ {st_b.get(p)}" for p in sorted(set(st_a) | set(st_b))
               if st_a.get(p) != st_b.get(p)]
    waves = [p for p in res["native"]["plugins"] if (p.get("shell") or "").startswith("WaveShell")]
    md = ["# Inventaire des plugins : hôte natif ↔ lecture actuelle (vst_probe, enfant Python)", "",
          f"Généré le {time.strftime('%d/%m/%Y %H:%M')}, cache vide pour les deux (tous les VST3 du PC relus).", "",
          "| | Lecture actuelle (Python) | Hôte natif |", "|---|---|---|",
          f"| Plugins dans la liste | {len(A)} | {len(B)} |",
          f"| Fichiers lus (sans moduleinfo.json) | {res['pedalboard']['bundles_read']} | {res['native']['bundles_read']} |",
          f"| Temps total (scan + lecture) | {res['pedalboard']['seconds']} s | {res['native']['seconds']} s |",
          f"| Plugins Waves (shells) | {sum(1 for p in res['pedalboard']['plugins'] if (p.get('shell') or '').startswith('WaveShell'))} | {len(waves)} |",
          "", f"- Seulement dans la lecture actuelle : {len(only_a)} {[k[0] for k in only_a[:20]]}",
          f"- Seulement avec l'hôte natif : {len(only_b)} {[k[0] for k in only_b[:20]]}",
          f"- Champs différents : {len(diffs)}"] + [f"  - {d}" for d in diffs[:40]] + \
         [f"- Statuts de lecture différents : {len(st_diff)}"] + [f"  - {d}" for d in st_diff[:40]]
    open(os.path.join(a.out, "SCAN.md"), "w", encoding="utf-8").write("\n".join(md) + "\n")
    print("\n".join(md))


if __name__ == "__main__":
    main()
