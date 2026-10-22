"""Lecture réelle avec un effet à latence sur le master : le début d'un son posé avant la latence
compensée n'est plus coupé (pré-roulement de latence du transport, 22/10/2026).

Navigateur headless (aucune fenêtre), QA 100 % hors production (qa_hors_prod importé AVANT le
lancement du navigateur). À 44,1 et 48 kHz :

  - une grosse caisse (clic de 0,9 sur son 1er échantillon, puis 60 Hz amorti) posée à 0,000 s ;
  - master : EQ 12 bandes en phase LINÉAIRE (≈ 43 ms de latence, annoncée au PDC), réglages neutres
    (le son doit ressortir identique au son sec) ; puis la même chose + limiteur NOVA à anticipation ;
  - lecture en temps réel enregistrée au master, à l'échantillon près (currentFrame), depuis 0 puis
    depuis le milieu (grosse caisse posée pile au point de départ, 1,000 s).

Mesures : 1er échantillon entendu de la grosse caisse (0 attendu, avant : ≈ la latence), énergie des
43 premières ms entendues / son sec (0 dB attendu), écart lecture / son sec (EQ neutre) et lecture /
export (au bit près, ≤ 1 LSB 16 bits), tête de lecture : jamais avant le départ ni en avance sur le son.

NOVA_URL=http://127.0.0.1:3525/ python qa/pdc_preroll_lecture.py
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
OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-qa-hors-prod\pdc_preroll_lecture"))
OUT.mkdir(parents=True, exist_ok=True)
SEUIL = 1.0   # LSB 16 bits

JS = r"""
async ({ rate, cfg }) => {
  const M = p => window.__novaAppModule(p);
  const { audioEngine: e } = await M('/engine/AudioEngine.ts');
  const { TrackType } = await M('/types.ts');
  const { builtinPlugin } = await M('/utils/sessionTemplate.ts');
  const REG = await M('/engine/pluginRegistry.ts');
  if (!e.ctx || e.ctx.sampleRate !== rate) await e.setSampleRate(rate);
  await e.init(); await e.resume();
  const SR = e.ctx.sampleRate;
  e.setSafetyLimiter(false);
  // Grosse caisse : clic sur le 1er échantillon (repère de l'attaque), puis 60 Hz amorti qui glisse.
  const kick = new AudioBuffer({ length: Math.round(0.6 * SR), numberOfChannels: 2, sampleRate: SR });
  for (let c = 0; c < 2; c++) { const x = kick.getChannelData(c);
    for (let i = 0; i < x.length; i++) { const t = i / SR; x[i] = 0.5 * Math.sin(2 * Math.PI * 60 * t + 6 * (1 - Math.exp(-t / 0.015))) * Math.exp(-t / 0.15); }
    x[0] = 0.9; }
  const eqLin = () => { const p = builtinPlugin('PROEQ12', { phase: 'linear' }, 'eq-lin'); p.params.bands[0].isEnabled = false; p.params.bands[11].isEnabled = false; return p; };
  const lim = () => { const reg = REG.getRegisteredPlugin('LIMITER'); return reg ? { id: 'fx-lim', name: 'LIMITER', type: 'LIMITER', isEnabled: true, latency: 0, params: reg.defaultParams() } : builtinPlugin('LIMITER', {}, 'fx-lim'); };
  const base = (id, type, extra) => ({ id, name: id, type, volume: 1, pan: 0, isMuted: false, isSolo: false, clips: [], plugins: [], sends: [], automationLanes: [], outputTrackId: 'master', ...extra });
  const tracks = [
    base('kick', TrackType.AUDIO, { clips: [{ id: 'c-kick', type: TrackType.AUDIO, start: cfg.at, duration: kick.duration, offset: 0, buffer: kick, gain: 1, name: 'kick', fadeIn: 0, fadeOut: 0, color: '#fff' }] }),
    base('master', TrackType.BUS, { outputTrackId: '', plugins: cfg.limiteur ? [eqLin(), lim()] : [eqLin()] }),
  ];
  tracks.forEach(t => e.updateTrack(t, tracks));
  tracks.forEach(t => e.updateTrack(t, tracks));
  e.setSafetyLimiter(false);
  await new Promise(r => setTimeout(r, 1500));   // worklets chargés, filtres linéaires calculés
  const latence_ms = +(e.getTrackLatency('kick') * 1000).toFixed(3);

  const recSrc = `class R extends AudioWorkletProcessor { constructor() { super(); this.on = false; this.next = -1; this.port.onmessage = (e) => { this.on = !!e.data; }; }
    process(inputs) { const late = this.next >= 0 && currentFrame < this.next; const f = late ? this.next : currentFrame; this.next = f + 128; const i = inputs[0]; if (this.on && i && i.length) this.port.postMessage([f, i[0].slice(), (i[1] || i[0]).slice()]); return true; } }
    registerProcessor('nova-qa-rec-preroll', R);`;
  if (window.__qaRecPreroll !== e.ctx) { await e.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([recSrc], { type: 'application/javascript' }))); window.__qaRecPreroll = e.ctx; }

  const from = cfg.from, dur = 1.0, n = Math.round(dur * SR);
  const ex = await e.renderProject(tracks, dur, from, SR);
  const EL = ex.getChannelData(0), ER = ex.getChannelData(1);
  const K = kick.getChannelData(0), k0 = Math.round((cfg.at - from) * SR);
  const dry = i => (i - k0 >= 0 && i - k0 < K.length ? K[i - k0] : 0);
  const capture = async () => {
    const recNode = new AudioWorkletNode(e.ctx, 'nova-qa-rec-preroll', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
    const tap = e.getMasterMeterInput();
    const mute = e.ctx.createGain(); mute.gain.value = 0;
    tap.connect(recNode); recNode.connect(mute); mute.connect(e.ctx.destination);
    const blocks = [];
    recNode.port.onmessage = ev => blocks.push(ev.data);
    recNode.port.postMessage(true);
    await new Promise(r => setTimeout(r, 400));
    const at = Math.ceil((e.ctx.currentTime + 0.3) * SR) / SR;
    e.startPlayback(from, tracks, { at });
    const origin = e.playbackStartTime + from;   // instant du contexte où le point de départ s'entend
    const tete = [[e.ctx.currentTime, e.getCurrentTime()]];
    const c0 = e.ctx.currentTime, w0 = performance.now();
    while (e.ctx.currentTime - c0 < dur + 0.6 && performance.now() - w0 < 60000) { await new Promise(r => setTimeout(r, 5)); tete.push([e.ctx.currentTime, e.getCurrentTime()]); }
    e.stopAll();
    await new Promise(r => setTimeout(r, 200));
    recNode.port.postMessage(false);
    try { tap.disconnect(recNode); recNode.disconnect(); mute.disconnect(); } catch (err) {}
    const L = new Float32Array(n), Rr = new Float32Array(n);
    const f0 = Math.round(origin * SR);
    let got = 0;
    for (const [fr, a, b] of blocks) for (let i = 0; i < a.length; i++) { const k = fr + i - f0; if (k >= 0 && k < n) { L[k] = a[i]; Rr[k] = b[i]; got++; } }
    let dExp = 0, dDry = 0;
    for (let i = 0; i < n; i++) { dExp = Math.max(dExp, Math.abs(L[i] - EL[i]), Math.abs(Rr[i] - ER[i])); dDry = Math.max(dDry, Math.abs(L[i] - dry(i))); }
    let first = -1; for (let i = 0; i < n; i++) if (Math.abs(L[i]) > 0.3) { first = i; break; }
    const W = Math.round(0.043 * SR); let eL = 0, eD = 0; for (let i = k0; i < k0 + W; i++) { eL += L[i] * L[i]; eD += dry(i) * dry(i); }
    // Tête de lecture : jamais avant le départ, jamais en avance sur ce qui s'entend (horloge à un bloc près).
    const q = 128 / SR + 0.0005;
    let avant = 0, avance = 0, ecart_tete = 0;
    for (const [ct, p] of tete) {
      if (p < from - 1e-9) avant++;
      const heard = Math.max(from, from + ct - origin);
      if (p > heard + q) avance++;
      ecart_tete = Math.max(ecart_tete, Math.abs(p - heard));
    }
    return { echantillons: got, attendus: n, pre_roulement_ms: +((origin - at) * 1000).toFixed(3),
      tete_au_depart: +tete[0][1].toFixed(6), tete_avant_le_depart: avant, tete_en_avance: avance, tete_ecart_max_ms: +(ecart_tete * 1000).toFixed(3),
      premier_echantillon_entendu: first - k0, energie_43ms_db: +(10 * Math.log10((eL + 1e-30) / (eD + 1e-30))).toFixed(3),
      ecart_sec_lsb16: +(dDry * 32768).toFixed(4), ecart_export_lsb16: +(dExp * 32768).toFixed(4) };
  };
  const essais = [];
  for (let k = 0; k < 3; k++) { const c = await capture(); essais.push(c); if (c.ecart_export_lsb16 <= 1 && c.echantillons >= c.attendus * 0.999) break; }
  const best = essais.filter(x => x.echantillons >= x.attendus * 0.999).reduce((a, b) => (!a || b.ecart_export_lsb16 < a.ecart_export_lsb16 ? b : a), null) || essais[essais.length - 1];
  tracks.forEach(t => e.disposeTrack(t.id));
  return { frequence: SR, latence_ms, ...best, tentatives: essais.length };
}
"""

checks = []


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:700]}"), flush=True)


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
        cfgs = [("EQ linéaire, depuis 0", {"at": 0.0, "from": 0.0, "limiteur": False}),
                ("EQ linéaire, depuis le milieu", {"at": 1.0, "from": 1.0, "limiteur": False}),
                ("EQ linéaire + limiteur, depuis 0", {"at": 0.0, "from": 0.0, "limiteur": True}),
                ("EQ linéaire + limiteur, depuis le milieu", {"at": 1.0, "from": 1.0, "limiteur": True})]
        for rate in (44100, 48000):
            for name, cfg in cfgs:
                try:
                    r = pg.evaluate(JS, {"rate": rate, "cfg": cfg})
                except Exception as ex:
                    r = {"erreur": str(ex)[:300]}
                res["mesures"][f"{rate} {name}"] = r
                print(rate, name, json.dumps(r, ensure_ascii=False), flush=True)
                tag = f"[{rate} Hz · {name}]"
                check(f"{tag} latence compensée ≈ 43 à 50 ms (EQ linéaire, + limiteur)", 40 <= (r.get("latence_ms") or 0) <= 55, r)
                check(f"{tag} grosse caisse entendue dès son 1er échantillon (clic à l'échantillon 0)", r.get("premier_echantillon_entendu") == 0, r)
                check(f"{tag} 43 premières ms entendues entières (énergie = son sec à ±0,5 dB)", abs(r.get("energie_43ms_db", -99)) <= 0.5, r)
                if not cfg["limiteur"]:
                    check(f"{tag} EQ neutre : la lecture = le son sec (≤ {SEUIL} LSB 16 bits)", r.get("ecart_sec_lsb16", 99) <= SEUIL, r)
                check(f"{tag} lecture = export au bit près (≤ {SEUIL} LSB 16 bits)", r.get("ecart_export_lsb16", 99) <= SEUIL, r)
                check(f"{tag} tête de lecture : sur le départ au lancement, jamais avant, jamais en avance sur le son",
                      abs(r.get("tete_au_depart", -1) - cfg["from"]) < 1e-6 and r.get("tete_avant_le_depart") == 0 and r.get("tete_en_avance") == 0, r)
        res["erreurs_page"] = errs[:5]
        check("aucune erreur de page", not errs, errs[:5])
        b.close()
    res["checks"] = checks
    res["ok"] = all(c["ok"] for c in checks)
    (OUT / "pdc_preroll_lecture.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print("OK" if res["ok"] else "ÉCHEC", f"{sum(c['ok'] for c in checks)}/{len(checks)}")
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
