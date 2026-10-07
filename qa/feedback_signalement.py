"""Scénario « Signaler un bug / proposer une idée » dans un Chrome headless, avec un
Supabase SIMULÉ (toutes les requêtes vers le projet sont interceptées : rien n'atteint
la vraie base). Captures PC, tablette et téléphone.

1. PC : studio ouvert, faux jeton dans le stockage local + erreur console qui le
   contient ; ouverture par l'icône de la barre du haut ; formulaire rempli ; capture
   jointe (image) + zone masquée ; « Ce qui sera joint » ; envoi ; confirmation n° ;
   le serveur simulé a reçu la ligne + la capture, SANS le jeton.
2. PC : deuxième signalement HORS LIGNE (gardé, numéro donné), « Mes signalements »
   = en attente ; retour du réseau → reparti tout seul → « Reçu » ; le serveur passe
   le premier à « corrigé » → « Corrigé dans la version … » ; Ctrl+Maj+B / Échap.
3. Tablette (tactile) et téléphone : ouverture par le menu ☰, envoi, confirmation,
   historique ; aucun débordement horizontal.

Usage : NOVA_URL=http://127.0.0.1:3424/ python qa/feedback_signalement.py
"""
import json, os, re, sys, time
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3424/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-retours")
from qalib import launch, VIEWPORTS, BASE, OUT, overflow_report  # noqa: E402
from scenarios import close_welcome, wait_text_gone, DEFAULT_BEAT  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

PROJECT = "mxdrxpzxbgybchzzvpkf.supabase.co"
FAKE_JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmYWtlLXVzZXIiLCJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.FauxJetonSecretNePasJoindre42"
res = {"etapes": {}, "captures": []}


def ok(k, v, note=None):
    res["etapes"][k] = {"ok": bool(v), **({"detail": note} if note is not None else {})}
    print(("OK  " if v else "KO  ") + k, "" if note is None else note)


class FakeSupabase:
    """Imite PostgREST + Storage pour nova_feedback ; bloque toute autre écriture."""

    def __init__(self):
        self.rows, self.uploads, self.blocked, self.status = [], [], [], {}

    def handle(self, route, request):
        url, method = request.url, request.method
        path = url.split(PROJECT, 1)[1] if PROJECT in url else ""
        if path.startswith("/rest/v1/nova_feedback") and method == "POST":
            row = json.loads(request.post_data or "{}")
            if any(r["ref"] == row.get("ref") for r in self.rows):
                return route.fulfill(status=409, content_type="application/json",
                                     body=json.dumps({"code": "23505", "message": "duplicate key value violates unique constraint"}))
            self.rows.append(row)
            return route.fulfill(status=201, body="")
        if path.startswith("/rest/v1/nova_feedback") and method == "GET":
            return route.fulfill(status=200, content_type="application/json", body="[]")
        if path.startswith("/rest/v1/rpc/nova_feedback_statuts"):
            refs = (json.loads(request.post_data or "{}")).get("p_refs") or []
            out = [{"ref": r, "status": self.status.get(r, ("recu", None))[0], "fixed_in_version": self.status.get(r, ("recu", None))[1]}
                   for r in refs if any(x["ref"] == r for x in self.rows)]
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(out))
        if path.startswith("/storage/v1/object/nova-feedback/") and method == "POST":
            self.uploads.append({"path": path.split("/nova-feedback/", 1)[1], "bytes": len(request.post_data_buffer or b""),
                                 "type": request.headers.get("content-type", "")})
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"Key": "nova-feedback/x"}))
        if method in ("POST", "PATCH", "PUT", "DELETE") and not url.startswith(BASE.rstrip("/")):
            self.blocked.append(f"{method} {url[:120]}")
            return route.abort()
        return route.continue_()


def make_screenshot(path):
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (1200, 700), (14, 16, 20))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 1200, 60], fill=(24, 28, 34))
    d.text((20, 20), "NOVA - studio (capture de test)", fill=(0, 242, 255))
    d.rectangle([40, 120, 700, 600], fill=(30, 34, 40))
    for i in range(6):
        d.rectangle([60, 140 + i * 70, 680, 190 + i * 70], fill=(0, 120 + i * 20, 160))
    d.rectangle([760, 120, 1160, 260], fill=(60, 30, 30))
    d.text((780, 140), "Compte : artiste@exemple.com", fill=(255, 255, 255))
    img.save(path)
    return path


def snap(page, name):
    p = OUT / f"{name}.png"
    page.screenshot(path=str(p))
    res["captures"].append(p.name)
    return p


def open_studio(page):
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text(DEFAULT_BEAT, exact=True).first.wait_for(timeout=30000)
    page.get_by_text(DEFAULT_BEAT, exact=True).first.click()
    page.wait_for_timeout(1500)
    close_welcome(page)
    wait_text_gone(page, "Chargement", 60)
    page.wait_for_timeout(800)
    close_welcome(page)


def dialog(page):
    return page.locator('[data-nova-feedback] [role="dialog"]')


def fill_form(page, title, desc, freq="Parfois"):
    page.locator("#nova-fb-title").fill(title)
    page.locator("#nova-fb-desc").fill(desc)
    if freq:
        dialog(page).get_by_role("button", name=freq, exact=True).click()


def attach_and_mask(page, img):
    page.locator("[data-nova-feedback-file]").set_input_files(img)
    prev = page.locator("[data-nova-feedback-preview]")
    prev.wait_for(timeout=8000)
    prev.scroll_into_view_if_needed()
    b = prev.bounding_box()
    # Zone « compte / e-mail » en haut à droite de l'image : masquée.
    page.mouse.move(b["x"] + b["width"] * 0.62, b["y"] + b["height"] * 0.15)
    page.mouse.down()
    page.mouse.move(b["x"] + b["width"] * 0.97, b["y"] + b["height"] * 0.38, steps=6)
    page.mouse.up()
    page.wait_for_timeout(200)


def wait_until(page, fn, timeout=15):
    # page.wait_for_timeout (et pas time.sleep) : Playwright doit traiter les requêtes interceptées pendant l'attente.
    t = time.time()
    while time.time() - t < timeout:
        if fn():
            return True
        page.wait_for_timeout(250)
    return False


def scenario_pc(p, fake, img):
    b = launch(p)
    ctx = b.new_context(viewport=VIEWPORTS["pc"], locale="fr-BE", device_scale_factor=1, permissions=["microphone"])
    ctx.route("**/*", fake.handle)
    page = ctx.new_page()
    page.set_default_timeout(15000)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)[:200]))
    open_studio(page)

    # Faux secret : dans le stockage local ET dans une erreur de la console.
    page.evaluate("""(jwt) => {
      localStorage.setItem('sb-sqduhfckgvyezdiubeei-auth-token', JSON.stringify({ access_token: jwt, refresh_token: 'rt-secret-123456789', user: { email: 'secret@exemple.com' } }));
      console.error('Session refusée pour ' + jwt + ' (secret@exemple.com)');
      console.warn('Test : avertissement de latence');
    }""", FAKE_JWT)

    # 1. Ouverture par l'icône de la barre du haut.
    page.get_by_role("button", name="Signaler un bug ou proposer une idée").first.click()
    dialog(page).wait_for()
    ok("pc_ouverture_barre_du_haut", dialog(page).is_visible())
    snap(page, "pc_01_formulaire_vide")

    fill_form(page, "Le son coupe quand j'enregistre", "Pendant l'enregistrement de la voix, le beat s'arrête au bout de 10 s.")
    attach_and_mask(page, img)
    snap(page, "pc_02_formulaire_capture_masquee")
    dialog(page).get_by_role("button", name="Voir le détail technique").click()
    page.locator("[data-nova-feedback-context]").scroll_into_view_if_needed()
    tech = page.locator("[data-nova-feedback-context] pre").inner_text()
    ok("pc_contexte_montre_sans_secret", "eyJhbGci" not in tech and "secret@exemple.com" not in tech and "rt-secret" not in tech and '"erreurs"' in tech and '"actions"' in tech)
    snap(page, "pc_03_ce_qui_sera_joint")

    page.locator("[data-nova-feedback-send]").click()
    page.locator("[data-nova-feedback-done]").wait_for(timeout=15000)
    done = page.locator("[data-nova-feedback-done]").inner_text()
    m = re.search(r"n°\s*([2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4})", done)
    ok("pc_confirmation_numero", bool(m) and "est bien reçu" in done, m.group(1) if m else done[:120])
    snap(page, "pc_04_confirmation")
    ref1 = m.group(1).replace("-", "") if m else None
    row = fake.rows[0] if fake.rows else {}
    dump = json.dumps(row, ensure_ascii=False)
    ok("pc_serveur_a_recu_la_ligne", bool(row) and row.get("ref") == ref1 and row.get("frequency") == "parfois" and row.get("category") == "bug")
    ok("pc_capture_envoyee", len(fake.uploads) == 1 and fake.uploads[0]["path"] == f"{row.get('device_id')}/{ref1}.jpg" and row.get("screenshot_path") == fake.uploads[0]["path"],
       fake.uploads)
    ok("pc_jamais_le_jeton", FAKE_JWT not in dump and "eyJhbGci" not in dump and "rt-secret" not in dump and "secret@exemple.com" not in dump)
    ok("pc_contexte_complet", all(k in (row.get("context") or {}) for k in ("nova", "navigateur", "ecran", "studio", "erreurs", "actions"))
       and (row.get("context") or {}).get("studio", {}).get("trackCount") is not None, (row.get("context") or {}).get("studio"))
    ok("pc_pas_de_statut_envoye_par_le_client", "status" not in row and "user_id" not in row and "admin_note" not in row)

    # 2. Hors ligne.
    dialog(page).get_by_role("button", name="En envoyer un autre").click()
    fill_form(page, "Idée : un accordeur pour la guitare", "Un petit accordeur dans la piste guitare.", freq=None)
    dialog(page).get_by_role("button", name="Idée", exact=True).click()
    ctx.set_offline(True)
    page.wait_for_timeout(300)
    page.locator("[data-nova-feedback-send]").click()
    page.locator("[data-nova-feedback-done]").wait_for(timeout=15000)
    done2 = page.locator("[data-nova-feedback-done]").inner_text()
    m2 = re.search(r"n°\s*([2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4})", done2)
    ok("hors_ligne_numero_donne_quand_meme", bool(m2) and "connexion" in done2, done2[:160])
    ok("hors_ligne_rien_envoye", len(fake.rows) == 1)
    snap(page, "pc_05_hors_ligne_confirmation")
    dialog(page).get_by_role("button", name="Voir mes signalements").click()
    page.locator("[data-nova-feedback-history]").wait_for()
    hist = page.locator("[data-nova-feedback-history]").inner_text()
    ok("historique_en_attente", "En attente d’envoi" in hist and "Reçu" in hist, hist[:200])
    snap(page, "pc_06_mes_signalements_en_attente")

    ctx.set_offline(False)
    ok("retour_reseau_reparti_tout_seul", wait_until(page, lambda: len(fake.rows) == 2, 20), len(fake.rows))
    page.wait_for_timeout(600)
    hist = page.locator("[data-nova-feedback-history]").inner_text()
    ok("historique_recu_apres_retour", "En attente d’envoi" not in hist, hist[:200])
    snap(page, "pc_07_mes_signalements_recus")

    # Le serveur (Claude) passe le premier à « corrigé ».
    fake.status[ref1] = ("corrige", "2026.10.08")
    dialog(page).get_by_role("button", name=re.compile("Actualiser|Réessayer")).click()
    page.get_by_text("Corrigé dans la version 2026.10.08").wait_for(timeout=8000)
    ok("statut_corrige_dans_la_version", True)
    snap(page, "pc_08_statut_corrige")

    # Échap ferme, Ctrl+Maj+B ouvre / ferme.
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    ok("echap_ferme", dialog(page).count() == 0)
    page.keyboard.press("Control+Shift+B")
    page.wait_for_timeout(300)
    ok("raccourci_ctrl_maj_b_ouvre", dialog(page).count() == 1)
    page.keyboard.press("Control+Shift+B")
    page.wait_for_timeout(300)
    ok("raccourci_ctrl_maj_b_ferme", dialog(page).count() == 0)
    # La barre d'espace dans la fenêtre ne lance pas la lecture derrière.
    page.keyboard.press("Control+Shift+B")
    page.locator("#nova-fb-title").fill("Test espace")
    page.keyboard.press("Space")
    playing = page.evaluate("() => !!document.querySelector('button[aria-label=\"Pause\"]')")
    ok("saisie_ne_pilote_pas_le_studio", not playing)
    page.keyboard.press("Escape")
    ok("pc_aucune_erreur_de_page", not errors, errors[:3])
    ctx.close(); b.close()


def scenario_touch(p, fake, img, vp):
    b = launch(p)
    size = {"tab": {"width": 1024, "height": 1366}, "tel": {"width": 390, "height": 844}}[vp]
    ctx = b.new_context(viewport=size, locale="fr-BE", device_scale_factor=2 if vp == "tel" else 1, has_touch=True, is_mobile=(vp == "tel"),
                        permissions=["microphone"])
    ctx.route("**/*", fake.handle)
    page = ctx.new_page()
    page.set_default_timeout(15000)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)[:200]))
    open_studio(page)
    before = len(fake.rows)

    page.get_by_role("button", name="Ouvrir le menu").first.click()
    page.wait_for_timeout(400)
    entry = page.get_by_role("button", name="Signaler un bug / proposer une idée")
    entry.scroll_into_view_if_needed()
    snap(page, f"{vp}_01_menu")
    entry.tap() if vp == "tel" else entry.click()
    dialog(page).wait_for()
    ok(f"{vp}_ouverture_menu", dialog(page).is_visible())
    snap(page, f"{vp}_02_formulaire")
    fill_form(page, "Le métronome est décalé" if vp == "tel" else "Pouvoir renommer une prise",
              "Sur téléphone le clic arrive en retard." if vp == "tel" else "Les prises s'appellent toutes Prise 1, Prise 2…",
              freq="À chaque fois" if vp == "tel" else None)
    if vp == "tab":
        dialog(page).get_by_role("button", name="Amélioration", exact=True).click()
    attach_and_mask(page, img)
    snap(page, f"{vp}_03_capture")
    ov = overflow_report(page)
    ok(f"{vp}_pas_de_debordement", not [o for o in ov if o["kind"] in ("page-hscroll", "off-right")], ov[:3])
    small = page.evaluate("""() => Array.from(document.querySelectorAll('[data-nova-feedback] button')).filter(b => b.getClientRects().length)
        .map(b => b.getBoundingClientRect()).filter(r => r.height < 36).length""")
    ok(f"{vp}_cibles_tactiles_44px", small == 0, small)
    send = page.locator("[data-nova-feedback-send]")
    send.scroll_into_view_if_needed()
    send.tap() if vp == "tel" else send.click()
    page.locator("[data-nova-feedback-done]").wait_for(timeout=15000)
    ok(f"{vp}_confirmation", "est bien reçu" in page.locator("[data-nova-feedback-done]").inner_text())
    ok(f"{vp}_serveur_a_recu", len(fake.rows) == before + 1)
    snap(page, f"{vp}_04_confirmation")
    dialog(page).get_by_role("button", name="Voir mes signalements").click()
    page.locator("[data-nova-feedback-history]").wait_for()
    snap(page, f"{vp}_05_mes_signalements")
    ok(f"{vp}_aucune_erreur_de_page", not errors, errors[:3])
    ctx.close(); b.close()


if __name__ == "__main__":
    img = make_screenshot(str(OUT / "_capture_test.png"))
    fake = FakeSupabase()
    with sync_playwright() as p:
        for name, fn in (("pc", lambda: scenario_pc(p, fake, img)), ("tab", lambda: scenario_touch(p, fake, img, "tab")),
                         ("tel", lambda: scenario_touch(p, fake, img, "tel"))):
            try:
                fn()
            except Exception as e:  # noqa: BLE001
                ok(f"{name}_scenario_sans_exception", False, f"{type(e).__name__}: {str(e)[:300]}")
    res["serveur_simule"] = {"lignes": len(fake.rows), "captures": fake.uploads, "ecritures_bloquees": fake.blocked[:20],
                             "refs": [r.get("ref") for r in fake.rows]}
    (OUT / "resultat_scenario.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    ko = [k for k, v in res["etapes"].items() if not v["ok"]]
    print(f"\n{len(res['etapes']) - len(ko)} OK, {len(ko)} KO -> {OUT}")
    sys.exit(1 if ko else 0)
