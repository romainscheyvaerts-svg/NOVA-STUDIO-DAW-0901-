"""Scénario de bout en bout : « Ingé à distance », l'artiste REMPLACE un passage
par une autre prise (comping) après avoir reçu les réglages de l'ingé.

Deux navigateurs headless (aucune fenêtre) : l'artiste (navigateur) et l'ingé
(appli Windows simulée, pont VST simulé : compresseur « VST3 » de test).
Serveur NOVA simulé (qa/mode_inge.py), direct Realtime coupé (rattrapage).

L'artiste a deux prises : la prise 1 (3 phrases, active) et la prise 2 (un
autre son, plus doux, sous la phrase 2, coupée). Après le premier aller-retour,
il garde la prise 2 sur la zone « Phrase 2 » (panneau Mix auto → Mes prises).
Attendu : la piste repart toute seule chez l'ingé, qui la regèle avec SON
compresseur et la renvoie ; chez l'artiste, la phrase 2 joue la prise 2 avec
les effets de l'ingé, la phrase 1 ne bouge pas.

Usage :
  NOVA_URL=http://127.0.0.1:4020/ python qa/remplacer_prise.py
"""
import io, json, os, sys, time, wave, zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-collab-durcissement\remplacer_prise")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:4020/")
from qalib import *  # noqa
from gel_pre_effet import FakeBridge, prepare, open_project_file, rms_db, duration_s, voice_wav, export_wav, PHRASES, SR  # noqa
from mode_inge import FakeNovaServer, connect, base_state, BASE_T, dismiss, open_collab, panel, wait_for, text_of, click_track, side_tab, close_plugin_window, engineer_project  # noqa


def take2_wav() -> bytes:
    """Prise 2 : la phrase 2 rechantée (330 Hz, plus douce : -8 dB)."""
    t = np.arange(int(10 * SR)) / SR
    x = np.zeros_like(t)
    a, b = PHRASES[1]
    m = (t >= a) & (t < b)
    env = np.minimum(1, np.minimum((t[m] - a) / 0.02, (b - t[m]) / 0.02))
    x[m] = 0.2 * env * (np.sin(2 * np.pi * 330 * t[m]) + 0.3 * np.sin(2 * np.pi * 660 * t[m])) / 1.3
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def artist_project(path: Path):
    clips = [{"id": f"p{i+1}", "name": "Prise 1", "start": a, "duration": b - a, "offset": a, "fadeIn": 0, "fadeOut": 0,
              "color": "#22d3ee", "type": "AUDIO", "audioRef": "audio/voix.wav", "gain": 1, "takeNumber": 1} for i, (a, b) in enumerate(PHRASES)]
    a, b = PHRASES[1]
    clips.append({"id": "t2", "name": "Prise 2", "start": a, "duration": b - a, "offset": a, "fadeIn": 0, "fadeOut": 0, "color": "#f472b6",
                  "type": "AUDIO", "audioRef": "audio/prise2.wav", "gain": 1, "takeNumber": 2, "isMuted": True})
    tracks = [{**BASE_T, "id": "voix", "name": "Voix lead", "type": "AUDIO", "color": "#22d3ee", "volume": 1.0, "outputTrackId": "master",
               "sends": [], "clips": clips, "plugins": []}]
    st = base_state("proj-artiste-prises", "Session artiste (2 prises)", tracks)
    st["markers"] = [{"id": "m-ph2", "time": a - 0.1, "endTime": b + 0.1, "name": "Phrase 2", "type": "REGION", "color": "#f472b6"}]
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(st))
        z.writestr("audio/voix.wav", voice_wav())
        z.writestr("audio/prise2.wav", take2_wav())


def run():
    res = {"name": "remplacer_prise", "ok": True, "steps": [], "mesures": {},
           "note": "Serveur NOVA simulé, direct Realtime coupé (rattrapage 10 s), pont VST de l'ingé simulé."}
    srv = FakeNovaServer()
    a_src = OUT / "00_session_artiste_2_prises.novaproj.zip"
    e_src = OUT / "00_session_inge.novaproj.zip"
    artist_project(a_src)
    engineer_project(e_src)

    def step(label, fn):
        t = time.time()
        try:
            out = fn()
            res["steps"].append({"step": label, "ok": True, "s": round(time.time() - t, 1), **({"info": out} if out else {})})
            return out
        except Exception as e:  # noqa
            res["ok"] = False
            res["steps"].append({"step": label, "ok": False, "err": f"{type(e).__name__}: {str(e)[:500]}"})
            return None

    with sync_playwright() as p:
        b = launch(p)
        logA, logE = Log("artiste_prises"), Log("inge_prises")
        ctxA, A = new_page(b, "pc", logA)
        ctxE, E = new_page(b, "pc", logE)
        bridge = FakeBridge()
        prepare(A, None, desktop=False)
        prepare(E, bridge, desktop=True)
        connect(A, srv, "11111111-1111-4111-8111-111111111111", "lina@test.local")
        connect(E, srv, "22222222-2222-4222-8222-222222222222", "max@test.local")
        invite = {}

        def setup():
            open_project_file(A, a_src, res, "P1_artiste_deux_prises")
            dismiss(A)
            open_collab(A)
            A.get_by_test_id("collab-mode-remote").click(); A.wait_for_timeout(300)
            A.get_by_test_id("remote-start").click()
            A.get_by_test_id("remote-invite").wait_for(timeout=20000)
            invite["url"] = A.get_by_test_id("remote-invite").input_value()
            open_project_file(E, e_src, res, "P2_inge_session")
            dismiss(E)
            wait_for(E, lambda: E.evaluate("() => !!(window.__novaBridge && window.__novaBridge.isConnected())"), 20, what="pont simulé")
            open_collab(E)
            E.get_by_test_id("collab-mode-remote").click(); E.wait_for_timeout(200)
            E.get_by_test_id("collab-role").select_option("engineer"); E.wait_for_timeout(200)
            E.get_by_test_id("remote-link-input").fill(invite["url"])
            E.get_by_test_id("remote-start").click()
            E.get_by_test_id("remote-panel").wait_for(timeout=20000)
            panel(A)
            A.get_by_test_id("remote-send-voix").click()
            wait_for(E, lambda: E.get_by_test_id("remote-row-voix").count() > 0, 40, what="piste reçue chez l'ingé")
        step("Lien Ingé à distance + piste « Voix lead » (2 prises) envoyée", setup)

        def first_round():
            click_track(E, "Voix lead")
            side_tab(E, "VST")
            E.locator("[data-vst-plugin='NovaTestComp']").first.click(); E.wait_for_timeout(1200)
            close_plugin_window(E)
            panel(E)
            E.get_by_test_id("remote-return-voix").click()
            wait_for(E, lambda: "Envoyée à l'artiste" in text_of(E, "remote-status-voix"), 60, what="gel + envoi")
            panel(A)
            wait_for(A, lambda: A.get_by_test_id("remote-receive-voix").count() > 0, 40, what="réglages prêts")
            A.get_by_test_id("remote-receive-voix").click()
            wait_for(A, lambda: "Mise à jour reçue" in text_of(A, "remote-status-voix"), 30, what="réglages appliqués")
            shot(A, "P3_reglages_recus")
            export_wav(A, OUT / "P_avant_remplacement.wav", "P4")
        step("Premier aller-retour (compresseur VST de l'ingé) + export de l'artiste", first_round)

        def replace_take():
            n_send = sum(1 for o in srv.ops if o["kind"] == "ri_send")
            n_ret = sum(1 for o in srv.ops if o["kind"] == "ri_return")
            A.keyboard.press("Escape"); A.wait_for_timeout(300)
            A.locator("[data-nova-target='mix-auto']").locator("visible=true").first.click(); A.wait_for_timeout(800)
            A.get_by_text("Mes prises").first.wait_for(timeout=8000)
            sel = A.locator("select").filter(has=A.locator("option", has_text="Toute la prise")).first
            opts = sel.locator("option").all_inner_texts()
            idx = next(i for i, t in enumerate(opts) if t.startswith("Phrase 2"))
            sel.select_option(value=sel.locator("option").nth(idx).get_attribute("value"))
            A.wait_for_timeout(400)
            shot(A, "P5_mes_prises_zone_phrase2")
            A.get_by_role("button", name="Garder", exact=True).first.click()
            A.wait_for_timeout(600)
            shot(A, "P6_prise2_gardee")
            A.keyboard.press("Escape")
            t0 = time.time()
            wait_for(A, lambda: sum(1 for o in srv.ops if o["kind"] == "ri_send") > n_send, 30, what="renvoi automatique")
            sent = [o for o in srv.ops if o["kind"] == "ri_send"][-1]["op"]
            wait_for(A, lambda: sum(1 for o in srv.ops if o["kind"] == "ri_return") > n_ret, 90, what="retour automatique de l'ingé")
            panel(A)
            wait_for(A, lambda: "Mise à jour reçue" in text_of(A, "remote-status-voix"), 40, what="mise à jour reçue")
            res["mesures"]["aller_retour_auto_s"] = round(time.time() - t0, 1)
            A.wait_for_timeout(600)
            shot(A, "P7_mise_a_jour_recue")
            panel(E)
            shot(E, "P8_inge_regele")
            clips = [{k: c.get(k) for k in ("id", "start", "duration", "isMuted", "takeNumber")} for c in sent["clips"]]
            return {"clips_envoyes": clips, "v": sent["v"]}
        step("Artiste : garde la prise 2 sur « Phrase 2 » → part chez l'ingé, regelée, revient toute seule", replace_take)

        def export_after():
            export_wav(A, OUT / "P_apres_remplacement.wav", "P9")
            export_wav(E, OUT / "P_inge_apres_remplacement.wav", "P10")
        step("Exports après le remplacement (artiste, ingé)", export_after)

        res["A_erreurs"] = [e["text"][:200] for e in logA.errors()][:12]
        res["E_erreurs"] = [e["text"][:200] for e in logE.errors()][:12]
        res["ops"] = [{k: o[k] for k in ("seq", "role", "kind")} for o in srv.ops]
        save_log(logA); save_log(logE)
        ctxA.close(); ctxE.close(); b.close()

    m = res["mesures"]
    for k, name in {"avant": "P_avant_remplacement.wav", "apres": "P_apres_remplacement.wav", "inge": "P_inge_apres_remplacement.wav"}.items():
        f = OUT / name
        if f.exists():
            m[k] = {"phrase1_dB": rms_db(f, 1.2, 2.8), "phrase2_dB": rms_db(f, 4.2, 5.8), "duree_s": duration_s(f)}
    checks = {}
    if all(k in m for k in ("avant", "apres", "inge")):
        # Prise 2 : -8 dB à la source, mais le compresseur de l'ingé (4:1) resserre l'écart.
        checks["phrase 2 : la prise 2 (plus douce) joue chez l'artiste (≥ 1 dB plus bas après le compresseur, pas muette)"] = (m["avant"]["phrase2_dB"] - m["apres"]["phrase2_dB"]) >= 1 and m["apres"]["phrase2_dB"] > -60
        checks["phrase 1 inchangée (± 0,5 dB)"] = abs(m["avant"]["phrase1_dB"] - m["apres"]["phrase1_dB"]) <= 0.5
        checks["chez l'artiste comme chez l'ingé (phrase 2, ± 1 dB)"] = abs(m["apres"]["phrase2_dB"] - m["inge"]["phrase2_dB"]) <= 1
    sent = next((s.get("info") for s in res["steps"] if "garde la prise 2" in s["step"] and s.get("ok")), None)
    if sent:
        act = {c["id"]: c for c in sent["clips_envoyes"]}
        checks["la version envoyée à l'ingé joue la prise 2 sur la phrase 2"] = any(c.get("takeNumber") == 2 and not c.get("isMuted") for c in act.values())
    res["verifications"] = checks
    if not checks or not all(checks.values()):
        res["ok"] = False
    (OUT / "resultat_remplacer_prise.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: res[k] for k in ("ok", "steps", "mesures", "verifications")}, ensure_ascii=True, indent=1)[:8000])
    return res


if __name__ == "__main__":
    r = run()
    sys.exit(0 if r["ok"] else 1)
