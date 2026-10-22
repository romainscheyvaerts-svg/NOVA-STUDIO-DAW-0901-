"""🎙️ Séance d'enregistrement voix comme un ingé (audit du 22/10/2026), hors production.

Navigateur headless (aucune fenêtre), micro simulé (balayage de fréquence), Supabase simulé.
Chaque geste est mesuré (touches / clics, secondes) et écrit dans seance_rec.json.

  1. Modèle de Romain (LENNON, 78 pistes) : 1er REC sans rien armer → la prise part sur REC
     (avant : KICK inactive sélectionnée, « Piste indisponible pour l'enregistrement »).
  2. Repère au clavier : K à l'arrêt ouvre son nom → « Couplet 1 », Entrée (2 gestes + le nom).
  3. 10 prises d'affilée sur le couplet (décompte d'une mesure, réglage par défaut) : R / R,
     temps R → enregistrement, STOP → prêt, tête revenue au même point, prises nommées
     « Couplet 1 · Prise 1 » … « Couplet 1 · Prise 10 ».
  4. Annonce de la 1re prise lisible (pas écrasée par « Sauvegarde automatique active »).
  5. Pré-roll de 2 s : 3 reprises repartent du même point (avant : 10 s → 8 s → 6 s).
  6. Jeter la prise en cours : Ctrl+. puis le bouton « 🗑️ Jeter la prise » : aucun couloir,
     aucun numéro consommé, retour au début.
  7. R pendant la lecture : la prise part tout de suite à l'endroit joué (avant : décompte
     par-dessus le beat puis saut en arrière de ~3 s).
  8. Ctrl+Z juste après une prise l'enlève (un geste), 📌 Ctrl+Alt+P garde la dernière.

NOVA_URL=http://127.0.0.1:3532/ PYTHONIOENCODING=utf-8 python qa/seance_rec.py
"""
import io, json, os, re, sys, time, wave, zipfile
from pathlib import Path

import numpy as np

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3532/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-audit-rec\qa")
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402,F401  (Supabase simulé avant tout navigateur)
from qalib import BASE, OUT, CHROME, Log, new_page, shot, save_log, ouvrir_plus_accueil  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SR = 48000
MIC_WAV = OUT / "micro_balayage_150_1200hz.wav"
TID = "track-rec-main"
TPL = Path(__file__).resolve().parents[1] / "templates" / "romain-lennon-depart.novatemplate"
EMAIL = "romain.scheyvaerts@gmail.com"
BPM = 90
BAR = 60 / BPM * 4

checks = []
res = {"mesures": {}}


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:700]}"), flush=True)


def sweep_wav(f0, f1, seconds, amp=0.25, sr=SR) -> bytes:
    t = np.arange(int(seconds * sr)) / sr
    k = (f1 - f0) / seconds
    x = amp * np.sin(2 * np.pi * (f0 * t + 0.5 * k * t * t))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def launch(p):
    if not MIC_WAV.exists():
        MIC_WAV.write_bytes(sweep_wav(150, 1200, 240))
    return p.chromium.launch(headless=True, executable_path=CHROME, args=[
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
        f"--use-file-for-fake-audio-capture={MIC_WAV}", "--autoplay-policy=no-user-gesture-required"])


def make_project(path: Path):
    voice = {"id": TID, "name": "Voix lead", "type": "AUDIO", "color": "#22d3ee", "isMuted": False, "isSolo": False,
             "isTrackArmed": False, "isFrozen": False, "volume": 1.0, "pan": 0, "outputTrackId": "master",
             "sends": [], "clips": [], "plugins": [], "automationLanes": [], "totalLatency": 0}
    state = {
        "id": "proj-seance-rec", "name": "Séance rec", "bpm": BPM, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": [voice], "trackGroups": [], "markers": [], "selectedTrackId": TID, "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True, "vocalMixStyle": "voix-brute",
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))


# Décompte LAISSÉ par défaut (une mesure) : on mesure la séance telle qu'un ingé la vit.
INIT = """
try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_auto_clean', '0'); localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}
"""


def st(page, expr="s => s"):
    return page.evaluate(f"() => {{ const s = window.DAW_CONTROL.getState(); return ({expr})(s); }}")


def wait_rec(page, on, to=20):
    t0 = time.time()
    while time.time() - t0 < to and bool(st(page, "s => s.isRecording")) != on:
        page.wait_for_timeout(15)
    return round(time.time() - t0, 2)


def notice(page):
    return page.evaluate("() => Array.from(document.querySelectorAll('[role=status], [role=alert]')).map(e => e.innerText).join(' | ').slice(0, 500)")


LANES_JS = """async (tid) => {
  const P = await window.__novaAppModule('/utils/playlists.ts');
  const t = window.DAW_CONTROL.getState().tracks.find(x => x.id === tid);
  return P.listLanes(t).map(l => ({ n: l.n, name: l.name }));
}"""

ENGINE_T = "async () => (await window.__novaAppModule('/engine/AudioEngine.ts')).audioEngine.getCurrentTime()"


def lanes(page, tid=TID):
    return page.evaluate(LANES_JS, tid)


def close_cards(page):
    for name in ("C'est parti", "Plus tard"):
        bb = page.get_by_role("button", name=name, exact=True).locator("visible=true").first
        try:
            if bb.is_visible(): bb.click(); page.wait_for_timeout(300)
        except Exception:
            pass


def open_project(page, f: Path):
    page.add_init_script(INIT)
    page.route("**/functions/v1/nova-billing", lambda r: r.fulfill(status=200, content_type="application/json",
               body=json.dumps({"plans": [], "admin": True, "unlocked": True, "free_exports_left": 10})))
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=60000)
    page.get_by_text("Charger Projet").first.click()
    page.wait_for_timeout(700)
    with page.expect_file_chooser(timeout=8000) as fc:
        page.get_by_text("Charger depuis l'ordinateur").first.click()
    fc.value.set_files(str(f))
    page.wait_for_timeout(5000)
    close_cards(page)
    page.wait_for_function("() => !!window.DAW_CONTROL", timeout=30000)
    adv = page.get_by_role("button", name=re.compile("Mode avanc", re.I)).locator("visible=true").first
    try:
        if adv.is_visible(): adv.click(); page.wait_for_timeout(500)
    except Exception:
        pass


SET_ACCOUNT = r"""
async (email) => {
  const m = await window.__novaAppModule('/services/templateAccount.ts');
  const client = { auth: { getSession: async () => ({ data: { session: { user: { email } } } }), getUser: async () => ({ data: { user: { email } } }) } };
  m.setAccountClients(async () => [client]);
  return true;
}
"""


def template_romain(b):
    """1. Modèle de Romain : le 1er REC part sur la piste REC."""
    log = Log("seance_rec_modele")
    ctx, page = new_page(b, "pc", log=log, touch=False)
    page.add_init_script(INIT)
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Nouveau Projet").first.wait_for(timeout=60000)
    ouvrir_plus_accueil(page)
    page.get_by_test_id("landing-templates").wait_for(timeout=30000)
    page.evaluate(SET_ACCOUNT, EMAIL)
    page.get_by_test_id("landing-templates").click()
    item = page.locator("[data-template-id='tpl-romain-lennon-depart']")
    item.wait_for(timeout=20000)
    item.get_by_test_id("tpl-use").click(); page.wait_for_timeout(500)
    item.get_by_test_id("tpl-create").click()
    page.locator("[data-track-name]").first.wait_for(timeout=60000)
    page.wait_for_timeout(3000)
    close_cards(page)
    page.mouse.click(5, 5); page.keyboard.press("Escape")
    sel = st(page, "s => { const t = s.tracks.find(x => x.id === s.selectedTrackId); return t ? t.name.trim() : null; }")
    t0 = time.time()
    page.keyboard.press("r")
    d = wait_rec(page, True)
    armed = st(page, "s => s.tracks.filter(t => t.isTrackArmed).map(t => t.name.trim())")
    shot(page, "01_modele_romain_rec")
    page.wait_for_timeout(2500)
    page.keyboard.press("r"); wait_rec(page, False); page.wait_for_timeout(600)
    withclips = st(page, "s => s.tracks.filter(t => t.clips.length).map(t => [t.name.trim(), t.clips.map(c => c.name)])")
    res["mesures"]["modele_romain"] = {"piste_selectionnee": sel, "R_vers_enregistrement_s": d, "armee": armed, "pistes_avec_prise": withclips,
                                       "gestes": 1, "avant": "KICK (inactive) sélectionnée ; R → « Piste indisponible pour l'enregistrement », rien ne s'enregistre"}
    check("modèle de Romain : la piste sélectionnée à l'ouverture est REC", sel == "REC", sel)
    check("modèle de Romain : 1er REC (1 touche) → la prise part sur REC", armed == ["REC"] and any(n == "REC" for n, _ in withclips), {"armee": armed, "prises": withclips})
    errs = [e for e in log.errors() if "ARM FAILED" in e["text"]]
    check("modèle de Romain : aucun « ARM FAILED » dans la console", not errs, errs[:3])
    ctx.close()


def take(page, secs):
    """Une prise : R, chanter `secs`, R. Retourne les mesures (s)."""
    t0 = time.time(); page.keyboard.press("r")
    d_in = wait_rec(page, True)
    page.wait_for_timeout(int(secs * 1000))
    t1 = time.time(); page.keyboard.press("r")
    d_out = wait_rec(page, False)
    return {"R_vers_enregistrement_s": d_in, "stop_vers_pret_s": d_out}


def seance(b):
    f = OUT / "seance_rec.zip"
    make_project(f)
    log = Log("seance_rec")
    ctx, page = new_page(b, "pc", log=log, touch=False)
    open_project(page, f)
    page.mouse.click(700, 860); page.wait_for_timeout(200)
    page.keyboard.press("Escape")
    M = res["mesures"]

    # --- 2. Repères au clavier : K à l'arrêt ouvre le nom.
    page.evaluate(f"() => window.DAW_CONTROL.seek({BAR})"); page.wait_for_timeout(300)
    page.keyboard.press("k"); page.wait_for_timeout(400)
    focused = page.evaluate("() => { const e = document.activeElement; return e && e.tagName === 'INPUT' ? e.value : null; }")
    page.keyboard.type("Couplet 1"); page.keyboard.press("Enter"); page.wait_for_timeout(300)
    page.evaluate(f"() => window.DAW_CONTROL.seek({BAR * 9})"); page.wait_for_timeout(200)
    page.keyboard.press("k"); page.wait_for_timeout(400)
    page.keyboard.type("Refrain"); page.keyboard.press("Enter"); page.wait_for_timeout(300)
    mk = st(page, "s => s.markers.map(m => [m.name, +m.time.toFixed(2)])")
    M["repere_nomme"] = {"gestes": "K + nom + Entrée (2 touches)", "champ_ouvert": focused, "reperes": mk,
                         "avant": "K posait « Marqueur N » sans rien ouvrir : clic droit → Renommer → nom → Entrée (3 gestes + le nom)"}
    check("K à l'arrêt : le nom du repère s'ouvre tout de suite (tapé « Couplet 1 », Entrée)", focused is not None and [m[0] for m in mk] == ["Couplet 1", "Refrain"], {"champ": focused, "reperes": mk})
    shot(page, "02_reperes_nommes")

    # --- 3. 10 prises d'affilée sur le couplet (élan d'une mesure avant le repère).
    start = 0.0
    page.evaluate(f"() => window.DAW_CONTROL.seek({start})"); page.wait_for_timeout(300)
    rows = []
    first_notice = None
    for i in range(10):
        ph0 = st(page, "s => s.currentTime")
        m = take(page, 3.2)
        page.wait_for_timeout(250)
        if i == 0:
            page.wait_for_timeout(2500)  # la sauvegarde auto passe juste après la 1re prise
            first_notice = notice(page)
        m.update({"prise": i + 1, "tete_avant": round(ph0, 3), "tete_apres": round(st(page, "s => s.currentTime"), 3)})
        rows.append(m)
    L = lanes(page)
    names = [l["name"] for l in L]
    M["dix_prises"] = {"prises": rows, "couloirs": names, "gestes_par_prise": 2,
                       "R_vers_enregistrement_moy_s": round(sum(r["R_vers_enregistrement_s"] for r in rows) / len(rows), 2),
                       "stop_vers_pret_moy_s": round(sum(r["stop_vers_pret_s"] for r in rows) / len(rows), 2)}
    check("10 prises d'affilée : 10 couloirs « Couplet 1 · Prise 1 » … « Couplet 1 · Prise 10 »",
          names == [f"Couplet 1 · Prise {k}" for k in range(1, 11)], names)
    check("10 prises : la tête revient toujours au même point (une touche = refaire la prise)",
          all(abs(r["tete_apres"] - start) < 0.01 for r in rows), [r["tete_apres"] for r in rows])
    check("10 prises : STOP → prêt pour la suivante en moins de 1 s", all(r["stop_vers_pret_s"] < 1.0 for r in rows), [r["stop_vers_pret_s"] for r in rows])
    M["annonce_1re_prise"] = first_notice
    check("1re prise : son annonce reste lisible (pas écrasée par « Sauvegarde automatique active »)",
          "Couplet 1 · Prise 1" in (first_notice or "") and "Sauvegarde automatique" not in (first_notice or ""), first_notice)
    clipnames = st(page, f"s => s.tracks.find(t => t.id === '{TID}').clips.filter(c => !c.isMuted).map(c => c.name)")
    check("le clip entendu porte le nom de la prise (« Couplet 1 · Prise 10 »)", clipnames == ["Couplet 1 · Prise 10"], clipnames)
    shot(page, "03_dix_prises")

    # --- 8a. 📌 Ctrl+Alt+P garde la dernière ; Ctrl+Z enlève une prise juste faite.
    page.keyboard.press("Control+Alt+p"); page.wait_for_timeout(400)
    kept = page.evaluate("async () => { const K = await window.__novaAppModule('/utils/keptTakes.ts'); return K.keptLanes(window.DAW_CONTROL.getState().tracks[0]).map(l => l.name); }")
    check("📌 Ctrl+Alt+P : la dernière prise est gardée sous son nom", kept == ["Couplet 1 · Prise 10"], kept)
    take(page, 3.2); page.wait_for_timeout(600)
    n_before = len(lanes(page))
    page.keyboard.press("Control+z"); page.wait_for_timeout(500)
    n_after = len(lanes(page))
    undo_note = notice(page)
    M["supprimer_mauvaise_prise"] = {"gestes": 1, "touche": "Ctrl+Z", "couloirs_avant": n_before, "couloirs_apres": n_after, "annonce": undo_note}
    check("Ctrl+Z juste après une prise : elle disparaît (un geste)", n_before == 11 and n_after == 10, [n_before, n_after])
    check("Ctrl+Z : l'annonce dit quelle prise est partie (« Couplet 1 · Prise 11 retirée »)", "Couplet 1 · Prise 11 retirée" in undo_note, undo_note)

    # --- 6. Jeter la prise en cours : Ctrl+. puis le bouton.
    page.evaluate(f"() => window.DAW_CONTROL.seek({start})"); page.wait_for_timeout(200)
    page.keyboard.press("r"); wait_rec(page, True); page.wait_for_timeout(1500)
    t0 = time.time(); page.keyboard.press("Control+.")
    d = wait_rec(page, False)
    page.wait_for_timeout(300)
    L2 = lanes(page)
    note = notice(page)
    ph = st(page, "s => s.currentTime")
    M["jeter_ctrl_point"] = {"gestes": 1, "arret_s": d, "couloirs": len(L2), "tete": round(ph, 3), "annonce": note,
                             "avant": "n'existait pas : STOP puis Ctrl+Z (2 gestes)"}
    check("Ctrl+. pendant la prise : arrêt, aucun couloir de plus, retour au début", len(L2) == 10 and abs(ph - start) < 0.01 and not st(page, "s => s.isPlaying"), {"couloirs": len(L2), "tete": ph})
    check("Ctrl+. : annonce « Prise jetée »", "Prise jetée" in note, note)
    page.keyboard.press("r"); wait_rec(page, True); page.wait_for_timeout(1200)
    btn = page.locator('[data-testid="rec-discard"]').locator("visible=true")
    has_btn = btn.count() == 1
    shot(page, "06_bouton_jeter_pendant_prise")
    if has_btn:
        btn.first.click()
    else:
        page.keyboard.press("Control+.")
    wait_rec(page, False); page.wait_for_timeout(300)
    check("bouton « 🗑️ Jeter la prise » visible pendant la prise, il jette (1 clic)", has_btn and len(lanes(page)) == 10, {"bouton": has_btn, "couloirs": len(lanes(page))})
    take(page, 3.2); page.wait_for_timeout(500)
    L3 = lanes(page)
    check("après 2 prises jetées, la suivante s'appelle « Couplet 1 · Prise 11 » (aucun numéro perdu)", L3[-1]["name"] == "Couplet 1 · Prise 11", L3[-1])

    # --- 5. Pré-roll 2 s : 3 reprises repartent du même point.
    page.evaluate("() => window.DAW_CONTROL.setPunch({ preRollOn: true, preRollSec: 2 })"); page.wait_for_timeout(300)
    p0 = BAR * 9 + 1
    page.evaluate(f"() => window.DAW_CONTROL.seek({p0})"); page.wait_for_timeout(300)
    pts = []
    for i in range(3):
        take(page, 3.5); page.wait_for_timeout(400)
        pts.append(round(st(page, "s => s.currentTime"), 3))
    page.evaluate("() => window.DAW_CONTROL.setPunch({ preRollOn: false })"); page.wait_for_timeout(200)
    L4 = lanes(page)
    M["preroll"] = {"point": p0, "tete_apres_chaque_reprise": pts, "avant": [p0, p0 - 2, p0 - 4, p0 - 6]}
    check("pré-roll 2 s : chaque reprise revient au point d'enregistrement (pas 2 s plus tôt à chaque fois)", all(abs(x - p0) < 0.01 for x in pts), pts)
    check("prises du refrain nommées « Refrain · Prise 1 … 3 »", [l["name"] for l in L4[-3:]] == [f"Refrain · Prise {k}" for k in (1, 2, 3)], [l["name"] for l in L4[-3:]])

    # --- 7. R pendant la lecture : la prise part tout de suite, là où on est.
    page.evaluate("() => window.DAW_CONTROL.seek(0)"); page.wait_for_timeout(300)
    page.keyboard.press("Space"); page.wait_for_timeout(2500)
    pos_r = page.evaluate(ENGINE_T)
    page.keyboard.press("r")
    d = wait_rec(page, True)
    pos_after = page.evaluate(ENGINE_T)
    page.wait_for_timeout(1500)
    page.keyboard.press("Space"); wait_rec(page, False); page.wait_for_timeout(600)
    back = round(st(page, "s => s.currentTime"), 3)
    clip = st(page, f"s => {{ const c = s.tracks.find(t => t.id === '{TID}').clips.filter(c => !c.isMuted).sort((a, b) => b.takeNumber - a.takeNumber)[0]; return c ? [c.name, +c.start.toFixed(3)] : null; }}")
    M["R_pendant_lecture"] = {"position_appui": round(pos_r, 3), "R_vers_enregistrement_s": d, "position_au_depart": round(pos_after, 3), "prise": clip, "tete_apres_espace": back,
                              "avant": "décompte de 2,9 s par-dessus le beat qui joue, puis la lecture saute en arrière au point d'appui"}
    check("R pendant la lecture : la prise part tout de suite (< 0,5 s), sans décompte ni saut en arrière",
          d < 0.5 and pos_after >= pos_r - 0.05 and clip and abs(clip[1] - pos_r) < 0.35, M["R_pendant_lecture"])
    check("prise à la volée arrêtée à l'Espace : la tête revient au début de la prise (R la refait)", abs(back - pos_r) < 0.1, {"tete": back, "appui": pos_r})

    errs = log.errors()
    check("séance : aucune erreur dans la console", not errs, errs[:5])
    save_log(log)
    ctx.close()


with sync_playwright() as p:
    b = launch(p)
    try:
        template_romain(b)
        seance(b)
    finally:
        b.close()

res["verifications"] = checks
res["bilan"] = {"ok": sum(c["ok"] for c in checks), "total": len(checks)}
(OUT / "seance_rec.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
print("\nMESURES :", json.dumps(res["mesures"], ensure_ascii=False, default=str)[:3000])
print("\nBILAN :", json.dumps(res["bilan"], ensure_ascii=False))
sys.exit(0 if all(c["ok"] for c in checks) else 1)
