"""L'ARTISTE invité dans la séance de l'ingé : parcours complet au téléphone, sur tablette et sur PC portable.

Le cas le plus fréquent du studio : un artiste qui n'y connaît rien rejoint, à distance, la séance que
l'ingé (Max) a ouverte sur son PC, pour poser sa voix. On joue l'artiste (Nina), au doigt sur téléphone
(390 × 844) et tablette (1024 × 768), à la souris sur PC portable (1366 × 768), et on déroule :

  1. invitation (lien reçu)                 6. prise demandée (talkback, décompte, paroles)
  2. compte (connexion)                     7. réécouter, recommencer, choisir sa prise
  3. arrivée : où suis-je, qui est là ?     8. parler à l'ingé (écrire, talkback)
  4. casque et micro (SANS casque)          9. coupure réseau puis retour
  5. écouter le mix de l'ingé en direct    10. quitter, revenir plus tard
 11. droits : ce que l'artiste peut casser dans la séance de l'ingé (par l'interface, et par une
     opération forgée injectée dans le journal : la RÉCEPTION chez l'ingé doit la refuser).

Chaque geste est compté (toucher, écrire, faire défiler), chaque attente mesurée ; chaque écran est audité
(jargon visible, cibles trop petites pour le doigt, nombre de commandes, commandes qui modifient la
séance de l'ingé). Les frictions sont relevées automatiquement.

Tout est hors production : serveur NOVA et Supabase Realtime SIMULÉS (qa/collab_sim.py), comptes simulés,
micro simulé (WAV), navigateurs headless (aucune fenêtre). Le même script mesure le code d'avant et
celui d'après (il cherche d'abord l'écran « Artiste invité », sinon le DAW complet).

Usage : NOVA_URL=http://127.0.0.1:3494/ PHASE=apres FORMATS=tel390,tab,pc1366 python qa/collab_artiste.py
Sorties : D:\\1 WORK\\CONTENU\\nova-collab-artiste\\<PHASE>\\<format>\\ (captures + parcours.json)
"""
import json, os, re, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
PHASE = os.environ.get("PHASE", "apres")
FORMATS = [f for f in os.environ.get("FORMATS", "tel390,tab,pc1366").split(",") if f]
ROOT = Path(os.environ.get("QA_ROOT", r"D:\1 WORK\CONTENU\nova-collab-artiste"))
os.environ.setdefault("QA_OUT", str(ROOT / PHASE))
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3494/")
import qalib  # noqa
from qalib import *  # noqa
from gel_pre_effet import prepare, voice_wav  # noqa
from collab_sim import FakeNovaCloud, FakeRealtime, jwt, SUPA, STORE, free_billing  # noqa
from feat_lib import dismiss, wait_for, collab, open_panel, close_panel, REC_INIT, BASE_T  # noqa

MAX_UID, NINA_UID = "22222222-2222-4222-8222-222222222222", "44444444-4444-4444-8444-444444444444"
NINA_MAIL, NINA_PASS = "nina@test.local", "secret123"
LYRICS = "\n".join([
    "J'arrive au studio, casque sur les oreilles",
    "Max lance le beat, je pose ma voix",
    "Une prise, deux prises, on garde la meilleure",
    "Le refrain revient, tout le monde chante",
])
# Mots qu'un artiste débutant ne comprend pas (on les cherche dans ce qui est VISIBLE à l'écran).
JARGON = [r"latence", r"buffer", r"\bbus\b", r"\binserts?\b", r"\benvois?\b", r"\bpan\b", r"\bgain\b", r"\bdB\b", r"\d+\s?ms\b",
          r"kb/s", r"\bOpus\b", r"WebRTC", r"talkback", r"\bVST", r"plug-?in", r"\baux\b", r"sidechain", r"\btrim\b", r"\bphase\b",
          r"automation", r"\bgel(er|ée|é)?\b", r"\bpunch", r"\bARA\b", r"\bMIDI\b", r"\bHz\b", r"quantif", r"\bhôte\b", r"\bLUFS\b",
          r"\bFX\b", r"\b1/16\b", r"\bcomping\b", r"\bcomp\b"]
# Commandes qui changent la séance de l'ingé pour tout le monde (mix, structure, tempo, pistes).
DANGER = re.compile(r"(Volume (Beat|Voix lead|Bus)|Effets de (Beat|Voix lead|Bus)|Supprimer|Mix auto|^Envois|^Mixer$|BPM|Tempo|Dupliquer|^Couper$|^Gomme$|^Rogner$|^Fondus$|Changer de beat|Piste voix)", re.I)


def launch_rtc(p):
    """Comme qalib.launch, plus WebRTC entre pages headless (adresses locales en clair)."""
    return p.chromium.launch(headless=True, executable_path=CHROME, args=[
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={FAKE_WAV}",
        "--autoplay-policy=no-user-gesture-required", "--disable-features=WebRtcHideLocalIpsWithMdns",
    ])


def beat_wav(seconds=16, sr=44100):
    """Un « beat » reconnaissable : grosse caisse sur chaque temps (120 BPM) + accord tenu."""
    import io, wave
    import numpy as np
    t = np.arange(int(seconds * sr)) / sr
    x = 0.18 * (np.sin(2 * np.pi * 110 * t) + np.sin(2 * np.pi * 165 * t) + 0.6 * np.sin(2 * np.pi * 220 * t)) / 2.6
    for k in range(int(seconds * 2)):
        a = int(k * 0.5 * sr); n = int(0.12 * sr)
        if a + n < len(x):
            e = np.exp(-np.arange(n) / (0.03 * sr))
            x[a:a + n] += 0.6 * e * np.sin(2 * np.pi * 55 * np.arange(n) / sr)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def seance_project(path: Path):
    """La séance de Max : le beat, la « Voix lead » qu'il a préparée (une prise témoin), un bus voix, les paroles."""
    import zipfile
    phr = [(1.0, 3.0), (4.0, 6.0), (7.0, 9.0)]
    clips = [{"id": f"p{i+1}", "name": f"Témoin {i+1}", "start": a, "duration": b - a, "offset": a, "fadeIn": 0, "fadeOut": 0,
              "color": "#22d3ee", "type": "AUDIO", "audioRef": "audio/voix.wav", "gain": 1} for i, (a, b) in enumerate(phr)]
    tracks = [
        {**BASE_T, "id": "instrumental", "name": "Beat", "type": "AUDIO", "color": "#f59e0b", "volume": 0.8, "outputTrackId": "master", "sends": [], "plugins": [],
         "clips": [{"id": "beat1", "name": "Beat", "start": 0, "duration": 16, "offset": 0, "fadeIn": 0, "fadeOut": 0, "color": "#f59e0b", "type": "AUDIO", "audioRef": "audio/beat.wav", "gain": 1}]},
        {**BASE_T, "id": "voix", "name": "Voix lead", "type": "AUDIO", "color": "#22d3ee", "volume": 1.0, "outputTrackId": "bus-voix", "sends": [], "plugins": [], "clips": clips},
        {**BASE_T, "id": "bus-voix", "name": "Bus voix", "type": "BUS", "color": "#a78bfa", "volume": 1.0, "outputTrackId": "master", "sends": [], "plugins": [], "clips": []},
    ]
    state = {
        "id": "proj-seance-max", "name": "Séance du 12 octobre", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": "voix", "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0, "recStartTime": None,
        "isDelayCompEnabled": True, "lyrics": LYRICS, "lyricsStart": 0, "lyricsSpeed": 30,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 1, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/voix.wav", voice_wav())
        z.writestr("audio/beat.wav", beat_wav())


def connect_logged_out(page, cloud, rt, tag, uid, email):
    """Comme collab_sim.connect, mais l'artiste arrive SANS être connecté : il se connecte (ou crée son compte)
    dans l'appli. Connexion, création de compte, daw-session et Realtime sont simulés."""
    user = {"id": uid, "email": email, "aud": "authenticated", "role": "authenticated", "app_metadata": {}, "user_metadata": {}, "created_at": "2026-01-01T00:00:00Z"}
    tok = jwt(uid, email)
    sess = {"access_token": tok, "token_type": "bearer", "expires_in": 86400 * 30, "expires_at": int(time.time()) + 86400 * 30, "refresh_token": "qa-refresh", "user": user}
    page.add_init_script("try { localStorage.setItem('nova_simple_mode', '0'); localStorage.setItem('nova_count_in', '1'); localStorage.setItem('nova_auto_clean', '0'); } catch (e) {}")
    page.route(f"{SUPA}/auth/v1/user*", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(user)))
    page.route(f"{SUPA}/auth/v1/token*", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(sess)))
    page.route(f"{SUPA}/auth/v1/signup*", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(sess)))
    page.route(f"{SUPA}/auth/v1/logout*", lambda r: r.fulfill(status=204, body=""))
    page.route(f"{SUPA}/functions/v1/daw-session", cloud.handler(tag))
    page.route(f"{SUPA}/storage/v1/object/upload/sign/**", cloud.upload)
    page.route(f"{STORE}/**", cloud.download)
    page.route(f"{SUPA}/rest/v1/instrumentals*", lambda r: r.fulfill(status=200, content_type="application/json", body="[]"))
    page.route(f"{SUPA}/rest/v1/rpc/**", lambda r: r.fulfill(status=200, content_type="application/json", body="false"))
    page.route_web_socket(re.compile(r"realtime/v1/websocket"), rt.handler(tag))


def connect_engineer(page, cloud, rt, tag, uid, email):
    from collab_sim import connect
    connect(page, cloud, rt, tag, uid, email)


# ------------------------------------------------------------------ mesure de l'écran

AUDIT_JS = """(args) => {
  const [minTouch] = args;
  // Calques « transparents au doigt » (prompteur, bulles) : rendus testables le temps de la mesure, pour savoir
  // ce qui est VRAIMENT au premier plan (un texte derrière un écran plein ne compte pas).
  const pe = document.createElement('style'); pe.textContent = '* { pointer-events: auto !important; }'; document.head.appendChild(pe);
  const vw = innerWidth, vh = innerHeight;
  const inView = (r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  const vis = (el) => { const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity !== 0; };
  // Vraiment au premier plan : ce qui est recouvert par un écran plein ou un panneau ne compte pas.
  const onTop = (el, r) => { const x = Math.min(vw - 1, Math.max(0, r.left + r.width / 2)), y = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
    const hit = document.elementFromPoint(x, y); return !!hit && (el === hit || el.contains(hit) || hit.contains(el)); };
  // Texte VISIBLE à l'écran (pas tout le document).
  // (le texte de chaque élément en entier : « 🔊 Max te parle… » est fait de plusieurs morceaux de texte)
  const parts = [];
  const seen = new Set();
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n; while ((n = tw.nextNode())) { const el = n.parentElement; const s = n.textContent.trim(); if (!el || !s) continue;
    const blk = el.closest('p, li, button, h1, h2, h3, label, span, div') || el;
    if (seen.has(blk)) continue;
    const r = el.getBoundingClientRect(); if (inView(r) && vis(el) && el.closest('[aria-hidden=true]') === null && onTop(el, r)) { seen.add(blk); parts.push((blk.innerText || s).replace(/\\s+/g, ' ').trim()); } }
  const ctrls = Array.from(document.querySelectorAll('button, [role=button], a[href], input, select, textarea, [role=slider]'))
    .filter(b => { const r = b.getBoundingClientRect(); return inView(r) && vis(b) && !b.disabled && onTop(b, r); })
    .map(b => { const r = b.getBoundingClientRect(); return { t: (b.getAttribute('aria-label') || b.innerText || b.placeholder || b.title || b.type || '').trim().replace(/\\s+/g, ' ').slice(0, 60), w: Math.round(r.width), h: Math.round(r.height) }; });
  // Ce qui est réellement au-dessus (une commande recouverte par un écran plein n'est pas « visible »).
  const top = ctrls.filter((c, i) => true);
  pe.remove();
  return { text: parts.join(' | ').slice(0, 6000), controls: top, small: top.filter(c => Math.min(c.w, c.h) < minTouch) };
}"""


def audit(page, touch):
    a = page.evaluate(AUDIT_JS, [44 if touch else 24])
    words = sorted({m.group(0) for pat in JARGON for m in re.finditer(pat, a["text"], re.I)})
    danger = [c["t"] for c in a["controls"] if DANGER.search(c["t"] or "")]
    return {"commandes_visibles": len(a["controls"]), "petites_cibles": len(a["small"]), "petites_cibles_ex": [f"{c['t']} ({c['w']}×{c['h']})" for c in a["small"][:10]],
            "jargon": words, "commandes_qui_modifient_la_seance_de_l_inge": danger[:20], "nb_commandes_dangereuses": len(danger), "texte": a["text"][:1500]}


# ------------------------------------------------------------------ le parcours

class Parcours:
    def __init__(self, vp, out: Path):
        self.vp, self.out = vp, out
        self.touch = vp != "pc1366"
        self.steps = []
        self.cur = None

    def start(self, key, title):
        self.cur = {"etape": key, "titre": title, "gestes": [], "frictions": [], "attente_s": 0.0, "t0": time.time(), "mesures": {}}
        self.steps.append(self.cur)

    def g(self, what):
        self.cur["gestes"].append(what)

    def friction(self, what):
        if what not in self.cur["frictions"]:
            self.cur["frictions"].append(what)

    def wait(self, s):
        self.cur["attente_s"] = round(self.cur["attente_s"] + (s or 0), 2)

    def m(self, **kw):
        self.cur["mesures"].update(kw)

    def end(self):
        self.cur["duree_s"] = round(time.time() - self.cur.pop("t0"), 1)
        self.cur["nb_gestes"] = len(self.cur["gestes"])

    def shot(self, page, name):
        p = self.out / f"{name}.png"
        try:
            page.screenshot(path=str(p))
        except Exception:
            pass
        return p.name


def in_view(page, loc):
    try:
        b = loc.bounding_box()
    except Exception:
        return False
    if not b:
        return False
    vp = page.viewport_size
    return b["y"] >= 0 and b["y"] + b["height"] <= vp["height"] and b["x"] >= 0 and b["x"] + b["width"] <= vp["width"]


def tap(P, page, loc, what):
    loc = loc.first
    loc.wait_for(state="attached", timeout=15000)
    if not in_view(page, loc):
        P.g("faire défiler")
        loc.scroll_into_view_if_needed(timeout=5000)
    if P.touch:
        try:
            loc.tap(timeout=5000)
        except Exception:
            loc.click(timeout=5000)
    else:
        loc.click(timeout=5000)
    P.g(what)


def type_in(P, page, loc, text, what):
    loc = loc.first
    if not in_view(page, loc):
        P.g("faire défiler")
        loc.scroll_into_view_if_needed(timeout=5000)
    loc.fill(text)
    P.g(f"écrire {what}")


def hold(P, page, loc, seconds, what, count=True):
    loc = loc.first
    if not in_view(page, loc):
        if count:
            P.g("faire défiler")
        loc.scroll_into_view_if_needed(timeout=5000)
    b = loc.bounding_box()
    page.mouse.move(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)
    page.mouse.down()
    if count:
        P.g(f"maintenir {what}")
    return lambda: page.mouse.up()


def text_on_screen(page, pattern):
    return bool(re.search(pattern, page.evaluate(AUDIT_JS, [0])["text"], re.I))


def guest(page):
    return page.get_by_test_id("guest-studio").count() > 0


def st(page, expr):
    return page.evaluate(f"() => {{ const d = window.__novaTest.getState(); return ({expr}); }}")


def mix_level(page, suffix=":mix", seconds=4.0):
    return page.evaluate("""async ([suffix, secs]) => { const el = document.querySelector(`audio[data-collab-audio$="${suffix}"]`); if (!el || !el.srcObject) return null;
        const ctx = new AudioContext(); const src = ctx.createMediaStreamSource(el.srcObject); const an = ctx.createAnalyser(); an.fftSize = 2048; src.connect(an);
        const buf = new Float32Array(2048); let best = -200;
        for (let i = 0; i < secs * 10; i++) { await new Promise(r => setTimeout(r, 100)); an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; best = Math.max(best, 10 * Math.log10(s / buf.length + 1e-12)); }
        ctx.close(); return +best.toFixed(1); }""", [suffix, seconds])


def run_format(p, vp):
    out = qalib.OUT / vp
    out.mkdir(parents=True, exist_ok=True)
    P = Parcours(vp, out)
    res = {"format": vp, "phase": PHASE, "viewport": VIEWPORTS[vp], "ok": True, "verifications": {}, "audits": {}, "erreurs": []}

    def check(label, ok, detail=None):
        res["verifications"][label] = {"ok": bool(ok), **({"detail": detail} if detail is not None else {})}
        if not ok:
            res["ok"] = False

    # 1.5.1 (invité gratuit) : seul Max, l'hôte, a Nova Pro ; Nina a un compte GRATUIT (serveur ET appli).
    cloud = FakeNovaCloud(per_device=True, codes=True, strict=True, pro={MAX_UID})
    rt = FakeRealtime()
    src = out / "00_seance_max.novaproj.zip"
    seance_project(src)
    b = launch_rtc(p)
    lE, lT = Log(f"inge_{vp}"), Log(f"artiste_{vp}")
    # L'ingé a un casque ; l'artiste, NON (haut-parleurs du téléphone ou du PC) : il doit être guidé.
    os.environ["QA_SORTIE_AUDIO"] = "Casque (Realtek(R) Audio)"
    cE, E = new_page(b, "pc", lE)
    E.add_init_script(REC_INIT)
    prepare(E, None, desktop=False)
    connect_engineer(E, cloud, rt, "E", MAX_UID, "max@test.local")
    os.environ["QA_SORTIE_AUDIO"] = "Haut-parleurs (Realtek(R) Audio)"
    cT, T = new_page(b, vp, lT)
    os.environ["QA_SORTIE_AUDIO"] = "Casque (Realtek(R) Audio)"
    prepare(T, None, desktop=False)
    free_billing(T)
    connect_logged_out(T, cloud, rt, "T", NINA_UID, NINA_MAIL)
    E.goto(BASE, wait_until="domcontentloaded", timeout=180000)
    E.get_by_text("Charger Projet").first.wait_for(timeout=180000)

    # ------------------------------------------------ préparation : Max ouvre sa séance (PC), en ingé, hôte
    from gel_pre_effet import open_project_file
    open_project_file(E, src, {}, str(Path(vp) / "E0_seance_de_max"))
    dismiss(E); open_panel(E)
    E.get_by_test_id("collab-role").select_option("engineer")
    E.get_by_placeholder("Ton nom (affiché aux autres)").fill("Max")
    E.get_by_role("button", name="Démarrer la collaboration en direct").click()
    wait_for(E, lambda: collab(E, "c.role()") == "engineer", 90, what="séance de Max en ligne")
    E.wait_for_timeout(1500)
    sid = next(k for k, v in cloud.sessions.items() if v["manifest"])
    link = collab(E, "c.invite ? c.invite() : null") or f"{BASE}?session={sid}.{cloud.sessions[sid]['secret']}&invite=1"
    try:
        wait_for(E, lambda: re.search(r"[A-Z0-9]{3} [A-Z0-9]{3}", E.get_by_test_id("collab-invite-code").inner_text()), 20, what="code")
        code = re.search(r"([A-Z0-9]{3}) ([A-Z0-9]{3})", E.get_by_test_id("collab-invite-code").inner_text()).group(0)
    except Exception:
        code = None
    res["invitation"] = {"lien": link.replace(BASE, "…/"), "code": code}
    P.shot(E, "E1_inge_invite")
    has_rights_ui = E.get_by_test_id("collab-guest-rights").count() > 0
    res["inge_reglage_des_droits"] = has_rights_ui
    if has_rights_ui:
        E.get_by_test_id("collab-guest-rights").scroll_into_view_if_needed()
        P.shot(E, "E2_inge_droits_de_l_artiste")
    close_panel(E)

    # ------------------------------------------------ 1. invitation
    P.start("1_invitation", "Nina reçoit le lien de Max et l'ouvre")
    t0 = time.time()
    T.goto(link, wait_until="domcontentloaded", timeout=180000)
    P.g("ouvrir le lien reçu")
    wait_for(T, lambda: T.get_by_test_id("collab-arrival").count() > 0, 120, step=200, what="carte d'arrivée")
    P.wait(time.time() - t0)
    T.wait_for_timeout(1200); dismiss(T)
    P.m(sait_qui_invite=text_on_screen(T, r"\bMax\b"), role_deja_choisi=T.locator("[data-testid=arrival-role-artist][data-quick='1'], [data-testid=arrival-role-artist] input:checked").count() > 0)
    if not P.cur["mesures"]["sait_qui_invite"]:
        P.friction("La carte d'arrivée ne dit pas QUI invite (le nom de l'ingé n'apparaît pas)")
    if not P.cur["mesures"]["role_deja_choisi"]:
        P.friction("Il faut lire 3 rôles (artiste, ingé son, beatmaker) et choisir : choisir « Ingé son » par erreur donne la main sur tout le mix")
    P.shot(T, "T01_arrivee")
    res["audits"]["arrivee"] = audit(T, P.touch)
    P.end()

    # ------------------------------------------------ 2. compte
    P.start("2_compte", "Nina se connecte avec son compte (elle en a un) et rejoint")
    t0 = time.time()
    if T.get_by_test_id("arrival-login").count():
        type_in(P, T, T.get_by_label("Ton nom", exact=True), "Nina", "son nom")
        type_in(P, T, T.get_by_test_id("arrival-login").get_by_label("E-mail"), NINA_MAIL, "son e-mail")
        type_in(P, T, T.get_by_test_id("arrival-login").get_by_label("Mot de passe"), NINA_PASS, "son mot de passe")
        tap(P, T, T.get_by_test_id("arrival-join"), "« Me connecter et rejoindre »")
    else:
        art = T.get_by_test_id("arrival-role-artist")
        if not art.locator("input:checked").count() and not T.locator("[data-testid=arrival-role-artist][data-quick='1']").count():
            tap(P, T, art, "choisir « Artiste »")
        type_in(P, T, T.get_by_label("Ton nom", exact=True), "Nina", "son nom")
        tap(P, T, T.get_by_test_id("arrival-join"), "« Rejoindre »")
        wait_for(T, lambda: T.get_by_placeholder("E-mail").count() > 0 or collab(T, "c.role()") == "artist", 30, what="connexion demandée")
        if T.get_by_placeholder("E-mail").count():
            P.friction("Après « Rejoindre », un 2e écran demande de se connecter (il fallait le savoir avant)")
            P.shot(T, "T02_connexion_demandee")
            type_in(P, T, T.get_by_placeholder("E-mail"), NINA_MAIL, "son e-mail")
            type_in(P, T, T.get_by_placeholder("Mot de passe"), NINA_PASS, "son mot de passe")
            tap(P, T, T.get_by_role("button", name="Se connecter"), "« Se connecter »")
    if T.get_by_text("Créer un compte sur studiomakemusic.com").count():
        P.friction("Pas de compte ? « Créer un compte » ouvre un AUTRE site (studiomakemusic.com) : il faut revenir ensuite")
    wait_for(T, lambda: collab(T, "c.role()") == "artist", 90, step=200, what="Nina reliée")
    P.wait(time.time() - t0)
    # 1.5.1 · lot 3 : Nina n'a PAS Nova Pro (compte gratuit, serveur et appli) et rejoint quand même.
    P.m(invite_gratuit=True, nina_pro=cloud.is_pro(NINA_UID), hote_pro=cloud.is_pro(MAX_UID))
    check("invité gratuit : Nina (sans Nova Pro) rejoint la séance de Max (seul l'hôte a Nova Pro)", not cloud.is_pro(NINA_UID) and collab(T, "c.role()") == "artist")
    abo = text_on_screen(T, r"abonne-toi|M'abonner|abonnement collaboration")
    check("invité gratuit : aucun « abonne-toi » montré à l'invitée", not abo)
    P.end()

    # ------------------------------------------------ 3. où suis-je ?
    P.start("3_arrivee", "Nina arrive dans la séance : comprend-elle où elle est et qui est là ?")
    T.wait_for_timeout(2500); dismiss(T)
    # Max relié dans la présence ?
    try:
        s = wait_for(T, lambda: text_on_screen(T, r"Max"), 15, step=300, what="Max visible")
        P.wait(s)
    except AssertionError:
        pass
    P.shot(T, "T03_premier_ecran")
    a = audit(T, P.touch)
    res["audits"]["premier_ecran"] = a
    P.m(voit_max=text_on_screen(T, r"\bMax\b"), voit_role_inge=text_on_screen(T, r"ing[ée]"), ecran_artiste_invite=guest(T))
    if not guest(T):
        # Avant : le panneau Collaboration reste ouvert par-dessus le DAW complet ; on le ferme pour voir l'écran principal.
        if T.locator("[aria-labelledby='collab-title']").count():
            P.shot(T, "T03b_panneau_par_dessus")
            close_panel(T); P.g("fermer le panneau Collaboration")
        T.wait_for_timeout(600)
        P.shot(T, "T03c_ecran_principal")
        a2 = audit(T, P.touch)
        res["audits"]["ecran_principal"] = a2
        P.m(voit_max_ecran_principal=text_on_screen(T, r"\bMax\b"))
        if not text_on_screen(T, r"\bMax\b"):
            P.friction("Sur l'écran principal (DAW complet), rien ne dit qu'on est dans la séance de Max ni qu'il est là")
        if a2["nb_commandes_dangereuses"]:
            P.friction(f"{a2['nb_commandes_dangereuses']} commandes visibles qui modifient la séance de l'ingé ({', '.join(a2['commandes_qui_modifient_la_seance_de_l_inge'][:6])})")
        if a2["jargon"]:
            P.friction("Jargon visible : " + ", ".join(a2["jargon"][:10]))
        if a2["petites_cibles"] and P.touch:
            P.friction(f"{a2['petites_cibles']} boutons trop petits pour le doigt (< 44 px)")
    else:
        res["audits"]["ecran_principal"] = a
        if a["nb_commandes_dangereuses"]:
            P.friction(f"{a['nb_commandes_dangereuses']} commandes visibles qui modifient la séance de l'ingé")
        if a["jargon"]:
            P.friction("Jargon visible : " + ", ".join(a["jargon"][:10]))
        if a["petites_cibles"] and P.touch:
            P.friction(f"{a['petites_cibles']} boutons trop petits pour le doigt (< 44 px) : " + ", ".join(a["petites_cibles_ex"][:4]))
    P.end()

    # ------------------------------------------------ 4. casque et micro (Nina n'a PAS de casque)
    P.start("4_casque_micro", "Nina règle son micro ; elle n'a pas de casque : est-elle guidée ?")
    if guest(T):
        hp = T.get_by_test_id("guest-headphones")
        try:
            wait_for(T, lambda: hp.get_attribute("data-state") != "inconnu", 6, step=200, what="casque détecté")
        except AssertionError:
            pass
        state = hp.get_attribute("data-state") if hp.count() else None
        if state == "inconnu":
            tap(P, T, T.get_by_test_id("guest-setup").get_by_role("button", name="Non"), "répondre « pas de casque »")
            state = hp.get_attribute("data-state")
        P.m(casque_detecte=state, conseil_sans_casque=text_on_screen(T, r"Pas de casque|écouteurs"))
        tap(P, T, T.get_by_test_id("guest-test-mic"), "« Tester mon micro »")
        try:
            s = wait_for(T, lambda: T.get_by_test_id("guest-mic").count() > 0, 15, step=200, what="vumètre")
            P.wait(s)
            T.wait_for_timeout(1500)
        except AssertionError:
            P.friction("Le test du micro ne s'affiche pas")
        P.m(vumetre=T.get_by_test_id("guest-mic").count() > 0, verdict_micro=(T.get_by_test_id("guest-mic").inner_text()[:80] if T.get_by_test_id("guest-mic").count() else None))
        T.get_by_test_id("guest-setup").scroll_into_view_if_needed()
    else:
        P.m(conseil_sans_casque=text_on_screen(T, r"casque|écouteurs"), vumetre=False)
        P.friction("Aucun réglage micro / casque proposé avant la prise ; la question du casque arrive seulement au premier REC (et ici, détectée en silence : rien n'est dit à l'écran du téléphone)")
        P.friction("Pas de test du micro avant d'enregistrer (le vumètre n'existe que dans la question du casque)")
    P.shot(T, "T04_casque_micro")
    P.end()

    # ------------------------------------------------ 5. écouter le mix de l'ingé
    P.start("5_mix_inge", "Max diffuse son mix et lance la lecture : Nina l'écoute")
    open_panel(E)
    E.get_by_test_id("collab-mix-out").scroll_into_view_if_needed(); E.get_by_test_id("collab-mix-out").click()
    close_panel(E)
    E.evaluate("() => window.DAW_CONTROL.seek(0)"); E.wait_for_timeout(300)
    E.get_by_role("button", name=re.compile(r"^(Lecture|Lire)")).locator("visible=true").first.click()
    t0 = time.time()
    if guest(T):
        wait_for(T, lambda: T.get_by_test_id("guest-listen-toggle").count() > 0, 30, step=200, what="bouton « écouter Max »")
        tap(P, T, T.get_by_test_id("guest-listen-toggle"), "« Écouter le son de Max »")
        status = lambda: T.get_by_test_id("guest-mix-status").get_attribute("data-state") if T.get_by_test_id("guest-mix-status").count() else None  # noqa
    else:
        open_panel(T); P.g("ouvrir le menu" if vp == "tel390" else "ouvrir « Collaboration »")
        if vp == "tel390":
            P.g("toucher « Collaborer »")
        wait_for(T, lambda: T.get_by_test_id("collab-mix-listen").count() > 0, 30, step=200, what="« Écouter le mix de Max »")
        tap(P, T, T.get_by_test_id("collab-mix-listen"), "« Écouter le mix de Max »")
        status = lambda: T.get_by_test_id("collab-mix-status").get_attribute("data-state") if T.get_by_test_id("collab-mix-status").count() else None  # noqa
    try:
        s = wait_for(T, lambda: status() == "ecoute", 25, step=200, what="mix reçu")
        P.wait(time.time() - t0)
        P.m(son_recu_en_s=round(time.time() - t0, 1))
    except AssertionError:
        P.friction("Le mix de Max n'arrive pas (état : %s)" % status())
    lvl = mix_level(T, ":mix", 3)
    P.m(niveau_mix_recu_db=lvl)
    check(f"{vp} : Nina entend le mix de Max (niveau > -60 dB)", lvl is not None and lvl > -60, lvl)
    a = audit(T, P.touch)
    if a["jargon"]:
        P.friction("Jargon visible : " + ", ".join(a["jargon"][:10]))
    P.shot(T, "T05_ecoute_du_mix")
    P.end()

    # ------------------------------------------------ 6. prise demandée : talkback, décompte, paroles
    P.start("6_prise", "Max lui parle (« vas-y ») ; Nina enregistre : voit-elle le décompte et ses paroles ?")
    E.keyboard.press("Space"); E.wait_for_timeout(400)  # Max arrête sa lecture
    open_panel(E)
    up = hold(P, E, E.get_by_test_id("collab-talk"), 0, "(Max) talkback", count=False)  # geste de Max, pas de Nina
    try:
        s = wait_for(T, lambda: text_on_screen(T, r"Max te parle"), 20, step=150, what="« Max te parle » visible")
        P.m(voit_max_te_parle=True, max_te_parle_en_s=s)
    except AssertionError:
        P.m(voit_max_te_parle=False)
        P.friction("Quand Max parle au talkback, rien ne s'affiche sur l'écran où elle est (« Max te parle » n'existe que dans le panneau Collaboration)")
    talk_lvl = mix_level(T, ":talk", 2)
    P.m(niveau_talkback_db=talk_lvl)
    P.shot(T, "T06a_max_parle")
    up(); close_panel(E)
    # REC
    before = st(T, "d.tracks.flatMap(t => t.clips.map(c => c.id))")
    if guest(T):
        rec = T.get_by_test_id("guest-rec")
    else:
        if T.locator("[aria-labelledby='collab-title']").count():
            close_panel(T); P.g("fermer le panneau Collaboration")
        rec = T.get_by_role("button", name=re.compile(r"^(Enregistrer|Arrêter l'enregistrement)$")).locator("visible=true")
    tap(P, T, rec, "REC")
    t0 = time.time()
    # Casque : la question peut venir (avant : seulement si rien n'est détecté).
    seen_count = False
    lyrics_seen = False
    asked = False
    while time.time() - t0 < 10:
        if T.locator("#casque-titre").count():
            asked = True
            P.shot(T, "T06b_question_casque")
            tap(P, T, T.get_by_role("button", name=re.compile("Non, haut-parleurs")), "répondre « haut-parleurs »")
        if text_on_screen(T, r"Prépare-toi"):
            if not seen_count:
                P.shot(T, "T06c_decompte")
            seen_count = True
        if st(T, "d.isRecording"):
            break
        T.wait_for_timeout(100)
    rec_started = st(T, "d.isRecording")
    check(f"{vp} : la prise démarre", rec_started)
    # Fin du décompte (la prise est lancée et l'écran du décompte est parti), puis on regarde l'écran.
    tc = time.time()
    while time.time() - tc < 6 and text_on_screen(T, r"Prépare-toi"):
        if not seen_count:
            P.shot(T, "T06c_decompte")
        seen_count = True
        T.wait_for_timeout(100)
    T.wait_for_timeout(800)
    lyrics_seen = text_on_screen(T, r"J'arrive au studio|Max lance le beat|Une prise, deux prises")
    P.shot(T, "T06d_pendant_la_prise")
    P.m(decompte_visible=seen_count, paroles_visibles_pendant_la_prise=lyrics_seen, question_casque=asked)
    if not seen_count:
        P.friction("Pas de décompte visible avant la prise")
    if not lyrics_seen:
        P.friction("Ses paroles ne sont pas à l'écran pendant la prise (il faut ouvrir « Paroles » avant)")
    T.wait_for_timeout(2500)
    stop = T.get_by_test_id("guest-rec") if guest(T) else T.get_by_role("button", name=re.compile(r"^(Arrêter l'enregistrement|Stop)$")).locator("visible=true")
    tap(P, T, stop, "STOP")
    t1 = time.time()
    try:
        wait_for(T, lambda: any(c not in before for c in st(T, "d.tracks.flatMap(t => t.clips.map(c => c.id))")), 15, step=150, what="prise posée")
        new_ids = [c for c in st(T, "d.tracks.flatMap(t => t.clips.map(c => c.id))") if c not in before]
        tid = st(T, f"d.tracks.find(t => t.clips.some(c => c.id === {json.dumps(new_ids[0])})).id")
        tname = st(T, f"d.tracks.find(t => t.id === {json.dumps(tid)}).name")
        wait_for(E, lambda: E.evaluate(f"() => window.__novaTest.getState().tracks.some(t => t.clips.some(c => c.id === {json.dumps(new_ids[0])}))"), 40, step=150, what="prise reçue chez Max")
        P.m(prise_recue_chez_max_en_s=round(time.time() - t1, 1), piste_de_la_prise=tname)
        res["piste_de_nina"] = {"id": tid, "nom": tname}
        if tid == "voix":
            P.friction("La prise de Nina part sur la « Voix lead » préparée par Max (sur sa prise témoin), pas sur une piste à son nom")
    except AssertionError as e:
        P.friction(f"Prise non reçue chez Max ({e})")
        res["piste_de_nina"] = None
    P.shot(T, "T06e_apres_la_prise")
    P.end()

    # ------------------------------------------------ 7. réécouter, recommencer, choisir
    P.start("7_reecouter_choisir", "Nina réécoute sa prise, en refait une, puis garde la première")
    tid = (res.get("piste_de_nina") or {}).get("id")
    if guest(T):
        tap(P, T, T.get_by_test_id("guest-take").first.get_by_test_id("guest-take-play"), "« ▶ Écouter » sa prise")
        T.wait_for_timeout(1500)
        P.m(lecture_de_sa_prise=st(T, "d.isPlaying"))
        tap(P, T, T.get_by_test_id("guest-take").first.get_by_test_id("guest-take-play"), "« ■ Stop »")
        tap(P, T, T.get_by_test_id("guest-rec"), "REC (2e prise)")
        wait_for(T, lambda: st(T, "d.isRecording"), 12, step=100, what="2e prise")
        T.wait_for_timeout(2500)
        tap(P, T, T.get_by_test_id("guest-rec"), "STOP")
        wait_for(T, lambda: T.get_by_test_id("guest-take").count() >= 2, 15, step=200, what="2 prises listées")
        P.shot(T, "T07a_deux_prises")
        tap(P, T, T.locator("[data-testid=guest-take][data-n='1']").get_by_test_id("guest-take-keep"), "« ✓ Garder » la prise 1")
        T.wait_for_timeout(800)
        kept = T.locator("[data-testid=guest-take][data-n='1']").get_attribute("data-kept") == "1"
    else:
        # Avant : réécouter = Lecture dans la barre du haut (depuis le début de la prise), recommencer = REC, choisir = « Mix auto » → « Mes prises ».
        T.evaluate("() => window.DAW_CONTROL && window.DAW_CONTROL.seek(0)")
        P.g("ramener la tête de lecture au début (glisser sur la règle)")
        tap(P, T, T.get_by_role("button", name=re.compile(r"^(Lecture|Lire)")).locator("visible=true"), "Lecture")
        T.wait_for_timeout(1500)
        P.m(lecture_de_sa_prise=st(T, "d.isPlaying"))
        tap(P, T, T.get_by_role("button", name=re.compile(r"^(Stop|Pause)")).locator("visible=true"), "Stop")
        T.wait_for_timeout(600)
        tap(P, T, T.get_by_role("button", name=re.compile(r"^Enregistrer$")).locator("visible=true"), "REC (2e prise)")
        wait_for(T, lambda: st(T, "d.isRecording"), 12, step=100, what="2e prise")
        T.wait_for_timeout(2500)
        tap(P, T, T.get_by_role("button", name=re.compile(r"^(Arrêter l'enregistrement|Stop)$")).locator("visible=true"), "STOP")
        T.wait_for_timeout(1500)
        kept = False
        try:
            tap(P, T, T.locator("button:visible", has_text="Mix auto"), "« Mix auto » (pour trouver ses prises)")
            T.wait_for_timeout(800)
            P.shot(T, "T07a_mix_auto_prises")
            mes = T.locator("[data-mes-prises]")
            if mes.count():
                tap(P, T, mes.get_by_role("button", name="Garder").first, "« Garder » une prise")
                kept = True
            else:
                P.friction("Ses prises n'apparaissent pas dans « Mix auto »")
            T.keyboard.press("Escape")
        except Exception as e:  # noqa
            P.friction(f"Choisir sa prise : introuvable ({str(e)[:80]})")
        P.friction("Ses prises se choisissent dans « Mix auto », un panneau de styles de mix (rien ne l'indique), au milieu de commandes qui changent le son de l'ingé")
    P.m(prise_gardee=kept)
    if tid:
        try:
            wait_for(E, lambda: E.evaluate(f"""() => {{ const t = window.__novaTest.getState().tracks.find(x => x.id === {json.dumps(tid)}); if (!t) return false;
                const n1 = t.clips.filter(c => c.takeNumber === 1 && !c.isMuted).length, n2 = t.clips.filter(c => c.takeNumber === 2 && !c.isMuted).length; return n1 > 0 && n2 === 0; }}"""), 25, step=200, what="choix de prise reçu chez Max")
            P.m(choix_recu_chez_max=True)
        except AssertionError:
            P.m(choix_recu_chez_max=False)
    P.shot(T, "T07b_prise_choisie")
    # 📌 Prises gardées (15/10/2026) : l'artiste met la prise 2 de côté depuis son téléphone ;
    # elle arrive dans la zone « Prises gardées » de l'ingé (op « content », droits de l'ingé respectés).
    pin = T.locator("[data-testid=guest-take][data-n='2']").get_by_test_id("guest-take-pin") if guest(T) else None
    if pin is not None and pin.count() and tid:
        tap(P, T, pin, "« 📌 De côté » la prise 2")
        T.wait_for_timeout(600)
        P.shot(T, "T07c_prise_de_cote")
        try:
            wait_for(E, lambda: E.evaluate(f"""() => {{ const t = window.DAW_CONTROL.getState().tracks.find(x => x.id === {json.dumps(tid)});
                return !!t && (t.takeMeta || []).some(m => m.n === 2 && m.kept); }}"""), 25, step=300, what="prise gardée reçue chez Max")
            pin_ok = True
        except AssertionError:
            pin_ok = False
        P.m(prise_de_cote_recue_chez_max=pin_ok)
        check(f"{vp} : 📌 « De côté » (artiste) : la prise arrive dans les prises gardées de l'ingé", pin_ok)
        P.shot(E, "E07c_prises_gardees_chez_max")
    elif guest(T):
        check(f"{vp} : 📌 « De côté » visible sur les prises de l'artiste", False, "bouton guest-take-pin absent")
    P.end()

    # ------------------------------------------------ 8. parler à l'ingé
    P.start("8_parler", "Nina écrit à Max, puis lui parle au talkback")
    msg = f"On la refait au refrain ? ({vp})"
    if guest(T):
        type_in(P, T, T.get_by_test_id("guest-chat-input"), msg, "son message")
        tap(P, T, T.get_by_test_id("guest-chat-send"), "« Envoyer »")
        talk = T.get_by_test_id("guest-talk")
    else:
        if not T.locator("[aria-labelledby='collab-title']").count():
            open_panel(T); P.g("ouvrir le menu" if vp == "tel390" else "ouvrir « Collaboration »")
            if vp == "tel390":
                P.g("toucher « Collaborer »")
        type_in(P, T, T.get_by_label("Message", exact=True), msg, "son message")
        tap(P, T, T.get_by_role("button", name="Envoyer", exact=True), "« ➤ » (envoyer)")
        talk = T.get_by_test_id("collab-talk")
    t0 = time.time()
    try:
        wait_for(E, lambda: collab(E, f"c.messages().some(m => m.text === {json.dumps(msg)})"), 20, step=100, what="message reçu par Max")
        P.m(message_recu_en_s=round(time.time() - t0, 2))
    except AssertionError:
        P.friction("Message non reçu par Max")
    open_panel(E)
    up = hold(P, T, talk, 0, "« Parler » (talkback)")
    try:
        s = wait_for(E, lambda: E.get_by_test_id("collab-talking").count() > 0, 20, step=150, what="« Nina te parle » chez Max")
        P.m(talkback_vu_par_max_en_s=s)
    except AssertionError:
        P.friction("Max ne voit pas que Nina lui parle")
    P.m(niveau_talkback_chez_max_db=mix_level(E, ":talk", 2))
    P.shot(T, "T08_parle_a_max")
    up()
    # 16/10/2026 (guidage) : Échap ferme le panneau Collaboration comme les autres fenêtres ; fermer ne quitte pas la séance.
    if E.locator("[aria-labelledby='collab-title']").count():
        E.evaluate("() => document.activeElement && document.activeElement.blur && document.activeElement.blur()")
        E.keyboard.press("Escape"); E.wait_for_timeout(500)
        check(f"{vp} : Échap ferme le panneau Collaboration de Max, sans quitter la séance",
              E.locator("[aria-labelledby='collab-title']").count() == 0 and collab(E, "c.role()") is not None, collab(E, "c.role()"))
    close_panel(E)
    a = audit(T, P.touch)
    if a["jargon"]:
        P.friction("Jargon visible : " + ", ".join(a["jargon"][:10]))
    P.end()

    # ------------------------------------------------ 9. coupure réseau puis retour
    P.start("9_reseau", "Nina perd le réseau 8 s (elle écrit à Max pendant ce temps), puis le retrouve")
    if not guest(T) and T.locator("[aria-labelledby='collab-title']").count():
        close_panel(T)
    cloud.down.add("T"); rt.drop("T"); rt.blocked.add("T")
    T.context.set_offline(True)
    T.evaluate("() => window.dispatchEvent(new Event('offline'))")
    T.wait_for_timeout(3500)
    P.shot(T, "T09a_hors_ligne")
    said = text_on_screen(T, r"Connexion perdue|Hors ligne|hors ligne|réseau")
    P.m(coupure_dite_a_l_ecran=said)
    if not said:
        P.friction("Réseau coupé : rien ne le dit sur l'écran où elle est (l'état n'est que dans le panneau Collaboration)")
    off_msg = f"Tu m'entends ? ({vp})"
    if guest(T):
        type_in(P, T, T.get_by_test_id("guest-chat-input"), off_msg, "un message hors ligne")
        tap(P, T, T.get_by_test_id("guest-chat-send"), "« Envoyer »")
    else:
        open_panel(T); P.g("ouvrir le menu" if vp == "tel390" else "ouvrir « Collaboration »")
        if vp == "tel390":
            P.g("toucher « Collaborer »")
        type_in(P, T, T.get_by_label("Message", exact=True), off_msg, "un message hors ligne")
        tap(P, T, T.get_by_role("button", name="Envoyer", exact=True), "« ➤ »")
    T.wait_for_timeout(4500)
    cloud.down.discard("T"); rt.blocked.discard("T")
    T.context.set_offline(False)
    T.evaluate("() => window.dispatchEvent(new Event('online'))")
    t0 = time.time()
    try:
        wait_for(E, lambda: collab(E, f"c.messages().some(m => m.text === {json.dumps(off_msg)})"), 40, step=200, what="message hors ligne reçu")
        P.m(retour_reseau_message_recu_en_s=round(time.time() - t0, 1))
        check(f"{vp} : rien de perdu pendant la coupure", True)
    except AssertionError:
        check(f"{vp} : rien de perdu pendant la coupure", False)
    T.wait_for_timeout(1500)
    P.shot(T, "T09b_reseau_revenu")
    P.m(etat_apres=collab(T, "c.status ? c.status() : null"))
    P.end()

    # ------------------------------------------------ 10. quitter, revenir plus tard
    P.start("10_quitter_revenir", "Nina quitte la séance, puis revient plus tard par le même lien")
    if guest(T):
        tap(P, T, T.get_by_test_id("guest-menu"), "« ⋯ »")
        tap(P, T, T.get_by_test_id("guest-leave"), "« Quitter la séance »")
        tap(P, T, T.get_by_test_id("guest-leave-confirm"), "confirmer « Quitter »")
    else:
        if not T.locator("[aria-labelledby='collab-title']").count():
            open_panel(T); P.g("ouvrir le menu" if vp == "tel390" else "ouvrir « Collaboration »")
            if vp == "tel390":
                P.g("toucher « Collaborer »")
        tap(P, T, T.get_by_role("button", name="Quitter la collaboration"), "« Quitter la collaboration »")
    wait_for(T, lambda: collab(T, "c.role()") is None, 20, step=200, what="Nina partie")
    T.wait_for_timeout(800)
    P.shot(T, "T10a_apres_quitter")
    a = audit(T, P.touch)
    P.m(ecran_apres_depart=a["texte"][:200])
    # Plus tard : elle rouvre le lien (nouvelle page).
    t0 = time.time()
    T.goto(link, wait_until="domcontentloaded")
    P.g("rouvrir le lien")
    wait_for(T, lambda: T.get_by_test_id("collab-arrival").count() > 0 or collab(T, "c.role()") == "artist", 120, step=200, what="arrivée (retour)")
    T.wait_for_timeout(1500); dismiss(T)
    if collab(T, "c.role()") != "artist":
        P.shot(T, "T10b_retour_arrivee")
        art = T.get_by_test_id("arrival-role-artist")
        if art.count() and not art.locator("input:checked").count() and not T.locator("[data-testid=arrival-role-artist][data-quick='1']").count():
            tap(P, T, art, "choisir « Artiste »")
        if not (T.get_by_label("Ton nom", exact=True).input_value() or "").strip():
            type_in(P, T, T.get_by_label("Ton nom", exact=True), "Nina", "son nom")
        tap(P, T, T.get_by_test_id("arrival-join"), "« Rejoindre »")
    wait_for(T, lambda: collab(T, "c.role()") == "artist", 60, step=200, what="Nina de retour")
    P.wait(time.time() - t0)
    T.wait_for_timeout(2000)
    P.m(ses_prises_toujours_la=st(T, f"(d.tracks.find(t => t.id === {json.dumps(tid)}) || {{ clips: [] }}).clips.length") if tid else None,
        meme_piste_qu_avant=bool(tid) and st(T, f"d.tracks.filter(t => t.collabOwnerName === 'Nina' && t.type === 'AUDIO').length") <= 1)
    P.shot(T, "T10c_de_retour")
    P.end()

    # ------------------------------------------------ 11. droits : ce que Nina peut casser chez Max
    P.start("11_droits", "Nina (sans le vouloir) baisse le beat, supprime la « Voix lead » de Max, change le tempo")
    before_e = E.evaluate("() => { const d = window.__novaTest.getState(); return { beat: d.tracks.find(t => t.id === 'instrumental').volume, voix: d.tracks.some(t => t.id === 'voix'), bpm: d.bpm, bus: d.tracks.find(t => t.id === 'bus-voix').volume }; }")
    # a) par l'interface (même chemin que les gestes : setState → détection → collaboration)
    T.evaluate("""() => window.__novaTest.update(d => { const b = d.tracks.find(t => t.id === 'instrumental'); if (b) b.volume = 0.05;
        const bus = d.tracks.find(t => t.id === 'bus-voix'); if (bus) bus.volume = 0.1; d.bpm = 140; d.tracks = d.tracks.filter(t => t.id !== 'voix'); })""")
    E.wait_for_timeout(6000)
    after_ui = E.evaluate("() => { const d = window.__novaTest.getState(); return { beat: d.tracks.find(t => t.id === 'instrumental').volume, voix: d.tracks.some(t => t.id === 'voix'), bpm: d.bpm, bus: d.tracks.find(t => t.id === 'bus-voix').volume }; }")
    P.m(chez_max_avant=before_e, chez_max_apres_gestes_de_nina=after_ui)
    broke = [k for k in before_e if before_e[k] != after_ui[k]]
    if broke:
        P.friction("Nina a modifié la séance de Max : " + ", ".join({"beat": "volume du beat", "voix": "« Voix lead » supprimée", "bpm": "tempo", "bus": "volume du bus voix"}[k] for k in broke))
    check(f"{vp} : les gestes de Nina ne changent pas la séance de Max (beat, bus, voix lead, tempo)", not broke, after_ui)
    # b) opérations FORGÉES (ancienne version, appareil trafiqué) injectées dans le journal au nom de Nina :
    #    la RÉCEPTION chez Max doit les refuser.
    nina_key = next((k[1] for k, v in cloud.members.items() if k[0] == sid and v["name"] == "Nina"), None)
    forged = [("mix", {"trackId": "instrumental", "fields": {"volume": 0.02}}), ("tempo", {"bpm": 150, "timeSignature": {"numerator": 4, "denominator": 4}, "tempoEvents": []}),
              ("track_del", {"trackId": "voix"}), ("mix", {"trackId": "bus-voix", "fields": {"isMuted": True}})]
    for kind, op in forged:
        cloud.seq += 1
        cloud.ops.append({"seq": cloud.seq, "sid": sid, "member_key": nina_key, "role": "artist", "author_name": "Nina", "kind": kind,
                          "op": {**op, "_id": f"forge-{cloud.seq}", "_d": "appareil-trafique"}, "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"), "t": time.time()})
    E.evaluate("() => window.dispatchEvent(new Event('online'))")  # rattrapage tout de suite (sinon ≤ 10 s)
    E.wait_for_timeout(12000)
    after_forged = E.evaluate("() => { const d = window.__novaTest.getState(); const b = d.tracks.find(t => t.id === 'bus-voix'); return { beat: d.tracks.find(t => t.id === 'instrumental').volume, voix: d.tracks.some(t => t.id === 'voix'), bpm: d.bpm, bus_muet: !!(b && b.isMuted) }; }")
    P.m(chez_max_apres_operations_forgees=after_forged)
    forged_ok = after_forged["beat"] == before_e["beat"] and after_forged["voix"] and after_forged["bpm"] == before_e["bpm"] and not after_forged["bus_muet"]
    if not forged_ok:
        P.friction("Des opérations forgées au nom de Nina sont appliquées chez Max (la réception ne vérifie pas les droits de l'invité)")
    check(f"{vp} : opérations forgées au nom de Nina refusées à la RÉCEPTION chez Max", forged_ok, after_forged)
    P.shot(E, "E11_seance_de_max_intacte")
    P.end()

    for k, lg in (("inge", lE), ("artiste", lT)):
        res["erreurs"] += [f"{k}: {e['text'][:160]}" for e in lg.errors()][:8]
        save_log(lg)
    res["parcours"] = P.steps
    res["total"] = {"gestes": sum(s["nb_gestes"] for s in P.steps), "frictions": sum(len(s["frictions"]) for s in P.steps),
                    "attente_s": round(sum(s["attente_s"] for s in P.steps), 1), "duree_s": round(sum(s["duree_s"] for s in P.steps), 1)}
    res["ecritures_bloquees"] = len(getattr(T, "_blocked", [])) + len(getattr(E, "_blocked", []))
    b.close()
    (out / "parcours.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    return res


def run():
    allres = {"phase": PHASE, "url": BASE, "formats": {}}
    ok = True
    with sync_playwright() as p:
        for vp in FORMATS:
            t0 = time.time()
            try:
                r = run_format(p, vp)
            except Exception as e:  # noqa
                import traceback
                r = {"format": vp, "ok": False, "exception": f"{type(e).__name__}: {str(e)[:800]}", "trace": traceback.format_exc()[-2500:]}
            r["duree_totale_s"] = round(time.time() - t0, 1)
            allres["formats"][vp] = r
            ok = ok and r.get("ok", False)
            print(json.dumps({vp: {"ok": r.get("ok"), "total": r.get("total"), "exception": r.get("exception"), "verifications": r.get("verifications")}}, ensure_ascii=False, indent=1))
    allres["ok"] = ok
    (qalib.OUT / "resultat_collab_artiste.json").write_text(json.dumps(allres, ensure_ascii=False, indent=1), encoding="utf-8")
    return allres


if __name__ == "__main__":
    r = run()
    sys.exit(0 if r["ok"] else 1)
