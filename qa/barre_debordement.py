"""Barre du haut (transport) : AUCUN débordement, à aucune largeur (test de non-régression).

Depuis les mètres R11 (puce LUFS, CPU / DSP, état du pont), CAPTURER (R3), GUIDE, métronome et
TAP (R2), la barre débordait de 165 px à 1600 px et de 377 px à 1920 px : le BPM et le bouton
Tempo sortaient de l'écran. Ce scénario échoue dès qu'un élément de la barre sort de l'écran
(ou de la barre), que la barre a `scrollWidth > clientWidth`, que la page défile en largeur,
ou qu'un élément essentiel manque : lecture, stop, REC, boucle, compteur, BPM, Tempo
(tonalité + mesure), LUFS du master, indicateur CPU.

Cas le plus chargé : compte connecté (Partager, avatar), piste armée (CAPTURER), piste guide
(GUIDE), tonalité connue, pont VST connecté (puce VST), tap tempo en cours (TAP 128).
Largeurs : 1280, 1366, 1440, 1600, 1920, 2560 (PC) ; 1024, 1180 (tablette, tactile) ;
mode simple et avancé ; thème sombre et clair. Chrome headless (aucune fenêtre).

NOVA_URL=http://127.0.0.1:3453/ PYTHONIOENCODING=utf-8 QA_PHASE=apres python qa/barre_debordement.py
Sorties : D:\\1 WORK\\CONTENU\\nova-barre\\<phase>\\ (captures de la barre + barre_debordement.json)
"""
import json, os, sys, zipfile, io, wave
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3453/")
PHASE = os.environ.get("QA_PHASE", "apres")
os.environ.setdefault("QA_OUT", rf"D:\1 WORK\CONTENU\nova-barre\{PHASE}")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, OUT  # noqa: E402
from desktop_gate import install_mocks, SUPERADMIN  # noqa: E402
_r1 = (Path(__file__).parent / "r1_export.py").read_text(encoding="utf-8").split("\nwith sync_playwright() as p:")[0]
exec(compile(_r1, "r1_export.py", "exec"))  # open_with_project, close_welcome…
from playwright.sync_api import sync_playwright  # noqa: E402

PC = [1280, 1366, 1440, 1600, 1920, 2560]
TAB = [1024, 1180]
HEIGHT = {1280: 800, 1366: 768, 1440: 900, 1600: 900, 1920: 1080, 2560: 1440, 1024: 768, 1180: 820}
res = {"phase": PHASE, "cas": [], "echecs": []}


def silent_wav(secs=2, sr=48000):
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr); w.writeframes(b"\0" * (4 * sr * secs))
    return b.getvalue()


def make_project(path):
    def track(tid, name, typ="AUDIO", out="master", clip=True, **kw):
        return {"id": tid, "name": name, "type": typ, "color": "#22d3ee", "isMuted": False, "isSolo": False, "isTrackArmed": False,
                "isFrozen": False, "volume": 1, "pan": 0, "outputTrackId": out, "sends": [], "plugins": [], "automationLanes": [], "totalLatency": 0,
                "clips": [{"id": "c-" + tid, "name": name, "type": "AUDIO", "start": 0, "duration": 2, "offset": 0, "audioRef": "audio/sil.wav",
                           "color": "#ef4444", "fadeIn": 0, "fadeOut": 0, "gain": 1}] if clip else [], **kw}
    tracks = [track("beat", "Beat"), track("voix", "Voix lead", isTrackArmed=True),
              track("guide", "Guide topliner", isGuide=True, guideLevel=0.7), track("master", "MASTER", typ="BUS", out="", clip=False)]
    state = {"id": "qa-barre", "name": "Barre QA", "bpm": 120, "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False,
             "loopStart": 0, "loopEnd": 2, "tracks": tracks, "selectedTrackId": "voix", "currentView": "ARRANGEMENT",
             "timeSignature": {"numerator": 4, "denominator": 4}, "trackGroups": [], "markers": [], "projectKey": 1, "projectScale": "MINOR",
             "metronome": {"enabled": False, "volume": 1, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
             "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0}}
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/sil.wav", silent_wav())


SET_MODE = """async ({ simple, theme }) => {
  const { simpleModeStore } = await window.__novaAppModule('/utils/simpleMode.ts');
  const { themeStore } = await window.__novaAppModule('/utils/themeStore.ts');
  simpleModeStore.setPref(simple); themeStore.setPref(theme);
  // Pont VST connecté (cas le plus chargé : puce VST dans la barre).
  try { const { novaBridge } = await window.__novaAppModule('/services/NovaBridge.ts'); novaBridge.setBridgeState({ status: 'connected', pluginCount: 12 }); } catch (e) {}
  return true;
}"""

MEASURE = r"""() => {
  const rec = document.querySelector('[data-nova-target=rec]');
  const bar = document.querySelector('[data-testid=transport-bar]') || (rec && rec.closest('.h-16'));
  if (!bar) return { erreur: 'barre introuvable' };
  const vw = document.documentElement.clientWidth;
  const br = bar.getBoundingClientRect();
  const lim = { l: Math.max(0, br.left), r: Math.min(vw, br.right) };
  const shown = el => { if (!el || !el.getClientRects().length) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity !== 0; };
  const name = el => (el.getAttribute('aria-label') || el.getAttribute('data-testid') || el.title || el.innerText || el.className || el.tagName).toString().replace(/\s+/g, ' ').trim().slice(0, 60);
  const dehors = [];
  for (const el of bar.querySelectorAll('*')) {
    if (!shown(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.right > lim.r + 1 || r.left < lim.l - 1) dehors.push({ el: name(el), left: Math.round(r.left), right: Math.round(r.right) });
  }
  // Éléments de la barre (boutons, puces, compteurs) et leur largeur.
  const elements = [];
  for (const el of bar.querySelectorAll('button, [role=status], [data-testid], [data-bar-item], input')) {
    if (!shown(el)) continue;
    if (el.parentElement && el.parentElement.closest('button, [role=status], [data-testid=transport-bpm]') && !el.matches('[data-bar-item]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1) continue;
    elements.push({ el: name(el), x: Math.round(r.left), w: Math.round(r.width) });
  }
  const ess = {
    lecture: 'button[aria-label=Lecture], button[aria-label=Pause]', stop: 'button[aria-label=Stop]', rec: '[data-nova-target=rec]',
    boucle: 'button[aria-label=Boucle]', compteur: '[data-nova-target=clock]', bpm: '[data-testid=transport-bpm], [title^="Tempo : glisser"]',
    tempo_tonalite_mesure: '[data-testid=open-tempo]', lufs: '[data-testid=lufs-chip]', cpu: '[data-testid=dsp-meter]',
  };
  const essentiels = {};
  for (const [k, sel] of Object.entries(ess)) {
    const el = Array.from(bar.querySelectorAll(sel)).find(shown);
    if (!el) { essentiels[k] = 'absent'; continue; }
    const r = el.getBoundingClientRect();
    essentiels[k] = (r.left >= lim.l - 1 && r.right <= lim.r + 1 && r.width > 0) ? 'ok' : `hors écran (${Math.round(r.left)}→${Math.round(r.right)})`;
  }
  const folded = Array.from(bar.querySelectorAll('[data-bar-folded]')).map(e => e.getAttribute('data-bar-item'));
  return {
    vw, bar: { clientWidth: bar.clientWidth, scrollWidth: bar.scrollWidth, right: Math.round(br.right) },
    page_scrollWidth: document.documentElement.scrollWidth,
    depassement_px: Math.max(0, Math.round(Math.max(bar.scrollWidth - bar.clientWidth, ...dehors.map(d => d.right - lim.r), 0))),
    dehors: dehors.slice(0, 30), elements, essentiels, replies: folded,
    viewMode: document.body.getAttribute('data-view-mode'),
  };
}"""

TAP_KEYS = """async () => { for (let i = 0; i < 3; i++) { window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', code: 'KeyT', bubbles: true })); await new Promise(r => setTimeout(r, 470)); } }"""


def run_case(page, kind, width, simple, theme):
    page.set_viewport_size({"width": width, "height": HEIGHT[width]})
    page.evaluate(SET_MODE, {"simple": simple, "theme": theme})
    page.wait_for_timeout(250)
    page.evaluate(TAP_KEYS)  # « TAP 128 » affiché pendant la mesure (le cas le plus large)
    page.wait_for_timeout(350)
    m = page.evaluate(MEASURE)
    label = f"{kind}_{width}_{'simple' if simple else 'avance'}_{theme}"
    m["cas"] = label
    pb = []
    if m.get("erreur"): pb.append(m["erreur"])
    else:
        if m["bar"]["scrollWidth"] > m["bar"]["clientWidth"]: pb.append(f"barre scrollWidth {m['bar']['scrollWidth']} > clientWidth {m['bar']['clientWidth']}")
        if m["page_scrollWidth"] > m["vw"] + 1: pb.append(f"la page défile en largeur ({m['page_scrollWidth']} > {m['vw']})")
        if m["dehors"]: pb.append(f"{len(m['dehors'])} élément(s) hors de l'écran : " + ", ".join(d["el"] for d in m["dehors"][:6]))
        bad = {k: v for k, v in m["essentiels"].items() if v != "ok"}
        if bad: pb.append("essentiels manquants : " + json.dumps(bad, ensure_ascii=False))
    m["ok"] = not pb
    m["problemes"] = pb
    page.screenshot(path=str(OUT / f"barre_{label}.png"), clip={"x": 0, "y": 0, "width": width, "height": 72})
    print(("OK  " if not pb else "KO  ") + label, f"(dépassement {m.get('depassement_px')} px, repliés : {len(m.get('replies') or [])})", "" if not pb else " | ".join(pb)[:400])
    res["cas"].append(m)
    if pb: res["echecs"].append(label)


with sync_playwright() as p:
    b = launch(p)
    zpath = OUT / "barre_projet.zip"
    make_project(zpath)
    for kind, widths in (("pc", PC), ("tab", TAB)):
        ctx, page = new_page(b, kind)
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)[:300]))
        install_mocks(page, "romain", SUPERADMIN, {})
        open_with_project(page, zpath)
        page.mouse.click(5, 300)
        page.keyboard.press("Escape")
        for simple in (False, True):
            for theme in ("dark", "light"):
                for w in widths:
                    run_case(page, kind, w, simple, theme)
        if errs: res.setdefault("erreurs_page", []).extend(errs[:5])
        ctx.close()
    b.close()

(OUT / "barre_debordement.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
n = len(res["cas"])
print(f"\nBILAN : {n - len(res['echecs'])} / {n} sans débordement" + (f" — ÉCHECS : {', '.join(res['echecs'])}" if res["echecs"] else ""))
sys.exit(1 if res["echecs"] else 0)
