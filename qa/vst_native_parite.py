#!/usr/bin/env python3
"""
Parité hôte VST3 natif (NovaVSTHost) ↔ pedalboard, sur les vrais plugins du PC.

Chaque moteur tourne dans son propre processus (le pont réel : vst_host.Slot,
render_offline, set_parameters… avec NOVA_VST_ENGINE=pedalboard|native) ; les
résultats (réglages, textes, rendus, flux temps réel, états, latence, temps) sont
écrits dans un dossier puis comparés :
  - rendu hors ligne et flux temps réel : null test (crête de la différence en dB FS,
    ≤ −100 dB ou identique) ; chaque moteur est aussi comparé à lui-même (deux rendus)
    pour repérer un plugin non déterministe (modulation, bruit analogique…) ;
  - réglages : même liste (clés, noms, textes, pas, plages, valeurs possibles) ;
  - apply_param (SET_PARAMS) : même résultat (texte relu, valeur brute) ;
  - état : sauvé par l'un, rechargé par l'autre (rendu et textes identiques) ;
  - latence.
Aucune fenêtre : pas d'éditeur ouvert ; une fenêtre de licence qui apparaît est
fermée par son bouton « Quitter » (jamais Acheter / Activer / Essai).

Usage (python du pont, avec pedalboard) :
  python qa/vst_native_parite.py all [--only id,id] [--out DIR]
  python qa/vst_native_parite.py run --engine pedalboard|native --plugin ID --out DIR [--foreign F] [--only-foreign]
"""

import argparse
import base64
import ctypes
import json
import os
import re
import subprocess
import sys
import threading
import time
from ctypes import wintypes

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE = os.path.join(HERE, "..", "bridge-python")
OUT_DEFAULT = r"D:\1 WORK\CONTENU\nova-hote-vst"
VST3 = r"C:\Program Files\Common Files\VST3"
SR = 48000

PLUGINS = {
    "proq4": {"label": "FabFilter Pro-Q 4", "path": VST3 + r"\FabFilter\FabFilter Pro-Q 4.vst3",
              "settings": [{"name": "band_1_used", "text": "Used"}, {"name": "band_1_frequency", "real": 1200.0},
                           {"name": "band_1_gain", "real": 6.0}, {"name": "band_1_q", "real": 2.0}]},
    "proc3": {"label": "FabFilter Pro-C 3", "path": VST3 + r"\FabFilter\FabFilter Pro-C 3.vst3",
              "settings": [{"name": "ratio", "text": "2:1"}, {"name": "threshold", "real": -24.0},
                           {"name": "attack", "real": 5.0}, {"name": "release", "real": 80.0}]},
    "c6": {"label": "Waves C6 Stereo", "path": VST3 + r"\WaveShell1-VST3 17.1_x64.vst3", "plugin_name": "C6 Stereo"},
    "l1": {"label": "Waves L1 limiter Stereo", "path": VST3 + r"\WaveShell1-VST3 17.1_x64.vst3",
           "plugin_name": "L1 limiter Stereo"},
    "rvox": {"label": "Waves RVox Stereo", "path": VST3 + r"\WaveShell1-VST3 17.1_x64.vst3", "plugin_name": "RVox Stereo"},
    "echoboy": {"label": "Soundtoys EchoBoy", "path": VST3 + r"\Soundtoys\EchoBoy.vst3"},
    "la2a": {"label": "UADx LA-2A Silver", "path": VST3 + r"\uaudio_teletronix_la-2a_silver.vst3"},
    "autotune": {"label": "Auto-Tune Pro", "path": VST3 + r"\Auto-Tune Pro.vst3"},
    "cl1b": {"label": "Tube-Tech CL 1B mk II", "path": VST3 + r"\Tube-Tech CL 1B mk II.vst3"},
    "vital": {"label": "Vital (instrument)", "path": VST3 + r"\Vital.vst3", "instrument": True},
}

BELOW_NORMAL = 0x00004000


def below_normal():
    try:
        k = ctypes.windll.kernel32
        k.SetPriorityClass(k.GetCurrentProcess(), BELOW_NORMAL)
    except Exception:
        pass


# ─────────────────────────────────────────────────────────────────────────────
# Fenêtres de licence : bouton « Quitter » (jamais acheter / activer / essai)
# ─────────────────────────────────────────────────────────────────────────────

QUIT_WORDS = re.compile(r"^\s*&?(quitter|quit|exit|fermer|close)\s*$", re.I)


def license_clicker(log):
    if os.name != "nt":
        return
    import license_watch as lw
    u = ctypes.windll.user32
    proto = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    BM_CLICK = 0x00F5
    seen = set()
    while True:
        time.sleep(0.5)
        try:
            wins = lw.windows_of(lw.descendants(os.getpid()))
        except Exception:
            continue
        for hwnd, info in wins.items():
            if hwnd in seen:
                continue
            buttons = []

            def cb(h, _l):
                n = u.GetWindowTextLengthW(h)
                buf = ctypes.create_unicode_buffer(n + 1)
                u.GetWindowTextW(h, buf, n + 1)
                cls = ctypes.create_unicode_buffer(64)
                u.GetClassNameW(h, cls, 64)
                if QUIT_WORDS.match(buf.value or ""):
                    buttons.append((h, buf.value, cls.value))
                return True
            u.EnumChildWindows(hwnd, proto(cb), 0)
            if buttons:
                seen.add(hwnd)
                h, text, cls = buttons[0]
                u.SendMessageW(h, BM_CLICK, 0, 0)
                log(f"fenêtre « {info.get('title')} » : bouton « {text} » cliqué")


# ─────────────────────────────────────────────────────────────────────────────
# Signal de test (déterministe)
# ─────────────────────────────────────────────────────────────────────────────

def test_signal(seconds: float = 3.0):
    import numpy as np
    n = int(seconds * SR)
    t = np.arange(n) / SR
    rs = np.random.RandomState(1234)
    noise = rs.randn(2, n).astype(np.float64)
    noise = np.cumsum(noise, axis=1) * 0.02 + noise * 0.3     # bruit coloré
    noise /= np.max(np.abs(noise))
    sweep = np.sin(2 * np.pi * (80 * t + (2000 - 80) * t * t / (2 * seconds)))
    kick = np.zeros(n)
    for k0 in range(0, n, SR // 2):
        m = min(n - k0, SR // 5)
        tt = np.arange(m) / SR
        kick[k0:k0 + m] += np.sin(2 * np.pi * (50 + 120 * np.exp(-tt * 40)) * tt) * np.exp(-tt * 12)
    sig = np.vstack([0.3 * sweep + 0.12 * noise[0] + 0.5 * kick,
                     0.28 * sweep + 0.12 * noise[1] + 0.5 * kick])
    return (sig * 0.8).astype(np.float32)


def notes():
    return [{"pitch": 48 + (i % 5) * 7, "start": 0.25 * i, "duration": 0.2, "velocity": 0.8} for i in range(10)]


# ─────────────────────────────────────────────────────────────────────────────
# Un moteur, un plugin (processus enfant)
# ─────────────────────────────────────────────────────────────────────────────

def auto_items(params, spec_items):
    """Réglages d'essai, déduits de la liste des réglages (même liste → mêmes réglages)."""
    items = list(spec_items or [])
    taken = {it["name"] for it in items}
    cand = sorted((p for p in params if p["name"] not in taken
                   and not re.search(r"bypass|byp|oversampl|mute|solo|preset|program|^control_|midi", p["name"], re.I)),
                  key=lambda p: p["name"])
    k = 0
    for p in cand:
        if len(items) >= 24:
            break
        vals = p.get("values") or []
        rng = p.get("range") or [None, None, None]
        if vals and len(vals) >= 2:
            items.append({"name": p["name"], "text": str(vals[(len(vals) * (k % 3 + 1)) // 4])})
        elif rng[0] is not None and rng[1] is not None and rng[1] > rng[0]:
            items.append({"name": p["name"], "real": round(rng[0] + (rng[1] - rng[0]) * (0.2 + 0.15 * (k % 4)), 3)})
        else:
            items.append({"name": p["name"], "value": round(0.25 + 0.1 * (k % 5), 3)})
        k += 1
    return items


def mem_mb(pid):
    try:
        import license_watch  # noqa
        PROCESS_QUERY = 0x0410

        class PMC(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t),
                        ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t),
                        ("PeakPagefileUsage", ctypes.c_size_t)]
        h = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY, False, pid)
        pmc = PMC()
        pmc.cb = ctypes.sizeof(PMC)
        ctypes.windll.psapi.GetProcessMemoryInfo(h, ctypes.byref(pmc), pmc.cb)
        ctypes.windll.kernel32.CloseHandle(h)
        return round(pmc.WorkingSetSize / 1e6, 1)
    except Exception:
        return None


def run_engine(engine, pid, out, foreign=None, only_foreign=False):
    os.environ["NOVA_VST_ENGINE"] = engine
    os.environ.setdefault("NOVA_VST_HOST_PRIORITY", "below_normal")
    os.environ.setdefault("NOVA_GUARD_FILE", os.path.join(out, "plugin_guard.json"))
    sys.path.insert(0, BRIDGE)
    below_normal()
    import numpy as np
    import vst_host
    assert vst_host.ENGINE == engine, (vst_host.ENGINE, engine)
    vst_host.LOAD_TIMEOUT_S = 1200.0   # pedalboard est lent sur cette machine chargée (Pro-Q 4 : 5 s + 50 s de réglages)
    # Machine très chargée (Pro Tools, autres agents) et processus en priorité « inférieure à la
    # normale » : des minutes sans processeur. Délais du banc allongés (pas ceux du pont).
    import vst_native
    vst_native.CALL_TIMEOUT_S = 1800.0
    vst_native.PROCESS_TIMEOUT_S = 1800.0
    _rs = vst_host.JuceThread.run_sync
    vst_host.JuceThread.run_sync = lambda self, fn, *a, timeout=1800.0: _rs(self, fn, *a, timeout=max(timeout, 1800.0))
    spec = PLUGINS[pid]
    path, name = spec["path"], spec.get("plugin_name")
    tag = f"{pid}.{engine}" + (".foreign" if only_foreign else "")
    logf = open(os.path.join(out, tag + ".log"), "w", encoding="utf-8")

    def log(m):
        logf.write(f"{time.strftime('%H:%M:%S')} {m}\n")
        logf.flush()

    threading.Thread(target=license_clicker, args=(log,), daemon=True).start()
    juce = vst_host.JuceThread()
    res = {"engine": engine, "plugin": pid}

    def fresh_pool():
        # Instance hors ligne neuve à chaque rendu : chaque rendu est un « premier » rendu
        # (un plugin qui garde quelque chose d'un rendu à l'autre ne fausse pas la comparaison).
        old = vst_host.OFFLINE
        vst_host.OFFLINE = vst_host.OfflinePool()
        try:
            old.reap()
            for e in list(old.entries.values()):
                old._drop(e)
            old.entries.clear()
        except Exception:
            pass

    def work():
        try:
            sig = test_signal()
            if only_foreign:
                st = open(foreign, encoding="ascii").read().strip()
                fresh_pool()
                if spec.get("instrument"):
                    ev = vst_host.midi_events(notes(), 3.0)
                    y = vst_host.render_instrument_offline(juce, path, name, st, ev, 3.0, SR)
                else:
                    y = vst_host.render_offline(juce, path, name, st, sig, SR, 0.5)
                np.save(os.path.join(out, tag + ".render.npy"), y)
                slot = vst_host.Slot("f", path, name, SR, juce)
                slot.load(st)
                json.dump(slot.parameters(), open(os.path.join(out, tag + ".params.json"), "w", encoding="utf-8"))
                slot.unload()
                res["ok"] = True
                return
            t = time.perf_counter()
            slot = vst_host.Slot("p", path, name, SR, juce)
            slot.load(None)
            res["load_s"] = round(time.perf_counter() - t, 3)
            res.update(name=slot.name, vendor=slot.vendor, is_instrument=slot.is_instrument,
                       latency=slot.latency_samples, sidechain_inputs=slot.sidechain_inputs)
            log(f"chargé {slot.name} en {res['load_s']} s")
            t = time.perf_counter()
            params = slot.parameters()
            res["params_s"] = round(time.perf_counter() - t, 3)
            json.dump(params, open(os.path.join(out, tag + ".params0.json"), "w", encoding="utf-8"))
            items = auto_items(params, spec.get("settings"))
            t = time.perf_counter()
            applied = slot.set_parameters(items)
            res["apply_s"] = round(time.perf_counter() - t, 3)
            json.dump({"items": items, "applied": applied}, open(os.path.join(out, tag + ".apply.json"), "w", encoding="utf-8"))
            res["latency_after"] = slot.latency_samples
            res["plugin_latency"] = applied.get("plugin_latency_after")
            json.dump(slot.parameters(), open(os.path.join(out, tag + ".params1.json"), "w", encoding="utf-8"))
            state = slot.get_state()
            open(os.path.join(out, tag + ".state.b64"), "w", encoding="ascii").write(state or "")
            # Flux temps réel (blocs de 128, comme le DAW)
            if not slot.is_instrument:
                n = SR * 2
                blocks = []
                t = time.perf_counter()
                for a in range(0, n, vst_host.BLOCK):
                    blocks.append(slot.process_block(sig[:, a:a + vst_host.BLOCK]))
                dt = time.perf_counter() - t
                res["stream_block_us"] = round(dt / (n / vst_host.BLOCK) * 1e6, 1)
                np.save(os.path.join(out, tag + ".stream.npy"), np.concatenate(blocks, axis=1))
                # 2e flux sur une instance neuve (même état) : le plugin est-il déterministe ?
                s4 = vst_host.Slot("p2", path, name, SR, juce)
                s4.load(state)
                b2 = [s4.process_block(sig[:, a:a + vst_host.BLOCK]) for a in range(0, n, vst_host.BLOCK)]
                np.save(os.path.join(out, tag + ".stream2.npy"), np.concatenate(b2, axis=1))
                s4.unload()
            plug = slot.plugin
            if engine == "native":
                res["host_mem_mb"] = mem_mb(plug.host_pid)
                res["last_process_us"] = getattr(plug, "last_process_us", None)
            slot.unload()
            # Rendus hors ligne (deux fois : déterminisme)
            if engine == "native":
                # (Avec pedalboard, chaque instance coûte jusqu'à 16 min sur cette machine : pas de rechargement.)
                s3 = vst_host.Slot("r", path, name, SR, juce)
                s3.load(state)
                json.dump(s3.parameters(), open(os.path.join(out, tag + ".reload_params.json"), "w", encoding="utf-8"))
                s3.unload()
            for k in (1, 2):
                if k == 1:
                    fresh_pool()      # 2e rendu : même instance hors ligne réutilisée (comme le pont)
                t = time.perf_counter()
                if spec.get("instrument"):
                    ev = vst_host.midi_events(notes(), 3.0)
                    y = vst_host.render_instrument_offline(juce, path, name, state, ev, 3.0, SR)
                else:
                    y = vst_host.render_offline(juce, path, name, state, sig, SR, 0.5)
                res[f"render{k}_s"] = round(time.perf_counter() - t, 3)
                np.save(os.path.join(out, f"{tag}.render{k}.npy"), y)
            if foreign:
                st = open(foreign, encoding="ascii").read().strip()
                fresh_pool()
                if spec.get("instrument"):
                    y = vst_host.render_instrument_offline(juce, path, name, st, vst_host.midi_events(notes(), 3.0), 3.0, SR)
                else:
                    y = vst_host.render_offline(juce, path, name, st, sig, SR, 0.5)
                np.save(os.path.join(out, tag + ".foreign_render.npy"), y)
                s2 = vst_host.Slot("f", path, name, SR, juce)
                s2.load(st)
                json.dump(s2.parameters(), open(os.path.join(out, tag + ".foreign_params.json"), "w", encoding="utf-8"))
                s2.unload()
            res["ok"] = True
        except BaseException as e:  # noqa: BLE001
            import traceback
            res["ok"] = False
            res["error"] = f"{type(e).__name__}: {e}"
            log(traceback.format_exc())
        finally:
            json.dump(res, open(os.path.join(out, tag + ".result.json"), "w", encoding="utf-8"), indent=1)
            logf.close()
            os._exit(0)

    threading.Thread(target=work, daemon=True).start()
    juce.run_forever()


# ─────────────────────────────────────────────────────────────────────────────
# Comparaison
# ─────────────────────────────────────────────────────────────────────────────

def null_db(a, b):
    """Crête de la différence (dB FS) et, pour un plugin non déterministe, l'écart d'enveloppe :
    niveau RMS par fenêtres de 50 ms, écart maximal en dB (fenêtres au-dessus de −50 dB FS)."""
    import numpy as np
    if a is None or b is None:
        return None
    n = min(a.shape[1], b.shape[1])
    if a.shape[1] != b.shape[1]:
        return {"len": [int(a.shape[1]), int(b.shape[1])]}
    a64, b64 = a[:, :n].astype(np.float64), b[:, :n].astype(np.float64)
    d = np.abs(a64 - b64)
    peak = float(d.max()) if d.size else 0.0
    w = SR // 20
    env = 0.0
    for i in range(0, n - w, w):
        ra, rb = np.sqrt(np.mean(a64[:, i:i + w] ** 2)), np.sqrt(np.mean(b64[:, i:i + w] ** 2))
        if max(ra, rb) > 10 ** (-50 / 20):
            env = max(env, abs(20 * np.log10((ra + 1e-12) / (rb + 1e-12))))
    idx = np.nonzero(d.max(axis=0) > 0)[0]
    return {"identical": peak == 0.0, "peak_db": None if peak == 0 else round(20 * np.log10(peak), 1),
            "level_db": round(20 * np.log10(float(np.abs(a).max()) + 1e-30), 1), "env_db": round(env, 2),
            "first_diff": int(idx[0]) if idx.size else None}


def load_np(path):
    import numpy as np
    return np.load(path) if os.path.isfile(path) else None


def load_json(path):
    try:
        return json.load(open(path, encoding="utf-8"))
    except Exception:
        return None


# is_discrete n'est pas comparé : pedalboard 0.9.25 le donne vrai presque toujours, mais pas toujours
# pour le même réglage d'un chargement à l'autre (Vital, Auto-Tune) ; les écarts sont comptés à part.
PARAM_FIELDS = ("name", "display_name", "text", "label", "num_steps", "is_boolean", "range", "values")


def cmp_params(a, b):
    if a is None or b is None:
        return {"ok": False, "why": "absent"}
    diffs = []
    if [p["name"] for p in a] != [p["name"] for p in b]:
        sa, sb = {p["name"] for p in a}, {p["name"] for p in b}
        diffs.append(f"clés : {len(a)} / {len(b)}, seulement pedalboard {sorted(sa - sb)[:5]}, seulement natif {sorted(sb - sa)[:5]}")
    bb = {p["name"]: p for p in b}
    n = 0
    disc = 0
    for p in a:
        q = bb.get(p["name"])
        if q is None:
            continue
        for f in PARAM_FIELDS:
            if p.get(f) != q.get(f):
                n += 1
                if len(diffs) < 8:
                    diffs.append(f"{p['name']}.{f} : {str(p.get(f))[:60]} ≠ {str(q.get(f))[:60]}")
        if p.get("is_discrete") != q.get("is_discrete"):
            disc = disc + 1
        if abs(float(p.get("value") or 0) - float(q.get("value") or 0)) > 1e-6:
            n += 1
            if len(diffs) < 8:
                diffs.append(f"{p['name']}.value : {p.get('value')} ≠ {q.get('value')}")
    return {"ok": not diffs, "count": len(a), "count_native": len(b), "diffs": diffs, "n_diffs": n,
            "is_discrete_diffs": disc}


def compare(out, pid):
    P, N = f"{pid}.pedalboard", f"{pid}.native"
    ra, rb = load_json(os.path.join(out, P + ".result.json")) or {}, load_json(os.path.join(out, N + ".result.json")) or {}
    rep = {"plugin": pid, "label": PLUGINS[pid]["label"], "pb": ra, "native": rb}
    rep["params0"] = cmp_params(load_json(os.path.join(out, P + ".params0.json")), load_json(os.path.join(out, N + ".params0.json")))
    rep["params1"] = cmp_params(load_json(os.path.join(out, P + ".params1.json")), load_json(os.path.join(out, N + ".params1.json")))
    aa, ab = load_json(os.path.join(out, P + ".apply.json")), load_json(os.path.join(out, N + ".apply.json"))
    if aa and ab:
        ra_ = aa["applied"]["results"]
        rb_ = ab["applied"]["results"]
        same = [x.get("ok") == y.get("ok") and x.get("text") == y.get("text") and abs(float(x.get("value") or 0) - float(y.get("value") or 0)) < 1e-6
                for x, y in zip(ra_, rb_)] if aa["items"] == ab["items"] else []
        rep["apply"] = {"items": len(aa["items"]), "same_items": aa["items"] == ab["items"], "identical": sum(same),
                        "ok_pb": sum(1 for x in ra_ if x.get("ok")), "ok_native": sum(1 for x in rb_ if x.get("ok")),
                        "diffs": [f"{x['name']}: {x.get('text')} / {y.get('text')}" for x, y, s in zip(ra_, rb_, same) if not s][:6],
                        "examples": [f"{it['name']}={it.get('text', it.get('real', it.get('value')))} → {x.get('text')}"
                                     for it, x in zip(aa["items"], ra_)][:4]}
    rp1, rp2 = load_np(os.path.join(out, P + ".render1.npy")), load_np(os.path.join(out, P + ".render2.npy"))
    rn1, rn2 = load_np(os.path.join(out, N + ".render1.npy")), load_np(os.path.join(out, N + ".render2.npy"))
    rep["render"] = null_db(rp1, rn1)
    rep["render_pb_self"] = null_db(rp1, rp2)
    rep["render_native_self"] = null_db(rn1, rn2)
    rep["stream"] = null_db(load_np(os.path.join(out, P + ".stream.npy")), load_np(os.path.join(out, N + ".stream.npy")))
    rep["stream_pb_self"] = null_db(load_np(os.path.join(out, P + ".stream.npy")), load_np(os.path.join(out, P + ".stream2.npy")))
    rep["stream_native_self"] = null_db(load_np(os.path.join(out, N + ".stream.npy")), load_np(os.path.join(out, N + ".stream2.npy")))
    # États croisés : natif rend avec l'état de pedalboard, pedalboard avec celui du natif
    rep["state_pb_to_native"] = null_db(rp1, load_np(os.path.join(out, N + ".foreign_render.npy")))
    rep["state_native_to_pb"] = null_db(rn1, load_np(os.path.join(out, f"{pid}.pedalboard.foreign.render.npy")))
    rep["state_params_pb_to_native"] = cmp_params(load_json(os.path.join(out, P + ".reload_params.json"))
                                                  or load_json(os.path.join(out, P + ".params1.json")),
                                                  load_json(os.path.join(out, N + ".foreign_params.json")))
    rep["state_params_native_to_pb"] = cmp_params(load_json(os.path.join(out, N + ".reload_params.json")),
                                                  load_json(os.path.join(out, f"{pid}.pedalboard.foreign.params.json")))
    rep["latency"] = [ra.get("latency_after"), rb.get("latency_after")]
    return rep


def verdict_null(r, self_a=None, self_b=None):
    if r is None:
        return "—"
    if "len" in r:
        return f"longueurs {r['len']}"
    if r["identical"]:
        return "identique"
    if r.get("peak_db") is not None and r["peak_db"] <= -100:
        return f"{r['peak_db']} dB"
    return f"{r['peak_db']} dB (enveloppe {r.get('env_db')} dB)"


def write_report(out, reps):
    lines = ["# Parité hôte VST3 natif (NovaVSTHost) ↔ pedalboard", "",
             f"Généré le {time.strftime('%d/%m/%Y %H:%M')} — 48 kHz, signal de test 3 s (balayage, bruit coloré, kick), "
             "rendus par le vrai pont (vst_host : Slot, set_parameters, render_offline) dans un processus par moteur.",
             "Null test : crête de (pedalboard − natif) en dB FS ; « identique » = différence nulle à l'échantillon près. "
             "Auto-contrôle : chaque moteur comparé à lui-même (2e rendu sur la même instance hors ligne, réutilisée comme dans le pont).", "",
             "| Plugin | Rendu hors ligne | Flux 128 éch. | pb↔pb (rendu réutilisé / flux neuf) | natif↔natif (idem) | Réglages (clés / champs) | apply_param identiques | État pb→natif | État natif→pb | Latence pb / natif |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    for r in reps:
        if not r.get("pb", {}).get("ok") or not r.get("native", {}).get("ok"):
            lines.append(f"| {r['label']} | échec : pb {r.get('pb', {}).get('error', 'ok')} / natif {r.get('native', {}).get('error', 'ok')} | | | | | | | | |")
            continue
        p0 = r["params0"]
        ap = r.get("apply") or {}
        lines.append("| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |".format(
            r["label"], verdict_null(r["render"]), verdict_null(r["stream"]),
            verdict_null(r["render_pb_self"]) + " / " + verdict_null(r.get("stream_pb_self")),
            verdict_null(r["render_native_self"]) + " / " + verdict_null(r.get("stream_native_self")),
            ("identiques" if p0["ok"] else f"{p0['n_diffs']} écart(s)") + f" ({p0['count']})",
            f"{ap.get('identical')}/{ap.get('items')}" if ap.get("same_items") else "listes différentes",
            verdict_null(r["state_pb_to_native"]) + (" · textes ok" if r["state_params_pb_to_native"]["ok"] else " · textes ≠"),
            verdict_null(r["state_native_to_pb"]) + (" · textes ok" if r["state_params_native_to_pb"]["ok"] else " · textes ≠"),
            f"{r['latency'][0]} / {r['latency'][1]}"))
    lines += ["", "## Temps (pedalboard / natif)", "",
              "| Plugin | Chargement (s) | Lecture des réglages (s) | Réglage groupé (s) | Rendu 3,5 s (s) | Bloc temps réel 128 éch. (µs) | Mémoire du processus natif (Mo) |",
              "|---|---|---|---|---|---|---|"]
    for r in reps:
        a, b = r.get("pb", {}), r.get("native", {})
        lines.append(f"| {r['label']} | {a.get('load_s')} / {b.get('load_s')} | {a.get('params_s')} / {b.get('params_s')} | "
                     f"{a.get('apply_s')} / {b.get('apply_s')} | {a.get('render1_s')} / {b.get('render1_s')} | "
                     f"{a.get('stream_block_us')} / {b.get('stream_block_us')} | {b.get('host_mem_mb')} |")
    lines += ["", "## Détails des écarts", ""]
    for r in reps:
        det = []
        for k in ("params0", "params1", "state_params_pb_to_native", "state_params_native_to_pb"):
            v = r.get(k) or {}
            if v and not v.get("ok") and v.get("diffs"):
                det.append(f"- {k} : " + " ; ".join(v["diffs"][:6]))
        ap = r.get("apply") or {}
        if ap.get("diffs"):
            det.append("- apply_param : " + " ; ".join(ap["diffs"]))
        if ap.get("examples"):
            det.append("- exemples de réglages (pedalboard) : " + " ; ".join(ap["examples"]))
        if det:
            lines += [f"### {r['label']}", ""] + det + [""]
    open(os.path.join(out, "PARITE.md"), "w", encoding="utf-8").write("\n".join(lines) + "\n")
    json.dump(reps, open(os.path.join(out, "parite.json"), "w", encoding="utf-8"), indent=1, default=str)


def spawn(args, timeout=4 * 3600):
    flags = 0x08000000 | BELOW_NORMAL
    t = time.time()
    try:
        subprocess.run([sys.executable, os.path.abspath(__file__)] + args, timeout=timeout, creationflags=flags,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return f"délai dépassé ({timeout} s)"
    return round(time.time() - t, 1)


REUSE_PB = False
RERUN_PB: set = set()


def run_all(out, only):
    os.makedirs(out, exist_ok=True)
    reps = []
    for pid in only:
        print(f"== {pid}", flush=True)
        prev = load_json(os.path.join(out, f"{pid}.pedalboard.result.json")) or {}
        if REUSE_PB and prev.get("ok") and pid not in RERUN_PB:
            print("  pedalboard : résultats déjà là (pedalboard est très lent sur cette machine)", flush=True)
        else:
            print("  pedalboard", spawn(["run", "--engine", "pedalboard", "--plugin", pid, "--out", out]), flush=True)
        pb_state = os.path.join(out, f"{pid}.pedalboard.state.b64")
        print("  natif", spawn(["run", "--engine", "native", "--plugin", pid, "--out", out, "--foreign", pb_state]), flush=True)
        nv_state = os.path.join(out, f"{pid}.native.state.b64")
        if os.path.isfile(nv_state):
            print("  pedalboard (état natif)", spawn(["run", "--engine", "pedalboard", "--plugin", pid, "--out", out,
                                                      "--foreign", nv_state, "--only-foreign"]), flush=True)
        rep = compare(out, pid)
        reps.append(rep)
        print("  rendu", verdict_null(rep["render"]), "| flux", verdict_null(rep["stream"]), "| réglages",
              rep["params0"].get("ok"), flush=True)
        write_report(out, reps)
    return reps


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["all", "run", "report"])
    ap.add_argument("--engine")
    ap.add_argument("--plugin")
    ap.add_argument("--out", default=os.path.join(OUT_DEFAULT, "parite"))
    ap.add_argument("--foreign")
    ap.add_argument("--only-foreign", action="store_true")
    ap.add_argument("--only")
    ap.add_argument("--reuse-pb", action="store_true")
    ap.add_argument("--rerun-pb", help="plugins dont pedalboard est relancé malgré --reuse-pb")
    a = ap.parse_args()
    global REUSE_PB, RERUN_PB
    REUSE_PB = a.reuse_pb
    RERUN_PB = set((a.rerun_pb or "").split(","))
    below_normal()
    if a.cmd == "run":
        run_engine(a.engine, a.plugin, a.out, a.foreign, a.only_foreign)
    elif a.cmd == "report":
        only = a.only.split(",") if a.only else list(PLUGINS)
        write_report(a.out, [compare(a.out, p) for p in only])
    else:
        run_all(a.out, a.only.split(",") if a.only else list(PLUGINS))


if __name__ == "__main__":
    main()
