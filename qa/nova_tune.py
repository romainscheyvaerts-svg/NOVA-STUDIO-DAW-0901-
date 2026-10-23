"""Nova Tune (22/10/2026) : fenêtre sobre + réglages avancés + préréglages sourcés.

Headless (aucune fenêtre), hors production (qa_hors_prod via qalib). La fenêtre est montée seule
par le banc qa/harness/hwPlugins.tsx (même cadre que PluginEditor), dans l'appli :
  - bureau 1366 × 768 thème sombre, téléphone 390 × 844 thème clair ;
  - façade : pas de curseur « formulaire », listes seulement en afficheur, aucune phrase d'aide
    posée sur la façade hors réglages avancés, aucun nom de marque, pas de débordement, aucun
    bouton recouvert, contraste ;
  - « Réglages avancés » replié par défaut (pas de mur de boutons), puis ouvert : Flex, Vibrato,
    Formant, Transposer, Type de voix, Notes cibles ;
  - préréglages (menu déroulant) → réglages envoyés au projet (window.__qaHwParams) ;
  - notes cibles : notes choisies au clavier (Do, Sol) puis accords du morceau.
Le son (vitesse, Flex, vibrato, formant, transposition, latence, notes cibles) est mesuré dans
tests/novaTune.test.ts ; lecture = export dans fidelite_export.

Usage : NOVA_URL=http://127.0.0.1:3551/ python qa/nova_tune.py
Sorties : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-tune\\qa) : PNG + nova_tune.json.
"""
import json, os, re, sys
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3551/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-tune\qa")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402,F401  (Supabase simulé avant tout navigateur)
from qalib import BASE, OUT, Log, launch, new_page, balayage_chevauchement  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# Mesure de façade partagée avec qa/plugins_fin.py (même définition des contrôles).
MEASURE = re.search(r'MEASURE = r"""(.*?)"""', (Path(__file__).parent / "plugins_fin.py").read_text(encoding="utf-8"), re.S).group(1)
MARQUES = re.compile(r"auto-?tune|antares|waves|slate|metatune|melodyne|celemony", re.I)
checks = []
res = {}


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:600]}"), flush=True)


def mount(pg, mobile):
    pg.evaluate("async (m) => { const h = await import('/qa/harness/hwPlugins.tsx'); return h.mountHwPlugin('AUTOTUNE', m); }", mobile)
    pg.locator("[data-qa-hw] [data-nova-plugin='AUTOTUNE']").first.wait_for(timeout=20000)
    pg.wait_for_timeout(900)


def params(pg):
    return pg.evaluate("() => ({ ...(window.__qaHwParams || {}) })")


def facade(pg, tag, adv):
    # Téléphone : la fenêtre défile sous le bandeau fixe ; contrôles faits en haut de la fenêtre.
    pg.evaluate("() => { const s = document.querySelector('[data-qa-scroller]'); if (s) s.scrollTop = 0; }")
    pg.wait_for_timeout(200)
    m = pg.evaluate(MEASURE, "AUTOTUNE")
    ch = balayage_chevauchement(pg, "[data-qa-hw] [data-nova-plugin='AUTOTUNE']")
    # Les touches noires du clavier chevauchent les blanches par construction (comme un vrai clavier).
    ch["recouverts"] = [r for r in ch.get("recouverts", []) if not ("hw-piano-black" in " ".join(r.get("chaine", [])) or "hw-piano-key" in " ".join(r.get("pile", [])[:1]))]
    m["chevauchement"] = ch
    # Texte de la fenêtre de l'effet seulement (le bandeau du banc affiche le type interne « AUTOTUNE »).
    txt = pg.locator("[data-qa-hw] [data-nova-plugin='AUTOTUNE']").inner_text()
    m["marques"] = sorted(set(x.lower() for x in MARQUES.findall(txt)))
    res[tag] = m
    check(f"{tag} : façade matériel (titre « Nova Tune », ligne d'info)", m["plugin"] == "AUTOTUNE" and m["infobar"], m)
    check(f"{tag} : aucun curseur « formulaire », listes seulement en afficheur", m["curseurs_range"] == 0 and m["listes_select"] == 0, m)
    check(f"{tag} : aucun nom de marque visible", not m["marques"], m["marques"])
    check(f"{tag} : pas de débordement horizontal", not m["deborde_ecran"] and not m["defilement_horizontal"], m)
    check(f"{tag} : aucun bouton recouvert", not m["chevauchement"].get("recouverts"), m["chevauchement"])
    check(f"{tag} : contraste du texte ≥ 4,5:1", m["contraste_min"] >= 4.5, [m["contraste_min"], m["texte_le_moins_contraste"]])
    if not adv:
        check(f"{tag} : aucune phrase d'aide sur la façade", not m["phrases_aide_facade"], m["phrases_aide_facade"])
    return m


with sync_playwright() as p:
    b = launch(p)
    for theme, vp, qvp in (("dark", "bureau", "pc1366"), ("light", "tel", "tel390")):
        log = Log(f"nova_tune_{vp}_{theme}")
        ctx, pg = new_page(b, qvp, log)
        pg.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); localStorage.setItem('nova_simple_mode', '0'); }} catch (e) {{}}")
        pg.goto(BASE, wait_until="domcontentloaded", timeout=120000)
        pg.wait_for_timeout(3000)
        mount(pg, vp == "tel")
        win = pg.locator("[data-qa-hw]")
        tag = f"{vp}_{theme}"
        pg.screenshot(path=str(OUT / f"{tag}_1_fenetre.png"))
        facade(pg, f"{tag} replié", False)
        nb_knobs = win.locator("[role=slider]").count()
        check(f"{tag} : fenêtre sobre (3 boutons rotatifs, avancé replié)", nb_knobs == 3 and win.locator("[data-nova-param=flex]").count() == 0, nb_knobs)

        # Préréglages sourcés (menu déroulant).
        sel = win.locator("[data-nova-param=preset] select")
        opts = sel.locator("option").all_inner_texts()
        res[f"{tag}_prereglages"] = opts
        check(f"{tag} : menu de préréglages (≥ 8 recettes)", len(opts) >= 9, opts)
        sel.select_option("robot"); pg.wait_for_timeout(300)
        pr = params(pg)
        check(f"{tag} : préréglage « Robot » → vitesse 0, Flex 0", pr.get("speed") == 0 and pr.get("flex") == 0, pr)
        sel.select_option("naturel-expressif"); pg.wait_for_timeout(300)
        pr = params(pg)
        check(f"{tag} : préréglage « Naturel expressif » → Flex 61 %, 35 ms", abs((pr.get("flex") or 0) - 0.61) < 1e-6 and 0.4 < (pr.get("speed") or 0) < 0.42, pr)
        lcd = win.locator("[data-nova-param=speed]").inner_text()
        res[f"{tag}_vitesse_affichee"] = lcd

        # Réglages avancés.
        adv_btn = win.locator("[data-nova-tune-advanced]").first
        adv_btn.scroll_into_view_if_needed()
        (adv_btn.tap() if vp == "tel" else adv_btn.click()); pg.wait_for_timeout(500)
        pg.screenshot(path=str(OUT / f"{tag}_2_avance.png"))
        for pid in ("flex", "vibrato", "formant", "transpose", "voiceType", "targetMode"):
            check(f"{tag} : réglage avancé « {pid} » présent", win.locator(f"[data-nova-param={pid}]").count() > 0)
        facade(pg, f"{tag} avancé", True)
        if vp == "tel":
            small = pg.evaluate("() => [...document.querySelectorAll('[data-qa-hw] [role=slider]')].map(e => { const r = e.getBoundingClientRect(); return Math.round(Math.min(r.width, r.height)); })")
            check(f"{tag} : boutons rotatifs ≥ 44 px au doigt", min(small) >= 44, small)

        # Notes cibles : notes choisies, puis accords du morceau.
        tm = win.locator("[data-nova-param=targetMode] select")
        tm.select_option("custom"); pg.wait_for_timeout(300)
        keys = win.locator("[data-nova-param=targetNotes] [role=checkbox]")
        check(f"{tag} : clavier en mode « notes choisies » (12 cases)", keys.count() == 12, keys.count())
        for lab in ("C (", "G ("):
            k = win.locator(f"[data-nova-param=targetNotes] [aria-label^='{lab}']").first
            k.scroll_into_view_if_needed()
            (k.tap() if vp == "tel" else k.click()); pg.wait_for_timeout(200)
        pr = params(pg)
        check(f"{tag} : notes cibles Do + Sol envoyées", pr.get("targetNotes") == [0, 7] and not pr.get("followChords"), pr)
        pg.screenshot(path=str(OUT / f"{tag}_3_notes_choisies.png"))
        tm.select_option("chords"); pg.wait_for_timeout(300)
        pr = params(pg)
        check(f"{tag} : « accords du morceau » → suit la piste d'accords", pr.get("followChords") is True and pr.get("targetNotes") == [], pr)
        pg.screenshot(path=str(OUT / f"{tag}_4_accords.png"))
        tm.select_option("scale"); pg.wait_for_timeout(300)
        check(f"{tag} : retour à la gamme (boutons de gamme)", win.locator("[data-nova-scale]").count() == 5)

        pg.evaluate("async () => { const h = await import('/qa/harness/hwPlugins.tsx'); h.unmountHwPlugin?.(); }")
        errs = [e["text"][:200] for e in log.errors() if "Failed to load resource" not in e["text"]]
        res[f"erreurs_{tag}"] = errs[:8]
        check(f"{tag} : aucune erreur de page", not errs, errs[:5])
        ctx.close()
    b.close()

res["checks"] = checks
ok = all(c["ok"] for c in checks)
res["ok"] = ok
(OUT / "nova_tune.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"{sum(c['ok'] for c in checks)}/{len(checks)} contrôles OK")
sys.exit(0 if ok else 1)
