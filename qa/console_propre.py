"""Console propre au chargement (constat « Maximum update depth exceeded »).

Navigateur headless, aucune fenêtre. Pour PC, tablette et téléphone :
  1. accueil dans le navigateur ;
  2. ARTISTE (appli Windows simulée) qui ouvre sa session (fichier projet) ;
  3. INVITÉ de la collaboration : l'artiste (PC) démarre « En direct », l'invité
     (ingé) ouvre le lien d'invitation.
Chaque page est observée 4 s après le chargement. Toute erreur ou avertissement
de la console est relevé (texte complet, pile des composants React comprise).

Usage : NOVA_URL=http://127.0.0.1:3441/ python qa/console_propre.py [pc] [tab] [tel]
Sorties : D:\\1 WORK\\CONTENU\\nova-finitions-3\\console_*.png / console_propre.json
"""
import json, os, re, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-finitions-3")
from qalib import BASE, OUT, launch, new_page, shot  # noqa
from gel_pre_effet import prepare, open_project_file  # noqa
from collab_sim import FakeNovaCloud, FakeRealtime, FakeBridgeV7, connect  # noqa
from collab_direct import artist_project, dismiss, wait_for, collab, open_panel  # noqa
from playwright.sync_api import sync_playwright

# Bruits connus, sans rapport avec l'appli : écritures externes bloquées exprès par qalib.
IGNORE = re.compile(r"net::ERR_FAILED|ERR_BLOCKED_BY_CLIENT|status of 4\d\d \(\)$")


# Boucle de rendu React : on garde la pile JavaScript de l'appel (elle montre l'effet
# qui rappelle setState), en plus du message.
STACK_INIT = r"""
(() => { const orig = console.error; console.error = function (...a) {
  try { if (String(a[0]).includes('Maximum update depth')) orig.call(console, 'PILE boucle React : ' + new Error().stack.split(String.fromCharCode(10)).slice(2, 30).join(' <- ')); } catch (e) {}
  return orig.apply(console, a); }; })();
"""


def watch(page, bag):
    page.add_init_script(STACK_INIT)
    def on_console(m):
        if m.type in ("error", "warning"):
            loc = m.location or {}
            bag.append({"type": m.type, "text": m.text[:4000], "url": (loc.get("url") or "")[-80:]})
    page.on("console", on_console)
    page.on("pageerror", lambda e: bag.append({"type": "pageerror", "text": str(e)[:4000]}))
    page.on("response", lambda r: bag.append({"type": "http", "text": f"{r.status} {r.request.method} {r.url[:200]}"}) if r.status >= 400 else None)


def clean(bag):
    return [e for e in bag if not IGNORE.search(e["text"])]


def run(vps):
    res = {"ok": True, "pages": {}}
    with sync_playwright() as p:
        b = launch(p)
        for vp in vps:
            # 1. Accueil
            ctx, pg = new_page(b, vp)
            bag = []; watch(pg, bag)
            prepare(pg, None, desktop=False)
            pg.goto(BASE, wait_until="domcontentloaded"); pg.wait_for_timeout(5000)
            shot(pg, f"console_{vp}_1_accueil")
            res["pages"][f"{vp}_accueil"] = clean(bag); ctx.close()

            # 2. Artiste (appli Windows) qui ouvre sa session
            ctx, pg = new_page(b, vp)
            bag = []; watch(pg, bag)
            prepare(pg, FakeBridgeV7(), desktop=True)
            # Compte simulé valable (le faux jeton de fake_login fait refuser le catalogue : 401).
            connect(pg, FakeNovaCloud(codes=True), FakeRealtime(), "S", "33333333-3333-4333-8333-333333333333", "studio@test.local")
            src = OUT / "console_session_artiste.novaproj.zip"
            artist_project(src)
            open_project_file(pg, src, {}, f"console_{vp}_2_artiste")
            dismiss(pg); pg.wait_for_timeout(4000)
            shot(pg, f"console_{vp}_2_artiste_apres")
            res["pages"][f"{vp}_artiste"] = clean(bag); ctx.close()

            # 3. Invité de la collaboration (l'artiste est sur PC)
            # Fonction daw-session à jour (codes d'invitation). L'ancienne répond 400 « Action
            # inconnue » au code : l'appli s'en passe (lien seul), mais le navigateur l'affiche.
            cloud, rt = FakeNovaCloud(codes=True), FakeRealtime()
            ctxA, A = new_page(b, "pc")
            ctxB, B = new_page(b, vp)
            bagA, bagB = [], []
            watch(A, bagA); watch(B, bagB)
            bridgeA = FakeBridgeV7()
            prepare(A, bridgeA, desktop=True)
            prepare(B, None, desktop=False)
            connect(A, cloud, rt, "A", "11111111-1111-4111-8111-111111111111", "lina@test.local")
            connect(B, cloud, rt, "B", "22222222-2222-4222-8222-222222222222", "max@test.local")
            open_project_file(A, src, {}, f"console_{vp}_3_hote")
            dismiss(A); open_panel(A)
            A.get_by_placeholder("Ton nom (affiché aux autres)").fill("Lina")
            A.get_by_role("button", name=re.compile("Démarrer la collaboration en direct")).click()
            wait_for(A, lambda: collab(A, "c.role()") == "artist", 60, what="collaboration ouverte")
            sid = next(k for k, v in cloud.sessions.items() if v["manifest"])
            B.goto(f"{BASE}?session={sid}.{cloud.sessions[sid]['secret']}&role=engineer", wait_until="domcontentloaded")
            wait_for(B, lambda: collab(B, "c.role()") == "engineer", 60, what="invité relié")
            # L'artiste en direct publie la liste de ses VST : une fois, puis seulement si
            # elle change (avant : relue sans fin, des centaines de GET_PLUGIN_LIST).
            n0 = bridgeA.requests.count("GET_PLUGIN_LIST")
            B.wait_for_timeout(8000)
            res.setdefault("liste_vst_relue_en_8_s", {})[vp] = bridgeA.requests.count("GET_PLUGIN_LIST") - n0
            res.setdefault("liste_vst_relue_total", {})[vp] = bridgeA.requests.count("GET_PLUGIN_LIST")
            shot(B, f"console_{vp}_3_invite_relie")
            shot(A, f"console_{vp}_3_hote_relie")
            res["pages"][f"{vp}_invite"] = clean(bagB)
            res["pages"][f"{vp}_hote_collab"] = clean(bagA)
            ctxA.close(); ctxB.close()
    for k, v in res["pages"].items():
        bad = [e for e in v if e["type"] != "http"]
        print(k, "OK" if not bad else f"{len(bad)} message(s)", flush=True)
        for e in v:
            print("   ", e["type"], e["text"][:300].replace("\n", " | "), flush=True)
        if bad:
            res["ok"] = False
    print("GET_PLUGIN_LIST chez l'artiste (8 s en direct) :", res.get("liste_vst_relue_en_8_s"), "total :", res.get("liste_vst_relue_total"), flush=True)
    if any(v > 2 for v in (res.get("liste_vst_relue_en_8_s") or {}).values()):
        res["ok"] = False
    (OUT / "console_propre.json").write_text(json.dumps(res, indent=2, ensure_ascii=False), encoding="utf-8")
    return res


if __name__ == "__main__":
    run([a for a in sys.argv[1:] if a in ("pc", "tab", "tel")] or ["pc", "tab", "tel"])
