"""Lecture EN BOUCLE avec un effet à latence sur le master : chaque tour commence entier, sans trou ni
doublon à la jonction (pré-roulement au retour de boucle, 22/10/2026).

Navigateur headless (aucune fenêtre), QA 100 % hors production (qa_hors_prod importé AVANT le
lancement du navigateur). À 44,1 et 48 kHz, boucle de 1,000 s lue 4 tours, enregistrée au master à
l'échantillon près (currentFrame) :

  - grosse caisse (clic de 0,9 sur son 1er échantillon, puis 60 Hz amorti) posée pile au début de boucle ;
  - repère court (bip 2 kHz de 10 ms) 30 ms avant la fin de boucle : il doit s'entendre une fois par tour ;
  - « fuite » (bip 3 kHz de 10 ms) 20 ms APRÈS la fin de boucle : ne doit JAMAIS s'entendre ;
  - master : EQ 12 bandes en phase LINÉAIRE (≈ 43 ms, neutre = son sec), puis + limiteur à anticipation ;
  - piste MIDI (synthé NOVA) : note au début de boucle + note de même hauteur tenue au-delà de la fin
    de boucle (relâchée à la fin de boucle sans couper la note du tour suivant).

Mesures par tour : 1er échantillon entendu de la grosse caisse (0 attendu), énergie des 43 premières ms
/ son sec (0 dB), écart tour / export de la même zone (≤ 1 LSB 16 bits), énergie de la fuite (rien),
repère présent une fois, tête de lecture jamais en avance sur le son.

NOVA_URL=http://127.0.0.1:3526/ python qa/pdc_boucle_lecture.py
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
OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-qa-hors-prod\pdc_boucle_lecture"))
OUT.mkdir(parents=True, exist_ok=True)
SEUIL = 1.0   # LSB 16 bits
TOURS = 4

JS = r"""
async ({ rate, cfg, tours }) => {
  const M = p => window.__novaAppModule(p);
  const { audioEngine: e } = await M('/engine/AudioEngine.ts');
  const { TrackType } = await M('/types.ts');
  const { builtinPlugin } = await M('/utils/sessionTemplate.ts');
  const { defaultSynth } = await M('/utils/novaSynth.ts');
  const REG = await M('/engine/pluginRegistry.ts');
  if (!e.ctx || e.ctx.sampleRate !== rate) await e.setSampleRate(rate);
  await e.init(); await e.resume();
  const SR = e.ctx.sampleRate;
  e.setSafetyLimiter(false);
  const LEN = 1.0, ls = cfg.from, le = cfg.from + LEN;
  const mono = (sec, f) => { const b = new AudioBuffer({ length: Math.round(sec * SR), numberOfChannels: 2, sampleRate: SR });
    for (let c = 0; c < 2; c++) { const x = b.getChannelData(c); for (let i = 0; i < x.length; i++) x[i] = f(i / SR, i); } return b; };
  // Grosse caisse : clic sur le 1er échantillon (repère de l'attaque), puis 60 Hz amorti qui glisse.
  const kick = mono(0.6, (t, i) => i === 0 ? 0.9 : 0.5 * Math.sin(2 * Math.PI * 60 * t + 6 * (1 - Math.exp(-t / 0.015))) * Math.exp(-t / 0.15));
  const bip = (hz) => mono(0.01, t => 0.4 * Math.sin(2 * Math.PI * hz * t) * Math.sin(Math.PI * t / 0.01));
  const repere = bip(2000), fuite = bip(3000);
  const eqLin = () => { const p = builtinPlugin('PROEQ12', { phase: 'linear' }, 'eq-lin'); p.params.bands[0].isEnabled = false; p.params.bands[11].isEnabled = false; return p; };
  const lim = () => { const reg = REG.getRegisteredPlugin('LIMITER'); return reg ? { id: 'fx-lim', name: 'LIMITER', type: 'LIMITER', isEnabled: true, latency: 0, params: reg.defaultParams() } : builtinPlugin('LIMITER', {}, 'fx-lim'); };
  const base = (id, type, extra) => ({ id, name: id, type, volume: 1, pan: 0, isMuted: false, isSolo: false, clips: [], plugins: [], sends: [], automationLanes: [], outputTrackId: 'master', ...extra });
  const clip = (id, at, buf) => ({ id, type: TrackType.AUDIO, start: at, duration: buf.duration, offset: 0, buffer: buf, gain: 1, name: id, fadeIn: 0, fadeOut: 0, color: '#fff' });
  const tracks = cfg.midi ? [
    base('synth', TrackType.MIDI, { novaSynth: defaultSynth(), clips: [{ id: 'c-midi', type: TrackType.MIDI, start: ls - 0.5, duration: LEN + 1.0, offset: 0, name: 'notes', fadeIn: 0, fadeOut: 0, color: '#fff',
      notes: [{ id: 'n1', pitch: 60, start: 0.5, duration: 0.3, velocity: 0.9 }, { id: 'n2', pitch: 60, start: 0.5 + LEN - 0.2, duration: 0.5, velocity: 0.9 }] }] }),
    base('master', TrackType.BUS, { outputTrackId: '', plugins: cfg.limiteur ? [eqLin(), lim()] : [eqLin()] }),
  ] : [
    base('kick', TrackType.AUDIO, { clips: [clip('c-kick', ls, kick), clip('c-repere', le - 0.03, repere), clip('c-fuite', le + 0.02, fuite)] }),
    base('master', TrackType.BUS, { outputTrackId: '', plugins: cfg.limiteur ? [eqLin(), lim()] : [eqLin()] }),
  ];
  tracks.forEach(t => e.updateTrack(t, tracks));
  tracks.forEach(t => e.updateTrack(t, tracks));
  e.setSafetyLimiter(false);
  await new Promise(r => setTimeout(r, 1500));   // worklets chargés, filtres linéaires calculés
  const latence_ms = +(e.getTrackLatency(tracks[0].id) * 1000).toFixed(3);

  const recSrc = `class R extends AudioWorkletProcessor { constructor() { super(); this.on = false; this.next = -1; this.port.onmessage = (e) => { this.on = !!e.data; }; }
    process(inputs) { const late = this.next >= 0 && currentFrame < this.next; const f = late ? this.next : currentFrame; this.next = f + 128; const i = inputs[0]; if (this.on && i && i.length) this.port.postMessage([f, i[0].slice(), (i[1] || i[0]).slice()]); return true; } }
    registerProcessor('nova-qa-rec-boucle', R);`;
  if (window.__qaRecBoucle !== e.ctx) { await e.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([recSrc], { type: 'application/javascript' }))); window.__qaRecBoucle = e.ctx; }

  const nT = Math.round(LEN * SR), n = nT * tours;
  // Export de la même zone (début → fin de boucle).
  const ex = await e.renderProject(tracks, LEN, ls, SR);
  const EL = ex.getChannelData(0), ER = ex.getChannelData(1);
  const K = kick.getChannelData(0);
  const dry = i => (i >= 0 && i < K.length ? K[i] : 0);
  const capture = async () => {
    const recNode = new AudioWorkletNode(e.ctx, 'nova-qa-rec-boucle', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit' });
    const tap = e.getMasterMeterInput();
    const mute = e.ctx.createGain(); mute.gain.value = 0;
    tap.connect(recNode); recNode.connect(mute); mute.connect(e.ctx.destination);
    const blocks = [];
    recNode.port.onmessage = ev => blocks.push(ev.data);
    recNode.port.postMessage(true);
    e.setLoop(true, ls, le);
    await new Promise(r => setTimeout(r, 400));
    const at = Math.ceil((e.ctx.currentTime + 0.3) * SR) / SR;
    e.startPlayback(ls, tracks, { at });
    const origin = e.playbackStartTime + ls;   // instant du contexte où le début de boucle s'entend (1er tour)
    const tete = [];
    const c0 = e.ctx.currentTime, w0 = performance.now();
    while (e.ctx.currentTime - c0 < LEN * tours + 0.6 && performance.now() - w0 < 90000) { await new Promise(r => setTimeout(r, 5)); tete.push([e.ctx.currentTime, e.getCurrentTime()]); }
    e.stopAll();
    e.setLoop(false, ls, le);
    await new Promise(r => setTimeout(r, 200));
    recNode.port.postMessage(false);
    try { tap.disconnect(recNode); recNode.disconnect(); mute.disconnect(); } catch (err) {}
    const L = new Float32Array(n), Rr = new Float32Array(n);
    const f0 = Math.round(origin * SR);
    let got = 0;
    for (const [fr, a, b] of blocks) for (let i = 0; i < a.length; i++) { const k = fr + i - f0; if (k >= 0 && k < n) { L[k] = a[i]; Rr[k] = b[i]; got++; } }
    const W = Math.round(0.043 * SR);
    const en = (x, a, b) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return s; };
    const db = (a, b) => +(10 * Math.log10((a + 1e-30) / (b + 1e-30))).toFixed(3);
    const tourList = [];
    for (let k = 0; k < tours; k++) {
      const o = k * nT;
      let dExp = 0, dDry = 0;
      for (let i = 0; i < nT; i++) { dExp = Math.max(dExp, Math.abs(L[o + i] - EL[i]), Math.abs(Rr[o + i] - ER[i])); }
      const r = { tour: k + 1, ecart_export_lsb16: +(dExp * 32768).toFixed(4) };
      if (!cfg.midi) {
        for (let i = 0; i < nT; i++) { const exp = i < K.length ? dry(i) : 0; if (i < K.length) dDry = Math.max(dDry, Math.abs(L[o + i] - exp)); }
        let first = -1; for (let i = 0; i < nT; i++) if (Math.abs(L[o + i]) > 0.3) { first = i; break; }
        let eD = 0; for (let i = 0; i < W; i++) eD += dry(i) * dry(i);
        // Fuite (3 kHz, 20 ms après la fin de boucle) : ce qui s'entendrait au début du tour suivant.
        const f1 = Math.round(0.02 * SR), f2 = Math.round(0.03 * SR);
        let fu = 0; for (let i = f1; i < f2; i++) { const d = L[o + i] - EL[i]; fu += d * d; }
        const p1 = nT - Math.round(0.03 * SR), p2 = p1 + Math.round(0.01 * SR);
        Object.assign(r, { premier_echantillon_entendu: first, energie_43ms_db: db(en(L, o, o + W), eD),
          ecart_sec_kick_lsb16: +(dDry * 32768).toFixed(4),
          fuite_db_fs: +(10 * Math.log10(fu / (f2 - f1) + 1e-30)).toFixed(1),
          repere_db: db(en(L, o + p1, o + p2), en(EL, p1, p2)) });
      } else {
        Object.assign(r, { energie_43ms_db: db(en(L, o, o + W), en(EL, 0, W)), energie_tour_db: db(en(L, o, o + nT), en(EL, 0, nT)),
          energie_fin_tour_db: db(en(L, o + nT - Math.round(0.25 * SR), o + nT), en(EL, nT - Math.round(0.25 * SR), nT)) });
      }
      tourList.push(r);
    }
    // Tête de lecture : jamais en avance sur ce qui s'entend (horloge à un bloc près), toujours dans la boucle.
    const q = 128 / SR + 0.0005;
    let avance = 0, hors = 0, ecart = 0;
    for (const [ct, p] of tete) {
      if (ct < origin) continue;
      const heard = ls + ((ct - origin) % LEN);
      if (p < ls - 1e-9 || p > le + 1e-9) hors++;
      let d = p - heard; if (d > LEN / 2) d -= LEN; if (d < -LEN / 2) d += LEN;
      if (d > q) avance++;
      ecart = Math.max(ecart, Math.abs(d));
    }
    return { echantillons: got, attendus: n, tours: tourList, tete_en_avance: avance, tete_hors_boucle: hors, tete_ecart_max_ms: +(ecart * 1000).toFixed(3) };
  };
  const essais = [];
  const pire = c => Math.max(...c.tours.map(t => t.ecart_export_lsb16));
  for (let k = 0; k < 3; k++) { const c = await capture(); essais.push(c); if (pire(c) <= 1 && c.echantillons >= c.attendus * 0.999) break; }
  const best = essais.filter(x => x.echantillons >= x.attendus * 0.999).reduce((a, b) => (!a || pire(b) < pire(a) ? b : a), null) || essais[essais.length - 1];
  tracks.forEach(t => e.disposeTrack(t.id));
  return { frequence: SR, latence_ms, ...best, tentatives: essais.length };
}
"""

checks = []


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:900]}"), flush=True)


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
        cfgs = [("EQ linéaire, boucle 0 → 1 s", {"from": 0.0, "limiteur": False}),
                ("EQ linéaire, boucle 2 → 3 s", {"from": 2.0, "limiteur": False}),
                ("EQ linéaire + limiteur, boucle 2 → 3 s", {"from": 2.0, "limiteur": True}),
                ("synthé NOVA + EQ linéaire, boucle 2 → 3 s", {"from": 2.0, "limiteur": False, "midi": True})]
        for rate in (44100, 48000):
            for name, cfg in cfgs:
                try:
                    r = pg.evaluate(JS, {"rate": rate, "cfg": cfg, "tours": TOURS})
                except Exception as ex:
                    r = {"erreur": str(ex)[:300], "tours": []}
                res["mesures"][f"{rate} {name}"] = r
                print(rate, name, json.dumps(r, ensure_ascii=False), flush=True)
                tag = f"[{rate} Hz · {name}]"
                tours = r.get("tours") or []
                check(f"{tag} latence compensée ≈ 43 à 55 ms", 40 <= (r.get("latence_ms") or 0) <= 55, r.get("latence_ms"))
                check(f"{tag} {TOURS} tours enregistrés en entier", len(tours) == TOURS and r.get("echantillons", 0) >= r.get("attendus", 1) * 0.999, r)
                if not cfg.get("midi"):
                    check(f"{tag} chaque tour : grosse caisse entendue dès son 1er échantillon", all(t.get("premier_echantillon_entendu") == 0 for t in tours) and tours, tours)
                    check(f"{tag} chaque tour : 43 premières ms entières (énergie = son sec à ±0,5 dB)", tours and all(abs(t.get("energie_43ms_db", -99)) <= 0.5 for t in tours), tours)
                    check(f"{tag} jonction : la fuite d'après la fin de boucle ne s'entend jamais (< −90 dBFS)", tours and all(t.get("fuite_db_fs", 0) < -90 for t in tours), tours)
                    check(f"{tag} jonction : le repère de fin de boucle s'entend une fois par tour (= export ±0,5 dB)", tours and all(abs(t.get("repere_db", -99)) <= 0.5 for t in tours), tours)
                    if not cfg["limiteur"]:
                        check(f"{tag} EQ neutre : grosse caisse = son sec à chaque tour (≤ {SEUIL} LSB 16 bits)", tours and all(t.get("ecart_sec_kick_lsb16", 99) <= SEUIL for t in tours), tours)
                    check(f"{tag} chaque tour = export de la même zone au bit près (≤ {SEUIL} LSB 16 bits)", tours and all(t.get("ecart_export_lsb16", 99) <= SEUIL for t in tours), tours)
                else:
                    check(f"{tag} chaque tour : 43 premières ms = export (±0,5 dB, note du début entière)", tours and all(abs(t.get("energie_43ms_db", -99)) <= 0.5 for t in tours), tours)
                    check(f"{tag} chaque tour : énergie du tour = export (±0,5 dB)", tours and all(abs(t.get("energie_tour_db", -99)) <= 0.5 for t in tours), tours)
                    check(f"{tag} jonction : la note tenue relâchée à la fin de boucle (250 dernières ms = export ±1 dB)", tours and all(abs(t.get("energie_fin_tour_db", -99)) <= 1.0 for t in tours[:-1]), tours)
                check(f"{tag} tête de lecture : toujours dans la boucle, jamais en avance sur le son",
                      r.get("tete_en_avance") == 0 and r.get("tete_hors_boucle") == 0, {k: r.get(k) for k in ("tete_en_avance", "tete_hors_boucle", "tete_ecart_max_ms")})
        res["erreurs_page"] = errs[:5]
        check("aucune erreur de page", not errs, errs[:5])
        b.close()
    res["checks"] = checks
    res["ok"] = all(c["ok"] for c in checks)
    (OUT / "pdc_boucle_lecture.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print("OK" if res["ok"] else "ÉCHEC", f"{sum(c['ok'] for c in checks)}/{len(checks)}")
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
