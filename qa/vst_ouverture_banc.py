#!/usr/bin/env python3
"""
Banc « ouverture d'un VST » : temps entre la demande de chargement et la fenêtre affichée / le son
prêt, décomposé, sur de VRAIS plugins du PC, sans fenêtre visible (fenêtre du plugin HORS ÉCRAN).

Chemin mesuré = celui de LOAD_PLUGIN puis SHOW_EDITOR dans le pont (vst_host.instantiate →
prepare_plugin, get_state, puis show_editor), avec les postes :
  processus   démarrage de NovaVSTHost.exe (prêt + zone audio attachée)
  module      DLL + fabrique (mesuré dans l'hôte)
  composant   création + initialize du composant (licence…)
  contrôleur  création + initialize du contrôleur, synchronisation
  réglages    liste des réglages (hôte) + params (pont)
  test reset  « garde-t-il du son après un arrêt ? » (detect_reload)
  recréations reinstantiate (instance recréée)
  préparation état, prepare, premier bloc, remise à zéro, lecture de l'état
  fenêtre     createView + attached + affichage (hors écran)

Usage (venv du bureau) :
  python qa/vst_ouverture_banc.py [--runs 3] [--json sortie.json] [--only nom]
Variables : NOVA_VST_HOST_EXE (hôte à mesurer).
"""

import argparse
import json
import os
import statistics
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "bridge-python"))

import vst_host  # noqa: E402
import vst_native  # noqa: E402

V = r"C:\Program Files\Common Files\VST3"
PLUGINS = [
    ("Pro-Q 4", rf"{V}\FabFilter\FabFilter Pro-Q 4.vst3", None),
    ("Pro-C 3", rf"{V}\FabFilter\FabFilter Pro-C 3.vst3", None),
    ("Auto-Tune Pro", rf"{V}\Auto-Tune Pro.vst3", None),
    ("Waves C6", rf"{V}\WaveShell1-VST3 17.1_x64.vst3", "C6 Stereo"),
    ("Waves CLA-2A", rf"{V}\WaveShell1-VST3 17.1_x64.vst3", "CLA-2A Stereo"),
    ("Waves H-Reverb", rf"{V}\WaveShell1-VST3 17.1_x64.vst3", "H-Reverb Stereo"),
    ("A.O.M. Invisible Limiter G3", rf"{V}\A.O.M\Invisible_Limiter_G3.vst3", None),
    ("AIR Delay Pro", rf"{V}\AIR Music Technology\AIR Delay Pro.vst3", None),
    ("ValhallaRoom", rf"{V}\ValhallaDSP\ValhallaRoom.vst3", None),
]

POSTES = ["processus", "module", "composant", "contrôleur", "réglages", "test reset", "recréations",
          "préparation", "fenêtre"]


class Recorder:
    """Durée de chaque commande envoyée aux hôtes (HostProcess.request) et des démarrages."""

    def __init__(self):
        self.reset()
        orig_req = vst_native.HostProcess.request
        orig_init = vst_native.HostProcess.__init__
        rec = self

        def request(hp, cmd, timeout=None, **kw):
            if threading.current_thread() is not threading.main_thread():
                return orig_req(hp, cmd, timeout, **kw)      # hôtes de réserve (fil de fond)
            t0 = time.perf_counter()
            try:
                res = orig_req(hp, cmd, timeout, **kw)
            finally:
                rec.cmds.append((cmd, (time.perf_counter() - t0) * 1000.0))
            if cmd == "load":
                rec.load_timings = res.get("timings") or {}
            if cmd == "show_editor":
                rec.show = res
            return res

        def init(hp, *a, **k):
            if threading.current_thread() is not threading.main_thread():
                return orig_init(hp, *a, **k)
            t0 = time.perf_counter()
            orig_init(hp, *a, **k)
            rec.spawn_ms.append((time.perf_counter() - t0) * 1000.0)
            rec.uptime = (hp.info or {}).get("uptime_ms")
            rec.hosts.append(hp)

        vst_native.HostProcess.request = request
        vst_native.HostProcess.__init__ = init

    def reset(self):
        self.cmds = []
        self.spawn_ms = []
        self.load_timings = {}
        self.show = {}
        self.uptime = None
        self.hosts = []

    def sum(self, *names):
        return sum(ms for c, ms in self.cmds if c in names)


def postes(rec: Recorder, total_son: float, total_fen: float) -> dict:
    lt = rec.load_timings
    load_ms = rec.sum("load")
    host_known = sum(float(lt.get(k) or 0) for k in ("module", "component", "controller", "params"))
    # Les commandes d'attache comptent dans « processus » (fait par HostProcess.__init__).
    spawn = sum(rec.spawn_ms)
    out = {
        "processus": spawn,
        "module": float(lt.get("module") or 0) + max(0.0, load_ms - host_known),   # + aller-retour
        "composant": float(lt.get("component") or 0),
        "contrôleur": float(lt.get("controller") or 0),
        "réglages": float(lt.get("params") or 0) + rec.sum("params"),
        "test reset": rec.sum("detect_reload", "warm_up"),
        "recréations": rec.sum("reinstantiate"),
    }
    out["fenêtre"] = rec.sum("show_editor")
    known = sum(out.values()) - out["fenêtre"]
    out["préparation"] = max(0.0, total_son - known)
    out["son prêt"] = total_son
    out["fenêtre affichée"] = total_fen
    out["recréations (nb)"] = sum(1 for c, _ in rec.cmds if c == "reinstantiate")
    out["module préchargé"] = 1 if lt.get("preloaded") else 0
    return out


def run_one(rec: Recorder, name: str, path: str, cls, sr: int = 48000):
    rec.reset()
    t0 = time.perf_counter()
    plugin, _restored = vst_host.prepare_plugin(path, cls, None, sr, vst_host.BLOCK)
    try:
        vst_host._get_state(plugin)
        t_son = (time.perf_counter() - t0) * 1000.0
        plugin._host.request("show_editor", timeout=120, offscreen=True, title=plugin.name)
        t_fen = (time.perf_counter() - t0) * 1000.0
        plugin._host.request("hide_editor")
    finally:
        plugin.close()
    return postes(rec, t_son, t_fen)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--json")
    ap.add_argument("--only")
    ap.add_argument("--gap", type=float, default=2.5, help="pause avant chaque ouverture (s)")
    a = ap.parse_args()
    if not vst_host.NATIVE:
        print("Hôte natif introuvable")
        return 2
    print(f"Hôte : {vst_native.find_host_exe()}")
    rec = Recorder()
    results = {}
    for name, path, cls in PLUGINS:
        if a.only and a.only.lower() not in name.lower():
            continue
        if not os.path.exists(path):
            print(f"-- {name} : absent")
            continue
        runs = []
        for i in range(a.runs):
            time.sleep(a.gap)       # laisse les hôtes de réserve se remplir (comme entre deux clics)
            try:
                runs.append(run_one(rec, name, path, cls))
            except Exception as e:  # noqa: BLE001
                print(f"-- {name} : {e}")
                break
        if not runs:
            continue
        med = {k: statistics.median(r[k] for r in runs) for k in runs[0]}
        results[name] = {"median": med, "runs": runs}
        print(f"{name:30s} son prêt {med['son prêt']:7.0f} ms · fenêtre {med['fenêtre affichée']:7.0f} ms · "
              + " · ".join(f"{k} {med[k]:.0f}" for k in POSTES) + f" · recréations {med['recréations (nb)']:.0f} · module préchargé {med['module préchargé']:.0f}")
    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
