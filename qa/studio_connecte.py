"""Chantier 17 · Studio Make Music connecté (B6) : télécommande de cabine + « Envoyer au studio ».

1. CABINE. Max (ingé, PC 1600 × 900) ouvre sa séance, arme « Voix lead » (le micro du studio).
   Nina (artiste, téléphone 390 × 844) rejoint comme invitée. Max lui donne la télécommande
   (droit « remote »). Nina passe en mode cabine et pilote REC, STOP, lecture, retour au début.
   Mesures : délai entre le doigt posé sur REC (téléphone) et la prise lancée chez Max
   (objectif ≤ 300 ms), voyant REC au téléphone, décompte, prompteur qui défile.
   Pannes : double appui sur REC, commande forgée en double, réseau coupé au téléphone (rien ne
   part, rien ne part EN RETARD), ingé injoignable, téléphone verrouillé puis rouvert, droit retiré.
2. ENVOYER AU STUDIO. Nina, chez elle (téléphone puis PC), envoie projet + stems + notes
   horodatées + demande de réservation. Le VRAI code de la fonction studio-inbox tourne sur un
   serveur simulé (qa/harness/studio_inbox_serveur.mjs, fausse base en mémoire). Pannes : envoi
   coupé puis repris (seuls les fichiers manquants repartent), double clic sur « Envoyer ».
   Le studio relit sa boîte (studio_list) : paquet reçu, réservation créée.

100 % hors production : Supabase, Realtime, daw-session et studio-inbox simulés ; navigateurs
headless (aucune fenêtre) ; micro simulé. Aucune vraie base, aucune vraie réservation, aucun message.

Usage : NOVA_URL=http://127.0.0.1:3442/ python qa/studio_connecte.py
Sorties : D:\\1 WORK\\CONTENU\\nova-studio-connecte\\qa\\ (captures + resultat.json)
"""
import json, os, re, statistics, subprocess, sys, time, urllib.request, urllib.error
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).parent))
ROOT = Path(os.environ.get("QA_ROOT", r"D:\1 WORK\CONTENU\nova-studio-connecte"))
os.environ.setdefault("QA_OUT", str(ROOT / "qa"))
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3442/")
import qalib  # noqa
from qalib import *  # noqa
from gel_pre_effet import prepare, voice_wav  # noqa
from collab_sim import FakeNovaCloud, FakeRealtime, jwt, connect, SUPA  # noqa
from feat_lib import dismiss, wait_for, collab, open_panel, close_panel, REC_INIT, BASE_T  # noqa
from collab_artiste import beat_wav, launch_rtc  # noqa

MAX_UID, NINA_UID = "22222222-2222-4222-8222-222222222222", "44444444-4444-4444-8444-444444444444"
LYRICS = "\n".join([
    "J'arrive au studio, casque sur les oreilles",
    "Max lance le beat, je pose ma voix",
    "Une prise, deux prises, on garde la meilleure",
    "Le refrain revient, tout le monde chante",
    "Dernière ligne, on coupe et on écoute",
])
RES = {"ok": True, "verifications": {}, "mesures": {}, "captures": [], "erreurs": []}


def check(label, ok, detail=None):
    RES["verifications"][label] = {"ok": bool(ok), **({"detail": detail} if detail is not None else {})}
    print(("OK  " if ok else "KO  ") + label + (f"  ({detail})" if detail is not None and not ok else ""), flush=True)
    if not ok:
        RES["ok"] = False


def snap(page, name):
    p = qalib.OUT / f"{name}.png"
    try:
        page.screenshot(path=str(p))
        RES["captures"].append(p.name)
    except Exception as e:  # noqa
        RES["erreurs"].append(f"capture {name}: {e}")


def project(path: Path):
    """Séance de Max : beat, « Voix lead » ARMÉE (micro du studio), bus voix, paroles, repères et commentaires horodatés."""
    import zipfile
    reg = lambda v: {"v": v, "s": {"t": 1, "c": 0, "by": "u:nina"}}  # noqa
    comments = [
        {"id": "cm1", "authorKey": "u:nina", "authorName": "Nina", "role": "artist", "createdAt": 1, "pos": reg({"t": 12.4, "end": None}),
         "trackId": "voix", "text": reg("le « s » siffle ici"), "status": reg({"s": "open"}), "archived": reg(False), "replies": []},
        {"id": "cm2", "authorKey": "u:max", "authorName": "Max", "role": "engineer", "createdAt": 2, "pos": reg({"t": 4.0, "end": 8.0}),
         "trackId": None, "text": reg("intro : on garde la version 2"), "status": reg({"s": "resolved"}), "archived": reg(False), "replies": []},
    ]
    tracks = [
        {**BASE_T, "id": "instrumental", "name": "Beat", "type": "AUDIO", "color": "#f59e0b", "volume": 0.8, "outputTrackId": "master", "sends": [], "plugins": [],
         "clips": [{"id": "beat1", "name": "Beat", "start": 0, "duration": 16, "offset": 0, "fadeIn": 0, "fadeOut": 0, "color": "#f59e0b", "type": "AUDIO", "audioRef": "audio/beat.wav", "gain": 1}]},
        {**BASE_T, "id": "voix", "name": "Voix lead", "type": "AUDIO", "color": "#22d3ee", "volume": 1.0, "outputTrackId": "bus-voix", "sends": [], "plugins": [],
         "isTrackArmed": True, "comment": "SM7B, préampli à 40 %",
         "clips": [{"id": "t1", "name": "Témoin", "start": 1, "duration": 2, "offset": 1, "fadeIn": 0, "fadeOut": 0, "color": "#22d3ee", "type": "AUDIO", "audioRef": "audio/voix.wav", "gain": 1}]},
        {**BASE_T, "id": "bus-voix", "name": "Bus voix", "type": "BUS", "color": "#a78bfa", "volume": 1.0, "outputTrackId": "master", "sends": [], "plugins": [], "clips": []},
    ]
    state = {
        "id": "proj-studio", "name": "Séance du 13 octobre", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": tracks, "trackGroups": [], "selectedTrackId": "voix", "currentView": "ARRANGEMENT",
        "markers": [{"id": "m1", "name": "Refrain", "time": 8, "type": "REGION", "endTime": 16, "color": "#f43f5e"}],
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0, "recStartTime": None,
        "isDelayCompEnabled": True, "lyrics": LYRICS, "lyricsStart": 0, "lyricsSpeed": 30,
        "projectNotes": {"mix": "Voix devant, reverb courte"}, "timelineComments": comments,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 1, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/voix.wav", voice_wav())
        z.writestr("audio/beat.wav", beat_wav())


def st(page, expr):
    return page.evaluate(f"() => {{ const d = window.__novaTest.getState(); return ({expr}); }}")


# --------------------------------------------------------------------------- serveur simulé du studio

class StudioSim:
    """Le vrai code de supabase/functions/studio-inbox, sur un serveur local simulé (fausse base)."""

    def __init__(self):
        self.proc = subprocess.Popen(["node", str(Path(__file__).parent / "harness" / "studio_inbox_serveur.mjs")],
                                     cwd=str(Path(__file__).parent.parent), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), text=True, encoding="utf-8")
        line = self.proc.stdout.readline()
        m = re.search(r"PORT (\d+)", line or "")
        if not m:
            raise RuntimeError(f"serveur simulé du studio : {line!r}")
        self.base = f"http://127.0.0.1:{m.group(1)}"
        self.fail_uploads = {}  # fragment de chemin → nombre d'échecs à simuler
        self.calls = []
        self.known = set()

    def http(self, method, path, body=None, headers=None):
        req = urllib.request.Request(self.base + path, data=body, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.status, r.read(), dict(r.headers)
        except urllib.error.HTTPError as e:
            return e.code, e.read(), dict(e.headers)

    def user(self, token, uid, email):
        self.http("POST", "/__user", json.dumps({"token": token, "id": uid, "email": email}).encode(), {"content-type": "application/json"})

    def db(self):
        return json.loads(self.http("GET", "/__db")[1])

    def file(self, path):
        s, b, _ = self.http("GET", "/__file?path=" + urllib.request.quote(path))
        return b if s == 200 else None

    def route(self, route, request):
        # Compte simulé : le jeton de la page (faux JWT de collab_sim) est déclaré au serveur simulé.
        auth = request.headers.get("authorization", "")
        if auth.startswith("Bearer ") and auth.count(".") == 2 and auth not in self.known:
            import base64
            try:
                pl = json.loads(base64.urlsafe_b64decode(auth.split(".")[1] + "==").decode())
                self.user(auth[7:], pl["sub"], pl.get("email"))
                self.known.add(auth)
            except Exception:
                pass
        cors = {"access-control-allow-origin": request.headers.get("origin", "*"), "access-control-allow-headers": "*", "access-control-allow-methods": "*"}
        if request.method == "OPTIONS":
            return route.fulfill(status=204, headers=cors)
        u = urlparse(request.url)
        for frag, n in list(self.fail_uploads.items()):
            if "/storage/" in u.path and frag in u.path and n > 0:
                self.fail_uploads[frag] = n - 1
                self.calls.append(("échec simulé", u.path))
                return route.abort("internetdisconnected")
        hdr = {k: v for k, v in request.headers.items() if k.lower() in ("authorization", "content-type", "origin", "apikey", "x-client-info")}
        status, body, rh = self.http(request.method, u.path + (("?" + u.query) if u.query else ""), request.post_data_buffer, hdr)
        self.calls.append((request.method, u.path, status))
        route.fulfill(status=status, body=body, headers={**cors, "content-type": rh.get("Content-Type") or rh.get("content-type") or "application/json"})

    def install(self, page):
        page.route(f"{SUPA}/functions/v1/studio-inbox", self.route)
        page.route(f"{SUPA}/storage/v1/object/upload/sign/studio-packages/**", self.route)

    def close(self):
        try:
            self.proc.kill()
        except Exception:
            pass


# --------------------------------------------------------------------------- mesures

# Chez l'ingé : instant où la prise démarre (état du projet, relevé toutes les 2 ms) ; le début du
# décompte est noté par l'appli elle-même (window.__novaCabin.countIn).
# « Prise lancée » = le moteur audio enregistre (enregistreur créé, micro capté) ; l'écran de l'ingé
# (état du projet) est mesuré à part : il suit au dessin suivant de l'interface.
WATCH_E = """async () => { if (window.__qaW) return; window.__qaW = 1; window.__qa = { rec: [], eng: [], get ci() { return (window.__novaCabin && window.__novaCabin.countIn) || []; } };
  const eng = (await window.__novaAppModule('/engine/AudioEngine.ts')).audioEngine; let was = false, wasE = false;
  setInterval(() => { const d = window.__novaTest && window.__novaTest.getState(); if (!d) return;
    if (d.isRecording && !was) window.__qa.rec.push(Date.now()); was = d.isRecording;
    const on = !!eng.recordingTrackId; if (on && !wasE) window.__qa.eng.push(Date.now()); wasE = on; }, 2); }"""
WATCH_T = """() => { if (window.__qaW) return; window.__qaW = 1; window.__qa = { light: [], count: [] }; let was = false, wasC = false;
  setInterval(() => { const el = document.querySelector('[data-testid=cabin]'); const on = !!el && el.dataset.rec === '1'; const c = !!el && !!el.dataset.count;
    if (on && !was) window.__qa.light.push(Date.now()); was = on; if (c && !wasC) window.__qa.count.push(Date.now()); wasC = c; }, 2); }"""


def stats(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return None
    s = sorted(xs)
    return {"n": len(s), "min": s[0], "mediane": round(statistics.median(s)), "p95": s[min(len(s) - 1, int(round(0.95 * (len(s) - 1))))], "max": s[-1]}


def last_sent(T):
    return T.evaluate("() => { const s = (window.__novaCabin || {}).sent || []; return s[s.length - 1] || null; }")


def txt(page, testid):
    """Texte d'un élément s'il est là (sans attendre : il peut disparaître entre deux lectures)."""
    return page.evaluate("(id) => { const e = document.querySelector('[data-testid=' + id + ']'); return e ? e.innerText : ''; }", testid)


def tap(page, testid):
    page.get_by_test_id(testid).tap(timeout=5000)


def cabin_rec_take(E, T, seconds=1.5, count_in=False, on_rec=None):
    """REC depuis le téléphone, attente de la prise chez Max, STOP depuis le téléphone. Renvoie les délais (ms)."""
    n_rec, n_ci, n_eng = E.evaluate("() => window.__qa.rec.length"), E.evaluate("() => window.__qa.ci.length"), E.evaluate("() => window.__qa.eng.length")
    n_light, n_count = T.evaluate("() => window.__qa.light.length"), T.evaluate("() => window.__qa.count.length")
    n_exec = E.evaluate("() => ((window.__novaCabin || {}).executed || []).length")
    tap(T, "cabin-rec")
    try:
        wait_for(E, lambda: E.evaluate("() => window.__qa.rec.length") > n_rec, 20 if count_in else 8, step=20, what="prise lancée chez Max")
    except AssertionError:
        RES["diag"] = {"telephone": T.evaluate("() => JSON.stringify({ c: window.__novaCabin, cabin: document.querySelector('[data-testid=cabin]')?.innerText })"),
                       "inge": E.evaluate("() => JSON.stringify({ c: window.__novaCabin, qa: window.__qa && window.__qa.rec, rec: window.__novaTest && window.__novaTest.getState().isRecording, rights: window.__novaTest && window.__novaTest.getState().collabGuestRights, txt: document.body.innerText.slice(0, 1500) })")}
        snap(E, "E_diag")
        raise
    wait_for(T, lambda: T.evaluate("() => window.__qa.light.length") > n_light, 8, step=20, what="voyant REC au téléphone")
    s = last_sent(T)
    tap_at = s["tapAt"]
    rec_at = E.evaluate("() => window.__qa.rec[window.__qa.rec.length - 1]")
    engs = E.evaluate(f"() => window.__qa.eng.slice({n_eng})")
    ex = E.evaluate(f"() => ((window.__novaCabin || {{}}).executed || []).slice({n_exec})")
    light_at = T.evaluate("() => window.__qa.light[window.__qa.light.length - 1]")
    out = {"recu_chez_l_inge_ms": (ex[0]["at"] - tap_at) if ex else None, "prise_lancee_ms": (engs[0] - tap_at) if engs else None,
           "ecran_de_l_inge_a_jour_ms": rec_at - tap_at, "voyant_rec_telephone_ms": light_at - tap_at}
    if count_in:
        ci = E.evaluate(f"() => window.__qa.ci.slice({n_ci})")
        cnt = T.evaluate(f"() => window.__qa.count.slice({n_count})")
        out["decompte_chez_l_inge_ms"] = (ci[0] - tap_at) if ci else None
        out["decompte_au_telephone_ms"] = (cnt[0] - tap_at) if cnt else None
    if on_rec:
        on_rec()
    E.wait_for_timeout(int(seconds * 1000))
    wait_for(T, lambda: T.get_by_test_id("cabin-rec").get_attribute("data-cmd") == "stop" and T.get_by_test_id("cabin-rec").is_enabled(), 5, step=50, what="bouton STOP")
    tap(T, "cabin-rec")
    wait_for(E, lambda: not st(E, "d.isRecording"), 10, step=50, what="prise arrêtée chez Max")
    wait_for(T, lambda: T.get_by_test_id("cabin").get_attribute("data-rec") == "0", 8, step=50, what="voyant éteint")
    E.wait_for_timeout(900)
    return out


def voix_clips(E):
    """Prises de la cabine chez Max : sur sa piste « Cabine · Nina » (la « Voix lead » appartient à l'artiste en séance partagée)."""
    return st(E, "d.tracks.filter(t => t.name.startsWith('Cabine')).reduce((n, t) => n + t.clips.length, 0)")


# --------------------------------------------------------------------------- 1. cabine

def part_cabine(p, sim):
    cloud = FakeNovaCloud(per_device=True, codes=True, strict=True)
    rt = FakeRealtime()
    src = qalib.OUT / "00_seance_max.novaproj.zip"
    project(src)
    b = launch_rtc(p)
    lE, lT = Log("inge"), Log("artiste_cabine")
    cE, E = new_page(b, "pc", lE)
    E.add_init_script(REC_INIT)
    prepare(E, None, desktop=False)
    connect(E, cloud, rt, "E", MAX_UID, "max@test.local")
    cT, T = new_page(b, "tel390", lT)
    prepare(T, None, desktop=False)
    connect(T, cloud, rt, "T", NINA_UID, "nina@test.local")

    from gel_pre_effet import open_project_file
    open_project_file(E, src, {}, "E0")
    dismiss(E)
    E.evaluate(WATCH_E)
    open_panel(E)
    E.get_by_test_id("collab-role").select_option("engineer")
    E.get_by_placeholder("Ton nom (affiché aux autres)").fill("Max")
    E.get_by_role("button", name="Démarrer la collaboration en direct").click()
    wait_for(E, lambda: collab(E, "c.role()") == "engineer", 90, what="séance de Max en ligne")
    E.wait_for_timeout(1500)
    sid = next(k for k, v in cloud.sessions.items() if v["manifest"])
    link = collab(E, "c.invite ? c.invite() : null") or f"{BASE}?session={sid}.{cloud.sessions[sid]['secret']}&invite=1"
    close_panel(E)

    # Nina rejoint (téléphone)
    T.goto(link, wait_until="domcontentloaded", timeout=180000)
    wait_for(T, lambda: T.get_by_test_id("collab-arrival").count() > 0 or collab(T, "c.role()") == "artist", 120, step=200, what="arrivée")
    T.wait_for_timeout(1000); dismiss(T)
    if collab(T, "c.role()") != "artist":
        art = T.get_by_test_id("arrival-role-artist")
        if art.count() and not art.locator("input:checked").count() and not T.locator("[data-testid=arrival-role-artist][data-quick='1']").count():
            art.tap()
        if T.get_by_label("Ton nom", exact=True).count():
            T.get_by_label("Ton nom", exact=True).fill("Nina")
        T.get_by_test_id("arrival-join").tap()
    wait_for(T, lambda: collab(T, "c.role()") == "artist", 90, step=200, what="Nina reliée")
    wait_for(T, lambda: T.get_by_test_id("guest-studio").count() > 0, 30, step=200, what="écran de l'artiste")
    T.wait_for_timeout(1500)
    check("Droit décidé par l'ingé : pas de mode cabine tant que Max ne l'a pas permis", T.get_by_test_id("guest-cabin").count() == 0)
    snap(T, "T01_invitee_sans_telecommande")

    # Max donne la télécommande
    open_panel(E)
    E.get_by_test_id("guest-rights-remote").scroll_into_view_if_needed()
    E.get_by_test_id("guest-rights-remote").check()
    t0 = time.time()
    E.wait_for_timeout(300)
    snap(E, "E01_inge_donne_la_telecommande")
    close_panel(E)
    wait_for(T, lambda: T.get_by_test_id("guest-cabin").count() > 0, 20, step=100, what="carte « mode cabine »")
    RES["mesures"]["droit_recu_par_le_telephone_s"] = round(time.time() - t0, 2)
    T.get_by_test_id("guest-cabin").scroll_into_view_if_needed()
    snap(T, "T02_carte_mode_cabine")
    tap(T, "guest-cabin-open")
    wait_for(T, lambda: T.get_by_test_id("cabin").count() > 0 and T.get_by_test_id("cabin").get_attribute("data-link") == "ok", 20, step=100, what="cabine reliée")
    T.evaluate(WATCH_T)
    snap(T, "T03_cabine_prete")

    # Taille des cibles : énormes (casque sur la tête)
    sizes = T.evaluate("""() => ['cabin-rec','cabin-play','cabin-home','cabin-talk','cabin-close'].map(id => { const r = document.querySelector(`[data-testid=${id}]`).getBoundingClientRect(); return [id, Math.round(r.width), Math.round(r.height)]; })""")
    RES["mesures"]["cibles_px"] = sizes
    check("Boutons de la cabine : REC ≥ 120 px, les autres ≥ 48 px", sizes[0][1] >= 120 and sizes[0][2] >= 120 and all(min(w, h) >= 48 for _, w, h in sizes), sizes)
    over = T.evaluate("() => document.documentElement.scrollWidth > innerWidth + 1")
    check("Cabine au téléphone 390 px : aucun débordement horizontal", not over)

    # 1re prise : le micro du studio s'ouvre (mesurée à part)
    before = voix_clips(E)
    seen = {}

    def on_rec():
        E.wait_for_timeout(250)
        seen["txt"] = E.evaluate("() => document.body.innerText")
        snap(E, "E02_inge_notification_cabine")
    warm = cabin_rec_take(E, T, 1.2, on_rec=on_rec)
    RES["mesures"]["premiere_prise_micro_a_ouvrir"] = warm
    check("L'ingé voit la prise de la cabine en cours, sur sa piste « Cabine · Nina »", "Cabine · Nina" in seen.get("txt", "") and "Enregistrement" in seen.get("txt", ""), seen.get("txt", "")[-300:])

    # Délai REC : 12 prises, décompte coupé
    trials = []
    for i in range(12):
        trials.append(cabin_rec_take(E, T, 1.0))
    RES["mesures"]["rec_depuis_le_telephone"] = {
        "essais": trials,
        "doigt_vers_commande_recue_ms": stats([t["recu_chez_l_inge_ms"] for t in trials]),
        "doigt_vers_prise_lancee_ms": stats([t["prise_lancee_ms"] for t in trials]),
        "doigt_vers_ecran_de_l_inge_ms": stats([t["ecran_de_l_inge_a_jour_ms"] for t in trials]),
        "doigt_vers_voyant_rec_telephone_ms": stats([t["voyant_rec_telephone_ms"] for t in trials]),
    }
    lat = RES["mesures"]["rec_depuis_le_telephone"]["doigt_vers_prise_lancee_ms"]
    check("REC lancé depuis le téléphone en ≤ 300 ms (le moteur de Max enregistre ; pire des 12 essais)", lat and lat["n"] == 12 and lat["max"] <= 300, lat)
    light = RES["mesures"]["rec_depuis_le_telephone"]["doigt_vers_voyant_rec_telephone_ms"]
    check("Voyant REC allumé au téléphone en ≤ 500 ms (pire des 12 essais)", light and light["max"] <= 500, light)
    after = voix_clips(E)
    check("13 prises posées chez Max, sur sa piste « Cabine · Nina » (1 + 12)", after - before == 13, after - before)
    RES["mesures"]["piste_de_la_cabine"] = st(E, "(() => { const t = d.tracks.find(t => t.name.startsWith('Cabine')); return t ? { nom: t.name, proprietaire: t.collabOwnerName, sortie: t.outputTrackId, prises: t.clips.length } : null; })()")
    # La prise arrive aussi chez Nina (séance partagée), sur la même piste.
    try:
        wait_for(T, lambda: st(T, "d.tracks.filter(t => t.name.startsWith('Cabine')).reduce((n, t) => n + t.clips.length, 0)") >= after, 30, step=300, what="prises chez Nina")
        check("Les prises de la cabine arrivent aussi dans la séance de Nina", True)
    except AssertionError as e:
        check("Les prises de la cabine arrivent aussi dans la séance de Nina", False, str(e))

    # Prompteur : défile pendant la prise, au rythme de la lecture de Max
    tap(T, "cabin-rec")
    wait_for(E, lambda: st(E, "d.isRecording"), 8, step=20, what="prise (prompteur)")
    T.wait_for_timeout(500)
    l1 = T.get_by_test_id("cabin-line").inner_text()
    snap(T, "T04_voyant_rec_et_paroles")
    T.wait_for_timeout(4200)
    l2 = T.get_by_test_id("cabin-line").inner_text()
    snap(T, "T05_paroles_qui_defilent")
    check("Prompteur : la ligne en cours change avec la lecture de Max", l1 != l2 and l1 in LYRICS and l2 in LYRICS, [l1, l2])
    tap(T, "cabin-rec")
    wait_for(E, lambda: not st(E, "d.isRecording"), 10, step=50, what="stop")
    E.wait_for_timeout(1000)

    # Décompte (1 mesure chez Max)
    E.evaluate("() => localStorage.setItem('nova_count_in', '1')")
    n_cnt = T.evaluate("() => window.__qa.count.length")
    n_rec = E.evaluate("() => window.__qa.rec.length")
    tap(T, "cabin-rec")
    tap_at = None
    try:
        wait_for(T, lambda: T.get_by_test_id("cabin-countdown").count() > 0, 6, step=20, what="décompte au téléphone")
        snap(T, "T06_decompte")
        digits = set()
        t_end = time.time() + 4
        while time.time() < t_end and not st(E, "d.isRecording"):
            d = T.evaluate("() => { const p = document.querySelector('[data-testid=cabin-countdown] p'); return p ? p.textContent.trim() : null; }")
            if d:
                digits.add(d)
            T.wait_for_timeout(60)
        tap_at = last_sent(T)["tapAt"]
        ci_t = T.evaluate(f"() => window.__qa.count.slice({n_cnt})")
        e_ci = E.evaluate("() => window.__qa.ci[window.__qa.ci.length - 1] || null")
        wait_for(E, lambda: E.evaluate("() => window.__qa.rec.length") > n_rec, 10, step=20, what="prise après décompte")
        rec_at = E.evaluate("() => window.__qa.rec[window.__qa.rec.length - 1]")
        RES["mesures"]["decompte"] = {"chiffres_vus_au_telephone": sorted(digits), "doigt_vers_decompte_telephone_ms": (ci_t[0] - tap_at) if ci_t else None,
                                      "doigt_vers_decompte_chez_l_inge_ms": (e_ci - tap_at) if e_ci else None, "doigt_vers_prise_ms": rec_at - tap_at}
        check("Décompte de Max affiché en grand au téléphone (≥ 2 chiffres)", len(digits) >= 2, sorted(digits))
    except AssertionError as e:
        check("Décompte de Max affiché en grand au téléphone (≥ 2 chiffres)", False, str(e))
    T.wait_for_timeout(800)
    tap(T, "cabin-rec")
    wait_for(E, lambda: not st(E, "d.isRecording"), 10, step=50, what="stop")
    E.evaluate("() => localStorage.setItem('nova_count_in', '0')")
    E.wait_for_timeout(1000)

    # Lecture, retour au début
    tap(T, "cabin-play")
    wait_for(E, lambda: st(E, "d.isPlaying"), 5, step=20, what="lecture lancée")
    T.wait_for_timeout(2500)
    snap(T, "T07_lecture")
    tap(T, "cabin-home")
    T.wait_for_timeout(600)
    pos = T.get_by_test_id("cabin-status").inner_text()
    tap(T, "cabin-play")  # ■ Stop
    wait_for(E, lambda: not st(E, "d.isPlaying"), 5, step=20, what="lecture arrêtée")
    check("Lecture, retour au début et Stop pilotés depuis le téléphone", "0:0" in pos, pos)
    E.wait_for_timeout(600)

    # Double appui sur REC (même image) : une seule commande part
    n_sent = T.evaluate("() => window.__novaCabin.sent.length")
    n_exec = E.evaluate("() => window.__novaCabin.executed.length")
    before = voix_clips(E)
    T.evaluate("""() => { const b = document.querySelector('[data-testid=cabin-rec]'); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); b.click(); b.click(); }""")
    wait_for(E, lambda: st(E, "d.isRecording"), 8, step=20, what="prise (double appui)")
    E.wait_for_timeout(700)
    sent2 = T.evaluate("() => window.__novaCabin.sent.length") - n_sent
    # Commande forgée en double (deux téléphones, ancienne version) : la protection de l'ingé tient seule.
    T.evaluate("() => { window.__novaCabin.forceSend('rec'); window.__novaCabin.forceSend('rec'); }")
    E.wait_for_timeout(1200)
    still = st(E, "d.isRecording")
    execd = E.evaluate("() => window.__novaCabin.executed.length") - n_exec
    tap(T, "cabin-rec")
    wait_for(E, lambda: not st(E, "d.isRecording"), 10, step=50, what="stop")
    E.wait_for_timeout(1000)
    check("Double appui sur REC : une seule commande part du téléphone", sent2 == 1, sent2)
    check("REC reçu 3 fois (double appui + 2 forgés) : une seule prise, jamais arrêtée par erreur", execd == 1 and still and voix_clips(E) - before == 1, {"executees": execd, "toujours_en_prise": still})

    # Réseau coupé au téléphone : rien ne part, rien ne part EN RETARD
    cloud.down.add("T"); rt.drop("T"); rt.blocked.add("T")
    T.context.set_offline(True)
    T.evaluate("() => window.dispatchEvent(new Event('offline'))")
    T.wait_for_timeout(1200)
    blocked = txt(T, "cabin-blocked")
    rec_disabled = not T.get_by_test_id("cabin-rec").is_enabled()
    snap(T, "T08_reseau_coupe")
    T.evaluate("() => window.__novaCabin.forceSend('rec')")
    T.wait_for_timeout(1500)
    cloud.down.discard("T"); rt.blocked.discard("T")
    T.context.set_offline(False)
    T.evaluate("() => window.dispatchEvent(new Event('online'))")
    t0 = time.time()
    wait_for(T, lambda: T.get_by_test_id("cabin").get_attribute("data-link") == "ok" and T.get_by_test_id("cabin-rec").is_enabled(), 40, step=100, what="cabine reliée de nouveau")
    RES["mesures"]["retour_du_reseau_telephone_s"] = round(time.time() - t0, 1)
    E.wait_for_timeout(5000)
    late = st(E, "d.isRecording")
    check("Réseau coupé au téléphone : message clair, REC coupé", "Pas de réseau" in blocked and rec_disabled, blocked)
    check("Commande tapée hors ligne : jamais exécutée plus tard, au retour du réseau", not late)
    r = cabin_rec_take(E, T, 1.0)
    check("Après le retour du réseau, REC remarche", r["prise_lancee_ms"] is not None)

    # Max injoignable : le téléphone ne lance rien sans liaison sûre
    rt.drop("E"); rt.blocked.add("E")
    try:
        wait_for(T, lambda: T.get_by_test_id("cabin-blocked").count() > 0 and not T.get_by_test_id("cabin-rec").is_enabled(), 20, step=200, what="liaison perdue")
        lost = T.get_by_test_id("cabin-blocked").inner_text()
        snap(T, "T09_inge_injoignable")
        check("Max injoignable : boutons coupés, raison claire, « Réessayer » proposé",
              ("perdue" in lost or "pas dans la séance" in lost) and T.get_by_test_id("cabin-retry").count() == 1, lost)
        T.evaluate("() => window.__novaCabin.forceSend('rec')")
    except AssertionError as e:
        check("Max injoignable : « Liaison perdue », boutons coupés, « Réessayer » proposé", False, str(e))
    rt.blocked.discard("E")
    E.evaluate("() => window.dispatchEvent(new Event('online'))")
    t0 = time.time()
    wait_for(T, lambda: T.get_by_test_id("cabin").get_attribute("data-link") == "ok" and T.get_by_test_id("cabin-rec").is_enabled(), 60, step=200, what="Max de retour")
    RES["mesures"]["retour_de_l_inge_s"] = round(time.time() - t0, 1)
    E.wait_for_timeout(4000)
    check("Commande envoyée pendant que Max était injoignable : jamais exécutée à son retour", not st(E, "d.isRecording"))

    # Téléphone verrouillé (page cachée, liaison coupée) puis rouvert
    T.evaluate("""() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); }""")
    rt.drop("T"); rt.blocked.add("T")
    T.wait_for_timeout(8000)
    rt.blocked.discard("T")
    T.evaluate("""() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); }""")
    t0 = time.time()
    wait_for(T, lambda: T.get_by_test_id("cabin").get_attribute("data-link") == "ok" and T.get_by_test_id("cabin-rec").is_enabled(), 60, step=100, what="cabine reliée après déverrouillage")
    RES["mesures"]["telephone_rouvert_relie_en_s"] = round(time.time() - t0, 1)
    snap(T, "T10_telephone_rouvert")
    r = cabin_rec_take(E, T, 1.0)
    check("Téléphone verrouillé 8 s puis rouvert : la cabine se relie seule et REC remarche", r["prise_lancee_ms"] is not None, r)
    RES["mesures"]["rec_apres_deverrouillage_ms"] = r

    # Max retire la télécommande
    open_panel(E)
    E.get_by_test_id("guest-rights-remote").scroll_into_view_if_needed()
    E.get_by_test_id("guest-rights-remote").uncheck()
    close_panel(E)
    try:
        wait_for(T, lambda: not T.get_by_test_id("cabin-rec").is_enabled(), 15, step=100, what="télécommande retirée")
        why = txt(T, "cabin-blocked")
        snap(T, "T11_telecommande_retiree")
        check("Max retire la télécommande : boutons coupés, l'artiste sait pourquoi", "pas activé" in why, why)
    except AssertionError as e:
        check("Max retire la télécommande : boutons coupés, l'artiste sait pourquoi", False, str(e))
    T.evaluate("() => window.__novaCabin.forceSend('rec')")
    E.wait_for_timeout(1500)
    check("Commande forgée après le retrait du droit : refusée chez Max", not st(E, "d.isRecording"))

    # Vue de l'ingé au bureau
    open_panel(E)
    E.get_by_test_id("guest-rights-remote").scroll_into_view_if_needed()
    snap(E, "E03_inge_reglage_telecommande")
    close_panel(E)

    for k, lg in (("inge", lE), ("artiste", lT)):
        RES["erreurs"] += [f"{k}: {e['text'][:160]}" for e in lg.errors()][:8]
        save_log(lg)
    RES["ecritures_bloquees"] = len(getattr(T, "_blocked", [])) + len(getattr(E, "_blocked", []))
    b.close()


# --------------------------------------------------------------------------- 2. envoyer au studio

def open_send(page, phone):
    if phone:
        page.get_by_role("button", name=re.compile("Ouvrir le menu")).first.tap()
        page.wait_for_timeout(500)
        page.get_by_test_id("menu-send-studio").scroll_into_view_if_needed()
        page.get_by_test_id("menu-send-studio").tap()
    else:
        page.keyboard.press("Control+k")
        page.wait_for_timeout(400)
        page.keyboard.type("Envoyer au studio")
        page.wait_for_timeout(400)
        page.keyboard.press("Enter")
    wait_for(page, lambda: page.get_by_test_id("studio-send").count() > 0, 15, step=100, what="fenêtre « Envoyer au studio »")


def part_envoi(p, sim, vp, fail=False):
    phone = vp == "tel390"
    cloud, rt = FakeNovaCloud(), FakeRealtime()
    src = qalib.OUT / "00_seance_max.novaproj.zip"
    b = launch(p)
    lg = Log(f"envoi_{vp}")
    ctx, S = new_page(b, vp, lg)
    prepare(S, None, desktop=False)
    connect(S, cloud, rt, "S", NINA_UID, "nina@test.local")
    sim.install(S)
    from gel_pre_effet import open_project_file
    open_project_file(S, src, {}, "S0")
    dismiss(S)
    S.wait_for_timeout(800)
    open_send(S, phone)
    S.wait_for_timeout(800)
    snap(S, f"S{vp}_1_formulaire")
    preview = txt(S, "studio-notes-preview")
    check(f"{vp} : aperçu des notes horodatées (commentaire à 0:12,4, repère du refrain)", "0:12,4" in preview and "Refrain" in preview, preview)
    S.get_by_test_id("studio-slot-soir").click()
    S.get_by_role("button", name="Une heure de plus").click()
    S.get_by_test_id("studio-name").fill("Nina")
    S.get_by_test_id("studio-phone").fill("+32 470 12 34 56")
    S.get_by_test_id("studio-message").fill("On refait le refrain, je viens avec un feat")
    # Erreur actionnable : jour passé
    good_date = S.get_by_test_id("studio-date").input_value()
    n_before = len(sim.calls)
    S.get_by_test_id("studio-date").fill("2020-01-01")
    S.get_by_test_id("studio-send-go").click()
    S.wait_for_timeout(400)
    err = txt(S, "studio-err-date")
    check(f"{vp} : jour passé refusé avec une phrase claire, rien n'est parti", "déjà passé" in err and len(sim.calls) == n_before, err)
    S.get_by_test_id("studio-date").fill(good_date)
    if fail:
        sim.fail_uploads[".flac"] = 3  # le 1er stem coupé 3 fois de suite (les 3 essais de NOVA)
    n_calls = len(sim.calls)
    t0 = time.time()
    # Double clic sur « Envoyer au studio » : un seul paquet
    S.evaluate("() => { const b = document.querySelector('[data-testid=studio-send-go]'); b.click(); b.click(); }")
    if fail:
        wait_for(S, lambda: S.get_by_test_id("studio-error").count() > 0, 120, step=200, what="envoi coupé")
        msg = S.get_by_test_id("studio-error").inner_text()
        snap(S, f"S{vp}_2_envoi_coupe")
        check(f"{vp} : envoi coupé → message clair et « Réessayer » (reprend où ça s'est arrêté)",
              "Réessayer" in S.get_by_test_id("studio-send-go").inner_text() and "reprend" in msg, msg)
        S.get_by_test_id("studio-send-go").click()
    try:
        wait_for(S, lambda: S.get_by_test_id("studio-done").count() > 0, 180, step=250, what="reçu par le studio")
    except AssertionError as e:
        snap(S, f"S{vp}_x_echec")
        raise
    secs = round(time.time() - t0, 1)
    ref = S.get_by_test_id("studio-ref").inner_text()
    snap(S, f"S{vp}_3_recu_par_le_studio")
    calls = sim.calls[n_calls:]
    inits = [c for c in calls if len(c) > 2 and c[1].endswith("studio-inbox")]
    db = sim.db()
    pk = [x for x in db["tables"].get("studio_packages", []) if x["status"] == "recu"]
    pkg = pk[-1] if pk else None
    bk = [x for x in db["tables"].get("studio_booking_requests", []) if pkg and x["package_id"] == pkg["id"]]
    uploads = [c[1] for c in calls if len(c) > 2 and "/storage/" in c[1] and c[2] == 200]
    dup = [u for u in set(uploads) if uploads.count(u) > 1]
    RES["mesures"][f"envoi_{vp}"] = {"duree_s": secs, "reference": ref, "fichiers": len(pkg["files"]) if pkg else None,
                                    "octets": pkg["total_bytes"] if pkg else None, "appels_fonction": len(inits),
                                    "fichiers_envoyes_deux_fois": dup, "echecs_simules": [c for c in calls if c[0] == "échec simulé"][:5]}
    check(f"{vp} : paquet reçu par le studio (statut « reçu »), réservation créée (« demande »)", bool(pkg) and len(bk) == 1 and bk[0]["status"] == "demande", {"paquet": bool(pkg), "reservations": len(bk)})
    if pkg:
        kinds = [f["kind"] for f in pkg["files"]]
        check(f"{vp} : projet + stems + notes dans le paquet", kinds.count("projet") == 1 and kinds.count("stem") >= 2 and kinds.count("notes") == 2, kinds)
        stored = db["storage"].get("studio-packages", {})
        check(f"{vp} : chaque fichier est au studio, à la bonne taille", all(stored.get(f["path"]) == f["size"] for f in pkg["files"]))
        proj = next(f for f in pkg["files"] if f["kind"] == "projet")
        stem = next(f for f in pkg["files"] if f["kind"] == "stem")
        notes = next(f for f in pkg["files"] if f["name"] == "Notes.txt")
        pz, sz, nz = sim.file(proj["path"]), sim.file(stem["path"]), (sim.file(notes["path"]) or b"").decode("utf-8", "replace")
        check(f"{vp} : projet lisible (zip) et stems FLAC", pz[:2] == b"PK" and sz[:4] == b"fLaC")
        check(f"{vp} : notes horodatées pour l'ingé (commentaire, repère, consigne de piste, réservation)",
              "[0:12,4] Nina (Voix lead) : le « s » siffle ici" in nz and "Repère : Refrain" in nz and "SM7B" in nz and "Demande : Enregistrement" in nz, nz[:400])
        (qalib.OUT / f"notes_recues_{vp}.txt").write_text(nz, encoding="utf-8")
        b0 = bk[0] if bk else {}
        check(f"{vp} : réservation conforme (soir, 3 h, Nina, téléphone, message)",
              b0.get("slot") == "soir" and b0.get("hours") == 3 and b0.get("artist_name") == "Nina" and b0.get("phone") == "+32 470 12 34 56" and "refrain" in (b0.get("message") or ""), b0)
    check(f"{vp} : double clic sur « Envoyer » → un seul paquet ouvert", sum(1 for x in db["log"] if x.get("action") == "package_init") == RES.setdefault("_inits", 0) + 1,
          [x.get("action") for x in db["log"]])
    RES["_inits"] = sum(1 for x in db["log"] if x.get("action") == "package_init")
    if fail:
        check(f"{vp} : reprise après coupure : aucun fichier déjà arrivé n'est renvoyé", not dup, dup)
    over = S.evaluate("() => document.documentElement.scrollWidth > innerWidth + 1")
    check(f"{vp} : fenêtre sans débordement horizontal", not over)
    RES["erreurs"] += [f"envoi {vp}: {e['text'][:160]}" for e in lg.errors()][:8]
    save_log(lg)
    RES["ecritures_bloquees"] = RES.get("ecritures_bloquees", 0) + len(getattr(S, "_blocked", []))
    b.close()


def part_boite_du_studio(sim):
    tok = jwt("99999999-9999-4999-8999-999999999999", "studio@makemusic.test")
    sim.user(tok, "99999999-9999-4999-8999-999999999999", "studio@makemusic.test")
    s, body, _ = sim.http("POST", "/functions/v1/studio-inbox", json.dumps({"action": "studio_list"}).encode(),
                          {"content-type": "application/json", "authorization": f"Bearer {tok}", "origin": BASE.rstrip("/")})
    box = json.loads(body)
    pk = box.get("packages", [])
    RES["boite_du_studio"] = [{"titre": x["title"], "de": x["from"], "fichiers": [f["name"] for f in x["files"]],
                               "reservation": x["booking"]} for x in pk]
    check("Boîte du studio : les paquets reçus, avec la réservation et des liens de téléchargement", s == 200 and len(pk) >= 2 and all(x["booking"] and all(f["url"] for f in x["files"]) for x in pk), s)
    nina = jwt(NINA_UID, "nina@test.local")
    sim.user(nina, NINA_UID, "nina@test.local")
    s2, _, _ = sim.http("POST", "/functions/v1/studio-inbox", json.dumps({"action": "studio_list"}).encode(), {"content-type": "application/json", "authorization": f"Bearer {nina}"})
    check("Boîte du studio fermée à l'artiste (403)", s2 == 403, s2)


def run():
    sim = StudioSim()
    RES["serveur_simule"] = sim.base
    try:
        with sync_playwright() as p:
            parts = (("cabine", lambda: part_cabine(p, sim)),
                     ("envoi_telephone", lambda: part_envoi(p, sim, "tel390", fail=True)),
                     ("envoi_bureau", lambda: part_envoi(p, sim, "pc")))
            only = [x for x in os.environ.get("QA_PARTIES", "").split(",") if x]
            for name, fn in parts:
                if only and name not in only:
                    continue
                t0 = time.time()
                try:
                    fn()
                except Exception as e:  # noqa
                    import traceback
                    RES["ok"] = False
                    RES.setdefault("exceptions", {})[name] = f"{type(e).__name__}: {str(e)[:600]}\n{traceback.format_exc()[-1500:]}"
                    print("EXCEPTION", name, e, flush=True)
                RES.setdefault("durees_s", {})[name] = round(time.time() - t0, 1)
            if not only or "envoi_bureau" in only:
                part_boite_du_studio(sim)
    finally:
        sim.close()
    RES.pop("_inits", None)
    (qalib.OUT / "resultat.json").write_text(json.dumps(RES, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({"ok": RES["ok"], "mesures": {k: v for k, v in RES["mesures"].items() if k != "rec_depuis_le_telephone"},
                      "rec": {k: v for k, v in RES["mesures"].get("rec_depuis_le_telephone", {}).items() if k != "essais"}}, ensure_ascii=False, indent=1))
    return RES


if __name__ == "__main__":
    r = run()
    sys.exit(0 if r["ok"] else 1)
