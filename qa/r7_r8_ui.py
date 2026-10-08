"""R7 / R8 · scénario dans l'interface (navigateur headless, aucune fenêtre), captures PC,
tablette et téléphone :

  R7  fenêtre du Compresseur de la 808 → barre « Clé (side-chain) » → préréglage
      « 808 sous le kick » (la clé « Kick » est trouvée d'après son nom) → prise avant / après
      fader, filtre de la clé ; boucle refusée (la 808 sort sur « Bus 808 » : choisir ce bus
      comme clé affiche le message et ne change rien) ; Gate avec sa clé ;
  R8  vue Automation → « + » sur la 808 : « Compresseur · Seuil », « Muet »… → voie « Muet » ;
      barre de la vue Pistes : « Automation suit l'édition ».

NOVA_URL=http://127.0.0.1:3447/ PYTHONIOENCODING=utf-8 python qa/r7_r8_ui.py [pc] [tab] [tel]
Sorties : D:\\1 WORK\\CONTENU\\nova-r7-r8\\ (captures ui_*.png, r7_r8_ui.json)
"""
import io, json, os, re, sys, wave, zipfile
from pathlib import Path
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3447/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-r7-r8")
from qalib import launch, new_page, shot, overflow_report, Log, OUT  # noqa: E402
from gel_pre_effet import prepare, open_project_file  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SR = 44100
PROJECT = OUT / "r7_r8_projet.novaproj.zip"


def wav(x) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def make_project():
    t = np.arange(int(8 * SR)) / SR
    kick = np.zeros_like(t)
    for k in np.arange(0, 8, 0.5):
        m = (t >= k) & (t < k + 0.15)
        u = t[m] - k
        kick[m] += 0.9 * np.sin(2 * np.pi * (50 * u + 400 * (1 - np.exp(-u * 30)) / 30)) * np.exp(-u * 18)
    b808 = 0.6 * np.sin(2 * np.pi * 49 * t) * np.minimum(1, t / 0.01)
    base = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0, "sends": []}
    comp = {"id": "fx-comp808", "name": "Compresseur", "type": "COMPRESSOR", "isEnabled": True, "latency": 0,
            "params": {"threshold": -18, "ratio": 4, "knee": 12, "attack": 0.003, "release": 0.25, "makeupGain": 1, "mix": 1, "scHpFreq": 80, "lookahead": 0, "autoMakeup": False, "mode": "CLEAN", "isEnabled": True}}
    gate = {"id": "fx-gate", "name": "Gate", "type": "GATE", "isEnabled": True, "latency": 0, "params": {"threshold": -40, "range": 80, "attack": 0.5, "hold": 20, "release": 80}}
    clip = lambda cid, name, ref, color: {"id": cid, "name": name, "start": 0, "duration": 8, "offset": 0, "fadeIn": 0, "fadeOut": 0, "color": color, "type": "AUDIO", "audioRef": ref, "gain": 1}
    tracks = [
        {**base, "id": "kick", "name": "Kick", "type": "AUDIO", "color": "#f97316", "volume": 0.9, "outputTrackId": "master", "clips": [clip("ck", "Kick", "audio/kick.wav", "#f97316")], "plugins": []},
        {**base, "id": "b808", "name": "808", "type": "AUDIO", "color": "#a855f7", "volume": 0.9, "outputTrackId": "bus808", "clips": [clip("c8", "808", "audio/808.wav", "#a855f7")], "plugins": [comp]},
        {**base, "id": "pad", "name": "Pad", "type": "AUDIO", "color": "#22d3ee", "volume": 0.7, "outputTrackId": "master", "clips": [clip("cp", "Pad", "audio/808.wav", "#22d3ee")], "plugins": [gate]},
        {**base, "id": "bus808", "name": "Bus 808", "type": "BUS", "color": "#fbbf24", "volume": 1.0, "outputTrackId": "master", "clips": [], "plugins": []},
        {**base, "id": "master", "name": "MASTER BUS", "type": "BUS", "color": "#00f2ff", "volume": 1.0, "outputTrackId": "", "clips": [], "plugins": []},
    ]
    state = {
        "id": "proj-r7-r8", "name": "R7 R8 side-chain", "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": "b808", "currentView": "ARRANGEMENT",
        "projectPhase": "MIXING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(PROJECT, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/kick.wav", wav(kick))
        z.writestr("audio/808.wav", wav(b808))


STATE = "() => { const s = window.__novaEdit.getState(); const t = s.tracks.find(x => x.id === 'b808'); const p = t.plugins[0]; return { source: p.sidechainSourceId || null, name: p.sidechainSourceName || null, tap: p.sidechainTap || null, threshold: p.params.threshold, ratio: p.params.ratio, keyLpf: p.params.keyLpf, keyHpf: p.params.keyHpf, lanes: t.automationLanes.map(l => l.parameterName) }; }"


def open_plugin(pg, vp, track_name, fx_label):
    if vp == "tel":
        m = pg.get_by_text("Mixer", exact=True)
        if m.count(): m.last.click(); pg.wait_for_timeout(900)
        if track_name == "Pad":
            # Téléphone : la tranche du Pad (3e) se choisit d'un doigt, ses effets s'affichent dessous.
            pg.get_by_text("1 FX").locator("visible=true").nth(1).click(); pg.wait_for_timeout(600)
        pg.get_by_text(fx_label, exact=True).locator("visible=true").first.click()
    elif vp == "tab":
        pg.get_by_text(fx_label, exact=True).locator("visible=true").first.click()
    else:
        for label in ("Console", "Mixage", "Mixer"):
            t = pg.get_by_role("button", name=re.compile(f"^{label}$", re.I))
            if t.count() and t.first.is_visible():
                t.first.click(); pg.wait_for_timeout(1000); break
        pg.locator(f"button[aria-label^='Ouvrir {fx_label} ({track_name})']").first.click()
    pg.wait_for_timeout(1800)


def close_plugin(pg, vp):
    pg.keyboard.press("Escape"); pg.wait_for_timeout(500)
    if vp == "tel":
        f = pg.get_by_role("button", name="Fermer", exact=True).locator("visible=true")
        if f.count(): f.first.click(); pg.wait_for_timeout(500)


def run(vp, theme="dark"):
    tag = f"{vp}_{theme}"
    res = {"vp": vp, "theme": theme, "etapes": {}}
    log = Log(f"r7r8_{tag}")
    pg = None

    def step(name, fn):
        try:
            res["etapes"][name] = fn()
        except Exception as e:  # noqa
            res["etapes"][name] = {"erreur": str(e)[:300]}
            try: shot(pg, f"ui_{tag}_ERREUR_{name}")
            except Exception: pass

    with sync_playwright() as p:
        b = launch(p)
        ctx, pg = new_page(b, vp, log)
        prepare(pg)
        pg.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); localStorage.setItem('nova_simple_mode', '0'); }} catch (e) {{}}")
        open_project_file(pg, PROJECT, res, f"ui_{tag}_01_projet")
        pg.keyboard.press("Escape"); pg.wait_for_timeout(500)

        def r7_cle():
            out = {}
            open_plugin(pg, vp, "808", "Compresseur")
            bar = pg.locator("[data-nova-sidechain]").locator("visible=true").first
            bar.wait_for(timeout=6000)
            shot(pg, f"ui_{tag}_10_compresseur_cle_vide")
            pg.locator("[data-nova-key-more]").locator("visible=true").first.click(); pg.wait_for_timeout(400)
            shot(pg, f"ui_{tag}_10b_prereglages_trap")
            pg.locator("[data-nova-sc-preset='808-sous-kick']").locator("visible=true").first.click()
            pg.wait_for_timeout(900)
            out["apres_prereglage"] = pg.evaluate(STATE)
            out["message"] = pg.locator("[data-nova-sidechain] [aria-live]").first.inner_text()
            shot(pg, f"ui_{tag}_11_808_sous_le_kick")
            # Boucle : la 808 sort sur « Bus 808 » → refusé.
            sel = pg.locator("[data-nova-key-source]").locator("visible=true").first
            sel.select_option("bus808"); pg.wait_for_timeout(700)
            out["boucle_message"] = pg.locator("[data-nova-key-error]").first.inner_text() if pg.locator("[data-nova-key-error]").count() else None
            out["apres_boucle"] = pg.evaluate(STATE)
            shot(pg, f"ui_{tag}_12_boucle_refusee")
            # Retour sur le kick, après fader, écoute de la clé.
            sel.select_option("kick"); pg.wait_for_timeout(500)
            pg.get_by_role("radio", name="Après fader").locator("visible=true").first.click(); pg.wait_for_timeout(500)
            out["apres_fader"] = pg.evaluate(STATE)
            pg.locator("[data-nova-key-listen]").locator("visible=true").first.click(); pg.wait_for_timeout(500)
            shot(pg, f"ui_{tag}_13_ecoute_cle")
            pg.locator("[data-nova-key-listen]").locator("visible=true").first.click(); pg.wait_for_timeout(300)
            out["debordements"] = overflow_report(pg)[:5]
            close_plugin(pg, vp)
            return out
        step("R7_cle_compresseur", r7_cle)

        def r7_gate():
            out = {}
            open_plugin(pg, vp, "Pad", "Gate")
            pg.locator("[data-nova-sidechain]").locator("visible=true").first.wait_for(timeout=6000)
            pg.locator("[data-nova-key-source]").locator("visible=true").first.select_option("kick"); pg.wait_for_timeout(700)
            out["cle"] = pg.evaluate("() => window.__novaEdit.getState().tracks.find(t => t.id === 'pad').plugins[0].sidechainSourceId")
            shot(pg, f"ui_{tag}_20_gate_cle")
            out["debordements"] = overflow_report(pg)[:5]
            close_plugin(pg, vp)
            return out
        step("R7_gate", r7_gate)

        def r8_voies():
            out = {}
            ok = False
            for name in ("Auto", "Automation"):
                t = pg.get_by_role("button", name=name, exact=True).locator("visible=true")
                if t.count():
                    t.first.click(); ok = True; pg.wait_for_timeout(1200); break
            if not ok:
                mm = pg.get_by_role("button", name=re.compile("menu", re.I)).locator("visible=true")
                if mm.count():
                    mm.first.click(); pg.wait_for_timeout(500)
                    t = pg.get_by_text("Auto", exact=True).locator("visible=true")
                    # « Auto » du thème (Sombre / Clair / Auto) vient avant celui des vues : on prend le dernier.
                    if t.count(): t.last.click(); ok = True; pg.wait_for_timeout(1200)
            out["vue_automation"] = ok
            plus = pg.get_by_role("button", name="Ajouter un paramètre à automatiser sur 808").locator("visible=true")
            plus.first.click(); pg.wait_for_timeout(600)
            items = pg.locator("div:has(> div:text('Paramètre à automatiser')) button").all_inner_texts()
            out["menu"] = items
            shot(pg, f"ui_{tag}_30_plus_voie")
            pg.get_by_role("button", name="Muet", exact=True).locator("visible=true").first.click(); pg.wait_for_timeout(700)
            out["voies"] = pg.evaluate(STATE)["lanes"]
            shot(pg, f"ui_{tag}_31_voie_muet")
            return out
        step("R8_plus_voie", r8_voies)

        def r8_suit():
            out = {}
            for label in ("Édition", "Arrangement", "Pistes"):
                t = pg.get_by_role("button", name=re.compile(f"^{label}$", re.I))
                if t.count() and t.first.is_visible():
                    t.first.click(); pg.wait_for_timeout(900); break
            btn = pg.locator("[data-nova-target=automation-follows]")
            out["bouton_visible"] = btn.count() > 0 and btn.first.is_visible()
            if out["bouton_visible"]:
                out["active_par_defaut"] = btn.first.get_attribute("aria-pressed")
            shot(pg, f"ui_{tag}_40_pistes")
            return out
        step("R8_automation_suit", r8_suit)

        res["erreurs_console"] = log.errors()[:10]
        b.close()
    return res


if __name__ == "__main__":
    make_project()
    vps = [a for a in sys.argv[1:] if a in ("pc", "tab", "tel")] or ["pc", "tab", "tel"]
    allres = [run(vp) for vp in vps]
    (OUT / "r7_r8_ui.json").write_text(json.dumps(allres, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(allres, ensure_ascii=False, indent=1))
