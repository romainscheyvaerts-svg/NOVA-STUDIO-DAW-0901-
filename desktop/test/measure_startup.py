# -*- coding: utf-8 -*-
"""
Mesure du démarrage de Nova Studio pour Windows (avant / après une modification).

  venv\\Scripts\\python.exe test\\measure_startup.py <commande...> [--runs 2] [--offline] [--label x]

  <commande> : dist\\NovaStudio\\NovaStudio.exe, ou venv\\Scripts\\python.exe nova_desktop.py

Lance l'application avec un profil jetable (NOVA_DESKTOP_DATA_DIR temporaire, conservé
entre les lancements d'une même mesure : 1er lancement = à froid, suivants = cache chaud),
une fenêtre non activée (NOVA_DESKTOP_WINDOW : ne vole pas le focus), sans les ponts,
puis lit par le port de débogage (CDP) :
  - le délai lancement -> fenêtre WebView2 joignable -> DAW monté (#root rempli) ;
  - la navigation (document, ressources, octets transférés par le réseau) ;
  - la latence Web Audio (AudioContext 'interactive' : baseLatency, outputLatency).
--offline-after N : les N premiers lancements en ligne, les suivants hors ligne.
--offline : réseau coupé pour la page (proxy vers un port fermé, sauf 127.0.0.1).
Ferme ensuite la fenêtre normalement (WM_CLOSE -> sauvegarde de la session).
"""
import ctypes
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from ctypes import wintypes

CDP = int(os.environ.get("MEASURE_CDP_PORT", "9341"))
u32 = ctypes.WinDLL("user32")

AUDIO_JS = r"""
(async () => {
  const ac = new AudioContext({ latencyHint: 'interactive' });
  try { await ac.resume(); } catch (e) {}
  const o = ac.createOscillator(); const g = ac.createGain(); g.gain.value = 0;
  o.connect(g).connect(ac.destination); o.start();
  await new Promise(r => setTimeout(r, 600));
  const r = { state: ac.state, sampleRate: ac.sampleRate,
              baseLatencyMs: +(ac.baseLatency * 1000).toFixed(2),
              outputLatencyMs: +((ac.outputLatency || 0) * 1000).toFixed(2) };
  o.stop(); await ac.close();
  return r;
})()
"""

NAV_JS = r"""
(() => {
  const n = performance.getEntriesByType('navigation')[0] || {};
  const res = performance.getEntriesByType('resource');
  const sameOrigin = res.filter(e => e.name.startsWith(location.origin));
  return {
    href: location.href,
    title: document.title,
    responseEndMs: Math.round(n.responseEnd || 0),
    domContentLoadedMs: Math.round(n.domContentLoadedEventEnd || 0),
    loadMs: Math.round(n.loadEventEnd || 0),
    docTransferBytes: n.transferSize || 0,
    resources: res.length,
    // réponses servies en local par l'application : pas de protocole réseau (nextHopProtocol vide)
    viaNetwork: res.filter(e => e.nextHopProtocol).length + (n.nextHopProtocol ? 1 : 0),
    docProtocol: n.nextHopProtocol || 'local',
    networkBytes: res.filter(e => e.nextHopProtocol).reduce((s, e) => s + (e.transferSize || 0), 0) +
                  (n.nextHopProtocol ? (n.transferSize || 0) : 0),
    sameOriginResources: sameOrigin.length,
    desktop: window.__novaDesktop || null,
  };
})()
"""


def cdp_targets():
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{CDP}/json", timeout=0.5) as r:
            return [t for t in json.load(r) if t.get("type") == "page"]
    except Exception:
        return None


def evaluate(ws_url, expr, timeout=30):
    from websockets.sync.client import connect
    with connect(ws_url, max_size=None, open_timeout=5) as ws:
        ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {
            "expression": expr, "awaitPromise": True, "returnByValue": True}}))
        end = time.time() + timeout
        while time.time() < end:
            msg = json.loads(ws.recv(timeout=timeout))
            if msg.get("id") == 1:
                res = msg.get("result", {})
                if "exceptionDetails" in res:
                    raise RuntimeError(json.dumps(res["exceptionDetails"])[:300])
                return res.get("result", {}).get("value")
    raise TimeoutError(expr[:40])


def nova_windows():
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _):
        buf = ctypes.create_unicode_buffer(256)
        u32.GetWindowTextW(hwnd, buf, 256)
        if u32.IsWindowVisible(hwnd) and buf.value.startswith("Nova Studio"):
            found.append(hwnd)
        return True

    u32.EnumWindows(cb, 0)
    return found


def one_run(cmd, data_dir, offline, root_timeout=90):
    env = dict(os.environ)
    env.update({
        "NOVA_DESKTOP_DATA_DIR": data_dir,
        "NOVA_DESKTOP_CDP_PORT": str(CDP),
        "NOVA_DESKTOP_NO_BRIDGES": "1",
        "NOVA_DESKTOP_WINDOW": os.environ.get("MEASURE_WINDOW", "2300,1200,1280,800"),
        "NOVA_DESKTOP_NO_UPDATE": "1",
    })
    if offline:
        env["NOVA_DESKTOP_EXTRA_ARGS"] = "--proxy-server=http://127.0.0.1:9 --proxy-bypass-list=127.0.0.1"
    before = set(nova_windows())
    t0 = time.perf_counter()
    p = subprocess.Popen(cmd, env=env)
    out = {"pid": p.pid}
    try:
        targets = None
        while time.perf_counter() - t0 < 60 and not targets:
            targets = cdp_targets()
            if not targets:
                time.sleep(0.05)
        if not targets:
            out["error"] = "CDP injoignable"
            return out
        out["cdpReadyS"] = round(time.perf_counter() - t0, 2)
        ws = None
        mounted = False
        while time.perf_counter() - t0 < root_timeout:
            targets = cdp_targets() or []
            for t in targets:
                ws = t["webSocketDebuggerUrl"]
                try:
                    mounted = evaluate(ws, "!!(document.getElementById('root') && document.getElementById('root').children.length)", 3)
                except Exception:
                    mounted = False
                if mounted:
                    break
            if mounted:
                break
            time.sleep(0.1)
        out["rootMountedS"] = round(time.perf_counter() - t0, 2) if mounted else None
        if ws:
            try:
                out["nav"] = evaluate(ws, NAV_JS, 10)
            except Exception as e:
                out["nav"] = str(e)
            if mounted:
                try:
                    out["audio"] = evaluate(ws, AUDIO_JS, 15)
                except Exception as e:
                    out["audio"] = str(e)
        return out
    finally:
        hw = [h for h in nova_windows() if h not in before]
        for h in hw:
            u32.PostMessageW(h, 0x0010, 0, 0)  # WM_CLOSE (fermeture normale, avec sauvegarde)
        try:
            p.wait(120)
            out["closed"] = True
        except subprocess.TimeoutExpired:
            p.kill()
            out["closed"] = "tué"


def main():
    args = sys.argv[1:]
    runs, offline, label, offline_after = 2, False, "", None
    cmd = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--runs":
            runs = int(args[i + 1]); i += 2; continue
        if a == "--offline":
            offline = True; i += 1; continue
        if a == "--offline-after":  # 1er lancement en ligne, les suivants hors ligne
            offline_after = int(args[i + 1]); i += 2; continue
        if a == "--label":
            label = args[i + 1]; i += 2; continue
        cmd.append(a); i += 1
    data_dir = tempfile.mkdtemp(prefix="nova-measure-")
    results = []
    try:
        for n in range(runs):
            r = one_run(cmd, data_dir, offline or (offline_after is not None and n >= offline_after))
            r["run"] = n + 1
            results.append(r)
            print(json.dumps(r, ensure_ascii=False), flush=True)
            time.sleep(2)
    finally:
        shutil.rmtree(data_dir, ignore_errors=True)
    print(json.dumps({"label": label, "offline": offline, "runs": results}, ensure_ascii=False))


if __name__ == "__main__":
    main()
