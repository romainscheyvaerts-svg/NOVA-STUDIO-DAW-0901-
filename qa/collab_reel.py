"""Collaboration contre le VRAI backend (Supabase de production, Realtime compris).

À LANCER PLUS TARD, par Romain, avec deux comptes de test. Ce script ÉCRIT dans
la base de production (projet Supabase mxdrxpzxbgybchzzvpkf, « MAKE MUSIC
BOOKING ») : il ne part qu'avec --reel ET --je-confirme-ecriture-en-production,
et nettoie derrière lui (voir plus bas). Pour répéter le scénario sans rien
toucher, --simule le joue contre les simulateurs (qa/collab_sim.py).

Deux navigateurs headless (aucune fenêtre) : l'ARTISTE et l'INGÉ, chacun
connecté à SON compte Make Music. Les ponts VST restent simulés (aucun VST réel
n'est nécessaire) ; tout le reste est réel : fonction daw-session, journal des
opérations, stockage de l'audio (bucket daw-sessions), Supabase Realtime
(diffusion + présence).

Scénario :
  En direct
    D1  l'artiste ouvre une session et démarre « En direct » (session mise en ligne)
    D2  l'ingé ouvre le lien d'invitation : relié, présence des deux côtés,
        direct Realtime « en direct » des deux côtés
    D3  latence du direct : l'ingé coupe le son de la piste → reçu chez l'artiste
        (< 3 s attendu ; au-delà de 9 s, c'est le rattrapage : direct inopérant)
    D4  chat dans les deux sens
    D5  l'ingé règle le VST de l'artiste (Output -12 dB) → relu sur son pont,
        aperçu rendu chez l'artiste, envoyé par le vrai stockage, joué chez l'ingé
    D6  coupure réseau de l'ingé (navigateur hors ligne) : état « Hors ligne »,
        message gardé, parti au retour ; Realtime reconnecté
    D7  page de l'ingé rouverte : la collaboration reprend toute seule
  Ingé à distance
    R1  l'artiste crée le lien, l'ingé s'y relie (présence)
    R2  piste envoyée (audio réel en ligne), gelée chez l'ingé avec son VST
        (simulé), renvoyée, reçue par l'artiste
    R3  l'artiste remplace la phrase 2 par sa prise 2 : aller-retour automatique
  Nettoyage
    chaque session créée (lien compris) est supprimée par l'action « delete »
    de daw-session (compte de l'artiste, propriétaire) : ligne daw_sessions,
    membres et journal (cascade), fichiers audio du bucket.

Ce qu'il faut (mode réel) :
  - deux comptes Make Music de test (site studiomakemusic.com), e-mail
    confirmé, chacun avec l'abonnement collaboration actif (table
    nova_subscriptions, plan « collab », statut active/trialing) — ou le rôle
    admin (table user_roles) qui en dispense. Sur la branche « tarifs », c'est
    Nova Pro qui est demandé.
  - variables d'environnement :
      NOVA_TEST_ARTISTE_EMAIL, NOVA_TEST_ARTISTE_MDP
      NOVA_TEST_INGE_EMAIL,    NOVA_TEST_INGE_MDP
      NOVA_URL (défaut http://127.0.0.1:4020/ : serveur de dev du dépôt NOVA,
                origine localhost autorisée par daw-session)
  - Realtime actif sur le projet, canaux publics autorisés (le client NOVA
    n'utilise pas de canal privé).

Usage :
  python qa/collab_reel.py --simule
  QA_ALLOW_PROD=1 python qa/collab_reel.py --reel --je-confirme-ecriture-en-production
  (sans QA_ALLOW_PROD=1, qa_hors_prod bloque toute requête vers *.supabase.co)
  python qa/collab_reel.py --nettoyer <id.secret> [...]   (sessions restées en ligne)
"""
import argparse, json, os, re, sys, time, urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-collab-durcissement\reel")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:4020/")
from qalib import *  # noqa
from gel_pre_effet import FakeBridge, prepare, open_project_file, export_wav, rms_db, COMP_PATH  # noqa
from collab_sim import FakeNovaCloud, FakeRealtime, FakeBridgeV7, connect as connect_simule, SUPA  # noqa
from collab_direct import artist_project as direct_project, dismiss, wait_for, collab, open_panel, panel_text  # noqa
from remplacer_prise import artist_project as prises_project  # noqa
from mode_inge import engineer_project, panel, text_of, click_track, side_tab, close_plugin_window  # noqa

ANON = ("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14ZHJ4cHp4Ymd5YmNoenp2cGtmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1"
        "MTcwOTUsImV4cCI6MjA4NDA5MzA5NX0.pbO4Cd_7TWE6M_eP0vWeeJio8ZYdqSkqxEuTShKkG40")  # clé publique (anon), déjà dans services/supabase.ts
AUTH_KEY = "sb-mxdrxpzxbgybchzzvpkf-auth-token"


# ------------------------------------------------------------ backend réel
def http(method, url, body=None, token=None):
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"apikey": ANON, "Content-Type": "application/json", "Authorization": f"Bearer {token or ANON}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode() or "null")


def login(email, password):
    s = http("POST", f"{SUPA}/auth/v1/token?grant_type=password", {"email": email, "password": password})
    if not s or not s.get("access_token"):
        raise SystemExit(f"Connexion impossible pour {email}")
    return s


def check_plan(session, who):
    st = http("POST", f"{SUPA}/functions/v1/nova-billing", {"action": "status"}, session["access_token"])
    ok = bool(st.get("admin")) or any(p.get("plan") in ("collab", "pro") for p in st.get("plans") or [])
    if not ok:
        raise SystemExit(f"Le compte de test « {who} » n'a pas l'abonnement collaboration (ni le rôle admin) : {json.dumps(st)[:200]}")
    return st


def delete_session(link, token):
    sid, secret = link.split(".", 1)
    return http("POST", f"{SUPA}/functions/v1/daw-session", {"action": "delete", "id": sid, "secret": secret}, token)


class RealEnv:
    """Pages connectées au vrai backend ; seules les écritures vers Supabase et NOVA passent."""
    simulated = False

    def __init__(self):
        need = ["NOVA_TEST_ARTISTE_EMAIL", "NOVA_TEST_ARTISTE_MDP", "NOVA_TEST_INGE_EMAIL", "NOVA_TEST_INGE_MDP"]
        miss = [k for k in need if not os.environ.get(k)]
        if miss:
            raise SystemExit(f"Variables manquantes : {', '.join(miss)}")
        self.sessions = {"A": login(os.environ["NOVA_TEST_ARTISTE_EMAIL"], os.environ["NOVA_TEST_ARTISTE_MDP"]),
                         "E": login(os.environ["NOVA_TEST_INGE_EMAIL"], os.environ["NOVA_TEST_INGE_MDP"])}
        self.plans = {k: check_plan(v, k) for k, v in self.sessions.items()}
        self.created = []  # (lien, tag)

    def page(self, browser, tag, log, setup=None):
        ctx = browser.new_context(viewport=VIEWPORTS["pc"], permissions=["microphone"], accept_downloads=True, locale="fr-BE")
        allowed = (BASE.rstrip("/"), SUPA, "data:", "blob:")
        blocked = []

        def guard(route, request):
            if request.method in WRITE_METHODS and not request.url.startswith(allowed):
                blocked.append(f"{request.method} {request.url[:140]}")
                return route.abort()
            return route.continue_()
        ctx.route("**/*", guard)
        page = ctx.new_page()
        page.set_default_timeout(15000)
        if setup:
            setup(page)
        page.on("console", lambda m: log.add(f"console.{m.type}", m.text) if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: log.add("pageerror", e))

        def on_response(r):
            if "/functions/v1/daw-session" not in r.url or r.request.method != "POST":
                return
            try:
                if json.loads(r.request.post_data or "{}").get("action") == "create" and r.status == 200:
                    j = r.json()
                    self.created.append((f"{j['id']}.{j['secret']}", tag))
                    log.add("session-creee", j["id"])
            except Exception:
                pass
        page.on("response", on_response)
        s = self.sessions[tag]
        page.add_init_script(f"try {{ localStorage.setItem('{AUTH_KEY}', {json.dumps(json.dumps(s))}); localStorage.setItem('nova_simple_mode', '0'); }} catch (e) {{}}")
        page._blocked = blocked
        return ctx, page

    def go_offline(self, ctx, tag):
        ctx.set_offline(True)

    def go_online(self, ctx, tag):
        ctx.set_offline(False)

    def cleanup(self):
        out = []
        for link, tag in self.created:
            try:
                delete_session(link, self.sessions["A"]["access_token"])
                out.append({"session": link.split(".")[0], "supprimee": True})
            except Exception as e:  # noqa
                out.append({"session": link.split(".")[0], "supprimee": False, "erreur": str(e)[:200], "a_nettoyer": f"python qa/collab_reel.py --nettoyer {link}"})
        return out


class SimEnv:
    """Même scénario contre les simulateurs (rien ne sort)."""
    simulated = True

    def __init__(self):
        self.cloud, self.rt = FakeNovaCloud(), FakeRealtime()
        self.ids = {"A": "11111111-1111-4111-8111-111111111111", "E": "22222222-2222-4222-8222-222222222222"}
        self.created = []

    def page(self, browser, tag, log, setup=None):
        ctx, page = new_page(browser, "pc", log)
        if setup:
            setup(page)
        connect_simule(page, self.cloud, self.rt, tag, self.ids[tag], f"{tag.lower()}@test.local")
        return ctx, page

    def go_offline(self, ctx, tag):
        self.cloud.down.add(tag); self.rt.blocked.add(tag); self.rt.drop(tag)

    def go_online(self, ctx, tag):
        self.cloud.down.discard(tag); self.rt.blocked.discard(tag)

    def cleanup(self):
        return [{"session": k, "supprimee": "(simulée)"} for k in self.cloud.sessions]


# ------------------------------------------------------------ scénario
def run(env):
    res = {"name": "collab_reel", "mode": "simulé" if env.simulated else "RÉEL (production)", "ok": True, "steps": [], "mesures": {}}
    src_direct = OUT / "00_direct.novaproj.zip"; direct_project(src_direct)
    src_prises = OUT / "00_prises.novaproj.zip"; prises_project(src_prises)
    src_inge = OUT / "00_inge.novaproj.zip"; engineer_project(src_inge)
    st = {}

    def step(label, fn):
        t = time.time()
        try:
            o = fn()
            res["steps"].append({"step": label, "ok": True, "s": round(time.time() - t, 1), **({"info": o} if o else {})})
        except Exception as e:  # noqa
            res["ok"] = False
            res["steps"].append({"step": label, "ok": False, "err": f"{type(e).__name__}: {str(e)[:500]}"})
            # Captures d'échec (les deux côtés) pour comprendre sans relancer.
            for tag, pg in (("A", pages.get("A")), ("E", pages.get("E"))):
                try:
                    if pg: shot(pg, f"ECHEC_{label[:2]}_{tag}")
                except Exception:
                    pass

    pages = {}
    with sync_playwright() as p:
        b = launch(p)
        logA, logE = Log("reel_artiste"), Log("reel_inge")
        bridgeA, bridgeE = FakeBridgeV7(), FakeBridge()
        # Pont VST simulé AVANT la connexion du compte : chaque page garde SON compte
        # (un même compte des deux côtés écraserait le rôle sur le serveur).
        ctxA, A = env.page(b, "A", logA, lambda pg: prepare(pg, bridgeA, desktop=True, login=False))
        ctxE, E = env.page(b, "E", logE, lambda pg: prepare(pg, bridgeE, desktop=True, login=False))
        pages.update(A=A, E=E)
        try:
            # ---------------- En direct
            def d1():
                open_project_file(A, src_direct, res, "D1_artiste_session")
                dismiss(A)
                wait_for(A, lambda: any(s.get("path") == COMP_PATH for s in bridgeA.slots.values()), 30, what="VST chargé chez l'artiste")
                open_panel(A)
                A.get_by_placeholder("Ton nom (affiché aux autres)").fill("Artiste test")
                A.get_by_role("button", name=re.compile("Démarrer la collaboration en direct")).click()
                wait_for(A, lambda: collab(A, "c.role()") == "artist", 90, what="collaboration ouverte")
                st["sid"] = A.evaluate("() => { try { return JSON.parse(localStorage.getItem('nova_cloud_session')) } catch (e) { return null } }")
                shot(A, "D1_en_direct_ouvert")
                return {"session": (st["sid"] or {}).get("id")}
            step("D1 artiste : « En direct » démarré (session réelle mise en ligne)", d1)

            def d2():
                s = st["sid"]
                E.goto(f"{BASE}?session={s['id']}.{s['secret']}&role=engineer", wait_until="domcontentloaded")
                wait_for(E, lambda: collab(E, "c.role()") == "engineer", 90, what="ingé relié")
                dismiss(E); open_panel(E); open_panel(A)
                t = wait_for(E, lambda: E.get_by_test_id("collab-members").locator("span.rounded-full").count() >= 2 and A.get_by_test_id("collab-members").locator("span.rounded-full").count() >= 2, 30, what="présence Realtime des deux côtés")
                wait_for(E, lambda: collab(E, "c.status().realtime") == "live" and collab(A, "c.status().realtime") == "live", 30, what="direct Realtime « live » des deux côtés")
                shot(E, "D2_inge_present"); shot(A, "D2_artiste_voit_l_inge")
                return {"presence_s": t}
            step("D2 ingé : relié, présence et direct Realtime des deux côtés", d2)

            def d3():
                E.keyboard.press("Escape")
                mute = E.get_by_role("button", name="Muet : Voix lead").locator("visible=true").first
                t0 = time.time(); mute.click()
                wait_for(A, lambda: collab(A, "c.track('Voix lead')")["isMuted"] is True, 30, step=100, what="mix reçu chez l'artiste")
                lat = round(time.time() - t0, 2)
                res["mesures"]["latence_direct_s"] = lat
                mute.click()
                wait_for(A, lambda: collab(A, "c.track('Voix lead')")["isMuted"] is False, 30, step=100, what="son rendu")
                if lat > 9:
                    raise AssertionError(f"reçu en {lat} s : par le rattrapage (10 s), pas par le direct Realtime")
                return {"latence_s": lat}
            step("D3 latence du direct (mix de l'ingé reçu par Realtime)", d3)

            def d4():
                open_panel(A); A.get_by_label("Message").fill("Salut, c'est l'artiste"); A.get_by_role("button", name="Envoyer").click()
                open_panel(E); wait_for(E, lambda: "c'est l'artiste" in panel_text(E), 20, what="chat artiste → ingé")
                E.get_by_label("Message").fill("Bien reçu, c'est l'ingé"); E.get_by_role("button", name="Envoyer").click()
                wait_for(A, lambda: "c'est l'ingé" in panel_text(A), 20, what="chat ingé → artiste")
            step("D4 chat dans les deux sens", d4)

            def d5():
                open_panel(E)
                E.get_by_role("button", name="Lire ses réglages").click()
                wait_for(E, lambda: E.get_by_label("Valeur de Output").count() > 0, 60, what="réglages lus")
                before = (collab(E, "c.track('Voix lead')")["livePreview"] or {}).get("renderId")
                E.get_by_label("Valeur de Output").fill("-12")
                t0 = time.time()
                E.get_by_label("Valeur de Output").locator("xpath=..").get_by_role("button", name="Régler").click()
                wait_for(E, lambda: (collab(E, "c.track('Voix lead')")["livePreview"] or {}).get("renderId") not in (None, before), 90, step=250, what="aperçu reçu")
                res["mesures"]["reglage_vers_apercu_s"] = round(time.time() - t0, 1)
                shot(E, "D5_apercu_a_jour")
                return {"apercu": E.get_by_test_id("live-preview").inner_text()[:200]}
            step("D5 réglage d'un VST de l'artiste + aperçu par le vrai stockage", d5)

            def d6():
                env.go_offline(ctxE, "E")
                open_panel(E)
                E.get_by_label("Message").fill("Message écrit hors ligne"); E.get_by_role("button", name="Envoyer").click()
                wait_for(E, lambda: "Hors ligne" in panel_text(E), 40, what="état « Hors ligne »")
                shot(E, "D6_hors_ligne")
                env.go_online(ctxE, "E")
                t0 = time.time()
                if E.get_by_test_id("collab-status-action").count():
                    E.get_by_test_id("collab-status-action").click()
                wait_for(A, lambda: "écrit hors ligne" in panel_text(A), 40, what="message parti au retour")
                wait_for(E, lambda: collab(E, "c.status().realtime") == "live", 40, what="direct reconnecté")
                res["mesures"]["retour_reseau_s"] = round(time.time() - t0, 1)
            step("D6 coupure réseau de l'ingé : « Hors ligne », message gardé puis parti, direct reconnecté", d6)

            def d7():
                s = st["sid"]
                E.goto(f"{BASE}?session={s['id']}.{s['secret']}", wait_until="domcontentloaded")
                t = wait_for(E, lambda: collab(E, "c.role()") == "engineer", 90, what="reprise automatique")
                shot(E, "D7_reprise")
                return {"reprise_s": t}
            step("D7 page de l'ingé rouverte : la collaboration reprend toute seule", d7)

            def d8():
                for pg in (E, A):
                    open_panel(pg)
                    pg.get_by_role("button", name="Quitter la collaboration").click(); pg.wait_for_timeout(800)
            step("D8 les deux quittent la collaboration", d8)

            # ---------------- Ingé à distance
            def r1():
                open_project_file(A, src_prises, res, "R1_artiste_deux_prises"); dismiss(A)
                open_collab_remote(A, "artist")
                A.get_by_test_id("remote-invite").wait_for(timeout=60000)
                st["invite"] = A.get_by_test_id("remote-invite").input_value()
                open_project_file(E, src_inge, res, "R1_inge_session"); dismiss(E)
                open_collab_remote(E, "engineer", st["invite"])
                E.get_by_test_id("remote-panel").wait_for(timeout=60000)
                wait_for(A, lambda: "est connecté" in text_of(A, "remote-peer"), 40, what="présence dans le lien")
                shot(A, "R1_lien_relie")
            step("R1 lien « Ingé à distance » créé et relié (présence)", r1)

            def r2():
                panel(A); A.get_by_test_id("remote-send-voix").click()
                wait_for(E, lambda: E.get_by_test_id("remote-row-voix").count() > 0, 90, what="piste reçue (audio réel)")
                click_track(E, "Voix lead"); side_tab(E, "VST")
                E.locator("[data-vst-plugin='NovaTestComp']").first.click(); E.wait_for_timeout(1500); close_plugin_window(E)
                panel(E); E.get_by_test_id("remote-return-voix").click()
                wait_for(E, lambda: "Envoyée à l'artiste" in text_of(E, "remote-status-voix"), 120, what="gel + envoi")
                panel(A); wait_for(A, lambda: A.get_by_test_id("remote-receive-voix").count() > 0, 90, what="réglages prêts")
                A.get_by_test_id("remote-receive-voix").click()
                wait_for(A, lambda: "Mise à jour reçue" in text_of(A, "remote-status-voix"), 60, what="réglages appliqués")
                shot(A, "R2_recu")
            step("R2 piste envoyée, gelée chez l'ingé, renvoyée, reçue", r2)

            def r3():
                A.keyboard.press("Escape")
                A.locator("[data-nova-target='mix-auto']").locator("visible=true").first.click(); A.wait_for_timeout(800)
                sel = A.locator("select").filter(has=A.locator("option", has_text="Toute la prise")).first
                opts = sel.locator("option").all_inner_texts()
                sel.select_option(value=sel.locator("option").nth(next(i for i, t in enumerate(opts) if t.startswith("Phrase 2"))).get_attribute("value"))
                A.get_by_role("button", name="Garder", exact=True).first.click(); A.keyboard.press("Escape")
                t0 = time.time()
                panel(A)
                wait_for(A, lambda: "Chez l'ingé" in text_of(A, "remote-status-voix") or "Envoi" in text_of(A, "remote-status-voix"), 40, step=200, what="renvoi automatique")
                wait_for(A, lambda: "Mise à jour reçue" in text_of(A, "remote-status-voix"), 180, what="aller-retour automatique")
                res["mesures"]["aller_retour_auto_s"] = round(time.time() - t0, 1)
                shot(A, "R3_aller_retour")
            step("R3 prise 2 gardée sur la phrase 2 : aller-retour automatique", r3)

            def r4():
                for pg in (E, A):
                    panel(pg); pg.get_by_role("button", name="Quitter le lien").click(); pg.wait_for_timeout(600)
            step("R4 les deux quittent le lien", r4)
        finally:
            res["A_erreurs"] = [e["text"][:200] for e in logA.errors()][:12]
            res["E_erreurs"] = [e["text"][:200] for e in logE.errors()][:12]
            res["ecritures_bloquees"] = (A._blocked + E._blocked)[:20]
            save_log(logA); save_log(logE)
            ctxA.close(); ctxE.close(); b.close()
            res["nettoyage"] = env.cleanup()
    (OUT / f"resultat_collab_reel_{'simule' if env.simulated else 'reel'}.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: res[k] for k in ("mode", "ok", "steps", "mesures", "nettoyage")}, ensure_ascii=True, indent=1)[:9000])
    return res


def open_collab_remote(page, role, link=None):
    b = page.get_by_role("button", name=re.compile(r"(Collaborer|Ingé à distance( · en ligne)?|en ligne · Chat)$")).locator("visible=true").first
    b.click(); page.wait_for_timeout(600)
    page.get_by_test_id("collab-mode-remote").click(); page.wait_for_timeout(200)
    if role == "engineer":
        page.get_by_test_id("collab-role").select_option("engineer"); page.wait_for_timeout(200)
        page.get_by_test_id("remote-link-input").fill(link)
    page.get_by_test_id("remote-start").click()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Collaboration NOVA contre le vrai backend (ou simulé)")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--simule", action="store_true", help="répétition contre les simulateurs (rien ne sort)")
    g.add_argument("--reel", action="store_true", help="contre la production (écrit dans Supabase, nettoie ensuite)")
    g.add_argument("--nettoyer", nargs="+", metavar="ID.SECRET", help="supprime des sessions de test restées en ligne")
    ap.add_argument("--je-confirme-ecriture-en-production", dest="confirm", action="store_true")
    a = ap.parse_args()
    # QA hors production (qa_hors_prod) : la production n'est joignable qu'avec QA_ALLOW_PROD=1,
    # et seulement pour --reel / --nettoyer, qui exigent déjà un GO explicite.
    if (a.reel or a.nettoyer) and os.environ.get("QA_ALLOW_PROD") != "1":
        raise SystemExit("Production bloquée par défaut (quota d'egress Supabase) : relance avec QA_ALLOW_PROD=1, après le GO de Romain.")
    if a.simule and os.environ.get("QA_ALLOW_PROD") == "1":
        raise SystemExit("--simule se joue hors production : retire QA_ALLOW_PROD=1.")
    if a.nettoyer:
        tok = login(os.environ["NOVA_TEST_ARTISTE_EMAIL"], os.environ["NOVA_TEST_ARTISTE_MDP"])["access_token"]
        for link in a.nettoyer:
            print(link.split(".")[0], delete_session(link, tok))
        sys.exit(0)
    if a.reel and not a.confirm:
        raise SystemExit("Ce mode écrit dans la base de production : ajoute --je-confirme-ecriture-en-production.")
    r = run(SimEnv() if a.simule else RealEnv())
    sys.exit(0 if r["ok"] else 1)
