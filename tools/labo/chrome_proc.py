"""
Processeur « vrai moteur NOVA » du labo : l'effet tourne dans un Chrome
headless (sans fenêtre), en AudioWorklet, dans un OfflineAudioContext — le
même chemin que l'export de NOVA. Sert de PREUVE finale du comparateur.

Il faut le serveur de développement NOVA : npx vite --port 3440 --strictPort
(adresse : variable NOVA_URL, défaut http://127.0.0.1:3440/).
"""
from __future__ import annotations

import base64
import os

import numpy as np
from playwright.sync_api import sync_playwright

EXE = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
SR = 48000

JS = r"""
async ({ kind, params, n, data, sr }) => {
  const { AnalogCompNode } = await import('/engine/AnalogCompNode.ts');
  const bin = atob(data);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const all = new Float32Array(u8.buffer);
  const ctx = new OfflineAudioContext(2, n, sr);
  const buf = ctx.createBuffer(2, n, sr);
  buf.copyToChannel(all.subarray(0, n), 0);
  buf.copyToChannel(all.subarray(n, 2 * n), 1);
  const src = ctx.createBufferSource(); src.buffer = buf;
  const node = new AnalogCompNode(ctx, kind, params);
  await node.ready;
  if (node.isFallback()) throw new Error('AudioWorklet indisponible');
  src.connect(node.input); node.output.connect(ctx.destination); src.start(0);
  const out = await ctx.startRendering();
  const res = new Float32Array(2 * n);
  res.set(out.getChannelData(0), 0); res.set(out.getChannelData(1), n);
  const ob = new Uint8Array(res.buffer);
  let s = '';
  for (let i = 0; i < ob.length; i += 0x8000) s += String.fromCharCode.apply(null, ob.subarray(i, i + 0x8000));
  return { data: btoa(s), latency: Math.round(node.latency * sr) };
}
"""


class ChromeProc:
    def __init__(self, kind: str, base=None, url: str | None = None):
        self.kind = kind
        self.name = kind + "-chrome"
        self.base = dict(base or {})
        self.settings = dict(self.base)
        self.url = url or os.environ.get("NOVA_URL", "http://127.0.0.1:3440/")
        self._pw = sync_playwright().start()
        self._br = self._pw.chromium.launch(executable_path=EXE, headless=True,
                                            args=["--autoplay-policy=no-user-gesture-required"])
        self._page = self._br.new_page()
        self._page.goto(self.url.rstrip("/") + "/downloader.html", wait_until="domcontentloaded", timeout=120000)
        self._latency = 0

    @property
    def latency(self):
        return self._latency

    def configure(self, settings):
        s = dict(self.base)
        s.update(settings or {})
        self.settings = s
        return s

    def run(self, x: np.ndarray) -> np.ndarray:
        x = np.ascontiguousarray(x, dtype=np.float32)
        n = int(x.shape[1])
        r = self._page.evaluate(JS, {"kind": self.kind, "params": self.settings, "n": n, "sr": SR,
                                     "data": base64.b64encode(x.tobytes()).decode("ascii")})
        self._latency = int(r.get("latency", 0))
        y = np.frombuffer(base64.b64decode(r["data"]), dtype=np.float32).reshape(2, -1).astype(np.float64)
        L = self._latency
        if L > 0:   # compensation de la latence déclarée, comme le PDC de NOVA
            y = np.concatenate([y[:, L:], np.zeros((2, L))], axis=1)
        return y

    def close(self):
        try:
            self._br.close()
            self._pw.stop()
        except Exception:
            pass
