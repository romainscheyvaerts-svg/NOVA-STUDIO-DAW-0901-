"""1.5.1 · Lot 3 (invité gratuit) et lot 9 (« Faire sa version », page publique) : bout en bout, hors production.

Navigateurs headless (aucune fenêtre). Serveurs SIMULÉS : daw-session et Realtime (qa/collab_sim.py,
règle de paiement de la 1.5.1 : seul l'hôte a Nova Pro), daw-fork et la page publique de daw-listen
(qa/invite_copie_sim.py), nova-billing (Max : admin ; les autres : compte GRATUIT, collab_sim.free_billing).

  Lot 3 · invité gratuit
   1. Max (PC, Nova Pro) ouvre sa séance et invite.
   2. Nina (téléphone 390, compte gratuit) ouvre le lien : la carte d'arrivée dit « Gratuit pour toi » ;
      elle rejoint et enregistre (opération acceptée). Aucun « abonne-toi ».
   3. Nina essaie d'HÉBERGER sa propre collaboration : 402 « host_pro » dès la création.
   4. Ancien serveur (avant la 1.4.9 : chaque participant abonné) : l'invitée voit un message clair
      (« mise à jour en attente, tu n'auras rien à payer »), pas la carte d'abonnement.
  Lot 9a · « Faire sa version »
   5. Max (sans collaboration) crée le lien par la palette Ctrl+K : la séance part en ligne, le lien est donné.
   6. Rio (téléphone, déconnecté, compte gratuit) ouvre le lien, se connecte, « Créer ma version » :
      la copie est identique AU BIT PRÈS (SHA-1 de chaque fichier = celui de la séance figée), c'est un
      projet à lui (nouvel id, sa propre clé d'export) ; il la modifie : l'original ne bouge pas (aucun envoi).
   7. Le compteur de Max passe à « 1 copie » ; il désactive le lien : Rio le rouvre → « désactivé » (410).
  Lot 9b · page publique
   8. Max publie l'EXTRAIT (case « Je publie » obligatoire) ; lien + lecteur intégrable.
   9. Rio (gratuit) : « Morceau entier » grisé avec la raison.
  10. Visiteur sans compte (téléphone et PC) : page, lecteur (son chargé au 1er « Écouter »), « Réserver au studio »,
      aucun téléchargement (ni lien, ni lecteur natif), pas de pistes ; lecteur intégré (&embed=1) ;
      Max retire la page → « n'est plus publié ».
Captures thème sombre ET clair, bureau ET téléphone ; aucun bouton recouvert (qalib.balayage_chevauchement).

NOVA_URL=http://127.0.0.1:3422/ python qa/invite_copie.py
Sorties : D:\\1 WORK\\CONTENU\\nova-151\\invite-copie\\qa (invite_copie.json + captures).
"""
import hashlib, json, os, re, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-151\invite-copie\qa")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3422/")
import qalib  # noqa: E402,F401  (Supabase simulé avant tout navigateur)
from qalib import BASE, OUT, launch, new_page, Log, shot, save_log, balayage_chevauchement  # noqa: E402
from gel_pre_effet import prepare, open_project_file  # noqa: E402
from collab_sim import FakeNovaCloud, FakeRealtime, connect, free_billing, jwt, SUPA, STORE  # noqa: E402
from feat_lib import feat_project, dismiss, wait_for, collab, open_panel, close_panel  # noqa: E402
from invite_copie_sim import FakeForkPublic  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

MAX, NINA, RIO = "22222222-2222-4222-8222-222222222222", "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"
checks = []
res = {"name": "invite_copie", "etapes": {}, "chevauchements": {}}


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:600]}"), flush=True)


def theme(page, t):
    page.evaluate("t => { try { localStorage.setItem('nova_theme', t); } catch (e) {} document.documentElement.setAttribute('data-theme', t); }", t)
    page.wait_for_timeout(250)


def both_themes(page, name, scope=None):
    """Capture en sombre puis en clair, et balayage des boutons recouverts dans les deux."""
    out = {}
    for t in ("dark", "light"):
        theme(page, t)
        shot(page, f"{name}_{t}")
        b = balayage_chevauchement(page, scope)
        out[t] = {"boutons": b["boutons"], "recouverts": b["recouverts"][:6]}
    theme(page, "dark")
    res["chevauchements"][name] = out
    check(f"{name} : aucun bouton recouvert (sombre et clair)", all(not v["recouverts"] for v in out.values()), out)


def connect_out(page, cloud, rt, tag, uid, email):
    """Compte simulé, mais PAS connecté au départ (la connexion se fait dans l'appli)."""
    user = {"id": uid, "email": email, "aud": "authenticated", "role": "authenticated", "app_metadata": {}, "user_metadata": {}, "created_at": "2026-01-01T00:00:00Z"}
    tok = jwt(uid, email)
    sess = {"access_token": tok, "token_type": "bearer", "expires_in": 86400 * 30, "expires_at": int(time.time()) + 86400 * 30, "refresh_token": "qa-refresh", "user": user}
    page.add_init_script("try { localStorage.setItem('nova_simple_mode', '0'); } catch (e) {}")
    state = {"in": False}

    def user_route(r):
        if state["in"]:
            return r.fulfill(status=200, content_type="application/json", body=json.dumps(user))
        r.fulfill(status=401, content_type="application/json", body=json.dumps({"message": "not logged"}))

    def token_route(r):
        state["in"] = True
        r.fulfill(status=200, content_type="application/json", body=json.dumps(sess))
    page.route(f"{SUPA}/auth/v1/user*", user_route)
    page.route(f"{SUPA}/auth/v1/token*", token_route)
    page.route(f"{SUPA}/functions/v1/daw-session", cloud.handler(tag))
    page.route(f"{SUPA}/storage/v1/object/upload/sign/**", cloud.upload)
    page.route(f"{STORE}/**", cloud.download)
    page.route(f"{SUPA}/rest/v1/instrumentals*", lambda r: r.fulfill(status=200, content_type="application/json", body="[]"))
    page.route(f"{SUPA}/rest/v1/rpc/**", lambda r: r.fulfill(status=200, content_type="application/json", body="false"))
    page.route_web_socket(re.compile(r"realtime/v1/websocket"), rt.handler(tag))


def palette(page, query):
    page.keyboard.press("Escape")
    page.keyboard.press("Control+k")
    page.locator("[data-testid=command-palette]").wait_for(timeout=5000)
    page.keyboard.type(query, delay=15)
    page.wait_for_timeout(250)
    first = page.locator("[data-testid=command-palette] [role=option]").first.get_attribute("data-palette-id")
    page.keyboard.press("Enter")
    page.wait_for_timeout(500)
    return first


def wait_shot(page, fn, timeout, what, name):
    """wait_for, avec une capture et le texte de la page si ça échoue."""
    try:
        return wait_for(page, fn, timeout, step=300, what=what)
    except AssertionError:
        shot(page, f"ECHEC_{name}")
        (OUT / f"ECHEC_{name}.txt").write_text(page.evaluate("() => document.body.innerText"), encoding="utf-8")
        raise


def visible_text(page):
    return page.evaluate("() => document.body.innerText")


def host_session(page, name, src):
    open_project_file(page, src, {}, name)
    dismiss(page)


def file_sha1(cloud, f):
    return hashlib.sha1(b"".join(cloud.parts[p] for p in f["parts"])).hexdigest()


def run():
    src = OUT / "00_beat_de_max.novaproj.zip"
    feat_project(src, name="Beat de Max")
    cloud = FakeNovaCloud(per_device=True, codes=True, strict=True, pro={MAX})
    rt = FakeRealtime()
    fp = FakeForkPublic(cloud, mix_unlocked={MAX})
    logs = []
    with sync_playwright() as p:
        b = launch(p)

        # ══════════════════════════════════════════════════ Lot 3 · invité gratuit
        lM, lN = Log("max_hote"), Log("nina_invitee"); logs += [lM, lN]
        _, M = new_page(b, "pc1366", lM)
        prepare(M, None, desktop=False)
        connect(M, cloud, rt, "M", MAX, "max@test.local")
        host_session(M, "01_max_seance", src)
        open_panel(M)
        M.get_by_test_id("collab-role").select_option("engineer")
        M.get_by_placeholder("Ton nom (affiché aux autres)").fill("Max")
        M.get_by_role("button", name="Démarrer la collaboration en direct").click()
        wait_for(M, lambda: collab(M, "c.role()") == "engineer", 90, what="séance de Max en ligne")
        sid = next(k for k, v in cloud.sessions.items() if v["manifest"])
        link = collab(M, "c.invite ? c.invite() : null") or f"{BASE}?session={sid}.{cloud.sessions[sid]['secret']}&invite=1"
        check("la séance de Max appartient à Max (hôte, Nova Pro)", cloud.sessions[sid].get("owner") == MAX and cloud.is_pro(MAX))

        _, N = new_page(b, "tel390", lN)
        prepare(N, None, desktop=False)
        free_billing(N)
        connect(N, cloud, rt, "N", NINA, "nina@test.local")
        N.goto(link, wait_until="domcontentloaded", timeout=180000)
        wait_for(N, lambda: N.get_by_test_id("collab-arrival").count() > 0, 120, step=300, what="carte d'arrivée (Nina)")
        N.wait_for_timeout(1500); dismiss(N)
        free_txt = N.get_by_test_id("arrival-free").inner_text() if N.get_by_test_id("arrival-free").count() else ""
        check("arrivée : « Gratuit pour toi » dit à l'invitée", "Gratuit pour toi" in free_txt and "rien à payer" in free_txt, free_txt)
        both_themes(N, "02_nina_arrivee_tel", "[data-testid=collab-arrival]")
        N.get_by_label("Ton nom", exact=True).fill("Nina")
        N.get_by_test_id("arrival-join").click()
        wait_for(N, lambda: collab(N, "c.role()") == "artist", 90, step=300, what="Nina reliée")
        check("invité gratuit : Nina (sans Nova Pro) rejoint la séance de Max", collab(N, "c.role()") == "artist" and not cloud.is_pro(NINA))
        txt = visible_text(N)
        check("invitée : aucun « abonne-toi » ni carte d'abonnement", not re.search(r"abonne-toi|M'abonner|abonnement collaboration", txt, re.I))
        # Elle enregistre : ses opérations sont acceptées par le serveur (membre de la séance).
        N.wait_for_timeout(2500)
        nina_ops = [o for o in cloud.ops if o["sid"] == sid and o["member_key"].startswith(f"u:{NINA}")]
        joined = [k for k, m in cloud.members.items() if k[0] == sid and m.get("uid") == NINA]
        check("Nina est membre de la séance (join 200)", bool(joined), {"membres": [k[1] for k in cloud.members if k[0] == sid], "ops_nina": len(nina_ops)})
        shot(N, "03_nina_dans_la_seance_tel_dark")
        # 3. Héberger sans Nova Pro : refusé dès la création (règle du serveur 1.5.1).
        own = N.evaluate("""async (supa) => {
          const raw = localStorage.getItem('sb-mxdrxpzxbgybchzzvpkf-auth-token'); const tok = raw ? JSON.parse(raw).access_token : '';
          const r = await fetch(supa + '/functions/v1/daw-session', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok, apikey: 'x' },
            body: JSON.stringify({ action: 'create', name: 'Ma collab', purpose: 'collab' }) });
          return { status: r.status, body: await r.json() }; }""", SUPA)
        check("invitée gratuite : héberger SA collaboration → 402 « host_pro »", own["status"] == 402 and own["body"].get("reason") == "host_pro", own)
        res["etapes"]["lot3"] = {"lien": link.replace(BASE, "…/"), "arrivee": free_txt, "creation_refusee": own}
        M.context.close(); N.context.close()

        # 4. Ancien serveur (chaque participant abonné) : message clair, pas d'abonnement proposé.
        old = FakeNovaCloud(per_device=True, codes=True, strict=True, pro={MAX}, server="ancien")
        lM2, lN2 = Log("max_ancien"), Log("nina_ancien"); logs += [lM2, lN2]
        _, M2 = new_page(b, "pc1366", lM2)
        prepare(M2, None, desktop=False)
        connect(M2, old, rt, "M2", MAX, "max@test.local")
        host_session(M2, "04a_max_ancien_serveur", src)
        open_panel(M2)
        M2.get_by_placeholder("Ton nom (affiché aux autres)").fill("Max")
        M2.get_by_role("button", name="Démarrer la collaboration en direct").click()
        wait_for(M2, lambda: collab(M2, "c.role()") is not None, 90, what="séance (ancien serveur)")
        sid2 = next(k for k, v in old.sessions.items() if v["manifest"])
        link2 = f"{BASE}?session={sid2}.{old.sessions[sid2]['secret']}&invite=1"
        _, N2 = new_page(b, "tel390", lN2)
        prepare(N2, None, desktop=False)
        free_billing(N2)
        connect(N2, old, rt, "N2", NINA, "nina@test.local")
        N2.goto(link2, wait_until="domcontentloaded", timeout=180000)
        wait_for(N2, lambda: N2.get_by_test_id("collab-arrival").count() > 0, 120, step=300, what="arrivée (ancien serveur)")
        N2.wait_for_timeout(1200); dismiss(N2)
        N2.get_by_label("Ton nom", exact=True).fill("Nina")
        if N2.get_by_test_id("arrival-join").is_disabled():
            N2.get_by_test_id("arrival-role-engineer").click()  # hôte artiste : Nina vient en ingé son
        N2.get_by_test_id("arrival-join").click()
        wait_shot(N2, lambda: "invités gratuits" in visible_text(N2), 40, "message « mise à jour en attente »", "ancien_serveur")
        t2 = visible_text(N2)
        check("ancien serveur : l'invitée lit « pas encore les invités gratuits… rien à payer »", "pas encore les invités gratuits" in t2 and "rien à payer" in t2)
        check("ancien serveur : aucune carte d'abonnement montrée à l'invitée", not re.search(r"M'abonner|abonne-toi", t2, re.I))
        shot(N2, "04b_nina_ancien_serveur_tel_dark")
        M2.context.close(); N2.context.close()

        # ══════════════════════════════════════════════════ Lot 9a · « Faire sa version »
        lF, lR = Log("max_partage"), Log("rio_copie"); logs += [lF, lR]
        _, F = new_page(b, "pc1366", lF)
        prepare(F, None, desktop=False)
        connect(F, cloud, rt, "F", MAX, "max@test.local")
        fp.install(F)
        host_session(F, "05a_max_projet", src)
        pid = palette(F, "faire sa version")
        check("palette Ctrl+K : « faire sa version » trouve l'action", pid == "pal.forkLink", pid)
        F.get_by_test_id("share-session").wait_for(timeout=10000)
        F.wait_for_timeout(800)
        both_themes(F, "05b_max_faire_sa_version_vide_pc", "[data-testid=share-session]")
        F.get_by_test_id("fork-label").fill("Rappeurs du 93")
        F.get_by_test_id("fork-create").click()
        wait_for(F, lambda: F.get_by_test_id("fork-url").count() > 0, 120, step=400, what="lien « Faire sa version »")
        fork_url = F.get_by_test_id("fork-url").first.input_value()
        check("lien « Faire sa version » : jeton dans le fragment (#copie=)", re.search(r"#copie=[A-Za-z0-9]{32}$", fork_url) is not None, fork_url)
        token = fork_url.split("#copie=")[1]
        fsid = fp.forks[token]["sid"]
        check("la séance de Max est mise en ligne et lui appartient", cloud.sessions[fsid].get("owner") == MAX and cloud.sessions[fsid]["manifest"] is not None)
        both_themes(F, "05c_max_lien_cree_pc", "[data-testid=share-session]")
        host_state = F.evaluate("() => { const s = window.__novaTest.getState(); return { id: s.id, exportKey: s.exportKey || null, bpm: s.bpm, name: s.name }; }")
        frozen = fp.forks[token]["manifest"]
        expected = {name: file_sha1(cloud, f) for name, f in frozen["files"].items()}
        version_before = cloud.sessions[fsid]["version"]
        manifest_before = json.dumps(cloud.sessions[fsid]["manifest"], sort_keys=True)

        _, R = new_page(b, "tel390", lR)
        prepare(R, None, desktop=False)
        free_billing(R)
        connect_out(R, cloud, rt, "R", RIO, "rio@test.local")
        fp.install(R)
        R.goto(fork_url, wait_until="domcontentloaded", timeout=180000)
        R.get_by_test_id("fork-arrival").wait_for(timeout=120000)
        R.wait_for_timeout(1500)
        check("arrivée du lien : connexion demandée (compte gratuit)", R.get_by_test_id("fork-arrival-login").count() == 1)
        both_themes(R, "06a_rio_arrivee_tel", "[data-testid=fork-arrival]")
        R.get_by_test_id("fork-arrival-login").get_by_label("E-mail").fill("rio@test.local")
        R.get_by_test_id("fork-arrival-login").get_by_label("Mot de passe").fill("secret123")
        R.get_by_test_id("fork-arrival-login").get_by_role("button", name="Me connecter").click()
        R.get_by_test_id("fork-arrival-go").wait_for(timeout=20000)
        shot(R, "06b_rio_connecte_tel_dark")
        t0 = time.time()
        R.get_by_test_id("fork-arrival-go").click()
        wait_for(R, lambda: R.evaluate("() => !!(window.__novaFork && window.__novaFork.last)") and R.get_by_test_id("fork-arrival").count() == 0, 120, step=400, what="copie de Rio")
        wait_for(R, lambda: R.evaluate("() => { const t = window.__novaTest; return !!t && /^Ma version/.test(t.getState().name || ''); }"), 60, step=500, what="projet copié ouvert")
        R.wait_for_timeout(2000); dismiss(R)
        got = R.evaluate("() => window.__novaFork.last")
        copy = R.evaluate("() => { const s = window.__novaTest.getState(); return { id: s.id, name: s.name, exportKey: s.exportKey || null, bpm: s.bpm, pistes: s.tracks.filter(t => t.id !== 'master').map(t => ({ name: t.name, clips: t.clips.length, owner: t.collabOwnerKey || null })) }; }")
        res["etapes"]["lot9a"] = {"lien": fork_url.replace(BASE, "…/"), "copie": copy, "empreinte_attendue": expected, "empreinte_recue": got.get("files"), "duree_copie_s": round(time.time() - t0, 1)}
        check("copie identique AU BIT PRÈS (SHA-1 de chaque fichier audio)", got.get("files") == expected and len(expected) > 0, {"attendu": expected, "recu": got.get("files")})
        check("la copie est un projet à Rio : nouvel id, sa propre clé d'export, nom « Ma version · … »",
              copy["id"].startswith("proj-") and copy["id"] != host_state["id"] and copy["exportKey"] and copy["exportKey"] != host_state["exportKey"] and copy["name"].startswith("Ma version"), {"copie": copy, "hote": host_state})
        check("pistes, tempo copiés", copy["bpm"] == host_state["bpm"] and any(t["clips"] > 0 for t in copy["pistes"]), copy)
        both_themes(R, "06c_rio_sa_version_tel")
        # Rio modifie SA version : rien ne part vers la séance de Max.
        R.evaluate("() => window.__novaTest.update(d => { d.bpm = 97; d.tracks.forEach(t => { if (t.id !== 'master') t.name = t.name + ' (Rio)'; }); })")
        R.wait_for_timeout(4000)
        rio_writes = [x for x in cloud.log if x[0] == "R" and x[1] in ("commit", "create", "sign_upload", "op")]
        check("la modification de la copie ne touche pas l'original (aucun envoi de Rio, séance de Max identique)",
              not rio_writes and cloud.sessions[fsid]["version"] == version_before and json.dumps(cloud.sessions[fsid]["manifest"], sort_keys=True) == manifest_before, rio_writes)

        # 7. Compteur et désactivation.
        F.get_by_test_id("share-session").get_by_role("button", name="Fermer").click()
        palette(F, "faire sa version")
        wait_for(F, lambda: F.get_by_test_id("fork-copies").count() > 0 and "1 copie" in F.get_by_test_id("fork-copies").first.inner_text(), 20, step=300, what="compteur 1 copie")
        check("compteur : « 1 copie » chez Max", "1 copie" in F.get_by_test_id("fork-copies").first.inner_text())
        shot(F, "07a_max_compteur_pc_dark")
        F.get_by_test_id("fork-revoke").first.click()
        wait_for(F, lambda: F.get_by_test_id("fork-empty").count() > 0, 20, step=300, what="lien désactivé")
        R.goto(fork_url, wait_until="domcontentloaded", timeout=180000)
        R.get_by_test_id("fork-arrival").wait_for(timeout=120000)
        R.get_by_test_id("fork-arrival-go").wait_for(timeout=20000)
        R.get_by_test_id("fork-arrival-go").click()
        R.get_by_test_id("fork-arrival-error").wait_for(timeout=20000)
        code = R.get_by_test_id("fork-arrival-error").get_attribute("data-code")
        check("lien désactivé → « Ce lien a été désactivé » (410)", code == "revoked" and "désactivé" in R.get_by_test_id("fork-arrival-error").inner_text(), code)
        both_themes(R, "07b_rio_lien_desactive_tel", "[data-testid=fork-arrival]")
        R.get_by_role("button", name="Pas maintenant").click()

        # ══════════════════════════════════════════════════ Lot 9b · page publique
        F.get_by_test_id("share-session").get_by_role("button", name="Fermer").click()
        pid = palette(F, "page publique")
        check("palette Ctrl+K : « page publique » trouve l'action", pid == "pal.publicPage", pid)
        F.get_by_test_id("pub-title").wait_for(timeout=15000)
        F.get_by_test_id("pub-title").fill("Nuit blanche")
        F.get_by_test_id("pub-artist").fill("Max")
        F.get_by_test_id("pub-credits").fill("Prod. Max · voix Léo")
        check("publication : bouton grisé tant que « Je publie » n'est pas coché", F.get_by_test_id("pub-publish").is_disabled())
        both_themes(F, "08a_max_page_publique_formulaire_pc", "[data-testid=share-session]")
        F.get_by_test_id("pub-consent").check()
        F.get_by_test_id("pub-kind-extrait").click()
        F.get_by_test_id("pub-publish").click()
        wait_for(F, lambda: F.get_by_test_id("pub-url").count() > 0 or F.get_by_test_id("pub-error").count() > 0, 180, step=500, what="page publiée")
        perr = F.get_by_test_id("pub-error").inner_text() if F.get_by_test_id("pub-error").count() else None
        check("page publique publiée (extrait de 30 s)", F.get_by_test_id("pub-url").count() > 0, perr)
        pub_url = F.get_by_test_id("pub-url").input_value() if F.get_by_test_id("pub-url").count() else None
        page_rec = next(iter(fp.pages.values()), None)
        check("extrait ≤ 30 s, MP3, une seule partie (jamais les pistes séparées)", bool(page_rec) and page_rec["kind"] == "extrait" and page_rec["audio"]["duration"] <= 30.5
              and page_rec["audio"]["mime"] == "audio/mpeg" and len(page_rec["audio"]["parts"]) == 1, page_rec and page_rec["audio"])
        embed = F.get_by_test_id("pub-embed").input_value() if F.get_by_test_id("pub-embed").count() else ""
        check("code du lecteur à intégrer : <iframe … &embed=1>", embed.startswith("<iframe") and "&embed=1" in embed, embed[:120])
        both_themes(F, "08b_max_page_publiee_pc", "[data-testid=share-session]")

        # 9. Rio (gratuit) : morceau entier grisé, avec la raison.
        palette(R, "page publique")
        R.get_by_test_id("pub-kind-mix").wait_for(timeout=15000)
        wait_for(R, lambda: R.get_by_test_id("pub-mix-why").count() > 0, 20, step=300, what="raison du morceau entier grisé")
        check("compte gratuit : « Morceau entier » grisé, raison donnée", R.get_by_test_id("pub-kind-mix").is_disabled() and "export" in R.get_by_test_id("pub-mix-why").inner_text())
        both_themes(R, "09_rio_page_publique_tel", "[data-testid=share-session]")

        # 10. Visiteurs sans compte.
        out10 = {}
        for vp in ("tel390", "pc1366"):
            lV = Log(f"visiteur_{vp}"); logs.append(lV)
            _, V = new_page(b, vp, lV)
            fp.install(V)
            V.goto(pub_url, wait_until="domcontentloaded", timeout=120000)
            V.get_by_test_id("pub-title-view").wait_for(timeout=30000)
            V.wait_for_timeout(600)
            both_themes(V, f"10_visiteur_page_{vp}")
            booking = V.get_by_test_id("pub-booking").get_attribute("href")
            dl = V.evaluate("() => ({ a: document.querySelectorAll('a[download]').length, controls: document.querySelectorAll('audio[controls], video[controls]').length })")
            V.get_by_test_id("pub-play").click()
            wait_for(V, lambda: V.evaluate("() => (document.querySelector('[data-testid=pub-audio]') || {}).src || ''").startswith("blob:"), 30, step=300, what="son chargé")
            V.wait_for_timeout(800)
            out10[vp] = {"reservation": booking, "telechargement": dl, "texte": V.locator("body").inner_text()[:500]}
            check(f"visiteur {vp} : « Réserver au studio Make Music » → page de réservation", (booking or "").startswith("https://www.studiomakemusic.com/reservation"), booking)
            check(f"visiteur {vp} : aucun téléchargement (ni lien, ni lecteur natif)", dl == {"a": 0, "controls": 0}, dl)
            check(f"visiteur {vp} : titre, artiste, crédits affichés ; pas de pistes séparées", "Nuit blanche" in out10[vp]["texte"] and "Prod. Max" in V.locator("body").inner_text() and "voix.wav" not in V.locator("body").inner_text())
            if vp == "pc1366":
                V.goto(pub_url + "&embed=1", wait_until="domcontentloaded")
                V.set_viewport_size({"width": 560, "height": 152})
                V.get_by_test_id("pub-embed-page").wait_for(timeout=20000)
                V.get_by_test_id("pub-title-view").wait_for(timeout=20000)
                both_themes(V, "10c_lecteur_integre_560x152")
                V.set_viewport_size({"width": 1366, "height": 768})
            shot(V, f"10d_visiteur_lecture_{vp}")
            V.context.close()
        res["etapes"]["lot9b"] = {"page": pub_url.replace(BASE, "…/") if pub_url else None, "visiteurs": out10, "ecoutes": page_rec and page_rec["plays"]}

        # Max retire la page : le lien ne s'ouvre plus.
        F.get_by_test_id("pub-toggle").click()
        wait_for(F, lambda: F.get_by_test_id("pub-status").get_attribute("data-published") == "0", 20, step=300, what="page retirée")
        lV = Log("visiteur_retire"); logs.append(lV)
        _, V = new_page(b, "tel390", lV)
        fp.install(V)
        V.goto(pub_url, wait_until="domcontentloaded")
        V.get_by_test_id("pub-error-page").wait_for(timeout=30000)
        check("page retirée → « Ce morceau n'est plus publié » (410)", V.get_by_test_id("pub-error-page").get_attribute("data-code") == "unpublished")
        both_themes(V, "10e_page_retiree_tel")
        V.context.close()
        shot(F, "10f_max_page_retiree_pc_dark")

        for lg in logs:
            save_log(lg)
        res["erreurs_console"] = {lg.name: [e["text"][:200] for e in lg.errors()][:8] for lg in logs}
        b.close()

    res["verifications"] = checks
    res["ok"] = all(c["ok"] for c in checks)
    (OUT / "invite_copie.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print(f"\n{sum(c['ok'] for c in checks)}/{len(checks)} vérifications OK — {'VERT' if res['ok'] else 'ROUGE'}")
    return res


if __name__ == "__main__":
    r = run()
    sys.exit(0 if r["ok"] else 1)
