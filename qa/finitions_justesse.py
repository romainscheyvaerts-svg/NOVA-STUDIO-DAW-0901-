"""Preuves « finitions justesse » (V19), navigateur headless, aucune fenêtre.

  editeur : voix synthétique 40 cents trop haute, éditeur ouvert, « Corriger tout » à 100 % :
            capture de la courbe (plus de petit pic en fin de note) + nombre de trames de bord
            masquées à l'affichage.
  lot     : deux clips sélectionnés (lead + back), menu du clip → « Justesse : corriger tout
            (2 clips)… », dosage 100 %, naturel → les deux clips corrigés ; Ctrl+Z une fois :
            les deux reviennent.

Usage : serveur `npx vite --port 3435 --strictPort`, puis python qa/finitions_justesse.py [editeur] [lot]
Sorties : D:\\1 WORK\\CONTENU\\nova-finitions\\
"""
import json, os, sys, zipfile
from pathlib import Path

os.environ["NOVA_URL"] = os.environ.get("NOVA_URL", "http://127.0.0.1:3435/")
os.environ["QA_OUT"] = r"D:\1 WORK\CONTENU\nova-finitions"
sys.path.insert(0, str(Path(__file__).parent))
import v19_justesse as V  # noqa
from qalib import OUT, Log, launch, new_page, shot, save_log  # noqa
from gel_pre_effet import prepare, open_project_file  # noqa
from playwright.sync_api import sync_playwright


def make_two(path: Path, wav: bytes):
    base = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0,
            "sends": [], "plugins": [], "outputTrackId": "master", "volume": 1.0, "type": "AUDIO"}
    clip = lambda cid, name: {"id": cid, "name": name, "start": 1.0, "duration": V.SYN_DUR, "offset": 0, "fadeIn": 0, "fadeOut": 0,
                              "color": "#22d3ee", "type": "AUDIO", "audioRef": "audio/voix.wav", "gain": 1}
    tracks = [{**base, "id": "voix", "name": "Voix lead", "color": "#22d3ee", "clips": [clip("voix-1", "Couplet")]},
              {**base, "id": "back", "name": "Back", "color": "#f472b6", "clips": [clip("back-1", "Back couplet")]}]
    state = {**V.STATE_BASE, "id": "proj-lot", "name": "Justesse lot", "tracks": tracks, "projectKey": 9, "projectScale": "MINOR"}
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/voix.wav", wav)


PE = "s => s.tracks.filter(t => t.clips.length).map(t => [t.id, t.clips.map(c => c.pitchEdit ? { source: c.pitchEdit.sourceBufferId, amount: c.pitchEdit.amount, style: c.pitchEdit.style, buf: c.bufferId } : null)])"


def scenario_editeur(page, res):
    x, _ = V.synth_voice()
    proj = OUT / "justesse_editeur.zip"
    V.make_project(proj, V.wav_bytes(x), V.SYN_DUR, "Justesse pic")
    prepare(page)
    open_project_file(page, proj, res, "justesse_00_projet")
    page.wait_for_function("() => !!window.__novaEdit", timeout=20000)
    V.open_editor_desktop(page, "justesse_01")
    V.set_range(page, "pitch-amount", 100)
    page.wait_for_timeout(500)
    shot(page, "justesse_02_editeur_courbe_sans_pic")
    # Trames de bord masquées à l'affichage (pics de fin / début de passage), mesurées sur la même analyse.
    res["trames_masquees"] = page.evaluate("""async () => {
      const { audioBufferRegistry } = await import('/utils/audioBufferRegistry.ts');
      const A = await import('/utils/pitchAnalysis.ts'); const C = await import('/utils/pitchCorrect.ts');
      const c = window.__novaEdit.getState().tracks[0].clips[0]; const b = audioBufferRegistry.get(c.bufferId);
      const tr = A.analyzePitch(b.getChannelData(0), b.sampleRate); const d = C.displayPitchCurve(tr.midi);
      let n = 0, worst = 0; for (let i = 0; i < d.length; i++) if (Number.isNaN(d[i]) && !Number.isNaN(tr.midi[i])) {
        n++; const j = !Number.isNaN(tr.midi[i - 1]) ? i - 1 : i + 1; worst = Math.max(worst, Math.abs(tr.midi[i] - tr.midi[j])); }
      return { trames: n, plus_grand_saut_masque_demi_tons: +worst.toFixed(2) };
    }""")
    res["ok"] = res["trames_masquees"]["trames"] > 0


def scenario_lot(page, res):
    x, _ = V.synth_voice()
    proj = OUT / "justesse_lot.zip"
    make_two(proj, V.wav_bytes(x))
    prepare(page)
    open_project_file(page, proj, res, "justesse_10_projet_deux_clips")
    page.wait_for_function("() => !!window.__novaEdit", timeout=20000)
    page.mouse.click(800, 600); page.wait_for_timeout(200)
    box = V.canvas_box(page)
    xa = box["x"] + 2.0 * 40 - box["sl"]
    y0, y1 = box["y"] + 40 + 60 - box["st"], box["y"] + 40 + 120 + 60 - box["st"]
    page.mouse.click(xa, y0); page.wait_for_timeout(150)
    page.keyboard.down("Shift"); page.mouse.click(xa, y1); page.keyboard.up("Shift"); page.wait_for_timeout(200)
    page.mouse.click(xa, y0, button="right"); page.wait_for_timeout(400)
    item = page.get_by_text("Justesse : corriger tout (2 clips)…", exact=True).first
    res["entree_menu"] = item.is_visible()
    shot(page, "justesse_11_menu_corriger_tout_2_clips")
    item.click()
    page.get_by_test_id("pitch-batch").wait_for(timeout=8000)
    V.set_range(page, "pitch-batch-amount", 100)
    page.get_by_test_id("pitch-batch-style-naturel").click()
    res["fenetre"] = page.get_by_test_id("pitch-batch").inner_text()[:220]
    res["gamme_choisie"] = page.get_by_test_id("pitch-batch").get_by_label("Tonique").input_value()
    shot(page, "justesse_12_fenetre_lot")
    page.get_by_test_id("pitch-batch-apply").click()
    page.get_by_test_id("pitch-batch").wait_for(state="detached", timeout=120000)
    page.wait_for_timeout(600)
    res["apres"] = V.st(page, PE)
    shot(page, "justesse_13_deux_clips_corriges")
    # Les deux sons corrigés : justes (mesure indépendante de NOVA, en Python).
    import numpy as np
    errs = []
    for tid, cl in res["apres"]:
        if not cl[0]: continue
        y = V.buffer_of(page, cl[0]["buf"])
        for (m, c, at, ln, gl, vib) in V.MELODY:
            p = V.note_pitch(y, V.SR, at + 0.1, at + ln - 0.1)
            if p is not None and not np.isnan(p): errs.append(abs(p - m) * 100)
    res["ecart_moyen_cents_apres"] = round(float(np.mean(errs)), 1) if errs else None
    page.keyboard.press("Control+z"); page.wait_for_timeout(600)
    res["apres_un_ctrl_z"] = V.st(page, PE)
    shot(page, "justesse_14_une_annulation")
    both = [cl[0] for _, cl in res["apres"]]
    res["ok"] = (res["entree_menu"] and res["gamme_choisie"] == "9" and (res["ecart_moyen_cents_apres"] or 99) < 10
                 and all(b and b["amount"] == 1 and b["style"] == "naturel" for b in both)
                 and all(cl[0] is None for _, cl in res["apres_un_ctrl_z"]))


def main(names):
    table = {"editeur": scenario_editeur, "lot": scenario_lot}
    allres = {}
    with sync_playwright() as p:
        b = launch(p)
        for n in names:
            log = Log(f"justesse_{n}")
            res = {"name": n}
            ctx, page = new_page(b, "pc", log)
            try:
                table[n](page, res)
            except Exception as e:  # noqa
                res["ok"] = False
                res["exception"] = f"{type(e).__name__}: {str(e)[:600]}"
                try: shot(page, f"justesse_{n}__ECHEC")
                except Exception: pass
            res["erreurs_page"] = [e["text"][:300] for e in log.errors()][:20]
            save_log(log, {"result": res})
            allres[n] = res
            ctx.close()
        b.close()
    (OUT / f"finitions_justesse_{'_'.join(names)}.json").write_text(json.dumps(allres, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(allres, ensure_ascii=False, indent=1)[:6000])


if __name__ == "__main__":
    main([a for a in sys.argv[1:] if a in ("editeur", "lot")] or ["editeur", "lot"])
