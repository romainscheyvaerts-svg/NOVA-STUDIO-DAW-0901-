"""🔔 Lot 7 · Notifications (Web Push) : demande au bon moment, réglages, ouverture d'une notification.

100 % hors production : Supabase simulé (qa_hors_prod via qalib), compte SIMULÉ, table nova_notify_prefs
simulée (RLS : chacun ses lignes), fonction nova-push et abonnement (rpc nova_push_subscribe) simulés par des
routes de ce scénario. Navigateur headless. Le service worker et le PushManager du navigateur sont FAUX
(script d'init) : on compte les demandes de permission, les abonnements et les désabonnements, et on
simule les messages du service worker (notification touchée, nouveauté reçue NOVA au premier plan).
La clé publique utilisée est une clé de TEST (point fixe), jamais une clé du projet.

Cas :
  pc      (1366 × 768, sombre puis clair, mode simple) :
    1. au chargement : AUCUNE demande de permission, aucune carte ; une seule lecture de la config ;
    2. 1er commentaire posé (vraie fenêtre « Commentaires ») → carte discrète « Être prévenu… » (mode simple :
       une ligne, « Activer » et ✕, < 80 px), toujours aucune permission demandée ; rien de recouvert ;
    3. « Activer » → 1 demande de permission, 1 abonnement avec la clé publique de la config, appareil
       enregistré (rpc), réglages enregistrés (enabled) ; la carte disparaît ;
    4. Ctrl+K « notifications » → réglages : général + 4 types ; « Prises reçues » coupé → enregistré ;
       essai envoyé ; tout couper → désabonnement réel (unsubscribe + ligne supprimée) ; rallumer → réabonné ;
       captures sombre et clair ;
    5. nouveauté reçue NOVA au premier plan (message du service worker) → petite carte « Voir » → la fenêtre
       Commentaires s'ouvre sur le commentaire ; notification d'une AUTRE séance → « L'ouvrir maintenant ? »
       sans quitter le projet ;
  tel     (390 × 844, au doigt, clair puis sombre) : la carte est POSÉE dans la page des pistes (pas
          flottante), rien de recouvert, « Activer », réglages plein écran ;
  avance  (1366, mode avancé) : la carte donne le détail + « Choisir quoi recevoir » ;
  sans_cle : serveur sans clé publique → rien n'apparaît (ni carte, ni palette), aucune erreur ;
  refus   : permission refusée → message actionnable (cadenas), aucun abonnement ;
  windows : appli Windows simulée (pas de service worker) → activation sans abonnement Web Push, panneau
            « tant que Nova Studio est ouvert ».

  NOVA_URL=http://127.0.0.1:3423/ PYTHONIOENCODING=utf-8 python qa/notifications.py [pc] [tel] [avance] [sans_cle] [refus] [windows]
Sorties : D:\\1 WORK\\CONTENU\\nova-151\\notifications\\qa (captures + notifications.json)
"""
import json
import os
import re
import sys
import time
from pathlib import Path

os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-151\notifications\qa")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import qalib  # noqa: E402  (Supabase simulé, production bloquée)
import qa_hors_prod  # noqa: E402
from qalib import launch, new_page, Log, save_log, balayage_chevauchement  # noqa: E402
from scenarios import close_welcome, wait_text_gone, DEFAULT_BEAT  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

BASE = qalib.BASE
OUT = Path(os.environ["QA_OUT"])
OUT.mkdir(parents=True, exist_ok=True)

USER = "7c1f2a3b-4d5e-4f60-8a71-92b3c4d5e6f7"
EMAIL = "artiste.notif@exemple.be"
# Clé publique de TEST : 0x04 || 64 octets fixes (aucune clé privée n'existe pour elle).
TEST_KEY_BYTES = [4] + [(i * 7 + 3) & 255 for i in range(64)]


def b64url(bs):
    import base64
    return base64.urlsafe_b64encode(bytes(bs)).decode().rstrip("=")


TEST_KEY = b64url(TEST_KEY_BYTES)

FAKE_PUSH = r"""(() => {
  const opts = %s;
  const calls = window.__push = { perm: 0, subs: 0, unsub: 0, notifs: [], key: null };
  let permission = 'default';
  class FakeNotification {
    constructor(t, o) { calls.notifs.push({ t, o }); this.onclick = null; }
    close() {}
    static get permission() { return permission; }
    static async requestPermission() { calls.perm++; permission = opts.answer || 'granted'; return permission; }
  }
  window.Notification = FakeNotification;
  if (opts.desktop) {
    window.__novaDesktop = { version: '1.5.1-qa', platform: 'windows', ui: 'online' };
    try { Object.defineProperty(navigator, 'serviceWorker', { configurable: true, get: () => undefined }); } catch (e) {}
    try { delete window.PushManager; } catch (e) {}
    window.PushManager = undefined;
    return;
  }
  let sub = null;
  const P256 = 'B' + 'A'.repeat(85) + 'E';
  const pm = {
    async getSubscription() { return sub; },
    async subscribe(o) {
      calls.subs++;
      const key = new Uint8Array(o.applicationServerKey);
      calls.key = Array.from(key);
      sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/qa-' + calls.subs, options: { applicationServerKey: key.buffer },
        toJSON() { return { endpoint: this.endpoint, keys: { p256dh: P256, auth: 'QUFBQUFBQUFBQUFBQUFBQQ' } }; },
        getKey() { return null; },
        async unsubscribe() { calls.unsub++; sub = null; return true; } };
      return sub;
    },
  };
  window.PushManager = function PushManager() {};
  const listeners = [];
  const reg = { pushManager: pm, scope: location.origin + '/' };
  const sw = { getRegistration: async () => reg, register: async () => reg, ready: Promise.resolve(reg), controller: null,
    addEventListener: (t, f) => { if (t === 'message') listeners.push(f); }, removeEventListener() {} };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, get: () => sw });
  window.__swPost = (data) => listeners.forEach(f => f({ data }));
})();"""

res = {"cas": {}}


class Server:
    """nova-push + abonnements simulés (ce que feraient la fonction et nova_push_subscribe)."""

    def __init__(self, key=TEST_KEY):
        self.key = key
        self.config_calls = 0
        self.tests = 0
        self.subscribed = []
        self.deleted = []

    def install(self, page):
        def fn(route, request):
            if request.method == "OPTIONS":
                return route.fulfill(status=204, headers={"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS"})
            try:
                body = json.loads(request.post_data or "{}")
            except Exception:
                body = {}
            hdr = {"access-control-allow-origin": "*"}
            if body.get("action") == "config":
                self.config_calls += 1
                return route.fulfill(status=200, headers=hdr, content_type="application/json", body=json.dumps({"public_key": self.key}))
            if body.get("action") == "test":
                self.tests += 1
                return route.fulfill(status=200, headers=hdr, content_type="application/json", body=json.dumps({"sent": 1}))
            return route.fulfill(status=400, headers=hdr, content_type="application/json", body=json.dumps({"error": "Action inconnue"}))

        def rpc(route, request):
            if request.method == "OPTIONS":
                return route.fulfill(status=204, headers={"access-control-allow-origin": "*", "access-control-allow-headers": "*"})
            self.subscribed.append(json.loads(request.post_data or "{}"))
            return route.fulfill(status=200, headers={"access-control-allow-origin": "*"}, content_type="application/json", body=json.dumps("0b7e1d2c-3a4b-4c5d-8e6f-7a8b9c0d1e2f"))

        def subs(route, request):
            if request.method == "OPTIONS":
                return route.fulfill(status=204, headers={"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, DELETE"})
            if request.method == "DELETE":
                self.deleted.append(request.url)
                return route.fulfill(status=204, headers={"access-control-allow-origin": "*"}, body="")
            return route.fulfill(status=200, headers={"access-control-allow-origin": "*"}, content_type="application/json", body="[]")

        page.route(re.compile(r"^https://[a-z0-9-]+\.supabase\.co/functions/v1/nova-push"), fn)
        page.route(re.compile(r"^https://[a-z0-9-]+\.supabase\.co/rest/v1/rpc/nova_push_subscribe"), rpc)
        page.route(re.compile(r"^https://[a-z0-9-]+\.supabase\.co/rest/v1/nova_push_subscriptions"), subs)


def prefs_row():
    t = qa_hors_prod.TABLES.get("nova_notify_prefs") or {"lignes": {}}
    rows = [r for r in t["lignes"].values() if r.get("user_id") == USER]
    return rows[0] if rows else None


def run_case(p, case, vp, theme, simple=True, key=True, answer="granted", desktop=False):
    name = f"notif_{case}"
    log = Log(name)
    tel = vp.startswith("tel")
    r = {"vp": vp, "theme": theme, "simple": simple, "ok": True, "checks": [], "captures": []}
    res["cas"][case] = r
    qa_hors_prod.table_simulee("nova_notify_prefs", cle=("user_id",))
    sess = qa_hors_prod.compte_simule(USER, EMAIL)
    srv = Server(TEST_KEY if key else None)

    def check(label, cond, extra=""):
        r["checks"].append({"label": label, "ok": bool(cond), **({"extra": str(extra)[:400]} if extra not in ("", None) else {})})
        if not cond:
            r["ok"] = False
        print(("OK  " if cond else "KO  ") + f"[{case}] {label}" + ("" if cond else f"  → {str(extra)[:300]}"), flush=True)

    def snap(tag):
        path = OUT / f"{name}_{tag}.png"
        page.screenshot(path=str(path))
        r["captures"].append(path.name)

    def tap(loc):
        loc = loc.locator("visible=true").first
        (loc.tap if tel else loc.click)()

    def push():
        return page.evaluate("() => window.__push")

    def set_theme(t):
        page.evaluate("""async (t) => { const { themeStore } = await window.__novaAppModule('/utils/themeStore.ts'); themeStore.setPref(t); }""", t)
        page.wait_for_timeout(400)

    def palette(query):
        if tel:
            b = page.locator("[data-testid=open-palette]").locator("visible=true")
            if b.count():
                b.first.tap()
            else:
                page.get_by_test_id("transport-menu").locator("visible=true").first.tap()
                page.wait_for_timeout(300)
                page.get_by_test_id("menu-palette").locator("visible=true").first.tap()
        else:
            page.keyboard.press("Control+k")
        page.locator("[data-testid=command-palette]").wait_for(timeout=5000)
        page.keyboard.type(query, delay=10)
        page.wait_for_timeout(300)
        ids = page.evaluate("() => [...document.querySelectorAll('[data-testid=command-palette] [role=option]')].map(o => o.getAttribute('data-palette-id'))")
        return ids

    def palette_run(query, pid):
        ids = palette(query)
        if pid not in ids:
            page.keyboard.press("Escape")
            return False, ids
        page.locator(f"[data-testid=command-palette] [role=option][data-palette-id='{pid}']").first.click()
        page.wait_for_timeout(500)
        return True, ids

    def wait_for(sel, timeout=8000):
        try:
            page.locator(sel).locator("visible=true").first.wait_for(timeout=timeout)
            return True
        except Exception:
            return False

    def add_comment(text):
        ok, ids = palette_run("commentaires et versions", "pal.reviews")
        check("palette : « Commentaires et versions » ouvre la fenêtre", ok, ids)
        wait_for("[data-testid=comment-text]")
        page.locator("[data-testid=comment-text]").locator("visible=true").first.fill(text)
        tap(page.get_by_test_id("comment-add"))
        page.wait_for_timeout(600)

    def close_reviews():
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)
        if page.get_by_test_id("reviews-panel").locator("visible=true").count():
            b = page.get_by_test_id("reviews-panel").get_by_role("button", name=re.compile("Fermer")).locator("visible=true")
            if b.count():
                tap(b)
                page.wait_for_timeout(300)

    def no_overlap(where, scope=None):
        bal = balayage_chevauchement(page, scope)
        check(f"{where} : aucun bouton recouvert", not bal.get("recouverts") and not bal.get("erreur"), bal)

    b = launch(p)
    ctx, page = new_page(b, vp, log)
    ctx.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); localStorage.setItem('nova_simple_mode', '{1 if simple else 0}'); localStorage.removeItem('nova_push_ask'); "
                        f"localStorage.setItem('sb-mxdrxpzxbgybchzzvpkf-auth-token', {json.dumps(json.dumps(sess))}); }} catch (e) {{}}")
    ctx.add_init_script(FAKE_PUSH % json.dumps({"answer": answer, "desktop": desktop}))
    srv.install(page)
    try:
        page.goto(BASE, wait_until="domcontentloaded")
        page.get_by_text(DEFAULT_BEAT, exact=True).first.wait_for(timeout=40000)
        page.get_by_text(DEFAULT_BEAT, exact=True).first.click()
        page.wait_for_timeout(1500)
        close_welcome(page)
        wait_text_gone(page, "Chargement", 60)
        close_welcome(page)
        page.wait_for_timeout(7500)  # vérification discrète faite à ~6 s

        # 1. Rien au chargement.
        pu = push()
        check("1. aucune demande de permission au chargement", pu["perm"] == 0, pu)
        check("1. aucune carte au chargement", page.locator("[data-testid=notif-ask]").count() == 0)
        check("1. config lue une seule fois (pas de boucle)", srv.config_calls <= 1, srv.config_calls)

        if case == "sans_cle":
            add_comment("le refrain est trop fort")
            page.wait_for_timeout(4000)
            check("sans clé : aucune carte après un commentaire", page.locator("[data-testid=notif-ask]").count() == 0)
            close_reviews()
            ids = palette("notifications")
            page.keyboard.press("Escape")
            check("sans clé : pas de « Notifications » dans la palette", "pal.notifications" not in ids, ids)
            check("sans clé : aucune permission demandée", push()["perm"] == 0)
            snap("sans_cle")
            return

        # 2. Le bon moment : 1er commentaire posé.
        add_comment("le « s » siffle au refrain")
        shown = wait_for("[data-testid=notif-ask]", 8000)
        check("2. carte « Être prévenu… » après le 1er commentaire", shown)
        if not shown:
            snap("2_pas_de_carte")
            return
        txt = page.get_by_test_id("notif-ask").locator("visible=true").first.inner_text()
        want = "Être prévenu des réponses, même NOVA fermée ?" if simple else "Être prévenu quand on répond à ton commentaire ?"
        check("2. phrase claire", want in txt, txt)
        check("2. toujours aucune permission demandée (la carte demande d'abord)", push()["perm"] == 0)
        if not tel:
            close_reviews()
            page.wait_for_timeout(300)
        else:
            close_reviews()
            # Page des pistes : la carte y est posée.
            pistes = page.locator("[data-testid=mobile-tab-ARRANGEMENT], [data-nova-target=tab-ARRANGEMENT]").locator("visible=true")
            if pistes.count():
                pistes.first.tap(); page.wait_for_timeout(500)
            wait_for("[data-testid=notif-ask]", 4000)
        box = page.evaluate("""() => { const e = [...document.querySelectorAll('[data-testid=notif-ask]')].find(x => x.getClientRects().length); if (!e) return null;
          const r = e.getBoundingClientRect(); return { h: Math.round(r.height), w: Math.round(r.width), x: Math.round(r.left), y: Math.round(r.top), pos: getComputedStyle(e).position, simple: e.dataset.simple, dialog: !!e.closest('[role=dialog]') }; }""")
        check("2. carte visible", box is not None, box)
        if box:
            check("2. pas une fenêtre modale (discrète)", not box["dialog"], box)
            if simple:
                check("2. mode simple : une seule ligne discrète (< 80 px de haut), sans détail", box["simple"] == "1" and box["h"] < 80, box)
            else:
                check("2. mode avancé : détail + « Choisir quoi recevoir »", page.get_by_test_id("notif-ask-settings").locator("visible=true").count() == 1, box)
            if tel:
                check("2. téléphone : posée dans la page, pas flottante", box["pos"] != "fixed" and box["w"] <= 390, box)
        no_overlap("2. carte", "[data-testid=notif-ask]")
        no_overlap("2. écran avec la carte")
        snap(f"2_carte_{theme}")

        # 3. Activer.
        tap(page.get_by_test_id("notif-ask-yes"))
        page.wait_for_timeout(1500)
        pu = push()
        if case == "refus":
            check("refus : 1 demande de permission", pu["perm"] == 1, pu)
            check("refus : aucun abonnement", pu["subs"] == 0 and not srv.subscribed, pu)
            err = page.locator("[data-testid=notif-ask] [role=alert]").locator("visible=true")
            etxt = err.first.inner_text() if err.count() else ""
            check("refus : message actionnable (cadenas › Autoriser)", "cadenas" in etxt and "Autoriser" in etxt, etxt)
            snap("refus")
            return
        check("3. une seule demande de permission, au clic", pu["perm"] == 1, pu)
        if desktop:
            check("windows : pas d'abonnement Web Push (pas de service worker)", pu["subs"] == 0 and not srv.subscribed, pu)
        else:
            check("3. abonné une fois", pu["subs"] == 1, pu)
            check("3. avec la clé publique de la config", pu["key"] == TEST_KEY_BYTES, pu["key"][:6] if pu["key"] else None)
            sub = srv.subscribed[0] if srv.subscribed else {}
            check("3. appareil enregistré (nova_push_subscribe)", str(sub.get("p_endpoint", "")).startswith("https://fcm.googleapis.com/") and sub.get("p_app_key") == TEST_KEY[:16], sub)
        pr = prefs_row()
        check("3. réglages enregistrés (activées, tout coché)", bool(pr) and pr.get("enabled") is True and pr.get("takes") is True, pr)
        check("3. la carte disparaît", page.locator("[data-testid=notif-ask]").locator("visible=true").count() == 0)

        # 4. Réglages.
        ok, ids = palette_run("notifications", "pal.notifications")
        check("4. palette Ctrl+K : « Notifications »", ok, ids)
        if not wait_for("[data-testid=notif-panel]", 5000):
            check("4. réglages ouverts", False)
            return
        page.wait_for_timeout(600)
        master = page.get_by_test_id("notif-master")
        check("4. général activé", master.get_attribute("aria-checked") == "true")
        types = [page.get_by_test_id(f"notif-pref-{k}").get_attribute("aria-checked") for k in ("comments", "versions", "invites", "takes")]
        check("4. 4 types, tous cochés", types == ["true"] * 4, types)
        dev = page.get_by_test_id("notif-device").inner_text()
        check("4. état de l'appareil affiché", "reçoit les notifications" in dev and (("Windows" in dev) == desktop), dev)
        snap(f"4_reglages_{theme}")
        no_overlap("4. réglages", "[data-testid=notif-panel]")
        sw = page.evaluate("() => [document.documentElement.scrollWidth, innerWidth]")
        check("4. aucun débordement horizontal", sw[0] <= sw[1] + 1, sw)
        other = "light" if theme == "dark" else "dark"
        set_theme(other)
        snap(f"4_reglages_{other}")
        set_theme(theme)

        tap(page.get_by_test_id("notif-pref-takes"))
        page.wait_for_timeout(800)
        pr = prefs_row()
        check("4. « Prises reçues » coupé → enregistré", bool(pr) and pr.get("takes") is False and pr.get("comments") is True, pr)
        check("4. résumé « 3 types sur 4 »", page.get_by_test_id("notif-summary").inner_text() == "3 types sur 4", page.get_by_test_id("notif-summary").inner_text())
        if desktop:
            tap(page.get_by_test_id("notif-test"))
            page.wait_for_timeout(600)
            check("windows : l'essai s'affiche (notification Windows ou carte)", len(push()["notifs"]) >= 1 or page.locator("[data-testid=notif-inapp]").count() >= 1 or page.locator("[data-testid=notif-info]").count() == 1)
        else:
            tap(page.get_by_test_id("notif-test"))
            page.wait_for_timeout(800)
            check("4. essai envoyé (fonction appelée, message clair)", srv.tests == 1 and "Essai envoyé" in page.get_by_test_id("notif-info").inner_text(), srv.tests)

        tap(master)
        page.wait_for_timeout(1000)
        pu, pr = push(), prefs_row()
        check("4. tout couper → enregistré (enabled = false)", bool(pr) and pr.get("enabled") is False, pr)
        check("4. tout couper → types grisés", page.get_by_test_id("notif-pref-comments").is_disabled())
        if not desktop:
            check("4. désabonnement RÉEL (unsubscribe + ligne supprimée)", pu["unsub"] == 1 and len(srv.deleted) == 1 and "endpoint=eq." in srv.deleted[0], {"push": pu, "deleted": srv.deleted})
        snap(f"4_tout_coupe_{theme}")
        tap(master)
        page.wait_for_timeout(1200)
        pu, pr = push(), prefs_row()
        check("4. rallumer → réactivé, sans redemander la permission", pr and pr.get("enabled") is True and pu["perm"] == 1, {"push": pu, "prefs": pr})
        check("4. rallumer garde le choix par type (prises toujours coupées)", pr and pr.get("takes") is False, pr)
        if not desktop:
            check("4. rallumer → réabonné", pu["subs"] == 2, pu)
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)
        check("4. Échap ferme les réglages", page.locator("[data-testid=notif-panel]").count() == 0)

        if case != "pc":
            return

        # 5. Ouvrir ce qu'une notification montre.
        cid = page.evaluate("() => (window.__novaTest.getState().timelineComments || [])[0]?.id || null")
        check("5. le commentaire posé existe", bool(cid), cid)
        page.evaluate("(c) => window.__swPost({ type: 'nova-push', data: { title: '💬 Max a répondu (0:00)', body: '« ok je corrige »', c, at: 0, url: '/?nova_c=' + c } })", cid)
        got = wait_for("[data-testid=notif-inapp]", 3000)
        check("5. nouveauté reçue NOVA devant → petite carte dans la page (pas de notification système)", got and len(push()["notifs"]) == 0)
        no_overlap("5. carte nouveauté", "[data-testid=notif-inapp]")
        snap("5_nouveaute")
        if got:
            tap(page.get_by_test_id("notif-inapp-open"))
            page.wait_for_timeout(900)
            check("5. « Voir » ouvre la fenêtre Commentaires", page.get_by_test_id("reviews-panel").locator("visible=true").count() >= 1 or page.get_by_test_id("comments-list").locator("visible=true").count() >= 1)
            snap("5_commentaire_ouvert")
            close_reviews()
        page.evaluate("() => window.__swPost({ type: 'nova-notif-open', data: { s: 'zzzzzzzzzzzz', c: 'cm-x', url: '/?session=zzzzzzzzzzzz.abc&nova_s=zzzzzzzzzzzz&nova_c=cm-x' } })")
        got = wait_for("[data-testid=notif-other-session]", 3000)
        check("5. notification d'une autre séance → « L'ouvrir maintenant ? » (on ne quitte pas le projet)", got)
        snap("5_autre_seance")
        url_before = page.url
        if got:
            tap(page.get_by_test_id("notif-other-session").get_by_role("button", name="Plus tard"))
            page.wait_for_timeout(400)
        check("5. « Plus tard » : rien ne change", page.url == url_before and page.locator("[data-testid=notif-other-session]").count() == 0)
    except Exception as e:  # noqa: BLE001
        check("scénario sans exception", False, repr(e)[:300])
        try:
            snap("exception")
        except Exception:
            pass
    finally:
        errs = [e for e in log.errors() if "nova-push" in e["text"] or "Notification" in e["text"] or "push" in e["text"].lower()]
        check("aucune erreur liée aux notifications dans la console", not errs, errs[:3])
        r["erreurs_console"] = [e["text"][:200] for e in log.errors()][:10]
        r["bloquees"] = page._blocked[:5]
        save_log(log)
        ctx.close()
        b.close()


CASES = {
    "pc": dict(vp="pc1366", theme="dark", simple=True),
    "tel": dict(vp="tel390", theme="light", simple=True),
    "avance": dict(vp="pc1366", theme="light", simple=False),
    "sans_cle": dict(vp="pc1366", theme="dark", key=False),
    "refus": dict(vp="pc1366", theme="dark", answer="denied"),
    "windows": dict(vp="pc1366", theme="dark", simple=False, desktop=True),
}


def main():
    names = [a for a in sys.argv[1:] if a in CASES] or list(CASES)
    t0 = time.time()
    with sync_playwright() as p:
        for n in names:
            run_case(p, n, **CASES[n])
    ok = all(c["ok"] for c in res["cas"].values())
    res["ok"] = ok
    res["duree_s"] = round(time.time() - t0, 1)
    (OUT / "notifications.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(("TOUT VERT" if ok else "ÉCHECS") + f" : {sum(len(c['checks']) for c in res['cas'].values())} vérifications, {res['duree_s']} s", flush=True)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
