"""Son identique avant / après une optimisation : rendu hors ligne de la même séance par deux versions.

Navigateur headless (aucune fenêtre), QA 100 % hors production. Deux serveurs de dev (le moteur est
importé tel que l'appli le charge, window.__novaAppModule) : la version de référence (avant) et la
version optimisée (après). Chaque cas est rendu par `renderProject` (le rendu d'export) dans les deux,
avec les mêmes sons (générateur pseudo-aléatoire fixe) et les mêmes réglages ; écart maximal en LSB
16 bits (seuil 1 LSB, soit −96 dBFS ; visé : 0).

Cas :
  - « seance » : N pistes voix (au bit près : piste par piste, retour d'envoi sans la reverb, dont le
    rendu varie d'une fois à l'autre ; le mixage complet avec reverb est comparé au bruit de deux rendus
    de la référence) × EQ 12 bandes + compresseur (4 modes) + de-esser (relatif / absolu,
    cloche / plateau) + envoi reverb, 4 bus compressés, master EQ + compresseur ; automation de
    volume, de panoramique, du seuil des bus et du seuil d'un de-esser (version complète du worklet) ;
  - « deesser_seul », « comp_seul » : chaque réglage typique seul, à trous (veille, queues de filtres).
  - aux deux fréquences (44,1 et 48 kHz).

Usage : REF_URL=http://127.0.0.1:3523/ NOVA_URL=http://127.0.0.1:3503/ PYTHONIOENCODING=utf-8 python qa/identite_dsp.py
Sortie : $QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-perfseance)\\identite_dsp.json
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401
import base64, json, os, sys
from pathlib import Path

import numpy as np
from playwright.sync_api import sync_playwright
from qalib import CHROME, Log, new_page  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

REF = os.environ.get("REF_URL", "http://127.0.0.1:3523/")
NEW = os.environ.get("NOVA_URL", "http://127.0.0.1:3503/")
OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-perfseance"))
OUT.mkdir(parents=True, exist_ok=True)
RATES = [int(x) for x in os.environ.get("IDENT_RATES", "44100,48000").split(",")]
SEUIL = 1.0

JS = r"""
async ({ rate, cas, n, only }) => {
  const M = p => window.__novaAppModule(p);
  const { audioEngine: e } = await M('/engine/AudioEngine.ts');
  const { TrackType } = await M('/types.ts');
  const { builtinPlugin } = await M('/utils/sessionTemplate.ts');
  await e.init();
  const SR = rate;
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const DUR = cas === 'seance' ? 6.0 : 4.0;
  const voice = (dur, f0, k) => { const b = new AudioBuffer({ length: Math.round(dur * SR), numberOfChannels: 1, sampleRate: SR }); const x = b.getChannelData(0);
    for (let i = 0; i < x.length; i++) { const t = i / SR, env = Math.min(1, t / 0.02, (dur - t) / 0.05), syl = 0.55 + 0.45 * Math.sin(2 * Math.PI * (3.1 + 0.2 * k) * t);
      x[i] = env * syl * (0.3 * Math.sin(2 * Math.PI * f0 * t) + 0.12 * Math.sin(2 * Math.PI * 3 * f0 * t) + 0.05 * Math.sin(2 * Math.PI * 7200 * t)) + ((t % 0.55) < 0.07 ? 0.09 * rnd() * env : 0); }
    return b; };
  const clip = (id, buf, start) => ({ id, type: TrackType.AUDIO, start, duration: buf.duration, offset: 0, buffer: buf, gain: 1, name: id, fadeIn: 0.005, fadeOut: 0.01, color: '#fff' });
  const base = (id, type, extra) => ({ id, name: id, type, volume: 0.6, pan: 0, isMuted: false, isSolo: false, clips: [], plugins: [], sends: [], automationLanes: [], outputTrackId: 'master', ...extra });
  const eq = (id, k) => { const p = builtinPlugin('PROEQ12', {}, id); p.params.bands[0] = { ...p.params.bands[0], frequency: 90 + 10 * (k % 3) };
    p.params.bands[2] = { ...p.params.bands[2], gain: -2, frequency: 300, q: 1 }; p.params.bands[6] = { ...p.params.bands[6], gain: 2.5, frequency: 4000, q: 0.9 };
    p.params.bands[11] = { ...p.params.bands[11], frequency: 17000 }; return p; };
  const MODES = ['CLEAN', 'OPTO', 'FET', 'VCA'];
  const comp = (id, k, extra = {}) => builtinPlugin('COMPRESSOR', { threshold: -24, ratio: 3 + (k % 3), knee: 6, attack: 0.005, release: 0.15, makeupGain: 1.4, mode: MODES[k % 4], ...extra }, id);
  const ds = (id, k) => builtinPlugin('DEESSER', k % 2 ? { frequency: 7000, threshold: -30, reduction: 0.5, detection: 'RELATIVE', relThreshold: -6, mode: 'BELL', q: 1 }
                                                 : { frequency: 6500, threshold: -34, reduction: 0.7, detection: 'ABSOLUTE', mode: 'SHELF', q: 1.2 }, id);
  const lane = (pid, param, pts) => ({ id: pid + param, parameterName: param, color: '#fff', isExpanded: false, min: -60, max: 1, points: pts.map(([t, v], i) => ({ id: pid + i, time: t, value: v })) });
  let tracks = [];
  if (cas === 'seance') {
    tracks.push(base('verb', TrackType.SEND, { plugins: [builtinPlugin('REVERB', { modDepth: 0 }, 'rev')] }));
    for (let b = 0; b < 4; b++) tracks.push(base('bus' + b, TrackType.BUS, { plugins: [comp('bus' + b + '-comp', b, { threshold: -18, ratio: 2 })],
      automationLanes: [lane('bus' + b, 'plugin::bus' + b + '-comp::threshold', [[0, -18], [2, -14], [4, -20], [6, -16]])] }));
    for (let k = 0; k < n; k++) {
      const starts = [0.1 + 0.13 * (k % 5), 2.4 + 0.11 * (k % 4), 4.3];
      const lanes = [];
      if (k % 4 === 1) lanes.push(lane('t' + k, 'volume', [[0, 0.5], [1.5, 0.3], [3, 0.45], [6, 0.35]]));
      if (k % 4 === 2) lanes.push(lane('t' + k, 'pan', [[0, -0.6], [2, 0.6], [4, -0.3], [6, 0.4]]));
      if (k === 3) lanes.push(lane('t' + k, 'plugin::t' + k + '-ds::threshold', [[0, -34], [3, -26], [6, -38]]));
      tracks.push(base('t' + k, TrackType.AUDIO, {
        clips: starts.map((s, j) => clip(`t${k}-${j}`, voice(1.2 + 0.15 * j, 140 + 23 * k, k), s)), pan: ((k % 7) - 3) / 5, volume: 0.35,
        plugins: [eq('t' + k + '-eq', k), comp('t' + k + '-comp', k), ds('t' + k + '-ds', k)], sends: [{ id: 'verb', level: 0.12, isEnabled: true }],
        outputTrackId: 'bus' + (k % 4), automationLanes: lanes }));
    }
    tracks.push(base('master', TrackType.BUS, { outputTrackId: '', plugins: [eq('m-eq', 0), comp('m-comp', 0, { threshold: -12, ratio: 2 })] }));
    // Une seule piste (avec son bus, la reverb et le master) : jamais plus de deux signaux additionnés
    // au même point, le rendu est alors reproductible au bit près (voir l'en-tête).
    if (only !== undefined && only !== null) {
      tracks = tracks.filter(t => !/^t\d+$/.test(t.id) || t.id === 't' + only);
      // La reverb (ConvolverNode de Chrome, étages calculés sur un autre fil) n'est pas reproductible
      // au bit près d'un rendu à l'autre, même sans rien changer : le retour reste, sans la reverb.
      tracks.find(t => t.id === 'verb').plugins = [];
    }
  } else {
    for (let k = 0; k < n; k++) {
      const fx = cas === 'deesser_seul' ? [ds('t' + k + '-ds', k)] : [comp('t' + k + '-comp', k, k > 3 ? { mix: 0.6, lookahead: 0.003 } : {})];
      tracks.push(base('t' + k, TrackType.AUDIO, { clips: [clip('c' + k, voice(1.3, 170 + 30 * k, k), 0.2 + 0.4 * (k % 3)), clip('d' + k, voice(0.9, 210, k), 2.4)], plugins: fx, pan: (k - 3) / 6 }));
    }
    if (only !== undefined && only !== null) tracks = tracks.filter(t => t.id === 't' + only);
    tracks.push(base('master', TrackType.BUS, { outputTrackId: '' }));
  }
  e.setSafetyLimiter && e.setSafetyLimiter(false);
  const out = await e.renderProject(tracks, DUR, 0, SR);
  const enc = (f) => { const u = new Uint8Array(f.buffer.slice(0)); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  return { L: enc(out.getChannelData(0)), R: enc(out.getChannelData(1)), sr: out.sampleRate };
}
"""


def render(page, rate, cas, n, only=None):
    r = page.evaluate(JS, {"rate": rate, "cas": cas, "n": n, "only": only})
    dec = lambda b: np.frombuffer(base64.b64decode(b), dtype=np.float32)
    return np.stack([dec(r["L"]), dec(r["R"])])


def main():
    cases = [("seance", 16), ("deesser_seul", 6), ("comp_seul", 8)]
    res = {"ref": REF, "nouveau": NEW, "seuil_lsb16": SEUIL, "cas": [], "ok": True}
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, executable_path=CHROME, args=["--autoplay-policy=no-user-gesture-required"])
        pages = {}
        for name, url in (("ref", REF), ("nouveau", NEW)):
            if os.environ.get("IDENT_MEME_PAGE") == "1" and pages:
                pages[name] = next(iter(pages.values())); continue
            ctx, page = new_page(b, "pc", Log("identite_" + name))
            page.set_default_timeout(300000)
            page.goto(url, wait_until="domcontentloaded"); page.wait_for_timeout(5000)
            pages[name] = page
        def compare(a, z):
            if a.shape != z.shape:
                return {"erreur": f"tailles {a.shape} / {z.shape}", "ecart_max_lsb16": 1e9}
            d = np.abs(a.astype(np.float64) - z.astype(np.float64)); mx = float(d.max())
            return {"echantillons": int(a.shape[1]), "crete": round(float(np.abs(a).max()), 4), "ecart_max_lsb16": round(mx * 32768, 6),
                    "ecart_max_dbfs": round(20 * np.log10(mx + 1e-30), 1), "echantillons_differents": int((d > 0).sum()), "identique_au_bit": bool(mx == 0)}
        for rate in RATES:
            # 1. Au bit près : une piste à la fois (chaîne complète, bus, reverb, master), puis effets seuls.
            for cas, n in cases:
                ks = range(n) if cas != "seance" else range(min(n, 8))
                worst = None
                for k in ks:
                    c = compare(render(pages["ref"], rate, cas, n, k), render(pages["nouveau"], rate, cas, n, k))
                    c["piste"] = k
                    if worst is None or c["ecart_max_lsb16"] > worst["ecart_max_lsb16"]: worst = c
                r = {"cas": cas + " (piste par piste)", "frequence": rate, "pistes": len(ks), **worst}
                r["ok"] = r["ecart_max_lsb16"] <= SEUIL and r.get("crete", 0) > 0.001
                res["ok"] &= r["ok"]; res["cas"].append(r)
                print(("OK  " if r["ok"] else "ÉCHEC ") + json.dumps(r, ensure_ascii=False), flush=True)
            # 2. Mixage complet : l'ordre des additions de Chrome varie d'un rendu à l'autre (ulp), amplifié
            #    par les compresseurs. Comparé au bruit de deux rendus de la RÉFÉRENCE elle-même.
            a1 = render(pages["ref"], rate, "seance", 16); a2 = render(pages["ref"], rate, "seance", 16)
            z = render(pages["nouveau"], rate, "seance", 16)
            bruit = compare(a1, a2); c = compare(a1, z)
            r = {"cas": "seance 16 pistes (mixage)", "frequence": rate, **c, "bruit_ref_ref_lsb16": bruit["ecart_max_lsb16"]}
            r["ok"] = c["ecart_max_lsb16"] <= max(SEUIL, 2 * bruit["ecart_max_lsb16"])
            res["ok"] &= r["ok"]; res["cas"].append(r)
            print(("OK  " if r["ok"] else "ÉCHEC ") + json.dumps(r, ensure_ascii=False), flush=True)
        b.close()
    (OUT / "identite_dsp.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print("OK" if res["ok"] else "ÉCHEC", "->", OUT / "identite_dsp.json")
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
