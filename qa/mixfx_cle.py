"""Clé externe (side-chain) sur le Compresseur multibande et l'EQ dynamique (22/10/2026), par le vrai moteur.

Navigateur headless (aucune fenêtre), QA 100 % hors production (qa_hors_prod importé AVANT le lancement).
Dans chaque cas, la piste qui donne la clé est MUETTE (prise « avant fader » : on ne l'entend pas, elle
garde la pompe), donc tout ce qui sort est la piste traitée :

  - multibande : basse 80 Hz continue ; bande grave à −30 dB 8:1 ; clé = kick (60 Hz, 0,15 s toutes
    les 0,5 s) → la basse se creuse pendant chaque kick, pas entre ; sans clé, elle se comprime
    elle-même en continu (aucune pompe) ;
  - EQ dynamique : nappe 1 kHz continue ; cloche 1 kHz, seuil −30 dB, plage −6 dB ; clé = voix (1 kHz,
    0,2 s toutes les 0,5 s) → la nappe baisse de ≈ 6 dB pendant la voix seulement ;
  - lecture en temps réel enregistrée au master = export (≤ 1 LSB 16 bits), 44,1 et 48 kHz.

NOVA_URL=http://127.0.0.1:3525/ python qa/mixfx_cle.py
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import json, os, sys
from pathlib import Path
from playwright.sync_api import sync_playwright
from qalib import APP_MODULE_INIT, CHROME  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
URL = os.environ.get("NOVA_URL", "http://127.0.0.1:3525/")
OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-qa-hors-prod\mixfx_cle"))
OUT.mkdir(parents=True, exist_ok=True)
SEUIL = 1.0

JS = r"""
async ({ rate, kind }) => {
  const M = p => window.__novaAppModule(p);
  const { audioEngine: e } = await M('/engine/AudioEngine.ts');
  const { TrackType } = await M('/types.ts');
  const REG = await M('/engine/pluginRegistry.ts');
  if (!e.ctx || e.ctx.sampleRate !== rate) await e.setSampleRate(rate);
  await e.init(); await e.resume();
  const SR = e.ctx.sampleRate;
  e.setSafetyLimiter(false);
  const LEN = 3.0;
  const mb = kind === 'MBCOMP';
  const f0 = mb ? 80 : 1000, fk = mb ? 60 : 1000, burst = mb ? 0.15 : 0.2;
  const buf = (fn) => { const b = new AudioBuffer({ length: Math.round(LEN * SR), numberOfChannels: 2, sampleRate: SR }); for (let c = 0; c < 2; c++) { const x = b.getChannelData(c); for (let i = 0; i < x.length; i++) x[i] = fn(i / SR); } return b; };
  const pad = buf(t => (mb ? 0.3 : 0.05) * Math.sin(2 * Math.PI * f0 * t) * Math.min(1, t / 0.01));
  const key = buf(t => { const ph = t % 0.5; return ph < burst ? 0.5 * Math.sin(2 * Math.PI * fk * t) * Math.min(1, ph / 0.002, (burst - ph) / 0.002) : 0; });
  const reg = REG.getRegisteredPlugin(kind);
  const params = mb ? { ...reg.defaultParams(), bands: 3, x1: 200, x2: 4000, knee: 0, b1Thr: -30, b1Ratio: 8, b1Att: 1, b1Rel: 60 }
                    : { ...reg.defaultParams(), d1On: 1, d1Freq: 1000, d1Q: 2, d1Thr: -30, d1Range: -6, d1Att: 0.5, d1Rel: 40 };
  const clip = (id, b) => ({ id, type: TrackType.AUDIO, start: 0, duration: LEN, offset: 0, buffer: b, gain: 1, name: id, fadeIn: 0, fadeOut: 0, color: '#fff' });
  const mk = (withKey) => [
    { id: 'pad', name: 'pad', type: TrackType.AUDIO, volume: 1, pan: 0, isMuted: false, isSolo: false, sends: [], outputTrackId: 'master', automationLanes: [],
      plugins: [{ id: 'fx', name: kind, type: kind, isEnabled: true, latency: 0, params, ...(withKey ? { sidechainSourceId: 'cle', sidechainTap: 'pre' } : {}) }], clips: [clip('c-pad', pad)] },
    { id: 'cle', name: 'Clé', type: TrackType.AUDIO, volume: 1, pan: 0, isMuted: true, isSolo: false, sends: [], outputTrackId: 'master', automationLanes: [], plugins: [], clips: [clip('c-cle', key)] },
    { id: 'master', name: 'master', type: TrackType.BUS, volume: 1, pan: 0, isMuted: false, isSolo: false, sends: [], outputTrackId: '', plugins: [], clips: [], automationLanes: [] },
  ];
  // Niveau pendant / entre les salves de la clé (fenêtres au milieu, après 1 s).
  const levels = (b) => { const d = b.getChannelData(0); const r = (a, z) => { let s = 0, n = 0; for (let i = Math.floor(a * SR); i < Math.floor(z * SR); i++) { s += d[i] * d[i]; n++; } return 10 * Math.log10(s / n + 1e-30); };
    const on = [], off = []; for (let k = 2; k < 6; k++) { on.push(r(k * 0.5 + 0.04, k * 0.5 + burst - 0.02)); off.push(r(k * 0.5 + burst + 0.15, k * 0.5 + 0.48)); }
    const avg = a => a.reduce((x, y) => x + y, 0) / a.length; return { pendant_db: +avg(on).toFixed(2), entre_db: +avg(off).toFixed(2), creux_db: +(avg(on) - avg(off)).toFixed(2) }; };
  const out = { frequence: SR, effet: kind, origine_db: +(20 * Math.log10((mb ? 0.3 : 0.05) / Math.SQRT2)).toFixed(2) };
  out.export_avec_cle = levels(await e.renderProject(mk(true), LEN, 0, SR));
  out.export_sans_cle = levels(await e.renderProject(mk(false), LEN, 0, SR));
  // Lecture en temps réel = export (clé câblée par le moteur, comme à l'export).
  const tracks = mk(true);
  tracks.forEach(t => e.updateTrack(t, tracks)); tracks.forEach(t => e.updateTrack(t, tracks));
  e.setSafetyLimiter(false);
  await new Promise(r => setTimeout(r, 1500));
  const recSrc = `class R extends AudioWorkletProcessor { constructor() { super(); this.on = false; this.next = -1; this.port.onmessage = (e) => { this.on = !!e.data; }; }
    process(inputs) { const late = this.next >= 0 && currentFrame < this.next; const f = late ? this.next : currentFrame; this.next = f + 128; const i = inputs[0]; if (this.on && i && i.length) this.port.postMessage([f, i[0].slice(), (i[1] || i[0]).slice()]); return true; } }
    registerProcessor('nova-qa-rec-cle', R);`;
  if (window.__qaRecCle !== e.ctx) { await e.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([recSrc], { type: 'application/javascript' }))); window.__qaRecCle = e.ctx; }
  const dur = 2.8, n = Math.round(dur * SR);
  const ex = await e.renderProject(tracks, dur, 0, SR);
  const EL = ex.getChannelData(0), ER = ex.getChannelData(1);
  const capture = async () => {
    const recNode = new AudioWorkletNode(e.ctx, 'nova-qa-rec-cle', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
    const tap = e.getMasterMeterInput();
    const mute = e.ctx.createGain(); mute.gain.value = 0;
    tap.connect(recNode); recNode.connect(mute); mute.connect(e.ctx.destination);
    const blocks = []; recNode.port.onmessage = ev => blocks.push(ev.data); recNode.port.postMessage(true);
    await new Promise(r => setTimeout(r, 400));
    const at = Math.ceil((e.ctx.currentTime + 0.3) * SR) / SR;
    e.startPlayback(0, tracks, { at });
    const origin = e.playbackStartTime;
    const c0 = e.ctx.currentTime, w0 = performance.now();
    while (e.ctx.currentTime - c0 < dur + 0.6 && performance.now() - w0 < 60000) await new Promise(r => setTimeout(r, 50));
    e.stopAll();
    await new Promise(r => setTimeout(r, 200));
    recNode.port.postMessage(false);
    try { tap.disconnect(recNode); recNode.disconnect(); mute.disconnect(); } catch (err) {}
    const L = new Float32Array(n), Rr = new Float32Array(n), f0_ = Math.round(origin * SR);
    let got = 0;
    for (const [fr, a, b] of blocks) for (let i = 0; i < a.length; i++) { const k = fr + i - f0_; if (k >= 0 && k < n) { L[k] = a[i]; Rr[k] = b[i]; got++; } }
    let d = 0; for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(L[i] - EL[i]), Math.abs(Rr[i] - ER[i]));
    return { echantillons: got, attendus: n, ecart_lsb16: +(d * 32768).toFixed(4) };
  };
  const essais = [];
  for (let k = 0; k < 3; k++) { const c = await capture(); essais.push(c); if (c.ecart_lsb16 <= 1 && c.echantillons >= c.attendus * 0.999) break; }
  out.lecture = essais.filter(x => x.echantillons >= x.attendus * 0.999).reduce((a, b) => (!a || b.ecart_lsb16 < a.ecart_lsb16 ? b : a), null) || essais[essais.length - 1];
  out.lecture.tentatives = essais.length;
  tracks.forEach(t => e.disposeTrack(t.id));
  return out;
}
"""

checks = []


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:600]}"), flush=True)


def main():
    res = {"url": URL, "mesures": {}}
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, executable_path=CHROME, args=["--autoplay-policy=no-user-gesture-required"])
        pg = b.new_page()
        errs = []
        pg.on("pageerror", lambda x: errs.append(str(x)[:300]))
        pg.add_init_script(APP_MODULE_INIT)
        pg.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
        pg.goto(URL, wait_until="domcontentloaded", timeout=120000)
        pg.wait_for_timeout(4000)
        pg.set_default_timeout(300000)
        for rate in (44100, 48000):
            for kind in ("MBCOMP", "DYNEQ"):
                try:
                    r = pg.evaluate(JS, {"rate": rate, "kind": kind})
                except Exception as ex:
                    r = {"erreur": str(ex)[:300]}
                res["mesures"][f"{rate} {kind}"] = r
                print(rate, kind, json.dumps(r, ensure_ascii=False), flush=True)
                t = f"[{rate} Hz · {'multibande' if kind == 'MBCOMP' else 'EQ dynamique'}]"
                a, s = r.get("export_avec_cle") or {}, r.get("export_sans_cle") or {}
                if kind == "MBCOMP":
                    check(f"{t} clé (kick muet) : la basse se creuse pendant chaque kick (≥ 10 dB)", a.get("creux_db", 0) <= -10, a)
                else:
                    check(f"{t} clé (voix muette) : la nappe baisse pendant la voix (−6 dB ±1, la plage)", abs(a.get("creux_db", 0) + 6) <= 1, a)
                check(f"{t} entre les salves : le son d'origine (±0,5 dB) — l'effet n'écoute que la clé", abs(a.get("entre_db", -99) - r.get("origine_db", 0)) <= 0.5, {"avec": a, "origine_db": r.get("origine_db")})
                check(f"{t} sans clé : l'effet réagit à la piste elle-même, en continu (aucune pompe, ±0,3 dB)", abs(s.get("creux_db", 9)) <= 0.3 and s.get("entre_db", 0) < r.get("origine_db", 0) - 1, s)
                lec = r.get("lecture") or {}
                check(f"{t} lecture = export au bit près (≤ {SEUIL} LSB 16 bits)", lec.get("ecart_lsb16", 99) <= SEUIL and lec.get("echantillons", 0) >= lec.get("attendus", 1) * 0.999, lec)
        res["erreurs_page"] = errs[:5]
        check("aucune erreur de page", not errs, errs[:5])
        b.close()
    res["checks"] = checks
    res["ok"] = all(c["ok"] for c in checks)
    (OUT / "mixfx_cle.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print("OK" if res["ok"] else "ÉCHEC", f"{sum(c['ok'] for c in checks)}/{len(checks)}")
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
