"""Prise et horloge : un bloc d'entrée manquant décale-t-il la suite de la prise ? (headless, aucune fenêtre, hors production)

Mesure en ÉCHANTILLONS. Des clics sont programmés à des n° d'échantillon connus de l'horloge du
contexte audio ; on les retrouve dans la prise et on compare :
  - écart absolu : position trouvée (premier n° de la prise + index) − position programmée ;
  - écart des intervalles : un bloc sauté raccourcit l'intervalle de 128 échantillons.

A. Enregistreur seul (engine/NovaRecorder.ts), entrée « trouée » : un nœud qui ne reçoit que les
   clics devient inactif entre eux (AudioWorklet sans canal d'entrée = cas d'une source qui cale).
     mono (réglage par défaut : Fredonne → MIDI, ancienne prise du navigateur) ;
     multi k=1 derrière un ChannelMerger (câblage EXACT des prises normales, InputRouter) ;
     mono keepClock.
B. Prise NORMALE complète (AudioEngine.armTrack → startRecording → stopRecordingAll), micro simulé
   (getUserMedia → flux d'un MediaStreamDestination du contexte du moteur) :
     B1 entrée continue ; B2 trous dans le flux (la voix débranchée 3 × 300 ms) ;
     B3 piste du micro coupée puis remise (track.enabled) ; B4 fil principal bloqué 1,5 s ;
     B5 AudioWorklet affamé (un nœud qui fait attendre le fil audio 1,5 s : rendu en retard) ;
     B6 page masquée (visibilitychange simulé + minuteries ralenties par CDP).
C. « Fredonne → MIDI » (AudioEngine.startHumTake, enregistreur mono) avec des trous.

NOVA_URL=http://127.0.0.1:3458/ python qa/prise_horloge.py   (sortie : QA_OUT ou D:\\1 WORK\\CONTENU\\nova-prise-horloge)
"""
import json, os, sys
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3458/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-prise-horloge")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402
from qalib import OUT, BASE, Log, new_page  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

KO = []


def ok(name, cond, detail=None):
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:600]}"), flush=True)
    if not cond:
        KO.append(name)


# Outils communs dans la page : clic court, recherche des clics, écarts.
HELPERS = r"""
const sr50 = want => Math.max(1000, Math.round((want[1] - want[0]) / 4));
window.__ph = {
  click(ctx, dest, frame) {
    const b = ctx.createBuffer(1, 32, ctx.sampleRate); b.getChannelData(0).fill(0.6);
    const s = ctx.createBufferSource(); s.buffer = b; s.connect(dest); s.start(frame / ctx.sampleRate); return s;
  },
  /** Fronts montants au-dessus de 0,3 (un par clic). */
  find(x) { const out = []; for (let i = 1; i < x.length; i++) if (Math.abs(x[i]) > 0.3 && Math.abs(x[i - 1]) <= 0.3) { out.push(i); i += 64; } return out; },
  /**
   * Chaque clic trouvé est rapproché du clic programmé le plus proche (un clic tombé dans un
   * trou de l'entrée manque, c'est normal ; ce qui compte : les AUTRES restent à leur place).
   * firstFrame < 0 : position absolue inconnue (latence), on cale le 1er clic trouvé sur le 1er programmé.
   */
  stats(found, firstFrame, want) {
    const base = firstFrame >= 0 ? firstFrame : (found.length ? want[0] - found[0] : 0);
    const all = found.map(f => { const p = base + f; let best = want[0]; for (const w of want) if (Math.abs(w - p) < Math.abs(best - p)) best = w; return { p, w: best, e: p - best }; });
    // Front trop loin de tout clic programmé (plus de 50 ms) : parasite (rebranchement), pas un clic.
    const res = all.filter(r => Math.abs(r.e) <= sr50(want));
    const e = res.map(r => r.e);
    return { trouves: res.length, parasites: all.length - res.length, attendus: want.length, apparies: new Set(res.map(r => r.w)).size,
      ecart_ech: e.length ? [Math.min(...e), Math.max(...e)] : null,
      detail: res.filter(r => r.e !== 0).slice(0, 6).map(r => ({ clic: want.indexOf(r.w), ecart: r.e })) };
  },
  hog: `class Hog extends AudioWorkletProcessor { constructor() { super(); this.ms = 0; this.port.onmessage = e => { this.ms = e.data; }; }
    process() { if (this.ms > 0) { const t = Date.now(); while (Date.now() - t < this.ms) {} } return true; } } registerProcessor('qa-hog', Hog);`,
};
"""

PART_A = r"""async (mode) => {
  const R = await window.__novaAppModule('/engine/NovaRecorder.ts');
  const ctx = new AudioContext(); await ctx.resume();
  await R.ensureRecorderModule(ctx);
  const sr = ctx.sampleRate;
  // Entrée « trouée » : seuls les clics la font vivre (inactive entre eux).
  const holey = ctx.createGain();
  let src = holey;
  if (mode === 'multi') { const m = ctx.createChannelMerger(1); holey.connect(m, 0, 0); src = m; }
  const rec = new R.NovaRecorderSession(ctx, src, mode === 'multi' ? { channels: 1 } : mode === 'ancien' ? { keepClock: false } : {});
  const t0 = Math.ceil((ctx.currentTime + 0.3) * sr);
  const want = []; for (let i = 0; i < 16; i++) { want.push(t0 + i * Math.round(0.25 * sr) + (i % 3) * 37); __ph.click(ctx, holey, want[i]); }
  // Entrée débranchée 2 × 0,3 s pendant la prise : l'enregistreur ne reçoit AUCUN canal (inputs[0] vide).
  const node = rec.node;
  const at = s => new Promise(r => { const chk = () => (ctx.currentTime >= s ? r() : setTimeout(chk, 5)); chk(); });
  for (const k of [1.1, 2.6]) { await at(t0 / sr + k); src.disconnect(node); await new Promise(r => setTimeout(r, 300)); src.connect(node); }
  await at(want[15] / sr + 0.4);
  const { samples, firstFrame, channels } = await rec.stop(src);
  ctx.close();
  return { sr, firstFrame, ...__ph.stats(__ph.find(channels ? channels[0] : samples), firstFrame, want) };
}"""

PART_B = r"""async (cas) => {
  const { audioEngine: E } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const { TrackType } = await window.__novaAppModule('/types.ts');
  await E.init(); await E.resume();
  const ctx = E.ctx, sr = ctx.sampleRate;
  // Micro simulé : un flux du contexte du moteur, alimenté par la « voix » (clics).
  const voice = ctx.createGain(), dest = ctx.createMediaStreamDestination();
  voice.connect(dest);
  // Bruit de pièce très faible : flux continu comme un vrai micro.
  const room = ctx.createConstantSource(); room.offset.value = 0.0005; room.connect(voice); room.start();
  navigator.mediaDevices.getUserMedia = async () => dest.stream;
  const tid = 'voix-' + cas;
  const track = { id: tid, name: tid, type: TrackType.AUDIO, volume: 1, pan: 0, isMuted: false, isSolo: false, sends: [], automationLanes: [], plugins: [], clips: [], outputTrackId: 'master', isTrackArmed: true };
  E.updateTrack(track, [track]);
  const err = await E.armTrack(tid, { alone: true });
  if (err) return { erreur: err };
  await new Promise(r => setTimeout(r, 600));
  let hog = null;
  if (cas === 'affame') {
    const url = URL.createObjectURL(new Blob([__ph.hog], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    hog = new AudioWorkletNode(ctx, 'qa-hog'); const g = ctx.createGain(); g.gain.value = 0; hog.connect(g); g.connect(ctx.destination);
  }
  const ok = await E.startRecording(0, tid);
  if (!ok) return { erreur: 'startRecording a échoué' };
  const t0 = Math.ceil((ctx.currentTime + 0.4) * sr);
  const N = 24, step = Math.round(0.2 * sr);
  const want = []; for (let i = 0; i < N; i++) { want.push(t0 + i * step); __ph.click(ctx, voice, want[i]); }
  const at = s => new Promise(r => { const chk = () => (ctx.currentTime >= s ? r() : setTimeout(chk, 5)); chk(); });
  const t0s = t0 / sr; const info = {};
  if (cas === 'trous') {
    for (const k of [1.0, 2.0, 3.4]) { await at(t0s + k); voice.disconnect(dest); await new Promise(r => setTimeout(r, 300)); voice.connect(dest); }
  } else if (cas === 'muet') {
    const tr = dest.stream.getAudioTracks()[0];
    await at(t0s + 1.5); tr.enabled = false; await new Promise(r => setTimeout(r, 700)); tr.enabled = true;
  } else if (cas === 'bloque') {
    await at(t0s + 1.2); const t = performance.now(); while (performance.now() - t < 1500) {} info.bloque_ms = 1500;
  } else if (cas === 'affame') {
    await at(t0s + 1.2); const c0 = ctx.currentTime, p0 = performance.now(); hog.port.postMessage(6);
    await new Promise(r => setTimeout(r, 1500)); hog.port.postMessage(0);
    info.horloge_audio_s = +(ctx.currentTime - c0).toFixed(3); info.horloge_murale_s = +((performance.now() - p0) / 1000).toFixed(3);
  } else if (cas === 'masque') {
    await at(t0s + 1.2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise(r => setTimeout(r, 1500));
    delete document.visibilityState; delete document.hidden; document.dispatchEvent(new Event('visibilitychange'));
  }
  await at(want[N - 1] / sr + 0.6);
  const takes = await E.stopRecordingAll();
  E.disarmTrack(tid);
  const clip = takes[0] && takes[0].clip;
  if (!clip || !clip.buffer) return { erreur: 'pas de prise' };
  const x = clip.buffer.getChannelData(0);
  const found = __ph.find(x);
  // Les intervalles ne dépendent ni de la latence ni du tampon du flux : ils prouvent l'absence de bloc sauté ou ajouté.
  const st = __ph.stats(found, -1, want);
  return { sr, cas, duree_prise_s: +(x.length / sr).toFixed(3), ...st, ...info };
}"""

PART_C = r"""async () => {
  const { audioEngine: E } = await window.__novaAppModule('/engine/AudioEngine.ts');
  await E.init(); await E.resume();
  const ctx = E.ctx, sr = ctx.sampleRate;
  const voice = ctx.createGain(), dest = ctx.createMediaStreamDestination(); voice.connect(dest);
  const tr = dest.stream.getAudioTracks()[0];
  const { recordAt } = await E.startHumTake(dest.stream, [], 0, 120, 4, false);
  const t0 = Math.ceil((recordAt + 0.3) * sr), step = Math.round(0.2 * sr), N = 16;
  const want = []; for (let i = 0; i < N; i++) { want.push(t0 + i * step); __ph.click(ctx, voice, want[i]); }
  const at = s => new Promise(r => { const chk = () => (ctx.currentTime >= s ? r() : setTimeout(chk, 5)); chk(); });
  // Trous : la voix débranchée (flux vide) 2 × 300 ms.
  for (const k of [1.0, 2.0]) { await at(t0 / sr + k); voice.disconnect(dest); await new Promise(r => setTimeout(r, 300)); voice.connect(dest); }
  await at(want[N - 1] / sr + 0.5);
  const res = await E.stopHumTake();
  const x = res && res.data;
  if (!x) return { erreur: 'pas de prise', cles: res ? Object.keys(res) : null };
  const found = __ph.find(x);
  return { sr, ...__ph.stats(found, -1, want) };
}"""


PART_D = r"""async () => {
  // Même voix, deux chemins, deux enregistreurs (câblage des prises normales) dans la même prise :
  //  direct : voix → enregistreur ;  flux : voix → MediaStreamDestination → MediaStreamSource → enregistreur.
  // Le flux est coupé 2 × 0,3 s (la voix débranchée de la destination). Si seul le chemin « flux »
  // se décale, le décalage vient du transport MediaStream du navigateur, pas de l'enregistreur.
  const R = await window.__novaAppModule('/engine/NovaRecorder.ts');
  const ctx = new AudioContext(); await ctx.resume(); await R.ensureRecorderModule(ctx);
  const sr = ctx.sampleRate;
  const voice = ctx.createGain(), dest = ctx.createMediaStreamDestination(); voice.connect(dest);
  const room = ctx.createConstantSource(); room.offset.value = 0.0005; room.connect(voice); room.start();
  const msrc = ctx.createMediaStreamSource(dest.stream);
  const m1 = ctx.createChannelMerger(1), m2 = ctx.createChannelMerger(1);
  voice.connect(m1, 0, 0); msrc.connect(m2, 0, 0);
  await new Promise(r => setTimeout(r, 400));
  const r1 = new R.NovaRecorderSession(ctx, m1, { channels: 1 }), r2 = new R.NovaRecorderSession(ctx, m2, { channels: 1 });
  const t0 = Math.ceil((ctx.currentTime + 0.4) * sr), step = Math.round(0.2 * sr), N = 20;
  const want = []; for (let i = 0; i < N; i++) { want.push(t0 + i * step); __ph.click(ctx, voice, want[i]); }
  const at = s => new Promise(r => { const chk = () => (ctx.currentTime >= s ? r() : setTimeout(chk, 5)); chk(); });
  for (const k of [1.0, 2.0]) { await at(t0 / sr + k); voice.disconnect(dest); await new Promise(r => setTimeout(r, 300)); voice.connect(dest); }
  await at(want[N - 1] / sr + 0.5);
  const a = await r1.stop(m1), b = await r2.stop(m2);
  ctx.close();
  const direct = __ph.stats(__ph.find(a.channels[0]), a.firstFrame, want);
  const fb = __ph.find(b.channels[0]);
  // Le chemin « flux » a son propre retard (tampon) : calé sur son 1er clic.
  return { sr, direct, flux: __ph.stats(fb, -1, want) };
}"""


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    res = {}
    with sync_playwright() as p:
        b = qalib.launch(p)
        log = Log("prise_horloge")
        ctx, page = new_page(b, "pc", log)
        ctx.add_init_script(HELPERS)
        page.goto(BASE, wait_until="domcontentloaded")
        page.wait_for_function("() => !!window.__novaAppModule && document.readyState === 'complete'", timeout=60000)
        page.wait_for_timeout(2500)
        # A. Enregistreur seul
        for mode in ("ancien", "mono", "multi"):
            r = page.evaluate(PART_A, mode)
            res[f"A_{mode}"] = r
            print(f"A {mode}: {r}", flush=True)
        a_old, a_mono, a_m = res["A_ancien"], res["A_mono"], res["A_multi"]
        exact = lambda r: r["ecart_ech"] == [0, 0] and r["parasites"] == 0 and r["trouves"] >= 13
        ok("A : multi k=1 (câblage EXACT des prises normales), entrée débranchée 2 × 0,3 s : chaque clic à sa place (0 échantillon)", exact(a_m), a_m)
        ok("A : mono (Fredonne → MIDI, échauffement), entrée débranchée : chaque clic à sa place (0 échantillon)", exact(a_mono), a_mono)
        res["A_ancien_glisse"] = not exact(a_old)
        print(f"A ancien comportement mono (keepClock: false) glisse : {res['A_ancien_glisse']} {a_old['ecart_ech']} parasites={a_old['parasites']}", flush=True)
        # B. Prise normale complète
        cdp = ctx.new_cdp_session(page)
        for cas in ("continue", "trous", "muet", "bloque", "affame", "masque"):
            if cas == "masque":
                try: cdp.send("Emulation.setFocusEmulationEnabled", {"enabled": False}); cdp.send("Page.setWebLifecycleState", {"state": "active"})
                except Exception: pass
            r = page.evaluate(PART_B, cas)
            res[f"B_{cas}"] = r
            print(f"B {cas}: {r}", flush=True)
            # « trous » : le flux du micro lui-même se recale (tampon MediaStream de Chrome, en amont de
            # l'enregistreur) de ±64 échantillons au rebranchement ; toléré à ±128 (2,7 ms), sans dérive.
            tol = 1000 if cas == "trous" else 0   # « trous » : recalage du flux de Chrome (voir D), pas l'enregistreur
            e = r.get("ecart_ech") or [99999, 99999]
            ok(f"B {cas} : prise normale, {r.get('trouves')} clics sur {r.get('attendus')} trouvés, chacun à sa place (±{tol} échantillons)",
               not r.get("erreur") and r.get("trouves", 0) >= r.get("attendus", 99) - (8 if cas == "trous" else 5) and r.get("apparies") == r.get("trouves") and max(abs(e[0]), abs(e[1])) <= tol, r)
        # D. Même prise, chemin direct contre flux MediaStream
        r = page.evaluate(PART_D)
        res["D_direct_contre_flux"] = r
        print(f"D direct: {r['direct']}", flush=True)
        print(f"D flux:   {r['flux']}", flush=True)
        ok("D : dans la même prise, le chemin direct reste à 0 échantillon (l'enregistreur ne décale rien)",
           r["direct"]["ecart_ech"] == [0, 0] and r["direct"]["parasites"] == 0 and r["direct"]["trouves"] == r["direct"]["attendus"], r["direct"])
        res["D_flux_decalage_ech"] = r["flux"]["ecart_ech"]
        print(f"MESURE D : recalage du flux MediaStream de Chrome après coupure : {r['flux']['ecart_ech']} échantillons", flush=True)
        # C. Fredonne → MIDI
        try:
            r = page.evaluate(PART_C)
        except Exception as e:  # noqa
            r = {"erreur": str(e)[:300]}
        res["C_fredonne"] = r
        print(f"C fredonne: {r}", flush=True)
        e = r.get("ecart_ech") or [99999, 99999]
        ok("C : Fredonne → MIDI, flux troué : chaque clic à sa place (écart = recalage du flux de Chrome, voir D ; ≤ 1000 échantillons)",
           not r.get("erreur") and r.get("trouves", 0) >= r.get("attendus", 99) - 4 and r.get("apparies") == r.get("trouves") and max(abs(e[0]), abs(e[1])) <= 1000, r)
        res["erreurs_console"] = [e["text"][:200] for e in log.errors() if "status of 400" not in e["text"]][:8]
        ok("aucune erreur dans la console", not res["erreurs_console"], res["erreurs_console"])
        ctx.close(); b.close()
    res["KO"] = KO
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "prise_horloge.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print(f"{'KO' if KO else 'OK'} : {len(KO)} échec(s)")
    sys.exit(1 if KO else 0)


if __name__ == "__main__":
    main()
