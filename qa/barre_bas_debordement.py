"""Bandeau du bas (ordinateur / tablette) : visible, entier, rien qui dépasse (non-régression).

Deux défauts trouvés le 08/10/2026 en rejouant une session d'enregistrement :
1. Dans Nova Studio (appli Windows), le studio prenait la hauteur de son contenu (catalogue
   d'instrus de 3 000 px) : le bandeau du bas (Pistes, Groupes, Piste voix, Paroles, Mix auto…)
   était posé à y = 2 992 px, hors de l'écran, à TOUTES les largeurs ; les pistes du bas aussi.
2. À 1024 px (tablette), « Mix auto » sortait à droite (1 012 → 1 129 px) dans un ruban
   défilant sans barre de défilement : introuvable.

Le scénario échoue si le bandeau n'est pas entièrement dans l'écran, si un de ses boutons sort
de l'écran ou de son ruban, s'il est caché par un autre élément (bulle de l'assistant…), si un
bouton fait moins de 40 px de haut (doigt), ou si « Piste voix » / « Mix auto » manquent.
Cas : 1024 et 1180 (tablette, tactile), 1280 à 1920 (PC) ; navigateur ouvert et fermé ;
projet voix et projet beatmaking (Batterie, 808, Sampler, MIDI en plus) ; thème sombre et clair.

NOVA_URL=http://127.0.0.1:3481/ PYTHONIOENCODING=utf-8 QA_PHASE=apres python qa/barre_bas_debordement.py
Sorties : D:\\1 WORK\\CONTENU\\nova-pro\\<phase>\\barre_bas\\ (captures + barre_bas_debordement.json)
"""
import json, os, sys, zipfile, io, wave
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3481/")
PHASE = os.environ.get("QA_PHASE", "apres")
os.environ.setdefault("QA_OUT", rf"D:\1 WORK\CONTENU\nova-pro\{PHASE}\barre_bas")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, OUT  # noqa: E402
from desktop_gate import install_mocks, SUPERADMIN  # noqa: E402
_r1 = (Path(__file__).parent / "r1_export.py").read_text(encoding="utf-8").split("\nwith sync_playwright() as p:")[0]
exec(compile(_r1, "r1_export.py", "exec"))  # open_with_project, close_welcome…
from playwright.sync_api import sync_playwright  # noqa: E402

PC = [1280, 1366, 1600, 1920]
TAB = [1024, 1180]
HEIGHT = {1280: 800, 1366: 768, 1440: 900, 1600: 900, 1920: 1080, 1024: 768, 1180: 820}
res = {"phase": PHASE, "cas": [], "echecs": []}


def silent_wav(secs=2, sr=48000):
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr); w.writeframes(b"\0" * (4 * sr * secs))
    return b.getvalue()


def make_project(path, mode):
    def track(tid, name, typ="AUDIO", out="master", clip=True, **kw):
        return {"id": tid, "name": name, "type": typ, "color": "#22d3ee", "isMuted": False, "isSolo": False, "isTrackArmed": False,
                "isFrozen": False, "volume": 1, "pan": 0, "outputTrackId": out, "sends": [], "plugins": [], "automationLanes": [], "totalLatency": 0,
                "clips": [{"id": "c-" + tid, "name": name, "type": "AUDIO", "start": 0, "duration": 2, "offset": 0, "audioRef": "audio/sil.wav",
                           "color": "#ef4444", "fadeIn": 0, "fadeOut": 0, "gain": 1}] if clip else [], **kw}
    tracks = [track("beat", "Beat"), track("voix", "Voix lead", isTrackArmed=True), track("master", "MASTER", typ="BUS", out="", clip=False)]
    state = {"id": f"qa-dock-{mode}", "name": "Bandeau QA", "bpm": 140, "isPlaying": False, "isRecording": False, "currentTime": 0,
             "isLoopActive": False, "loopStart": 0, "loopEnd": 2, "tracks": tracks, "selectedTrackId": "voix", "currentView": "ARRANGEMENT",
             "timeSignature": {"numerator": 4, "denominator": 4}, "trackGroups": [], "markers": [], "projectKey": 1, "projectScale": "MINOR",
             "metronome": {"enabled": False, "volume": 1, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
             "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
             **({"projectMode": "BEATMAKING"} if mode == "beat" else {})}
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/sil.wav", silent_wav())


SET_THEME = """async (theme) => { const { themeStore } = await window.__novaAppModule('/utils/themeStore.ts'); themeStore.setPref(theme); return true; }"""

MEASURE = r"""() => {
  const dock = document.querySelector('[data-nova-dock]');
  if (!dock) return { erreur: 'bandeau introuvable' };
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const d = dock.getBoundingClientRect();
  const shown = el => { if (!el || !el.getClientRects().length) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const name = el => (el.getAttribute('aria-label') || el.innerText || el.title || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const boutons = [];
  const pb = [];
  for (const b of dock.querySelectorAll('button')) {
    if (!shown(b)) continue;
    const r = b.getBoundingClientRect();
    const scroller = b.closest('[data-dock-scroll]');
    const lim = scroller ? scroller.getBoundingClientRect() : d;
    const item = { b: name(b), x: Math.round(r.left), droite: Math.round(r.right), h: Math.round(r.height), replie: b.hasAttribute('data-dock-compact') };
    if (r.right > Math.min(vw, lim.right) + 1 || r.left < Math.max(0, lim.left) - 1) pb.push(`« ${item.b} » hors de l'écran ou de son ruban (${item.x}→${item.droite}, limite ${Math.round(Math.min(vw, lim.right))})`);
    else {
      const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      if (!hit || !b.contains(hit)) pb.push(`« ${item.b} » caché par ${(hit && (hit.getAttribute('aria-label') || hit.className || hit.tagName) || 'rien').toString().slice(0, 60)}`);
    }
    if (r.height < 40) pb.push(`« ${item.b} » trop petit pour le doigt (${Math.round(r.height)} px)`);
    boutons.push(item);
  }
  if (d.bottom > vh + 1 || d.top < 0) pb.push(`bandeau hors de l'écran (haut ${Math.round(d.top)}, bas ${Math.round(d.bottom)}, écran ${vh})`);
  if (document.documentElement.scrollWidth > vw + 1) pb.push(`la page défile en largeur (${document.documentElement.scrollWidth} > ${vw})`);
  for (const [k, sel] of [['Piste voix', 'button[aria-label="Ajouter une piste voix"]'], ['Mix auto', '[data-nova-target=mix-auto]']]) {
    if (!Array.from(dock.querySelectorAll(sel)).some(shown)) pb.push(`${k} absent`);
  }
  return { vw, vh, bandeau: { haut: Math.round(d.top), bas: Math.round(d.bottom), gauche: Math.round(d.left), droite: Math.round(d.right) }, boutons, problemes: pb };
}"""


def toggle_sidebar(page, want_open):
    lab = "Masquer le navigateur" if not want_open else "Afficher le navigateur"
    b = page.locator(f"button:visible[aria-label='{lab}']")
    if b.count():
        b.first.click(); page.wait_for_timeout(500)


def run_case(page, kind, mode, width, side, theme):
    page.set_viewport_size({"width": width, "height": HEIGHT[width]})
    page.evaluate(SET_THEME, theme)
    page.wait_for_timeout(450)
    m = page.evaluate(MEASURE)
    label = f"{kind}_{mode}_{width}_{'nav' if side else 'sans-nav'}_{theme}"
    m["cas"] = label
    pb = [m["erreur"]] if m.get("erreur") else m["problemes"]
    m["ok"] = not pb
    if theme == "dark" or pb:
        page.screenshot(path=str(OUT / f"bas_{label}.png"), clip={"x": 0, "y": max(0, HEIGHT[width] - 90), "width": width, "height": 90})
    print(("OK  " if not pb else "KO  ") + label, f"({sum(1 for b in m.get('boutons', []) if b['replie'])} replié(s))", "" if not pb else " | ".join(pb)[:500])
    res["cas"].append(m)
    if pb: res["echecs"].append(label)


with sync_playwright() as p:
    b = launch(p)
    for mode in ("voix", "beat"):
        zpath = OUT / f"bandeau_{mode}.zip"
        make_project(zpath, mode)
        for kind, widths in (("pc", PC), ("tab", TAB)):
            ctx, page = new_page(b, kind)
            errs = []
            page.on("pageerror", lambda e: errs.append(str(e)[:300]))
            page.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
            install_mocks(page, "romain", SUPERADMIN, {})
            open_with_project(page, zpath)
            page.mouse.click(5, 300)
            page.keyboard.press("Escape")
            for side in (True, False):
                toggle_sidebar(page, side)
                for theme in (("dark", "light") if kind == "tab" else ("dark",)):
                    for w in widths:
                        run_case(page, kind, mode, w, side, theme)
            if errs: res.setdefault("erreurs_page", []).extend(errs[:5])
            ctx.close()
    b.close()

(OUT / "barre_bas_debordement.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
n = len(res["cas"])
print(f"\nBILAN : {n - len(res['echecs'])} / {n} sans débordement" + (f" — ÉCHECS : {', '.join(res['echecs'])}" if res["echecs"] else ""))
sys.exit(1 if res["echecs"] else 0)
