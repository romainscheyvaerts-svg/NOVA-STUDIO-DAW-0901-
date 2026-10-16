"""Nova, ingé son du chat : commandes du DAW, confirmation, paiement respecté, un Ctrl+Z par message.

100 % hors production : Supabase simulé (qa_hors_prod via qalib), nova-billing simulé (cas « gratuit »
de qa/tarifs.py : export payant 1,99 €) et l'API de chat SIMULÉE (aucun appel à Groq ni à Gemini) :
/api/chat (et le déploiement de secours) est intercepté par la page et répond comme le ferait le
modèle, à partir de l'état et du catalogue réellement envoyés par NOVA.

Séance : le modèle de séance voix de NOVA en MODE AVANCÉ (BEAT, REC, LEAD COUPLET, LEAD REFRAIN, BACK 1, BACK 2,
BUS VOX, BUS FX ; le mode simple n'a que BEAT + REC depuis le 16/10/2026), chargé avec le beat NOCTAMBULE du catalogue simulé.

Scénarios, au bureau (1600 × 900, clavier) et au téléphone (390 × 844, au doigt) :
  1. « mets un compresseur 2:1 sur la voix lead » (IA simulée) → ✅ Compresseur ajouté sur REC : 2:1,
     seuil −18 dB ; la requête contient l'état résumé et le catalogue de la palette, bornés ;
  2. « coupe-bas à 80 sur les leads » (compris sans l'IA) → EQ 80 Hz sur toutes les leads ;
  3. « règle les backs comme au studio » (IA simulée, 4 actions) → un SEUL Ctrl+Z défait tout le message ;
  4. « exporte en MP3 » → « Oui, fais-le » demandé, rien d'ouvert avant ; après oui : fenêtre d'export
     avec l'offre payante (1,99 €), aucun paiement lancé par le chat ;
  5. « supprime la piste 3 » → confirmation ; « Non » ne touche à rien ; « Oui, fais-le » supprime ;
     Ctrl+Z la ramène ;
  6. réponse du modèle avec une commande inconnue et un volume hors bornes → ❌ avec la raison,
     volume ramené à +3,5 dB (✅ + note).

  NOVA_URL=http://127.0.0.1:3453/ python qa/chat_inge.py [--vp pc|tel390]
Sorties : D:\\1 WORK\\CONTENU\\nova-chat-inge\\captures (captures + resultats_chat_inge.json)
Au plus UN navigateur headless à la fois.
"""
import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-chat-inge\captures")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import qalib  # noqa: E402,F401  (Supabase simulé, production bloquée)
from qalib import launch, new_page, Log, save_log  # noqa: E402
from tarifs import Billing, route_billing, open_studio, sans_instru_du_catalogue, paywall  # noqa: E402
from scenarios import bottom_nav  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = Path(os.environ["QA_OUT"])
OUT.mkdir(parents=True, exist_ok=True)
INPUT = "input[placeholder*='rends ma voix plus pro']"


class ChatSim:
    """L'API de chat simulée : répond comme le modèle, à partir de ce que NOVA envoie vraiment."""

    def __init__(self):
        self.calls = []

    @staticmethod
    def track(state, role=None, name=None):
        for t in state.get("tracks", []):
            if role and t.get("role") == role:
                return t
            if name and t.get("name") == name:
                return t
        return None

    def reply(self, body):
        msg = (body.get("message") or "").lower()
        st = body.get("state") or {}
        self.calls.append({"message": body.get("message"), "octets": len(json.dumps(body, ensure_ascii=False)),
                           "etat_octets": len(json.dumps(st, ensure_ascii=False)), "catalogue_octets": len(body.get("catalog") or ""),
                           "catalogue_debut": (body.get("catalog") or "").split("\n")[:4], "historique": len(body.get("history") or []),
                           "pistes": [(t.get("n"), t.get("name"), t.get("role")) for t in st.get("tracks", [])]})
        if "compresseur" in msg:
            lead = next((t for t in st.get("tracks", []) if t.get("id") == st.get("selectedTrackId")), None) or self.track(st, role="lead")
            return {"text": "Je pose un compresseur 2:1 sur ta lead, seuil −18 dB, attaque 10 ms : premier étage, il tient la voix sans l'écraser. Le deuxième ira sur le bus voix.",
                    "actions": [{"action": "UPDATE_PLUGIN", "payload": {"trackId": lead["id"], "pluginType": "COMPRESSOR", "params": {"ratio": 2, "threshold": -18, "attackMs": 10, "releaseMs": 120}},
                                 "description": "Compresseur 2:1 sur la lead"}]}
        if "backs" in msg:
            b = self.track(st, role="back")
            return {"text": "Backs façon studio : coupe-bas 200 Hz et coupe-haut 15 kHz, −6 dB sous la lead, un peu à gauche, plus d'envoi réverbe. Un Ctrl+Z annule tout.",
                    "actions": [
                        {"action": "UPDATE_PLUGIN", "payload": {"trackId": b["id"], "pluginType": "PROEQ12", "params": {"hpf": 200, "lpf": 15000}}, "description": "EQ des backs"},
                        {"action": "SET_VOLUME", "payload": {"trackId": b["id"], "volumeDb": -6}, "description": "Backs à −6 dB"},
                        {"action": "SET_PAN", "payload": {"trackId": b["id"], "pan": -0.35}, "description": "Backs à gauche"},
                        {"action": "SET_SEND_LEVEL", "payload": {"trackId": b["id"], "sendId": "send-verb-short", "level": 0.3}, "description": "Plus de réverbe"},
                    ]}
        if "truc" in msg:
            lead = self.track(st, role="lead")
            return {"text": "Je tente la commande et je monte la lead.",
                    "actions": [{"action": "RUN_COMMAND", "payload": {"id": "pal.inexistant"}},
                                {"action": "SET_VOLUME", "payload": {"trackId": lead["id"], "volumeDb": 40}}]}
        return {"text": "Je t'écoute : dis-moi ce que tu veux régler.", "actions": []}


def route_chat(page, sim: ChatSim):
    def handler(route, request):
        if request.method == "OPTIONS":
            return route.fulfill(status=204, headers={"access-control-allow-origin": "*", "access-control-allow-headers": "*"})
        try:
            body = json.loads(request.post_data or "{}")
        except Exception:
            body = {}
        route.fulfill(status=200, content_type="application/json", body=json.dumps(sim.reply(body), ensure_ascii=False))
    # Route de la PAGE : avant le garde du contexte ; vaut aussi pour le déploiement de secours.
    page.route(re.compile(r"/api/chat(\?|$)"), handler)


SESSION_JS = """() => {
  window.__novaTest.update(d => { d.selectedTrackId = 'track-rec-main'; });
  return window.__novaTest.getState().tracks.filter(t => t.type !== 'SEND' && t.id !== 'master')
    .map((t, i) => ({ n: i + 1, id: t.id, name: t.name, type: t.type, voix: t.type === 'AUDIO' && t.id !== 'instrumental' && !t.instrumentId }));
}"""

TRACK_JS = """(id) => { const t = window.__novaTest.getState().tracks.find(x => x.id === id); return t ? JSON.parse(JSON.stringify({
  id: t.id, name: t.name, volume: t.volume, pan: t.pan, sends: t.sends.map(s => [s.id, s.level]),
  plugins: t.plugins.map(p => ({ type: p.type, params: p.type === 'PROEQ12' ? { bands: (p.params.bands || []).map(b => [b.type, b.frequency, b.isEnabled]) } : p.params })) })) : null; }"""


def run_vp(p, vp, res):
    name = f"chat_inge_{vp}"
    log = Log(name)
    r = {"vp": vp, "ok": True, "checks": [], "captures": [], "requetes": []}
    sim, billing = ChatSim(), Billing("gratuit")

    def check(label, cond, extra=""):
        r["checks"].append({"label": label, "ok": bool(cond), **({"extra": str(extra)[:300]} if extra not in ("", None) else {})})
        if not cond:
            r["ok"] = False
        print(("OK  " if cond else "KO  ") + f"[{vp}] {label}" + ("" if cond else f"  → {str(extra)[:200]}"), flush=True)

    def snap(tag):
        path = OUT / f"{name}_{tag}.png"
        page.screenshot(path=str(path))
        r["captures"].append(path.name)

    def track(tid):
        return page.evaluate(TRACK_JS, tid)

    def results_text():
        return page.evaluate("() => [...document.querySelectorAll('[data-testid=chat-result]')].map(e => (e.dataset.ok === '1' ? 'OK ' : 'KO ') + e.innerText.replace(/\\s+/g, ' ').replace(/^[✅❌]\\s*/, '').trim())")

    def send(text, wait_for=None, timeout=12):
        n_res = len(results_text())
        n_pend = page.locator("[data-testid=chat-pending]").count()
        n_calls = len(sim.calls)
        inp = page.locator(INPUT).locator("visible=true").first
        inp.fill(text)
        inp.press("Enter")
        t0 = time.time()
        while time.time() - t0 < timeout:
            page.wait_for_timeout(250)
            if wait_for == "pending" and page.locator("[data-testid=chat-pending]").count() > n_pend:
                break
            if wait_for == "results" and len(results_text()) > n_res:
                break
        page.wait_for_timeout(500)
        return {"api": len(sim.calls) > n_calls, "results": results_text()[n_res:], "ms": round((time.time() - t0) * 1000)}

    def undo():
        # Ctrl+Z du DAW (la case du chat n'a plus le focus : sinon le navigateur annulerait la saisie).
        page.evaluate("() => document.activeElement && document.activeElement.blur()")
        page.keyboard.press("Control+z")
        page.wait_for_timeout(600)

    b = launch(p)
    ctx, page = new_page(b, vp, log)
    # Séance voix complète (REC, LEAD COUPLET, LEAD REFRAIN, BACK 1, BACK 2) : depuis le 16/10/2026, c'est le gabarit
    # du MODE AVANCÉ (le mode simple n'a que BEAT + REC). Le scénario passe donc en mode avancé, comme un ingé son.
    page.add_init_script("try { localStorage.setItem('nova_simple_mode', '0'); } catch (e) {}")
    route_billing(page, billing)
    route_chat(page, sim)
    try:
        open_studio(page)
        sans_instru_du_catalogue(page)
        session = page.evaluate(SESSION_JS)
        r["pistes"] = [f"{t['n']}:{t['name']}" for t in session]
        role = lambda t: "back" if re.search(r"BACK|CHOEUR|DOUBLE|DBL", t["name"].upper()) else "harmony" if "HARMO" in t["name"].upper() else "adlib" if re.search(r"AD.?LIB", t["name"].upper()) else "lead"
        leads = [t for t in session if t["voix"] and role(t) == "lead"]
        backs = [t for t in session if t["voix"] and role(t) == "back"]
        lead_name = next(t["name"] for t in session if t["id"] == "track-rec-main")
        p3 = session[2]
        check("séance voix : au moins 2 leads, 1 back et 3 pistes", len(leads) >= 2 and backs and len(session) >= 3, r["pistes"])
        page.wait_for_timeout(400)
        # Ouvrir Nova.
        if vp == "pc":
            page.get_by_role("button", name="Ouvrir l'assistante Nova").first.click()
        else:
            bottom_nav(page).get_by_text("Nova", exact=True).first.tap()
        page.locator(INPUT).locator("visible=true").first.wait_for(timeout=8000)
        page.wait_for_timeout(500)
        # Le bloc « Étape » replié : plus de place pour la conversation (comme un utilisateur le ferait).
        tg = page.get_by_test_id("nova-step-toggle").locator("visible=true")
        if tg.count() and "Réduire" in tg.first.inner_text():
            tg.first.click(); page.wait_for_timeout(200)

        # 1. Compresseur 2:1 (IA simulée).
        o = send("mets un compresseur 2:1 sur la voix lead", "results")
        lead = track("track-rec-main")
        comp = next((x for x in lead["plugins"] if x["type"] == "COMPRESSOR"), None)
        check("1. la demande part à l'IA (simulée)", o["api"], o)
        check(f"1. ✅ « Compresseur ajouté sur {lead_name} : 2:1, seuil −18 dB, attaque 10 ms, relâchement 120 ms »",
              any(x.startswith(f"OK Compresseur ajouté sur {lead_name} : 2:1, seuil −18 dB, attaque 10 ms, relâchement 120 ms") for x in o["results"]), o["results"])
        check("1. compresseur réellement posé : ratio 2, seuil −18, attaque 0,01 s", comp and comp["params"].get("ratio") == 2 and comp["params"].get("threshold") == -18 and abs(comp["params"].get("attack", 0) - 0.01) < 1e-6, comp)
        req = sim.calls[-1] if sim.calls else {}
        r["requetes"].append(req)
        check("1. requête bornée : état résumé (pistes numérotées, rôles) + catalogue de la palette",
              req.get("etat_octets", 99999) <= 6500 and 0 < req.get("catalogue_octets", 0) <= 3200 and any(t[1] == lead_name and t[2] == "lead" and t[0] == 2 for t in req.get("pistes", [])),
              {k: req.get(k) for k in ("octets", "etat_octets", "catalogue_octets", "catalogue_debut")})
        snap("01_compresseur")
        undo()
        lead_after = track("track-rec-main")
        check("1. un Ctrl+Z retire le compresseur", not any(x["type"] == "COMPRESSOR" for x in lead_after["plugins"]), lead_after["plugins"])

        # 2. Coupe-bas à 80 sur les leads (sans l'IA).
        o = send("coupe-bas à 80 sur les leads", "results")
        hp = lambda t: next((bb for x in t["plugins"] if x["type"] == "PROEQ12" for bb in x["params"]["bands"] if bb[0] == "highpass"), None)
        eqs = [hp(track(t["id"])) for t in leads]
        check("2. compris sans l'IA (aucune requête)", not o["api"], o)
        check(f"2. ✅ EQ sur les {len(leads)} leads : coupe-bas 80 Hz (et rien d'autre annoncé)",
              sum(1 for x in o["results"] if re.match(r"OK EQ ajouté sur .+ : coupe-bas 80 Hz$", x)) == len(leads), o["results"])
        check("2. bande coupe-bas réellement à 80 Hz sur toutes les leads", all(e and e[1] == 80 and e[2] for e in eqs), eqs)
        snap("02_coupe_bas")

        # 3. Plusieurs actions → un seul Ctrl+Z.
        before = track(backs[0]["id"])
        o = send("règle les backs comme au studio", "results")
        after = track(backs[0]["id"])
        check("3. 4 actions faites (EQ 200 Hz / 15 kHz, −6 dB, pan, réverbe)", sum(1 for x in o["results"] if x.startswith("OK")) == 4, o["results"])
        check("3. backs réellement réglés", abs(after["volume"] - 0.5) < 0.01 and abs(after["pan"] + 0.35) < 0.01 and any(x["type"] == "PROEQ12" for x in after["plugins"]), after)
        snap("03_backs")
        undo()
        undone = track(backs[0]["id"])
        check("3. UN Ctrl+Z défait tout le message (EQ, volume, pan, envoi)", undone == before, {"avant": before, "apres_ctrl_z": undone})

        # 4. Export MP3 : confirmation, puis le paiement est respecté.
        o = send("exporte en MP3", "pending")
        dlg = page.locator("[role=dialog][aria-labelledby=export-title]")
        check("4. « Oui, fais-le » demandé, rien d'ouvert avant", page.locator("[data-testid=chat-pending][data-state=asked]").count() >= 1 and dlg.count() == 0, o)
        snap("04a_export_confirmation")
        page.get_by_test_id("chat-confirm-yes").locator("visible=true").last.click()
        dlg.wait_for(timeout=8000)
        pw = paywall(page)
        st, tx = pw.get_attribute("data-state"), pw.inner_text()
        check("4. fenêtre d'export ouverte avec l'offre payante (1,99 € ou Nova Pro)", st == "paiement" and "1,99 €" in tx, (st, tx[:160]))
        check("4. aucun paiement lancé par le chat (pas de checkout)", not any(c.get("action") == "checkout" for c in billing.calls), [c.get("action") for c in billing.calls])
        snap("04b_export_paiement")
        page.keyboard.press("Escape"); page.wait_for_timeout(500)
        if dlg.count():
            close = page.get_by_role("button", name=re.compile("Fermer")).locator("visible=true")
            if close.count():
                close.first.click(); page.wait_for_timeout(400)
        check("4. ✅ « Fenêtre d'export ouverte (MP3 demandé) » dans le chat", any("Fenêtre d’export ouverte (MP3 demandé)" in x for x in results_text()), results_text()[-3:])

        # 5. Supprimer la piste 3 : non, puis oui, puis Ctrl+Z.
        o = send("supprime la piste 3", "pending")
        page.get_by_test_id("chat-confirm-no").locator("visible=true").last.click()
        page.wait_for_timeout(600)
        check(f"5. « Non » : la piste 3 ({p3['name']}) est toujours là", track(p3["id"]) is not None, None)
        snap("05a_suppression_non")
        o = send("supprime la piste 3", "pending")
        snap("05b_suppression_confirmation")
        page.get_by_test_id("chat-confirm-yes").locator("visible=true").last.click()
        page.wait_for_timeout(1000)
        check(f"5. « Oui, fais-le » : {p3['name']} supprimée", track(p3["id"]) is None, None)
        check(f"5. ✅ « Piste {p3['name']} supprimée » dans le chat", any(f"Piste {p3['name']} supprimée" in x for x in results_text()), results_text()[-2:])
        snap("05c_suppression_faite")
        undo()
        check("5. Ctrl+Z ramène la piste", track(p3["id"]) is not None, None)

        # 6. Commande inconnue et valeur hors bornes renvoyées par le modèle.
        o = send("ouvre le truc", "results")
        check("6. ❌ commande inconnue refusée, avec la raison", any(x.startswith("KO") and "pal.inexistant" in x and "inconnue" in x for x in o["results"]), o["results"])
        check("6. ✅ volume ramené dans les bornes (+3,5 dB) avec une note", any(x.startswith(f"OK Volume de {lead_name} : +3,5 dB") and "ramené" in x for x in o["results"]), o["results"])
        snap("06_refus_et_bornes")

        errs = [e["text"] for e in log.errors() if "Failed to load resource" not in e["text"]]
        check("aucune erreur de page", not errs, errs[:3])
        r["blocked_writes"] = page._blocked[:10]
    except Exception as e:  # noqa
        r["ok"] = False
        r["checks"].append({"label": "EXCEPTION", "ok": False, "extra": f"{type(e).__name__}: {str(e)[:300]}"})
        print(f"KO  [{vp}] EXCEPTION {type(e).__name__}: {str(e)[:300]}", flush=True)
        try:
            snap("ECHEC")
        except Exception:
            pass
    r["appels_api_chat_simulee"] = len(sim.calls)
    save_log(log, {"result": r})
    ctx.close(); b.close()
    res.append(r)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vp", choices=["pc", "tel390"], action="append")
    a = ap.parse_args()
    res = []
    with sync_playwright() as p:
        for vp in a.vp or ["pc", "tel390"]:
            run_vp(p, vp, res)  # un seul navigateur à la fois
    (OUT / "resultats_chat_inge.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    n = sum(len(r["checks"]) for r in res)
    ok = sum(c["ok"] for r in res for c in r["checks"])
    print(f"\n{ok}/{n} vérifications OK — captures : {OUT}")
    sys.exit(0 if all(r["ok"] for r in res) else 1)


if __name__ == "__main__":
    main()
