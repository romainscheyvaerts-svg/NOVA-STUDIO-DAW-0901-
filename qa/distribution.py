"""Lot 12 BandLab · « Prêt pour Spotify / Apple / TikTok ? », 100 % hors production.

Supabase du catalogue simulé par qa_hors_prod (via qalib) ; nova-billing simulé EN PLUS par ce
scénario (comme qa/tarifs.py) pour décider de l'export. Au bureau (1600 × 900) et au téléphone
(390 × 844, au doigt), en thème sombre et clair, avec captures :

  probleme : instru achetée (licence) ; le projet est abîmé exprès :
             3 s de blanc au début (clips décalés), master à +12 dB (écrêtage, crête),
             titre « … (feat. Kalia) », pochette 3600 × 3000 (pas carrée), une voix ajoutée,
             des paroles. On vérifie les feux, chaque « Corriger », puis le paquet .zip :
             il se rouvre, WAV PCM 24 bits 44,1 kHz stéréo, MP3 (ID3), instrumental,
             a cappella, pochette 3000², Paroles.txt, fiche .txt / .json ;
  refus    : instru du catalogue NON achetée : feu rouge « Acheter la licence », aucun paquet.

  NOVA_URL=http://127.0.0.1:3457/ python qa/distribution.py [--vp pc|tel390] [--theme dark|light] [cas ...]

Au plus UN navigateur headless à la fois.
"""
import argparse
import io
import json
import os
import re
import sys
import time
import wave
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import qalib  # noqa: E402  (Supabase simulé, production bloquée)
from qalib import launch, new_page, Log, save_log  # noqa: E402
from scenarios import DEFAULT_BEAT  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402
from tarifs import GRILLE, statut, route_billing, open_studio, open_export  # noqa: E402

OUT = Path(os.environ.get("QA_OUT", r"D:\1 WORK\CONTENU\nova-bandlab\lot12_distribution\captures"))
OUT.mkdir(parents=True, exist_ok=True)


class Billing:
    """nova-billing simulé : instru achetée (« licence ») ou non (« refus »)."""

    def __init__(self, cas):
        self.cas = cas
        self.calls = []

    def reply(self, body):
        a = body.get("action")
        self.calls.append(body)
        if a == "pricing":
            return 200, GRILLE
        if a == "status":
            return 200, statut(None)
        if a == "export_access":
            ids = body.get("catalog_ids") or []
            owned = self.cas != "refus"
            items = [{"id": i, "title": DEFAULT_BEAT, "kind": "beat", "owned": owned} for i in ids]
            base = {"grille": "2026-10-14", "missing": [], "items": items, "login_required": False, "kits": bool(body.get("kits")), "offers": None, "pro": None}
            if not owned and ids and body.get("scope") == "mix":
                return 200, {**base, "unlocked": False, "via": None, "reason": "catalogue_non_achete",
                             "missing": [{"id": i, "title": DEFAULT_BEAT, "kind": "beat"} for i in ids]}
            return 200, {**base, "unlocked": True, "via": "licence", "reason": None}
        return 400, {"error": "Action inconnue"}


def cover_png(w, h):
    from PIL import Image, ImageDraw
    im = Image.new("RGB", (w, h), (30, 20, 60))
    d = ImageDraw.Draw(im)
    for k in range(0, min(w, h) // 2, 60):
        d.ellipse([w // 2 - k, h // 2 - k, w // 2 + k, h // 2 + k], outline=(200, 80 + k % 150, 220), width=8)
    b = io.BytesIO()
    im.save(b, "PNG")
    return b.getvalue()


ABIMER = """() => window.__novaTest.update(d => {
  for (const t of d.tracks) for (const c of t.clips) c.start += 3;
  const m = d.tracks.find(t => t.id === 'master'); if (m) m.volume = 4;
  const beat = d.tracks.find(t => t.instrumentId !== undefined && t.instrumentId !== null && t.instrumentId !== '' && t.clips.length);
  if (beat) {
    const v = JSON.parse(JSON.stringify(beat));
    v.id = 'qa-voix-lead'; v.name = 'Voix lead'; delete v.instrumentId; v.volume = 0.5;
    v.clips = v.clips.map((c, i) => ({ ...c, id: 'qa-voix-clip-' + i, bufferId: c.bufferId, buffer: c.buffer }));
    d.tracks.push(v);
  }
  d.lyrics = '[Couplet]\\nJe marche dans la nuit\\nSous les lumières de la ville\\n\\n[Refrain]\\nNuit blanche';
})"""


def checks(page):
    return {c["id"]: c for c in page.evaluate("() => (window.__novaDistribution && window.__novaDistribution.checks) || []")}


def wait_analysis(page, timeout=180):
    t0 = time.time()
    while time.time() - t0 < timeout:
        lvl = page.get_by_test_id("dist-summary").get_attribute("data-level")
        busy = page.locator("[data-testid=dist-summary] .fa-spin").count()
        if lvl and lvl != "idle" and not busy:
            return True
        page.wait_for_timeout(500)
    return False


def wait_idle(page, timeout=120):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if not page.locator("[data-testid=dist-summary] .fa-spin").count():
            return True
        page.wait_for_timeout(300)
    return False


MESURES = """() => {
  const p = document.querySelector('[data-testid=distribution-panel]');
  const r = p.getBoundingClientRect();
  const over = Array.from(p.querySelectorAll('*')).filter(e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > innerWidth + 1; }).map(e => e.tagName + '.' + String(e.className).slice(0, 30)).slice(0, 6);
  const small = Array.from(p.querySelectorAll('button, input, select, label')).filter(e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.height < 36 && getComputedStyle(e).display !== 'none' && e.tagName === 'BUTTON'; }).map(e => (e.innerText || e.getAttribute('aria-label') || '').slice(0, 30));
  return { panneau: [Math.round(r.width), Math.round(r.height)], defilement_horizontal: document.documentElement.scrollWidth > innerWidth + 1, hors_ecran: over, petits_boutons: small,
           theme: document.documentElement.getAttribute('data-theme'), fond: getComputedStyle(p).backgroundColor };
}"""


def run_case(p, cas, vp, theme, res):
    os.environ["QA_THEME"] = theme
    name = f"distribution_{cas}_{vp}_{theme}"
    log = Log(name)
    r = {"cas": cas, "vp": vp, "theme": theme, "ok": True, "checks": [], "captures": []}
    sim = Billing(cas)
    phone = vp.startswith("tel")

    def check(label, cond, extra=""):
        r["checks"].append({"label": label, "ok": bool(cond), **({"extra": str(extra)[:300]} if extra != "" else {})})
        if not cond:
            r["ok"] = False

    def snap(tag, full=False):
        path = OUT / f"{name}_{tag}.png"
        page.screenshot(path=str(path), full_page=full)
        r["captures"].append(path.name)

    def scroll_to(testid):
        page.get_by_test_id(testid).first.scroll_into_view_if_needed()
        page.wait_for_timeout(250)

    def tap(testid):
        el = page.get_by_test_id(testid).first
        el.scroll_into_view_if_needed()
        (el.tap if phone else el.click)()

    b = launch(p)
    ctx, page = new_page(b, vp, log)
    route_billing(page, sim)
    t0 = time.time()
    try:
        open_studio(page)
        if cas == "probleme":
            page.evaluate(ABIMER)
            page.wait_for_timeout(800)
        open_export(page)
        # Vue simple de la fenêtre Exporter (15/10/2026) : « Prêt pour Spotify » est dans « Réglages avancés ».
        if not page.get_by_test_id("export-distribution").count():
            r.setdefault("chemin", []).append("Réglages avancés")
            av = page.get_by_test_id("export-avance").first
            av.scroll_into_view_if_needed()
            (av.tap if phone else av.click)()
            page.wait_for_timeout(400)
        btn = page.get_by_test_id("export-distribution")
        btn.scroll_into_view_if_needed()
        check("bouton « Prêt pour Spotify / Apple / TikTok ? » dans la fenêtre Exporter", "Prêt pour Spotify" in btn.inner_text(), btn.inner_text())
        (btn.tap if phone else btn.click)()
        panel = page.get_by_test_id("distribution-panel")
        panel.wait_for(timeout=15000)
        check("la fenêtre Exporter se ferme, la fenêtre de distribution s'ouvre", page.locator("[role=dialog][aria-labelledby=export-title]").count() == 0, "")
        page.wait_for_timeout(1500)
        r["mesures"] = page.evaluate(MESURES)
        check("aucun défilement horizontal, rien hors de l'écran", not r["mesures"]["defilement_horizontal"] and not r["mesures"]["hors_ecran"], r["mesures"])
        check(f"thème {theme} appliqué", r["mesures"]["theme"] == theme, r["mesures"])
        snap("01_ouverture")

        if cas == "refus":
            t1 = time.time()
            while time.time() - t1 < 15 and checks(page).get("licence", {}).get("level") not in ("error",):
                page.wait_for_timeout(300)
            lic = checks(page).get("licence", {})
            check("instru non achetée : feu rouge « Acheter la licence »", lic.get("level") == "error" and lic.get("fix") == "buy_licence", lic)
            fixbtn = page.get_by_test_id("dist-fix-licence")
            check("bouton « Acheter la licence » visible", fixbtn.count() and "Acheter la licence" in fixbtn.inner_text(), fixbtn.inner_text() if fixbtn.count() else "")
            texte = page.get_by_test_id("dist-check-licence").inner_text()
            check("message clair : on ne distribue pas sans licence", "licence" in texte and DEFAULT_BEAT in texte, texte)
            scroll_to("dist-check-licence")
            snap("02_licence_rouge")
            tap("dist-analyze")
            check("la mesure reste possible (aucun fichier donné)", wait_analysis(page), "")
            pk = page.get_by_test_id("dist-package")
            check("paquet impossible : bouton désactivé", pk.is_disabled(), pk.inner_text())
            check("aucun paquet produit", not page.evaluate("() => !!(window.__novaDistribution && window.__novaDistribution.lastZip)"), "")
            snap("03_paquet_bloque")
        else:
            # Infos : titre avec « feat. », artiste, auteurs, explicite.
            page.get_by_test_id("dist-title").fill("Nuit blanche (feat. Kalia)")
            page.get_by_test_id("dist-artist").fill("Lennon")
            page.get_by_test_id("dist-composers").fill("Romain Dupont, Lina Haddad")
            ex = checks(page).get("explicit", {})
            check("explicite pas encore répondu : rouge bloquant", ex.get("level") == "error", ex)
            tap("dist-explicit-non")
            page.get_by_test_id("dist-cover-input").set_input_files({"name": "pochette.png", "mimeType": "image/png", "buffer": cover_png(3600, 3000)})
            page.wait_for_timeout(800)
            c = checks(page)
            check("titre avec « feat. » : orange + Corriger", c.get("title", {}).get("level") == "warn" and c["title"].get("fix") == "title_feat", c.get("title"))
            check("pochette 3600 × 3000 : rouge (pas carrée) + Corriger", c.get("cover", {}).get("level") == "error" and c["cover"].get("fix") == "cover_square", c.get("cover"))
            tap("dist-analyze")
            check("analyse terminée", wait_analysis(page), "")
            page.wait_for_timeout(500)
            c = checks(page)
            r["avant"] = {k: {"level": v["level"], "value": v.get("value")} for k, v in c.items()}
            check("blanc de 3 s au début : orange + Corriger", c.get("silence_start", {}).get("level") == "warn" and c["silence_start"].get("fix") == "trim_start", c.get("silence_start"))
            check("master à +12 dB : écrêtage ou crête en rouge", c.get("clipping", {}).get("level") == "error" or c.get("truepeak", {}).get("level") == "error", (c.get("clipping"), c.get("truepeak")))
            check("licence achetée : vert", c.get("licence", {}).get("level") == "ok", c.get("licence"))
            scroll_to("dist-summary")
            snap("02_feux_avant")
            if phone:
                scroll_to("dist-check-clipping"); snap("02b_feux_son")
            # Corrections
            for cid in ("silence_start", "clipping", "truepeak", "title", "cover"):
                cur = checks(page).get(cid, {})
                if cur.get("level") in ("warn", "error") and cur.get("fix"):
                    tap(f"dist-fix-{cid}")
                    page.wait_for_timeout(600)
                    wait_idle(page)
                    page.wait_for_timeout(300)
            c = checks(page)
            r["apres"] = {k: {"level": v["level"], "value": v.get("value")} for k, v in c.items()}
            check("après « Corriger » : blanc du début vert", c.get("silence_start", {}).get("level") == "ok", c.get("silence_start"))
            check("après « Corriger » : écrêtage vert", c.get("clipping", {}).get("level") == "ok", c.get("clipping"))
            check("après « Corriger » : crête vraie verte", c.get("truepeak", {}).get("level") == "ok", c.get("truepeak"))
            check("après « Corriger » : titre vert, invité déplacé", c.get("title", {}).get("level") == "ok" and page.get_by_test_id("dist-feat").input_value() == "Kalia", (c.get("title"), page.get_by_test_id("dist-feat").input_value()))
            check("après « Corriger » : pochette 3000 × 3000", c.get("cover", {}).get("value") == "3000 × 3000 px", c.get("cover"))
            fixes = page.evaluate("() => window.__novaDistribution.fixes")
            r["corrections"] = fixes
            scroll_to("dist-summary")
            snap("03_feux_apres")
            # Paquet
            pk = page.get_by_test_id("dist-package")
            check("paquet téléchargeable", not pk.is_disabled(), pk.inner_text())
            zbytes = None
            try:
                with page.expect_download(timeout=240000) as dl:
                    (pk.tap if phone else pk.click)()
                path = OUT / f"{name}.zip"
                dl.value.save_as(str(path))
                zbytes = path.read_bytes()
            except Exception as e:  # noqa
                r["download_error"] = str(e)[:200]
            page.get_by_test_id("dist-done").wait_for(timeout=60000)
            last = page.evaluate("() => window.__novaDistribution.lastZip")
            r["zip"] = last
            check("paquet annoncé à l'écran", "Paquet prêt" in page.get_by_test_id("dist-done").inner_text(), "")
            check("zip téléchargé", zbytes is not None, r.get("download_error", ""))
            if zbytes:
                z = zipfile.ZipFile(io.BytesIO(zbytes))
                names = [n.split("/", 1)[1] for n in z.namelist() if not n.endswith("/")]
                r["contenu_zip"] = names
                want = ["Master_WAV24.wav", "Master_MP3_320.mp3", "Instrumental.wav", "A_cappella.wav", "Pochette_3000x3000.jpg", "Paroles.txt", "Credits_et_metadonnees.txt", "metadonnees.json"]
                check("contenu : master WAV 24 + MP3 320 + instrumental + a cappella + pochette + paroles + fiche", all(any(n.endswith(w) for n in names) for w in want), names)
                check("noms de fichiers acceptés par CD Baby (lettres, chiffres, - _)", all(re.match(r"^[A-Za-z0-9_.-]+$", n) for n in names), names)
                for n in z.namelist():
                    if n.endswith(".wav"):
                        with wave.open(io.BytesIO(z.read(n))) as w:
                            spec = (w.getnchannels(), w.getsampwidth() * 8, w.getframerate(), w.getnframes())
                        r.setdefault("wav", {})[n.split("/")[-1]] = spec
                        check(f"{n.split('/')[-1]} : stéréo, 24 bits, 44,1 ou 48 kHz", spec[:2] == (2, 24) and spec[2] in (44100, 48000), spec)
                lens = {s[3] for s in r.get("wav", {}).values()}
                check("instrumental et a cappella calés sur le master (même longueur)", len(lens) == 1, r.get("wav"))
                mp3 = next(z.read(n) for n in z.namelist() if n.endswith(".mp3"))
                check("MP3 avec étiquette ID3 (titre, pochette)", mp3[:3] == b"ID3" and b"APIC" in mp3[:400000], mp3[:3])
                meta = json.loads(z.read(next(n for n in z.namelist() if n.endswith("metadonnees.json"))))
                r["metadonnees"] = {k: meta.get(k) for k in ("titre", "artiste", "invites", "auteurs_compositeurs", "explicite", "isrc", "corrections")}
                check("fiche .json : titre propre, invité, auteurs, explicite non", meta["titre"] == "Nuit blanche" and meta["invites"] == ["Kalia"] and meta["auteurs_compositeurs"] == ["Romain Dupont", "Lina Haddad"] and meta["explicite"] is False, r["metadonnees"])
                check("fiche .json : licence de l'instru achetée", any(x.get("licence_achetee") for x in meta["instrus_catalogue"]), meta["instrus_catalogue"])
                txt = z.read(next(n for n in z.namelist() if n.endswith("Paroles.txt"))).decode("utf-8")
                check("paroles .txt sans « [Refrain] »", "Nuit blanche" in txt and "[" not in txt, txt)
            snap("04_paquet_pret")
            if phone:
                snap("04b_page_entiere", full=True)
        errs = [e["text"] for e in log.errors() if "Failed to load resource" not in e["text"]]
        check("aucune erreur de page", not errs, errs[:3])
    except Exception as e:  # noqa
        r["ok"] = False
        r["checks"].append({"label": "EXCEPTION", "ok": False, "extra": f"{type(e).__name__}: {str(e)[:300]}"})
        try:
            snap("ECHEC")
        except Exception:
            pass
    finally:
        r["secs"] = round(time.time() - t0, 1)
        r["blocked_writes"] = page._blocked[:10]
        save_log(log, {"result": r})
        ctx.close(); b.close()
    res.append(r)
    print(("OK  " if r["ok"] else "KO  ") + f"{cas} [{vp} {theme}] {r['secs']} s " + "; ".join(c["label"] + (f" ({c.get('extra', '')})" if not c["ok"] else "") for c in r["checks"] if not c["ok"]), flush=True)


RUNS = [("probleme", "pc", "dark"), ("probleme", "tel390", "light"), ("refus", "pc", "light"), ("refus", "tel390", "dark")]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vp", choices=["pc", "tel390"], action="append")
    ap.add_argument("--theme", choices=["dark", "light"], action="append")
    ap.add_argument("cas", nargs="*")
    a = ap.parse_args()
    runs = [x for x in RUNS if (not a.cas or x[0] in a.cas) and (not a.vp or x[1] in a.vp) and (not a.theme or x[2] in a.theme)]
    if a.vp and a.theme:
        runs = [(c, v, t) for c in (a.cas or ["probleme", "refus"]) for v in a.vp for t in a.theme]
    res = []
    with sync_playwright() as p:
        for cas, vp, theme in runs:
            run_case(p, cas, vp, theme, res)  # un seul navigateur à la fois
    (OUT / "resultats_distribution.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    ok = all(r["ok"] for r in res)
    print(f"\n{sum(r['ok'] for r in res)}/{len(res)} cas OK — captures : {OUT}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
