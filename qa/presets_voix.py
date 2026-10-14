"""Lot 8 BandLab — presets voix, « Décris ton son », One Knob, de bout en bout dans le vrai studio.

Chrome headless (aucune fenêtre), 100 % hors production (qa_hors_prod via qalib : Supabase simulé).
Projet : 3 vraies prises rap du studio (séance « 13 mini 22 04 vs 2 ») sur Lead, Back 1 et Adlib,
retours Écho / Réverbe courte / Réverbe longue.

  A. bureau 1600 × 900, thème sombre (console PC) :
     One Knob dans la tranche de Lead ; façade (kit hw) ; « Presets voix » → filtre rôle Lead →
     « Trap lead » posé (chaîne, trim calé sur la prise, envois) ; macro Brillance à 100 % (clavier sur
     le gros bouton) ; Ctrl+Z revient ; cadran de la tranche (flèches) ; « Décris ton son » avec la
     phrase d'exemple → proposition (mots compris) → Appliquer (preset, macros, écho) ; Backs sur Back 1.
  B. bureau, thème clair : tranche, façade, presets.
  C. téléphone 390 × 844, thème sombre : onglet Mixer, One Knob de la piste, façade en bas d'écran,
     presets, Décris ton son ; aucun débordement horizontal ; zones de toucher ≥ 44 px.
  D. téléphone, thème clair : mêmes écrans.

  NOVA_URL=http://127.0.0.1:3455/ PYTHONIOENCODING=utf-8 python qa/presets_voix.py [A B C D]
Sorties : D:\\1 WORK\\CONTENU\\nova-bandlab\\lot8_presets\\scenario (presets_voix.json + captures)
"""
import io, json, os, re, sys, time, wave, zipfile
from pathlib import Path

import numpy as np

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3455/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-bandlab\lot8_presets\scenario")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, OUT, Log, BASE, overflow_report  # noqa: E402  (qa_hors_prod : Supabase simulé, prod bloquée)
from desktop_gate import install_mocks, SUPERADMIN  # noqa: E402
from scenarios import close_welcome  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SESSION = Path(r"D:\1 WORK\2 SESSIONS PROTOOLS\OneDrive\13 mini 22 04 vs 2\Audio Files")
PHRASE = "voix plus brillante et plus en avant avec un peu d'écho"
checks = []
res = {"cas": {}}


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("  OK  " if cond else "  KO  ") + name + (f" — {detail}" if detail is not None else ""), flush=True)


def st(page, expr):
    return page.evaluate(f"() => {{ const s = window.__novaEdit && window.__novaEdit.getState(); return s ? ({expr})(s) : null; }}")


def track(page, tid):
    return st(page, f"s => {{ const t = s.tracks.find(x => x.id === '{tid}'); return t ? JSON.parse(JSON.stringify({{ plugins: t.plugins.map(p => ({{ type: p.type, params: p.params }})), sends: t.sends, trim: t.inputTrimDb ?? null, vc: t.voiceChain || null, volume: t.volume, pan: t.pan }})) : null; }}")


def overflow_in(page, sel):
    """Débordements horizontaux de la page, et éléments de la fenêtre `sel` qui sortent de l'écran."""
    return page.evaluate("""(sel) => {
      const out = [], vw = window.innerWidth;
      if (document.documentElement.scrollWidth > vw + 1) out.push({kind: 'page-hscroll', w: document.documentElement.scrollWidth, vw});
      for (const root of document.querySelectorAll(sel)) for (const el of root.querySelectorAll('button, h2, h3, p, span, label, input')) {
        if (!el.getClientRects().length) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        if (r.right > vw + 1 || r.left < -1) out.push({kind: 'off-screen', t: (el.innerText || el.value || '').trim().slice(0, 40), left: Math.round(r.left), right: Math.round(r.right)});
      }
      return out.slice(0, 20);
    }""", sel)


def shot(page, name):
    page.screenshot(path=str(OUT / f"{name}.png"))


# ─── Projet : 3 vraies prises ─────────────────────────────────────────────────

def take(name, seconds, peak_db):
    with wave.open(str(SESSION / name)) as w:
        sr, n = w.getframerate(), w.getnframes()
        y = np.frombuffer(w.readframes(n), "<i2").astype(np.float32) / 32768
    y = y[: int(seconds * sr)]
    y = y * (10 ** (peak_db / 20) / max(1e-9, float(np.max(np.abs(y)))))
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(np.clip(np.round(y * 32767), -32768, 32767).astype("<i2").tobytes())
    return buf.getvalue(), len(y) / sr


def make_project(path: Path):
    base = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0,
            "sends": [], "plugins": [], "volume": 0.8, "outputTrackId": "master"}
    tracks, audio = [], {}
    for tid, nm, f, pk in (("lead", "Lead", "REC_220.wav", -8), ("back1", "Back 1", "REC_70.wav", -14), ("adlib", "Adlib", "REC_201.wav", -11)):
        data, dur = take(f, 12, pk)
        audio[tid] = data
        tracks.append({**base, "id": tid, "name": nm, "type": "AUDIO", "color": "#a78bfa", "outputTrackId": "bus-voix" if tid == "back1" else "master",
                       "clips": [{"id": f"c-{tid}", "name": nm, "type": "AUDIO", "audioRef": f"audio/{tid}.wav", "color": "#a78bfa",
                                  "fadeIn": 0, "fadeOut": 0, "gain": 1.0, "start": 0, "offset": 0.0, "duration": round(dur, 3)}]})

    def ret(tid, nm, plug):
        return {**base, "id": tid, "name": nm, "type": "SEND", "color": "#10b981", "volume": 0.7, "clips": [], "plugins": [plug]}
    tracks += [
        ret("send-delay", "Écho 1/4", {"id": "d1", "type": "DELAY", "name": "DELAY", "isEnabled": True, "latency": 0, "params": {"division": "1/4", "feedback": 0.35, "mix": 1, "bpm": 140}}),
        ret("send-verb-short", "Réverbe courte", {"id": "v1", "type": "REVERB", "name": "REVERB", "isEnabled": True, "latency": 0, "params": {"decay": 1.2, "preDelay": 0.02, "mix": 1, "size": 0.4, "mode": "PLATE"}}),
        ret("send-verb-long", "Réverbe longue", {"id": "v2", "type": "REVERB", "name": "REVERB", "isEnabled": True, "latency": 0, "params": {"decay": 3.5, "preDelay": 0.05, "mix": 1, "size": 0.9, "mode": "HALL"}}),
        {**base, "id": "bus-voix", "name": "Bus voix", "type": "BUS", "color": "#fbbf24", "volume": 1, "clips": []},
        {**base, "id": "master", "name": "MASTER", "type": "BUS", "volume": 1, "outputTrackId": "", "clips": []},
    ]
    state = {"id": "qa-presets-voix", "name": "Presets voix (lot 8)", "bpm": 140, "timeSignature": {"numerator": 4, "denominator": 4},
             "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 12,
             "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": "lead", "currentView": "ARRANGEMENT", "projectKey": 6, "projectScale": "MINOR",
             "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
             "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0}}
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        for k, v in audio.items():
            z.writestr(f"audio/{k}.wav", v)


def open_studio(page, zpath):
    page.goto(BASE, wait_until="domcontentloaded")
    page.locator("button:visible", has_text=re.compile("Nouveau Projet")).first.wait_for(timeout=90000)
    page.wait_for_function("() => !document.getElementById('loading-screen')", timeout=15000)
    page.wait_for_timeout(300)
    page.locator("button:visible", has_text=re.compile("Nouveau Projet")).first.click()
    page.wait_for_timeout(800); close_welcome(page)
    page.wait_for_function("() => !!window.__novaEdit", timeout=60000)
    page.get_by_role("button", name=re.compile("^Ouvrir le menu$")).first.click(); page.wait_for_timeout(300)
    page.locator("[role=dialog] button", has_text=re.compile("Ouvrir un projet")).first.click(); page.wait_for_timeout(400)
    page.get_by_text(re.compile("Fichier sur l.ordinateur")).first.click()
    page.set_input_files('input[type=file][accept=".zip,.json"]', str(zpath))
    page.wait_for_function("() => window.__novaEdit.getState().tracks.some(t => t.id === 'lead' && t.clips.length)", timeout=60000)
    page.wait_for_timeout(1500)
    for _ in range(2): page.keyboard.press("Escape"); page.wait_for_timeout(150)


def open_console_pc(page):
    page.get_by_role("button", name=re.compile("^Ouvrir le menu$")).first.click(); page.wait_for_timeout(300)
    page.locator("[role=dialog] button", has_text=re.compile("^Console$")).first.click()
    page.wait_for_function("() => document.querySelectorAll('[data-strip-id]').length > 3", timeout=15000)
    page.wait_for_timeout(600)


def apply_preset(page, role, pid, tag):
    page.locator(f"[data-testid=voice-role-{role}]").click(); page.wait_for_timeout(200)
    card = page.locator(f"[data-testid=voice-preset-card][data-preset-id={pid}]")
    card.scroll_into_view_if_needed()
    card.locator("[data-testid=voice-preset-apply]").click()
    page.locator("[data-testid=voice-presets-status]", has_text=re.compile("posé sur")).wait_for(timeout=20000)
    return page.locator("[data-testid=voice-presets-status]").inner_text()


def knob_end(page):
    k = page.locator("[data-testid=one-knob-modal] [data-nova-param=amount] [role=slider]").first
    if not k.count():
        k = page.locator("[data-testid=one-knob-modal] [role=slider]").first
    k.focus(); page.keyboard.press("End"); page.wait_for_timeout(300)


# ─── A / B : bureau ───────────────────────────────────────────────────────────

def run_pc(page, theme, zpath):
    tag = f"pc_{theme}"
    open_studio(page, zpath)
    open_console_pc(page)
    strip = page.locator("[data-testid=one-knob-strip-lead]")
    check(f"{tag} · One Knob dans la tranche de Lead", strip.count() == 1 and strip.is_visible())
    check(f"{tag} · pas de One Knob sur les retours d'effets", page.locator("[data-testid=one-knob-strip-send-delay]").count() == 0)
    strip.scroll_into_view_if_needed()
    page.locator("[data-strip-id=lead]").screenshot(path=str(OUT / f"{tag}_01_tranche_lead.png"))
    page.locator("[data-testid=one-knob-open-lead]").click()
    page.locator("[data-testid=one-knob-modal] [data-nova-plugin=ONEKNOB]").wait_for(timeout=8000)
    page.wait_for_timeout(400)
    shot(page, f"{tag}_02_facade")
    check(f"{tag} · façade : 8 macros", page.locator("[data-testid=one-knob-macros] [role=radio]").count() == 8)
    # Presets voix
    page.locator("[data-testid=one-knob-presets]").click()
    page.locator("[data-testid=voice-presets-dialog]").wait_for(timeout=8000)
    shot(page, f"{tag}_03_presets_lead")
    n_lead = page.locator("[data-testid=voice-preset-card]").count()
    check(f"{tag} · bibliothèque : rôle Lead filtré", n_lead >= 10, n_lead)
    msg = apply_preset(page, "lead", "trap-lead", tag)
    t = track(page, "lead")
    types = [p["type"] for p in t["plugins"]]
    check(f"{tag} · « Trap lead » posé : chaîne NOVA en 2 étages 2:1", types[:4] == ["DENOISER", "AUTOTUNE", "PROEQ12", "COMPRESSOR"] and "OPTO_VINTAGE" in types
          and all(p["params"].get("ratio") == 2 for p in t["plugins"] if p["type"] in ("COMPRESSOR", "OPTO_VINTAGE")), types)
    check(f"{tag} · trim d'entrée calé sur la prise (≠ 0) et annoncé", t["trim"] not in (None, 0) and "trim" in msg, [t["trim"], msg[:160]])
    check(f"{tag} · envois réverbe et écho posés (effets temporels en envoi)", {s["id"] for s in t["sends"] if s["level"] > 0} >= {"send-delay", "send-verb-short"}, t["sends"])
    check(f"{tag} · Nova Tune dans la tonalité du projet (F# mineur)", next(p for p in t["plugins"] if p["type"] == "AUTOTUNE")["params"].get("rootKey") == 6)
    shot(page, f"{tag}_04_trap_lead_pose")
    # Presets « Bus voix » : jamais sur une piste (Lead sort sur le master : bouton grisé, raison dite)
    page.locator("[data-testid=voice-role-bus]").click(); page.wait_for_timeout(200)
    bb = page.locator("[data-testid=voice-preset-card][data-preset-id=bus-voix-maison] [data-testid=voice-preset-apply]")
    check(f"{tag} · presets de bus grisés sur une piste qui sort au master, raison dite", bb.is_disabled() and "bus" in bb.inner_text(), bb.inner_text())
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    # Macro Brillance à 100 %
    page.locator("[data-testid=one-knob-macros] [data-macro=brillance]").click(); page.wait_for_timeout(150)
    air0 = track(page, "lead")["plugins"][2]["params"]["bands"][9]["gain"]
    knob_end(page)
    t1 = track(page, "lead")
    air1 = t1["plugins"][2]["params"]["bands"][9]["gain"]
    check(f"{tag} · Brillance 100 % : air +3 dB, position gardée", abs(air1 - air0 - 3) < 0.01 and (t1["vc"] or {}).get("amounts", {}).get("brillance") == 1, [air0, air1])
    check(f"{tag} · lecture du gros bouton « Brillance 100 % »", "Brillance 100" in page.locator("[data-testid=one-knob-readout]").inner_text())
    shot(page, f"{tag}_05_brillance_100")
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    check(f"{tag} · Échap ferme la façade", page.locator("[data-testid=one-knob-modal]").count() == 0)
    page.mouse.click(5, 450); page.keyboard.press("Control+z"); page.wait_for_timeout(500)
    t2 = track(page, "lead")
    check(f"{tag} · Ctrl+Z : la macro revient (air d'avant)", abs(t2["plugins"][2]["params"]["bands"][9]["gain"] - air0) < 0.01, t2["plugins"][2]["params"]["bands"][9]["gain"])
    # Cadran de la tranche : flèches
    dial = page.locator("[data-testid=one-knob-strip-lead] [role=slider]")
    dial.focus(); page.keyboard.press("ArrowUp"); page.keyboard.press("ArrowUp"); page.wait_for_timeout(300)
    check(f"{tag} · cadran de la tranche : 2 crans = 10 %", abs(float(dial.get_attribute("aria-valuenow")) - 10) < 0.5, dial.get_attribute("aria-valuetext"))
    # Décris ton son
    page.locator("[data-testid=one-knob-open-lead]").click()
    page.locator("[data-testid=one-knob-describe]").click()
    page.locator("[data-testid=voice-describe-input]").fill(PHRASE)
    page.locator("[data-testid=voice-describe-propose]").click()
    page.locator("[data-testid=voice-describe-result]").wait_for(timeout=5000)
    txt = page.locator("[data-testid=voice-describe-result]").inner_text()
    check(f"{tag} · Décris ton son : brillance, présence et écho compris", all(w in txt for w in ("Brillance 60 %", "Présence 60 %", "écho")), txt.replace("\n", " ")[:200])
    shot(page, f"{tag}_06_decris_ton_son")
    page.locator("[data-testid=voice-describe-apply]").click()
    page.locator("[data-testid=voice-presets-status]", has_text=re.compile("Brillance")).wait_for(timeout=15000)
    t3 = track(page, "lead")
    am = (t3["vc"] or {}).get("amounts", {})
    check(f"{tag} · appliqué : macros Présence et Brillance à 60 %", am.get("presence") == 0.6 and am.get("brillance") == 0.6, am)
    shot(page, f"{tag}_07_decris_applique")
    # Backs sur Back 1 (depuis sa tranche)
    page.keyboard.press("Escape"); page.wait_for_timeout(200); page.keyboard.press("Escape"); page.wait_for_timeout(300)
    page.locator("[data-testid=one-knob-open-back1]").click()
    page.locator("[data-testid=one-knob-presets]").click()
    page.locator("[data-testid=voice-presets-dialog]").wait_for(timeout=8000)
    sel = page.locator("[data-testid=voice-role-back]").get_attribute("aria-checked")
    check(f"{tag} · Back 1 : la bibliothèque s'ouvre sur le rôle Backs", sel == "true")
    apply_preset(page, "back", "back-trap", tag)
    tb = track(page, "back1")
    eq = next(p for p in tb["plugins"] if p["type"] == "PROEQ12")["params"]["bands"]
    check(f"{tag} · Backs : coupe-bas ≥ 200 Hz, coupe-haut ≤ 15 kHz, ouverts sur un côté, plus bas", eq[0]["frequency"] >= 200 and eq[11]["isEnabled"] and eq[11]["frequency"] <= 15000
          and abs(tb["pan"]) > 0.3 and tb["volume"] < 0.6, [eq[0]["frequency"], eq[11]["frequency"], tb["pan"], tb["volume"]])
    shot(page, f"{tag}_08_backs")
    # Back 1 sort dans « Bus voix » : le preset de bus s'y pose (FET 76 puis Leveler 2A, rien sur la piste)
    page.locator("[data-testid=voice-role-bus]").click(); page.wait_for_timeout(200)
    apply_preset(page, "bus", "bus-voix-maison", tag)
    page.locator("[data-testid=voice-presets-status]", has_text=re.compile("sur le bus")).wait_for(timeout=10000)
    bus = track(page, "bus-voix")
    check(f"{tag} · « Bus voix (règle maison) » posé sur le bus : FET 76 puis Leveler 2A", [p["type"] for p in bus["plugins"]] == ["FET76", "LEVELER2A"], [p["type"] for p in bus["plugins"]])
    check(f"{tag} · la piste Back 1 garde sa chaîne de voix", [p["type"] for p in track(page, "back1")["plugins"]][-1] == "OPTO_VINTAGE")
    shot(page, f"{tag}_09_bus_voix")
    ov = overflow_report(page)
    check(f"{tag} · aucun débordement horizontal", not [o for o in ov if o["kind"] in ("page-hscroll", "off-right")], ov[:3])


def run_pc_light(page, theme, zpath):
    tag = f"pc_{theme}"
    open_studio(page, zpath)
    open_console_pc(page)
    page.locator("[data-testid=one-knob-strip-lead]").scroll_into_view_if_needed()
    page.locator("[data-strip-id=lead]").screenshot(path=str(OUT / f"{tag}_01_tranche_lead.png"))
    page.locator("[data-testid=one-knob-open-lead]").click()
    page.locator("[data-testid=one-knob-modal] [data-nova-plugin=ONEKNOB]").wait_for(timeout=8000)
    page.wait_for_timeout(300)
    shot(page, f"{tag}_02_facade")
    page.locator("[data-testid=one-knob-presets]").click()
    page.locator("[data-testid=voice-presets-dialog]").wait_for(timeout=8000)
    apply_preset(page, "lead", "rnb-doux-lead", tag)
    shot(page, f"{tag}_03_presets_rnb")
    page.locator("[data-testid=voice-describe-input]").fill("plus chaude, un peu plus large, beaucoup de réverbe")
    page.locator("[data-testid=voice-describe-propose]").click()
    page.locator("[data-testid=voice-describe-result]").wait_for(timeout=5000)
    shot(page, f"{tag}_04_decris")
    check(f"{tag} · thème clair : dialogue lisible (fond clair)", page.evaluate("() => { const d = document.querySelector('[data-testid=voice-presets-dialog]'); const c = getComputedStyle(d).backgroundColor.match(/\\d+/g).map(Number); return (c[0] + c[1] + c[2]) / 3 > 150; }"))


# ─── C / D : téléphone ────────────────────────────────────────────────────────

def run_tel(page, theme, zpath):
    tag = f"tel_{theme}"
    open_studio(page, zpath)
    page.locator("[role=navigation] button", has_text=re.compile(r"^\s*Mixer\s*$")).first.tap()
    page.wait_for_timeout(800)
    strip = page.locator("[data-testid^=one-knob-strip-]").first
    strip.wait_for(timeout=15000)
    strip.evaluate("e => e.scrollIntoView({ block: 'center' })")
    page.wait_for_timeout(300)
    shot(page, f"{tag}_01_console")
    strip.evaluate("e => e.parentElement.parentElement.scrollIntoView({ block: 'center' })")
    page.wait_for_timeout(200)
    shot(page, f"{tag}_01b_one_knob_piste")
    box = page.locator("[data-testid^=one-knob-open-]").first.bounding_box()
    dial = page.locator("[data-testid^=one-knob-strip-] [role=slider]").first.bounding_box()
    check(f"{tag} · One Knob sur la console du téléphone, zones ≥ 44 px", box["height"] >= 44 and dial["height"] >= 44, [round(box["height"]), round(dial["height"])])
    page.locator("[data-testid^=one-knob-open-]").first.tap()
    page.locator("[data-testid=one-knob-modal] [data-nova-plugin=ONEKNOB]").wait_for(timeout=8000)
    page.wait_for_timeout(400)
    shot(page, f"{tag}_02_facade")
    ov = overflow_in(page, "[data-testid=one-knob-modal]")
    check(f"{tag} · façade : aucun débordement horizontal", not ov, ov[:3])
    small = page.evaluate("() => Array.from(document.querySelectorAll('[data-testid=one-knob-macros] [role=radio]')).map(b => Math.round(b.getBoundingClientRect().height)).filter(h => h < 44)")
    check(f"{tag} · macros : boutons ≥ 44 px", not small, small)
    page.locator("[data-testid=one-knob-macros] [data-macro=chaleur]").tap(); page.wait_for_timeout(150)
    knob_end(page)
    tid = st(page, "s => s.selectedTrackId")
    am = (track(page, tid)["vc"] or {}).get("amounts", {})
    check(f"{tag} · Chaleur 100 % au doigt (clavier du gros bouton)", am.get("chaleur") == 1, am)
    page.locator("[data-testid=one-knob-presets]").tap()
    page.locator("[data-testid=voice-presets-dialog]").wait_for(timeout=8000)
    page.wait_for_timeout(300)
    shot(page, f"{tag}_03_presets")
    ov = overflow_in(page, "[data-testid=voice-presets-dialog]")
    check(f"{tag} · presets : aucun débordement horizontal", not ov, ov[:3])
    apply_preset(page, "lead", "afro-lead", tag)
    shot(page, f"{tag}_04_afro_pose")
    page.locator("[data-testid=voice-describe-input]").fill("ad-libs au téléphone avec de l'écho")
    page.locator("[data-testid=voice-describe-propose]").tap()
    page.locator("[data-testid=voice-describe-result]").wait_for(timeout=5000)
    shot(page, f"{tag}_05_decris")
    check(f"{tag} · Décris ton son : preset Ad-libs téléphone proposé", "Ad-libs téléphone" in page.locator("[data-testid=voice-describe-result]").inner_text())


def main():
    want = set(a.upper() for a in sys.argv[1:]) or {"A", "B", "C", "D"}
    zpath = OUT / "presets_voix.zip"; make_project(zpath)
    t0 = time.time()
    plan = [("A", "pc", "sombre", run_pc), ("B", "pc", "clair", run_pc_light), ("C", "tel390", "sombre", run_tel), ("D", "tel390", "clair", run_tel)]
    with sync_playwright() as p:
        b = launch(p)
        for key, vp, theme, fn in plan:
            if key not in want: continue
            log = Log(f"presets_{vp}_{theme}")
            ctx, page = new_page(b, vp, log=log, touch=vp != "pc")
            page.set_default_timeout(20000)
            page.add_init_script(f"try {{ localStorage.setItem('nova_welcome_seen', '1'); localStorage.setItem('nova_simple_mode', '0'); localStorage.setItem('nova_theme', '{'light' if theme == 'clair' else 'dark'}'); }} catch (e) {{}}")
            install_mocks(page, "romain", SUPERADMIN, {})
            try:
                fn(page, theme, zpath)
            except Exception as e:
                check(f"{key} {vp}_{theme} · déroulé complet", False, f"{type(e).__name__}: {str(e)[:300]}")
                try: shot(page, f"{key}_{vp}_{theme}_ECHEC")
                except Exception: pass
            errs = [e["text"][:200] for e in log.errors() if not re.search(r"876[56]|ERR_CONNECTION_REFUSED|status of 400", e["text"])]
            check(f"{key} {vp}_{theme} · aucune erreur de console", not errs, errs[:3])
            ctx.close()
        b.close()
    ok = sum(c["ok"] for c in checks)
    res.update({"verifs": checks, "total": f"{ok}/{len(checks)}", "secs": round(time.time() - t0, 1)})
    (OUT / "presets_voix.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n{ok}/{len(checks)} vérifications")
    sys.exit(0 if ok == len(checks) else 1)


if __name__ == "__main__":
    main()
