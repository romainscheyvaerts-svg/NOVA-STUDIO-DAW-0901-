"""Kits NOVA (13/10/2026) : composer sur une mélodie du catalogue avec les kits, sans jamais exporter gratuitement.

Demande de Romain : les drum kits du studio utilisables pour composer sur les mélodies du catalogue,
export payant. Ce scénario, 100 % hors production (catalogue simulé, qa_hors_prod), headless :

  1. ouvre une mélodie du catalogue (/daw?melody=<id>) : la batterie s'ouvre ;
  2. AUCUN son de kit n'est téléchargé tant qu'on n'écoute rien (chargement à la demande) ;
  3. ouvre « Kits », écoute un kit (motif calé au tempo), le charge sur les pads ;
  4. pose un motif (pas allumés), écoute (lecture), cherche « 808 », écoute et pose un son ;
  5. les fichiers servis ne sont ni des FLAC ni des WAV lisibles (pas de « fLaC » / « RIFF » en tête) ;
  6. aucun bouton, lien ou glisser « télécharger le son » dans le navigateur de kits ;
  7. export : mélodie non achetée -> bloqué (« ACHETER L'INSTRU… »), aucun fichier téléchargé ;
     sans instru du catalogue -> payant (« 2 € » / Nova Pro), aucun fichier sans paiement ;
     admin -> export gratuit annoncé ;
  8. le tout au PC (1600 x 900) et au téléphone (390 x 844), en thème sombre et clair, captures.

  NOVA_URL=http://127.0.0.1:3446/ PYTHONIOENCODING=utf-8 python qa/kits_batterie.py [--formats pc,tel390] [--themes dark,light]
Sorties : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-kits-lrs\\qa) : captures + kits_batterie.json
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3446/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-kits-lrs\qa")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import run_one, shot, BASE, OUT, overflow_report  # noqa: E402
from scenarios import step, close_welcome, wait_text_gone, btn, visible  # noqa: E402

# Audit du thème clair : le même que qa/theme_clair.py (zones très sombres, textes peu contrastés).
_tc = (Path(__file__).parent / "theme_clair.py").read_text(encoding="utf-8")
AUDIT_JS = re.search(r'AUDIT_JS = r"""(.*?)"""', _tc, re.S).group(1)
_AUDIT_OPTS = {"voulues": re.search(r'ZONES_VOULUES = "([^"]+)"', _tc).group(1), "pixelsVoulus": re.search(r'PIXELS_VOULUS = "([^"]+)"', _tc).group(1),
               "aireMin": float(re.search(r"AIRE_MIN = ([\d.]+)", _tc).group(1)), "lumSombre": float(re.search(r"LUM_SOMBRE = ([\d.]+)", _tc).group(1)),
               "contrasteMin": float(re.search(r"CONTRASTE_MIN = ([\d.]+)", _tc).group(1))}


def audit_clair(page, res, ecran):
    """Thème clair seulement : aucune grande zone très sombre ni texte sous 3:1 à l'écran."""
    if os.environ.get("QA_THEME") != "light":
        return
    a = page.evaluate(AUDIT_JS, _AUDIT_OPTS)
    res.setdefault("notes", []).append(f"clair/{ecran} : {len(a['zones'])} zone(s) sombre(s), {a['nTextes']} texte(s) peu contrasté(s)")
    assert a["theme"] == "light", f"thème {a['theme']}"
    assert not a["zones"], f"zones très sombres : {a['zones'][:3]}"
    assert not a["nTextes"], f"textes peu contrastés : {[(t['texte'], t['contraste']) for t in a['textes'][:6]]}"


MELODIE = "8f6206d4-326b-4e0f-98f2-7d81df7699e6"  # « Neon Storm », mélodie du catalogue simulé
OPEN_SPY_JS = "window.__opened = []; window.open = function (u) { window.__opened.push(String(u || '')); return null; };"
DL_RE = re.compile(r"t[ée]l[ée]charg|download|enregistrer sous", re.I)


def billing_admin(page, state):
    """nova-billing : admin (page.route passe avant le simulateur du contexte)."""
    def h(route, request):
        if request.method == "OPTIONS":
            return route.fulfill(status=204, headers={"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST, OPTIONS"})
        try: action = (request.post_data_json or {}).get("action")
        except Exception: action = None
        state.setdefault("billing", []).append(action)
        body = {"status": {"plans": [], "admin": True, "free_exports_left": 999, "free_exports_total": 10},
                "export_unlocked": {"unlocked": True, "admin": True}}.get(action, {"error": "non simulé"})
        return route.fulfill(status=200, content_type="application/json", body=json.dumps(body), headers={"Access-Control-Allow-Origin": "*"})
    page.route("**/functions/v1/nova-billing", h)


def spy_kits(page, state):
    """Requêtes /drums/kits/ : nombre et premiers octets (forme servie)."""
    state.setdefault("kits", [])

    def on_resp(r):
        if "/drums/kits/" in r.url:
            try: head = r.body()[:4]
            except Exception: head = b""
            state["kits"].append({"url": r.url.rsplit("/", 1)[-1], "status": r.status, "head": head.decode("latin1"), "ct": r.headers.get("content-type", "")})
    page.on("response", on_resp)
    state["downloads"] = []
    page.on("download", lambda d: state["downloads"].append(d.suggested_filename))
    # Liens sortants (boutique, paiement) : notés, pas ouverts (le site de la boutique n'est pas simulé).
    page.add_init_script(OPEN_SPY_JS)


def open_melody(page):
    page.goto(BASE + f"daw?melody={MELODIE}", wait_until="domcontentloaded")
    page.wait_for_timeout(1500)
    close_welcome(page)
    wait_text_gone(page, "Chargement", 60)
    page.get_by_role("dialog", name=re.compile("Batterie")).wait_for(timeout=30000)
    # Guide « Ton beat, en 3 gestes » (projet mélodie) : il arrive un peu après, par-dessus.
    for _ in range(12):
        g = btn(page, "C'est parti", exact=True)
        if visible(g):
            g.click(); page.wait_for_timeout(400); break
        page.wait_for_timeout(400)
    page.wait_for_timeout(500)


def click(loc, timeout=8000):
    """Clic robuste (machine chargée : animation du panneau) : clic normal, sinon forcé."""
    loc.scroll_into_view_if_needed(timeout=timeout)
    try:
        loc.click(timeout=timeout)
    except Exception:
        loc.click(force=True, timeout=timeout)


def drum_dialog(page):
    return page.get_by_role("dialog", name=re.compile("Batterie"))


def no_download_ui(page, where):
    bad = page.evaluate("""(re) => {
      const R = new RegExp(re, 'i');
      const root = document.querySelector('[data-testid="kit-browser"]'); if (!root) return ['navigateur absent'];
      const out = [];
      root.querySelectorAll('a[download], audio, video').forEach(n => out.push(n.outerHTML.slice(0, 80)));
      root.querySelectorAll('button, a, [role=button], [title], [aria-label]').forEach(n => {
        const t = `${n.innerText || ''} ${n.getAttribute('title') || ''} ${n.getAttribute('aria-label') || ''}`;
        if (R.test(t)) out.push(t.slice(0, 80));
      });
      return out;
    }""", DL_RE.pattern)
    assert not bad, f"{where} : élément de téléchargement : {bad}"


def check_touch_targets(page, res):
    """Téléphone : cibles du navigateur de kits >= 44 px, pas de débordement horizontal."""
    small = page.evaluate("""() => Array.from(document.querySelectorAll('[data-testid="kit-browser"] button, [data-testid="kit-browser"] select, [data-testid="kit-browser"] input'))
      .filter(b => b.getClientRects().length).map(b => { const r = b.getBoundingClientRect(); return {t: (b.innerText || b.getAttribute('aria-label') || b.tagName).trim().slice(0, 30), w: Math.round(r.width), h: Math.round(r.height)}; })
      .filter(x => x.h < 43.5 || x.w < 43.5)""")
    res.setdefault("notes", []).append(f"cibles < 44 px : {small[:8]}")
    assert not small, f"cibles trop petites au doigt : {small[:8]}"
    # Débordement réel : la page défile en largeur, ou un élément sort de l'écran sans être dans
    # une rangée qui défile exprès (rangées de puces « overflow-x-auto »).
    of = page.evaluate("""() => {
      const vw = innerWidth, out = [];
      if (document.documentElement.scrollWidth > vw + 1) out.push('page : ' + document.documentElement.scrollWidth);
      const scrolls = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; };
      document.querySelectorAll('[role=dialog] button, [role=dialog] h2, [role=dialog] h3, [role=dialog] select, [role=dialog] input').forEach(el => {
        if (!el.getClientRects().length) return;
        const r = el.getBoundingClientRect();
        if ((r.right > vw + 2 || r.left < -2) && !scrolls(el)) out.push((el.innerText || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 30) + ' @' + Math.round(r.right));
      });
      return out;
    }""")
    assert not of, f"débordement : {of[:6]}"


def k_melodie(page, log, res, vp):
    state = {}
    spy_kits(page, state)
    tag = f"{vp}_{os.environ.get('QA_THEME', 'dark')}"
    with step(res, "mélodie du catalogue ouverte, batterie ouverte, aucun son de kit téléchargé"):
        open_melody(page)
        assert state["kits"] == [], f"sons téléchargés sans écoute : {state['kits'][:5]}"
    with step(res, "navigateur des kits : liste des kits, toujours rien de téléchargé"):
        click(page.get_by_test_id("open-kits"))
        page.get_by_test_id("kit-card").first.wait_for(timeout=15000)
        n = page.get_by_test_id("kit-card").count()
        assert n >= 20, f"{n} kits"
        page.wait_for_timeout(600)
        assert state["kits"] == [], f"sons téléchargés à l'ouverture : {len(state['kits'])}"
        no_download_ui(page, "kits")
        shot(page, f"{tag}_1_kits")
        audit_clair(page, res, "kits")
        if vp.startswith("tel"): check_touch_targets(page, res)
    with step(res, "écouter un kit (motif au tempo) : quelques sons seulement, servis brouillés"):
        click(page.get_by_test_id("kit-play").first)
        page.wait_for_timeout(2500)
        got = [k for k in state["kits"] if k["status"] == 200]
        assert 1 <= len(got) <= 8, f"{len(got)} sons téléchargés pour écouter un kit"
        for k in got:
            assert k["head"] not in ("fLaC", "RIFF"), f"{k['url']} servi lisible ({k['head']})"
            assert k["head"] == "NVK1", f"{k['url']} : en-tête {k['head']!r}"
        res["notes"].append(f"écoute d'un kit : {len(got)} sons téléchargés ({', '.join(k['url'] for k in got)})")
    with step(res, "charger le kit : les pads prennent les sons « Kick N », « Snare N »…"):
        click(page.get_by_test_id("kit-load").first)
        page.wait_for_timeout(800)
        txt = drum_dialog(page).inner_text()
        assert re.search(r"Kick \d+", txt), "pad Kick du kit absent"
        assert re.search(r"Snare \d+", txt), "pad Snare du kit absent"
        shot(page, f"{tag}_2_kit_charge")
    with step(res, "poser un motif : 4 pas de kick allumés"):
        # Ferme le navigateur pour voir la grille, puis allume des pas du kick.
        click(page.get_by_role("button", name="Fermer les kits"))
        page.wait_for_timeout(300)
        for si in (1, 5, 9, 13):
            cell = page.get_by_role("button", name=re.compile(rf"^Kick \d+, pas {si}(,|$)")).first
            if visible(cell) and "actif" not in (cell.get_attribute("aria-label") or ""):
                cell.dispatch_event("pointerdown"); cell.dispatch_event("pointerup")
                page.wait_for_timeout(120)
        actifs = page.get_by_role("button", name=re.compile(r"^Kick \d+, pas \d+, actif")).count()
        assert actifs >= 2, f"{actifs} pas actifs sur le kick"
        shot(page, f"{tag}_3_motif")
    with step(res, "écouter le motif (lecture puis pause)"):
        b = drum_dialog(page).get_by_role("button", name=re.compile(r"Écouter"))
        click(b.first)
        page.wait_for_timeout(2200)
        playing = page.evaluate("() => !!(window.__novaTest && window.__novaTest.getState().isPlaying)")
        assert playing, "la lecture n'a pas démarré"
        click(drum_dialog(page).get_by_role("button", name=re.compile(r"Pause")).first)
        page.wait_for_timeout(400)
    with step(res, "sons : chercher « 808 », écouter, poser sur un nouveau pad (808 accordée)"):
        click(page.get_by_test_id("open-kits"))
        click(page.get_by_test_id("kit-tab-sons"))
        page.get_by_test_id("kit-search").fill("808")
        page.wait_for_timeout(400)
        first = page.get_by_test_id("kit-sound").first
        name = first.inner_text().split("\n")[0].strip()
        assert name.startswith("808 "), f"premier résultat : {name}"
        before = len(state["kits"])
        click(first.get_by_test_id("kit-sound-play"))
        page.wait_for_timeout(1500)
        assert len(state["kits"]) == before + 1, "écouter un son = exactement un téléchargement"
        click(first.get_by_test_id("kit-sound-pick"))
        page.wait_for_timeout(800)
        assert name in drum_dialog(page).inner_text(), f"« {name} » absent des pads"
        no_download_ui(page, "sons")
        shot(page, f"{tag}_4_sons_808")
        audit_clair(page, res, "sons")
        if vp.startswith("tel"): check_touch_targets(page, res)
    with step(res, "export : mélodie non achetée -> bloqué, aucun fichier"):
        close_drums(page)
        open_export(page)
        assert "Admin : export gratuit" not in page.inner_text("body")
        seen = try_exports(page, state, r"ACHETER L'INSTRU")
        res["notes"].append(f"export (mélodie non achetée) : {seen}")
        shot(page, f"{tag}_5_export_bloque")
    res["notes"].append(f"sons téléchargés au total : {len(state['kits'])}")
    st = page.evaluate("() => window.__novaKits ? window.__novaKits.stats() : null")
    if st: res["notes"].append(f"coût par son : déchiffrement {st['avgOpenMs']:.2f} ms, décodage {st['avgDecodeMs']:.2f} ms ({st['count']} sons)")


def open_export(page):
    """Fenêtre Exporter, vue avancée (comme qa/r1_export.py)."""
    if page.locator("[role=dialog][aria-labelledby=export-title]").count() == 0:
        b = page.get_by_role("button", name="Exporter le mix").locator("visible=true")
        if b.count() == 0:
            page.locator("button:visible[aria-label='Ouvrir le menu']").first.click(); page.wait_for_timeout(500)
            b = page.locator("button:visible", has_text=re.compile(r"^\s*Exporter\s*$"))
        b.first.click(); page.wait_for_timeout(1500)
    if page.locator("[data-export-vue=avancee]").count() == 0:
        page.get_by_role("button", name=re.compile("Réglages avancés")).click(); page.wait_for_timeout(400)
    page.locator("[data-export-vue=avancee]").wait_for(timeout=10000)


def try_exports(page, state, expect_rx, sources=("MASTER", "STEMS")):
    """Mix puis stems : le bouton annonce le verrou attendu, cliquer ne télécharge rien."""
    seen = {}
    for src in sources:
        b = page.get_by_test_id(f"export-source-{src}")
        if b.count() == 0:
            continue
        b.first.click(); page.wait_for_timeout(400)
        go = page.get_by_test_id("export-go")
        label = go.inner_text().strip()
        seen[src] = label
        assert re.search(expect_rx, label), f"{src} : bouton « {label} »"
        go.click(); page.wait_for_timeout(2000)
        assert not state["downloads"], f"{src} : fichier téléchargé {state['downloads']}"
        opened = page.evaluate("() => (window.__opened || []).splice(0)")
        if opened: seen[src] += f" -> ouvre {opened[0][:80]}"
    assert seen, "aucune source d'export trouvée"
    return seen


def close_drums(page):
    if visible(drum_dialog(page)):
        page.keyboard.press("Escape"); page.wait_for_timeout(300)
    if visible(drum_dialog(page)):
        b = page.get_by_role("button", name="Fermer la batterie")
        b.scroll_into_view_if_needed(); b.click(force=True); page.wait_for_timeout(300)


def k_sans_catalogue(page, log, res, vp):
    """Sons de kits sur un beat importé (pas du catalogue) : export payant, rien sans paiement."""
    state = {}
    spy_kits(page, state)
    with step(res, "projet sans instru du catalogue + kit chargé"):
        open_melody(page)
        page.evaluate("() => window.__novaTest.update(d => { d.tracks.forEach(t => { delete t.instrumentId; }); })")
        click(page.get_by_test_id("open-kits"))
        click(page.get_by_test_id("kit-load").first)
        page.wait_for_timeout(600)
        close_drums(page)
    with step(res, "export (mix et stems) : 2 € ou un export Nova Pro, aucun fichier sans paiement"):
        open_export(page)
        assert "Admin : export gratuit" not in page.inner_text("body")
        seen = try_exports(page, state, r"PAYER 2 €|NOVA PRO")
        res["notes"].append(f"export (sans catalogue) : {seen}")
        shot(page, "pc_sans_catalogue_export_payant")


def k_admin(page, log, res, vp):
    state = {}
    billing_admin(page, state)
    with step(res, "admin : mélodie non achetée, export gratuit annoncé"):
        open_melody(page)
        close_drums(page)
        open_export(page)
        page.get_by_text("Admin : export gratuit").first.wait_for(timeout=10000)
        label = page.get_by_test_id("export-go").inner_text().strip()
        assert not re.search(r"ACHETER|PAYER", label), f"admin : bouton « {label} »"
        res.setdefault("notes", []).append(f"admin : bouton « {label} »")
        shot(page, "pc_admin_export_gratuit")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--formats", default="pc,tel390")
    ap.add_argument("--themes", default="dark,light")
    a = ap.parse_args()
    results = []
    for theme in a.themes.split(","):
        os.environ["QA_THEME"] = theme
        for vp in a.formats.split(","):
            results.append(run_one(k_melodie, vp, name=f"kits_melodie_{vp}_{theme}"))
    os.environ["QA_THEME"] = "dark"
    results.append(run_one(k_sans_catalogue, "pc", name="kits_sans_catalogue_pc"))
    results.append(run_one(k_admin, "pc", name="kits_admin_pc"))
    (OUT / "kits_batterie.json").write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    for r in results:
        print(("OK  " if r["ok"] else "ÉCHEC ") + r["name"], f"({r['secs']} s)")
        for s in r.get("steps", []):
            if not s["ok"]: print("     ✗", s["step"], "→", s.get("err"))
        for n in r.get("notes", []):
            if n.startswith("EXCEPTION"): print("     ", n)
    sys.exit(0 if all(r["ok"] for r in results) else 1)


if __name__ == "__main__":
    main()
