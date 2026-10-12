"""Fréquence du projet dans l'APPLI (navigateur headless, aucune fenêtre ; QA 100 % hors production) :

  A. ancien projet (sans fréquence, WAV 44,1 kHz) rouvert : moteur à 44,1 kHz, sons IDENTIQUES au
     fichier (aucune conversion), réglages de session « 44,1 kHz (projet d'avant ce réglage) »,
     et la sauvegarde n'ajoute aucune fréquence (le projet reste celui d'avant) ;
  B. projet en 48 kHz contenant un WAV 44,1 kHz : moteur recréé à 48 kHz, son converti une fois
     (plat jusqu'à 20 kHz) ;
  C. Session › Réglages : 48 → 96 kHz avec l'avertissement (« Rééchantillonner les clips… ») ;
     Annuler ne change rien ; confirmer recrée le moteur à 96 kHz et convertit le son ;
     Ctrl+Z revient à 48 kHz ;
  D. (en premier, profil neuf) accueil : nouveau projet vierge en 48 kHz (choix par défaut).

Usage : NOVA_URL=http://127.0.0.1:3492/ python qa/frequence_projets.py
Sorties : D:\\1 WORK\\CONTENU\\nova-frequence\\projets\\
"""
import io, json, math, os, struct, sys, zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-frequence\projets")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3492/")
import qalib  # noqa: E402,F401  (importe qa_hors_prod : Supabase simulé, prod bloquée)
from qalib import *  # noqa: E402,F403
from gel_pre_effet import prepare, open_project_file, save_zip  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
TONES = [1000, 10000, 18000, 19000, 20000]


def wav16(sr, seconds=3.0):
    n = int(sr * seconds)
    frames = bytearray()
    for i in range(n):
        v = sum(0.08 * math.sin(2 * math.pi * f * i / sr) for f in TONES)
        s = int(max(-1, min(1, v)) * 32767)
        frames += struct.pack("<hh", s, s)
    data = bytes(frames)
    return (b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE" + b"fmt " + struct.pack("<IHHIIHH", 16, 1, 2, sr, sr * 4, 4, 16)
            + b"data" + struct.pack("<I", len(data)) + data), n


def project_zip(path, sample_rate, wav_sr):
    wav, n = wav16(wav_sr)
    base = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0,
            "sends": [], "plugins": [], "volume": 1.0, "outputTrackId": "master"}
    clip = {"id": "c-son", "name": "Sinus", "type": "AUDIO", "audioRef": "audio/son.wav", "color": "#a78bfa", "fadeIn": 0, "fadeOut": 0,
            "gain": 1, "start": 0.0, "offset": 0.0, "duration": n / wav_sr}
    state = {"id": "proj-freq", "name": "Projet fréquence", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
             "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
             "tracks": [{**base, "id": "son", "name": "Son", "type": "AUDIO", "color": "#a78bfa", "clips": [clip]}],
             "trackGroups": [], "markers": [], "selectedTrackId": "son", "currentView": "ARRANGEMENT", "projectPhase": "MIXING",
             "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0, "recStartTime": None, "isDelayCompEnabled": True,
             "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
             "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0}}
    if sample_rate:
        state["sampleRate"] = sample_rate
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/son.wav", wav)
    return wav


# État du moteur et du son du clip (niveaux par fréquence ; écart au fichier si même fréquence).
PROBE_JS = r"""async ({ wavB64 }) => {
  const { audioEngine: e } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const { audioBufferRegistry: reg } = await window.__novaAppModule('/utils/audioBufferRegistry.ts');
  const st = window.__novaEdit && window.__novaEdit.getState();
  const clip = st && st.tracks.find(t => t.id === 'son')?.clips[0];
  const b = clip && reg.get(clip.bufferId);
  const out = { contexte: e.ctx ? e.ctx.sampleRate : null, etat_sampleRate: st ? (st.sampleRate ?? null) : 'inconnu',
                son: b ? { frequence: b.sampleRate, longueur: b.length, canaux: b.numberOfChannels } : null };
  if (b) {
    const x = b.getChannelData(0), sr = b.sampleRate;
    const lvl = f => { const a = Math.floor(x.length * 0.3), z = Math.floor(x.length * 0.7); let s = 0, c = 0;
      for (let i = a; i < z; i++) { s += x[i] * Math.sin(2 * Math.PI * f * i / sr); c += x[i] * Math.cos(2 * Math.PI * f * i / sr); }
      return +(20 * Math.log10(2 * Math.hypot(s, c) / (z - a) / 0.08 + 1e-12)).toFixed(3); };
    out.niveaux_db = Object.fromEntries([1000, 10000, 18000, 19000, 20000].map(f => [f, lvl(f)]));
    if (wavB64) {   // même fréquence : chaque échantillon = le décodage de l'ANCIEN moteur (navigateur, contexte 44,1 kHz)
      const raw = Uint8Array.from(atob(wavB64), c => c.charCodeAt(0));
      const ref = await new OfflineAudioContext(2, 1, sr).decodeAudioData(raw.buffer);
      const y = ref.getChannelData(0);
      let d = 0; const n = Math.min(b.length, y.length);
      for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(x[i] - y[i]));
      out.ecart_au_decodage_ancien_moteur = d; out.echantillons_compares = n; out.longueur_ancien_moteur = y.length;
    }
  }
  return out; }"""


def wait_rate(page, rate, timeout=60000):
    page.wait_for_function("""async (r) => { const m = await window.__novaAppModule('/engine/AudioEngine.ts');
        return m.audioEngine.ctx && m.audioEngine.ctx.sampleRate === r; }""", arg=rate, timeout=timeout)


def scenario(page, log, res, vp):
    import base64
    page.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
    prepare(page)
    # D. accueil : nouveau projet vierge
    page.goto(BASE, wait_until="domcontentloaded")   # profil neuf : rien à reprendre
    page.get_by_test_id("landing-project-rate").wait_for(timeout=25000)
    res["D_accueil_choix"] = page.get_by_test_id("landing-project-rate").input_value()
    shot(page, "D0_accueil")
    page.get_by_text("Nouveau Projet", exact=True).first.click()
    page.wait_for_timeout(3000)
    res["D_nouveau_projet"] = page.evaluate("""async () => { const { audioEngine: e } = await window.__novaAppModule('/engine/AudioEngine.ts');
        await e.init(); const st = window.__novaEdit && window.__novaEdit.getState(); return { etat_sampleRate: st ? st.sampleRate : null, contexte: e.ctx.sampleRate }; }""")
    # A. ancien projet
    old = OUT / "ancien_projet_44k.zip"
    wav_old = project_zip(old, None, 44100)
    open_project_file(page, old, res, "A0_ancien_projet")
    wait_rate(page, 44100)
    page.wait_for_timeout(1500)
    res["A_ancien_projet"] = page.evaluate(PROBE_JS, {"wavB64": base64.b64encode(wav_old).decode()})
    page.evaluate("async () => { const m = await window.__novaAppModule('/utils/r21Bus.ts'); m.openSessionPanel('reglages'); }")
    page.get_by_test_id("session-settings").wait_for(timeout=10000)
    res["A_reglages_texte"] = page.get_by_test_id("session-settings").inner_text()[:400]
    shot(page, "A1_reglages_ancien_projet")
    page.evaluate("async () => { const m = await window.__novaAppModule('/utils/r21Bus.ts'); m.openSessionPanel(null); }")
    saved, names = save_zip(page, OUT / "ancien_projet_resauve.zip")
    res["A_sauvegarde_sampleRate"] = saved.get("sampleRate", "absente")
    # B. projet 48 kHz avec un WAV 44,1 kHz
    p48 = OUT / "projet_48k_wav_44k.zip"
    project_zip(p48, 48000, 44100)
    open_project_file(page, p48, res, "B0_projet_48k")
    wait_rate(page, 48000)
    page.wait_for_timeout(2500)
    res["B_projet_48k"] = page.evaluate(PROBE_JS, {"wavB64": None})
    # C. Session › Réglages : 48 → 96 kHz
    page.evaluate("async () => { const m = await window.__novaAppModule('/utils/r21Bus.ts'); m.openSessionPanel('reglages'); }")
    page.get_by_test_id("session-rate-pick").select_option("96000")
    page.get_by_test_id("session-rate-apply").click()
    page.get_by_test_id("rate-confirm").wait_for(timeout=8000)
    res["C_avertissement"] = page.get_by_test_id("rate-confirm").inner_text()
    shot(page, "C1_avertissement")
    page.get_by_test_id("rate-confirm-cancel").click()
    page.wait_for_timeout(800)
    res["C_apres_annuler"] = page.evaluate(PROBE_JS, {"wavB64": None})
    page.get_by_test_id("session-rate-pick").select_option("96000")
    page.get_by_test_id("session-rate-apply").click()
    page.get_by_test_id("rate-confirm-ok").click()
    wait_rate(page, 96000)
    page.wait_for_function("async () => { const m = await window.__novaAppModule('/utils/audioBufferRegistry.ts'); const st = window.__novaEdit.getState(); const c = st.tracks.find(t => t.id === 'son').clips[0]; return m.audioBufferRegistry.get(c.bufferId).sampleRate === 96000; }", timeout=60000)
    page.wait_for_timeout(1000)
    res["C_apres_96k"] = page.evaluate(PROBE_JS, {"wavB64": None})
    shot(page, "C2_projet_96k")
    page.evaluate("async () => { const m = await window.__novaAppModule('/utils/r21Bus.ts'); m.openSessionPanel(null); }")
    page.mouse.click(800, 450)
    page.keyboard.press("Control+z")
    wait_rate(page, 48000)
    page.wait_for_timeout(2500)
    res["C_apres_annuler_ctrl_z"] = page.evaluate(PROBE_JS, {"wavB64": None})
    a, b_, c, d = res["A_ancien_projet"], res["B_projet_48k"], res["C_apres_96k"], res["D_nouveau_projet"]
    flat = lambda r: bool(r.get("niveaux_db")) and all(abs(v) <= 0.1 for v in r["niveaux_db"].values())  # noqa: E731
    res["verifications"] = {
        "A : ancien projet en 44,1 kHz, sans fréquence ajoutée": a["contexte"] == 44100 and a["etat_sampleRate"] is None,
        "A : son identique à l'ancien moteur (aucune conversion)": a.get("son", {}).get("frequence") == 44100 and a.get("ecart_au_decodage_ancien_moteur", 1) == 0 and a.get("son", {}).get("longueur") == a.get("longueur_ancien_moteur"),
        "A : réglages « 44,1 kHz »": "44,1 kHz" in res["A_reglages_texte"],
        "A : la sauvegarde n'ajoute pas de fréquence": res["A_sauvegarde_sampleRate"] == "absente",
        "B : moteur 48 kHz, WAV 44,1 kHz converti plat jusqu'à 20 kHz": b_["contexte"] == 48000 and b_["son"]["frequence"] == 48000 and flat(b_),
        "C : avertissement clair (rééchantillonner ou annuler)": "Rééchantillonner" in res["C_avertissement"] and "Annuler" in res["C_avertissement"],
        "C : Annuler ne change rien": res["C_apres_annuler"]["contexte"] == 48000 and res["C_apres_annuler"]["etat_sampleRate"] == 48000,
        "C : 96 kHz appliqué (moteur recréé, son converti, plat)": c["contexte"] == 96000 and c["etat_sampleRate"] == 96000 and c["son"]["frequence"] == 96000 and flat(c),
        "C : Ctrl+Z revient à 48 kHz": res["C_apres_annuler_ctrl_z"]["contexte"] == 48000 and res["C_apres_annuler_ctrl_z"]["etat_sampleRate"] == 48000,
        "D : nouveau projet en 48 kHz": res["D_accueil_choix"] == "48000" and d["etat_sampleRate"] == 48000 and d["contexte"] == 48000,
    }
    for k, v in res["verifications"].items():
        if not v:
            res["ok"] = False
            res["notes"].append(f"ÉCHEC : {k}")


if __name__ == "__main__":
    r = run_one(scenario, name="frequence_projets")
    (OUT / "frequence_projets.json").write_text(json.dumps(r, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print(json.dumps({k: r.get(k) for k in ("ok", "verifications", "notes", "A_ancien_projet", "B_projet_48k", "C_apres_96k", "C_apres_annuler_ctrl_z", "D_nouveau_projet")}, ensure_ascii=False, indent=1, default=str)[:6000])
    sys.exit(0 if r.get("ok") else 1)
