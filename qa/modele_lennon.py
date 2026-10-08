"""Le modèle privé « LENNON · session de départ Romain » se charge pour le compte romain
(navigateur headless, aucune fenêtre, aucune écriture vers Supabase).

1. Accueil → « Modèles » : le compte connecté est simulé (romain.scheyvaerts@gmail.com)
   par le crochet de test services/templateAccount.setAccountClients ; un invité ne voit
   PAS le modèle (vérifié d'abord).
2. « Utiliser ce modèle » → « Créer le projet » (plugins absents : remplacés).
3. Le projet est exporté (Ctrl+S → cet appareil) et son project.json comparé au modèle :
   pistes masquées et inactives, dossiers (routage / simples), VCA et membres, envois
   (niveau, pan, muet, pré-fader, emplacement), bus nommés, remplaçants.
4. Captures : accueil des modèles, studio (pistes), console (mixer) ; journal de la console.

NOVA_URL=http://127.0.0.1:3446/ PYTHONIOENCODING=utf-8 python qa/modele_lennon.py
"""
import json, os, sys, time, zipfile
from pathlib import Path
sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-modeles\lennon\nova")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3446/")
from qalib import launch, new_page, OUT, Log, save_log, BASE  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

TPL = Path(__file__).resolve().parents[1] / "templates" / "romain-lennon-depart.novatemplate"
EMAIL = "romain.scheyvaerts@gmail.com"

SET_ACCOUNT = r"""
async (email) => {
  const m = await window.__novaAppModule('/services/templateAccount.ts');
  const client = email ? { auth: {
    getSession: async () => ({ data: { session: { user: { email } } } }),
    getUser: async () => ({ data: { user: { email } } }),
  } } : null;
  m.setAccountClients(async () => [client]);
  return true;
}
"""


def shot(page, name):
    p = OUT / f"{name}.png"
    page.screenshot(path=str(p))
    return p.name


def open_templates(page, email):
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_test_id("landing-templates").wait_for(timeout=30000)
    page.evaluate(SET_ACCOUNT, email)
    page.get_by_test_id("landing-templates").click()
    page.get_by_test_id("tpl-account").wait_for(timeout=15000)
    page.wait_for_timeout(1500)


def expected_from_template():
    t = json.loads(TPL.read_text(encoding="utf-8"))
    tr = t["session"]["tracks"]
    by_id = {x["id"]: x for x in tr}
    master = next((x for x in tr if x["id"] == "master"), {})
    return {
        "id": t["id"], "name": t["name"],
        "hidden": sorted(x["name"] for x in tr if x.get("isHidden")),
        "inactive": sorted(x["name"] for x in tr if x.get("isInactive")),
        "routing_folders": sorted(x["name"] for x in tr if (x.get("folder") or {}).get("kind") == "routing"),
        "basic_folders": sorted(x["name"] for x in tr if (x.get("folder") or {}).get("kind") == "basic"),
        "vcas": sorted(x["name"] for x in tr if x.get("isVca")),
        "vca_members": sorted(f"{x['name']} → {by_id[x['vcaId']]['name']}" for x in tr if x.get("vcaId") in by_id),
        "sends": sorted(f"{x['name']} → {by_id[s['id']]['name']}" for x in tr for s in x.get("sends", []) if s["id"] in by_id),
        "buses": sorted(b["name"] for b in master.get("ioBuses", [])),
        "replacements": sorted(f"{x['name']} : {p['params']['templateReplacement']['from']} → {p['params']['templateReplacement']['to']}"
                               for x in tr for p in x.get("plugins", []) if (p.get("params") or {}).get("templateReplacement")),
        "tracks": len(tr),
    }


def from_project(proj):
    tr = proj.get("tracks", [])
    by_id = {x["id"]: x for x in tr}
    master = next((x for x in tr if x["id"] == "master"), {})
    return {
        "hidden": sorted(x["name"] for x in tr if x.get("isHidden")),
        "inactive": sorted(x["name"] for x in tr if x.get("isInactive")),
        "routing_folders": sorted(x["name"] for x in tr if (x.get("folder") or {}).get("kind") == "routing"),
        "basic_folders": sorted(x["name"] for x in tr if (x.get("folder") or {}).get("kind") == "basic"),
        "vcas": sorted(x["name"] for x in tr if x.get("isVca")),
        "vca_members": sorted(f"{x['name']} → {by_id[x['vcaId']]['name']}" for x in tr if x.get("vcaId") in by_id),
        "sends": sorted(f"{x['name']} → {by_id[s['id']]['name']}" for x in tr for s in x.get("sends", []) if s["id"] in by_id),
        "buses": sorted(b["name"] for b in master.get("ioBuses", [])),
        "replacements": sorted(f"{x['name']} : {p['params']['templateReplacement']['from']} → {p['params']['templateReplacement']['to']}"
                               for x in tr for p in x.get("plugins", []) if (p.get("params") or {}).get("templateReplacement")),
        "tracks": len(tr),
    }


def main():
    log = Log("modele_lennon")
    res = {"ok": True, "checks": {}, "shots": []}
    exp = expected_from_template()
    with sync_playwright() as p:
        b = launch(p)
        # 1. Invité : le modèle privé n'apparaît pas.
        ctx, page = new_page(b, "pc", log)
        open_templates(page, None)
        guest_sees = page.locator(f"[data-template-id='{exp['id']}']").count()
        res["checks"]["invité : modèle privé caché"] = guest_sees == 0
        res["shots"].append(shot(page, "01_modeles_invite"))
        ctx.close()

        # 2. Compte romain : le modèle est listé, on crée le projet.
        ctx, page = new_page(b, "pc", log)
        open_templates(page, EMAIL)
        item = page.locator(f"[data-template-id='{exp['id']}']")
        item.wait_for(timeout=15000)
        res["checks"]["romain : modèle listé"] = True
        res["account_text"] = page.get_by_test_id("tpl-account").inner_text()
        item.get_by_test_id("tpl-use").click()
        page.wait_for_timeout(500)
        res["shots"].append(shot(page, "02_modeles_romain"))
        t0 = time.time()
        item.get_by_test_id("tpl-create").click()
        # Studio ouvert : en-têtes de pistes visibles.
        page.locator("[data-track-name]").first.wait_for(timeout=60000)
        page.wait_for_timeout(2500)
        res["studio_s"] = round(time.time() - t0, 1)
        for name in ("C'est parti", "Plus tard"):
            loc = page.get_by_role("button", name=name, exact=True)
            if loc.count() and loc.first.is_visible():
                loc.first.click(); page.wait_for_timeout(400)
        res["notice"] = page.evaluate("() => Array.from(document.querySelectorAll('[role=status], [role=alert]')).map(e => e.innerText).join('\\n').slice(0, 1500)")
        res["visible_tracks"] = page.evaluate("() => Array.from(document.querySelectorAll('[data-track-name]')).map(e => e.getAttribute('data-track-name'))")
        res["shots"].append(shot(page, "03_studio_pistes"))

        # Pistes masquées affichées un instant (liste des pistes) : capture du dossier BEAT, VCA…
        page.wait_for_timeout(9000)   # la notice du modèle se referme
        res["shots"].append(shot(page, "03b_studio_pistes_sans_notice"))
        # 3. Console (mixer) : bouton « Console » du mode avancé.
        cons = page.get_by_role("button", name="Console", exact=True)
        if not (cons.count() and cons.first.is_visible()):
            adv = page.get_by_role("button", name=__import__("re").compile("mode avancé", __import__("re").I))
            if adv.count():
                adv.first.click(); page.wait_for_timeout(800)
                for name in ("Passer en mode avancé", "Mode avancé", "Activer", "OK", "Continuer"):
                    b2 = page.get_by_role("button", name=name, exact=True)
                    if b2.count() and b2.first.is_visible():
                        b2.first.click(); page.wait_for_timeout(600); break
        cons = page.get_by_role("button", name="Console", exact=True)
        res["console_ouverte"] = False
        if cons.count() and cons.first.is_visible():
            cons.first.click(); page.wait_for_timeout(1500); res["console_ouverte"] = True
        res["shots"].append(shot(page, "04_console"))
        res["console_strips"] = page.evaluate("() => Array.from(document.querySelectorAll('[data-track-name], [data-strip-name], [data-mixer-track]')).length")

        # 4. Projet exporté : comparaison au modèle.
        page.keyboard.press("Control+s"); page.wait_for_timeout(1000)
        btn = page.get_by_role("button", name=__import__("re").compile("(Export local|cet appareil)", __import__("re").I)).first
        with page.expect_download(timeout=60000) as dl:
            btn.click()
        zpath = OUT / "projet_depuis_modele.zip"
        dl.value.save_as(str(zpath))
        proj = json.loads(zipfile.ZipFile(zpath).read("project.json"))
        got = from_project(proj)
        for k in ("hidden", "inactive", "routing_folders", "basic_folders", "vcas", "vca_members", "sends", "buses", "replacements"):
            same = got[k] == exp[k]
            res["checks"][k] = same
            if not same:
                res.setdefault("diffs", {})[k] = {"manquants": sorted(set(exp[k]) - set(got[k]))[:20], "en_trop": sorted(set(got[k]) - set(exp[k]))[:20]}
        res["counts"] = {k: len(v) if isinstance(v, list) else v for k, v in got.items()}
        # Pistes masquées : absentes de la liste affichée.
        res["checks"]["pistes masquées non affichées"] = not (set(exp["hidden"]) & set(res["visible_tracks"]))
        ctx.close()
        b.close()
    errors = [e for e in log.entries if e["kind"] in ("console.error", "pageerror")]
    res["console_errors"] = [e["text"] for e in errors][:30]
    res["blocked_writes"] = [e["text"] for e in log.entries if e["kind"] == "blocked-write"][:10]
    res["ok"] = all(res["checks"].values())
    save_log(log, {"result": res})
    (OUT / "verification_modele.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: res[k] for k in ("ok", "checks", "counts", "studio_s")}, ensure_ascii=False, indent=1))
    if res.get("diffs"):
        print(json.dumps(res["diffs"], ensure_ascii=False, indent=1))
    print("erreurs console :", len(res["console_errors"]))
    for e in res["console_errors"][:10]:
        print("  ", e[:200])


if __name__ == "__main__":
    main()
