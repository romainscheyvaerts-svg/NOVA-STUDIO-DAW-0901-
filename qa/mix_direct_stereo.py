"""Mix de l'ingé en direct : STÉRÉO et qualité studio, mesurées de bout en bout.

Deux navigateurs headless (aucune fenêtre), serveur NOVA (daw-session) et
Supabase Realtime SIMULÉS (qa/collab_sim.py), 100 % hors production
(qa/qa_hors_prod.py via qalib) ; WebRTC RÉEL entre les deux pages :

  A = Lina, artiste, hôte (PC)          E = Max, ingé son (PC)

La session de Lina contient une piste « Test stéréo » (WAV 48 kHz) :
  gauche = 440 Hz (−12 dBFS) + multiton ; droite = 660 Hz (−12 dBFS) + multiton
  multiton = 16 sinus à −32 dBFS de 40 Hz à 20 kHz, identiques des deux côtés.
Max (ingé) la reçoit, diffuse son mix (« Diffuser mon mix ») et lance la
lecture ; Lina « Écoute le mix de Max ».

Mesures :
  - chez Max, ce qui PART (flux du mix : MediaStreamDestination du master) ;
  - chez Lina, ce qui ARRIVE (flux WebRTC reçu, celui que joue l'appli) :
    enregistrement 2 canaux (48 kHz), niveaux par fréquence (Goertzel, fenêtre
    de Hann, 65 536 points) ;
  - séparation gauche / droite : 440 Hz à gauche vs à droite, 660 Hz à droite
    vs à gauche (≥ 30 dB exigés) ;
  - réponse en fréquence : reçu − envoyé à chaque fréquence du multiton
    (± 3 dB jusqu'à 19,5 kHz exigés ; 20 kHz = limite d'Opus fullband, relevé) ;
  - SDP (fmtp Opus des deux côtés : stereo=1, sprop-stereo=1,
    maxaveragebitrate=510000, useinbandfec=1), codec négocié (canaux),
    débit réel (getStats, octets sur 3 s), réglages de la piste envoyée
    (aucun traitement de voix).

Usage : NOVA_URL=http://127.0.0.1:3490/ MESURE=apres python qa/mix_direct_stereo.py
Sorties : D:\\1 WORK\\CONTENU\\nova-pro4\\mix_direct_stereo\\<MESURE>\\
"""
import json, math, os, re, struct, sys, time, zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
TAG = os.environ.get("MESURE", "apres")
os.environ.setdefault("QA_OUT", rf"D:\1 WORK\CONTENU\nova-pro4\mix_direct_stereo\{TAG}")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3490/")
import qalib  # noqa
from qalib import *  # noqa
from gel_pre_effet import prepare, open_project_file  # noqa
from collab_sim import FakeNovaCloud, FakeRealtime, connect  # noqa
from feat_lib import BASE_T, dismiss, wait_for, collab, tracks, open_panel, close_panel, REC_INIT  # noqa

LINA, MAX = "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"
SR = 48000
F_L, F_R = 440, 660
MULTI = [40, 100, 250, 1000, 3000, 5000, 8000, 10000, 12000, 14000, 16000, 17000, 18000, 19000, 19500, 20000]
A_LR, A_MULTI = 10 ** (-12 / 20), 10 ** (-32 / 20)
DUREE = 40  # s : couvre largement l'écoute
TALK_FIRST = os.environ.get("TALK_FIRST", "1") != "0"  # talkback des deux côtés avant le mix (cas réel)
# Fréquence du PROJET de test (12/10/2026) : PROJET_SR=48000 → session en 48 kHz, moteurs des deux
# côtés à 48 kHz, plus aucun rééchantillonnage avant Opus ; comparé à la référence « Opus seul ».
PROJET_SR = int(os.environ.get("PROJET_SR", "0") or 0)

# Toutes les connexions WebRTC de la page (pour lire SDP et codec négocié), sans rien changer à l'appli.
PCS_INIT = """(() => { const O = window.RTCPeerConnection; if (!O || O.__qa) return; const list = []; window.__qaPcs = list;
  const P = class extends O { constructor(c) { super(c); list.push(this); } }; P.__qa = true; window.RTCPeerConnection = P; })();"""


def stereo_wav() -> bytes:
    """1 s périodique (fréquences entières), répété : gauche 440 Hz, droite 660 Hz, multiton des deux côtés."""
    per = bytearray()
    for i in range(SR):
        t = i / SR
        m = sum(A_MULTI * math.sin(2 * math.pi * f * t) for f in MULTI)
        l = A_LR * math.sin(2 * math.pi * F_L * t) + m
        r = A_LR * math.sin(2 * math.pi * F_R * t) + m
        per += struct.pack("<hh", int(max(-1, min(1, l)) * 32767), int(max(-1, min(1, r)) * 32767))
    data = bytes(per) * DUREE
    return (b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE" + b"fmt " + struct.pack("<IHHIIHH", 16, 1, 2, SR, SR * 4, 4, 16)
            + b"data" + struct.pack("<I", len(data)) + data)


def stereo_project(path: Path):
    clip = {"id": "st1", "name": "Test stéréo", "start": 0, "duration": DUREE, "offset": 0, "fadeIn": 0, "fadeOut": 0,
            "color": "#a78bfa", "type": "AUDIO", "audioRef": "audio/test_stereo.wav", "gain": 1, "takeNumber": 1}
    tracks_ = [{**BASE_T, "id": "stereo", "name": "Test stéréo", "type": "AUDIO", "color": "#a78bfa", "volume": 1.0, "outputTrackId": "master",
                "sends": [], "clips": [clip], "plugins": []}]
    state = {
        "id": "proj-stereo", "name": "Mix direct stéréo", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": tracks_, "trackGroups": [], "markers": [], "selectedTrackId": "stereo", "currentView": "ARRANGEMENT",
        "projectPhase": "MIXING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    if PROJET_SR:
        state["sampleRate"] = PROJET_SR
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/test_stereo.wav", stereo_wav())


def launch_rtc(p):
    return p.chromium.launch(headless=True, executable_path=CHROME, args=[
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={FAKE_WAV}",
        "--autoplay-policy=no-user-gesture-required", "--disable-features=WebRtcHideLocalIpsWithMdns",
    ])


# Enregistre 2 canaux d'un flux (reçu chez Lina / envoyé chez Max) dès qu'il porte du son, puis
# mesure chaque fréquence (Goertzel, Hann). L'entrée est « speakers » : un flux MONO arrive
# identique à gauche et à droite (séparation 0 dB), un flux stéréo garde ses deux canaux.
MEASURE_JS = """async ({ which, freqs, secs }) => {
  // recu : le flux WebRTC que joue l'appli chez Lina, enregistré dans un contexte à 48 kHz.
  // envoye : chez Max, le nœud du master qui alimente le flux du mix (dans SON contexte audio).
  let ctx, src, own = false, tr = null, stream = null;
  if (which === 'recu' || which === 'boucle') { const el = which === 'boucle' ? null : document.querySelector('audio[data-collab-audio$=":mix"]');
    stream = which === 'boucle' ? window.__qaLoop && window.__qaLoop.remote : el && el.srcObject; if (!stream) return { erreur: 'aucun flux reçu' };
    tr = stream.getAudioTracks()[0]; ctx = new AudioContext({ sampleRate: 48000 }); own = true; await ctx.resume(); src = ctx.createMediaStreamSource(stream); }
  else { const m = await window.__novaAppModule('/engine/AudioEngine.ts'); ctx = m.audioEngine.getAudioContext(); src = m.audioEngine.getMasterMeterInput();
    stream = m.audioEngine.getCollabMixStream(); tr = stream && stream.getAudioTracks()[0]; if (!ctx || !src) return { erreur: 'moteur de Max absent' }; }
  const sr = ctx.sampleRate, n = Math.round(secs * sr);
  const sp = ctx.createScriptProcessor(4096, 2, 2); sp.channelCount = 2; sp.channelCountMode = 'explicit'; sp.channelInterpretation = 'speakers';
  const mute = ctx.createGain(); mute.gain.value = 0; src.connect(sp); sp.connect(mute); mute.connect(ctx.destination);
  const L = new Float32Array(n), R = new Float32Array(n); let w = 0, started = false; const t0 = performance.now(); let tSon = null;
  await new Promise((res) => {
    sp.onaudioprocess = (e) => { const a = e.inputBuffer.getChannelData(0), b = e.inputBuffer.getChannelData(1);
      if (!started) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i] + b[i] * b[i]; if (s / a.length > 1e-6) { started = true; tSon = Math.round(performance.now() - t0); } else return; }
      if (performance.now() - t0 < tSon + 500) return;  // 0,5 s après le premier son (montée du codec)
      for (let i = 0; i < a.length && w < n; i++, w++) { L[w] = a[i]; R[w] = b[i]; }
      if (w >= n) res(); };
    setTimeout(res, 30000); });
  sp.onaudioprocess = null; try { src.disconnect(sp); } catch (e) {} try { sp.disconnect(); mute.disconnect(); } catch (e) {} if (own) await ctx.close();
  if (w < n) return { erreur: 'pas assez de son (' + w + ' échantillons)', premier_son_ms: tSon };
  // Puissance moyenne par fréquence (Welch) : segments de 0,1 s (raies de 10 Hz : chaque fréquence
  // testée tombe sur une raie), fenêtre de Hann, recouvrement 50 %. Insensible aux petits sauts de
  // temps du tampon de gigue (une mesure cohérente sur 2 s y perdait jusqu'à 6 dB).
  const seg = Math.round(sr / 10), hop = seg >> 1, han = new Float32Array(seg); for (let i = 0; i < seg; i++) han[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / seg);
  const lvl = (x, f) => { const k = 2 * Math.PI * f / sr, c = 2 * Math.cos(k), ck = Math.cos(k), sk = Math.sin(k); let p = 0, m = 0;
    for (let o = 0; o + seg <= n; o += hop, m++) { let s1 = 0, s2 = 0; for (let i = 0; i < seg; i++) { const s0 = x[o + i] * han[i] + c * s1 - s2; s2 = s1; s1 = s0; }
      const re = s1 - s2 * ck, im = s2 * sk; p += (re * re + im * im); }
    return 20 * Math.log10(4 * Math.sqrt(p / Math.max(1, m)) / seg + 1e-12); };
  const out = {}; for (const f of freqs) out[f] = { g: +lvl(L, f).toFixed(2), d: +lvl(R, f).toFixed(2) };
  let dmax = 0, sL = 0, sR = 0; for (let i = 0; i < n; i++) { dmax = Math.max(dmax, Math.abs(L[i] - R[i])); sL += L[i] * L[i]; sR += R[i] * R[i]; }
  let st = null; try { st = tr ? tr.getSettings() : null; } catch (e) {}
  return { frequence_echantillonnage: sr, niveaux: out, rms_g_db: +(10 * Math.log10(sL / n + 1e-12)).toFixed(2), rms_d_db: +(10 * Math.log10(sR / n + 1e-12)).toFixed(2),
           ecart_max_g_d: +dmax.toFixed(5), premier_son_ms: tSon, reglages_piste: st, contentHint: tr ? (tr.contentHint ?? null) : null, piste_id: tr ? tr.id : null }; }"""

# Référence « Opus seul » : le même multiton, dans un contexte audio à `rate` Hz, envoyé par une
# boucle WebRTC locale (deux connexions dans la page) avec le MÊME réglage Opus que l'appli
# (utils/opusSdp). À 48 kHz : Opus fullband seul ; à 44,1 kHz (le moteur de NOVA) : plus le
# rééchantillonnage 44,1 → 48 kHz du navigateur avant le codeur.
LOOP_JS = """async ({ rate, freqs, amp }) => {
  const { tuneOpusSdp } = await window.__novaAppModule('/utils/opusSdp.ts');
  const ctx = new AudioContext({ sampleRate: rate }); await ctx.resume();
  const dest = ctx.createMediaStreamDestination(); dest.channelCount = 2; const merger = ctx.createChannelMerger(2);
  for (const f of freqs) { const o = ctx.createOscillator(); o.frequency.value = f; const g = ctx.createGain(); g.gain.value = amp; o.connect(g); g.connect(merger, 0, 0); g.connect(merger, 0, 1); o.start(); }
  merger.connect(dest);
  const a = new RTCPeerConnection(), b = new RTCPeerConnection();
  a.onicecandidate = e => { if (e.candidate) b.addIceCandidate(e.candidate).catch(() => {}); }; b.onicecandidate = e => { if (e.candidate) a.addIceCandidate(e.candidate).catch(() => {}); };
  const got = new Promise(r => { b.ontrack = e => r(e.streams[0] || new MediaStream([e.track])); });
  a.addTrack(dest.stream.getAudioTracks()[0], dest.stream);
  const off = await a.createOffer(); await a.setLocalDescription({ type: 'offer', sdp: tuneOpusSdp(off.sdp) });
  await b.setRemoteDescription(a.localDescription); const ans = await b.createAnswer(); await b.setLocalDescription({ type: 'answer', sdp: tuneOpusSdp(ans.sdp) });
  await a.setRemoteDescription(b.localDescription);
  const remote = await got; const el = new Audio(); el.srcObject = remote; el.muted = true; el.play().catch(() => {});
  window.__qaLoop = { ctx, a, b, el, remote };
  return { contexte: ctx.sampleRate }; }"""

LOOP_CLOSE_JS = """async () => { const l = window.__qaLoop; if (!l) return; try { l.el.pause(); l.el.srcObject = null; } catch (e) {} l.a.close(); l.b.close(); await l.ctx.close(); window.__qaLoop = null; }"""

STATS_JS = """async () => { const out = [];
  for (const pc of (window.__qaPcs || [])) { if (pc.connectionState === 'closed') continue;
    const rep = await pc.getStats(); const codecs = {}, sources = {}; rep.forEach(x => { if (x.type === 'codec') codecs[x.id] = x; if (x.type === 'media-source') sources[x.id] = x; });
    const items = []; rep.forEach(x => { if ((x.type !== 'inbound-rtp' && x.type !== 'outbound-rtp') || x.kind !== 'audio') return; const c = codecs[x.codecId] || {};
      items.push({ type: x.type, octets: x.bytesReceived ?? x.bytesSent ?? 0, paquets: x.packetsReceived ?? x.packetsSent ?? 0, ts: x.timestamp,
        codec: c.mimeType || null, canaux: c.channels ?? null, fmtp: c.sdpFmtpLine || null, piste: x.trackIdentifier || (sources[x.mediaSourceId] || {}).trackIdentifier || null,
        cible_kbps: x.targetBitrate ? Math.round(x.targetBitrate / 1000) : null, fec_recus: x.fecPacketsReceived ?? null,
        perdus: x.packetsLost ?? null, gigue_ms: typeof x.jitter === 'number' ? Math.round(x.jitter * 1000) : null,
        dissimules: x.concealedSamples ?? null, echantillons: x.totalSamplesReceived ?? null }); });
    // fmtp Opus de chaque section audio (par mid), et quelle piste chaque section reçoit / envoie.
    const secs = s => { const out = {}; (s || '').split(/\\r\\n(?=m=)/).forEach(sec => { if (!/^m=audio/.test(sec)) return;
      const mid = (sec.match(/^a=mid:(\\S+)/m) || [])[1]; const pt = (sec.match(/^a=rtpmap:(\\d+) opus\\/48000\\/2/im) || [])[1];
      const f = pt ? (sec.match(new RegExp('^a=fmtp:' + pt + ' (.*)$', 'm')) || [])[1] : null; out[mid] = f ? f.trim() : null; }); return out; };
    const tx = pc.getTransceivers().map(t => ({ mid: t.mid, recoit: t.receiver.track ? t.receiver.track.id : null, envoie: t.sender.track ? t.sender.track.id : null, sens: t.currentDirection }));
    out.push({ etat: pc.connectionState, flux: items, sections_local: secs(pc.localDescription && pc.localDescription.sdp),
               sections_distant: secs(pc.remoteDescription && pc.remoteDescription.sdp), transceivers: tx }); }
  return out; }"""


def bitrate(page, kind, track_id=None):
    """Débit réel (kb/s) du flux audio du mix (inbound / outbound, filtré par piste) mesuré sur 3 s par getStats."""
    def total():
        s = page.evaluate(STATS_JS)
        it = [f for pc in s for f in pc["flux"] if f["type"] == kind and (track_id is None or f["piste"] == track_id)]
        return sum(f["octets"] for f in it), (max(f["ts"] for f in it) if it else 0), s
    b0, t0, _ = total()
    page.wait_for_timeout(3000)
    b1, t1, s = total()
    kbps = round((b1 - b0) * 8 / max(1e-3, (t1 - t0)), 1) if t1 > t0 else None  # octets·8 / ms = kb/s
    return kbps, s


def run():
    res = {"name": "mix_direct_stereo", "mesure": TAG, "talkback_avant_le_mix": TALK_FIRST, "ok": True, "steps": [], "verifications": {},
           "note": "Serveur NOVA et Supabase Realtime SIMULÉS ; WebRTC réel entre deux pages headless ; aucune requête vers la production."}
    cloud = FakeNovaCloud(per_device=True, codes=True, strict=True)
    rt = FakeRealtime()
    src = OUT / "00_session_test_stereo.novaproj.zip"
    stereo_project(src)
    link = {}

    def check(label, ok):
        res["verifications"][label] = bool(ok)
        if not ok:
            res["ok"] = False

    def step(label, fn):
        t = time.time()
        try:
            o = fn()
            res["steps"].append({"step": label, "ok": True, "s": round(time.time() - t, 1), **({"info": o} if o else {})})
            return o
        except Exception as e:  # noqa
            res["ok"] = False
            res["steps"].append({"step": label, "ok": False, "err": f"{type(e).__name__}: {str(e)[:600]}"})
            for tag, pg in (("A", A), ("E", E)):
                try: shot(pg, f"ECHEC_{len(res['steps'])}_{tag}")
                except Exception: pass
            return None

    with sync_playwright() as p:
        b = launch_rtc(p)
        logs = {k: Log(f"stereo_{k}") for k in ("A", "E")}
        ctxA, A = new_page(b, "pc", logs["A"])
        ctxE, E = new_page(b, "pc", logs["E"])
        for pg in (A, E):
            pg.add_init_script(REC_INIT)
            pg.add_init_script(PCS_INIT)
            prepare(pg, None, desktop=False)
        connect(A, cloud, rt, "A", LINA, "lina@test.local")
        connect(E, cloud, rt, "E", MAX, "max@test.local")
        for pg in (A, E):
            pg.goto(BASE, wait_until="domcontentloaded", timeout=180000)
            pg.get_by_text("Nouveau Projet").first.wait_for(timeout=180000)

        def a_start():
            open_project_file(A, src, res, "A1_session_test_stereo")
            dismiss(A); open_panel(A)
            A.get_by_placeholder("Ton nom (affiché aux autres)").fill("Lina")
            A.get_by_role("button", name="Démarrer la collaboration en direct").click()
            wait_for(A, lambda: collab(A, "c.role()") == "artist", 60, what="collaboration ouverte chez Lina")
            sid = next(k for k, v in cloud.sessions.items() if v["manifest"])
            link["s"] = f"{sid}.{cloud.sessions[sid]['secret']}"
        step("Lina ouvre la session « Test stéréo » et démarre « En direct »", a_start)

        def e_link():
            E.goto(f"{BASE}?session={link['s']}&invite=1", wait_until="domcontentloaded")
            wait_for(E, lambda: E.get_by_test_id("collab-arrival").count() > 0, 60, what="choix du rôle (Max)")
            E.wait_for_timeout(1500); dismiss(E)
            E.get_by_test_id("arrival-role-engineer").click()
            E.get_by_label("Ton nom", exact=True).fill("Max")
            E.get_by_test_id("arrival-join").click()
            wait_for(E, lambda: collab(E, "c.role()") == "engineer", 60, what="Max relié")
            dismiss(E)
            wait_for(E, lambda: any(c["buf"] for t in (tracks(E) or []) if t["id"] == "stereo" for c in t["clips"]), 90, what="audio de la piste stéréo chargé chez Max")
        step("Max (ingé) rejoint et reçoit la piste stéréo", e_link)

        def hold_talk(pg, ms=1500):
            t = pg.get_by_test_id("collab-talk"); t.scroll_into_view_if_needed(); bx = t.bounding_box()
            pg.mouse.move(bx["x"] + bx["width"] / 2, bx["y"] + bx["height"] / 2); pg.mouse.down(); pg.wait_for_timeout(ms); pg.mouse.up()

        def stream():
            # Ordre d'une vraie séance : on se parle d'abord (talkback des deux côtés), PUIS l'ingé
            # diffuse son mix. Le mix arrive alors sur une 2e (ou 3e) section audio de la connexion.
            if TALK_FIRST:
                open_panel(A); hold_talk(A)
                open_panel(E); hold_talk(E)
                E.wait_for_timeout(1500)
            open_panel(E)
            E.get_by_test_id("collab-mix-out").click()
            E.keyboard.press("Escape")
            open_panel(A)
            wait_for(A, lambda: A.get_by_test_id("collab-mix-listen").count() > 0, 30, step=100, what="« Écouter le mix de Max » chez Lina")
            A.get_by_test_id("collab-mix-listen").click()
            E.evaluate("() => window.DAW_CONTROL.seek(0)"); E.wait_for_timeout(300)
            E.get_by_role("button", name=re.compile(r"^(Lecture|Lire)")).locator("visible=true").first.click()
            freqs = sorted(set([F_L, F_R] + MULTI))
            rates_js = "async () => { const m = await window.__novaAppModule('/engine/AudioEngine.ts'); return m.audioEngine.ctx ? m.audioEngine.ctx.sampleRate : null; }"
            res["frequence_moteur"] = {"lina": A.evaluate(rates_js), "max": E.evaluate(rates_js), "projet": PROJET_SR or "absente (44,1 kHz)"}
            recu = A.evaluate(MEASURE_JS, {"which": "recu", "freqs": freqs, "secs": 2})
            envoye = E.evaluate(MEASURE_JS, {"which": "envoye", "freqs": freqs, "secs": 2})
            kin, sA = bitrate(A, "inbound-rtp", (recu or {}).get("piste_id"))
            kout, sE = bitrate(E, "outbound-rtp", (envoye or {}).get("piste_id"))
            shot(A, "A2_lina_ecoute_mix_stereo"); shot(E, "E1_max_diffuse_mix")
            status = A.locator("[data-testid=collab-mix-status]").first
            try:
                wait_for(A, lambda: A.get_by_test_id("collab-mix-quality").count() > 0, 10, step=200, what="qualité affichée")
            except AssertionError:
                pass
            ui = {"etat": status.get_attribute("data-state"), "texte": status.inner_text()} if status.count() else None
            q = A.get_by_test_id("collab-mix-quality")
            ui_q = {"texte": q.inner_text(), "alerte": q.get_attribute("data-warn") == "1"} if q.count() else None
            E.keyboard.press("Space")
            return {"recu": recu, "envoye": envoye, "debit_recu_kbps": kin, "debit_envoye_kbps": kout, "stats_lina": sA, "stats_max": sE, "indicateur_lina": ui, "qualite_affichee": ui_q}
        m = step("Max diffuse son mix et lance la lecture ; Lina écoute (mesures des deux côtés)", stream)

        def references():
            freqs = sorted(set([1000] + MULTI))
            out = {}
            for rate in (48000, 44100):
                A.evaluate(LOOP_JS, {"rate": rate, "freqs": freqs, "amp": A_MULTI})
                r = A.evaluate(MEASURE_JS, {"which": "boucle", "freqs": freqs, "secs": 2})
                A.evaluate(LOOP_CLOSE_JS)
                if r and "niveaux" in r:
                    ref = (r["niveaux"]["1000"]["g"] + r["niveaux"]["1000"]["d"]) / 2
                    out[str(rate)] = {str(f): round((r["niveaux"][str(f)]["g"] + r["niveaux"][str(f)]["d"]) / 2 - ref, 2) for f in MULTI}
                else:
                    out[str(rate)] = r
            return out
        refs = step("Références : Opus seul (boucle locale à 48 kHz) et Opus après rééchantillonnage 44,1 → 48 kHz", references)

        if m and m["recu"] and "niveaux" in m["recu"] and m["envoye"] and "niveaux" in m["envoye"]:
            r, e = m["recu"]["niveaux"], m["envoye"]["niveaux"]
            g =lambda d, f: d.get(str(f)) or d.get(f)  # noqa
            sep_l = round(g(r, F_L)["g"] - g(r, F_L)["d"], 1)
            sep_r = round(g(r, F_R)["d"] - g(r, F_R)["g"], 1)
            sep_env_l = round(g(e, F_L)["g"] - g(e, F_L)["d"], 1)
            sep_env_r = round(g(e, F_R)["d"] - g(e, F_R)["g"], 1)
            rep = {f: round(((g(r, f)["g"] + g(r, f)["d"]) - (g(e, f)["g"] + g(e, f)["d"])) / 2, 2) for f in MULTI}
            ref1k = (g(r, 1000)["g"] + g(r, 1000)["d"]) / 2
            rel = {f: round((g(r, f)["g"] + g(r, f)["d"]) / 2 - ref1k, 2) for f in MULTI}
            res["mesures"] = {
                "separation_recu_db": {"440 Hz (gauche vs droite)": sep_l, "660 Hz (droite vs gauche)": sep_r},
                "separation_envoye_db": {"440 Hz": sep_env_l, "660 Hz": sep_env_r},
                "reponse_recu_moins_envoye_db": rep,
                "reponse_recu_relative_1kHz_db": rel,
                "debit_recu_kbps": m["debit_recu_kbps"], "debit_envoye_kbps": m["debit_envoye_kbps"],
                "ecart_max_g_d_recu": m["recu"].get("ecart_max_g_d"),
                "reglages_piste_envoyee": m["envoye"].get("reglages_piste"), "contentHint_envoye": m["envoye"].get("contentHint"),
                "reglages_piste_recue": m["recu"].get("reglages_piste"),
            }
            check(f"séparation gauche / droite reçue chez Lina ≥ 30 dB (440 Hz : {sep_l} dB, 660 Hz : {sep_r} dB)", sep_l >= 30 and sep_r >= 30)
            bad = {f: v for f, v in rep.items() if f <= 18000 and abs(v - rep[1000]) > 1}
            check(f"réponse reçue = envoyée à ± 1 dB de 40 Hz à 18 kHz (écarts : {bad or 'aucun'})", not bad)
            # Au-delà de 18 kHz : pas plus de perte que la référence « Opus fullband » mesurée dans les
            # mêmes conditions (boucle locale, contexte à 44,1 kHz comme le moteur de NOVA).
            ref44 = (refs or {}).get("44100") if isinstance(refs, dict) else None
            if isinstance(ref44, dict) and str(1000) in ref44:
                ecarts = {f: round((rep[f] - rep[1000]) - ref44[str(f)], 2) for f in MULTI if f >= 16000}
                res["mesures"]["ecart_a_la_reference_opus_db"] = ecarts
                # Écart > 0 : le mix perd MOINS que la référence ; on refuse seulement une perte en plus.
                pire = {f: v for f, v in ecarts.items() if f <= 20000 and v < -1.5}
                check(f"de 16 à 20 kHz : pas de coupure au-delà de la référence Opus fullband (perte en plus ≤ 1,5 dB ; {pire or 'aucune'})", not pire)
            else:
                check("références Opus mesurées", False)
            res["mesures"]["reference_opus_seul_48k_relative_1kHz_db"] = (refs or {}).get("48000") if isinstance(refs, dict) else refs
            ref48 = (refs or {}).get("48000") if isinstance(refs, dict) else None
            if PROJET_SR == 48000 and isinstance(ref48, dict) and str(1000) in ref48:
                # Projet en 48 kHz : le mix ne passe plus par aucun rééchantillonnage ; il doit
                # coller à « Opus seul » jusqu'à 20 kHz (± 1 dB).
                e48 = {f: round((rep[f] - rep[1000]) - ref48[str(f)], 2) for f in MULTI if f >= 12000}
                res["mesures"]["ecart_a_opus_seul_48k_db"] = e48
                fm = res.get("frequence_moteur") or {}
                check(f"moteurs à 48 kHz des deux côtés ({fm})", fm.get("lina") == 48000 and fm.get("max") == 48000)
                check(f"projet en 48 kHz : réponse = Opus seul à ± 1 dB jusqu'à 20 kHz ({e48})", all(abs(v) <= 1.0 for v in e48.values()))
            res["mesures"]["reference_opus_contexte_44k_relative_1kHz_db"] = ref44
            check(f"débit réel du mix ≥ 256 kb/s (reçu {m['debit_recu_kbps']} kb/s)", (m["debit_recu_kbps"] or 0) >= 256)
            st = m["envoye"].get("reglages_piste") or {}
            check("flux du mix sans traitement de voix (echoCancellation / noiseSuppression / autoGainControl absents ou faux)",
                  not any(st.get(k) for k in ("echoCancellation", "noiseSuppression", "autoGainControl")))
        else:
            check("mesures stéréo faites des deux côtés", False)

        MUSIC = ("stereo=1", "sprop-stereo=1", "maxaveragebitrate=510000", "useinbandfec=1")

        def sdp_mix(pcs, track_id, side):
            """fmtp Opus (local et distant) de la section audio qui porte le mix (side : recoit / envoie)."""
            for pc in pcs:
                for t in pc["transceivers"]:
                    if track_id and t[side] == track_id:
                        return {"mid": t["mid"], "local": pc["sections_local"].get(t["mid"]), "distant": pc["sections_distant"].get(t["mid"]),
                                "toutes_sections": {"local": pc["sections_local"], "distant": pc["sections_distant"]}}
            return None

        def music_ok(sec):
            return bool(sec) and all(sec.get(k) and all(w in sec[k] for w in MUSIC) for k in ("local", "distant"))
        if m:
            lA = sdp_mix(m["stats_lina"], (m.get("recu") or {}).get("piste_id"), "recoit")
            lE = sdp_mix(m["stats_max"], (m.get("envoye") or {}).get("piste_id"), "envoie")
            res["sdp_fmtp"] = {"lina": lA, "max": lE}
            check("SDP Opus de la section du MIX, des deux côtés : stereo=1 ; sprop-stereo=1 ; maxaveragebitrate=510000 ; useinbandfec=1", music_ok(lA) and music_ok(lE))
            mix_id = (m.get("recu") or {}).get("piste_id")
            inb = [f for pc in m["stats_lina"] for f in pc["flux"] if f["type"] == "inbound-rtp" and f["piste"] == mix_id]
            res["codec_recu"] = [{k: f[k] for k in ("codec", "canaux", "fmtp", "perdus", "gigue_ms", "fec_recus", "dissimules", "echantillons")} for f in inb]
            qa_ = m.get("qualite_affichee")
            res["qualite_affichee_chez_lina"] = qa_
            check("Lina voit la qualité du mix reçu : « stéréo · … kb/s » (sans alerte mono)", bool(qa_) and "stéréo" in qa_["texte"] and not qa_["alerte"])
            check("codec négocié pour le MIX chez Lina : Opus 2 canaux", any((f["codec"] or "").lower() == "audio/opus" and f["canaux"] == 2 for f in inb))

        for k, lg in logs.items():
            res[f"erreurs_{k}"] = [x["text"][:200] for x in lg.errors()][:12]
            save_log(lg)
        res["ecritures_bloquees"] = sum(len(getattr(pg, "_blocked", [])) for pg in (A, E))
        b.close()

    (OUT / "resultat_mix_direct_stereo.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: res.get(k) for k in ("ok", "mesure", "steps", "verifications", "mesures", "sdp_fmtp", "codec_recu")}, ensure_ascii=False, indent=1)[:12000])
    return res


if __name__ == "__main__":
    r = run()
    sys.exit(0 if r["ok"] else 1)
