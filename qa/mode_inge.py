"""Scénario de bout en bout : mode « Ingé à distance (ses propres VST) ».

Deux navigateurs headless (aucune fenêtre) : l'ARTISTE (navigateur, sans pont
VST) et l'INGÉ (appli Windows simulée, pont VST simulé avec un compresseur et
une reverb « VST3 » de test rendus en Python). Chacun ouvre SA session.

Le serveur de NOVA (fonction daw-session : lien, journal d'opérations, audio
en morceaux SHA-1) est SIMULÉ en Python et partagé par les deux navigateurs ;
le direct Supabase Realtime est coupé (les opérations arrivent par le
rattrapage toutes les 10 s, comme après une coupure). Les écritures vers
Supabase restent bloquées (qalib). Compte et abonnement : simulés.

Usage :
  NOVA_URL=http://127.0.0.1:4010/ python qa/mode_inge.py
"""
import base64, io, json, os, random, re, string, sys, time, wave, zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-mode-inge")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:4010/")
from qalib import *  # noqa
from gel_pre_effet import FakeBridge, prepare, open_project_file, rms_db, duration_s, voice_wav, export_wav, PHRASES, SR  # noqa

SUPA = "https://mxdrxpzxbgybchzzvpkf.supabase.co"
STORE = "https://fake-storage.test"


# ------------------------------------------------------------ serveur NOVA simulé (daw-session)
class FakeNovaServer:
    def __init__(self):
        self.sessions = {}
        self.members = {}
        self.ops = []
        self.seq = 5000
        self.parts = {}
        self.log = []

    def _id(self, n, alphabet=string.ascii_lowercase + string.digits):
        return "".join(random.choice(alphabet) for _ in range(n))

    def handle(self, route, request):
        if request.method == "OPTIONS":
            return route.fulfill(status=204, headers=self.cors())
        try:
            body = json.loads(request.post_data or "{}")
        except Exception:
            body = {}
        a = body.get("action")
        self.log.append(a)
        try:
            out = self.act(a, body)
            route.fulfill(status=200, content_type="application/json", headers=self.cors(), body=json.dumps(out))
        except Exception as e:  # noqa
            route.fulfill(status=400, content_type="application/json", headers=self.cors(), body=json.dumps({"error": str(e)}))

    @staticmethod
    def cors():
        return {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*"}

    def act(self, a, b):
        if a == "create":
            sid = self._id(12)
            self.sessions[sid] = {"secret": self._id(32, string.ascii_letters + "23456789"), "name": b.get("name")}
            return {"id": sid, "secret": self.sessions[sid]["secret"], "version": 0, "owned": True}
        sid = b.get("id")
        s = self.sessions.get(sid)
        if not s or s["secret"] != b.get("secret"):
            raise RuntimeError("Session introuvable")
        key = "d:" + str(b.get("device_id") or "")
        if a == "join":
            self.members[(sid, key)] = {"role": b.get("role"), "name": b.get("name")}
            mem = [{"member_key": k[1], "role": v["role"], "display_name": v["name"]} for k, v in self.members.items() if k[0] == sid]
            return {"member_key": key, "last_seq": self.seq, "members": mem, "channel": f"nova-collab-{sid}"}
        if a == "op":
            m = self.members.get((sid, key))
            if not m:
                raise RuntimeError("Rejoins d'abord la session")
            self.seq += 1
            o = {"seq": self.seq, "sid": sid, "member_key": key, "role": m["role"], "author_name": m["name"], "kind": b.get("kind"), "op": b.get("op"), "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ")}
            self.ops.append(o)
            return {"seq": o["seq"], "created_at": o["created_at"], "role": m["role"], "author_name": m["name"], "member_key": key}
        if a == "ops_since":
            after = int(b.get("after") or 0)
            ops = [{k: v for k, v in o.items() if k != "sid"} for o in self.ops if o["sid"] == sid and o["seq"] > after][:500]
            return {"ops": ops}
        if a == "sign_upload":
            ups = {p: {"path": f"daw-sessions/{sid}/{p}", "token": "tok"} for p in b.get("parts", []) if p not in self.parts}
            return {"uploads": ups}
        if a == "urls":
            return {"urls": {p: f"{STORE}/{p}" for p in b.get("parts", []) if p in self.parts}}
        if a == "members":
            return {"members": []}
        if a == "info":
            return {"id": sid, "name": s["name"], "version": 0}
        raise RuntimeError(f"Action inconnue {a}")

    def upload(self, route, request):
        if request.method == "OPTIONS":
            return route.fulfill(status=204, headers=self.cors())
        name = request.url.split("?")[0].rstrip("/").split("/")[-1]
        data = request.post_data_buffer or b""
        ctype = request.headers.get("content-type", "")
        if ctype.startswith("multipart/form-data"):
            boundary = ctype.split("boundary=")[-1].encode()
            for part in data.split(b"--" + boundary):
                if b"\r\n\r\n" not in part:
                    continue
                head, payload = part.split(b"\r\n\r\n", 1)
                if b"filename" in head or b"octet-stream" in head:
                    data = payload[:-2] if payload.endswith(b"\r\n") else payload
                    break
        self.parts[name] = data
        route.fulfill(status=200, content_type="application/json", headers=self.cors(), body=json.dumps({"Key": f"daw-sessions/{name}"}))

    def download(self, route, request):
        name = request.url.split("?")[0].rstrip("/").split("/")[-1]
        data = self.parts.get(name)
        if data is None:
            return route.fulfill(status=404, body="absent")
        route.fulfill(status=200, headers={"content-type": "application/octet-stream", "access-control-allow-origin": "*"}, body=data)


def jwt(sub, email):
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")  # noqa
    return f"{enc({'alg': 'HS256', 'typ': 'JWT'})}.{enc({'sub': sub, 'email': email, 'role': 'authenticated', 'aud': 'authenticated', 'exp': int(time.time()) + 86400 * 30})}.sig"


def connect(page, server, uid, email):
    """Compte Make Music et abonnement simulés, serveur NOVA simulé, direct Realtime coupé."""
    user = {"id": uid, "email": email, "aud": "authenticated", "role": "authenticated", "app_metadata": {}, "user_metadata": {}, "created_at": "2026-01-01T00:00:00Z"}
    tok = jwt(uid, email)
    sess = {"access_token": tok, "token_type": "bearer", "expires_in": 86400 * 30, "expires_at": int(time.time()) + 86400 * 30, "refresh_token": "qa-refresh", "user": user}
    page.add_init_script(f"try {{ localStorage.setItem('sb-mxdrxpzxbgybchzzvpkf-auth-token', {json.dumps(json.dumps(sess))}); localStorage.setItem('nova_simple_mode', '0'); }} catch (e) {{}}")
    page.route(f"{SUPA}/auth/v1/user*", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(user)))
    page.route(f"{SUPA}/auth/v1/token*", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(sess)))
    page.route(f"{SUPA}/functions/v1/daw-session", server.handle)
    page.route(f"{SUPA}/storage/v1/object/upload/sign/**", server.upload)
    page.route(f"{STORE}/**", server.download)
    page.route(f"{SUPA}/rest/v1/instrumentals*", lambda r: r.fulfill(status=200, content_type="application/json", body="[]"))
    page.route_web_socket(re.compile(r"realtime/v1/websocket"), lambda ws: None)  # ouvert mais muet : pas de tempête de reconnexions


# ------------------------------------------------------------ projets de départ
def base_state(pid, name, tracks):
    return {
        "id": pid, "name": name, "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": None, "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }


BASE_T = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0}


def artist_project(path: Path):
    clips = [{"id": f"p{i+1}", "name": f"Phrase {i+1}", "start": a, "duration": b - a, "offset": a, "fadeIn": 0, "fadeOut": 0,
              "color": "#22d3ee", "type": "AUDIO", "audioRef": "audio/voix.wav", "gain": 1, "takeNumber": 1} for i, (a, b) in enumerate(PHRASES)]
    tracks = [{**BASE_T, "id": "voix", "name": "Voix lead", "type": "AUDIO", "color": "#22d3ee", "volume": 1.0, "outputTrackId": "master",
               "sends": [], "clips": clips, "plugins": []}]
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(base_state("proj-artiste", "Session artiste", tracks)))
        z.writestr("audio/voix.wav", voice_wav())


def engineer_project(path: Path):
    tracks = [{**BASE_T, "id": "notes-inge", "name": "Piste 1", "type": "AUDIO", "color": "#94a3b8", "volume": 1.0, "outputTrackId": "master",
               "sends": [], "clips": [], "plugins": []}]
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(base_state("proj-inge", "Session de l'ingé", tracks)))


# ------------------------------------------------------------ outils
def dismiss(page):
    for name in ("C'est parti", "Plus tard", "C'est noté"):
        b = page.get_by_role("button", name=name, exact=True).locator("visible=true").first
        try:
            if b.is_visible(): b.click(); page.wait_for_timeout(300)
        except Exception:
            pass


def open_collab(page):
    b = page.get_by_role("button", name=re.compile(r"(Collaborer|Ingé à distance|en ligne · Chat)$")).locator("visible=true").first
    b.click(); page.wait_for_timeout(600)


def panel(page):
    """Panneau « Ingé à distance » ouvert (il se ferme quand on travaille ailleurs)."""
    if not page.get_by_test_id("remote-panel").count():
        open_collab(page)
        page.get_by_test_id("remote-panel").wait_for(timeout=8000)


def wait_for(page, fn, timeout=40, step=500, what="condition"):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if fn():
                return round(time.time() - t0, 1)
        except Exception:
            pass
        page.wait_for_timeout(step)
    raise AssertionError(f"délai dépassé : {what}")


def text_of(page, testid):
    loc = page.get_by_test_id(testid)
    return loc.first.inner_text() if loc.count() else ""


def click_track(page, name):
    page.locator(f"span[title='{name}']").first.click(); page.wait_for_timeout(300)


def side_tab(page, label):
    page.locator("aside button").filter(has_text=re.compile(rf"^\s*{label}\s*$")).first.click(); page.wait_for_timeout(700)


def close_plugin_window(page):
    for _ in range(2):
        b = page.get_by_role("button", name=re.compile(r"^(Fermer|Close)$")).locator("visible=true")
        try:
            if b.count():
                b.last.click(); page.wait_for_timeout(300)
        except Exception:
            pass
    page.keyboard.press("Escape")


# ------------------------------------------------------------ scénario
def run():
    res = {"name": "mode_inge", "ok": True, "steps": [], "mesures": {},
           "note_pont": "Pont VST de l'ingé SIMULÉ (compresseur + reverb de test rendus en Python) ; serveur NOVA simulé ; direct Realtime coupé (rattrapage 10 s)."}
    srv = FakeNovaServer()
    a_src = OUT / "00_session_artiste.novaproj.zip"
    e_src = OUT / "00_session_inge.novaproj.zip"
    artist_project(a_src)
    engineer_project(e_src)

    def step(label, fn):
        t = time.time()
        try:
            out = fn()
            res["steps"].append({"step": label, "ok": True, "s": round(time.time() - t, 1), **({"info": out} if out else {})})
            return out
        except Exception as e:  # noqa
            res["ok"] = False
            res["steps"].append({"step": label, "ok": False, "err": f"{type(e).__name__}: {str(e)[:500]}"})
            return None

    with sync_playwright() as p:
        b = launch(p)
        logA, logE = Log("artiste"), Log("inge")
        ctxA, A = new_page(b, "pc", logA)
        ctxE, E = new_page(b, "pc", logE)
        bridge = FakeBridge()
        prepare(A, None, desktop=False)
        prepare(E, bridge, desktop=True)
        connect(A, srv, "11111111-1111-4111-8111-111111111111", "lina@test.local")
        connect(E, srv, "22222222-2222-4222-8222-222222222222", "max@test.local")
        invite = {}

        def a_open():
            open_project_file(A, a_src, res, "A1_artiste_session_ouverte")
            dismiss(A)
        step("Artiste : sa session ouverte (navigateur, sans pont VST)", a_open)

        def a_export_raw():
            export_wav(A, OUT / "A0_artiste_prise_brute.wav", "A0")
        step("Artiste : export de référence (prise brute)", a_export_raw)

        def a_link():
            open_collab(A)
            shot(A, "A2_choix_du_mode")
            res["A_modes"] = A.locator("fieldset").first.inner_text()
            A.get_by_test_id("collab-mode-remote").click(); A.wait_for_timeout(300)
            shot(A, "A3_mode_inge_a_distance")
            A.get_by_test_id("remote-start").click()
            A.get_by_test_id("remote-invite").wait_for(timeout=20000)
            invite["url"] = A.get_by_test_id("remote-invite").input_value()
            A.wait_for_timeout(500)
            shot(A, "A4_lien_cree")
            assert "?inge=" in invite["url"], invite
            return invite["url"]
        step("Artiste : « Ingé à distance » → lien créé", a_link)

        def e_open():
            open_project_file(E, e_src, res, "E1_inge_session_ouverte")
            dismiss(E)
            wait_for(E, lambda: E.evaluate("() => !!(window.__novaBridge && window.__novaBridge.isConnected())"), 20, what="pont simulé")
        step("Ingé : SA session ouverte (appli Windows, pont VST simulé)", e_open)

        def e_join():
            open_collab(E)
            E.get_by_test_id("collab-mode-remote").click(); E.wait_for_timeout(200)
            E.get_by_test_id("collab-role").select_option("engineer"); E.wait_for_timeout(200)
            E.get_by_test_id("remote-link-input").fill(invite["url"])
            shot(E, "E2_inge_colle_le_lien")
            E.get_by_test_id("remote-start").click()
            E.get_by_test_id("remote-panel").wait_for(timeout=20000)
            wait_for(E, lambda: "Enregistrement" in text_of(E, "remote-phase"), 15, what="panneau ingé")
            E.wait_for_timeout(800)
            shot(E, "E3_inge_relie_vide")
            return text_of(E, "remote-panel")[:400]
        step("Ingé : relié à l'artiste (session à lui, état vide clair)", e_join)

        def a_send():
            grip = A.locator("[data-nova-target='track-voix'] [draggable='true']").first
            try:
                grip.drag_to(A.get_by_test_id("remote-slot-lead"))
                A.wait_for_timeout(800)
            except Exception:
                pass
            A.wait_for_timeout(1500)
            sent = any(o["kind"] == "ri_send" for o in srv.ops)
            how = "glisser sur « Lead »"
            if not sent:
                A.get_by_test_id("remote-send-voix").click()
                how = "bouton « Envoyer à l'ingé » (glisser non transmis par le navigateur de test)"
            wait_for(A, lambda: any(o["kind"] == "ri_send" for o in srv.ops), 20, what="envoi de la piste")
            A.wait_for_timeout(500)
            shot(A, "A5_piste_envoyee")
            return {"comment": how, "etat": text_of(A, "remote-status-voix")}
        step("Artiste : glisse sa piste « Voix lead » sur Lead → envoyée", a_send)

        def e_receive():
            s = wait_for(E, lambda: E.get_by_test_id("remote-row-voix").count() > 0, 30, what="piste reçue chez l'ingé")
            E.wait_for_timeout(600)
            shot(E, "E4_inge_piste_recue")
            return {"recue_en_s": s, "ligne": text_of(E, "remote-row-voix")}
        step("Ingé : la piste arrive dans SA session", e_receive)

        def e_work_recording():
            click_track(E, "Voix lead")
            side_tab(E, "VST")
            E.locator("[data-vst-plugin='NovaTestComp']").first.click(); E.wait_for_timeout(1200)
            close_plugin_window(E)
            # Reverb VST pendant l'enregistrement : refusée, avec l'explication.
            click_track(E, "Voix lead")
            side_tab(E, "VST")
            E.locator("[data-vst-plugin='NovaTestVerb']").first.click(); E.wait_for_timeout(700)
            seen = {}
            def has_lock():
                t = E.locator("body").inner_text()
                if "Pendant l'enregistrement" in t: seen["body"] = t
                return "body" in seen
            wait_for(E, has_lock, 8, step=200, what="message de verrou")
            E.wait_for_timeout(1200)
            shot(E, "E5_inge_reverb_vst_refusee_pendant_enregistrement")
            body = seen["body"]
            # Reverb de NOVA (que l'artiste a aussi) : en envoi, réglages synchronisés.
            click_track(E, "Voix lead")
            side_tab(E, "FX")
            E.get_by_text("Spatial Verb", exact=True).first.click(); E.wait_for_timeout(1200)
            close_plugin_window(E)
            shot(E, "E6_inge_comp_vst_et_reverb_nova")
            return {"message_verrou": re.search(r"Pendant l'enregistrement[^\n]{0,160}", body).group(0)}
        step("Ingé (enregistrement) : compresseur VST en insert, reverb VST refusée, reverb de NOVA en envoi", e_work_recording)

        def e_return_1():
            panel(E)
            E.get_by_test_id("remote-return-voix").click()
            wait_for(E, lambda: "Envoyée à l'artiste" in text_of(E, "remote-status-voix"), 60, what="gel + envoi")
            shot(E, "E7_inge_gele_et_envoye")
            return {"rendus_pont": len(bridge.renders), "etat": text_of(E, "remote-status-voix")}
        step("Ingé : « Geler et envoyer à l'artiste »", e_return_1)

        def a_receive_1():
            panel(A)
            wait_for(A, lambda: A.get_by_test_id("remote-receive-voix").count() > 0, 40, what="réglages prêts chez l'artiste")
            A.wait_for_timeout(500)
            shot(A, "A6_reglages_prets")
            A.get_by_test_id("remote-receive-voix").click()
            wait_for(A, lambda: "Mise à jour reçue" in text_of(A, "remote-status-voix"), 30, what="réglages appliqués")
            A.wait_for_timeout(800)
            shot(A, "A7_reglages_recus")
            return {"etat": text_of(A, "remote-status-voix"), "badge": text_of(A, "remote-badge-voix")}
        step("Artiste : « Recevoir les réglages de l'ingé »", a_receive_1)

        def a_export_rec():
            export_wav(A, OUT / "A1_artiste_reglages_enregistrement.wav", "A8")
        step("Artiste : export avec les réglages reçus (compresseur VST gelé + reverb de NOVA de l'ingé)", a_export_rec)

        def e_mix():
            panel(E)
            E.get_by_test_id("remote-phase-mix").click(); E.wait_for_timeout(600)
            click_track(E, "Voix lead")
            side_tab(E, "VST")
            E.locator("[data-vst-plugin='NovaTestVerb']").first.click(); E.wait_for_timeout(1200)
            close_plugin_window(E)
            shot(E, "E8_inge_mix_reverb_vst_en_envoi")
            panel(E)
            n_ret = sum(1 for o in srv.ops if o["kind"] == "ri_return")
            E.get_by_test_id("remote-return-voix").click()
            wait_for(E, lambda: sum(1 for o in srv.ops if o["kind"] == "ri_return") > n_ret, 60, what="gel + envoi (mix)")
            E.wait_for_timeout(500)
            shot(E, "E9_inge_mix_envoye")
            return {"rendus_pont": [r["plugin"] for r in bridge.renders]}
        step("Ingé : « passer au mix », reverb VST sur un envoi, gel et envoi (session sauvegardée)", e_mix)

        def a_mix_received():
            wait_for(A, lambda: sum(1 for o in srv.ops if o["kind"] == "ri_return") >= 2, 30, what="retour mix envoyé")
            # Mise à jour appliquée toute seule (déjà acceptée une fois) : annonce « Mise à jour reçue de l'ingé ».
            s = wait_for(A, lambda: "Mise à jour reçue de l" in A.locator("body").inner_text(), 40, step=300, what="annonce de mise à jour")
            shot(A, "A9_mix_recu_annonce")
            A.wait_for_timeout(1500)
            export_wav(A, OUT / "A2_artiste_mix_recu.wav", "A10")
            return {"recu_en_s": s}
        step("Artiste : mise à jour du mix reçue toute seule (reverb VST de l'ingé, par source) + export", a_mix_received)

        def a_edit():
            n_send = sum(1 for o in srv.ops if o["kind"] == "ri_send")
            n_ret = sum(1 for o in srv.ops if o["kind"] == "ri_return")
            A.keyboard.press("Escape"); A.wait_for_timeout(500)
            shot(A, "A10b_avant_suppression")
            # Clips dessinés (canvas) : clic au milieu de « Phrase 3 » (7–9 s, 1re piste).
            A.mouse.click(936, 215); A.wait_for_timeout(300)
            A.keyboard.press("Delete"); A.wait_for_timeout(500)
            shot(A, "A11_phrase3_supprimee")
            wait_for(A, lambda: sum(1 for o in srv.ops if o["kind"] == "ri_send") > n_send, 30, what="renvoi automatique")
            panel(A)
            shot(A, "A12_chez_l_inge")
            etat_pendant = text_of(A, "remote-status-voix")
            wait_for(A, lambda: sum(1 for o in srv.ops if o["kind"] == "ri_return") > n_ret, 90, what="retour automatique de l'ingé")
            wait_for(A, lambda: "Mise à jour reçue" in text_of(A, "remote-status-voix"), 40, what="mise à jour reçue")
            A.wait_for_timeout(600)
            shot(A, "A13_mise_a_jour_recue")
            return {"etat_pendant": etat_pendant, "etat_apres": text_of(A, "remote-status-voix")}
        step("Artiste : supprime la phrase 3 → part chez l'ingé, dégel + regel automatiques, revient", a_edit)

        def e_after():
            panel(E)
            shot(E, "E10_inge_apres_aller_retour_auto")
            return {"ligne": text_of(E, "remote-row-voix")}
        step("Ingé : piste retraitée toute seule", e_after)

        def a_export_after():
            export_wav(A, OUT / "A3_artiste_apres_aller_retour.wav", "A14")
        step("Artiste : export après l'aller-retour automatique", a_export_after)

        def e_export():
            export_wav(E, OUT / "E_inge_export_mix.wav", "E11")
        step("Ingé : export de son mix (référence)", e_export)

        def no_loop():
            before = [o["kind"] for o in srv.ops if o["kind"] != "ri_ack"]
            A.wait_for_timeout(25000)
            after = [o["kind"] for o in srv.ops if o["kind"] != "ri_ack"]
            assert len(after) == len(before), f"opérations en plus : {after[len(before):]}"
            return {"operations": {k: before.count(k) for k in sorted(set(before))}}
        step("Pas de boucle : rien ne repart tout seul pendant 25 s", no_loop)

        def a_revert():
            panel(A)
            A.get_by_test_id("remote-revert-voix").click(); A.wait_for_timeout(800)
            shot(A, "A15_prise_brute")
            st = text_of(A, "remote-status-voix")
            A.get_by_test_id("remote-receive-voix").click(); A.wait_for_timeout(1500)
            shot(A, "A16_reglages_reappliques")
            return {"apres_retour": st, "apres_reapplication": text_of(A, "remote-status-voix")}
        step("Artiste : « Revenir à ma prise brute » puis « Réappliquer » (annulable)", a_revert)

        res["A_erreurs"] = [e["text"][:200] for e in logA.errors()][:12]
        res["E_erreurs"] = [e["text"][:200] for e in logE.errors()][:12]
        res["ops"] = [{k: o[k] for k in ("seq", "role", "kind")} for o in srv.ops]
        save_log(logA); save_log(logE)
        ctxA.close(); ctxE.close(); b.close()

    # --- Mesures audio (ffmpeg)
    f = {k: OUT / v for k, v in {"brut": "A0_artiste_prise_brute.wav", "rec": "A1_artiste_reglages_enregistrement.wav",
                                  "mix": "A2_artiste_mix_recu.wav", "apres": "A3_artiste_apres_aller_retour.wav", "inge": "E_inge_export_mix.wav"}.items()}
    m = res["mesures"]
    for k, path in f.items():
        if path.exists():
            m[k] = {"phrase1_dB (1,2-2,8 s)": rms_db(path, 1.2, 2.8), "apres_phrase1_dB (3,1-3,9 s)": rms_db(path, 3.1, 3.9),
                    "zone_phrase3_dB (7,5-9 s)": rms_db(path, 7.5, 9.0), "queue_phrase3_dB (9,2-10,5 s)": rms_db(path, 9.2, 10.5), "duree_s": duration_s(path)}
    checks = {}
    if all(k in m for k in ("brut", "rec", "mix", "apres")):
        checks["réglages reçus : le son change (compresseur VST de l'ingé, ≥ 1 dB sur la phrase 1)"] = abs((m["rec"]["phrase1_dB (1,2-2,8 s)"] or 0) - (m["brut"]["phrase1_dB (1,2-2,8 s)"] or 0)) >= 1
        checks["reverb (NOVA puis VST de l'ingé) entendue chez l'artiste après la phrase 1 (> brut + 10 dB)"] = (m["mix"]["apres_phrase1_dB (3,1-3,9 s)"] or -200) > (m["brut"]["apres_phrase1_dB (3,1-3,9 s)"] or -200) + 10
        checks["phrase 3 supprimée : ni voix ni reverb à sa place (< -80 dB)"] = (m["apres"]["zone_phrase3_dB (7,5-9 s)"] or 0) < -80
        checks["phrase 1 inchangée par l'aller-retour (±0,5 dB)"] = abs((m["apres"]["phrase1_dB (1,2-2,8 s)"] or 0) - (m["mix"]["phrase1_dB (1,2-2,8 s)"] or 99)) <= 0.5
    if "inge" in m and "apres" in m:
        checks["chez l'artiste comme chez l'ingé : phrase 1 (±1 dB)"] = abs((m["apres"]["phrase1_dB (1,2-2,8 s)"] or 0) - (m["inge"]["phrase1_dB (1,2-2,8 s)"] or 99)) <= 1
        checks["chez l'artiste comme chez l'ingé : reverb après la phrase 1 (±1,5 dB)"] = abs((m["apres"]["apres_phrase1_dB (3,1-3,9 s)"] or 0) - (m["inge"]["apres_phrase1_dB (3,1-3,9 s)"] or 99)) <= 1.5
    res["verifications_audio"] = checks
    if not checks or not all(checks.values()):
        res["ok"] = False
    (OUT / "resultat_mode_inge.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: res[k] for k in ("ok", "steps", "verifications_audio")}, ensure_ascii=True, indent=1)[:8000])
    return res


if __name__ == "__main__":
    r = run()
    sys.exit(0 if r["ok"] else 1)
