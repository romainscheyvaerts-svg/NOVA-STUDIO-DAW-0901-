"""B3 · Prise envoyée PENDANT l'enregistrement : preuves en réseau bridé (artiste à distance).

Max (ingé son, PC, fibre) ouvre sa séance ; Nina (artiste invitée) la rejoint depuis chez elle. Le réseau de
Nina est bridé : débit MONTANT limité (1 Mb/s par défaut) et latence (80 ms aller-retour), par un « goulot »
qui retarde chaque requête de Nina d'après sa taille (Playwright ne bride pas les requêtes simulées : le goulot
est donc dans le simulateur, voir Shaper). Tout est hors production : serveur NOVA (daw-session), stockage et
Supabase Realtime SIMULÉS (qa/collab_sim.py), comptes simulés, micro simulé (fichier WAV), navigateurs headless.

Scénarios (SCEN=…, séparés par des virgules) :
  longue   : prise de DUREE s (180 par défaut) ; temps entre STOP et prise POSÉE chez Max (son complet, vérifié) ;
  coupure  : coupure réseau de 20 s au milieu d'une prise de 60 s ; la prise arrive complète, au bit près ;
  onglet   : réseau coupé à la fin d'une prise, STOP, onglet de Nina FERMÉ, réseau revenu, onglet rouvert : reprise ;
  reseau   : test de connexion sur 3 profils (fibre, 4G, très faible) : verdict et prédiction ;
  ancien   : Max en ANCIENNE version (sans prise en direct) : il reçoit la prise entière comme avant.
PHASE=avant : les deux navigateurs en « ancienne version » (nova_lt_off=1 : chemin d'envoi d'avant, WAV après STOP).

Usage : NOVA_URL=http://127.0.0.1:3499/ PHASE=apres SCEN=longue,coupure,onglet,reseau,ancien python qa/prise_directe.py
Sorties : D:\\1 WORK\\CONTENU\\nova-prise-directe\\<PHASE>\\ (resultat.json, captures)
"""
import json, os, re, sys, time, wave, io
from pathlib import Path

import numpy as np

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

sys.path.insert(0, str(Path(__file__).parent))
PHASE = os.environ.get("PHASE", "apres")
SCENS = [s for s in os.environ.get("SCEN", "longue,coupure,onglet,reseau,ancien").split(",") if s]
DUREE = float(os.environ.get("DUREE", "180"))
UP_KBPS = float(os.environ.get("UP_KBPS", "1000"))
RTT_MS = float(os.environ.get("RTT_MS", "80"))
STEREO = os.environ.get("STEREO", "1") == "1"
ROOT = Path(os.environ.get("QA_ROOT", r"D:\1 WORK\CONTENU\nova-prise-directe"))
os.environ.setdefault("QA_OUT", str(ROOT / PHASE))
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3499/")
import qalib  # noqa
from qalib import *  # noqa
from gel_pre_effet import prepare  # noqa
from collab_sim import FakeNovaCloud, FakeRealtime, connect, SUPA, STORE  # noqa
from feat_lib import dismiss, collab, open_panel, close_panel, REC_INIT  # noqa
from collab_artiste import seance_project  # noqa

MAX_UID, NINA_UID = "22222222-2222-4222-8222-222222222222", "44444444-4444-4444-8444-444444444444"
FAKE_MIC = ROOT / "micro_voix_48k_stereo.wav"
OUT = Path(os.environ["QA_OUT"])
OUT.mkdir(parents=True, exist_ok=True)


# ------------------------------------------------------------------ micro simulé : une voix (48 kHz, stéréo)

def make_mic(path: Path, seconds=60, sr=48000):
    """Une « voix » chantée : fondamentale qui bouge (vibrato, mélodie), harmoniques, souffle, phrases et silences ;
    canal droit = même voix un peu différente (autre micro de la paire). 16 bits (comme une carte son grand public).
    Le navigateur la rejoue en boucle pendant toute la prise."""
    if path.exists():
        return
    rng = np.random.default_rng(3)
    t = np.arange(int(seconds * sr)) / sr
    notes = 196 * 2 ** (np.array([0, 2, 4, 5, 7, 5, 4, 2]) / 12)
    f0 = notes[(t // 0.6).astype(int) % len(notes)] * (1 + 0.012 * np.sin(2 * np.pi * 5.2 * t))
    ph = 2 * np.pi * np.cumsum(f0) / sr
    phrase = ((t % 4.0) < 3.1).astype(float)
    env = np.convolve(phrase, np.ones(int(0.04 * sr)) / int(0.04 * sr), mode="same")
    v = sum((0.55 / k) * np.sin(k * ph + k * 0.3) for k in range(1, 9)) * env
    breath = rng.normal(0, 0.004, len(t)) * (1 - env)
    room = rng.normal(0, 0.0007, len(t))
    left = 0.42 * v + breath + room
    right = 0.38 * np.roll(v, 24) + breath * 0.8 + rng.normal(0, 0.0007, len(t))
    data = np.stack([left, right], axis=1)
    data = (np.clip(data, -1, 1) * 32767).astype("<i2")
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(data.tobytes())


def launch_mic(p):
    return p.chromium.launch(headless=True, executable_path=CHROME, args=[
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={FAKE_MIC}",
        "--autoplay-policy=no-user-gesture-required",
    ])


# ------------------------------------------------------------------ goulot réseau de Nina (débit montant + latence)

class Shaper:
    """Réseau d'un participant : chaque requête attend que ses octets soient passés dans le débit montant
    (file unique, comme une box), plus la latence ; le serveur simulé ne la traite qu'à ce moment-là.
    `cut` : réseau coupé (requêtes en échec). `drop_every` : une requête sur N perdue (réseau instable)."""

    def __init__(self, up_kbps, rtt_ms, drop_every=0):
        self.set(up_kbps, rtt_ms, drop_every)
        self.free = 0.0
        self.pending = []
        self.cut = False
        self.count = 0
        self.bytes_up = 0

    def set(self, up_kbps, rtt_ms, drop_every=0):
        self.up = up_kbps * 1000 / 8   # octets / s
        self.rtt = rtt_ms / 1000
        self.drop_every = drop_every

    def wrap(self, handler):
        def h(route, request):
            if request.method == "OPTIONS":
                return handler(route, request)
            if self.cut:
                return route.abort("internetdisconnected")
            self.count += 1
            if self.drop_every and self.count % self.drop_every == 0:
                self.pending.append((time.time() + 2.0 + self.rtt, None, route, request))  # perdue : échec après un délai
                return
            n = len(request.post_data_buffer or b"") + 700  # en-têtes
            self.bytes_up += n
            now = time.time()
            start = max(now, self.free)
            self.free = start + n / self.up
            self.pending.append((self.free + self.rtt, handler, route, request))
        return h

    def tick(self):
        now = time.time()
        due = sorted([x for x in self.pending if x[0] <= now], key=lambda x: x[0])
        for it in due:
            self.pending.remove(it)
            _, handler, route, request = it
            try:
                if handler is None or self.cut:
                    route.abort("internetdisconnected" if self.cut else "timedout")
                else:
                    handler(route, request)
            except Exception:
                pass

    def drop_all(self):
        for it in list(self.pending):
            self.pending.remove(it)
            try:
                it[2].abort("internetdisconnected")
            except Exception:
                pass


class Rig:
    def __init__(self, p, lt_off=False, inge_old=False, up=UP_KBPS, rtt=RTT_MS):
        self.p = p
        self.cloud = FakeNovaCloud(per_device=True, codes=True, strict=True)
        self.rt = FakeRealtime()
        self.shaper = Shaper(up, rtt)
        self.b = launch_mic(p)
        self.lt_off = lt_off
        self.inge_old = inge_old or lt_off
        self.logE, self.logT = Log("inge"), Log("artiste")
        self.cE, self.E = new_page(self.b, "pc", self.logE)
        self.E.add_init_script(REC_INIT)
        if self.inge_old:
            self.E.add_init_script("try { localStorage.setItem('nova_lt_off', '1'); } catch (e) {}")
        prepare(self.E, None, desktop=False)
        connect(self.E, self.cloud, self.rt, "E", MAX_UID, "max@test.local")
        self.cT = None
        self.T = None

    def wait(self, sec):
        """Attente qui fait avancer le goulot (les requêtes de Nina partent à leur heure)."""
        end = time.time() + sec
        while True:
            self.shaper.tick()
            left = end - time.time()
            if left <= 0:
                return
            self.E.wait_for_timeout(int(min(25, left * 1000)) or 1)

    def until(self, fn, timeout, what, step=0.1):
        t0 = time.time()
        last = None
        while time.time() - t0 < timeout:
            try:
                v = fn()
                if v:
                    return round(time.time() - t0, 2)
            except Exception as e:  # noqa
                last = e
            self.wait(step)
        raise AssertionError(f"délai dépassé : {what}" + (f" ({last})" if last else ""))

    def open_nina_page(self, storage_ctx=None):
        """Page de Nina (contexte gardé entre deux ouvertures : son appareil, son stockage)."""
        if self.cT is None:
            self.cT, self.T = new_page(self.b, "pc1366", self.logT)
            self.T.add_init_script(REC_INIT)
            if self.lt_off:
                self.T.add_init_script("try { localStorage.setItem('nova_lt_off', '1'); } catch (e) {}")
        else:
            self.T = self.cT.new_page()
            self.T.set_default_timeout(15000)
            self.T.on("console", lambda m: self.logT.add(f"console.{m.type}", m.text) if m.type in ("error", "warning") else None)
            self.T.on("pageerror", lambda e: self.logT.add("pageerror", e))
        prepare(self.T, None, desktop=False)
        connect(self.T, self.cloud, self.rt, "T", NINA_UID, "nina@test.local")
        # Goulot : tout ce que Nina envoie au serveur et au stockage (enregistré APRÈS connect : prioritaire).
        cloud_h = self.cloud.handler("T")
        self.T.route(f"{SUPA}/functions/v1/daw-session", self.shaper.wrap(cloud_h))
        self.T.route(f"{SUPA}/storage/v1/object/upload/sign/**", self.shaper.wrap(self.cloud.upload))
        self.T.route(f"{STORE}/**", self.shaper.wrap(self.cloud.download))
        return self.T

    def cut(self, on: bool):
        self.shaper.cut = on
        if on:
            self.cloud.down.add("T"); self.rt.drop("T"); self.rt.blocked.add("T")
            self.shaper.drop_all()
            try: self.cT.set_offline(True)
            except Exception: pass
        else:
            self.cloud.down.discard("T"); self.rt.blocked.discard("T")
            try: self.cT.set_offline(False)
            except Exception: pass

    def start(self):
        src = OUT / "seance_max.novaproj.zip"
        seance_project(src)
        # Séance en 48 kHz (comme demandé pour la mesure) : même projet, fréquence fixée.
        import zipfile
        with zipfile.ZipFile(src) as z:
            files = {n: z.read(n) for n in z.namelist()}
        proj = json.loads(files["project.json"])
        proj["sampleRate"] = int(os.environ.get("SR", "48000"))
        files["project.json"] = json.dumps(proj).encode()
        with zipfile.ZipFile(src, "w") as z:
            for n, b in files.items():
                z.writestr(n, b)
        E = self.E
        E.goto(BASE, wait_until="domcontentloaded", timeout=180000)
        E.get_by_text("Charger Projet").first.wait_for(timeout=180000)
        from gel_pre_effet import open_project_file
        open_project_file(E, src, {}, "E0_seance")
        dismiss(E); open_panel(E)
        E.get_by_test_id("collab-role").select_option("engineer")
        E.get_by_placeholder("Ton nom (affiché aux autres)").fill("Max")
        E.get_by_role("button", name="Démarrer la collaboration en direct").click()
        self.until(lambda: collab(E, "c.role()") == "engineer", 90, "séance de Max en ligne", 0.3)
        self.wait(1.5)
        self.sid = next(k for k, v in self.cloud.sessions.items() if v["manifest"])
        self.link = collab(E, "c.invite ? c.invite() : null") or f"{BASE}?session={self.sid}.{self.cloud.sessions[self.sid]['secret']}&invite=1"
        close_panel(E)
        T = self.open_nina_page()
        T.goto(self.link, wait_until="domcontentloaded", timeout=180000)
        self.until(lambda: T.get_by_test_id("collab-arrival").count() > 0 or collab(T, "c.role()") == "artist", 120, "carte d'arrivée", 0.2)
        self.wait(1.0); dismiss(T)
        if collab(T, "c.role()") != "artist":
            name = T.get_by_label("Ton nom", exact=True)
            if name.count():
                name.fill("Nina")
            T.get_by_test_id("arrival-join").click()
        self.until(lambda: collab(T, "c.role()") == "artist", 90, "Nina reliée", 0.2)
        self.wait(2.0); dismiss(T)
        # Piste de Nina (créée à son arrivée) ; micro ouvert (entrée stéréo si demandé).
        self.until(lambda: self.nina_track() is not None, 30, "piste de Nina", 0.3)
        tid = self.nina_track()
        if STEREO:
            T.evaluate("(tid) => window.__novaTest.update(d => { const t = d.tracks.find(x => x.id === tid); if (t) t.recordInput = { ch: 0, stereo: true }; })", tid)
            self.wait(0.5)
        self.tid = tid
        return self

    def nina_track(self):
        return self.T.evaluate("""() => { const s = window.__novaTest && window.__novaTest.getState(); const me = window.__novaCollab && window.__novaCollab.me();
          if (!s || !me) return null; const t = s.tracks.find(x => x.type === 'AUDIO' && x.collabOwnerKey === me.key); return t ? t.id : null; }""")

    def clips(self, page, tid):
        return page.evaluate("(tid) => { const t = window.__novaTest.getState().tracks.find(x => x.id === tid); return t ? t.clips.map(c => ({ id: c.id, buf: c.bufferId || null })) : []; }", tid)

    def has_buffer(self, page, bid):
        return page.evaluate("(id) => window.__novaCollab.hasBuffer(id)", bid)

    def timeline(self, t_stop):
        """Ce qui arrive au serveur après le STOP (s) : morceaux, fin, contenu."""
        out = []
        for o in self.cloud.ops:
            if o.get("t", 0) >= t_stop - 0.5 and o["kind"] in ("take_seg", "take_end", "content", "take_ok"):
                extra = [s["i"] for s in o["op"].get("segs", [])] if o["kind"] == "take_seg" else None
                out.append({"op": o["kind"], "s": round(o["t"] - t_stop, 2), **({"morceaux": extra} if extra else {})})
        return out

    def sum(self, page, bid):
        return page.evaluate("(id) => window.__novaCollab.bufferSum(id)", bid)

    def lt(self, page):
        return page.evaluate("() => window.__novaCollab.liveTake()")

    def rec(self):
        T = self.T
        btn = T.get_by_test_id("guest-rec")
        if not btn.count():
            btn = T.get_by_role("button", name=re.compile(r"^(Enregistrer|Arrêter l'enregistrement)$")).locator("visible=true").first
        btn.click()

    def is_recording(self):
        return self.T.evaluate("() => !!window.__novaTest.getState().isRecording")

    def record(self, seconds, during=None):
        """REC, attend `seconds` de prise (during(t) appelé en route), STOP. Renvoie (instant du STOP, ids des clips avant)."""
        before = {c["id"] for c in self.clips(self.T, self.tid)}
        self.rec()
        self.until(lambda: self.is_recording(), 20, "prise lancée", 0.05)
        t0 = time.time()
        while time.time() - t0 < seconds:
            if during:
                during(time.time() - t0)
            self.wait(0.2)
        self.rec()
        t_stop = time.time()
        self.until(lambda: not self.is_recording(), 20, "prise arrêtée", 0.05)
        return t_stop, before

    def new_take(self, before):
        self.until(lambda: any(c["id"] not in before for c in self.clips(self.T, self.tid)), 30, "prise posée chez Nina", 0.1)
        return next(c for c in self.clips(self.T, self.tid) if c["id"] not in before)

    def placed_at_max(self, clip):
        """La prise est POSÉE chez Max : le clip est dans sa piste ET son son est complet dans le registre."""
        ids = {c["id"]: c["buf"] for c in self.clips(self.E, self.tid)}
        return clip["id"] in ids and self.has_buffer(self.E, clip["buf"])

    def close(self, name="journal"):
        try:
            (OUT / f"console_{name}.json").write_text(json.dumps({"inge": self.logE.entries[-200:], "artiste": self.logT.entries[-200:]}, ensure_ascii=False, indent=1), encoding="utf-8")
        except Exception:
            pass
        try: self.b.close()
        except Exception: pass


def shot(page, name):
    try:
        page.screenshot(path=str(OUT / f"{name}.png"))
    except Exception:
        pass


# ------------------------------------------------------------------ scénarios

def sc_longue(p, res):
    rig = Rig(p, lt_off=(PHASE == "avant")).start()
    try:
        r = {"duree_prise_s": DUREE, "debit_montant_kbps": UP_KBPS, "rtt_ms": RTT_MS, "stereo": STEREO}
        seen = {"recv_pendant": 0.0, "peaks": 0}

        def during(t):
            if PHASE != "avant" and int(t * 5) % 25 == 0:
                lt = rig.lt(rig.E)
                for v in lt["recv"]:
                    seen["recv_pendant"] = max(seen["recv_pendant"], v["seconds"])
                    seen["peaks"] = max(seen["peaks"], v["peaks"])
                if 60 < t < 61 and not seen.get("shot"):
                    seen["shot"] = True
                    shot(rig.E, "longue_inge_pendant_la_prise"); shot(rig.T, "longue_artiste_pendant_la_prise")

        rig.shaper.bytes_up = 0
        t_stop, before = rig.record(DUREE, during)
        clip = rig.new_take(before)
        shot(rig.T, "longue_artiste_apres_stop")
        try:
            dt = rig.until(lambda: rig.placed_at_max(clip), 900, "prise posée chez Max", 0.1)
        except AssertionError as e:
            dt = None
            r["erreur"] = str(e)
        r["stop_vers_posee_s"] = round(time.time() - t_stop, 2) if dt is not None else None
        r["octets_envoyes_par_nina"] = rig.shaper.bytes_up
        r["apres_stop"] = rig.timeline(t_stop)
        sT, sE = rig.sum(rig.T, clip["buf"]), (rig.sum(rig.E, clip["buf"]) if dt is not None else None)
        r["artiste"], r["inge"] = sT, sE
        r["identique_au_bit_pres_24_bits"] = bool(sE and sT and sE["sha256"] == sT["sha256"])
        r["reception_pendant_la_prise_s"] = round(seen["recv_pendant"], 1)
        r["forme_d_onde_points_pendant_la_prise"] = seen["peaks"]
        if PHASE != "avant":
            lt = rig.lt(rig.T)
            last = lt["send"][-1] if lt["send"] else None
            r["envoi"] = last
            if last and last.get("framesSent"):
                r["debit_flux_kbps"] = round(last["sent"] * 8 / (last["framesSent"] / last["sr"]) / 1000, 1)
            rig.wait(2.5)
            r["texte_artiste"] = rig.T.get_by_test_id("take-send-status").inner_text() if rig.T.get_by_test_id("take-send-status").count() else None
            shot(rig.T, "longue_artiste_recue")
            shot(rig.E, "longue_inge_posee")
        res["longue"] = r
        return r
    finally:
        rig.close("longue")


def sc_coupure(p, res):
    rig = Rig(p).start()
    try:
        r = {"duree_prise_s": 60, "coupure_s": 20, "debit_montant_kbps": UP_KBPS}
        res["coupure"] = r
        state = {"cut": False, "done": False}

        def during(t):
            if 20 <= t < 40 and not state["cut"]:
                state["cut"] = True; rig.cut(True)
            if t >= 40 and state["cut"] and not state["done"]:
                state["done"] = True
                lt = rig.lt(rig.T)
                r["pendant_la_coupure"] = {"gardes_sur_l_appareil": len(lt["queued"]), "octets": sum(x["bytes"] for x in lt["queued"])}
                r["texte_artiste_coupure"] = rig.T.get_by_test_id("take-send-status").inner_text() if rig.T.get_by_test_id("take-send-status").count() else None
                shot(rig.T, "coupure_artiste_hors_ligne")
                rig.cut(False)

        t_stop, before = rig.record(60, during)
        clip = rig.new_take(before)
        try:
            rig.until(lambda: rig.placed_at_max(clip), 300, "prise posée chez Max", 0.1)
            r["stop_vers_posee_s"] = round(time.time() - t_stop, 2)
        except AssertionError as e:
            r["erreur"] = str(e)
        sT, sE = rig.sum(rig.T, clip["buf"]), rig.sum(rig.E, clip["buf"])
        r["artiste"], r["inge"] = sT, sE
        r["complete_au_bit_pres"] = bool(sE and sT and sE["sha256"] == sT["sha256"] and sE["frames"] == sT["frames"])
        segs = [o for o in rig.cloud.ops if o["kind"] == "take_seg"]
        idx = [s["i"] for o in segs for s in o["op"]["segs"]]
        r["morceaux_annonces"] = len(idx)
        r["morceaux_en_double"] = len(idx) - len(set(idx))
        r["dans_l_ordre"] = idx == sorted(idx)
        rig.wait(2)
        r["texte_artiste_fin"] = rig.T.get_by_test_id("take-send-status").inner_text() if rig.T.get_by_test_id("take-send-status").count() else None
        shot(rig.T, "coupure_artiste_fin"); shot(rig.E, "coupure_inge_fin")
        res["coupure"] = r
        return r
    finally:
        rig.close("coupure")


def sc_onglet(p, res):
    rig = Rig(p).start()
    try:
        r = {"duree_prise_s": 40}
        res["onglet"] = r
        state = {"cut": False}

        def during(t):
            if t >= 24 and not state["cut"]:
                state["cut"] = True; rig.cut(True)

        t_stop, before = rig.record(40, during)
        clip = rig.new_take(before)
        rig.wait(3.0)  # la sauvegarde automatique range la prise, puis Nina ferme l'onglet (réseau toujours coupé)
        lt = rig.lt(rig.T)
        r["avant_fermeture"] = {"gardes_sur_l_appareil": len(lt["queued"]), "fin_comprise": any(x["kind"] == "end" for x in lt["queued"])}
        r["chez_max_avant_reouverture"] = rig.placed_at_max(clip)
        url = rig.T.url
        rig.T.close()
        rig.cut(False)
        rig.wait(3.0)
        r["chez_max_onglet_ferme"] = rig.placed_at_max(clip)
        t_open = time.time()
        T2 = rig.open_nina_page()
        T2.goto(url, wait_until="domcontentloaded", timeout=180000)
        try:
            rig.until(lambda: collab(T2, "c.role()") == "artist", 120, "collaboration reprise", 0.3)
            r["reprise_collab_s"] = round(time.time() - t_open, 1)
        except AssertionError as e:
            r["erreur_reprise"] = str(e)
        dismiss(T2)
        try:
            rig.until(lambda: rig.placed_at_max(clip), float(os.environ.get("ONGLET_MAX", "240")), "prise posée chez Max après réouverture", 0.2)
            r["reouverture_vers_posee_s"] = round(time.time() - t_open, 1)
        except AssertionError as e:
            r["erreur"] = str(e)
            shot(T2, "onglet_artiste_rouvert_echec")
            r["diag_artiste_rouvert"] = T2.evaluate("""(tid) => { const s = window.__novaTest && window.__novaTest.getState(); const t = s && s.tracks.find(x => x.id === tid);
              return { projet: s && s.id, pistes: s && s.tracks.map(x => x.name), clips: t ? t.clips.map(c => c.id) : null, lt: window.__novaCollab && window.__novaCollab.liveTake(),
                texte: document.body.innerText.slice(0, 600) }; }""", rig.tid)
        sE = rig.sum(rig.E, clip["buf"])
        sT = rig.sum(T2, clip["buf"])
        r["artiste"], r["inge"] = sT, sE
        r["complete_au_bit_pres"] = bool(sE and sT and sE["sha256"] == sT["sha256"])
        segs = [o for o in rig.cloud.ops if o["kind"] == "take_seg"]
        idx = [s["i"] for o in segs for s in o["op"]["segs"]]
        r["morceaux_en_double"] = len(idx) - len(set(idx))
        rig.wait(2)
        shot(T2, "onglet_artiste_rouvert"); shot(rig.E, "onglet_inge_fin")
        res["onglet"] = r
        return r
    finally:
        rig.close("onglet")


PROFILS = {
    "fibre": {"up": 20000, "rtt": 15, "drop": 0, "attendu": "parfait"},
    "4G": {"up": 4000, "rtt": 140, "drop": 0, "attendu": "ok"},
    "tres_faible": {"up": 300, "rtt": 600, "drop": 4, "attendu": "faible"},
}


def sc_reseau(p, res):
    rig = Rig(p).start()
    try:
        out = {}
        for name, pr in PROFILS.items():
            rig.shaper.set(pr["up"], pr["rtt"], pr["drop"])
            T = rig.T
            card = T.get_by_test_id("net-test")
            if not card.count():
                out[name] = {"erreur": "bouton absent"}; continue
            card.scroll_into_view_if_needed()
            t0 = time.time()
            T.get_by_test_id("net-test-run").click()
            try:
                rig.until(lambda: T.get_by_test_id("net-test-result").count() > 0 and not T.get_by_test_id("net-test-run").is_disabled(), 120, f"test {name}", 0.2)
            except AssertionError as e:
                out[name] = {"erreur": str(e)}; continue
            level = card.get_attribute("data-level")
            out[name] = {"profil": {"montant_kbps": pr["up"], "rtt_ms": pr["rtt"], "perte": f"1/{pr['drop']}" if pr["drop"] else "0"},
                         "verdict": T.get_by_test_id("net-test-verdict").inner_text(), "niveau": level, "attendu": pr["attendu"], "ok": level == pr["attendu"],
                         "prediction": T.get_by_test_id("net-test-prediction").inner_text(), "duree_test_s": round(time.time() - t0, 1)}
            shot(T, f"reseau_{name}")
        rig.shaper.set(UP_KBPS, RTT_MS, 0)
        # Le même bouton dans le panneau Collaboration de l'ingé.
        open_panel(rig.E)
        out["panneau_inge_bouton"] = rig.E.get_by_test_id("net-test-run").count() > 0
        close_panel(rig.E)
        res["reseau"] = out
        return out
    finally:
        rig.close("reseau")


def sc_ancien(p, res):
    """Max sur une ancienne version (pas de prise en direct) : la prise entière lui arrive comme avant."""
    rig = Rig(p, inge_old=True).start()
    try:
        r = {"duree_prise_s": 20}
        t_stop, before = rig.record(20)
        clip = rig.new_take(before)
        try:
            rig.until(lambda: rig.placed_at_max(clip), 300, "prise reçue par l'ancienne version", 0.2)
            r["stop_vers_posee_s"] = round(time.time() - t_stop, 2)
        except AssertionError as e:
            r["erreur"] = str(e)
        sT, sE = rig.sum(rig.T, clip["buf"]), rig.sum(rig.E, clip["buf"])
        r["artiste"], r["inge"] = sT, sE
        r["recue"] = bool(sE and sE["frames"] == sT["frames"])
        r["envoi_classique_wav"] = any(o["kind"] == "content" and o["op"].get("again") for o in rig.cloud.ops)
        res["ancien"] = r
        return r
    finally:
        rig.close("ancien")


SC = {"longue": sc_longue, "coupure": sc_coupure, "onglet": sc_onglet, "reseau": sc_reseau, "ancien": sc_ancien}


def run():
    make_mic(FAKE_MIC)
    res_path = OUT / "resultat.json"
    res = json.loads(res_path.read_text(encoding="utf-8")) if res_path.exists() else {}
    res["phase"] = PHASE
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        for name in SCENS:
            t0 = time.time()
            try:
                SC[name](p, res)
            except Exception as e:  # noqa
                import traceback
                res[name] = {**(res.get(name) or {}), "exception": f"{e}", "trace": traceback.format_exc()[-1500:]}
            res.setdefault("durees_s", {})[name] = round(time.time() - t0, 1)
            res_path.write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
            print(json.dumps({name: res.get(name)}, ensure_ascii=False, indent=1)[:4000])


if __name__ == "__main__":
    run()
