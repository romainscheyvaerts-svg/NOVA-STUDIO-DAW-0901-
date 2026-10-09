"""R10 · Side-chain des VST : preuves sur le VRAI moteur de NOVA (Chrome headless, aucune fenêtre)
avec le VRAI pont de ce dépôt (port 8776 / 8777).

 1. Chemin complet NOVA → pont → effet à clé → retour, avec l'effet à clé de référence du pont
    (« nova:debug-ducker », NOVA_BRIDGE_DEBUG=1 ; il remplit exactement le contrat que l'hôte
    VST3 natif devra remplir, voir bridge-python/vst_sidechain.py) chargé COMME UN VST de la
    piste : « 808 sous le kick » — la 808 (sinus 2 kHz connu, gain lu échantillon par échantillon)
    porte le VST, sa clé = le kick (muet, avant fader). Réduction et début de réduction à chaque
    kick, en lecture (worklet du pont, trames à 4 canaux, PDC) ET à l'export (rendu du pont avec
    la clé), dans les 4 cas de latence de R7 (rien ; limiteur 5 ms sur le kick ; limiteur avant
    le VST ; limiteur après le VST).
 2. FabFilter Pro-C 3 réel avec la même clé : état de la clé annoncé par le pont (pedalboard ne
    peut pas alimenter l'entrée side-chain des VST3) et réduction mesurée (≈ 0 dB attendu tant que
    l'hôte natif n'est pas là : la limite est documentée, pas cachée).

Usage (serveur `npx vite --port 3460 --strictPort`) :
  set NOVA_URL=http://127.0.0.1:3460/ && python qa/r10_sidechain_vst.py
Sortie : D:\\1 WORK\\CONTENU\\nova-r9-r10\\r10_sidechain_vst.json
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import json
import os
import sys
import traceback

from playwright.sync_api import sync_playwright

sys.path.insert(0, os.path.dirname(__file__))
from r9r10_lib import OUT, pick_port, start_bridge, stop_bridge  # noqa: E402
from r9_automation_vst import EXE, HELPERS as R9_HELPERS  # noqa: E402

URL = os.environ.get("NOVA_URL", "http://127.0.0.1:3460/")

HELPERS = R9_HELPERS + r"""
const { DEFAULT_LIMITER_PARAMS } = await import('/engine/LimiterNode.ts');
const r3 = v => Math.round(v * 1000) / 1000;
const KICKS = [0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25];
const kickSig = (sec, sr) => { const x = new Float32Array(Math.round(sec * sr)); for (const k of KICKS) { const i0 = Math.round(k * sr); for (let i = 0; i < 0.15 * sr && i0 + i < x.length; i++) { const t = i / sr; x[i0 + i] += 0.9 * Math.sin(2 * Math.PI * (50 * t + 400 * (1 - Math.exp(-t * 30)) / 30)) * Math.exp(-t * 18); } } return x; };
const pl = (id, type, params, extra = {}) => ({ id, type, name: type, isEnabled: true, latency: 0, params, ...extra });
const LIM = (id) => pl(id, 'LIMITER', { ...DEFAULT_LIMITER_PARAMS, ceiling: 0, inputGain: 0, lookahead: 5 });
const gainTrack = (y, x, sr, step = 0.00025) => { const out = []; const w = Math.round(0.00025 * sr); for (let t = 0.05; t < x.length / sr - 0.05; t += step) { const i0 = Math.round(t * sr); let my = 0, mx = 0; for (let i = i0; i < i0 + w; i++) { my = Math.max(my, Math.abs(y[i])); mx = Math.max(mx, Math.abs(x[i])); } out.push([t, 20 * Math.log10((my + 1e-12) / (mx + 1e-12))]); } return out; };
const perKick = (g, kicks, thr = -0.5) => kicks.map(k => {
  const pre = g.filter(([t]) => t > k - 0.06 && t < k - 0.01);
  const ref = pre.reduce((a, [, v]) => a + v, 0) / Math.max(1, pre.length);
  let start = null, min = 0;
  for (const [t, v] of g) { if (t < k - 0.02 || t > k + 0.2) continue; if (start === null && v < ref + thr) start = t; if (v - ref < min) min = v - ref; }
  return { kick_ms: r2(k * 1000), ecart_ms: start === null ? null : r2((start - k) * 1000), reduction_max_db: r2(min) };
});
const meas = (y, ref, sr) => {
  const rows = perKick(gainTrack(y, ref, sr), KICKS);
  const e = rows.map(r => r.ecart_ms).filter(v => v !== null);
  return { par_kick: rows, debut_reduction_ecart_max_ms: e.length ? r2(Math.max(...e.map(Math.abs))) : null, reduction_moyenne_db: r2(rows.reduce((a, r) => a + r.reduction_max_db, 0) / rows.length) };
};
"""

MAIN = r"""
const out = {};
await ensureBridge();
await E.init();
const sr = E.ctx.sampleRate;
out.sampleRate = sr;
out.pont = { version: novaBridge.getBridgeState().version, cle_vst_par_l_hote: !!novaBridge.getBridgeState().sidechain };
await setupCapture();
const sec = 3.6;
const ducker = { name: 'NOVA Debug Ducker', path: 'nova:debug-ducker', pluginName: null, stateB64: null };
const SC = (cas, v = ducker) => {
  const ref = sine(sec, 0.5, 2000, sr);
  const kick = audioTrack('kick', toBuf(kickSig(sec, sr), sr), cas === 2 ? [LIM('limk')] : [], [], { isMuted: true });
  const vp = { ...vstPlugin('vstk', v), sidechainSourceId: 'kick', sidechainTap: 'pre' };
  const chain = cas === 3 ? [LIM('lim808'), vp] : cas === 4 ? [vp, LIM('lim808')] : [vp];
  return { ref, tracks: [kick, audioTrack('808', toBuf(ref, sr), chain, [])] };
};
out.cle_vst = {};
for (const cas of [1, 2, 3, 4]) {
  const r = {};
  { const sc = SC(cas); const prep = await VF.prepareTracksForOffline(sc.tracks); const b = await E.renderProject(prep.tracks, sec, 0, sr); prep.cleanup(); r.export = meas(b.getChannelData(0), sc.ref, sr); r.export.rendu_par_le_pont = prep.tracks.map(t => !!t.isFrozen); }
  { const sc = SC(cas); const info = await loadLive(sc.tracks); const y = await capture(sc.tracks, sec);
    const node = VN.liveVstNodes.get('vstk');
    const st = node && node.getSlotId() ? await novaBridge.request({ action: 'AUTOMATION_STATS', slot_id: node.getSlotId() }) : null;
    r.lecture = { ...meas(y, sc.ref, sr), vst: info.map(i => i && { status: i.status, latencyMs: i.latencyMs, sidechain: i.sidechain, underruns: i.underruns }), blocs_avec_cle_au_pont: st && st.key_blocks };
    sc.tracks.forEach(t => E.disposeTrack(t.id)); }
  const a = r.export.par_kick.map(x => x.ecart_ms), l = r.lecture.par_kick.map(x => x.ecart_ms);
  const d = a.map((x, i) => (x !== null && l[i] !== null ? Math.abs(x - l[i]) : null)).filter(v => v !== null);
  r.ecart_max_lecture_export_ms = d.length ? r2(Math.max(...d)) : null;
  out.cle_vst['cas' + cas] = r;
}

// ── 2. Pro-C 3 réel, même clé ─────────────────────────────────────────────────
const list = novaBridge.getCachedPlugins();
let pc = null;
try {
  pc = await prepareVst(list, /^FabFilter Pro-C 3$/,
    [{ name: 'auto_gain', text: 'Off' }, { name: 'ratio', real: 10 }, { name: 'attack', value: 0 }, { name: 'release', real: 100 },
     { name: 'threshold', real: -30 }, { name: 'side_chain_input', text: 'External' }],
    { thr: { name: 'threshold', real: -30 } });
} catch (e) { out.pro_c3 = { erreur: String(e) }; }
if (pc) {
  const r = { reglages: pc.relu };
  { const sc = SC(1, pc); const prep = await VF.prepareTracksForOffline(sc.tracks); const b = await E.renderProject(prep.tracks, sec, 0, sr); prep.cleanup(); r.export = meas(b.getChannelData(0), sc.ref, sr); }
  { const sc = SC(1, pc); const info = await loadLive(sc.tracks); const y = await capture(sc.tracks, sec);
    r.lecture = { ...meas(y, sc.ref, sr), etat_cle: info[0] && info[0].sidechain };
    sc.tracks.forEach(t => E.disposeTrack(t.id)); }
  out.pro_c3 = r;
}
return out;
"""


def main():
    port = pick_port()
    proc = start_bridge(port)
    res = {"port": port}
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(headless=True, executable_path=EXE, args=["--autoplay-policy=no-user-gesture-required"])
            pg = b.new_page()
            errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)[:300]))
            pg.on("console", lambda m: errs.append(m.text[:300]) if m.type == "error" else None)
            pg.add_init_script(f"try {{ localStorage.setItem('nova.bridge.url', 'ws://127.0.0.1:{port}'); }} catch (e) {{}}")
            pg.goto(URL, wait_until="domcontentloaded", timeout=120000)
            pg.wait_for_timeout(4000)
            pg.set_default_timeout(900000)
            res.update(pg.evaluate("async () => {" + HELPERS + MAIN + "}"))
            res["erreurs_page"] = errs[:30]
            b.close()
    except Exception as e:
        res["erreur"] = f"{e}\n{traceback.format_exc()}"[:3000]
    finally:
        stop_bridge(proc)
    (OUT / "r10_sidechain_vst.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    sys.stdout.buffer.write(json.dumps(res, ensure_ascii=False, indent=1).encode("utf-8") + b"\n")


if __name__ == "__main__":
    main()
