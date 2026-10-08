"""Pannes injectées (isolation des erreurs) : le reste du studio et le son continuent.

a) Panne d'un panneau pendant la lecture (console de mixage, arrangement, fenêtre
   d'effet, navigateur latéral) : le panneau est remplacé par un message, un bouton du
   transport répond, la lecture avance, le niveau du master ne bouge pas ; « Relancer
   ce panneau » le ramène.
b) Un worklet d'effet lève une exception pendant la lecture : la piste fautive repasse
   au son sec (au lieu du silence), l'autre piste ne bouge pas, l'effet passe en bypass
   dans le projet et une notification s'affiche.

Usage :
  NOVA_URL=http://127.0.0.1:3442/ PYTHONIOENCODING=utf-8 python qa/pannes_injectees.py
Sortie : D:\\1 WORK\\CONTENU\\nova-stabilite\\pannes_injectees.json (+ captures headless)
"""
import io, json, math, os, sys, time, wave, zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-stabilite")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3442/")
from qalib import BASE, OUT, Log, launch, new_page, shot  # noqa: E402
from gel_pre_effet import prepare  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SR = 44100
DUR = 20.0


def tone_wav(freq, amp):
    t = np.arange(int(DUR * SR)) / SR
    x = amp * np.sin(2 * np.pi * freq * t)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((x * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def make_project(path: Path):
    def clip(cid, ref):
        return {"id": cid, "name": cid, "start": 0, "duration": DUR, "offset": 0, "fadeIn": 0, "fadeOut": 0,
                "color": "#22d3ee", "type": "AUDIO", "audioRef": ref, "gain": 1}

    def track(tid, name, clips, plugins):
        return {"id": tid, "name": name, "type": "AUDIO", "color": "#22d3ee", "isMuted": False, "isSolo": False,
                "isTrackArmed": False, "isFrozen": False, "volume": 1.0, "pan": 0, "outputTrackId": "master", "sends": [],
                "clips": clips, "plugins": plugins, "automationLanes": [], "totalLatency": 0}
    master = {"id": "master", "name": "MASTER BUS", "type": "BUS", "color": "#00f2ff", "isMuted": False, "isSolo": False,
              "isTrackArmed": False, "isFrozen": False, "volume": 1.0, "pan": 0, "outputTrackId": "", "sends": [], "clips": [],
              "plugins": [], "automationLanes": [], "totalLatency": 0}
    tracks = [master,
              track("voix", "Voix", [clip("c-voix", "audio/voix.wav")], [{"id": "fx-panne", "name": "Effet test (panne)", "type": "QA_CRASH", "isEnabled": True, "params": {}}]),
              track("beat", "Beat", [clip("c-beat", "audio/beat.wav")], [{"id": "fx-comp", "name": "Compresseur", "type": "COMPRESSOR", "isEnabled": True, "params": {}}])]
    state = {"id": "proj-pannes", "name": "Pannes injectées", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
             "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": True, "loopStart": 0, "loopEnd": DUR - 1,
             "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": "voix", "currentView": "ARRANGEMENT",
             "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
             "recStartTime": None, "isDelayCompEnabled": True,
             "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
             "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0}}
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/voix.wav", tone_wav(330, 0.3))
        z.writestr("audio/beat.wav", tone_wav(110, 0.3))


# Effet de test : passe-plat dans un worklet qui lève une exception sur demande (message « boom »).
REGISTER_QA_EFFECT = r"""
async () => {
  const reg = await window.__novaAppModule('/engine/pluginRegistry.ts');
  if (reg.PLUGIN_REGISTRY.some(p => p.type === 'QA_CRASH')) return 'déjà';
  const SRC = `class QaCrash extends AudioWorkletProcessor {
    constructor() { super(); this.boom = false; this.port.onmessage = (e) => { if (e.data === 'boom') this.boom = true; }; }
    process(inputs, outputs) {
      if (this.boom) throw new Error('Panne injectée dans le worklet (test)');
      const i = inputs[0], o = outputs[0];
      for (let c = 0; c < o.length; c++) { if (i && i[c]) o[c].set(i[c]); else o[c].fill(0); }
      return true;
    }
  }
  registerProcessor('qa-crash', QaCrash);`;
  const url = URL.createObjectURL(new Blob([SRC], { type: 'application/javascript' }));
  const loaded = new WeakMap();
  window.__qaCrashNodes = [];
  reg.PLUGIN_REGISTRY.push({
    type: 'QA_CRASH', name: 'Effet test (panne)', category: 'Test', icon: 'fa-bug', color: '#f00', description: 'test',
    defaultParams: () => ({}), ui: () => null,
    create: (ctx) => {
      const input = ctx.createGain(), output = ctx.createGain();
      input.connect(output);
      const fx = { input, output, worklet: null, updateParams() {} };
      let p = loaded.get(ctx); if (!p) { p = ctx.audioWorklet.addModule(url); loaded.set(ctx, p); }
      p.then(() => {
        const n = new AudioWorkletNode(ctx, 'qa-crash', { outputChannelCount: [2] });
        fx.worklet = n;
        input.disconnect(); input.connect(n); n.connect(output);
        if (ctx instanceof AudioContext) window.__qaCrashNodes.push(n);
      });
      return fx;
    },
  });
  return 'ok';
}
"""

LEVELS = r"""
async (ids) => {
  const { audioEngine: e } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const rms = (an) => { if (!an) return null; const d = new Float32Array(an.fftSize); an.getFloatTimeDomainData(d); let s = 0; for (const x of d) s += x * x; return Math.sqrt(s / d.length); };
  const acc = {}; const keys = ['master', ...ids];
  for (const k of keys) acc[k] = 0;
  const N = 8;
  for (let i = 0; i < N; i++) {
    acc.master += rms(e.masterAnalyzerL) || 0;
    for (const id of ids) acc[id] += rms(e.tracksDSP.get(id)?.analyzer) || 0;
    await new Promise(r => setTimeout(r, 60));
  }
  const db = (v) => v > 0 ? Math.round(20 * Math.log10(v) * 10) / 10 : -120;
  const out = {}; for (const k of keys) out[k] = db(acc[k] / N);
  out.t = Math.round(window.DAW_CONTROL.getState().currentTime * 100) / 100;
  out.playing = !!window.DAW_CONTROL.getState().isPlaying;
  return out;
}
"""


def levels(page, ids=("voix", "beat")):
    return page.evaluate(LEVELS, list(ids))


def crashed_panels(page):
    return page.evaluate("() => Array.from(document.querySelectorAll('[data-panel-crash]')).map(e => e.getAttribute('data-panel-crash'))")


def set_fault(page, name, on=True):
    page.evaluate("([n, on]) => { const s = (globalThis.__novaFaults ||= new Set()); if (on) s.add(n); else s.delete(n); }", [name, on])


def poke(page):
    """Force un rendu de l'appli (volume du beat inchangé à 1e-6 près)."""
    page.evaluate("() => { const s = window.DAW_CONTROL.getState(); const t = s.tracks.find(x => x.id === 'beat'); window.DAW_CONTROL.updateTrack({ ...t, volume: t.volume === 1 ? 0.999999 : 1 }); }")


def loop_button_works(page):
    before = page.evaluate("() => window.DAW_CONTROL.getState().isLoopActive")
    page.get_by_role("button", name="Boucle", exact=True).first.click(timeout=4000)
    page.wait_for_timeout(300)
    after = page.evaluate("() => window.DAW_CONTROL.getState().isLoopActive")
    page.get_by_role("button", name="Boucle", exact=True).first.click(timeout=4000)
    page.wait_for_timeout(200)
    return before != after


def relaunch(page, name):
    set_fault(page, name, False)
    page.locator(f'[data-panel-crash="{name}"] button', has_text="Relancer ce panneau").first.click(timeout=4000)
    page.wait_for_timeout(900)
    ok = name not in crashed_panels(page)
    if not ok:
        print("  relance :", page.locator(f'[data-panel-crash="{name}"]').first.inner_text()[:300])
    return ok


def run():
    OUT.mkdir(parents=True, exist_ok=True)
    proj = OUT / "pannes_injectees.novaproj.zip"
    make_project(proj)
    res = {"url": BASE, "panneaux": {}, "worklet": {}, "verifs": [], "ok": True}

    def check(label, cond, detail=""):
        res["verifs"].append({"verif": label, "ok": bool(cond), "detail": detail})
        if not cond: res["ok"] = False

    log = Log("pannes_injectees")
    with sync_playwright() as p:
        b = launch(p)
        ctx, page = new_page(b, "pc", log)
        ctx.add_init_script("try { localStorage.setItem('nova_welcome_seen','1'); localStorage.setItem('nova_headphones','1'); localStorage.setItem('nova_simple_mode','0'); } catch (e) {}")
        prepare(page, None, desktop=False)
        try:
            page.goto(BASE, wait_until="domcontentloaded")
            page.get_by_text("Charger Projet").first.wait_for(timeout=40000)
            res["registre"] = page.evaluate(REGISTER_QA_EFFECT)
            page.get_by_text("Charger Projet").first.click(); page.wait_for_timeout(700)
            with page.expect_file_chooser(timeout=8000) as fc:
                page.get_by_text("Charger depuis l'ordinateur").first.click()
            fc.value.set_files(str(proj))
            for _ in range(40):
                page.wait_for_timeout(500)
                if page.evaluate("() => !!(window.DAW_CONTROL && window.DAW_CONTROL.diag && window.DAW_CONTROL.diag().tracks >= 3)"): break
            for name in ("C'est parti", "Plus tard"):
                bt = page.get_by_role("button", name=name, exact=True).locator("visible=true").first
                try:
                    if bt.is_visible(): bt.click(); page.wait_for_timeout(300)
                except Exception:
                    pass
            page.wait_for_timeout(2500)
            page.evaluate("() => window.DAW_CONTROL.seek(0)")
            for _ in range(5):
                page.evaluate("async () => { if (!window.DAW_CONTROL.getState().isPlaying) await window.DAW_CONTROL.togglePlay(); }")
                page.wait_for_timeout(1500)
                if page.evaluate("() => window.DAW_CONTROL.getState().isPlaying"): break
            ref = levels(page)
            res["reference"] = ref
            check("lecture lancée et son présent", ref["playing"] and ref["master"] > -40, json.dumps(ref))

            # ------------------------------------------------ a) panneaux en panne
            scenarios = [
                ("la console de mixage", lambda: page.evaluate("() => window.DAW_CONTROL.setView('MIXER')")),
                ("l'arrangement", lambda: (page.evaluate("() => window.DAW_CONTROL.setView('ARRANGEMENT')"), page.wait_for_timeout(500), poke(page))),
                ("la fenêtre d'effet", lambda: page.locator(".fx-slot button[aria-label^='Ouvrir Compresseur'], button[aria-label^='Ouvrir Compresseur']").first.click(timeout=5000)),
                ("le navigateur latéral", lambda: poke(page)),
            ]
            for name, trigger in scenarios:
                r = {}
                before = levels(page)
                set_fault(page, name, True)
                trigger()
                page.wait_for_timeout(900)
                crashed = crashed_panels(page)
                r["panneau_remplace"] = name in crashed
                r["autres_panneaux_en_panne"] = [c for c in crashed if c != name]
                r["message"] = page.locator(f'[data-panel-crash="{name}"]').first.inner_text(timeout=3000).split("\n")[:2] if name in crashed else None
                shot(page, f"panne_{name.replace(' ', '_').replace(chr(39), '')}")
                during = levels(page)
                page.wait_for_timeout(700)
                during2 = levels(page)
                r["transport_repond"] = loop_button_works(page)
                r["position_avance"] = during2["t"] != during["t"]
                r["relance_ok"] = relaunch(page, name)
                after = levels(page)
                r["master_dB"] = {"avant": before["master"], "pendant": during["master"], "apres": after["master"]}
                r["lecture"] = {"avant_s": before["t"], "pendant_s": [during["t"], during2["t"]], "apres_s": after["t"], "en_lecture": during2["playing"]}
                res["panneaux"][name] = r
                check(f"{name} : seul ce panneau est remplacé", r["panneau_remplace"] and not r["autres_panneaux_en_panne"], str(crashed))
                check(f"{name} : le transport répond", r["transport_repond"])
                check(f"{name} : la lecture avance", r["position_avance"] and during2["playing"], json.dumps(r["lecture"]))
                check(f"{name} : le son du master ne bouge pas (±1 dB)", abs(during["master"] - before["master"]) <= 1.0 and abs(after["master"] - before["master"]) <= 1.0, json.dumps(r["master_dB"]))
                check(f"{name} : « Relancer ce panneau » le ramène", r["relance_ok"])
                if name == "la fenêtre d'effet":
                    # Fenêtre refermée par sa croix (Échap arrête aussi la lecture).
                    try:
                        page.get_by_role("button", name="Fermer").locator("visible=true").last.click(timeout=2000)
                    except Exception:
                        pass
                    page.wait_for_timeout(300)

            # ------------------------------------------------ b) worklet qui plante
            w = {}
            nodes = page.evaluate("() => (window.__qaCrashNodes || []).length")
            w["worklets_de_test"] = nodes
            avant = levels(page)
            page.evaluate("() => { window.__qaNotes = []; const o = new MutationObserver(() => { const t = document.body.innerText; const m = t.match(/L'effet « [^»]+ » de « [^»]+ » a planté[^\\n]*/); if (m && !window.__qaNotes.includes(m[0])) window.__qaNotes.push(m[0]); }); o.observe(document.body, { childList: true, subtree: true, characterData: true }); window.__qaCrashNodes.forEach(n => n.port.postMessage('boom')); }")
            page.wait_for_timeout(250)
            juste_apres = levels(page)
            page.wait_for_timeout(1200)
            apres = levels(page)
            state_fx = page.evaluate("() => window.DAW_CONTROL.getState().tracks.find(t => t.id === 'voix').plugins.map(p => ({ id: p.id, isEnabled: p.isEnabled }))")
            notes = page.evaluate("() => window.__qaNotes")
            shot(page, "panne_worklet_notification")
            w.update({"niveaux_dB": {"avant": avant, "250ms_apres": juste_apres, "1s5_apres": apres}, "effet_dans_le_projet": state_fx, "notification": notes})
            check("worklet : l'effet de test tourne vraiment dans un worklet", nodes >= 1, str(nodes))
            check("worklet : l'autre piste ne bouge pas (±0,5 dB)", abs(apres["beat"] - avant["beat"]) <= 0.5 and abs(juste_apres["beat"] - avant["beat"]) <= 0.5, f"{avant['beat']} → {juste_apres['beat']} → {apres['beat']}")
            check("worklet : la piste fautive revient au son sec (pas de silence, ±1 dB)", apres["voix"] > -40 and abs(apres["voix"] - avant["voix"]) <= 1.0 and juste_apres["voix"] > -40, f"{avant['voix']} → {juste_apres['voix']} → {apres['voix']}")
            check("worklet : l'effet est passé en bypass dans le projet", any(x["id"] == "fx-panne" and x["isEnabled"] is False for x in state_fx), json.dumps(state_fx))
            check("worklet : notification affichée", bool(notes), json.dumps(notes, ensure_ascii=False))
            check("worklet : la lecture continue", apres["playing"])
            # Réactivé : effet recréé (nouveau worklet), le son passe toujours.
            page.evaluate("() => window.DAW_CONTROL.toggleBypass('voix', 'fx-panne')")
            page.wait_for_timeout(1200)
            react = levels(page)
            w["reactive"] = {"worklets_de_test": page.evaluate("() => (window.__qaCrashNodes || []).length"), "niveaux_dB": react}
            check("worklet : réactivé, l'effet est recréé et la piste sonne", w["reactive"]["worklets_de_test"] > nodes and react["voix"] > -40, json.dumps(w["reactive"]))
            res["worklet"] = w
        except Exception as e:  # noqa
            res["ok"] = False
            res["exception"] = f"{type(e).__name__}: {str(e)[:500]}"
            try: shot(page, "pannes_injectees__FAIL")
            except Exception: pass
        finally:
            res["erreurs_page"] = [x["text"][:200] for x in log.entries if x["kind"] == "pageerror"][:20]
            ctx.close(); b.close()
    out = OUT / "pannes_injectees.json"
    out.write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    for v in res["verifs"]:
        print(("OK   " if v["ok"] else "ÉCHEC"), v["verif"], "" if v["ok"] else v["detail"])
    print("→", out, "| ok =", res["ok"])
    return res


if __name__ == "__main__":
    run()
