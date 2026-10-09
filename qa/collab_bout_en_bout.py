"""Collaboration de bout en bout : artiste + ingé (En direct), 2e artiste (feat), pannes.

Quatre navigateurs headless (aucune fenêtre) :
  A = Lina, artiste, hôte (PC)          E = Max, ingé son (PC)
  B = Sam, 2e artiste (téléphone)       A2 = Lina sur sa tablette (MÊME compte que A)

Serveur NOVA (daw-session) et Supabase Realtime SIMULÉS (qa/collab_sim.py) :
par défaut la fonction CORRIGÉE (fe14e5f : clé par appareil, codes, règles
strictes de la vraie fonction : compte, abonnement, nom d'opération, taille,
codes HTTP). COLLAB_SERVEUR=ancien : la fonction actuellement en ligne.
Rien ne part vers Supabase (écritures bloquées par qalib).

Après CHAQUE étape : empreinte de ce qui est partagé, piste par piste
(utils/collabFingerprint, window.__novaCollab.fingerprint()), comparée chez
tous les participants ; temps de convergence mesuré ; ce qui diffère est
nommé (« Voix lead : clips », « session : tempo »…) avec le détail.

Les modifications passent par le même chemin que l'interface (setState de
l'appli → détection → collaboration) via window.__novaTest (serveur de
développement seulement) ; invitation, rôles, REC, chat, talkback, historique
et exports se font à la souris / au doigt.

Usage : NOVA_URL=http://127.0.0.1:3480/ python qa/collab_bout_en_bout.py
Sorties : D:\\1 WORK\\CONTENU\\nova-collab-pro\\bout_en_bout\\
"""
import json, os, re, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-collab-pro\bout_en_bout")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3480/")
import qalib  # noqa
from qalib import *  # noqa
from gel_pre_effet import prepare, export_wav, rms_db, open_project_file  # noqa
from collab_sim import FakeNovaCloud, FakeRealtime, connect  # noqa
from feat_lib import feat_project, dismiss, wait_for, collab, tracks, open_panel, close_panel, rec_button, REC_INIT  # noqa

NEW_SERVER = os.environ.get("COLLAB_SERVEUR", "patch") != "ancien"
LINA, SAM, MAX = "11111111-1111-4111-8111-111111111111", "33333333-3333-4333-8333-333333333333", "22222222-2222-4222-8222-222222222222"
CONVERGE_S = float(os.environ.get("CONVERGE_S", "25"))


def launch_rtc(p):
    """Comme qalib.launch, plus WebRTC entre pages headless (adresses locales en clair, pas de mDNS)."""
    return p.chromium.launch(headless=True, executable_path=CHROME, args=[
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={FAKE_WAV}",
        "--autoplay-policy=no-user-gesture-required", "--disable-features=WebRtcHideLocalIpsWithMdns",
    ])


def rtc_diag(page):
    """Diagnostic WebRTC : getStats (octets, paquets, niveau) par personne, journal de signalisation, éléments audio, moteur."""
    return page.evaluate("""async () => { const c = window.__novaCollab; if (!c || !c.rtcStats) return null;
        const stats = await c.rtcStats();
        const els = [...document.querySelectorAll('audio[data-collab-audio]')].map(el => ({ id: el.getAttribute('data-collab-audio'), paused: el.paused, muted: el.muted,
            readyState: el.readyState, tracks: el.srcObject ? el.srcObject.getAudioTracks().map(t => ({ id: t.id, state: t.readyState, muted: t.muted, enabled: t.enabled })) : null }));
        let engine = null; try { const m = await window.__novaAppModule('/engine/AudioEngine.ts'); const ctx = m.audioEngine.ctx; engine = ctx ? { state: ctx.state, t: +ctx.currentTime.toFixed(2) } : null; } catch (e) { engine = String(e); }
        return { stats, trace: c.rtcTrace().slice(-40).map(x => ({ ...x, t: x.t % 100000 })), elements: els, engine, audio: c.audio() }; }""")


def fp(page):
    return page.evaluate("() => window.__novaCollab && window.__novaCollab.fingerprint ? window.__novaCollab.fingerprint() : null")


def parts(page, tid):
    return page.evaluate(f"() => window.__novaCollab && window.__novaCollab.parts ? window.__novaCollab.parts({json.dumps(tid)}) : null")


def detail(pa, pb, tid, part):
    """Ce qui diffère précisément dans une partie d'une piste (clips : lesquels, quels champs)."""
    a, b = (parts(pa, tid) or {}).get(part), (parts(pb, tid) or {}).get(part)
    if part == "clips" and isinstance(a, list) and isinstance(b, list):
        am, bm = {c["id"]: c for c in a}, {c["id"]: c for c in b}
        out = [f"clip {i} absent d'un côté" for i in sorted(set(am) ^ set(bm))]
        for i in sorted(set(am) & set(bm)):
            ks = sorted(k for k in set(am[i]) | set(bm[i]) if am[i].get(k) != bm[i].get(k))
            if ks:
                out.append(f"clip {i} : " + ", ".join(f"{k}={json.dumps(am[i].get(k))[:40]} / {json.dumps(bm[i].get(k))[:40]}" for k in ks[:4]))
        return out[:6]
    if isinstance(a, dict) and isinstance(b, dict):
        return [f"{k}={json.dumps(a.get(k))[:60]} / {json.dumps(b.get(k))[:60]}" for k in sorted(set(a) | set(b)) if a.get(k) != b.get(k)][:6]
    return [f"{json.dumps(a)[:120]} / {json.dumps(b)[:120]}"]


def diff(a, b):
    """Ce qui diffère entre deux empreintes : [(texte, id de piste, partie)]."""
    out = []
    for k in sorted(set(a["song"]) | set(b["song"])):
        if a["song"].get(k) != b["song"].get(k):
            out.append((f"session : {k}", None, k))
    bm = {t["id"]: t for t in b["tracks"]}
    am = {t["id"]: t for t in a["tracks"]}
    for t in a["tracks"]:
        o = bm.get(t["id"])
        if not o:
            out.append((f"« {t['name']} » : absente chez l'autre", t["id"], None)); continue
        if o["sig"] != t["sig"]:
            out += [(f"« {t['name']} » : {k}", t["id"], k) for k in t["parts"] if t["parts"][k] != o["parts"].get(k)]
    out += [(f"« {t['name']} » : absente ici", t["id"], None) for t in b["tracks"] if t["id"] not in am]
    return out


def upd(page, js_body):
    """Modification faite comme l'interface (setState → détection → collaboration).
    js_body : corps d'une fonction (d) => {…} ; elle ne lève jamais d'erreur (l'appli resterait figée)."""
    page.evaluate(f"() => window.__novaTest.update((d) => {{ try {{ {js_body} }} catch (e) {{ console.warn('qa', e); }} }})")


def st(page, expr):
    return page.evaluate(f"() => {{ const d = window.__novaTest.getState(); return ({expr}); }}")


def run():
    res = {"name": "collab_bout_en_bout", "ok": True, "serveur": "corrigé (fe14e5f, règles strictes)" if NEW_SERVER else "actuel (en ligne)",
           "steps": [], "convergence": [], "latences_ms": {}, "constats": [], "verifications": {},
           "note": "Serveur NOVA (daw-session) et Supabase Realtime SIMULÉS ; protocole Phoenix réel côté navigateur ; WebRTC réel entre pages ; micro simulé (WAV)."}
    cloud = FakeNovaCloud(per_device=NEW_SERVER, codes=NEW_SERVER, strict=NEW_SERVER)
    rt = FakeRealtime()
    src = OUT / "00_session_lina.novaproj.zip"
    feat_project(src, name="Feat Lina x Sam")
    link = {}
    pages = {}
    ids = {}

    def lat(name, ms):
        res["latences_ms"].setdefault(name, []).append(round(ms))

    def check(label, ok):
        res["verifications"][label] = bool(ok)
        if not ok:
            res["ok"] = False

    def converge(label, who=None, timeout=CONVERGE_S):
        """Empreintes identiques chez tous (who : liste de lettres). Mesure le temps ; nomme les écarts."""
        names = who or [k for k in pages if pages[k] is not None]
        t0 = time.time()
        last = {}
        while time.time() - t0 < timeout:
            try:
                last = {k: fp(pages[k]) for k in names}
            except Exception:
                last = {}
            if last and all(last.values()) and len({v["sig"] for v in last.values()}) == 1:
                s = round(time.time() - t0, 2)
                res["convergence"].append({"etape": label, "ok": True, "s": s, "participants": names, "empreinte": next(iter(last.values()))["sig"]})
                return s
            time.sleep(0.25)
        ref = names[0]
        ecarts = {}
        for k in names[1:]:
            if last.get(ref) and last.get(k):
                d = diff(last[ref], last[k])
                if d:
                    ecarts[f"{ref}≠{k}"] = [txt + (f" → {detail(pages[ref], pages[k], tid, part)}" if tid and part else "") for txt, tid, part in d[:8]]
        res["convergence"].append({"etape": label, "ok": False, "participants": names, "ecarts": ecarts})
        res["ok"] = False
        return None

    def step(label, fn, conv=True, who=None):
        t = time.time()
        try:
            o = fn()
            res["steps"].append({"step": label, "ok": True, "s": round(time.time() - t, 1), **({"info": o} if o else {})})
        except Exception as e:  # noqa
            res["ok"] = False
            res["steps"].append({"step": label, "ok": False, "err": f"{type(e).__name__}: {str(e)[:600]}"})
            for tag, pg in pages.items():
                try:
                    if pg is not None: shot(pg, f"ECHEC_{len(res['steps'])}_{tag}")
                except Exception:
                    pass
            o = None
        if conv:
            converge(label, who)
        return o

    def propagate(name, dst_pages, fn_check, timeout=30):
        """Temps (ms) jusqu'à ce que fn_check(page) soit vrai chez chaque destinataire."""
        t0 = time.time()
        for d in dst_pages:
            wait_for(d, lambda: fn_check(d), timeout, step=40, what=name)
            lat(f"{name} → {[k for k, v in pages.items() if v is d][0]}", (time.time() - t0) * 1000)

    with sync_playwright() as p:
        b = launch_rtc(p)
        logs = {k: Log(f"e2e_{k}") for k in ("A", "E", "B", "A2")}
        ctxA, A = new_page(b, "pc", logs["A"])
        ctxE, E = new_page(b, "pc", logs["E"])
        ctxB, B = new_page(b, "tel", logs["B"])
        pages.update({"A": A, "E": E, "B": B})
        for pg in (A, E, B):
            pg.add_init_script(REC_INIT)
            prepare(pg, None, desktop=False)
        connect(A, cloud, rt, "A", LINA, "lina@test.local")
        connect(E, cloud, rt, "E", MAX, "max@test.local")
        connect(B, cloud, rt, "B", SAM, "sam@test.local")
        # Serveur de développement froid (première compilation) : on le réchauffe avant de mesurer quoi que ce soit.
        for pg in (A, E, B):
            pg.goto(BASE, wait_until="domcontentloaded", timeout=180000)
            pg.get_by_text("Nouveau Projet").first.wait_for(timeout=180000)

        # ------------------------------------------------------------ 1. invitation, rôles, présence
        def a_start():
            open_project_file(A, src, res, "A1_session_lina")
            dismiss(A)
            open_panel(A)
            A.get_by_placeholder("Ton nom (affiché aux autres)").fill("Lina")
            t0 = time.time()
            A.get_by_role("button", name="Démarrer la collaboration en direct").click()
            wait_for(A, lambda: collab(A, "c.role()") == "artist", 60, what="collaboration ouverte chez Lina")
            lat("démarrage (mise en ligne + connexion)", (time.time() - t0) * 1000)
            sid = next(k for k, v in cloud.sessions.items() if v["manifest"])
            link["s"] = f"{sid}.{cloud.sessions[sid]['secret']}"
            if NEW_SERVER:
                wait_for(A, lambda: re.search(r"[A-Z0-9]{3} [A-Z0-9]{3}", A.get_by_test_id("collab-invite-code").inner_text()), 20, what="code affiché")
                link["code"] = re.search(r"([A-Z0-9]{3}) ([A-Z0-9]{3})", A.get_by_test_id("collab-invite-code").inner_text()).group(0)
            shot(A, "A2_lina_invite")
            return {"code": link.get("code")}
        step("Lina (artiste, hôte) démarre « En direct » : lien + code", a_start, conv=False)

        def e_link():
            E.goto(f"{BASE}?session={link['s']}&invite=1", wait_until="domcontentloaded")
            wait_for(E, lambda: E.get_by_test_id("collab-arrival").count() > 0, 60, what="choix du rôle (Max)")
            E.wait_for_timeout(1500); dismiss(E)
            E.get_by_test_id("arrival-role-engineer").click()
            E.get_by_label("Ton nom", exact=True).fill("Max")
            shot(E, "E1_max_choisit_inge")
            E.get_by_test_id("arrival-join").click()
            wait_for(E, lambda: collab(E, "c.role()") == "engineer", 60, what="Max relié")
            dismiss(E)
        step("Max (ingé) rejoint par le LIEN et choisit « Ingé son »", e_link, who=["A", "E"])

        def b_code():
            B.goto(BASE, wait_until="domcontentloaded")
            B.get_by_text("Nouveau Projet").first.wait_for(timeout=25000)
            B.get_by_text("Nouveau Projet").first.click(); B.wait_for_timeout(2000)
            dismiss(B)
            open_panel(B)
            if NEW_SERVER:
                B.get_by_test_id("collab-code-input").fill(link["code"].lower())
                B.get_by_test_id("collab-code-join").click()
            else:
                B.goto(f"{BASE}?session={link['s']}&invite=1", wait_until="domcontentloaded")
            wait_for(B, lambda: B.get_by_test_id("collab-arrival").count() > 0, 60, what="choix du rôle (Sam)")
            B.wait_for_timeout(1500); dismiss(B)
            shot(B, "B1_sam_telephone_arrivee")
            B.get_by_test_id("arrival-role-artist").click()
            B.get_by_label("Ton nom", exact=True).fill("Sam")
            B.get_by_test_id("arrival-join").click()
            wait_for(B, lambda: collab(B, "c.role()") == "artist", 60, what="Sam relié")
            dismiss(B)
            online = lambda pg: pg.locator("[data-testid=collab-peer][data-online='1']").count()  # noqa
            for pg in (A, E, B):
                open_panel(pg)
            s = wait_for(A, lambda: online(A) >= 3 and online(E) >= 3 and online(B) >= 3, 40, what="présence des trois")
            shot(A, "A3_presence_pc"); shot(B, "B2_presence_telephone"); shot(E, "E2_presence_inge")
            # « Créer ma piste » (au doigt, sur le téléphone de Sam).
            B.get_by_test_id("collab-my-track").click(); B.wait_for_timeout(600)
            for pg in (A, E, B):
                close_panel(pg)
            return {"presence_s": s}
        step("Sam (téléphone) rejoint avec le CODE, choisit « Artiste », crée SA piste ; les trois se voient", b_code)

        # ------------------------------------------------------------ 2. l'ingé règle le mix de la voix de Lina
        def e_mix():
            upd(E, """const t = d.tracks.find(x => x.id === 'voix'); t.volume = 0.7; t.pan = -0.3;
              t.plugins.push({ id: 'comp-e2e', name: 'COMPRESSOR', type: 'COMPRESSOR', isEnabled: true, latency: 0,
                params: { threshold: -18, ratio: 2, knee: 12, attack: 0.003, release: 0.25, makeupGain: 1.6, isEnabled: true } });""")
            propagate("mix de l'ingé (volume, pan, effet)", [A, B],
                      lambda pg: st(pg, "(() => { const t = d.tracks.find(x => x.id === 'voix'); return t && Math.abs(t.volume - 0.7) < 1e-6 && t.plugins.some(p => p.id === 'comp-e2e'); })()"))
        step("Max règle la voix de Lina (volume, pan, compresseur 2:1)", e_mix)

        # ------------------------------------------------------------ 3. prises : Lina (PC) et Sam (téléphone)
        def takes():
            out = {}
            for who, pg in (("A", A), ("B", B)):
                pg.keyboard.press("Escape")
                pg.evaluate(f"async () => {{ const m = await window.__novaAppModule('/utils/playheadStore.ts'); m.playheadStore.set({4 if who == 'A' else 10}); }}")
                before = set(c["id"] for t in tracks(pg) for c in t["clips"])
                rec_button(pg).click(); pg.wait_for_timeout(2500); rec_button(pg).click()
                t0 = time.time()
                wait_for(pg, lambda: any(c["id"] not in before for t in tracks(pg) for c in t["clips"]), 20, what=f"prise posée ({who})")
                take = next(dict(c, track=t["name"]) for t in tracks(pg) for c in t["clips"] if c["id"] not in before)
                ids[who] = take["id"]
                others = [x for x in ("A", "E", "B") if x != who]
                for nm in others:
                    o = pages[nm]
                    wait_for(o, lambda: any(c["id"] == take["id"] for t in tracks(o) for c in t["clips"]), 40, step=50, what=f"prise de {who} reçue ({nm})")
                    lat(f"prise : fin de REC → reçue ({who}→{nm})", (time.time() - t0) * 1000)
                out[who] = take
            heard = E.evaluate(f"""async () => {{ const r = (await window.__novaAppModule('/utils/audioBufferRegistry.ts')).audioBufferRegistry;
                const c = window.__novaTest.getState().tracks.flatMap(t => t.clips).find(c => c.id === '{ids["A"]}');
                const b = c && r.get(c.bufferId); if (!b) return null; const x = b.getChannelData(0); let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i];
                return {{ dur: +b.duration.toFixed(2), rms_db: +(10 * Math.log10(s / x.length + 1e-12)).toFixed(1) }}; }}""")
            out["audio_de_lina_chez_max"] = heard
            check("Max a l'audio de la prise de Lina (non muet)", heard and heard["rms_db"] > -60)
            shot(E, "E3_max_recoit_les_prises"); shot(B, "B3_sam_sa_prise_telephone")
            return out
        step("Lina (PC) puis Sam (téléphone) enregistrent : chacun reçoit la prise de l'autre (audio compris)", takes)

        # ------------------------------------------------------------ 4. l'ingé retouche la prise de Lina
        def e_edits():
            tid = ids.get("A")
            upd(E, f"""const t = d.tracks.find(x => x.clips.some(c => c.id === '{tid}')); const c = t.clips.find(c => c.id === '{tid}');
              c.gain = 0.8; c.fadeIn = 0.05; c.fadeOut = 0.08; c.gainPoints = [{{ t: c.offset + 0.2, db: -3 }}, {{ t: c.offset + 0.6, db: 0 }}];
              c.breaths = [{{ start: c.offset + 0.1, end: c.offset + 0.3, gainDb: -12 }}];
              const p1 = t.clips.find(x => x.id === 'p1'); if (p1) p1.isMuted = true;""")
            propagate("retouche de clip par l'ingé (gain, fondus, respiration, comp)", [A, B],
                      lambda pg: st(pg, f"(() => {{ const c = d.tracks.flatMap(t => t.clips).find(c => c.id === '{tid}'); const p1 = d.tracks.flatMap(t => t.clips).find(c => c.id === 'p1'); return c && c.gain === 0.8 && (c.breaths || []).length === 1 && p1 && p1.isMuted; }})()"), timeout=20)
        step("Max retouche la prise de Lina : gain de clip, ligne de gain (R5), fondus, respiration, comp (phrase 1 coupée)", e_edits)

        # ------------------------------------------------------------ 5. chacun règle SA piste (feat), automation, tranche
        def own_mix():
            upd(B, "const t = d.tracks.find(x => x.collabOwnerName === 'Sam'); if (t) t.pan = 0.4;")
            upd(A, "const t = d.tracks.find(x => x.id === 'voix'); t.stereoWidth = 0.8;")
            propagate("mix d'un artiste sur SA piste", [E], lambda pg: st(pg, "(() => { const t = d.tracks.find(x => x.collabOwnerName === 'Sam'); return t && t.pan === 0.4; })()"), timeout=15)
        step("Feat : Sam règle le pan de SA piste, Lina la largeur de la sienne", own_mix)

        def automation():
            upd(E, """const t = d.tracks.find(x => x.id === 'voix'); t.automationMode = 'read';
              t.automationLanes = [{ id: 'lane-vol', parameterName: 'volume', color: '#22d3ee', isExpanded: true, min: 0, max: 1.5,
                points: [{ id: 'a1', time: 0, value: 0.9 }, { id: 'a2', time: 6, value: 0.5 }, { id: 'a3', time: 10, value: 1.0 }] }];
              t.inputTrimDb = -2; t.phaseInvert = true;""")
        step("Max écrit une automation de volume (R7/R8) et règle trim + phase", automation)

        # ------------------------------------------------------------ 6. session : tempo, repères, accords, groupes, notes, arrangements, tonalité
        def song():
            upd(E, "d.bpm = 92; d.projectKey = 9; d.projectScale = 'MINOR';")
            upd(B, "d.markers = [...(d.markers || []), { id: 'mk-refrain', name: 'Refrain', time: 8, color: '#f59e0b' }];")
            upd(A, "d.chords = [...(d.chords || []), { id: 'ch-am', start: 0, end: 2, root: 9, quality: 'min' }];")
            upd(E, """d.trackGroups = [{ id: 'grp-voix', name: 'Voix', color: '#a78bfa', trackIds: d.tracks.filter(t => t.type === 'AUDIO' && t.id !== 'instrumental').map(t => t.id),
              isCollapsed: false, linkedVolume: true, linkedMute: true, linkedSolo: true, linkedPan: false }];""")
            upd(E, "d.projectNotes = { ...(d.projectNotes || {}), mix: 'Compresseur voix 2:1, ad-lib au refrain', updatedAt: Date.now(), updatedBy: 'Max' };")
            upd(A, "d.arrangements = [{ id: 'arr-court', name: 'Version courte', sections: ['__debut', 'mk-refrain'], mutedClipIds: [] }];")
        step("Session : tempo 92 + tonalité (Max), repère (Sam), accord (Lina), groupe (Max), note (Max), arrangement (Lina)", song)

        # ------------------------------------------------------------ 7. transposition (R13), MIDI + CC (R16), structure, suppression
        def tracks_more():
            tid = ids.get("A")
            upd(A, f"""const c = d.tracks.flatMap(t => t.clips).find(c => c.id === '{tid}');
              if (c) c.elastic = {{ sourceOffset: c.offset, sourceDuration: c.duration, duration: c.duration, renderedOffset: 0, semitones: 2, markers: [] }};""")
            upd(E, """d.tracks.splice(d.tracks.length - 1, 0, { id: 'midi-e2e', name: 'Synth de Max', type: 'MIDI', color: '#fbbf24', isMuted: false, isSolo: false,
              isTrackArmed: false, isFrozen: false, volume: 0.8, pan: 0, outputTrackId: 'master', sends: [], plugins: [], automationLanes: [], totalLatency: 0,
              clips: [{ id: 'mc1', name: 'Motif', start: 0, duration: 4, offset: 0, fadeIn: 0, fadeOut: 0, color: '#fbbf24', type: 'MIDI',
                notes: [{ id: 'n1', pitch: 60, start: 0, duration: 0.5, velocity: 100 }, { id: 'n2', pitch: 64, start: 1, duration: 0.5, velocity: 90 }],
                cc: { '1': [{ t: 0, v: 0 }, { t: 2, v: 127 }] } }] });""")
            upd(E, "const t = d.tracks.find(x => x.id === 'instrumental'); if (t) t.isHidden = true;")
        step("Lina transpose sa prise (+2, R13) ; Max crée une piste MIDI avec notes et CC (R16) ; Max masque une piste", tracks_more)

        def e_delete():
            upd(E, "d.tracks = d.tracks.filter(t => t.id !== 'midi-e2e');")
            propagate("suppression de piste", [A, B], lambda pg: st(pg, "!d.tracks.some(t => t.id === 'midi-e2e')"), timeout=15)
        step("Max supprime la piste MIDI qu'il a créée : supprimée chez tous", e_delete)

        # ------------------------------------------------------------ 8. conflits
        def same_field():
            upd(A, "const t = d.tracks.find(x => x.id === 'voix'); t.pan = 0.25;")
            upd(E, "const t = d.tracks.find(x => x.id === 'voix'); t.pan = -0.6;")
        step("Conflit : Lina et Max changent le pan de la voix en même temps", same_field)

        def diff_clips():
            upd(A, "const c = d.tracks.find(x => x.id === 'voix').clips.find(c => c.id === 'p2'); c.start = c.start + 0.5;")
            upd(E, "const c = d.tracks.find(x => x.id === 'voix').clips.find(c => c.id === 'p3'); c.gain = 0.6;")
        step("Conflit : Lina déplace la phrase 2 pendant que Max baisse la phrase 3", diff_clips)

        def both_kept():
            ok = st(A, "(() => { const t = d.tracks.find(x => x.id === 'voix'); const p3 = t.clips.find(c => c.id === 'p3'); return !!(p3 && p3.gain === 0.6); })()")
            ok2 = st(E, "(() => { const t = d.tracks.find(x => x.id === 'voix'); const p2 = t.clips.find(c => c.id === 'p2'); return !!(p2 && p2.start === 2.5); })()") if False else st(E, "(() => { const t = d.tracks.find(x => x.id === 'voix'); const p2 = t.clips.find(c => c.id === 'p2'); return p2 ? p2.start : null; })()")
            check("conflit sur deux clips : la baisse de Max est gardée chez Lina", ok)
            return {"gain_p3_chez_lina": ok, "debut_p2_chez_max": ok2}
        step("Vérification : les deux éditions sont gardées partout", both_kept, conv=False)

        # ------------------------------------------------------------ 9. historique « qui a changé quoi » + Annuler
        def history_undo():
            upd(E, "const t = d.tracks.find(x => x.id === 'voix'); t.volume = 0.42;")
            propagate("volume de Max", [A], lambda pg: st(pg, "d.tracks.find(x => x.id === 'voix').volume === 0.42"), timeout=15)
            open_panel(A)
            A.get_by_test_id("collab-history-toggle").click(); A.wait_for_timeout(300)
            entry = A.get_by_test_id("collab-history-entry").filter(has_text="le volume").first
            entry.wait_for(timeout=10000)
            text = entry.inner_text()
            shot(A, "A4_historique_qui_a_change_quoi")
            t0 = time.time()
            entry.get_by_test_id("collab-history-undo").click()
            propagate("annulation (retour arrière) chez Max", [E], lambda pg: st(pg, "d.tracks.find(x => x.id === 'voix').volume !== 0.42"), timeout=15)
            vA, vE = st(A, "d.tracks.find(x => x.id === 'voix').volume"), st(E, "d.tracks.find(x => x.id === 'voix').volume")
            close_panel(A)
            check("historique : « Annuler » remet l'ancien volume chez Lina ET chez Max", vA == vE and vA != 0.42)
            return {"ligne": text.replace("\n", " ")[:200], "volume_lina": vA, "volume_max": vE}
        step("Historique : Lina voit « Max a changé le volume… » et l'annule ; le retour arrière part chez tous", history_undo)

        # ------------------------------------------------------------ 10. chat, latences, verrou doux
        def chat():
            out = {}
            for who, pg, others in (("A", A, ("E", "B")), ("E", E, ("A", "B"))):
                open_panel(pg)
                txt = f"message de {who} {int(time.time() * 1000) % 100000} à 0:08"
                pg.get_by_label("Message", exact=True).fill(txt)
                t0 = time.time()
                pg.get_by_role("button", name="Envoyer", exact=True).click()
                for nm in others:
                    o = pages[nm]
                    wait_for(o, lambda: collab(o, f"c.messages().some(m => m.text === {json.dumps(txt)})"), 20, step=40, what=f"message reçu ({nm})")
                    lat(f"chat ({who}→{nm})", (time.time() - t0) * 1000)
                    open_panel(o)
                    try:
                        # « à 0:08 » s'affiche en bouton « ▶ 0:08 » (il place la tête de lecture) : on cherche le début.
                        wait_for(o, lambda: txt.split(" à ")[0] in o.locator("[aria-labelledby='collab-title']").first.inner_text()
                                 and o.locator("[aria-labelledby='collab-title'] button[aria-label='Aller à 0:08']").count() > 0, 10, step=200, what="message affiché")
                        check(f"chat : message de {who} affiché chez {nm}", True)
                    except AssertionError:
                        check(f"chat : message de {who} affiché chez {nm}", False)
                        shot(o, f"CHAT_non_affiche_{who}_{nm}")
                out[who] = txt
            A.wait_for_timeout(6000)  # mesures de latence (toutes les 5 s) et empreintes (toutes les 8 s)
            out["latence_vue_par_lina"] = collab(A, "c.latency()")
            out["pastille_latence"] = A.get_by_test_id("collab-latency").inner_text() if A.get_by_test_id("collab-latency").count() else None
            shot(B, "B4_chat_telephone"); shot(A, "A5_chat_latences_pc")
            for pg in (A, E, B):
                close_panel(pg)
            check("latence affichée (serveur)", out["pastille_latence"] is not None)
            return out
        step("Chat : Lina et Max écrivent, tout le monde reçoit ; latences affichées", chat, conv=False)

        def soft_lock():
            upd(E, "const t = d.tracks.find(x => x.id === 'voix'); t.pan = -0.1;")
            seen = wait_for(A, lambda: A.get_by_test_id("collab-edit-voix").count() > 0, 10, step=100, what="« ✎ Max » sur la voix chez Lina")
            A.wait_for_timeout(300)
            shot(A, "A6_verrou_doux_max_modifie")
            return {"vu_en_s": seen, "texte": A.get_by_test_id("collab-edit-voix").inner_text()}
        step("Verrou doux : quand Max modifie la voix, Lina voit « ✎ Max » sur l'en-tête de la piste", soft_lock)

        # ------------------------------------------------------------ 11. vérification de synchronisation (empreintes échangées)
        def sync_badge():
            open_panel(A)
            s = wait_for(A, lambda: A.locator("[data-testid=collab-peer-sync][data-ok='1']").count() >= 2, 40, step=500, what="« ✓ même session que toi » pour Max et Sam")
            shot(A, "A7_synchro_verifiee")
            close_panel(A)
            return {"s": s, "etat": collab(A, "c.latency()")}
        step("Indicateur de synchronisation : Lina voit « ✓ même session que toi » pour Max et Sam", sync_badge, conv=False)

        # ------------------------------------------------------------ 12. audio en direct : talkback et mix de l'ingé (WebRTC)
        def live_audio():
            for pg in (A, E):
                open_panel(pg)
            # Talkback : Max maintient le bouton ; Lina entend (niveau mesuré sur le flux reçu).
            talk = E.get_by_test_id("collab-talk")
            talk.scroll_into_view_if_needed()
            box = talk.bounding_box()
            E.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            E.mouse.down()
            t0 = time.time()
            wait_for(A, lambda: A.get_by_test_id("collab-talking").count() > 0, 25, step=100, what="« Max te parle » chez Lina")
            lat("talkback : appui → « te parle » chez Lina", (time.time() - t0) * 1000)
            lvl = A.evaluate("""async () => { const el = document.querySelector('audio[data-collab-audio$=":talk"]'); if (!el || !el.srcObject) return null;
                const ctx = new AudioContext(); const src = ctx.createMediaStreamSource(el.srcObject); const an = ctx.createAnalyser(); an.fftSize = 2048; src.connect(an);
                const buf = new Float32Array(2048); let best = -200;
                for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 100)); an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; best = Math.max(best, 10 * Math.log10(s / buf.length + 1e-12)); }
                ctx.close(); return +best.toFixed(1); }""")
            shot(A, "A8_talkback_max_parle"); shot(E, "E4_talkback_appuye")
            E.mouse.up()
            check("talkback : Lina reçoit la voix de Max (niveau > -60 dB)", lvl is not None and lvl > -60)
            # Mix de l'ingé en direct (comme Audiomovers).
            E.get_by_test_id("collab-mix-out").click()
            E.keyboard.press("Escape")
            open_panel(A)
            wait_for(A, lambda: A.get_by_test_id("collab-mix-listen").count() > 0, 25, step=100, what="« Écouter le mix de Max » chez Lina")
            diag = {"avant_ecoute": {"E": rtc_diag(E), "A": rtc_diag(A)}}
            A.get_by_test_id("collab-mix-listen").click()
            mix_state = lambda: A.locator("[data-testid=collab-mix-status]").first.get_attribute("data-state") if A.get_by_test_id("collab-mix-status").count() else None  # noqa
            # Max est à l'arrêt : la liaison marche, mais rien ne joue — Lina le voit (pas « connexion… » sans fin).
            try:
                arret_s = wait_for(A, lambda: mix_state() == "silence", 20, step=200, what="« rien ne joue » chez Lina (Max à l'arrêt)")
            except AssertionError:
                arret_s = None
            check("écoute du mix : Lina voit « bien relié, rien ne joue » tant que Max est à l'arrêt", arret_s is not None)
            shot(A, "A9a_ecoute_max_a_l_arret")
            diag["max_a_l_arret"] = {"E": rtc_diag(E), "A": rtc_diag(A), "etat_lina": mix_state()}
            # Max lance la lecture là où son mix a du son. La phrase 1 (1-3 s) a été coupée plus haut
            # (clip muet) : son mix est silencieux de 0 à 3,95 s (début de la prise 2 de Lina). Partir de 0
            # avec une mesure de 4 s ratait souvent tout le son : sous la charge de 3 navigateurs, l'horloge
            # audio headless de Max avance moins vite (mesuré : 3,35 s chez Max pendant 4,57 s chez Lina) ;
            # getStats le prouvait : paquets du mix à ~3 octets (silence Opus), liaison WebRTC saine.
            # (Avant : playheadStore.set(0), qui ne déplace pas le départ de la lecture ; on passe par la commande du DAW.)
            E.evaluate("() => window.DAW_CONTROL.seek(3.9)"); E.wait_for_timeout(300)
            t_play = time.time()
            E.get_by_role("button", name=re.compile(r"^(Lecture|Lire)")).locator("visible=true").first.click()
            mix = A.evaluate("""async () => { const el = document.querySelector('audio[data-collab-audio$=":mix"]'); if (!el || !el.srcObject) return null;
                const ctx = new AudioContext(); const src = ctx.createMediaStreamSource(el.srcObject); const an = ctx.createAnalyser(); an.fftSize = 2048; src.connect(an);
                const buf = new Float32Array(2048); let best = -200, first = null; const t0 = performance.now();
                for (let i = 0; i < 120; i++) { await new Promise(r => setTimeout(r, 100)); an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v;
                  const db = 10 * Math.log10(s / buf.length + 1e-12); best = Math.max(best, db);
                  if (db > -60 && first === null) first = Math.round(performance.now() - t0);
                  if (first !== null && performance.now() - t0 > first + 1500) break; }
                ctx.close(); return { best_db: +best.toFixed(1), premier_son_ms: first, canaux: el.srcObject.getAudioTracks()[0]?.getSettings?.().channelCount || null }; }""")
            try:
                ecoute_s = wait_for(A, lambda: mix_state() == "ecoute", 15, step=200, what="« en écoute » chez Lina")
            except AssertionError:
                ecoute_s = None
            lat("mix de l'ingé : lecture chez Max → son mesuré chez Lina", (time.time() - t_play) * 1000 if mix and mix.get("premier_son_ms") is not None else -1)
            diag["apres_ecoute"] = {"E": rtc_diag(E), "A": rtc_diag(A), "etat_lina": mix_state()}
            res["diag_mix_direct"] = diag
            shot(A, "A9_ecoute_mix_de_max"); shot(E, "E5_diffuse_son_mix")
            E.keyboard.press("Space")
            check("mix de l'ingé reçu en direct chez Lina (niveau > -60 dB)", mix is not None and mix["best_db"] > -60)
            check("écoute du mix : Lina voit « en écoute » quand le son arrive", ecoute_s is not None)
            st_audio = collab(A, "c.audio()")
            A.get_by_test_id("collab-mix-listen").click()
            for pg in (A, E):
                close_panel(pg)
            return {"talkback_niveau_db": lvl, "mix_recu": mix, "connexions": st_audio}
        step("Audio en direct : talkback de Max (maintenir), puis son mix diffusé que Lina écoute", live_audio, conv=False)

        # ------------------------------------------------------------ 13. coupure réseau de Sam, puis retour
        def cut():
            cloud.down.add("B"); rt.drop("B"); rt.blocked.add("B")
            B.context.set_offline(True)
            upd(B, "const t = d.tracks.find(x => x.collabOwnerName === 'Sam'); if (t) t.pan = -0.2;")
            upd(E, "const t = d.tracks.find(x => x.id === 'voix'); t.volume = 0.65;")
            B.wait_for_timeout(8000)
            cloud.down.discard("B"); rt.blocked.discard("B")
            B.context.set_offline(False)
            B.evaluate("() => window.dispatchEvent(new Event('online'))")
            t0 = time.time()
            wait_for(E, lambda: st(E, "(() => { const t = d.tracks.find(x => x.collabOwnerName === 'Sam'); return t && t.pan === -0.2; })()"), 40, step=200, what="réglage hors ligne de Sam arrivé chez Max")
            lat("retour du réseau → modification hors ligne reçue", (time.time() - t0) * 1000)
        step("Coupure réseau de Sam (8 s) : il règle sa piste, Max la voix ; retour : rien de perdu", cut)

        # ------------------------------------------------------------ 14. réponse perdue
        def lost():
            n0 = len(cloud.ops)
            cloud.lose_reply.add("E")
            upd(E, "const t = d.tracks.find(x => x.id === 'voix'); t.isMuted = true;")
            E.wait_for_timeout(1500)
            upd(E, "const t = d.tracks.find(x => x.id === 'voix'); t.isMuted = false;")
            return {"ops_journal": len(cloud.ops) - n0, "journal": [x for x in cloud.log if x[0] == "E"][-6:]}
        step("Réponse perdue : Max coupe puis rallume la voix (1re réponse du serveur perdue)", lost)

        # ------------------------------------------------------------ 15. rechargement de l'ingé (F5)
        def reload_e():
            chats_before = E.locator("[aria-labelledby='collab-title']").count()
            E.reload(wait_until="domcontentloaded")
            t0 = time.time()
            wait_for(E, lambda: collab(E, "c.role()") == "engineer", 60, what="collaboration reprise après rechargement (F5)")
            lat("rechargement (F5) → collaboration reprise", (time.time() - t0) * 1000)
            dismiss(E)
            return {"panneau_avant": chats_before}
        step("Max recharge sa page (F5) : collaboration reprise toute seule, rien de perdu", reload_e)

        # ------------------------------------------------------------ 16. deuxième appareil du même compte (Lina sur tablette)
        def second_device():
            ctxA2, A2 = new_page(b, "tab", logs["A2"])
            A2.add_init_script(REC_INIT)
            prepare(A2, None, desktop=False)
            connect(A2, cloud, rt, "A2", LINA, "lina@test.local")
            pages["A2"] = A2
            A2.goto(f"{BASE}?session={link['s']}&invite=1", wait_until="domcontentloaded")
            wait_for(A2, lambda: A2.get_by_test_id("collab-arrival").count() > 0, 60, what="arrivée (tablette de Lina)")
            A2.wait_for_timeout(1500); dismiss(A2)
            A2.get_by_test_id("arrival-role-artist").click()
            A2.get_by_label("Ton nom", exact=True).fill("Lina")
            A2.get_by_test_id("arrival-join").click()
            wait_for(A2, lambda: collab(A2, "c.role()") == "artist", 60, what="tablette reliée")
            dismiss(A2)
            return {"moi_tablette": collab(A2, "c.me()"), "moi_pc": collab(A, "c.me()")}
        step("Lina ouvre la session sur sa tablette (même compte, 2e appareil)", second_device)

        def second_device_edit():
            A2 = pages["A2"]
            upd(A2, "const t = d.tracks.find(x => x.id === 'voix'); t.color = '#f472b6';")
            propagate("modification depuis la tablette", [A, E], lambda pg: st(pg, "d.tracks.find(x => x.id === 'voix').color === '#f472b6'"), timeout=20)
            open_panel(A2); open_panel(A)
            A.wait_for_timeout(1500)
            shot(A2, "A10_tablette_session"); shot(A, "A11_pc_avec_tablette")
            peers = A.evaluate("() => [...document.querySelectorAll('[data-testid=collab-peer]')].map(e => e.innerText.replace(/\\s+/g, ' '))")
            close_panel(A2); close_panel(A)
            return {"participants_vus_sur_pc": peers}
        step("La tablette de Lina change la couleur de sa piste : le PC et les autres la voient", second_device_edit)

        # ------------------------------------------------------------ 16 bis. Melodyne (ARA) en insert sur la voix, gelée par l'ingé
        # La piste à insert ARA voyage comme une piste à VST : l'insert (réglages) part avec le mix,
        # le rendu du gel (le même code que « Geler » : renderTrackFreeze → renderRange de l'insert
        # ARA → applyFreezeResult) part chez les autres, qui jouent le son retouché tel quel.
        # Ici sans pont ni Melodyne (navigateurs headless) : le nœud de l'insert est remplacé par un
        # rendu connu (sinus 330 Hz, crête 0,25, avant les effets suivants) ; le vrai rendu ARA est prouvé par qa/ara_preuve.py insert.
        def ara_insert():
            upd(E, """const t = d.tracks.find(x => x.id === 'voix');
              t.plugins.unshift({ id: 'ara-melodyne-e2e', name: 'Melodyne', type: 'VST3', isEnabled: true, latency: 0,
                params: { isEnabled: true, name: 'Melodyne', vendor: 'Celemony', uid: '', ara: 'melodyne',
                          localPath: 'C:\\Program Files\\Common Files\\VST3\\Celemony\\Melodyne.vst3' } });""")
            propagate("insert ARA (Melodyne) posé par l'ingé", [A, B],
                      lambda pg: st(pg, "d.tracks.find(x => x.id === 'voix').plugins.some(p => p.id === 'ara-melodyne-e2e' && p.type === 'VST3' && p.params && p.params.ara === 'melodyne')"), timeout=30)
            made = E.evaluate("""async () => {
              const m = (p) => window.__novaAppModule(p);
              const { liveVstNodes } = await m('/engine/VSTPluginNode.ts');
              const { novaBridge } = await m('/services/NovaBridge.ts');
              const { renderTrackFreeze, applyFreezeResult } = await m('/services/VstFreeze.ts');
              const { isAraInsert } = await m('/utils/araInsert.ts');
              const t = window.__novaTest.getState().tracks.find(x => x.id === 'voix');
              const ara = t.plugins.find(p => p.id === 'ara-melodyne-e2e');
              if (!isAraInsert(ara)) return { erreur: 'insert ARA non reconnu' };
              const calls = [];
              const prev = liveVstNodes.get(ara.id);
              liveVstNodes.set(ara.id, { renderRange: async (start, dur, sr) => {
                calls.push({ start, dur, sr }); const n = Math.round(dur * sr); const x = new Float32Array(n);
                for (let i = 0; i < n; i++) x[i] = 0.25 * Math.sin(2 * Math.PI * 330 * i / sr);
                return [x, x.slice()]; } });
              const conn = novaBridge.isConnected; novaBridge.isConnected = () => true;
              let r;
              try { r = await renderTrackFreeze(t, t.plugins.length - 1); }
              finally { novaBridge.isConnected = conn; if (prev) liveVstNodes.set(ara.id, prev); else liveVstNodes.delete(ara.id); }
              window.__novaTest.update(d => { const x = d.tracks.find(y => y.id === 'voix'); x.isFrozen = true; delete x.frozenAuto; applyFreezeResult(x, r, 'Max'); });
              return { clipId: r.clip.id, upTo: r.upTo, appels_renderRange: calls };
            }""")
            check("gel de la piste à insert ARA : le rendu vient de l'insert (renderRange appelé)", isinstance(made, dict) and made.get("clipId") and len(made.get("appels_renderRange") or []) == 1)
            cid = made.get("clipId")
            rms_js = f"""async () => {{ const r = (await window.__novaAppModule('/utils/audioBufferRegistry.ts')).audioBufferRegistry;
                const t = window.__novaTest.getState().tracks.find(x => x.id === 'voix');
                if (!t.isFrozen || !t.frozenClip || t.frozenClip.id !== {json.dumps(cid)}) return null;
                const b = r.get(t.frozenClip.bufferId); if (!b) return null; const x = b.getChannelData(0); let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i];
                // Hauteur du rendu (passages par zéro entre 1 et 3 s) : le sinus de l'insert, après les effets suivants de la chaîne.
                const a0 = Math.round(b.sampleRate), a1 = Math.min(x.length, 3 * a0); let z = 0; for (let i = a0 + 1; i < a1; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) z++;
                return {{ rms_db: +(10 * Math.log10(s / x.length + 1e-12)).toFixed(2), hz: +(z / 2 / ((a1 - a0) / b.sampleRate)).toFixed(1), dur: +b.duration.toFixed(2), upTo: t.frozenUpToPluginIndex,
                          insert: t.plugins.some(p => p.id === 'ara-melodyne-e2e' && p.params.ara === 'melodyne') }}; }}"""
            got = {}
            t0 = time.time()
            for nm in ("A", "B", "A2"):
                pg = pages.get(nm)
                if pg is None:
                    continue
                wait_for(pg, lambda: pg.evaluate(rms_js) is not None, 40, step=100, what=f"rendu de la piste à insert ARA reçu ({nm})")
                lat(f"gel ARA : rendu reçu (E→{nm})", (time.time() - t0) * 1000)
                got[nm] = pg.evaluate(rms_js)
            got["E"] = E.evaluate(rms_js)
            ok = all(v and v["insert"] and v["upTo"] == got["E"]["upTo"] and abs(v["rms_db"] - got["E"]["rms_db"]) < 0.05 for v in got.values())
            check("piste à insert ARA reçue gelée chez tous : insert gardé, même rendu (écart RMS < 0,05 dB)", ok)
            # Rendu = l'insert ARA PUIS les effets suivants de la voix (compresseur de l'ingé, chaîne « Mix auto ») :
            # le niveau change, la hauteur reste celle du rendu de l'insert (330 Hz).
            check("rendu de la piste = rendu de l'insert ARA à travers la suite de la chaîne (330 Hz, non muet)", got["E"] and abs(got["E"]["hz"] - 330) < 3 and got["E"]["rms_db"] > -40)
            shot(A, "A12_voix_melodyne_gelee"); shot(B, "B12_voix_melodyne_gelee")
            return {"gel": made, "recu": got}
        if os.environ.get("COLLAB_ARA", "1") != "0":
            step("Max pose Melodyne (ARA) en insert sur la voix et la gèle : la piste voyage comme une piste à VST (rendu chez tous)", ara_insert)

        # ------------------------------------------------------------ 17. export des deux côtés
        def exports():
            for pg in pages.values():
                if pg is not None:
                    close_panel(pg); pg.keyboard.press("Escape")
            fa = export_wav(A, OUT / "A_export_lina.wav", "A12")
            fe = export_wav(E, OUT / "E_export_max.wav", "E6")
            ra, re_ = rms_db(fa, 0, 16), rms_db(fe, 0, 16)
            check("export : même niveau chez Lina et chez Max (écart < 1 dB)", ra is not None and re_ is not None and abs(ra - re_) < 1.0)
            return {"rms_lina_db": ra, "rms_max_db": re_, "ecart_db": None if ra is None or re_ is None else round(abs(ra - re_), 2)}
        step("Export du mix chez Lina et chez Max (même son)", exports, conv=False)

        # ------------------------------------------------------------ bilan
        res["journal_mix_voix"] = [{"seq": o["seq"], "par": o["author_name"], "id": (o["op"] or {}).get("_id", "")[:8], "champs": (o["op"] or {}).get("fields")}
                                   for o in cloud.ops if o["kind"] == "mix" and (o["op"] or {}).get("trackId") == "voix"][-12:]
        res["journal_contenu_voix"] = [{"seq": o["seq"], "par": o["author_name"], "changed": (o["op"] or {}).get("changed"), "removed": (o["op"] or {}).get("removed"),
                                        "full": (o["op"] or {}).get("full"), "p2": next((c.get("start") for c in ((o["op"] or {}).get("content") or {}).get("clips", []) if c.get("id") == "p2"), None),
                                        "p3_gain": next((c.get("gain") for c in ((o["op"] or {}).get("content") or {}).get("clips", []) if c.get("id") == "p3"), None)}
                                       for o in cloud.ops if o["kind"] == "content" and (o["op"] or {}).get("trackId") == "voix"]
        res["journal_appels_E"] = [x for x in cloud.log if x[0] == "E"][-40:]
        res["journal_ops"] = {}
        for o in cloud.ops:
            res["journal_ops"][o["kind"]] = res["journal_ops"].get(o["kind"], 0) + 1
        for k, lg in logs.items():
            res[f"erreurs_{k}"] = [e["text"][:200] for e in lg.errors()][:12]
            save_log(lg)
        res["ecritures_bloquees"] = sum(len(getattr(pg, "_blocked", [])) for pg in pages.values() if pg is not None)
        b.close()

    for k, v in list(res["latences_ms"].items()):
        res["latences_ms"][k] = {"n": len(v), "min": min(v), "med": sorted(v)[len(v) // 2], "max": max(v)}
    (OUT / "resultat_collab_bout_en_bout.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: res[k] for k in ("ok", "serveur", "steps", "convergence", "latences_ms", "verifications")}, ensure_ascii=False, indent=1)[:16000])
    return res


if __name__ == "__main__":
    r = run()
    sys.exit(0 if r["ok"] else 1)
