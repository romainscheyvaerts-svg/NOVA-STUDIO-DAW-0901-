"""Lien d'écoute client SANS COMPTE (chantier 12 · B5) : de bout en bout, mesuré.

Deux navigateurs headless (aucune fenêtre), 100 % hors production :
  E = Max, ingé son (PC 1600 × 900), compte simulé ;
  C = le client (label, artiste, manager) : TÉLÉPHONE 390 × 844, contexte VIERGE
      (navigation privée : aucun stockage, aucun compte, aucune session).
Serveur NOVA (daw-session), fonction daw-listen et Supabase Realtime SIMULÉS
(qa/collab_sim.py, qa/listen_sim.py, qa/qa_hors_prod.py) ; WebRTC RÉEL entre les deux pages.

Déroulé :
  1. Max ouvre la séance « Test stéréo » (gauche 440 Hz, droite 660 Hz, multiton),
     démarre la collaboration (ingé), crée un lien d'écoute (7 jours, direct +
     versions + commentaires), le copie (bouton Copier, QR code affiché) ;
  2. une version envoyée et des commentaires existent dans la séance (journal) ;
  3. Max diffuse son mix aux clients et lance la lecture ;
  4. le client ouvre le lien sur son téléphone : page légère (sans le DAW),
     « En direct », grand bouton « Écouter » → mesures : premier son reçu après
     le clic (≤ 2 s exigé), stéréo (séparation ≥ 30 dB), débit (≈ 512 kb/s),
     codec Opus 2 canaux ; versions et commentaires affichés ; une version s'écoute ;
  5. lecture seule : toute écriture avec le jeton est refusée (daw-listen 403,
     daw-session 404), journal et séance inchangés ; aucun champ de saisie sur la page ;
  6. révocation en un clic : la page ouverte perd le son et affiche « désactivé » ;
     réouverture refusée ;
  7. lien expiré : refusé avec un message clair ; lien protégé : mot de passe demandé ;
     lien incomplet : message clair.

Usage : NOVA_URL=http://127.0.0.1:3433/ PASSE=1 python qa/lien_ecoute.py
Sorties : D:\\1 WORK\\CONTENU\\nova-lien-ecoute\\passe_<PASSE>\\
"""
import hashlib, json, math, os, re, struct, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
PASSE = os.environ.get("PASSE", "1")
os.environ["QA_OUT"] = os.environ.get("QA_OUT") or rf"D:\1 WORK\CONTENU\nova-lien-ecoute\passe_{PASSE}"
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3433/")
import qalib  # noqa
from qalib import *  # noqa
import mix_direct_stereo as mds  # noqa
from gel_pre_effet import prepare, open_project_file  # noqa
from collab_sim import FakeNovaCloud, FakeRealtime, connect, SUPA, STORE  # noqa
from listen_sim import FakeListen  # noqa
from feat_lib import dismiss, wait_for, collab, open_panel, close_panel, REC_INIT  # noqa

MAX = "22222222-2222-4222-8222-222222222222"
mds.DUREE = 60
FIRST_SOUND_MAX_MS = 2000

# Premier son reçu chez le client, mesuré depuis l'appui sur « Écouter » (pointerdown).
FIRST_SOUND_JS = """() => {
  window.__qaClick = null;
  const mark = (e) => { if (window.__qaClick == null && e.target && e.target.closest && e.target.closest('[data-testid=listen-play]')) window.__qaClick = performance.now(); };
  document.addEventListener('pointerdown', mark, true); document.addEventListener('click', mark, true);
  window.__qaFirst = new Promise((res) => {
    const t0 = performance.now(); let ctx = null, an = null, buf = null, seen = null;
    const loop = () => {
      const el = document.querySelector('audio[data-listen-audio="mix"]'); const st = el && el.srcObject;
      if (st && st !== seen && st.getAudioTracks && st.getAudioTracks().length) { seen = st;
        try { ctx = ctx || new AudioContext({ sampleRate: 48000 }); ctx.resume(); const s = ctx.createMediaStreamSource(st); an = ctx.createAnalyser(); an.fftSize = 1024; s.connect(an); buf = new Float32Array(an.fftSize); } catch (e) {} }
      if (an) { an.getFloatTimeDomainData(buf); let e = 0; for (let i = 0; i < buf.length; i++) e += buf[i] * buf[i];
        if (e / buf.length > 1e-5) { const t = performance.now(); try { ctx.close(); } catch (x) {}
          return res({ ms_depuis_clic: window.__qaClick != null ? Math.round(t - window.__qaClick) : null, rms_dbfs: +(10 * Math.log10(e / buf.length)).toFixed(1), flux_recu_ms: null }); } }
      if (performance.now() - t0 > 20000) return res({ erreur: 'pas de son en 20 s', clic: window.__qaClick != null });
      setTimeout(loop, 5); };
    loop(); });
  return true; }"""

LOAD_JS = """() => { const nav = performance.getEntriesByType('navigation')[0] || {};
  const res = performance.getEntriesByType('resource').map(r => new URL(r.name).pathname);
  return { dom_pret_ms: Math.round(nav.domContentLoadedEventEnd || 0), charge_ms: Math.round(nav.loadEventEnd || 0),
    modules: res.length, daw_charge: res.filter(p => /\\/(App\\.tsx|engine\\/AudioEngine\\.ts|components\\/ArrangementView)/.test(p)),
    champs_saisie: document.querySelectorAll('input, textarea, select, [contenteditable=true]').length,
    boutons: Array.from(document.querySelectorAll('button')).filter(b => b.getClientRects().length).map(b => (b.innerText || b.getAttribute('aria-label') || '').trim().slice(0, 40)) }; }"""

# Tentatives d'écriture faites DEPUIS la page du client, avec son jeton (comme le ferait un client malveillant).
WRITE_JS = """async ({ token, sid, supa }) => {
  const post = async (fn, body) => { try { const r = await fetch(`${supa}/functions/v1/${fn}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (e) {} return { fn, action: body.action, statut: r.status, code: j && j.code || null, erreur: j && j.error || null }; } catch (e) { return { fn, action: body.action, statut: 0, erreur: String(e) }; } };
  const out = [];
  for (const action of ['listen_create', 'listen_revoke', 'listen_list', 'op', 'commit', 'comment', 'decide'])
    out.push(await post('daw-listen', { action, token, id: sid, secret: token, link_id: 'x', ttl_hours: 720, kind: 'comments', op: { upsert: [] } }));
  for (const action of ['op', 'commit', 'join', 'sign_upload', 'delete', 'invite_code'])
    out.push(await post('daw-session', { action, id: sid, secret: token, kind: 'comments', op: { upsert: [{ id: 'cm-pirate' }] }, role: 'artist', device_id: 'tel', baseVersion: 0, manifest: { project: {} }, parts: ['a'.repeat(40)] }));
  return out; }"""


def short_wav(sec=3, sr=48000) -> bytes:
    data = bytearray()
    for i in range(int(sec * sr)):
        t = i / sr
        data += struct.pack("<hh", int(0.3 * math.sin(2 * math.pi * 440 * t) * 32767), int(0.3 * math.sin(2 * math.pi * 660 * t) * 32767))
    return (b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE" + b"fmt " + struct.pack("<IHHIIHH", 16, 1, 2, sr, sr * 4, 4, 16)
            + b"data" + struct.pack("<I", len(data)) + bytes(data))


def reg(v, t, c=0, by="u:nina"):
    return {"v": v, "s": {"t": t, "c": c, "by": by}}


def seed_review(cloud, sid):
    """Ce que l'autre chantier (commentaires horodatés, versions envoyées / validées) met dans le journal."""
    now = int(time.time() * 1000)
    wav = short_wav()
    part = hashlib.sha1(wav).hexdigest()
    cloud.parts[part] = wav
    v1 = {"id": "mv-qa-1", "n": 1, "name": "Version 1", "sentAt": now - 7200_000, "sentBy": "Max", "sentByKey": "u:max", "ref": {}, "audio": None,
          "decision": reg({"kind": "changes", "by": "Nina", "byKey": "u:nina", "at": now - 7000_000, "comment": "plus de voix au refrain"}, now - 7000_000)}
    v2 = {"id": "mv-qa-2", "n": 2, "name": "Version 2 · voix +1 dB", "note": "voix remontée, de-esser", "sentAt": now - 600_000, "sentBy": "Max", "sentByKey": "u:max",
          "ref": {}, "audio": {"bufferId": "b-qa", "parts": [part], "size": len(wav), "duration": 3.0}, "decision": {"v": None, "s": {"t": 0, "c": 0, "by": ""}}}
    def cm(i, t, text, ts, **kw):
        base = {"id": f"cm-qa-{i}", "authorKey": "u:nina", "authorName": "Nina", "role": "artist", "createdAt": ts, "trackId": "stereo",
                "pos": reg({"t": t, "end": None}, ts), "text": reg(text, ts), "status": reg({"s": "open"}, ts), "archived": reg(False, ts), "replies": []}
        base.update(kw)
        return base
    c1 = cm(1, 72, "à 1:12 le « s » siffle", now - 500_000, replies=[{"id": "rp-1", "authorKey": "u:max", "authorName": "Max", "createdAt": now - 400_000, "text": reg("corrigé dans la V2", now - 400_000, by="u:max")}])
    c2 = cm(2, 12, "intro : on peut couper 2 mesures ?", now - 450_000, status=reg({"s": "resolved"}, now - 300_000))
    c3 = cm(3, 30, "commentaire archivé (ne doit pas apparaître)", now - 440_000, archived=reg(True, now - 200_000))
    for kind, items in (("mixver", [v1, v2]), ("comments", [c1, c2, c3])):
        cloud.seq += 1
        cloud.ops.append({"seq": cloud.seq, "sid": sid, "member_key": "u:nina", "role": "artist", "author_name": "Nina", "kind": kind,
                          "op": {"upsert": items}, "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"), "t": time.time()})
    return part


def client_page(b, cloud, rt, fl, tag, log):
    """Téléphone, contexte vierge : aucun compte, aucun stockage (navigation privée)."""
    ctx, pg = new_page(b, "tel390", log)
    pg.add_init_script(mds.PCS_INIT)
    pg.route(f"{SUPA}/functions/v1/daw-listen", fl.handler(tag))
    pg.route(f"{SUPA}/functions/v1/daw-session", cloud.handler(tag))
    pg.route(f"{STORE}/**", cloud.download)
    pg.route_web_socket(re.compile(r"realtime/v1/websocket"), rt.handler(tag))
    return ctx, pg


def created_link(E, label):
    """Lien tout juste créé (ligne « label », partage ouvert) : son adresse et son identifiant."""
    row = E.locator("[data-testid=listen-link]").filter(has=E.locator("p", has_text=label))
    wait_for(E, lambda: row.count() > 0 and row.first.get_by_test_id("listen-link-url").count() > 0, 20, what=f"lien « {label} » créé")
    return row.first.get_by_test_id("listen-link-url").input_value(), row.first.get_attribute("data-link-id")


def run():
    res = {"name": "lien_ecoute", "passe": PASSE, "ok": True, "steps": [], "verifications": {}, "mesures": {},
           "note": "Serveur NOVA, daw-listen et Supabase Realtime SIMULÉS ; WebRTC réel entre deux pages headless ; aucune requête vers la production."}
    cloud = FakeNovaCloud(per_device=True, codes=True, strict=True)
    rt = FakeRealtime()
    fl = FakeListen(cloud)
    src = OUT / "00_session_test_stereo.novaproj.zip"
    mds.stereo_project(src)
    st = {}
    pages = {}

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
            res["steps"].append({"step": label, "ok": False, "err": f"{type(e).__name__}: {str(e)[:700]}"})
            for tag, pg in pages.items():
                try: shot(pg, f"ECHEC_{len(res['steps'])}_{tag}")
                except Exception: pass
            return None

    with sync_playwright() as p:
        b = mds.launch_rtc(p)
        logs = {k: Log(f"lien_ecoute_{k}") for k in ("E", "C", "C2", "C3", "C4")}
        ctxE, E = new_page(b, "pc", logs["E"])
        pages["E"] = E
        E.add_init_script(REC_INIT)
        E.add_init_script(mds.PCS_INIT)
        prepare(E, None, desktop=False)
        connect(E, cloud, rt, "E", MAX, "max@test.local")
        E.route(f"{SUPA}/functions/v1/daw-listen", fl.handler("E"))
        E.goto(BASE, wait_until="domcontentloaded", timeout=180000)
        E.get_by_text("Nouveau Projet").first.wait_for(timeout=180000)

        def e_start():
            open_project_file(E, src, res, "E1_seance_test_stereo")
            dismiss(E); open_panel(E)
            E.get_by_test_id("collab-role").select_option("engineer")
            E.get_by_placeholder("Ton nom (affiché aux autres)").fill("Max")
            E.get_by_role("button", name="Démarrer la collaboration en direct").click()
            wait_for(E, lambda: collab(E, "c.role()") == "engineer", 90, what="collaboration ouverte chez Max (ingé)")
            st["sid"] = next(k for k, v in cloud.sessions.items() if v["manifest"])
            return {"seance": st["sid"]}
        step("Max (ingé) ouvre la séance « Test stéréo » et démarre la collaboration", e_start)

        def e_create():
            open_panel(E)
            sec = E.get_by_test_id("listen-links")
            sec.scroll_into_view_if_needed()
            wait_for(E, lambda: E.get_by_test_id("listen-new").count() > 0, 30, what="section « Lien d'écoute client »")
            E.get_by_test_id("listen-new").click()
            E.get_by_test_id("listen-label").fill("Label Nina")
            E.get_by_test_id("listen-ttl-168").click()
            for k in ("live", "versions", "comments"):
                cb = E.get_by_test_id(f"listen-opt-{k}")
                if not cb.is_checked(): cb.check()
            E.get_by_test_id("listen-create").click()
            url, st["link_id"] = created_link(E, "Label Nina")
            st["url"] = url
            st["token"] = url.split("#t=")[-1]
            E.get_by_test_id("listen-copy").click()
            wait_for(E, lambda: "copié" in E.get_by_test_id("listen-copy").inner_text(), 5, what="« Lien copié »")
            wait_for(E, lambda: E.get_by_test_id("listen-qr").count() > 0, 10, what="QR code")
            qr_ok = E.evaluate("() => { const i = document.querySelector('[data-testid=listen-qr]'); return !!i && i.complete && i.naturalWidth >= 200; }")
            E.get_by_test_id("listen-share").scroll_into_view_if_needed()
            shot(E, "E2_lien_cree_qr_copier")
            check("lien au format <appli>/ecoute.html#t=<32 caractères> (jeton hors de la requête HTTP)", bool(re.match(r"^https?://[^?#]+/ecoute\.html#t=[A-Za-z0-9]{32}$", url)))
            check("bouton Copier : « Lien copié ✓ » ; QR code affiché (≥ 200 px)", qr_ok)
            lk = fl.links[st["link_id"]]
            check("réglages enregistrés côté serveur : 7 jours, direct + versions + commentaires, « Label Nina »",
                  abs((lk["expires"] - lk["created"]) - 168 * 3600) < 5 and lk["live"] and lk["versions"] and lk["comments"] and lk["label"] == "Label Nina")
            return {"url": url, "lien": st["link_id"]}
        step("Max crée un lien d'écoute (7 jours, direct + versions + commentaires), le copie, QR code", e_create)

        def seed():
            st["part"] = seed_review(cloud, st["sid"])
            st["ops_avant"] = len(cloud.ops)
            st["version_avant"] = cloud.sessions[st["sid"]]["version"]
        step("La séance contient 2 versions envoyées et 3 commentaires (journal de la collaboration)", seed)

        def e_live():
            E.get_by_test_id("listen-live-toggle").click()
            wait_for(E, lambda: E.get_by_test_id("listen-live-toggle").get_attribute("aria-pressed") == "true", 15, what="diffusion aux clients active")
            E.keyboard.press("Escape")
            close_panel(E)
            E.evaluate("() => window.DAW_CONTROL.seek(0)"); E.wait_for_timeout(300)
            E.get_by_role("button", name=re.compile(r"^(Lecture|Lire)")).locator("visible=true").first.click()
            E.wait_for_timeout(500)
        step("Max diffuse son mix à ses clients et lance la lecture", e_live)

        ctxC, C = client_page(b, cloud, rt, fl, "C", logs["C"])
        pages["C"] = C

        def c_open():
            t0 = time.time()
            C.goto(st["url"], wait_until="domcontentloaded")
            wait_for(C, lambda: C.get_by_test_id("listen-live-state").count() > 0, 30, step=50, what="page d'écoute prête")
            pret = round((time.time() - t0) * 1000)
            wait_for(C, lambda: C.get_by_test_id("listen-live-state").get_attribute("data-state") == "live", 30, step=100, what="« En direct » chez le client")
            direct = round((time.time() - t0) * 1000)
            load = C.evaluate(LOAD_JS)
            storage = C.evaluate("() => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie })")
            res["mesures"]["ouverture_page"] = {"page_prete_ms": pret, "en_direct_affiche_ms": direct, **load, "stockage_au_depart": storage}
            shot(C, "C1_client_telephone_en_direct")
            check("page d'écoute SANS le DAW (ni App.tsx, ni moteur audio chargés)", not load["daw_charge"])
            check("client sans compte : aucune session Supabase dans le navigateur", not any("auth-token" in k for k in C.evaluate("() => Object.keys(localStorage)")))
            check("« En direct » affiché chez le client pendant que Max diffuse", True)
            vers = C.get_by_test_id("listen-version").count()
            coms = C.locator("[data-testid=listen-comment]").all_inner_texts()
            res["mesures"]["affichage"] = {"versions": vers, "commentaires": coms}
            check(f"versions affichées en lecture seule (2 attendues : {vers})", vers == 2)
            check("commentaires affichés (2 visibles, l'archivé masqué ; réponse de Max visible)",
                  len(coms) == 2 and any("siffle" in c and "corrigé dans la V2" in c for c in coms) and not any("archivé" in c for c in coms))
            return {"page_prete_ms": pret, "en_direct_ms": direct}
        step("Le client ouvre le lien sur son téléphone (contexte vierge, sans compte)", c_open)

        def c_listen():
            C.evaluate(FIRST_SOUND_JS)
            C.get_by_test_id("listen-play").click()
            first = C.evaluate("() => window.__qaFirst")
            res["mesures"]["premier_son"] = first
            ms = (first or {}).get("ms_depuis_clic")
            check(f"son reçu ≤ {FIRST_SOUND_MAX_MS} ms après le clic sur « Écouter » ({ms} ms)", ms is not None and ms <= FIRST_SOUND_MAX_MS)
            freqs = sorted(set([mds.F_L, mds.F_R, 1000, 5000, 10000, 16000]))
            js = mds.MEASURE_JS.replace("""document.querySelector('audio[data-collab-audio$=":mix"]')""", """document.querySelector('audio[data-listen-audio="mix"]')""")
            recu = C.evaluate(js, {"which": "recu", "freqs": freqs, "secs": 2})
            kin, stats = mds.bitrate(C, "inbound-rtp", (recu or {}).get("piste_id"))
            g = lambda f: (recu.get("niveaux") or {}).get(str(f)) or {}  # noqa
            sep_l = round(g(mds.F_L).get("g", 0) - g(mds.F_L).get("d", 0), 1) if recu and "niveaux" in recu else None
            sep_r = round(g(mds.F_R).get("d", 0) - g(mds.F_R).get("g", 0), 1) if recu and "niveaux" in recu else None
            inb = [f for pc in stats for f in pc["flux"] if f["type"] == "inbound-rtp" and f["piste"] == (recu or {}).get("piste_id")]
            codec = [{k: f[k] for k in ("codec", "canaux", "fmtp", "perdus", "gigue_ms")} for f in inb]
            wait_for(C, lambda: C.get_by_test_id("listen-quality").count() > 0, 10, step=200, what="qualité affichée")
            ui = {"statut": C.get_by_test_id("listen-status").inner_text(), "qualite": C.get_by_test_id("listen-quality").inner_text()}
            res["mesures"]["stereo"] = {"separation_db": {"440 Hz gauche vs droite": sep_l, "660 Hz droite vs gauche": sep_r},
                                       "niveaux": recu.get("niveaux") if recu else recu, "debit_recu_kbps": kin, "codec": codec, "affiche": ui}
            shot(C, "C2_client_ecoute_en_direct")
            check(f"stéréo reçue : séparation ≥ 30 dB (440 Hz : {sep_l} dB, 660 Hz : {sep_r} dB)", (sep_l or 0) >= 30 and (sep_r or 0) >= 30)
            check(f"débit réel ≈ 512 kb/s (reçu {kin} kb/s ; 450 à 560 exigés)", kin is not None and 450 <= kin <= 560)
            check("codec : Opus 2 canaux, fmtp stereo=1 et maxaveragebitrate=510000",
                  any((f["codec"] or "").lower() == "audio/opus" and f["canaux"] == 2 and "stereo=1" in (f["fmtp"] or "") and "maxaveragebitrate=510000" in (f["fmtp"] or "") for f in inb))
            check(f"le client voit « Tu écoutes le mix en direct · stéréo · … kb/s » ({ui['qualite']})", "stéréo" in ui["qualite"] and "en direct" in ui["statut"])
            return {"premier_son_ms": ms, "separation": [sep_l, sep_r], "kbps": kin}
        step("Le client touche « Écouter » : premier son, stéréo, débit", c_listen)

        def c_version():
            C.get_by_test_id("listen-version-play").first.click()
            wait_for(C, lambda: C.get_by_test_id("listen-version-audio").count() > 0, 15, what="audio de la version chargé")
            dur = C.evaluate("""async () => { const a = document.querySelector('[data-testid=listen-version-audio]');
              if (!(a.duration > 0)) await new Promise(r => { a.onloadedmetadata = r; setTimeout(r, 5000); }); return a.duration; }""")
            res["mesures"]["version_ecoutee_duree_s"] = dur
            check(f"la version 2 s'écoute sur le téléphone (durée {dur} s, 3 s attendues)", dur and abs(dur - 3.0) < 0.1)
            C.get_by_test_id("listen-versions").scroll_into_view_if_needed()
            shot(C, "C3_client_versions_commentaires")
        step("Le client écoute la version 2 envoyée", c_version)

        def c_readonly():
            load = C.evaluate(LOAD_JS)
            out = C.evaluate(WRITE_JS, {"token": st["token"], "sid": st["sid"], "supa": SUPA})
            res["mesures"]["ecritures_tentees"] = out
            dl = [o for o in out if o["fn"] == "daw-listen"]
            ds = [o for o in out if o["fn"] == "daw-session"]
            check("daw-listen : toute action autre que lire, avec le jeton, refusée (403 lecture seule)", dl and all(o["statut"] == 403 and o["code"] == "read_only" for o in dl))
            check("daw-session : le jeton n'ouvre pas la séance (404 sur op, commit, join, envoi d'audio…)", ds and all(o["statut"] == 404 for o in ds))
            check("journal et séance inchangés après les tentatives (aucune opération, même version)",
                  len(cloud.ops) == st["ops_avant"] and cloud.sessions[st["sid"]]["version"] == st["version_avant"] and not any(o["op"].get("upsert") == [{"id": "cm-pirate"}] for o in cloud.ops if isinstance(o.get("op"), dict)))
            check(f"aucun champ de saisie sur la page du client ({load['champs_saisie']}) ; boutons : {load['boutons']}", load["champs_saisie"] == 0)
        step("Lecture seule : écritures refusées côté serveur, rien n'a changé", c_readonly)

        def e_revoke():
            open_panel(E)
            E.get_by_test_id("listen-links").scroll_into_view_if_needed()
            t0 = time.time()
            E.locator(f"[data-testid=listen-link][data-link-id='{st['link_id']}'] [data-testid=listen-revoke]").click()
            wait_for(E, lambda: E.get_by_test_id("listen-toast").count() > 0, 10, what="confirmation de révocation")
            toast = E.get_by_test_id("listen-toast").inner_text()
            shot(E, "E3_lien_revoque")
            # La page déjà ouverte chez le client : le son s'arrête (l'ingé quitte le canal du lien).
            wait_for(C, lambda: C.evaluate("() => !document.querySelector('audio[data-listen-audio=\"mix\"]').srcObject"), 15, step=100, what="son coupé chez le client")
            coupe = round((time.time() - t0) * 1000)
            C.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")
            wait_for(C, lambda: C.get_by_test_id("listen-error").count() > 0, 15, what="message de révocation chez le client")
            msg = {"code": C.get_by_test_id("listen-error").get_attribute("data-code"), "titre": C.get_by_test_id("listen-error-title").inner_text(),
                   "texte": C.get_by_test_id("listen-error-text").inner_text()}
            shot(C, "C4_client_lien_desactive")
            C.reload(wait_until="domcontentloaded")
            wait_for(C, lambda: C.get_by_test_id("listen-error").count() > 0, 15, what="réouverture refusée")
            re_code = C.get_by_test_id("listen-error").get_attribute("data-code")
            res["mesures"]["revocation"] = {"toast_inge": toast, "son_coupe_ms": coupe, "message_client": msg, "reouverture": re_code}
            check(f"révocation en un clic : le son s'arrête chez le client ({coupe} ms)", coupe < 15000)
            check(f"lien révoqué refusé avec un message clair (« {msg['titre']} » — {msg['texte'][:80]})", msg["code"] == "revoked" and "désactivé" in msg["titre"] and "nouveau lien" in msg["texte"])
            check("réouverture du lien révoqué refusée", re_code == "revoked")
            check("le lien révoqué n'est plus dans la liste de l'ingé", E.locator(f"[data-testid=listen-link][data-link-id='{st['link_id']}']").count() == 0)
        step("Max révoque le lien en un clic", e_revoke)

        def expired():
            E.get_by_test_id("listen-new").click()
            E.get_by_test_id("listen-label").fill("Manager")
            E.get_by_test_id("listen-ttl-24").click()
            E.get_by_test_id("listen-create").click()
            url, lid = created_link(E, "Manager")
            fl.expire(lid)
            ctx2, C2 = client_page(b, cloud, rt, fl, "C2", logs["C2"])
            pages["C2"] = C2
            C2.goto(url, wait_until="domcontentloaded")
            wait_for(C2, lambda: C2.get_by_test_id("listen-error").count() > 0, 20, what="message « expiré »")
            msg = {"code": C2.get_by_test_id("listen-error").get_attribute("data-code"), "titre": C2.get_by_test_id("listen-error-title").inner_text(),
                   "texte": C2.get_by_test_id("listen-error-text").inner_text()}
            shot(C2, "C5_client_lien_expire")
            res["mesures"]["expire"] = msg
            check(f"lien expiré refusé avec un message clair (« {msg['titre']} » — {msg['texte'][:80]})", msg["code"] == "expired" and "expiré" in msg["titre"] and re.search(r"\d\d/\d\d/\d{4}", msg["texte"]))
            check("aucun son ni canal pour un lien expiré", C2.get_by_test_id("listen-play").count() == 0)
            ctx2.close()
        step("Lien expiré (24 h écoulées) : refusé avec un message clair", expired)

        def password():
            E.get_by_test_id("listen-new").click()
            E.get_by_test_id("listen-label").fill("Artiste")
            E.get_by_test_id("listen-password-new").fill("nina2026")
            E.get_by_test_id("listen-create").click()
            url, _ = created_link(E, "Artiste")
            ctx3, C3 = client_page(b, cloud, rt, fl, "C3", logs["C3"])
            pages["C3"] = C3
            C3.goto(url, wait_until="domcontentloaded")
            wait_for(C3, lambda: C3.get_by_test_id("listen-password").count() > 0, 20, what="mot de passe demandé")
            shot(C3, "C6_client_mot_de_passe")
            C3.get_by_test_id("listen-password").fill("mauvais")
            C3.get_by_test_id("listen-password-submit").click()
            wait_for(C3, lambda: C3.get_by_test_id("listen-error").get_attribute("data-code") == "password_wrong", 10, what="mot de passe incorrect")
            C3.get_by_test_id("listen-password").fill("nina2026")
            C3.get_by_test_id("listen-password-submit").click()
            wait_for(C3, lambda: C3.get_by_test_id("listen-live-state").count() > 0, 15, what="page ouverte avec le bon mot de passe")
            check("lien protégé : mot de passe demandé, faux refusé, bon accepté", True)
            ctx3.close()
        step("Lien protégé par un mot de passe", password)

        def incomplete():
            ctx4, C4 = client_page(b, cloud, rt, fl, "C4", logs["C4"])
            pages["C4"] = C4
            C4.goto(BASE.rstrip("/") + "/ecoute.html", wait_until="domcontentloaded")
            wait_for(C4, lambda: C4.get_by_test_id("listen-error").count() > 0, 15, what="lien incomplet")
            code = C4.get_by_test_id("listen-error").get_attribute("data-code")
            C4.goto(BASE.rstrip("/") + "/ecoute.html#t=" + "x" * 32, wait_until="domcontentloaded")
            C4.reload(wait_until="domcontentloaded")
            wait_for(C4, lambda: C4.get_by_test_id("listen-error").count() > 0, 15, what="lien inconnu")
            code2 = C4.get_by_test_id("listen-error").get_attribute("data-code")
            shot(C4, "C7_client_lien_inconnu")
            check(f"lien incomplet / inconnu : message clair ({code}, {code2})", code == "missing" and code2 == "unknown")
            ctx4.close()
        step("Lien incomplet ou inconnu : message clair", incomplete)

        for k, lg in logs.items():
            res[f"erreurs_{k}"] = [x["text"][:200] for x in lg.errors() if "status of 4" not in x["text"]][:12]
            save_log(lg)
        res["appels_daw_listen"] = fl.calls[-40:]
        res["ecritures_bloquees"] = sum(len(getattr(pg, "_blocked", [])) for pg in pages.values())
        b.close()

    (OUT / "resultat_lien_ecoute.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: res.get(k) for k in ("ok", "passe", "steps", "verifications", "mesures")}, ensure_ascii=False, indent=1)[:14000])
    return res


if __name__ == "__main__":
    r = run()
    sys.exit(0 if r["ok"] else 1)
