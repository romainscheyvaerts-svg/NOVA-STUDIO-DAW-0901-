"""Rendu gelé périmé : preuves dans un navigateur headless (aucune fenêtre).

  justesse : piste gelée (compresseur natif) → justesse corrigée (éditeur V19, 100 %) →
             regel automatique : l'EXPORT est juste (hauteur mesurée ici, en Python) ;
             Ctrl+Z une fois : ancien rendu, export de nouveau faux de 40 cents.
  decoupe  : piste gelée → séparer à 5 s (export identique, sans creux à la coupe) →
             supprimer de 5 s à la fin → export silencieux après 5 s ; Ctrl+Z → comme avant.
  gain     : piste gelée → gain du clip −6 dB → regel : export = même édition sans gel
             (le compresseur réagit au nouveau gain), Ctrl+Z → ancien rendu.
  vst      : piste gelée avec un VST du PC, sans le pont : gain → indicateur « gel à
             refaire » seul ; justesse → notification « dégèle-la… » + bouton Dégeler.

Usage : serveur `npx vite --port 3439 --strictPort`, puis
  PYTHONIOENCODING=utf-8 python qa/gel_perime.py [justesse] [decoupe] [gain] [vst]
Sorties : D:\\1 WORK\\CONTENU\\nova-gel-perime\\
"""
import io, json, os, sys, wave, zipfile
from pathlib import Path

import numpy as np

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3439/")
os.environ["QA_OUT"] = os.environ.get("QA_OUT_GEL", r"D:\1 WORK\CONTENU\nova-gel-perime")
sys.path.insert(0, str(Path(__file__).parent))
import v19_justesse as V  # noqa
from qalib import OUT, Log, launch, new_page, shot, save_log  # noqa
from gel_pre_effet import prepare, open_project_file, export_wav  # noqa
from playwright.sync_api import sync_playwright

SR = 44100
COMP = {"id": "comp", "name": "Compresseur", "type": "COMPRESSOR", "isEnabled": True, "params": {}, "latency": 0}
VST = {"id": "vst-1", "name": "Pro-Q 3", "type": "VST3", "isEnabled": True, "latency": 0,
       "params": {"name": "Pro-Q 3", "localPath": "C:/VST3/FabFilter Pro-Q 3.vst3", "pluginName": None, "stateB64": "dGVzdA=="}}
PHRASES = [(1.0, 3.0), (4.0, 6.0), (7.0, 9.0)]


def phrases_wav() -> bytes:
    t = np.arange(int(10 * SR)) / SR
    x = np.zeros_like(t)
    for a, b in PHRASES:
        m = (t >= a) & (t < b)
        env = np.minimum(1, np.minimum((t[m] - a) / 0.02, (b - t[m]) / 0.02))
        x[m] = 0.5 * env * (np.sin(2 * np.pi * 220 * t[m]) + 0.4 * np.sin(2 * np.pi * 440 * t[m]) + 0.2 * np.sin(2 * np.pi * 660 * t[m])) / 1.6
    return V.wav_bytes(x.astype(np.float32))


def project(path: Path, wav: bytes, dur: float, clip_start: float, plugins, name: str, **track_extra):
    clip = {"id": "voix-1", "name": "Prise 1", "start": clip_start, "duration": dur, "offset": 0, "fadeIn": 0, "fadeOut": 0,
            "color": "#22d3ee", "type": "AUDIO", "audioRef": "audio/voix.wav", "gain": 1, "takeNumber": 1}
    clip.update(track_extra.pop("clip_extra", {}))
    base = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0}
    tracks = [{**base, "id": "voix", "name": "Voix lead", "type": "AUDIO", "color": "#22d3ee", "volume": 1.0, "outputTrackId": "master",
               "sends": [], "clips": [clip], "plugins": plugins, **track_extra}]
    state = {**V.STATE_BASE, "id": f"proj-{name}", "name": name, "tracks": tracks, "projectKey": 9, "projectScale": "MINOR"}
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/voix.wav", wav)


TRACK = "s => s.tracks.find(t => t.id === 'voix')"


def st(page, expr):
    return page.evaluate(f"() => {{ const s = window.__novaEdit.getState(); return ({expr})(s); }}")


def track_info(page):
    page.evaluate("async () => { if (!window.__F) window.__F = await import('/utils/freeze.ts'); }")
    return st(page, f"""s => {{ const t = ({TRACK})(s); const d = window.__F.freezeDrift(t);
        return {{ gelee: !!t.isFrozen, rendu: t.frozenClip ? t.frozenClip.id : null, perime: !!d, ecart: d,
                 clips: t.clips.map(c => ({{ id: c.id, start: +c.start.toFixed(3), duree: +c.duration.toFixed(3), gain: c.gain ?? 1,
                   justesse: !!c.pitchEdit, inverse: !!c.isReversed, ancre: !!c.freezeRef && !!t.frozenClip && c.freezeRef.renderId === t.frozenClip.id }})) }}; }}""")


def freeze_menu(page, label="Geler la piste (freeze)"):
    page.get_by_text("Voix lead", exact=True).locator("visible=true").first.click(button="right")
    page.wait_for_timeout(300)
    page.get_by_text(label).locator("visible=true").first.click()
    page.wait_for_timeout(500)


def wait_regel(page, prev, timeout=60000):
    page.evaluate("async () => { if (!window.__F) window.__F = await import('/utils/freeze.ts'); }")
    page.wait_for_function(f"""(prev) => {{ const t = ({TRACK})(window.__novaEdit.getState());
        return t.isFrozen && t.frozenClip && t.frozenClip.id !== prev && !window.__F.freezeOutdated(t); }}""", arg=prev, timeout=timeout)
    page.wait_for_timeout(300)


def read(path):
    x, sr = V.read_wav(path)
    return x[0], sr


def pitches(path, clip_start=1.0):
    x, sr = read(path)
    out = []
    for (m, c, at, ln, gl, vib) in V.MELODY:
        p = V.note_pitch(x, sr, clip_start + at + 0.12, clip_start + at + ln - 0.1)
        out.append(round((p - m) * 100, 1) if p is not None and not np.isnan(p) else None)
    return out


def rms_db(x, sr, a, b):
    s = x[int(a * sr):int(b * sr)]
    return round(float(20 * np.log10(max(np.sqrt(np.mean(s * s)) if len(s) else 0, 1e-10))), 2)


def max_diff_db(p, q, a=0.0, b=None):
    x, sr = read(p)
    y, _ = read(q)
    n = min(len(x), len(y))
    e = int((b or n / sr) * sr)
    d = np.max(np.abs(x[int(a * sr):min(e, n)] - y[int(a * sr):min(e, n)]))
    return round(float(20 * np.log10(max(d, 1e-10))), 1)


def advanced(page):
    """Mode avancé (menu de piste complet : Geler / Dégeler)."""
    page.add_init_script("try { localStorage.setItem('nova_simple_mode', '0'); } catch (e) {}")


def undo(page):
    page.mouse.click(1500, 860); page.wait_for_timeout(150)
    page.keyboard.press("Control+z"); page.wait_for_timeout(1200)


# ------------------------------------------------------------ scénarios
def scenario_justesse(page, res):
    x, _ = V.synth_voice()
    proj = OUT / "gel_justesse.zip"
    project(proj, V.wav_bytes(x), V.SYN_DUR, 1.0, [COMP], "Gel justesse")
    prepare(page)
    advanced(page)
    open_project_file(page, proj, res, "J0_projet")
    page.wait_for_function("() => !!window.__novaEdit", timeout=20000)
    freeze_menu(page)
    page.wait_for_function(f"() => {{ const t = ({TRACK})(window.__novaEdit.getState()); return t.isFrozen && !!t.frozenClip; }}", timeout=60000)
    r0 = track_info(page)
    res["gel"] = r0
    shot(page, "J1_piste_gelee")
    export_wav(page, OUT / "J_A_export_gele_avant.wav", "J2")
    res["export_avant_cents"] = pitches(OUT / "J_A_export_gele_avant.wav")
    # Justesse : éditeur note par note, « Corriger tout » à 100 %.
    V.open_editor_desktop(page, "J3")
    V.set_range(page, "pitch-amount", 100)
    page.get_by_test_id("pitch-apply").click()
    page.wait_for_selector("[data-testid=pitch-editor]", state="detached", timeout=60000)
    res["juste_apres_correction"] = track_info(page)
    shot(page, "J4_juste_apres_correction")
    wait_regel(page, r0["rendu"])
    r1 = track_info(page)
    res["apres_regel"] = r1
    shot(page, "J5_regelee")
    export_wav(page, OUT / "J_B_export_corrige.wav", "J6")
    res["export_corrige_cents"] = pitches(OUT / "J_B_export_corrige.wav")
    undo(page)
    page.wait_for_timeout(1500)  # aucun regel ne doit repartir
    r2 = track_info(page)
    res["apres_ctrl_z"] = r2
    shot(page, "J7_ctrl_z")
    export_wav(page, OUT / "J_C_export_apres_annuler.wav", "J8")
    res["export_apres_annuler_cents"] = pitches(OUT / "J_C_export_apres_annuler.wav")
    res["annuler_vs_avant_ecart_max_dbfs"] = max_diff_db(OUT / "J_A_export_gele_avant.wav", OUT / "J_C_export_apres_annuler.wav")
    ok = lambda v: [abs(c) for c in v if c is not None]
    res["ok"] = (min(ok(res["export_avant_cents"])) > 25 and max(ok(res["export_corrige_cents"])) < 10
                 and r1["rendu"] != r0["rendu"] and r1["gelee"] and not r1["perime"] and r1["clips"][0]["justesse"]
                 and r2["rendu"] == r0["rendu"] and not r2["clips"][0]["justesse"] and not r2["perime"]
                 and min(ok(res["export_apres_annuler_cents"])) > 25 and res["annuler_vs_avant_ecart_max_dbfs"] < -60)


def open_phrases(page, res, name, plugins, label, **extra):
    proj = OUT / f"gel_{name}.zip"
    project(proj, phrases_wav(), 10.0, 0.0, plugins, f"Gel {name}", **extra)
    prepare(page)
    advanced(page)
    open_project_file(page, proj, res, label)
    page.wait_for_function("() => !!window.__novaEdit", timeout=20000)


def scenario_decoupe(page, res):
    open_phrases(page, res, "decoupe", [COMP], "D0_projet")
    freeze_menu(page)
    page.wait_for_function(f"() => {{ const t = ({TRACK})(window.__novaEdit.getState()); return t.isFrozen && !!t.frozenClip; }}", timeout=60000)
    r0 = track_info(page)
    export_wav(page, OUT / "D_A_export_gele.wav", "D1")
    # 1) Séparer à 5 s (Ctrl+E, sur la plage 5–5,5 : deux coupes).
    page.evaluate("() => { const e = window.__novaEdit; e.selectRange(5, 7.5, ['voix']); e.separate(); }")
    wait_regel(page, r0["rendu"])
    r1 = track_info(page)
    res["apres_separer"] = r1
    shot(page, "D2_separee_regelee")
    export_wav(page, OUT / "D_B_export_separe.wav", "D3")
    res["separe_vs_avant_ecart_max_dbfs"] = max_diff_db(OUT / "D_A_export_gele.wav", OUT / "D_B_export_separe.wav")
    # Ce que la lecture par tranches aurait donné (fondus anti-clic à chaque coupe) : creux mesuré.
    x, sr = read(OUT / "D_B_export_separe.wav")
    a, _ = read(OUT / "D_A_export_gele.wav")
    res["niveau_a_la_coupe_5s_db"] = {"avant": rms_db(a, sr, 4.995, 5.005), "apres": rms_db(x, sr, 4.995, 5.005)}
    # 2) Supprimer de 5 s à la fin.
    page.evaluate("() => { const e = window.__novaEdit; e.selectRange(5, 10.5, ['voix']); e.deleteSelection(); e.clearSelection(); }")
    wait_regel(page, r1["rendu"])
    r2 = track_info(page)
    res["apres_supprimer"] = r2
    shot(page, "D4_supprimee_regelee")
    export_wav(page, OUT / "D_C_export_supprime.wav", "D5")
    y, sr = read(OUT / "D_C_export_supprime.wav")
    res["supprime_db"] = {"4.2-4.9": rms_db(y, sr, 4.2, 4.9), "5.2-5.9": rms_db(y, sr, 5.2, 5.9), "7.2-8.8": rms_db(y, sr, 7.2, 8.8),
                          "avant_5.2-5.9": rms_db(a, sr, 5.2, 5.9)}
    undo(page)
    page.wait_for_timeout(1500)
    r3 = track_info(page)
    res["apres_ctrl_z"] = r3
    shot(page, "D6_ctrl_z")
    export_wav(page, OUT / "D_D_export_apres_annuler.wav", "D7")
    res["annuler_vs_separe_ecart_max_dbfs"] = max_diff_db(OUT / "D_B_export_separe.wav", OUT / "D_D_export_apres_annuler.wav")
    sd = res["supprime_db"]
    res["ok"] = (r1["rendu"] != r0["rendu"] and len(r1["clips"]) == 3 and not r1["perime"] and all(c["ancre"] for c in r1["clips"])
                 and res["separe_vs_avant_ecart_max_dbfs"] < -60
                 and sd["4.2-4.9"] > -30 and sd["5.2-5.9"] < -80 and sd["7.2-8.8"] < -80 and sd["avant_5.2-5.9"] > -30
                 and r3["rendu"] == r1["rendu"] and len(r3["clips"]) == 3 and not r3["perime"]
                 and res["annuler_vs_separe_ecart_max_dbfs"] < -60)


def scenario_gain(page, res):
    open_phrases(page, res, "gain", [COMP], "G0_projet")
    freeze_menu(page)
    page.wait_for_function(f"() => {{ const t = ({TRACK})(window.__novaEdit.getState()); return t.isFrozen && !!t.frozenClip; }}", timeout=60000)
    r0 = track_info(page)
    export_wav(page, OUT / "G_A_export_gele.wav", "G1")
    page.evaluate("() => window.__novaEdit.patchClips('voix', { 'voix-1': { gain: 0.5 } })")
    wait_regel(page, r0["rendu"])
    r1 = track_info(page)
    res["apres_gain"] = r1
    shot(page, "G2_gain_regele")
    export_wav(page, OUT / "G_B_export_gain.wav", "G3")
    undo(page)
    page.wait_for_timeout(1500)
    r2 = track_info(page)
    res["apres_ctrl_z"] = r2
    export_wav(page, OUT / "G_C_export_apres_annuler.wav", "G4")
    # Référence : la même édition sur la piste dégelée (chaîne réelle).
    freeze_menu(page, "Dégeler la piste")
    page.wait_for_function(f"() => !({TRACK})(window.__novaEdit.getState()).isFrozen", timeout=20000)
    page.evaluate("() => window.__novaEdit.patchClips('voix', { 'voix-1': { gain: 0.5 } })")
    page.wait_for_timeout(600)
    export_wav(page, OUT / "G_R_export_reference_degelee.wav", "G5")
    a, sr = read(OUT / "G_A_export_gele.wav")
    b, _ = read(OUT / "G_B_export_gain.wav")
    r, _ = read(OUT / "G_R_export_reference_degelee.wav")
    lv = lambda s: [rms_db(s, sr, x0 + 0.2, x1 - 0.2) for x0, x1 in PHRASES]
    res["niveaux_db"] = {"gele_avant": lv(a), "gele_gain_regele": lv(b), "reference_degelee": lv(r)}
    res["baisse_db"] = [round(y - x, 2) for x, y in zip(lv(a), lv(b))]
    res["regele_vs_reference_ecart_max_db"] = max(abs(round(y - x, 2)) for x, y in zip(lv(r), lv(b)))
    res["annuler_vs_avant_ecart_max_dbfs"] = max_diff_db(OUT / "G_A_export_gele.wav", OUT / "G_C_export_apres_annuler.wav")
    res["ok"] = (r1["rendu"] != r0["rendu"] and not r1["perime"] and r1["clips"][0]["gain"] == 0.5
                 and res["regele_vs_reference_ecart_max_db"] < 0.1 and all(-6.0 < d < -0.5 for d in res["baisse_db"])
                 and r2["rendu"] == r0["rendu"] and r2["clips"][0]["gain"] == 1 and res["annuler_vs_avant_ecart_max_dbfs"] < -60)


def scenario_vst(page, res):
    x, _ = V.synth_voice()
    fz = {"id": "frozen-voix", "name": "Voix lead (rendu)", "start": 0, "duration": V.SYN_DUR + 4, "offset": 0, "fadeIn": 0, "fadeOut": 0,
          "color": "#22d3ee", "type": "AUDIO", "audioRef": "audio/voix.wav", "gain": 1, "isMuted": False}
    # Rendu fait au studio (son déjà dans le projet), clip ancré : « = » = même son que le clip.
    ref = {"renderId": "frozen-voix", "anchor": 1.0, "from": 0, "to": V.SYN_DUR, "fadeIn": 0, "fadeOut": 0, "gain": 1, "srcClipId": "voix-1", "buf": "="}
    proj = OUT / "gel_vst.zip"
    project(proj, V.wav_bytes(x), V.SYN_DUR, 1.0, [VST], "Gel VST", isFrozen=True, frozenClip=fz, frozenUpToPluginIndex=0,
            frozenPluginSig="sig-vst", clip_extra={"freezeRef": ref})
    prepare(page)
    advanced(page)
    open_project_file(page, proj, res, "V0_projet")
    page.wait_for_function("() => !!window.__novaEdit", timeout=20000)
    res["charge"] = track_info(page)
    # 1) Gain : suivi par les tranches, indicateur seul (pas de notification).
    page.evaluate("() => window.__novaEdit.patchClips('voix', { 'voix-1': { gain: 0.7 } })")
    page.get_by_test_id("freeze-outdated-voix").wait_for(timeout=10000)
    page.wait_for_timeout(1200)
    res["gain_indicateur"] = page.get_by_test_id("freeze-outdated-voix").inner_text()
    res["gain_notification"] = page.get_by_test_id("frozen-stale-toast").count()
    shot(page, "V1_gain_indicateur_gel_a_refaire")
    undo(page)
    page.wait_for_timeout(800)
    res["apres_annuler_indicateur"] = page.get_by_test_id("freeze-outdated-voix").count()
    # 2) Justesse : le son change, sans regel possible → notification + Dégeler.
    V.open_editor_desktop(page, "V2")
    V.set_range(page, "pitch-amount", 100)
    page.get_by_test_id("pitch-apply").click()
    page.wait_for_selector("[data-testid=pitch-editor]", state="detached", timeout=60000)
    page.get_by_test_id("frozen-stale-toast").wait_for(timeout=15000)
    res["notification"] = page.get_by_test_id("frozen-stale-toast").inner_text()
    res["bouton"] = page.get_by_test_id("frozen-stale-unfreeze").inner_text()
    res["indicateur"] = page.get_by_test_id("freeze-outdated-voix").inner_text()
    res["etat"] = track_info(page)
    shot(page, "V3_justesse_notification_degeler")
    page.get_by_test_id("frozen-stale-unfreeze").click(); page.wait_for_timeout(700)
    shot(page, "V4_clic_degeler_sans_pont")
    res["toujours_gelee_sans_pont"] = st(page, f"s => !!({TRACK})(s).isFrozen")
    res["ok"] = (res["charge"]["gelee"] and not res["charge"]["perime"] and "gel à refaire" in res["gain_indicateur"]
                 and res["gain_notification"] == 0 and res["apres_annuler_indicateur"] == 0
                 and "dégèle-la pour entendre le traitement" in res["notification"] and "Voix lead" in res["notification"]
                 and res["bouton"] == "Dégeler" and "gel à refaire" in res["indicateur"]
                 and res["etat"]["ecart"]["content"] == ["voix-1"] and res["toujours_gelee_sans_pont"])


def main(names):
    table = {"justesse": scenario_justesse, "decoupe": scenario_decoupe, "gain": scenario_gain, "vst": scenario_vst}
    allres = {}
    with sync_playwright() as p:
        b = launch(p)
        for n in names:
            log = Log(f"gel_perime_{n}")
            res = {"name": n}
            ctx, page = new_page(b, "pc", log)
            page.set_default_timeout(30000)
            try:
                table[n](page, res)
            except Exception as e:  # noqa
                res["ok"] = False
                res["exception"] = f"{type(e).__name__}: {str(e)[:600]}"
                try: shot(page, f"{n}__ECHEC")
                except Exception: pass
            res["erreurs_page"] = [e["text"][:300] for e in log.errors()][:20]
            save_log(log, {"result": res})
            allres[n] = res
            ctx.close()
        b.close()
    (OUT / f"gel_perime_{'_'.join(names)}.json").write_text(json.dumps(allres, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(allres, ensure_ascii=False, indent=1)[:12000])


if __name__ == "__main__":
    main([a for a in sys.argv[1:] if a in ("justesse", "decoupe", "gain", "vst")] or ["justesse", "decoupe", "gain", "vst"])
