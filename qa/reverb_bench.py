"""Banc de mesure des réverbes NOVA (constat R3 de l'audit UX du 08/10).

Rend 30 s d'une voix de synthèse dans un OfflineAudioContext (comme l'export
ou le gel) à travers ReverbNode, avec les réglages des deux envois du studio :
- « courte » : empreinte capturée Make Music (public/ir/make-music-vocal.wav, 5,25 s) ;
- « longue » : réponse calculée HALL 3,5 s (envoi Long) ;
- « plate »  : préréglage Vocal Plate 1,8 s ;
- « projet » : export réel (audioEngine.renderProject) d'une voix de 30 s envoyée
  aux deux reverbs ; « projet_sans_reverb » : le même sans les reverbs (référence).
Le hasard de la réponse calculée est rendu déterministe (graine refixée à
chaque calcul de réponse), ce qui permet un null test avant / après.

Usage (serveur Vite lancé) :
  NOVA_URL=http://127.0.0.1:3441/ python qa/reverb_bench.py --save avant
  NOVA_URL=http://127.0.0.1:3441/ python qa/reverb_bench.py --save apres --compare avant
Sorties : D:\\1 WORK\\CONTENU\\nova-finitions-3\\reverb_<nom>.json / .npz
"""
import argparse, base64, json, os, sys
from pathlib import Path

import numpy as np
from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-finitions-3")
import qalib  # noqa
from qalib import BASE, OUT  # noqa

CONFIGS = {
    "courte": {"irUrl": "/ir/make-music-vocal.wav", "decay": 1.2, "preDelay": 0, "size": 0.4, "mode": "PLATE", "erLevel": 0,
               "modDepth": 0, "bassBoost": 0, "lowCut": 20, "highCut": 20000, "width": 1, "ducking": 0, "damping": 0.4, "mix": 1.0},
    "longue": {"decay": 3.5, "preDelay": 0.05, "size": 0.9, "mode": "HALL", "damping": 0.4, "mix": 1.0},
    "plate": {"decay": 1.8, "preDelay": 0.025, "damping": 0.4, "size": 0.6, "mix": 0.22, "lowCut": 200, "highCut": 8000, "width": 1.0,
              "modRate": 0.5, "modDepth": 0.1, "erLevel": 0.3, "diffusion": 0.8, "bassBoost": 0.2, "ducking": 0.2, "mode": "PLATE"},
}

PREAMBLE = ("<!doctype html><title>banc</title><script type=\"module\">import R from \"/@react-refresh\";"
            "R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(t)=>t;"
            "window.__vite_plugin_react_preamble_installed__=true;</script>")

JS = r"""
async ({ params, seconds, sr, runs, keep, projet }) => {
  const prng = (seed) => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  // Après une modification, Vite sert le module sous « ?t=… » : le moteur charge alors une
  // autre instance que l'import nu. On rend déterministes TOUTES les instances chargées.
  if (projet) await import('/engine/AudioEngine.ts');
  const urls = new Set(['/plugins/ReverbPlugin.tsx']);
  for (const e of performance.getEntriesByType('resource')) { try { const u = new URL(e.name); if (u.pathname === '/plugins/ReverbPlugin.tsx') urls.add(u.pathname + u.search); } catch (_) {} }
  let mod = null;
  for (const url of urls) {
    const m = await import(/* @vite-ignore */ url); mod = mod || m;
    const proto = m.ReverbNode.prototype;
    if (!proto.__bench) {
      const orig = proto.buildImpulse;
      proto.buildImpulse = function () { const save = Math.random; Math.random = prng(12345); try { return orig.call(this); } finally { Math.random = save; } };
      proto.__bench = true;
    }
  }
  const n = Math.floor(seconds * sr);
  // Voix de synthèse : phrases de 0,35 s (harmoniques + souffle), silences entre elles.
  const rnd = prng(777);
  const src = [new Float32Array(n), new Float32Array(n)];
  for (let k = 0; k * 0.5 < seconds; k++) {
    const i0 = Math.floor(k * 0.5 * sr), len = Math.floor(0.35 * sr), f0 = 140 + 90 * ((k * 7) % 5);
    for (let i = 0; i < len && i0 + i < n; i++) {
      const env = Math.sin(Math.PI * i / len) ** 2, t = i / sr;
      let v = 0; for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / h;
      v = 0.25 * env * (v + 0.3 * (rnd() * 2 - 1));
      src[0][i0 + i] = v; src[1][i0 + i] = 0.9 * v;
    }
  }
  const times = []; let out = null, setup = 0;
  if (projet) {
    const { audioEngine } = await import('/engine/AudioEngine.ts');
    const { TrackType } = await import('/types.ts');
    const buf = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: sr }); buf.copyToChannel(src[0], 0); buf.copyToChannel(src[1], 1);
    const base = (id, type, extra) => ({ id, name: id, type, volume: 1, pan: 0, isMuted: false, isSolo: false, clips: [], plugins: [], sends: [], automationLanes: [], ...extra });
    const verb = (id, p) => projet === 'avec' ? [{ id: 'pl-' + id, type: 'REVERB', name: id, isEnabled: true, params: { ...p, isEnabled: true }, latency: 0 }] : [];
    const tracks = [
      base('voix', TrackType.AUDIO, { clips: [{ id: 'c-voix', type: TrackType.AUDIO, start: 0, duration: seconds, offset: 0, buffer: buf, gain: 1, name: 'voix' }],
        sends: [{ id: 'send-verb-short', level: 0.5, isEnabled: true }, { id: 'send-verb-long', level: 0.3, isEnabled: true }] }),
      base('send-verb-short', TrackType.SEND, { plugins: verb('short', params.courte), volume: 0.7 }),
      base('send-verb-long', TrackType.SEND, { plugins: verb('long', params.longue), volume: 0.6 }),
    ];
    const t1 = performance.now();
    out = await audioEngine.renderProject(tracks, seconds, 0, sr);
    times.push(performance.now() - t1);
  }
  for (let r = 0; r < (projet ? 0 : runs); r++) {
    const ctx = new OfflineAudioContext(2, n, sr);
    const t0 = performance.now();
    const buf = ctx.createBuffer(2, n, sr); buf.copyToChannel(src[0], 0); buf.copyToChannel(src[1], 1);
    const s = ctx.createBufferSource(); s.buffer = buf;
    const node = new mod.ReverbNode(ctx);
    node.updateParams({ ...params, isEnabled: true });
    if (node.ready) await node.ready;
    s.connect(node.input); node.output.connect(ctx.destination); s.start(0);
    const t1 = performance.now();
    const res = await ctx.startRendering();
    const t2 = performance.now();
    setup = t1 - t0; times.push(t2 - t1);
    if (r === runs - 1 && keep) out = res;
    node.dispose();
  }
  const enc = (f) => { const b = new Uint8Array(f.buffer); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
  return { times, setup, L: out ? enc(out.getChannelData(0)) : null, R: out ? enc(out.getChannelData(1)) : null };
}
"""

# En direct (contexte temps réel) : un réglage de la taille charge la nouvelle réponse avec
# un fondu, puis le convolveur sortant est vidé ; couper la reverb débranche sa queue.
JS_DIRECT = r"""
async () => {
  const mod = await import('/plugins/ReverbPlugin.tsx');
  const ctx = new AudioContext(); await ctx.resume();
  const osc = ctx.createOscillator(); const node = new mod.ReverbNode(ctx);
  osc.connect(node.input); node.output.connect(ctx.destination); osc.start();
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const st = () => ({ actif: node.activeConv, A: node.convA.buffer ? node.convA.buffer.length : null, B: node.convB.buffer ? node.convB.buffer.length : null,
                      queue: node.links.wet.on, reflexions: node.links.er.on, modulation: node.links.mod.on });
  const out = { creation: st() };
  await wait(400); node.updateParams({ decay: 5 }); out.pendant_le_fondu = st();
  await wait(1200); out.apres_le_fondu = st();
  node.updateParams({ isEnabled: false }); out.coupee_tout_de_suite = st();
  await wait(1000); out.coupee_apres_fondu = st();
  node.updateParams({ isEnabled: true }); out.remise = st();
  node.dispose(); osc.stop(); await ctx.close();
  return out;
}
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--save", default="mesure")
    ap.add_argument("--compare")
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--seconds", type=float, default=30)
    ap.add_argument("--sr", type=int, default=48000)
    a = ap.parse_args()
    res = {}
    arrays = {}
    names = list(CONFIGS) + ["projet", "projet_sans_reverb"]
    with sync_playwright() as p:
        br = qalib.launch(p)
        page = br.new_page()
        page.route("**/__banc.html", lambda r: r.fulfill(status=200, content_type="text/html", body=PREAMBLE))
        page.goto(BASE + "__banc.html"); page.wait_for_function("() => window.__vite_plugin_react_preamble_installed__")
        try:
            res["direct"] = page.evaluate(JS_DIRECT)
        except Exception as e:  # ancienne version (sans branches) : pas de mesure en direct
            res["direct"] = f"indisponible : {str(e)[:120]}"
        print("direct", res["direct"], flush=True)
        br.close()
    times = {k: [] for k in names}
    errors = []
    with sync_playwright() as p:
        br = qalib.launch(p)
        # Une page neuve par rendu, configurations entrelacées : la machine (et le
        # ramasse-miettes) pèse pareil sur l'avant et l'après ; on garde le meilleur temps.
        for run in range(a.runs):
            for name in names:
                page = br.new_page()
                # Le client Vite ne peut pas ouvrir son WebSocket dans cette page vide : sans rapport.
                page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "websocket" not in m.text.lower() else None)
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.route("**/__banc.html", lambda r: r.fulfill(status=200, content_type="text/html", body=PREAMBLE))
                page.goto(BASE + "__banc.html"); page.wait_for_function("() => window.__vite_plugin_react_preamble_installed__")
                keep = run == 0
                projet = {"projet": "avec", "projet_sans_reverb": "sans"}.get(name)
                params = CONFIGS if projet else CONFIGS[name]
                r = page.evaluate(JS, {"params": params, "seconds": a.seconds, "sr": a.sr, "runs": 1, "keep": keep, "projet": projet})
                page.close()
                times[name].append(r["times"][0])
                if keep:
                    L = np.frombuffer(base64.b64decode(r["L"]), dtype="<f4")
                    R = np.frombuffer(base64.b64decode(r["R"]), dtype="<f4")
                    arrays[name] = np.stack([L, R])
                print(name, round(r["times"][0]), "ms", flush=True)
        br.close()
    for name in names:
        t = sorted(times[name])
        res[name] = {"rendu_ms": [round(x) for x in times[name]], "rendu_min_ms": round(t[0]), "rendu_median_ms": round(t[len(t) // 2]),
                     "crete": float(np.abs(arrays[name]).max())}
        print(name, res[name], flush=True)
    res["projet"]["cout_des_2_reverbs_ms"] = res["projet"]["rendu_min_ms"] - res["projet_sans_reverb"]["rendu_min_ms"]
    print("export : coût des 2 reverbs", res["projet"]["cout_des_2_reverbs_ms"], "ms", flush=True)
    res["erreurs_console"] = errors
    np.savez_compressed(OUT / f"reverb_{a.save}.npz", **arrays)
    if a.compare:
        ref = np.load(OUT / f"reverb_{a.compare}.npz")
        before = json.loads((OUT / f"reverb_{a.compare}.json").read_text(encoding="utf-8"))
        for name in names:
            if name not in ref.files:
                continue
            d = arrays[name] - ref[name]
            peak = float(np.abs(ref[name]).max())
            diff = float(np.abs(d).max())
            res[name]["null_test_db"] = round(20 * np.log10(diff / peak), 1) if diff > 0 else "-inf (identique)"
            res[name]["acceleration"] = round(before[name]["rendu_min_ms"] / max(1, res[name]["rendu_min_ms"]), 2)
            res[name]["acceleration_mediane"] = round(before[name]["rendu_median_ms"] / max(1, res[name]["rendu_median_ms"]), 2)
            print(name, "null test", res[name]["null_test_db"], "dB, ×", res[name]["acceleration"], "(médiane ×", res[name]["acceleration_mediane"], ")", flush=True)
    (OUT / f"reverb_{a.save}.json").write_text(json.dumps(res, indent=2, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
