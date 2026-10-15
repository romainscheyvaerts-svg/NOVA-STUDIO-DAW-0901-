"""Lot 4 (BandLab) : « Masteriser un morceau » et « Caler sur la référence », de bout en bout.

Hors production (qa_hors_prod : Supabase simulé, nova-billing simulé par desktop_gate),
Chrome headless, AUCUNE fenêtre. Au bureau (1600 × 900) et au téléphone (390 × 844), en
thème sombre ET clair :

  1. accueil : le bouton « 🎚️ Masteriser un morceau » est visible et ouvre la page ;
  2. page vide (dépôt), puis un fichier WAV déposé : master rendu tout seul (Rap / Trap,
     Moyen, Spotify) ; LUFS à ±0,5 LU de −14, crête vraie ≤ −1 dBTP ;
  3. A/B : original / master / référence, « même volume perçu » coché par défaut ;
  4. référence (MP3) : l'EQ se cale dessus, l'écart spectral diminue ; cible « Comme la
     référence » atteinte à ±0,5 LU ;
  5. export, nova-billing simulé avec la grille du 14/10 (simulateur de qa/tarifs.py) :
     - admin (bureau, sombre) : WAV 24 bits téléchargé IDENTIQUE au bit près au tampon écouté
       (empreinte SHA-256 du tampon joué, codé comme l'export) ; MP3 320 kb/s dont la crête
       vraie décodée (ffmpeg) reste ≤ −1 dBTP ;
     - compte gratuit : « Payer 1,99 € et télécharger » (prix de la grille), export_access
       avec la clé du morceau (aucun élément du catalogue, aucun kit, portée mix), Stripe
       avec le produit export_project, puis téléchargement une fois le paiement vérifié ;
     - Nova Pro : « inclus dans Nova Pro », téléchargement sans paiement ;
  7. studio : palette Ctrl+K (bureau) et menu du téléphone ouvrent la page ; Échap la ferme ;
  8. thème clair : aucune zone très sombre, aucun texte sous 3:1 (mêmes mesures que
     qa/theme_clair.py) ; captures regardées.

  NOVA_URL=http://127.0.0.1:3452/ PYTHONIOENCODING=utf-8 python qa/master_fichier.py [--formats pc,tel390] [--themes dark,light]
Sorties : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-bandlab\\lot4_mastering\\qa) : captures + master_fichier.json
"""
import argparse, hashlib, json, os, re, subprocess, sys, time
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3452/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-bandlab\lot4_mastering\qa")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, OUT, BASE, Log, ouvrir_plus_accueil  # noqa: E402
from desktop_gate import install_mocks  # noqa: E402
from tarifs import Billing as TarifsBilling, route_billing  # noqa: E402  (nova-billing simulé, grille du 14/10)
_r1 = (Path(__file__).parent / "r1_export.py").read_text(encoding="utf-8").split("\nwith sync_playwright() as p:")[0]
exec(compile(_r1, "r1_export.py", "exec"))  # DEFAULT_BEAT, close_welcome, wait_text_gone…
from theme_clair import AUDIT_JS, pixels_sombres, ZONES_VOULUES, PIXELS_VOULUS, AIRE_MIN, LUM_SOMBRE, CONTRASTE_MIN, PIXELS_SOMBRES_MAX, BANDE_LIGNES  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

NOCREATE = getattr(subprocess, "CREATE_NO_WINDOW", 0)
TRACK = Path(r"D:\1 WORK\CONTENU\nova-fidelite\regressions\seance_inge\bounce_Session voix · Make Music.wav")
REF_SRC = Path(r"D:\1 WORK\3 EXPORT ABLETON\INSTRU ANCIEN\autres\BIKINI MIX MASTER.wav")
REF_MP3 = OUT / "reference_30s.mp3"
DL = OUT / "telechargements"
DL.mkdir(parents=True, exist_ok=True)

res = {"ecrans": [], "controles": {}, "echecs": []}


class Billing(TarifsBilling):
    """Simulateur de qa/tarifs.py, plus un compte admin (export_access : via admin)."""

    def access(self, body):
        if self.cas == "admin":
            return {"grille": "2026-10-14", "missing": [], "items": [], "login_required": False, "kits": False, "offers": None,
                    "pro": None, "unlocked": True, "via": "admin", "reason": None}
        return super().access(body)

    def reply(self, body):
        st, payload = super().reply(body)
        if self.cas == "admin" and body.get("action") == "status":
            payload = {**payload, "admin": True}
        return st, payload


def ok(cle, cond, detail=""):
    res["controles"][cle] = {"ok": bool(cond), "detail": detail}
    print(("OK  " if cond else "KO  ") + cle + (f" : {detail}" if detail else ""), flush=True)
    if not cond: res["echecs"].append(f"{cle} : {detail}")


def preparer_reference():
    """Référence en MP3 (30 s d'un mix masterisé) : le décodage MP3 est testé aussi."""
    if REF_MP3.exists(): return REF_MP3
    src = REF_SRC if REF_SRC.exists() else TRACK
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", "40", "-t", "30", "-i", str(src), "-b:a", "256k", str(REF_MP3)], check=True, creationflags=NOCREATE)
    return REF_MP3


def mesure(page, nom, vp, theme, settle=400):
    """Capture + audit du thème (mêmes règles que qa/theme_clair.py)."""
    page.wait_for_timeout(settle)
    path = OUT / f"{vp}_{theme}_{nom}.png"
    page.screenshot(path=str(path))
    a = page.evaluate(AUDIT_JS, {"voulues": ZONES_VOULUES, "pixelsVoulus": PIXELS_VOULUS, "aireMin": AIRE_MIN,
                                 "lumSombre": LUM_SOMBRE, "contrasteMin": CONTRASTE_MIN})
    frac, bande = pixels_sombres(path, a["voulues"])
    item = {"ecran": nom, "format": vp, "theme": theme, "capture": path.name, "pixels_sombres": frac, "bande_sombre_px": bande,
            "zones_sombres": a["zones"][:5], "textes_peu_contrastes": a["textes"][:8]}
    if theme == "light":
        pb = []
        if a["theme"] != "light": pb.append(f"<html data-theme> = {a['theme']}")
        if a["zones"]: pb.append(f"{len(a['zones'])} zone(s) très sombre(s)")
        if frac > PIXELS_SOMBRES_MAX: pb.append(f"{frac:.0%} de pixels très sombres")
        if bande >= BANDE_LIGNES * 4: pb.append(f"bande sombre de {bande} px")
        if a["nTextes"]: pb.append(f"{a['nTextes']} texte(s) sous {CONTRASTE_MIN}:1")
        item["problemes"] = pb
        ok(f"theme_clair/{vp}/{nom}", not pb, ", ".join(pb) or f"pixels sombres {frac:.1%}")
        for t in a["textes"][:5]: print("      texte :", repr(t["texte"]), t["contraste"], t["couleur"], "sur", t["fond"], t["el"][:90])
        for z in a["zones"][:3]: print("      zone :", z["el"], z["fond"], f"{z['w']}×{z['h']}")
    res["ecrans"].append(item)


def set_theme_init(ctx, theme):
    ctx.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); localStorage.setItem('nova_welcome_seen', '1'); }} catch (e) {{}}")


def scroll_page(page, frac):
    page.evaluate("(f) => { const el = document.querySelector('[data-nova-qm] > div'); if (el) el.scrollTop = (el.scrollHeight - el.clientHeight) * f; }", frac)
    page.wait_for_timeout(300)


def attendre_pret(page, timeout=180):
    t0 = time.time()
    # Un réglage vient de changer : le nouveau rendu démarre après 0,2 s (sinon on lirait l'ancien).
    try:
        page.wait_for_function("() => document.querySelector('[data-nova-qm]')?.getAttribute('data-qm-state') !== 'pret'", timeout=4000)
    except Exception:
        pass
    page.wait_for_function("() => { const r = document.querySelector('[data-nova-qm]'); return r && r.getAttribute('data-qm-state') === 'pret'; }", timeout=timeout * 1000)
    return round(time.time() - t0, 1)


def etat(page):
    return page.evaluate("() => window.__novaQuickMaster && window.__novaQuickMaster.state()")


def ffmpeg_mesure(path):
    p = subprocess.run(["ffmpeg", "-nostats", "-i", str(path), "-af", "ebur128=peak=true", "-f", "null", "-"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", creationflags=NOCREATE)
    txt = p.stderr
    i = re.findall(r"I:\s+(-?[\d.]+) LUFS", txt)
    pk = re.findall(r"Peak:\s+(-?[\d.]+) dBFS", txt)
    return (float(i[-1]) if i else None), (float(pk[-1]) if pk else None)


def parcours(b, vp, theme, compte):
    log = Log(f"master_fichier_{vp}_{theme}")
    ctx, page = new_page(b, vp, log)
    page.set_default_navigation_timeout(90000)
    set_theme_init(ctx, theme)
    install_mocks(page, "romain" if compte == "admin" else "artiste", {}, {})
    sim = Billing({"admin": "admin", "gratuit": "export_199", "pro": "pro"}[compte])
    route_billing(page, sim)
    tag = f"{vp}/{theme}"
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Nouveau Projet").first.wait_for(timeout=60000)
    ouvrir_plus_accueil(page, touch=vp.startswith("tel"))   # mode simple : sous « Plus d'options »
    btn = page.locator("[data-testid=landing-quick-master]").locator("visible=true")
    btn.first.wait_for(timeout=60000)
    page.wait_for_timeout(800)
    mesure(page, "accueil", vp, theme)
    ok(f"{tag} bouton accueil", btn.count() > 0 and "Masteriser un morceau" in btn.first.inner_text())
    btn.first.click()
    page.locator("[data-nova-qm]").wait_for(timeout=15000)
    mesure(page, "page_vide", vp, theme)

    # Dépôt du morceau : rendu automatique.
    page.set_input_files("[data-qm-input]", str(TRACK))
    secs = attendre_pret(page)
    st = etat(page)
    lufs, tp = st["result"]["lufs"], st["result"]["truePeak"]
    ok(f"{tag} master Spotify −14", abs(lufs + 14) <= 0.5 and tp <= -1.0, f"{lufs:.2f} LUFS, crête vraie {tp:.2f} dBTP, rendu en {secs} s")
    ok(f"{tag} écoute « même volume » par défaut", page.locator("[data-qm-egal]").is_checked())
    mesure(page, "master_pret", vp, theme, 600)
    scroll_page(page, 1); mesure(page, "master_pret_bas", vp, theme); scroll_page(page, 0)

    # A/B
    page.locator("[data-qm-ab=original]").click(); page.wait_for_timeout(300)
    s1 = etat(page)["selected"]
    page.locator("[data-qm-ab=master]").click(); page.wait_for_timeout(300)
    s2 = etat(page)
    ok(f"{tag} A/B original → master, lecture lancée", s1 == "original" and s2["selected"] == "master" and s2["playing"], f"{s1} → {s2['selected']}, lecture={s2['playing']}")
    niveau = page.locator("[data-qm-niveau]").inner_text()
    ok(f"{tag} message d'écoute honnête", "baissé" in niveau or "même volume" in niveau, niveau[:120])
    page.locator("[data-qm-play]").click(); page.wait_for_timeout(200)

    # Style et intensité changent le master.
    page.locator("[data-qm-style=drill]").click(); page.locator("[data-qm-intensite=fort]").click()
    page.wait_for_timeout(400)
    attendre_pret(page)
    st = etat(page)
    ok(f"{tag} Drill fort", abs(st["result"]["lufs"] + 14) <= 0.5 and st["result"]["truePeak"] <= -1.0, f"{st['result']['lufs']:.2f} LUFS, {st['result']['truePeak']:.2f} dBTP")

    # Référence (MP3) : EQ calée, écart réduit ; cible « Comme la référence ».
    page.set_input_files("[data-qm-ref-input]", str(preparer_reference()))
    page.locator("[data-qm-ab=reference]").wait_for(timeout=60000)
    page.wait_for_timeout(500)
    attendre_pret(page)
    e = page.locator("[data-qm-ecart]")
    avant, apres = float(e.get_attribute("data-avant")), float(e.get_attribute("data-apres"))
    ok(f"{tag} EQ calée sur la référence", apres < avant, f"écart {avant:.2f} → {apres:.2f} dB ({(1 - apres / avant) * 100:.0f} %)")
    res.setdefault("ecarts_reference", {})[tag] = {"avant": avant, "apres": apres, "eq": etat(page)["result"]["eq"]}
    page.locator("[data-qm-cible=reference]").click(); page.wait_for_timeout(400)
    attendre_pret(page)
    st = etat(page)
    cible = st["result"]["target"]["lufs"]
    ok(f"{tag} cible « Comme la référence »", abs(st["result"]["lufs"] - cible) <= 0.5 and st["result"]["truePeak"] <= -1.0, f"{st['result']['lufs']:.2f} LUFS pour {cible} visés, {st['result']['truePeak']:.2f} dBTP")
    page.locator("[data-qm-ab=reference]").click(); page.wait_for_timeout(300)
    mesure(page, "reference", vp, theme, 600)
    scroll_page(page, 0.55); mesure(page, "reference_milieu", vp, theme); scroll_page(page, 1); mesure(page, "reference_bas", vp, theme)

    # Export
    label = page.locator("[data-qm-telecharger]").inner_text()
    if compte == "admin":
        ok(f"{tag} libellé admin", "gratuit (admin)" in label, label)
        if vp == "pc" and theme == "dark":
            page.locator("[data-qm-format=wav]").click()
            with page.expect_download(timeout=60000) as d:
                page.locator("[data-qm-telecharger]").click()
            wav = DL / d.value.suggested_filename
            d.value.save_as(str(wav))
            sha_fichier = hashlib.sha256(wav.read_bytes()).hexdigest()
            sha_ecoute = page.evaluate("() => window.__novaQuickMaster.playedWavSha256()")
            l2, pk2 = ffmpeg_mesure(wav)
            ok("écoute = export (WAV 24 bits, au bit près)", sha_fichier == sha_ecoute, f"{wav.name} · SHA-256 {sha_fichier[:16]}… · ffmpeg {l2} LUFS")
            res["export_wav"] = {"fichier": wav.name, "sha256": sha_fichier, "sha256_ecoute": sha_ecoute, "ffmpeg_lufs": l2}
            page.locator("[data-qm-format=mp3]").click()
            with page.expect_download(timeout=90000) as d:
                page.locator("[data-qm-telecharger]").click()
            mp3 = DL / d.value.suggested_filename
            d.value.save_as(str(mp3))
            tp_mp3 = subprocess.run(["ffmpeg", "-nostats", "-i", str(mp3), "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"], capture_output=True, text=True, encoding="utf-8", errors="replace", creationflags=NOCREATE).stderr
            tpk = re.findall(r"Peak:\s+(-?[\d.]+) dBFS", tp_mp3)
            lu = re.findall(r"I:\s+(-?[\d.]+) LUFS", tp_mp3)
            tpv = float(tpk[-1]) if tpk else 99.0
            ok("MP3 320 kb/s : crête vraie décodée ≤ −1 dBTP", tpv <= -1.0 and mp3.suffix == ".mp3", f"{mp3.name} · {lu[-1] if lu else '?'} LUFS · crête vraie {tpv} dBTP")
            res["export_mp3"] = {"fichier": mp3.name, "true_peak": tpv, "lufs": float(lu[-1]) if lu else None}
            mesure(page, "export_fait", vp, theme)
    elif compte == "pro":
        ok(f"{tag} libellé Nova Pro", "inclus dans Nova Pro" in label, label)
        with page.expect_download(timeout=60000) as d:
            page.locator("[data-qm-telecharger]").click()
        wav = DL / ("pro_" + d.value.suggested_filename)
        d.value.save_as(str(wav))
        checkouts = [c for c in sim.calls if c.get("action") == "checkout"]
        ok(f"{tag} Nova Pro : téléchargé sans paiement", not checkouts and wav.stat().st_size > 1000, wav.name)
        mesure(page, "pro_fait", vp, theme)
    else:
        ok(f"{tag} libellé compte gratuit (prix de la grille)", "Payer 1,99 € et télécharger" in label, label)
        acc = [c for c in sim.calls if c.get("action") == "export_access"]
        q = acc[-1] if acc else {}
        ok(f"{tag} export_access : clé du morceau, sans catalogue ni kit", str(q.get("project_key", "")).startswith("master:") and q.get("catalog_ids") == [] and q.get("kits") is False and q.get("scope") == "mix", json.dumps(q)[:200])
        page.locator("[data-qm-format=wav]").click()
        with page.expect_download(timeout=60000) as d:
            page.locator("[data-qm-telecharger]").click()
        wav = DL / ("payant_" + d.value.suggested_filename)
        d.value.save_as(str(wav))
        co = [c for c in sim.calls if c.get("action") == "checkout"]
        ok(f"{tag} paiement Stripe (export_project, clé du morceau) puis téléchargement",
           len(co) == 1 and co[0].get("product") == "export_project" and str(co[0].get("project_key", "")).startswith("master:") and wav.stat().st_size > 1000,
           f"{json.dumps(co[:1])[:160]} · {wav.name}")
        msg = page.locator("[data-qm-export-msg]").inner_text()
        ok(f"{tag} message après paiement", "Paiement reçu" in msg, msg[:140])
        mesure(page, "paiement_fait", vp, theme)

    # Échap ferme la page.
    page.keyboard.press("Escape"); page.wait_for_timeout(500)
    ok(f"{tag} Échap ferme", page.locator("[data-nova-qm]").count() == 0)
    errs = [x["text"][:200] for x in log.errors() if "8765" not in x["text"] and "8766" not in x["text"]]
    ok(f"{tag} console sans erreur", not errs, "; ".join(errs[:3]))
    ctx.close()


def studio(b, vp, theme):
    """Entrées depuis le studio : palette Ctrl+K (bureau), menu du téléphone."""
    log = Log(f"master_fichier_studio_{vp}")
    ctx, page = new_page(b, vp, log)
    page.set_default_navigation_timeout(90000)
    set_theme_init(ctx, theme)
    install_mocks(page, "romain", {}, {})
    route_billing(page, Billing("admin"))
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text(DEFAULT_BEAT, exact=True).first.wait_for(timeout=60000)
    page.get_by_text(DEFAULT_BEAT, exact=True).first.click()
    page.wait_for_timeout(1200)
    close_welcome(page)
    wait_text_gone(page, "Chargement", 60)
    page.wait_for_timeout(1500)
    close_welcome(page)
    if vp == "pc":
        page.mouse.click(5, 300)
        page.keyboard.press("Control+k")
        page.locator("[data-testid=command-palette]").wait_for(timeout=5000)
        page.keyboard.type("masteriser", delay=15); page.wait_for_timeout(300)
        opt = page.locator("[data-testid=command-palette] [data-palette-id='pal.quickMaster']")
        ok("palette Ctrl+K : « Masteriser un morceau »", opt.count() > 0, opt.first.inner_text() if opt.count() else "absent")
        if opt.count(): opt.first.click()
    else:
        page.locator("button:visible[aria-label='Ouvrir le menu']").first.click(); page.wait_for_timeout(600)
        m = page.locator("[data-testid=menu-quick-master]").locator("visible=true")
        ok("téléphone : menu « Masteriser un morceau »", m.count() > 0)
        mesure(page, "menu_studio", vp, theme)
        if m.count(): m.first.click()
    page.locator("[data-nova-qm]").wait_for(timeout=15000)
    ok(f"studio {vp} : la page s'ouvre", True)
    mesure(page, "depuis_studio", vp, theme)
    page.keyboard.press("Escape"); page.wait_for_timeout(500)
    ok(f"studio {vp} : Échap revient au studio", page.locator("[data-nova-qm]").count() == 0)
    if vp == "pc":
        # 4b dans le master d'un projet : Master Nova › « Caler sur la référence ».
        page.mouse.click(5, 300)
        page.keyboard.press("Control+k")
        page.locator("[data-testid=command-palette]").wait_for(timeout=5000)
        page.keyboard.type("master nova", delay=15); page.wait_for_timeout(300)
        page.locator("[data-testid=command-palette] [data-palette-id='pal.masterNova']").first.click()
        page.locator("[data-nova-master]").wait_for(timeout=15000)
        page.set_input_files("[data-nova-reference] input[type=file]", str(preparer_reference()))
        page.locator("[data-nova-ref-match]").wait_for(timeout=60000)
        page.wait_for_timeout(500)
        page.locator("[data-nova-ref-match]").click()
        page.locator("[data-nova-ref-ecart]").wait_for(timeout=180000)
        e = page.locator("[data-nova-ref-ecart]")
        avant, apres = float(e.get_attribute("data-avant")), float(e.get_attribute("data-apres"))
        ok("projet : Master Nova calé sur la référence", apres < avant, f"écart {avant:.2f} → {apres:.2f} dB ({(1 - apres / avant) * 100:.0f} %)")
        res.setdefault("ecarts_reference", {})["projet Master Nova"] = {"avant": avant, "apres": apres}
        allumees = page.locator("[data-nova-master] [data-nova-cible][aria-pressed=true]").count()
        ok("Master Nova : plus de plateforme en surbrillance, cible « Comme la référence » affichée",
           allumees == 0 and page.locator("[data-nova-master] [data-nova-cible=reference]").count() == 1, f"plateformes allumées : {allumees}")
        page.locator("[data-nova-master-rapport] details summary").first.click()
        mesure(page, "master_nova_reference", vp, theme, 500)
        page.locator("[data-nova-master] > div").first.evaluate("el => el.scrollTop = el.scrollHeight")
        mesure(page, "master_nova_reference_bas", vp, theme, 300)
        errs = [x["text"][:200] for x in log.errors() if "8765" not in x["text"] and "8766" not in x["text"]]
        ok("studio pc : console sans erreur", not errs, "; ".join(errs[:3]))
    ctx.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--formats", default="pc,tel390")
    ap.add_argument("--themes", default="dark,light")
    a = ap.parse_args()
    t0 = time.time()
    with sync_playwright() as p:
        b = launch(p)
        for theme in a.themes.split(","):
            for vp in a.formats.split(","):
                compte = {("pc", "dark"): "admin", ("tel390", "dark"): "gratuit", ("pc", "light"): "gratuit", ("tel390", "light"): "pro"}.get((vp, theme), "gratuit")
                try:
                    parcours(b, vp, theme, compte)
                except Exception as e:  # noqa
                    ok(f"parcours {vp}/{theme}", False, f"{type(e).__name__}: {str(e)[:300]}")
                    try: OUT.joinpath(f"erreur_{vp}_{theme}.txt").write_text(str(e), encoding="utf-8")
                    except Exception: pass
        for vp in a.formats.split(","):
            try:
                studio(b, vp, "light" if vp == "tel390" else "dark")
            except Exception as e:  # noqa
                ok(f"studio {vp}", False, f"{type(e).__name__}: {str(e)[:300]}")
        b.close()
    res["duree_s"] = round(time.time() - t0)
    res["bilan"] = {"controles": len(res["controles"]), "ok": sum(1 for c in res["controles"].values() if c["ok"]), "echecs": res["echecs"]}
    (OUT / "master_fichier.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\nBILAN :", json.dumps(res["bilan"], ensure_ascii=False))
    return 1 if res["echecs"] else 0


if __name__ == "__main__":
    sys.exit(main())
