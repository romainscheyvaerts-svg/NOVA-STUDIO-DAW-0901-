"""Mesure de l'egress Supabase d'une séance type (catalogue simulé, cache HTTP réel).

La séance : ouvrir l'accueil (et parcourir toute la liste des instrus), écouter
5 beats, en choisir un, travailler 20 min (lecture, bibliothèque du studio, une
écoute de mélodie et une de beat dans la bibliothèque), puis rouvrir le projet
(sauvegarde .zip, page rechargée, projet rechargé, même beat rechoisi).

Le catalogue est servi par qa_hors_prod en mode « serveur » : *.supabase.co est
résolu vers un serveur HTTPS local (certificat accepté par Chrome via sa clé
publique), sans routes Playwright, pour que le cache HTTP du navigateur joue
comme chez un vrai utilisateur. Aucune requête ne part vers la production.

  NOVA_URL=http://127.0.0.1:3488/ python qa/egress_seance.py --tag avant [--minutes 20]

Sortie : QA_HORS_PROD_DIR\\egress\\seance_<tag>.json (requêtes et octets par type, par étape).
"""
import os
os.environ["QA_HORS_PROD_SERVEUR"] = "1"   # avant d'importer qa_hors_prod

import argparse, json, re, sys, time  # noqa: E402
from pathlib import Path  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
import qa_hors_prod as hp  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

CHROME = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
OUT = hp.DATA_DIR / "egress"
BEATS = ["NOCTAMBULE", "MIDNIGHT", "SANG FROID", "NISKA ORAGE", "CENDRE"]


def snap():
    with hp._LOCK:
        return {"requetes": dict(hp.STATS["simulees"]), "octets": dict(hp.STATS["octets"])}


def diff(a, b):
    out = {"requetes": {}, "octets": {}}
    for k in ("requetes", "octets"):
        for c in set(a[k]) | set(b[k]):
            d = b[k].get(c, 0) - a[k].get(c, 0)
            if d:
                out[k][c] = d
    out["requetes_total"] = sum(out["requetes"].values())
    out["octets_total"] = sum(out["octets"].values())
    return out


def close_welcome(pg):
    for name in ("C'est parti", "Plus tard"):
        b = pg.get_by_role("button", name=name, exact=True).locator("visible=true").first
        try:
            if b.is_visible():
                b.click(); pg.wait_for_timeout(300); return
        except Exception:
            pass


def wait_gone(pg, text, s=60):
    t = time.time()
    while time.time() - t < s:
        if text not in pg.inner_text("body"):
            return
        pg.wait_for_timeout(400)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", required=True)
    ap.add_argument("--minutes", type=float, default=20)
    ap.add_argument("--parcourir", action="store_true", help="faire défiler toute la liste des instrus à l'accueil (pire cas pour les pochettes)")
    a = ap.parse_args()
    base = os.environ.get("NOVA_URL", "http://127.0.0.1:3488/")
    OUT.mkdir(parents=True, exist_ok=True)
    steps, notes = [], []
    t_all = time.time()

    def step(name, fn):
        s0 = snap(); t0 = time.time()
        try:
            fn()
            ok = True
        except Exception as e:  # noqa
            ok = False
            notes.append(f"{name} : {type(e).__name__}: {str(e)[:300]}")
        d = diff(s0, snap())
        d.update({"etape": name, "ok": ok, "secs": round(time.time() - t0, 1)})
        steps.append(d)
        print(f"{'OK' if ok else 'KO'} {name:28s} {d['requetes_total']:4d} req  {d['octets_total'] / 1e6:8.2f} Mo", flush=True)

    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, executable_path=CHROME,
                              args=["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream",
                                    "--use-fake-device-for-media-stream"])
        ctx = b.new_context(viewport={"width": 1600, "height": 900}, locale="fr-BE", accept_downloads=True,
                            permissions=["microphone"])
        ctx.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
        pg = ctx.new_page()
        pg.set_default_timeout(30000)
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)[:300]))

        def accueil():
            pg.goto(base, wait_until="domcontentloaded")
            pg.get_by_text("NOCTAMBULE", exact=True).first.wait_for(timeout=60000)
            pg.wait_for_timeout(2500)
            if not a.parcourir:
                return
            # Pire cas : l'utilisateur parcourt toute la liste des instrus (pochettes chargées en défilant).
            for _ in range(12):
                pg.mouse.move(800, 500); pg.mouse.wheel(0, 700); pg.wait_for_timeout(500)
            pg.wait_for_timeout(1500)
            for _ in range(12):
                pg.mouse.wheel(0, -700); pg.wait_for_timeout(150)

        def ecoute_5():
            for t in BEATS:
                btn = pg.get_by_role("button", name=re.compile(f"Écouter.{{0,3}}{re.escape(t)}")).first
                btn.scroll_into_view_if_needed(); btn.click()
                pause = pg.get_by_role("button", name=re.compile(f"pause.{{0,3}}{re.escape(t)}", re.I)).first
                pause.wait_for(timeout=30000)
                pg.wait_for_timeout(8000)   # 8 s d'écoute
                pause.click(); pg.wait_for_timeout(500)

        def choix():
            pg.get_by_text("NOCTAMBULE", exact=True).first.click()
            pg.wait_for_timeout(1200)
            close_welcome(pg)
            wait_gone(pg, "Chargement", 90)
            pg.wait_for_timeout(2000)
            close_welcome(pg)

        def travail():
            end = time.time() + a.minutes * 60
            k = 0
            while time.time() < end:
                k += 1
                pg.keyboard.press("Space"); pg.wait_for_timeout(15000); pg.keyboard.press("Space")
                if k == 3:
                    # Bibliothèque du studio : onglet Mélodies + écoute d'une mélodie.
                    try:
                        pg.get_by_role("tab", name=re.compile("Mélodies")).last.click(); pg.wait_for_timeout(2000)
                        pg.get_by_role("button", name=re.compile("^Écouter Neon Storm")).first.click(); pg.wait_for_timeout(8000)
                        pg.get_by_role("button", name=re.compile("^Pause Neon Storm")).first.click()
                        pg.get_by_role("tab", name=re.compile("Instrus|Beats")).last.click()
                    except Exception as e:  # noqa
                        notes.append(f"bibliothèque (mélodie) : {str(e)[:200]}")
                if k == 8:
                    try:
                        pg.get_by_role("button", name=re.compile("^Écouter MIDNIGHT")).first.click(); pg.wait_for_timeout(8000)
                        pg.get_by_role("button", name=re.compile("^Pause MIDNIGHT")).first.click()
                    except Exception as e:  # noqa
                        notes.append(f"bibliothèque (beat) : {str(e)[:200]}")
                rest = min(45000, max(0, (end - time.time()) * 1000))
                if rest > 0:
                    pg.wait_for_timeout(rest)

        zip_path = OUT / f"seance_{a.tag}.novaproj.zip"

        def reouverture():
            pg.keyboard.press("Control+s"); pg.wait_for_timeout(1000)
            loc = pg.get_by_role("button", name=re.compile("(Export local|cet appareil)", re.I)).first
            with pg.expect_download(timeout=60000) as dl:
                loc.click()
            dl.value.save_as(str(zip_path))
            pg.wait_for_timeout(500)
            pg.goto(base, wait_until="domcontentloaded")
            pg.get_by_text("NOCTAMBULE", exact=True).first.wait_for(timeout=60000)
            pg.wait_for_timeout(2500)
            pg.get_by_text("Charger Projet").first.click(); pg.wait_for_timeout(800)
            with pg.expect_file_chooser(timeout=10000) as fc:
                pg.get_by_text("Charger depuis l'ordinateur").first.click()
            fc.value.set_files(str(zip_path))
            pg.wait_for_timeout(6000)
            close_welcome(pg)
            # Et le même beat rechoisi depuis l'accueil (nouvelle session sur ce beat).
            pg.goto(base, wait_until="domcontentloaded")
            pg.get_by_text("NOCTAMBULE", exact=True).first.wait_for(timeout=60000)
            pg.wait_for_timeout(1500)
            pg.get_by_text("NOCTAMBULE", exact=True).first.click()
            pg.wait_for_timeout(1200); close_welcome(pg)
            wait_gone(pg, "Chargement", 90)
            pg.wait_for_timeout(3000)

        step("1. accueil" + (" (liste entière parcourue)" if a.parcourir else ""), accueil)
        step("2. écoute de 5 beats", ecoute_5)
        step("3. choix de NOCTAMBULE", choix)
        step(f"4. travail ({a.minutes:g} min)", travail)
        step("5. réouverture du projet", reouverture)
        ctx.close(); b.close()

    total = {"requetes": {}, "octets": {}}
    for s in steps:
        for k in ("requetes", "octets"):
            for c, v in s[k].items():
                total[k][c] = total[k].get(c, 0) + v
    res = {"tag": a.tag, "url": base, "minutes_travail": a.minutes, "duree_s": round(time.time() - t_all),
           "etapes": steps, "total": total, "requetes_total": sum(total["requetes"].values()),
           "octets_total": sum(total["octets"].values()), "notes": notes, "erreurs_page": errors[:20],
           "bloquees": hp.STATS["bloquees"][:20]}
    (OUT / f"seance_{a.tag}.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: res[k] for k in ("requetes_total", "octets_total", "total", "notes")}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
