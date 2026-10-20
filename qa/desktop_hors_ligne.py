"""Appli Windows, édition HORS LIGNE (clé USB, 1.5.4) : sans compte et sans Internet.

window.__novaDesktop simulé avec edition « hors-ligne » ; TOUTE requête hors du serveur de test
est coupée (comme un PC sans réseau). Vérifie : pas de porte de connexion, projet ouvert depuis
l'ordinateur, export « Nova Studio hors ligne » débloqué sans serveur, fichier WAV non vide,
aucun appel à nova-billing.

  NOVA_URL=http://127.0.0.1:3421/ PYTHONIOENCODING=utf-8 python qa/desktop_hors_ligne.py
Sortie : D:\\1 WORK\\CONTENU\\nova-153\\hors-ligne\\
"""
import json, os, re, sys, wave
from pathlib import Path

os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-153\hors-ligne")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import BASE, OUT, Log, launch, new_page, save_log, shot  # noqa: E402
from gel_pre_effet import WORKER_STUB, open_project_file, rms_db  # noqa: E402
from automation_modes import make_project  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

DESKTOP_JS = ("window.__novaDesktop = Object.freeze({ version: '1.5.4', platform: 'windows', ui: 'qa', edition: 'hors-ligne', "
              "features: Object.freeze(['stems', 'voice', 'reveal-download', 'pick-folder', 'app-update']), "
              "bridges: Object.freeze({ asio: 8766, vst: 8765 }) });")
BRIDGES_ABSENT_JS = """(() => {
  const W = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    const u = String(url).replace(/^(wss?:\\/\\/(127\\.0\\.0\\.1|localhost)):876\\d/, '$1:1');
    return protocols === undefined ? new W(u) : new W(u, protocols);
  };
  window.WebSocket.prototype = W.prototype;
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
})();"""
RES = {"name": "desktop_hors_ligne", "ok": True, "etapes": {}}


def ok(k, v, note=None):
    RES["etapes"][k] = {"ok": bool(v), **({"detail": note} if note is not None else {})}
    if not v:
        RES["ok"] = False
    print(("OK  " if v else "KO  ") + k, "" if note is None else json.dumps(note, ensure_ascii=False)[:400], flush=True)


def run():
    src = OUT / "00_projet_hors_ligne.novaproj.zip"
    make_project(src)
    coupees = []
    with sync_playwright() as p:
        b = launch(p)
        log = Log("desktop_hors_ligne")
        ctx, page = new_page(b, "pc", log)
        page.add_init_script(DESKTOP_JS)
        # Ponts absents (les vrais 8765/8766 du PC ne sont jamais joints) : port fermé, échec immédiat.
        # (route_web_socket + ws.close() fige Playwright quand la page se reconnecte en boucle.)
        page.add_init_script(BRIDGES_ABSENT_JS)
        page.route("**/worklets/vst-bridge-worker-v6.js", lambda r: r.fulfill(status=200, content_type="text/javascript", body=WORKER_STUB))

        def sans_reseau(route, request):
            u = request.url
            if u.startswith(BASE.rstrip("/")) or u.startswith(("data:", "blob:", "ws:", "wss:")):
                return route.fallback()
            coupees.append(u[:160])
            return route.abort("internetdisconnected")
        page.route("**/*", sans_reseau)
        try:
            open_project_file(page, src, RES, "01_projet_ouvert")
            ok("aucune porte de connexion", page.get_by_test_id("desktop-gate").count() == 0)
            ok("projet ouvert sans Internet", page.evaluate("() => !!window.DAW_CONTROL && window.DAW_CONTROL.getState().tracks.some(t => t.id === 'voix')"))

            page.keyboard.press("Escape")
            bt = page.get_by_role("button", name=re.compile(r"^\W*Exporter( le mix)?\s*$")).locator("visible=true").first
            if not bt.is_visible():
                page.get_by_role("button", name=re.compile("Ouvrir le menu")).first.click(); page.wait_for_timeout(500)
                bt = page.get_by_role("button", name=re.compile(r"^\W*Exporter( le mix)?\s*$")).locator("visible=true").first
            bt.click()
            page.get_by_text("Nova Studio hors ligne").first.wait_for(timeout=20000)
            page.wait_for_timeout(800)
            shot(page, "02_export_hors_ligne")
            t = page.inner_text("body")
            ok("export annoncé libre (édition hors ligne)", "exports illimités, sans compte ni Internet" in t)
            ok("aucun prix ni paiement proposé", not re.search(r"Payer|1,99|Stripe", t))

            dest = OUT / "export_hors_ligne.wav"
            with page.expect_download(timeout=240000) as dl:
                simple = page.get_by_text("Mon morceau complet", exact=True).locator("visible=true")
                (simple.first if simple.count() else page.get_by_test_id("export-go").first).click()
            dl.value.save_as(str(dest))
            with wave.open(str(dest)) as w:
                dur = w.getnframes() / w.getframerate()
            niveau = rms_db(dest, 1.0, 9.0) if callable(rms_db) else None
            ok("WAV exporté et non vide", dur > 10 and (niveau is None or niveau > -30), {"duree_s": round(dur, 2), "rms_dB": niveau})
            shot(page, "03_apres_export")

            billing = [u for u in coupees if "nova-billing" in u]
            ok("aucun appel à nova-billing", not billing, billing[:5])
            errs = [e["text"][:200] for e in log.errors()
                    if not re.search(r"Failed to load resource|ERR_INTERNET_DISCONNECTED|Failed to fetch|NetworkError|net::", e["text"])]
            ok("aucune erreur (hors coupures réseau voulues)", not errs, errs[:6])
            RES["requetes_coupees"] = len(coupees)
            RES["exemples_coupees"] = sorted({re.sub(r"\?.*", "", u) for u in coupees})[:25]
        except Exception as e:  # noqa
            ok(f"EXCEPTION {type(e).__name__}", False, str(e)[:400])
            try: shot(page, "zz_echec")
            except Exception: pass
        finally:
            save_log(log, {"result": RES})
            ctx.close(); b.close()
    (OUT / "resultat.json").write_text(json.dumps(RES, ensure_ascii=False, indent=1), encoding="utf-8")
    return RES["ok"]


if __name__ == "__main__":
    sys.exit(0 if run() else 1)
