"""Scénario de bout en bout : gel automatique au studio, éditions sur la tablette,
retour au PC de l'ingé (éditions rejouées AVANT les effets), mesures audio.

Usage :
  NOVA_URL=http://127.0.0.1:4000/ QA_OUT="D:\\1 WORK\\CONTENU\\nova-gel-pre-effet" python qa/gel_pre_effet.py

Le pont VST du PC est SIMULÉ dans la page (aucune connexion au vrai port 8765) :
deux « plugins VST3 » de test, un compresseur en insert sur la voix et une
reverb sur un envoi, rendus en Python (numpy) quand NOVA demande un rendu.
Les écritures vers Supabase restent bloquées (qalib) ; la fonction de facturation
est simulée (admin) pour exporter sans paiement.
"""
import io, json, os, re, struct, subprocess, sys, time, wave, zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-gel-pre-effet")
from qalib import *  # noqa

FFMPEG = os.environ.get("FFMPEG", r"C:\Users\lenno\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0-full_build\bin\ffmpeg.exe")
COMP_PATH = r"C:\Program Files\Common Files\VST3\NovaTestComp.vst3"
VERB_PATH = r"C:\Program Files\Common Files\VST3\NovaTestVerb.vst3"
SR = 44100
PHRASES = [(1.0, 3.0), (4.0, 6.0), (7.0, 9.0)]  # voix : 3 phrases (s)


# ------------------------------------------------------------ projet de départ
def voice_wav() -> bytes:
    t = np.arange(int(10 * SR)) / SR
    x = np.zeros_like(t)
    for a, b in PHRASES:
        m = (t >= a) & (t < b)
        env = np.minimum(1, np.minimum((t[m] - a) / 0.02, (b - t[m]) / 0.02))
        x[m] = 0.5 * env * (np.sin(2 * np.pi * 220 * t[m]) + 0.4 * np.sin(2 * np.pi * 440 * t[m]) + 0.2 * np.sin(2 * np.pi * 660 * t[m])) / 1.6
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def vst(pid, name, path):
    return {"id": pid, "name": name, "type": "VST3", "isEnabled": True, "latency": 0,
            "params": {"name": name, "vendor": "Make Music (test)", "localPath": path, "pluginName": None, "stateB64": "dGVzdA=="}}


def make_project(path: Path):
    clips = [{"id": f"p{i+1}", "name": f"Phrase {i+1}", "start": a, "duration": b - a, "offset": a, "fadeIn": 0, "fadeOut": 0,
              "color": "#22d3ee", "type": "AUDIO", "audioRef": "audio/voix.wav", "gain": 1, "takeNumber": 1} for i, (a, b) in enumerate(PHRASES)]
    base = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0}
    tracks = [
        {**base, "id": "voix", "name": "Voix lead", "type": "AUDIO", "color": "#22d3ee", "volume": 1.0, "outputTrackId": "master",
         "sends": [{"id": "verb-vst", "level": 0.6, "isEnabled": True}], "clips": clips, "plugins": [vst("vst-comp", "NovaTest Comp", COMP_PATH)]},
        {**base, "id": "verb-vst", "name": "Reverb VST", "type": "SEND", "color": "#a78bfa", "volume": 1.0, "outputTrackId": "master",
         "sends": [], "clips": [], "plugins": [vst("vst-verb", "NovaTest Verb", VERB_PATH)]},
    ]
    state = {
        "id": "proj-gel-test", "name": "Gel pre-effet", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": None, "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/voix.wav", voice_wav())


# ------------------------------------------------------------ « plugins VST » de test
def fx_comp(x, sr):
    """Compresseur (seuil -20 dBFS, 4:1, attaque 5 ms, relâche 100 ms) : non linéaire."""
    mono = np.max(np.abs(x), axis=0)
    a, r = np.exp(-1 / (0.005 * sr)), np.exp(-1 / (0.1 * sr))
    env = np.zeros_like(mono); e = 0.0
    for i, v in enumerate(mono):
        e = a * e + (1 - a) * v if v > e else r * e + (1 - r) * v
        env[i] = e
    thr = 10 ** (-20 / 20)
    g = np.where(env > thr, (thr * (env / thr) ** (1 / 4)) / np.maximum(env, 1e-9), 1.0)
    return (x * g * 1.8).astype(np.float32)


_IR = None
def fx_verb(x, sr):
    """Reverb 100 % mouillée : bruit à décroissance exponentielle (RT60 ≈ 1,6 s, 2,5 s)."""
    global _IR
    if _IR is None or _IR[0] != sr:
        rng = np.random.default_rng(7)
        n = int(2.5 * sr)
        t = np.arange(n) / sr
        ir = rng.standard_normal((2, n)) * np.exp(-6.91 * t / 1.6)
        ir[:, : int(0.02 * sr)] = 0  # pré-délai 20 ms
        ir *= 0.6 / np.sqrt(np.sum(ir[0] ** 2))
        _IR = (sr, ir)
    ir = _IR[1]
    n = x.shape[1]
    size = 1 << int(np.ceil(np.log2(n + ir.shape[1])))
    out = np.zeros((2, n), dtype=np.float32)
    for c in range(2):
        xc = x[min(c, x.shape[0] - 1)]
        y = np.fft.irfft(np.fft.rfft(xc, size) * np.fft.rfft(ir[c], size), size)[:n]
        out[c] = y
    return out


class FakeBridge:
    """Pont VST simulé (protocole v6 de NovaBridge) dans la page de test."""
    def __init__(self, installed=(COMP_PATH, VERB_PATH)):
        self.installed = list(installed)
        self.renders = []
        self.requests = []

    def plugins(self):
        out = []
        for p in self.installed:
            name = Path(p).stem
            out.append({"id": p, "name": name, "vendor": "Make Music (test)", "category": "Effect", "path": p, "uid": name,
                        "plugin_name": None, "is_instrument": False, "scan_status": "ok"})
        return out

    def handler(self, ws):
        ws.on_message(lambda m: self.on_message(ws, m))

    def on_message(self, ws, m):
        if isinstance(m, (bytes, bytearray)):
            self.on_binary(ws, bytes(m)); return
        try:
            req = json.loads(m)
        except Exception:
            return
        act = req.get("action"); rid = req.get("req_id")
        self.requests.append(act)
        if act in ("HELLO", "PING"):
            ws.send(json.dumps({"req_id": rid, "success": True, "version": 6, "binary_audio": True, "render": True,
                                "editor": False, "pedalboard": True, "instruments": False, "license_events": False}))
        elif act == "GET_PLUGIN_LIST":
            ws.send(json.dumps({"req_id": rid, "success": True, "plugins": self.plugins(), "instruments_pending": False, "probe_progress": None}))
        elif act == "LOAD_PLUGIN":
            # Pas de flux temps réel dans le test (jamais de connexion au vrai pont) : le son passe tel quel.
            ws.send(json.dumps({"req_id": rid, "success": False, "error": "Lecture temps réel désactivée dans le test"}))
        elif act == "GET_STATE":
            ws.send(json.dumps({"req_id": rid, "success": True, "state": "dGVzdA==", "hash": "x"}))
        else:
            ws.send(json.dumps({"req_id": rid, "success": True}))

    def process(self, meta, x, sr):
        """Effet du « plugin » de test (surchargé par le pont v7 de qa/collab_sim.py)."""
        return fx_verb(x, sr) if "Verb" in (meta.get("path") or "") else fx_comp(x, sr)

    def on_binary(self, ws, buf):
        if buf[0] != 2:
            return
        (jlen,) = struct.unpack_from("<I", buf, 4)
        meta = json.loads(buf[8:8 + jlen].decode("utf-8"))
        off = (8 + jlen + 3) & ~3
        nch = int(meta.get("nch") or 2); nframes = int(meta.get("nframes") or 0); sr = int(meta.get("sample_rate") or 48000)
        data = np.frombuffer(buf, dtype="<f4", offset=off, count=nframes * nch).reshape(nframes, nch).T
        path = meta.get("path") or ""
        rid = meta.get("req_id")
        try:
            if path not in self.installed:
                raise RuntimeError("Plugin introuvable sur ce PC")
            x = np.vstack([data[0], data[min(1, nch - 1)]]).astype(np.float32)
            y = self.process(meta, x, sr)
            self.renders.append({"plugin": Path(path).stem, "seconds": round(nframes / sr, 2), "in_rms": float(np.sqrt(np.mean(x ** 2))), "out_rms": float(np.sqrt(np.mean(y ** 2)))})
            j = json.dumps({"action": "RENDER", "req_id": rid, "success": True, "nch": 2, "nframes": y.shape[1], "sample_rate": sr}).encode()
            o = (8 + len(j) + 3) & ~3
            head = bytearray(o); head[0] = 2; struct.pack_into("<I", head, 4, len(j)); head[8:8 + len(j)] = j
            ws.send(bytes(head) + np.ascontiguousarray(y.T, dtype="<f4").tobytes())
        except Exception as e:  # noqa
            j = json.dumps({"action": "RENDER", "req_id": rid, "success": False, "error": str(e)}).encode()
            o = (8 + len(j) + 3) & ~3
            head = bytearray(o); head[0] = 2; struct.pack_into("<I", head, 4, len(j)); head[8:8 + len(j)] = j
            ws.send(bytes(head))


# ------------------------------------------------------------ outils de page
DESKTOP_INIT = "window.__novaDesktop = { version: 'test', platform: 'windows', ui: 'test', bridges: { asio: 8766, vst: 8765 } };"
WORKER_STUB = "onmessage = () => {};"


SUPA_URL = "https://mxdrxpzxbgybchzzvpkf.supabase.co"


def fake_login(page, uid="33333333-3333-4333-8333-333333333333", email="studio@test.local"):
    """Compte Make Music simulé : l'appli Windows exige d'être connecté pour démarrer
    (porte d'entrée components/DesktopAccessGate). Aucun appel réel à Supabase."""
    import base64
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")  # noqa
    tok = f"{enc({'alg': 'HS256', 'typ': 'JWT'})}.{enc({'sub': uid, 'email': email, 'role': 'authenticated', 'aud': 'authenticated', 'exp': int(time.time()) + 86400 * 30})}.sig"
    user = {"id": uid, "email": email, "aud": "authenticated", "role": "authenticated", "app_metadata": {}, "user_metadata": {}, "created_at": "2026-01-01T00:00:00Z"}
    sess = {"access_token": tok, "token_type": "bearer", "expires_in": 86400 * 30, "expires_at": int(time.time()) + 86400 * 30, "refresh_token": "qa-refresh", "user": user}
    page.add_init_script(f"try {{ localStorage.setItem('sb-mxdrxpzxbgybchzzvpkf-auth-token', {json.dumps(json.dumps(sess))}); }} catch (e) {{}}")
    page.route(f"{SUPA_URL}/auth/v1/user*", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(user)))
    page.route(f"{SUPA_URL}/auth/v1/token*", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(sess)))


def prepare(page, bridge=None, desktop=False, login=True):
    """Pont simulé (ou absent), worker audio du pont neutralisé, facturation simulée (admin).
    Appli Windows simulée : compte connecté simulé (sinon la porte d'entrée bloque) ;
    login=False quand le scénario connecte lui-même un compte (vrai ou simulé)."""
    if desktop:
        page.add_init_script(DESKTOP_INIT)
        if login:
            fake_login(page)
    if bridge is not None:
        page.route_web_socket(re.compile(r"^ws://(127\.0\.0\.1|localhost):8765"), bridge.handler)
    else:
        page.route_web_socket(re.compile(r"^ws://(127\.0\.0\.1|localhost):8765"), lambda ws: ws.close())
    page.route_web_socket(re.compile(r"^ws://(127\.0\.0\.1|localhost):8766"), lambda ws: ws.close())
    page.route("**/worklets/vst-bridge-worker-v4.js", lambda r: r.fulfill(status=200, content_type="text/javascript", body=WORKER_STUB))
    page.route("**/functions/v1/nova-billing", lambda r: r.fulfill(status=200, content_type="application/json",
               body=json.dumps({"plans": [], "admin": True, "unlocked": True, "free_exports_left": 10})))


def open_project_file(page, f, res, label):
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=25000)
    page.get_by_text("Charger Projet").first.click(); page.wait_for_timeout(700)
    with page.expect_file_chooser(timeout=8000) as fc:
        page.get_by_text("Charger depuis l'ordinateur").first.click()
    fc.value.set_files(str(f))
    page.wait_for_timeout(6000)
    for name in ("C'est parti", "Plus tard"):
        b = page.get_by_role("button", name=name, exact=True).locator("visible=true").first
        try:
            if b.is_visible(): b.click(); page.wait_for_timeout(300)
        except Exception:
            pass
    shot(page, f"{label}")


def save_zip(page, dest: Path):
    page.keyboard.press("Control+s"); page.wait_for_timeout(900)
    loc = page.get_by_role("button", name=re.compile("(Export local|cet appareil)", re.I)).first
    with page.expect_download(timeout=90000) as dl:
        loc.click()
    dl.value.save_as(str(dest))
    page.wait_for_timeout(800)
    with zipfile.ZipFile(dest) as z:
        return json.loads(z.read("project.json")), sorted(z.namelist())


def export_wav(page, dest: Path, label):
    """Export du morceau complet (WAV). La fenêtre d'export a changé : on choisit
    « Mon morceau complet » (le téléchargement part tout de suite), au lieu de
    l'ancien bouton « WAV » puis « EXPORTER »."""
    page.keyboard.press("Escape")
    b = page.get_by_role("button", name=re.compile(r"^\W*Exporter( le mix)?\s*$")).locator("visible=true").first
    if not b.is_visible():
        page.get_by_role("button", name=re.compile("Ouvrir le menu")).first.click(); page.wait_for_timeout(500)
        b = page.get_by_role("button", name=re.compile(r"^\W*Exporter( le mix)?\s*$")).locator("visible=true").first
    b.click(); page.wait_for_timeout(1200)
    shot(page, f"{label}_export_fenetre")
    try:
        with page.expect_download(timeout=240000) as dl:
            page.get_by_text("Mon morceau complet", exact=True).first.click()
        dl.value.save_as(str(dest))
    finally:
        page.wait_for_timeout(800)
        for _ in range(3):
            close = page.get_by_role("button", name=re.compile("^(Fermer|Close)$")).locator("visible=true")
            try:
                if close.count() and page.get_by_text("Exporter ton morceau", exact=False).count(): close.last.click(); page.wait_for_timeout(300)
            except Exception:
                break
        page.keyboard.press("Escape")
    return dest


def duration_s(f: Path):
    r = subprocess.run([FFMPEG, "-hide_banner", "-i", str(f)], capture_output=True, text=True, encoding="utf-8", errors="replace")
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", r.stderr)
    return round(int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)), 2) if m else None


def rms_db(f: Path, t0, t1):
    """RMS (dBFS) d'une fenêtre, mesuré par ffmpeg (astats)."""
    r = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-i", str(f), "-af", f"atrim=start={t0}:end={t1},astats=measure_perchannel=none:measure_overall=RMS_level", "-f", "null", "-"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    m = re.findall(r"RMS level dB:\s*(-?[\d.]+|-inf)", r.stderr)
    if not m:
        return None
    v = m[-1]
    return -200.0 if v == "-inf" else float(v)


# ------------------------------------------------------------ scénario
def run():
    res = {"name": "gel_pre_effet", "ok": True, "steps": [], "mesures": {}}
    src = OUT / "00_projet_studio.novaproj.zip"
    make_project(src)

    def step_ok(label, fn):
        t = time.time()
        try:
            out = fn()
            res["steps"].append({"step": label, "ok": True, "s": round(time.time() - t, 1)})
            return out
        except Exception as e:  # noqa
            res["ok"] = False
            res["steps"].append({"step": label, "ok": False, "err": f"{type(e).__name__}: {str(e)[:400]}"})
            return None

    with sync_playwright() as p:
        b = launch(p)

        # --- A. PC de l'ingé : pont VST, plugins, gel automatique à la sauvegarde / fermeture
        logA = Log("A_pc_studio")
        ctx, page = new_page(b, "pc", logA)
        brA = FakeBridge()
        prepare(page, brA, desktop=True)

        def a_open():
            open_project_file(page, src, res, "A1_pc_session_ouverte")
            t0 = time.time()
            while time.time() - t0 < 20 and not page.evaluate("() => !!(window.__novaBridge && window.__novaBridge.isConnected())"):
                page.wait_for_timeout(500)
            assert page.evaluate("() => window.__novaBridge.isConnected()"), "pont simulé non connecté"
        step_ok("A. PC : session ouverte, pont VST connecté", a_open)

        def a_export_ref():
            export_wav(page, OUT / "A_export_studio_avant.wav", "A2")
        step_ok("A. PC : export de référence (avant les éditions)", a_export_ref)

        def a_close():
            t = time.time()
            page.evaluate("() => window.__novaBeforeClose()")
            res["mesures"]["gel_fermeture_s"] = round(time.time() - t, 1)
            js, files = save_zip(page, OUT / "A_session_gelee_par_le_pc.novaproj.zip")
            voix = next(t for t in js["tracks"] if t["id"] == "voix")
            verb = next(t for t in js["tracks"] if t["id"] == "verb-vst")
            res["A_sauvegarde"] = {
                "schemaVersion": js.get("schemaVersion"), "fichiers": files,
                "voix": {k: voix.get(k) for k in ("isFrozen", "frozenAuto", "frozenUpToPluginIndex")},
                "voix_photo_clips": [c["id"] for c in (voix.get("freezeBase") or {}).get("clips", [])],
                "voix_rendus_envoi": [s["clip"]["audioRef"] for s in voix.get("sendFreezes", [])],
                "reverb": {k: verb.get(k) for k in ("isFrozen", "frozenAuto", "frozenUpToPluginIndex")},
                "plugins_voix_gardes": [pl["params"].get("localPath") for pl in voix["plugins"]],
                "rendus_pont": brA.renders,
            }
            assert voix.get("isFrozen") and voix.get("frozenAuto"), "voix pas gelée automatiquement"
            assert verb.get("isFrozen") and verb.get("frozenAuto"), "reverb VST pas gelée"
            assert voix.get("sendFreezes"), "pas de rendu d'envoi vers la reverb"
            assert any(f.startswith("audio/frozen-voix") for f in files) and "audio/send-voix-verb-vst.wav" in files
        step_ok("A. PC : fermeture → gel auto (voix + reverb en envoi) + sauvegarde", a_close)
        shot(page, "A3_pc_apres_gel")
        res["A_erreurs"] = [e["text"][:200] for e in logA.errors()][:10]
        save_log(logA); ctx.close()

        # --- B. Tablette (téléphone 432x768 tactile), sans pont ni plugins : éditions
        logB = Log("B_tablette")
        ctx, page = new_page(b, "tel", logB)
        prepare(page, None, desktop=False)

        def b_open():
            open_project_file(page, OUT / "A_session_gelee_par_le_pc.novaproj.zip", res, "B1_tablette_ouverte")
            page.get_by_test_id("frozen-notice").wait_for(timeout=15000)
            res["B_bandeau"] = page.get_by_test_id("frozen-notice").inner_text()
        step_ok("B. Tablette : session gelée ouverte, bandeau visible", b_open)

        def tap_clip(name):
            el = page.get_by_text(name, exact=True).locator("visible=true").first
            el.scroll_into_view_if_needed()
            box = el.bounding_box()
            page.touchscreen.tap(box["x"] + box["width"] / 2, box["y"] + box["height"] + 12)
            page.wait_for_timeout(500)

        def b_edits():
            nav = page.locator("[role=navigation], div.fixed.bottom-0").filter(has_text="Morceau").last
            try: nav.get_by_text("Morceau", exact=True).click(); page.wait_for_timeout(800)
            except Exception: pass
            shot(page, "B2_tablette_morceau")
            # 1) Supprimer la phrase 3 (gomme)
            page.get_by_role("button", name="Gomme").locator("visible=true").first.click(); page.wait_for_timeout(300)
            tap_clip("Phrase 3")
            page.get_by_role("button", name="Sélection").locator("visible=true").first.click(); page.wait_for_timeout(300)
            # 2) Phrase 2 : fondu de sortie 1 s + gain -0,3
            tap_clip("Phrase 2")
            for _ in range(10):
                page.get_by_role("button", name="Allonger le fondu de sortie").locator("visible=true").first.click(); page.wait_for_timeout(60)
            for _ in range(3):
                page.get_by_role("button", name="Baisser le gain du clip").locator("visible=true").first.click(); page.wait_for_timeout(60)
            page.wait_for_timeout(600)
            shot(page, "B3_tablette_editions")
            res["B_bandeau_apres"] = page.get_by_test_id("frozen-notice").inner_text()
        step_ok("B. Tablette : supprimer phrase 3, fondu + gain sur phrase 2", b_edits)

        def b_save():
            js, files = save_zip(page, OUT / "B_session_editee_tablette.novaproj.zip")
            voix = next(t for t in js["tracks"] if t["id"] == "voix")
            res["B_sauvegarde"] = {
                "clips": [{k: c.get(k) for k in ("id", "start", "offset", "duration", "gain", "fadeOut")} for c in voix["clips"]],
                "journal": (voix.get("preFxJournal") or {}).get("ops"),
                "photo_son_phrase3": [c.get("audioRef") for c in voix["freezeBase"]["clips"] if c["id"] == "p3"],
            }
            assert not any(c["id"] == "p3" for c in voix["clips"]), "phrase 3 toujours là"
            assert voix.get("preFxJournal"), "pas de journal des éditions"
        step_ok("B. Tablette : sauvegarde (journal des éditions)", b_save)
        res["B_erreurs"] = [e["text"][:200] for e in logB.errors()][:10]
        save_log(logB); ctx.close()

        # --- C. Retour au PC de l'ingé : dégel auto, résumé, export
        logC = Log("C_pc_retour")
        ctx, page = new_page(b, "pc", logC)
        brC = FakeBridge()
        prepare(page, brC, desktop=True)

        def c_open():
            open_project_file(page, OUT / "B_session_editee_tablette.novaproj.zip", res, "C1_pc_retour_ouverte")
            page.get_by_test_id("prefx-panel").wait_for(timeout=30000)
            page.wait_for_timeout(500)
            shot(page, "C2_pc_resume_editions")
            res["C_resume"] = page.get_by_test_id("prefx-summary").inner_text()
            res["C_panneau"] = page.get_by_test_id("prefx-panel").inner_text()[:1200]
            assert "réappliquée" in res["C_resume"]
            page.get_by_role("button", name="C'est noté").click(); page.wait_for_timeout(800)
            for name in ("Plus tard", "C'est parti"):  # fenêtre d'accueil (projet sans beat) restée derrière
                bb = page.get_by_role("button", name=name, exact=True).locator("visible=true").first
                try:
                    if bb.is_visible(): bb.click(); page.wait_for_timeout(400)
                except Exception:
                    pass
            shot(page, "C2b_pc_apres_resume")
        step_ok("C. PC : dégel automatique + résumé des éditions", c_open)

        def c_export():
            export_wav(page, OUT / "C_export_pc_apres_editions.wav", "C3")
            res["C_rendus_pont"] = brC.renders
        step_ok("C. PC : export (éditions rejouées avant les effets)", c_export)
        res["C_erreurs"] = [e["text"][:200] for e in logC.errors()][:10]
        save_log(logC); ctx.close()

        # --- B'. Tablette 1024x768 tactile : même bandeau, mise en page « bureau »
        logT = Log("B2_tablette_1024")
        ctx, page = new_page(b, "tab", logT)
        prepare(page, None, desktop=False)

        def t_open():
            open_project_file(page, OUT / "B_session_editee_tablette.novaproj.zip", res, "BT1_tablette_1024_ouverte")
            page.get_by_test_id("frozen-notice").wait_for(timeout=15000)
            res["BT_bandeau"] = page.get_by_test_id("frozen-notice").inner_text()
            assert "3 éditions" in res["BT_bandeau"], res["BT_bandeau"]
        step_ok("B'. Tablette 1024 : bandeau avec les éditions gardées", t_open)

        def t_export():
            export_wav(page, OUT / "BT_export_tablette_apercu.wav", "BT2")
        step_ok("B'. Tablette 1024 : export (aperçu sans les plugins : rendus gelés)", t_export)
        save_log(logT); ctx.close()

        # --- E. PC : « Revenir à ma version » (tout est annulable) puis export
        logE = Log("E_pc_revenir")
        ctx, page = new_page(b, "pc", logE)
        prepare(page, FakeBridge(), desktop=True)

        def e_revert():
            open_project_file(page, OUT / "B_session_editee_tablette.novaproj.zip", res, "E1_pc_ouverte")
            page.get_by_test_id("prefx-panel").wait_for(timeout=30000)
            page.get_by_role("button", name="Revenir à ma version (avant ces éditions)").click(); page.wait_for_timeout(600)
            shot(page, "E2_pc_revenu_a_sa_version")
            assert page.get_by_role("button", name="Rétablir ses éditions").is_visible()
            page.get_by_role("button", name="C'est noté").click(); page.wait_for_timeout(800)
            for name in ("Plus tard", "C'est parti"):
                bb = page.get_by_role("button", name=name, exact=True).locator("visible=true").first
                try:
                    if bb.is_visible(): bb.click(); page.wait_for_timeout(400)
                except Exception:
                    pass
            export_wav(page, OUT / "E_export_pc_version_ingé.wav", "E3")
        step_ok("E. PC : revenir à la version de l'ingé (annulable) + export", e_revert)
        save_log(logE); ctx.close()

        # --- F. « Volume avant effets » dessiné sur la tablette (automation preVolume) :
        # fondu de la phrase 1 (1 → 2,5 s jusqu'à -20 dB), retour à 0 dB juste après la phrase.
        def make_prevol_zip():
            srcz = OUT / "B_session_editee_tablette.novaproj.zip"
            dst = OUT / "F_session_tablette_volume_avant_effets.novaproj.zip"
            with zipfile.ZipFile(srcz) as zi, zipfile.ZipFile(dst, "w") as zo:
                for n in zi.namelist():
                    data = zi.read(n)
                    if n == "project.json":
                        js = json.loads(data)
                        v = next(t for t in js["tracks"] if t["id"] == "voix")
                        v["automationLanes"] = [l for l in v.get("automationLanes", []) if l.get("parameterName") != "preVolume"] + [{
                            "id": "auto-prevol", "parameterName": "preVolume", "color": "#22d3ee", "isExpanded": True, "min": 0, "max": 1.5,
                            "points": [{"id": "a", "time": 0, "value": 1}, {"id": "b", "time": 1.0, "value": 1}, {"id": "c", "time": 2.5, "value": 0.1},
                                       {"id": "d", "time": 3.0, "value": 0.1}, {"id": "e", "time": 3.05, "value": 1}]}]
                        data = json.dumps(js).encode()
                    zo.writestr(n, data)
            return dst
        fzip = step_ok("F. préparation : volume avant effets dessiné sur la tablette", make_prevol_zip)

        logF = Log("F_pc_volume_avant_effets")
        ctx, page = new_page(b, "pc", logF)
        prepare(page, FakeBridge(), desktop=True)

        def f_pc():
            open_project_file(page, fzip, res, "F1_pc_volume_avant_effets")
            page.get_by_test_id("prefx-panel").wait_for(timeout=30000)
            shot(page, "F2_pc_resume_avec_volume")
            res["F_resume"] = page.get_by_test_id("prefx-summary").inner_text()
            assert "4 éditions" in res["F_resume"], res["F_resume"]
            page.get_by_role("button", name="C'est noté").click(); page.wait_for_timeout(800)
            for name in ("Plus tard", "C'est parti"):
                bb = page.get_by_role("button", name=name, exact=True).locator("visible=true").first
                try:
                    if bb.is_visible(): bb.click(); page.wait_for_timeout(400)
                except Exception:
                    pass
            export_wav(page, OUT / "F_export_pc_volume_avant_effets.wav", "F3")
        step_ok("F. PC : volume avant effets rejoué avant compresseur et reverb + export", f_pc)
        save_log(logF); ctx.close()

        logF2 = Log("F2_tablette_apercu_volume")
        ctx, page = new_page(b, "tab", logF2)
        prepare(page, None, desktop=False)

        def f_tab():
            open_project_file(page, fzip, res, "F4_tablette_volume_avant_effets")
            export_wav(page, OUT / "F_export_tablette_apercu_volume.wav", "F5")
        step_ok("F. Tablette : aperçu du volume (après le rendu gelé) + export", f_tab)
        save_log(logF2); ctx.close()

        # --- D. PC sans la reverb installée : la piste reste gelée, on prévient
        logD = Log("D_pc_plugin_manquant")
        ctx, page = new_page(b, "pc", logD)
        brD = FakeBridge(installed=[COMP_PATH])
        prepare(page, brD, desktop=True)

        def d_open():
            open_project_file(page, OUT / "B_session_editee_tablette.novaproj.zip", res, "D1_pc_sans_reverb")
            page.get_by_test_id("prefx-missing").wait_for(timeout=30000)
            page.wait_for_timeout(1500)  # le résumé ne doit pas être écrasé ensuite
            shot(page, "D2_pc_plugin_manquant")
            res["D_manquant"] = page.get_by_test_id("prefx-missing").inner_text()
            res["D_resume"] = page.get_by_test_id("prefx-summary").inner_text()
            assert "3 éditions" in res["D_resume"], res["D_resume"]
        step_ok("D. PC sans le plugin : voix dégelée (éditions rejouées), reverb gardée gelée + message", d_open)

        def d_retry():
            brD.installed.append(VERB_PATH)  # l'ingé installe la reverb
            page.get_by_role("button", name="Réessayer").click()
            page.wait_for_timeout(4000)
            shot(page, "D3_pc_reessayer_apres_installation")
            missing_left = page.get_by_test_id("prefx-missing").count()
            res["D_apres_reessayer"] = page.get_by_test_id("prefx-panel").inner_text()[:300] if page.get_by_test_id("prefx-panel").count() else "(panneau fermé)"
            assert missing_left == 0, "plugin toujours signalé manquant"
        step_ok("D. PC : « Réessayer » après installation du plugin → dégel", d_retry)
        save_log(logD); ctx.close()
        b.close()

    # --- Mesures (ffmpeg)
    A = OUT / "A_export_studio_avant.wav"; C = OUT / "C_export_pc_apres_editions.wav"
    if A.exists() and C.exists():
        m = res["mesures"]
        m["phrase1_avant_dB"] = rms_db(A, 1.2, 2.8); m["phrase1_apres_dB"] = rms_db(C, 1.2, 2.8)
        m["duree_export_avant_s"] = duration_s(A); m["duree_export_apres_s"] = duration_s(C)
        m["zone_phrase3_avant_dB (7,5-9 s)"] = rms_db(A, 7.5, 9.0)
        m["zone_phrase3_apres_dB (7,5-9 s)"] = rms_db(C, 7.5, 9.0)
        m["queue_phrase3_avant_dB (9,2-10,5 s)"] = rms_db(A, 9.2, 10.5)
        m["queue_phrase3_apres_dB (9,2-10,5 s)"] = rms_db(C, 9.2, 10.5) if (m["duree_export_apres_s"] or 0) > 9.3 else "fichier terminé avant (aucune queue)"
        m["queue_phrase2_avant_dB (6,05-7 s)"] = rms_db(A, 6.05, 7.0)
        m["queue_phrase2_pre_effet_dB (6,05-7 s)"] = rms_db(C, 6.05, 7.0)
        q3 = m["queue_phrase3_apres_dB (9,2-10,5 s)"]
        checks = {
            "phrase 1 intacte (±0,5 dB)": abs((m["phrase1_avant_dB"] or 0) - (m["phrase1_apres_dB"] or 99)) <= 0.5,
            "reverb VST présente au départ (queue phrase 3 > -60 dB)": (m["queue_phrase3_avant_dB (9,2-10,5 s)"] or -200) > -60,
            "voix supprimée : ni voix ni reverb à sa place (< -80 dB)": (m["zone_phrase3_apres_dB (7,5-9 s)"] or 0) < -80,
            "voix supprimée : pas de queue de reverb orpheline après": isinstance(q3, str) or q3 < -80,
            "fondu AVANT la reverb : queue phrase 2 plus basse de 6 dB+": (m["queue_phrase2_avant_dB (6,05-7 s)"] or 0) - (m["queue_phrase2_pre_effet_dB (6,05-7 s)"] or 0) >= 6,
        }
        T = OUT / "BT_export_tablette_apercu.wav"
        if T.exists():
            m["tablette_phrase1_dB (sans plugins, rendus gelés)"] = rms_db(T, 1.2, 2.8)
            m["tablette_zone_phrase3_dB (7,5-9 s)"] = rms_db(T, 7.5, 9.0)
            m["tablette_reverb_apres_phrase1_dB (3,05-3,9 s)"] = rms_db(T, 3.05, 3.9)
            m["pc_reverb_apres_phrase1_dB (3,05-3,9 s)"] = rms_db(A, 3.05, 3.9)
            checks["tablette : la voix sonne avec les effets VST gelés (phrase 1 ±0,5 dB du PC)"] = abs((m["tablette_phrase1_dB (sans plugins, rendus gelés)"] or 0) - (m["phrase1_avant_dB"] or 99)) <= 0.5
            checks["tablette : la reverb VST gelée suit la voix (queue phrase 1 ±1 dB du PC)"] = abs((m["tablette_reverb_apres_phrase1_dB (3,05-3,9 s)"] or 0) - (m["pc_reverb_apres_phrase1_dB (3,05-3,9 s)"] or 99)) <= 1
            checks["tablette : phrase 3 supprimée, sa reverb aussi (< -80 dB)"] = (m["tablette_zone_phrase3_dB (7,5-9 s)"] or 0) < -80
        FP = OUT / "F_export_pc_volume_avant_effets.wav"; FT = OUT / "F_export_tablette_apercu_volume.wav"
        if FP.exists() and FT.exists():
            m["F_fin_phrase1_dB (2,6-3 s) PC avant / volume avant effets"] = [rms_db(A, 2.6, 3.0), rms_db(FP, 2.6, 3.0)]
            m["F_queue_reverb_phrase1_dB (3,1-3,9 s) PC avant / PC volume avant effets / tablette aperçu"] = [rms_db(A, 3.1, 3.9), rms_db(FP, 3.1, 3.9), rms_db(FT, 3.1, 3.9)]
            qa_, qf, qt = m["F_queue_reverb_phrase1_dB (3,1-3,9 s) PC avant / PC volume avant effets / tablette aperçu"]
            checks["volume avant effets (PC) : la reverb suit le fondu (queue -10 dB+)"] = (qa_ or 0) - (qf or 0) >= 10
            res["F_note"] = ("Sur la tablette (sans plugins), le volume avant effets s'applique après le rendu gelé : la queue de reverb "
                             "revient quand le volume remonte (aperçu). Au PC, il est rejoué AVANT le compresseur et la reverb.")
        E = OUT / "E_export_pc_version_ingé.wav"
        if E.exists():
            m["retour_version_ingé_zone_phrase3_dB (7,5-9 s)"] = rms_db(E, 7.5, 9.0)
            m["retour_version_ingé_queue_phrase3_dB (9,2-10,5 s)"] = rms_db(E, 9.2, 10.5)
            checks["« Revenir à ma version » : phrase 3 et sa reverb reviennent (±0,5 dB)"] = (
                abs((m["retour_version_ingé_zone_phrase3_dB (7,5-9 s)"] or 0) - (m["zone_phrase3_avant_dB (7,5-9 s)"] or 99)) <= 0.5
                and abs((m["retour_version_ingé_queue_phrase3_dB (9,2-10,5 s)"] or 0) - (m["queue_phrase3_avant_dB (9,2-10,5 s)"] or 99)) <= 0.5)
        res["verifications_audio"] = checks
        if not all(checks.values()):
            res["ok"] = False
    else:
        res["ok"] = False
        res["verifications_audio"] = "exports manquants"

    (OUT / "resultat_gel_pre_effet.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(res, ensure_ascii=True, indent=1)[:6000])
    return res


if __name__ == "__main__":
    r = run()
    sys.exit(0 if r["ok"] else 1)
