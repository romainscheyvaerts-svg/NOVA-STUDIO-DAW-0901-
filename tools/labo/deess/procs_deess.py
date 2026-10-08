"""Processeurs du banc de-esser : VST réel (pedalboard, sans fenêtre) et
de-esser NOVA dans le VRAI moteur (Chrome headless, OfflineAudioContext).

NovaDeessChrome(module, export) : `module` = chemin servi par vite (ex.
'/plugins/DeEsserPlugin.tsx'), le nœud expose input/output/updateParams et,
s'il en a un, `ready`. 0,3 s de silence en tête (réglages posés, lissages
terminés), retirés de la sortie ; la latence annoncée (node.latency, s) est
compensée.
"""
from __future__ import annotations

import base64
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import host  # noqa: E402

SR = 48000
PAD = int(0.3 * SR)
EXE = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"

JS = r"""
async ({ mod, exp, params, n, data, sr }) => {
  if (!window.__vite_plugin_react_preamble_installed__) {
    const R = await import('/@react-refresh');
    R.default.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (t) => t;
    window.__vite_plugin_react_preamble_installed__ = true;
  }
  const M = await import(mod);
  const bin = atob(data);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const all = new Float32Array(u8.buffer);
  const ctx = new OfflineAudioContext(2, n, sr);
  const buf = ctx.createBuffer(2, n, sr);
  buf.copyToChannel(all.subarray(0, n), 0);
  buf.copyToChannel(all.subarray(n, 2 * n), 1);
  const src = ctx.createBufferSource(); src.buffer = buf;
  const node = new M[exp](ctx, params);
  if (node.ready instanceof Promise) await node.ready;
  node.updateParams(params);
  src.connect(node.input); node.output.connect(ctx.destination); src.start(0);
  const out = await ctx.startRendering();
  const res = new Float32Array(2 * n);
  res.set(out.getChannelData(0), 0); res.set(out.getChannelData(1), n);
  const ob = new Uint8Array(res.buffer);
  let s = '';
  for (let i = 0; i < ob.length; i += 0x8000) s += String.fromCharCode.apply(null, ob.subarray(i, i + 0x8000));
  const lat = typeof node.latency === 'number' ? node.latency : 0;
  return { data: btoa(s), latency: Math.round(lat * sr) };
}
"""


class VstDeess:
    def __init__(self, plugin_file, base=None):
        self.plugin = host.open_plugin(plugin_file)
        self.name = getattr(self.plugin, "name", plugin_file)
        self.base = dict(base or {})
        self.settings = dict(self.base)
        self.applied = host.set_params(self.plugin, self.base) if self.base else {}

    @property
    def latency(self):
        return host.latency_of(self.plugin)

    def configure(self, settings):
        s = dict(self.base)
        s.update(settings or {})
        self.applied = host.set_params(self.plugin, s)
        self.settings = s
        return self.applied

    def run(self, x):
        xx = np.concatenate([np.zeros((2, PAD)), x], axis=1)
        y = host.process(self.plugin, xx, SR, block=512, reset=True)
        return y[:, PAD:PAD + x.shape[1]]

    def close(self):
        self.plugin = None


class NovaDeessChrome:
    def __init__(self, mod="/plugins/DeEsserPlugin.tsx", exp="DeEsserNode", base=None, url=None, name=None):
        from playwright.sync_api import sync_playwright
        self.mod, self.exp = mod, exp
        self.name = name or exp
        self.base = dict(base or {})
        self.settings = dict(self.base)
        self.url = url or os.environ.get("NOVA_URL", "http://127.0.0.1:3452/")
        self._pw = sync_playwright().start()
        self._br = self._pw.chromium.launch(executable_path=EXE, headless=True)
        self._page = self._br.new_page()
        self._page.goto(self.url.rstrip("/") + "/downloader.html", wait_until="domcontentloaded", timeout=120000)
        self.latency = 0

    def configure(self, settings):
        s = dict(self.base)
        s.update(settings or {})
        self.settings = s
        return s

    def run(self, x):
        xx = np.ascontiguousarray(np.concatenate([np.zeros((2, PAD)), x], axis=1), dtype=np.float32)
        n = int(xx.shape[1])
        r = self._page.evaluate(JS, {"mod": self.mod, "exp": self.exp, "params": self.settings, "n": n, "sr": SR,
                                     "data": base64.b64encode(xx.tobytes()).decode("ascii")})
        self.latency = int(r.get("latency", 0))
        y = np.frombuffer(base64.b64decode(r["data"]), dtype=np.float32).reshape(2, -1).astype(np.float64)
        L = PAD + self.latency
        out = y[:, L:L + x.shape[1]]
        if out.shape[1] < x.shape[1]:
            out = np.concatenate([out, np.zeros((2, x.shape[1] - out.shape[1]))], axis=1)
        return out

    def close(self):
        try:
            self._br.close()
            self._pw.stop()
        except Exception:
            pass


class NodeDeess:
    """Cœur engine/deesserCore.ts exécuté par Node (même code que l'AudioWorklet) : calage rapide."""

    def __init__(self, base=None, name="nova_node"):
        import json as _json
        import subprocess
        self._json = _json
        self.name = name
        self.base = dict(base or {})
        self.settings = dict(self.base)
        self.latency = 0
        self.last_gr = None
        repo = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
        bundle = os.path.join(HERE, "build", "deess_core.mjs")
        os.makedirs(os.path.dirname(bundle), exist_ok=True)
        esb = os.path.join(repo, "node_modules", ".bin", "esbuild.cmd")
        r = subprocess.run([esb, os.path.join(HERE, "deess_core_server.ts"), "--bundle", "--platform=node", "--format=esm",
                            f"--outfile={bundle}", "--log-level=error"], cwd=repo, capture_output=True, text=True,
                           creationflags=0x08000000)
        if r.returncode != 0:
            raise RuntimeError("esbuild : " + r.stderr[-2000:])
        self.p = subprocess.Popen(["node", bundle], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  creationflags=0x08000000, cwd=repo)

    def configure(self, settings):
        s = dict(self.base)
        s.update(settings or {})
        self.settings = s
        return s

    def run(self, x):
        x = np.ascontiguousarray(x, dtype=np.float32)
        req = {"params": self.settings, "sr": SR, "n": int(x.shape[1]), "data": base64.b64encode(x.tobytes()).decode("ascii")}
        self.p.stdin.write((self._json.dumps(req) + "\n").encode())
        self.p.stdin.flush()
        r = self._json.loads(self.p.stdout.readline())
        if r.get("error"):
            raise RuntimeError(r["error"])
        self.last_gr = np.array(r["gr"])
        return np.frombuffer(base64.b64decode(r["data"]), dtype=np.float32).reshape(2, -1).astype(np.float64)

    def close(self):
        try:
            self.p.stdin.close()
            self.p.wait(5)
        except Exception:
            self.p.kill()
