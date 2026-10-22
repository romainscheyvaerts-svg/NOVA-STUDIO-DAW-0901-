"""Métrologie dans le VRAI navigateur (Chrome headless, aucune fenêtre) : l'égaliseur 12 bandes rendu
par OfflineAudioContext (même chemin que l'export) donne-t-il la courbe calculée par le banc vitest
(tests/metrologieEQ.test.ts, formules de la spécification Web Audio) ?

Pour chaque réglage (44,1 et 48 kHz) : sinus rendus à travers ProEQ12Node, gain mesuré par moindres
carrés contre le sinus sec rendu dans le même contexte, comparé à la courbe affichée par la fenêtre
(engine/eqQ.ts : eqBandDb). Vérifie aussi qu'un ancien projet (Q de l'ancienne convention) sonne au
bit près comme les anciens filtres natifs, et que le cœur « pro » (worklet) suit le chemin classique.

Usage : NOVA_URL=http://127.0.0.1:3541/ python qa/metrologie_navigateur.py
Sortie : D:\\1 WORK\\CONTENU\\nova-metrologie\\navigateur.json
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production
import json, os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright
from qalib import APP_MODULE_INIT, CHROME  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
URL = os.environ.get("NOVA_URL", "http://127.0.0.1:3541/")
OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-metrologie"))
OUT.mkdir(parents=True, exist_ok=True)

JS = r"""
async ({ sr }) => {
  const eqm = await window.__novaAppModule('/plugins/ProEQ12Plugin.tsx');
  const qm = await window.__novaAppModule('/engine/eqQ.ts');
  const FREQS = [80, 150, 300, 500, 1000, 2000, 4000, 6000, 8000, 10000, 12000, 18000];
  const bandsWith = (b, extra = {}) => FREQS.map((frequency, id) => ({ id, type: 'peaking', frequency, gain: 0, q: 1, isEnabled: false, isSolo: false, ...(id === 4 ? { ...b, isEnabled: true } : {}) }));
  const fit = (x, f, from, to) => {
    const w = 2 * Math.PI * f / sr; let ss = 0, cc = 0, sc = 0, xs = 0, xc = 0;
    for (let i = from; i < to; i++) { const s = Math.sin(w * i), c = Math.cos(w * i), v = x[i]; ss += s * s; cc += c * c; sc += s * c; xs += v * s; xc += v * c; }
    const det = ss * cc - sc * sc; const a = (xs * cc - xc * sc) / det, b = (xc * ss - xs * sc) / det; return Math.hypot(a, b);
  };
  /** Gain (dB) du nœud construit par build(ctx) pour un sinus à f (régime établi). */
  async function gainAt(f, build, waitPro = false) {
    const n = Math.round(sr * 0.75);
    const ctx = new OfflineAudioContext(2, n, sr);
    const node = build(ctx);
    if (waitPro && node.ready) await node.ready;
    const osc = ctx.createOscillator(); osc.frequency.value = f;
    const sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2);
    osc.connect(node.input); node.output.connect(sp); sp.connect(mg, 0, 0); osc.connect(mg, 0, 1); mg.connect(ctx.destination);
    osc.start(0);
    const buf = await ctx.startRendering();
    const y = buf.getChannelData(0), x = buf.getChannelData(1);
    const from = Math.round(n * 0.5);
    const lat = node.latency ? Math.round(node.latency * sr) : 0;
    const per = sr / f, to = from + Math.floor((n - from - 1) / per) * Math.round(per);
    return 20 * Math.log10(fit(y, f, from, to) / fit(x, f, from - lat, to - lat) * 1) ;
  }
  const out = { sr, mesures: [], bitExact: [] };
  const cases = [
    { nom: 'Coupe-bas 200 Hz Q 0,71', b: { type: 'highpass', frequency: 200, q: Math.SQRT1_2 }, fs: [50, 100, 150, 190, 200, 210, 300, 1000, 5000] },
    { nom: 'Coupe-haut 18 kHz Q 0,71', b: { type: 'lowpass', frequency: 18000, q: Math.SQRT1_2 }, fs: [1000, 10000, 16000, 17500, 18000, 18500, 19500] },
    { nom: 'Cloche 10 kHz +12 dB Q 1', b: { type: 'peaking', frequency: 10000, gain: 12, q: 1 }, fs: [2000, 5000, 6180, 8000, 10000, 12000, 16180, 19000] },
    { nom: 'Cloche 100 Hz −9 dB Q 4', b: { type: 'peaking', frequency: 100, gain: -9, q: 4 }, fs: [60, 88, 94, 100, 106, 114, 200] },
    { nom: 'Étagère aiguë 6 kHz +6 dB', b: { type: 'highshelf', frequency: 6000, gain: 6, q: 1 }, fs: [500, 3000, 6000, 12000, 20000] },
    { nom: 'Encoche 1 kHz Q 10', b: { type: 'notch', frequency: 1000, q: 10 }, fs: [500, 900, 950, 1050, 1100, 2000] },
  ];
  for (const c of cases) {
    for (const f of c.fs) {
      const m = await gainAt(f, ctx => new eqm.ProEQ12Node(ctx, { isEnabled: true, masterGain: 1, qVersion: 2, bands: bandsWith(c.b) }));
      const shown = qm.eqBandDb(c.b, f, sr);
      out.mesures.push({ chemin: 'classique', reglage: c.nom, f, affiche: shown, mesure: m, ecart: m - shown });
    }
  }
  // Cœur « pro » (worklet, bande sur la gauche = chemin pro) : même courbe que le classique.
  for (const c of [cases[0], cases[2]]) {
    for (const f of c.fs.slice(0, 5)) {
      const m = await gainAt(f, ctx => new eqm.ProEQ12Node(ctx, { isEnabled: true, masterGain: 1, qVersion: 2, bands: bandsWith({ ...c.b, channel: 'left' }) }), true);
      const shown = qm.eqBandDb(c.b, f, sr);
      out.mesures.push({ chemin: 'pro (worklet)', reglage: c.nom, f, affiche: shown, mesure: m, ecart: m - shown });
    }
  }
  // Ancien projet : même son AU BIT PRÈS que les anciens filtres natifs (Q posé tel quel).
  const legacy = [{ type: 'highpass', frequency: 120, q: 3 }, { type: 'peaking', frequency: 12000, gain: 4, q: 0.8 }, { type: 'notch', frequency: 3000, q: 6 }, { type: 'peaking', frequency: 250, gain: -3, q: 1.4 }];
  for (const b of legacy) {
    const n = 32768;
    const render = async (build) => {
      const ctx = new OfflineAudioContext(1, n, sr);
      const src = ctx.createBufferSource(); const ab = ctx.createBuffer(1, n, sr); const d = ab.getChannelData(0);
      let s = 12345; for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; d[i] = 0.5 * (s / 0x7fffffff * 2 - 1); }
      src.buffer = ab; const node = build(ctx); src.connect(node.input); node.output.connect(ctx.destination); src.start(0);
      return (await ctx.startRendering()).getChannelData(0);
    };
    const a = await render(ctx => new eqm.ProEQ12Node(ctx, { isEnabled: true, masterGain: 1, bands: bandsWith(b) }));
    const r = await render(ctx => { const g = ctx.createGain(); const bq = ctx.createBiquadFilter(); bq.type = b.type; bq.frequency.value = b.frequency; bq.Q.value = b.q; bq.gain.value = b.gain || 0; const o = ctx.createGain(); g.connect(bq); bq.connect(o); return { input: g, output: o }; });
    let mx = 0; for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(a[i] - r[i]));
    out.bitExact.push({ reglage: `${b.type} ${b.frequency} Hz, ancien Q ${b.q}`, ecartMax: mx });
  }
  // Saturation : « le niveau reste à peu près constant » (compensation calée sur un sinus crête
  // −14 dBFS) et bouton Sortie exact. Sinus 1 kHz, mélange 100 %.
  const satm = await window.__novaAppModule('/plugins/VocalSaturatorPlugin.tsx');
  out.saturation = [];
  for (const mode of ['TAPE', 'TUBE']) for (const drive of [0, 25, 50, 100]) for (const og of [1, 2]) {
    if (og === 2 && drive !== 25) continue;
    const n = Math.round(sr * 0.5);
    const ctx = new OfflineAudioContext(2, n, sr);
    const node = new satm.VocalSaturatorNode(ctx);
    // Même ordre que le moteur à l'export : réglages posés à la création, puis le worklet se charge
    // avec eux (un réglage envoyé APRÈS par message arrive à un instant quelconque du rendu hors ligne).
    node.updateParams({ drive, mix: 1, tone: 0, eqLow: 0, eqMid: 0, eqHigh: 0, mode, isEnabled: true, outputGain: og });
    await node.ready;
    const osc = ctx.createOscillator(); osc.frequency.value = 1000;
    const g = ctx.createGain(); g.gain.value = 0.2; // crête −14 dBFS
    const sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2);
    osc.connect(g); g.connect(node.input); node.output.connect(sp); sp.connect(mg, 0, 0); g.connect(mg, 0, 1); mg.connect(ctx.destination);
    osc.start(0);
    const buf = await ctx.startRendering();
    const y = buf.getChannelData(0), x = buf.getChannelData(1);
    let ey = 0, ex = 0; for (let i = n >> 1; i < n; i++) { ey += y[i] * y[i]; ex += x[i] * x[i]; }
    out.saturation.push({ mode, drive, sortie: og, ecartNiveauDb: 10 * Math.log10(ey / ex), attenduDb: 20 * Math.log10(og) });
  }
  return out;
}
"""


def main():
    res = {"url": URL, "rates": {}, "ok": True}
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, executable_path=CHROME, args=["--autoplay-policy=no-user-gesture-required"])
        pg = b.new_page()
        errs = []
        pg.on("pageerror", lambda x: errs.append(str(x)[:300]))
        pg.add_init_script(APP_MODULE_INIT)
        pg.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
        pg.goto(URL, wait_until="domcontentloaded", timeout=120000)
        pg.wait_for_timeout(3000)
        pg.set_default_timeout(600000)
        for sr in (44100, 48000):
            r = pg.evaluate(JS, {"sr": sr})
            res["rates"][sr] = r
            pire = max(abs(m["ecart"]) for m in r["mesures"] if m["affiche"] > -40)
            bits = max(x["ecartMax"] for x in r["bitExact"])
            print(f"{sr} Hz : écart max navigateur / courbe affichée = {pire:.4f} dB ; ancien projet vs anciens filtres natifs = {bits:g}")
            for x in r.get("saturation", []):
                print(f"   saturation {x['mode']} chaleur {x['drive']} sortie {x['sortie']} : niveau {x['ecartNiveauDb']:+.2f} dB (attendu {x['attenduDb']:+.2f})")
            for m in r["mesures"]:
                if abs(m["ecart"]) > 0.02 and m["affiche"] > -40:
                    print("   hors tolérance :", m)
            if pire > 0.02 or bits != 0:
                res["ok"] = False
        res["erreurs_page"] = errs
        b.close()
    (OUT / "navigateur.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print("OK" if res["ok"] else "ÉCARTS", "→", OUT / "navigateur.json")
    sys.exit(0 if res["ok"] else 1)


if __name__ == "__main__":
    main()
