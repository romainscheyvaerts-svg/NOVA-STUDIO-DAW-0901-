"""Charge DSP mesurée, avant / après.

1. Coût de calcul par effet (rendu hors ligne de 20 instances, ms de calcul par seconde
   de son et par instance) sur le serveur de dev (code actuel) ; l'égaliseur d'avant
   (git 26e6de4) est rechargé à côté pour comparer, et le son des deux est comparé.
2. Lecture SEULE (sans éditions) d'une session de N pistes pendant 3 min sur les deux
   builds (avant / après), l'une après l'autre : part du son joué en sous-régime
   (craquements) et vitesse de l'horloge audio par rapport au temps réel.

  PYTHONIOENCODING=utf-8 python qa/charge_dsp.py --dev http://127.0.0.1:3442/ --avant http://127.0.0.1:3443/ --apres http://127.0.0.1:3471/
Résultat : D:\\1 WORK\\CONTENU\\nova-stabilite\\charge_dsp.json
"""
import argparse, json, os, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-stabilite")
from qalib import OUT, CHROME  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

COST_JS = r"""
async () => {
  const { audioEngine: e } = await import('/engine/AudioEngine.ts');
  const Old = await import('/plugins/__ProEQ12Old.tsx');
  const New = await import('/plugins/ProEQ12Plugin.tsx');
  await e.init();
  const N = 20, SEC = 6, SR = 44100;
  const noise = (oc) => { const b = oc.createBuffer(2, SR, SR); for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); let s = 7 + c; for (let i = 0; i < d.length; i++) { s = (s * 16807) % 2147483647; d[i] = (s / 2147483647 - 0.5) * 0.2; } } return b; };
  const bench = async (make) => {
    const oc = new OfflineAudioContext(2, SEC * SR, SR); const buf = noise(oc);
    for (let k = 0; k < N; k++) { const s = oc.createBufferSource(); s.buffer = buf; s.loop = true; s.start(0); const p = make(oc, k); s.connect(p.input); p.output.connect(oc.destination); }
    await new Promise(r => setTimeout(r, 200));
    const t0 = performance.now(); const out = await oc.startRendering(); return { ms: Math.round((performance.now() - t0) / N / SEC * 10) / 10, out };
  };
  const res = {};
  const types = ['COMPRESSOR','REVERB','DELAY','CHORUS','FLANGER','DOUBLER','STEREOSPREADER','DEESSER','VOCALSATURATOR','LOFI','DJFILTER','GATEFX','AUTOTUNE','DENOISER'];
  for (const t of types) { const r = await bench((oc, k) => e.createPluginNode({ id: 'p' + k, type: t, name: t, isEnabled: true, params: {} }, 120, oc)); res[t] = { avant: r.ms, apres: r.ms, note: 'inchangé' }; }
  const bands4 = { isEnabled: true, masterGain: 1, bands: Array.from({ length: 12 }, (_, i) => ({ id: i, type: i === 0 ? 'highpass' : i === 11 ? 'lowpass' : (i === 2 ? 'lowshelf' : i === 9 ? 'highshelf' : 'peaking'), frequency: [80,150,300,500,1000,2000,4000,6000,8000,10000,12000,18000][i], gain: [0,0,3,0,-4,0,0,2.5,0,1.5,0,0][i], q: 1, isEnabled: i !== 5, isSolo: false })) };
  for (const [name, params] of [['PROEQ12 (réglage plat)', undefined], ['PROEQ12 (4 bandes actives)', bands4]]) {
    const a = await bench((oc) => new Old.ProEQ12Node(oc, params && JSON.parse(JSON.stringify(params))));
    const b = await bench((oc) => new New.ProEQ12Node(oc, params && JSON.parse(JSON.stringify(params))));
    let d = 0; for (let c = 0; c < 2; c++) { const x = a.out.getChannelData(c), y = b.out.getChannelData(c); for (let i = 0; i < x.length; i++) d = Math.max(d, Math.abs(x[i] - y[i])); }
    res[name] = { avant: a.ms, apres: b.ms, note: d === 0 ? 'son identique (écart 0)' : `écart max ${d}` };
  }
  return res;
}
"""


def effect_costs(dev):
    old = ROOT / "plugins" / "__ProEQ12Old.tsx"
    old.write_text(subprocess.run(["git", "-c", "safe.directory=*", "show", "26e6de4:plugins/ProEQ12Plugin.tsx"], cwd=ROOT, capture_output=True, text=True, encoding="utf-8").stdout, encoding="utf-8")
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(headless=True, executable_path=CHROME, args=["--autoplay-policy=no-user-gesture-required"])
            pg = b.new_page(); pg.goto(dev, wait_until="domcontentloaded"); pg.wait_for_timeout(3000)
            r = pg.evaluate(COST_JS)
            b.close()
            return r
    finally:
        old.unlink(missing_ok=True)


def playback(url, label, pistes, minutes):
    import endurance
    os.environ["NOVA_URL"] = url
    endurance.BASE = url
    import qalib
    qalib.BASE = url
    r = endurance.run(minutes, f"lecture_{pistes}p_{label}", 7, edits=False, pistes=pistes)
    rows = r["rows"]
    a, z = rows[1] if len(rows) > 2 else rows[0], rows[-1]
    pa, pz = a.get("playback") or {}, z.get("playback") or {}
    played = max(1e-9, pz["totalS"] - pa["totalS"])
    return {
        "part_du_son_en_sous_regime_pct": round(100 * (pz["underrunMs"] - pa["underrunMs"]) / 1000 / played, 1),
        "horloge_audio_sur_temps_reel": round((pz["ctxTime"] - pa["ctxTime"]) / max(1e-9, z["wall_s"] - a["wall_s"]), 3),
        "sous_regimes_par_min": round((pz["underrunEvents"] - pa["underrunEvents"]) / max(1e-9, (z["wall_s"] - a["wall_s"]) / 60)),
        "taches_longues_par_min": round((z["longTasks"] - a["longTasks"]) / max(1e-9, (z["wall_s"] - a["wall_s"]) / 60), 1),
        "image_p95_ms": z.get("frameP95"),
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dev", default="http://127.0.0.1:3442/")
    ap.add_argument("--avant", default="http://127.0.0.1:3443/")
    ap.add_argument("--apres", default="http://127.0.0.1:3471/")
    ap.add_argument("--minutes", type=float, default=3)
    ap.add_argument("--sans-effets", action="store_true")
    a = ap.parse_args()
    out = {"date": time.strftime("%Y-%m-%d %H:%M")}
    if not a.sans_effets:
        out["effets"] = effect_costs(a.dev)
        print(json.dumps(out["effets"], ensure_ascii=False))
    out["lecture"] = {}
    for pistes in (16, 40):
        for label, url in (("avant", a.avant), ("apres", a.apres)):
            m = playback(url, label, pistes, a.minutes)
            print(pistes, label, m, flush=True)
            for k, v in m.items():
                out["lecture"].setdefault(f"{pistes} pistes : {k.replace('_', ' ')}", {})[label] = v
    (OUT / "charge_dsp.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print("→", OUT / "charge_dsp.json")
