"""Toutes les fenêtres du studio : temps d'ouverture, fermeture par Échap, style (audit pro).

Pour chaque fenêtre, panneau ou menu qu'un ingé ouvre dans une journée (raccourci ou bouton) :
- temps entre le geste et l'apparition (ms) ;
- Échap la ferme-t-elle ? (Pro Tools, Logic, Live : oui, toujours) ;
- a-t-elle un titre, un bouton Fermer, un rôle « dialog » (lecteurs d'écran) ;
- boutons de moins de 24 px (trop petits à la souris, impossibles au doigt).
Chrome headless (aucune fenêtre), compte simulé, aucune écriture externe.

NOVA_URL=http://127.0.0.1:3491/ QA_PHASE=apres PYTHONIOENCODING=utf-8 python qa/fenetres_echap.py
Sorties : D:\\1 WORK\\CONTENU\\nova-pro\\<phase>\\fenetres\\ (fenetres_echap.json + captures)
"""
import json, os, sys, time
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3491/")
PHASE = os.environ.get("QA_PHASE", "apres")
os.environ.setdefault("QA_OUT", rf"D:\1 WORK\CONTENU\nova-pro\{PHASE}\fenetres")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, OUT, Log  # noqa: E402
from nova_pro_lib import track_point  # noqa: E402
from desktop_gate import install_mocks, SUPERADMIN  # noqa: E402
_r1 = (Path(__file__).parent / "r1_export.py").read_text(encoding="utf-8").split("\nwith sync_playwright() as p:")[0]
exec(compile(_r1, "r1_export.py", "exec"))  # make_project, open_with_project…
from playwright.sync_api import sync_playwright  # noqa: E402

MARK = r"""() => {
  const out = [];
  const cand = document.querySelectorAll('[role=dialog], [aria-modal=true], [role=menu], [role=listbox], [data-nova-transport], [data-nova-pianoroll], body *');
  let n = 0;
  for (const el of cand) {
    if (n > 4000) break; n++;
    if (!el.getClientRects().length) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
    const special = el.matches('[role=dialog], [aria-modal=true], [role=menu], [role=listbox], [data-nova-transport], [data-nova-pianoroll]');
    if (!special) {
      if (cs.position !== 'fixed') continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height < 30000) continue;
      if ((+cs.zIndex || 0) < 40) continue;
    }
    if (!el.dataset.qaW) el.dataset.qaW = String(Math.random()).slice(2, 10);
    out.push(el.dataset.qaW);
  }
  return out;
}"""

DESCRIBE = r"""(ids) => ids.map(id => {
  const el = document.querySelector(`[data-qa-w="${id}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const head = el.querySelector('h1, h2, h3, [id$=title]');
  const close = el.querySelector('button[aria-label^="Fermer"], button[title^="Fermer"], button[aria-label="Close"]');
  const small = Array.from(el.querySelectorAll('button')).filter(b => { const q = b.getBoundingClientRect(); return q.width > 0 && (q.height < 24 || q.width < 20); }).length;
  return { id, role: el.getAttribute('role') || (el.getAttribute('aria-modal') ? 'modal' : ''), titre: (el.getAttribute('aria-label') || (head && head.innerText) || '').trim().slice(0, 60),
           fermer: !!close, petits_boutons: small, w: Math.round(r.width), h: Math.round(r.height) };
}).filter(Boolean)"""

VISIBLE_IDS = r"""(ids) => ids.filter(id => { const el = document.querySelector(`[data-qa-w="${id}"]`); if (!el || !el.getClientRects().length) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity !== 0; })"""

res = {"phase": PHASE, "fenetres": []}


def new_windows(page, before, timeout_ms=5000):
    t0 = time.time()
    while (time.time() - t0) * 1000 < timeout_ms:
        now = page.evaluate(MARK)
        nw = [i for i in now if i not in before]
        if nw:
            return nw, round((time.time() - t0) * 1000)
        page.wait_for_timeout(40)
    return [], None


def force_close(page, ids):
    for _ in range(3):
        if not page.evaluate(VISIBLE_IDS, ids): return True
        b = page.locator("button:visible[aria-label^='Fermer'], button:visible[title^='Fermer']")
        if b.count(): b.last.click(); page.wait_for_timeout(300); continue
        page.mouse.click(700, 500); page.wait_for_timeout(300)
    return not page.evaluate(VISIBLE_IDS, ids)


def case(page, log, name, action, pre=None):
    if pre:
        try: pre(page)
        except Exception as e: print("  (préparation)", name, e)
    page.wait_for_timeout(250)
    before = page.evaluate(MARK)
    n_err = len(log.errors())
    t = time.time()
    try:
        action(page)
    except Exception as e:
        res["fenetres"].append({"fenetre": name, "ouverte": False, "erreur": str(e)[:200]}); print("??  ", name, "geste impossible :", str(e)[:120]); return
    nw, ms = new_windows(page, before)
    if not nw:
        res["fenetres"].append({"fenetre": name, "ouverte": False}); print("--  ", name, "rien ne s'ouvre"); return
    page.wait_for_timeout(350)
    desc = page.evaluate(DESCRIBE, nw)
    page.screenshot(path=str(OUT / f"f_{len(res['fenetres']):02d}_{''.join(c if c.isalnum() else '_' for c in name)[:30]}.png"))
    page.keyboard.press("Escape")
    page.wait_for_timeout(600)
    still = page.evaluate(VISIBLE_IDS, nw)
    echap = not still
    if not echap: force_close(page, nw)
    errs = [e["text"][:160] for e in log.errors()[n_err:] if "8765" not in e["text"] and "8766" not in e["text"]]
    item = {"fenetre": name, "ouverte": True, "ms": ms, "echap_ferme": echap, "details": desc[:3], "erreurs_console": errs[:3]}
    res["fenetres"].append(item)
    print(("OK  " if echap else "KO  ") + name, f"{ms} ms", "Échap ferme" if echap else "ÉCHAP NE FERME PAS", json.dumps(desc[:1], ensure_ascii=False)[:160])


def key(k):
    return lambda p: p.keyboard.press(k)


def click(sel):
    return lambda p: p.locator(sel).locator("visible=true").first.click(timeout=4000)


def select_first_clip(p):
    x, y = track_point(p, "voix", 3.0)
    p.mouse.click(x, y)


def clip_menu(p):
    x, y = track_point(p, "voix", 3.0)
    p.mouse.click(x, y, button="right")


CASES = [
    ("Menu ☰", click("button[aria-label='Ouvrir le menu']"), None),
    ("Sauvegarder (Ctrl+S)", key("Control+s"), None),
    ("Exporter (Ctrl+Maj+E)", key("Control+Shift+E"), None),
    ("Aide des raccourcis (?)", key("Shift+Slash"), None),
    ("Éditeur de raccourcis (Ctrl+Alt+K)", key("Control+Alt+k"), None),
    ("Dispositions de fenêtres (Ctrl+Alt+J)", key("Control+Alt+j"), None),
    ("Repères (Ctrl+5)", key("Control+5"), None),
    ("Importer depuis une session (Alt+Maj+I)", key("Alt+Shift+I"), None),
    ("Insérer du temps (Ctrl+Alt+I)", key("Control+Alt+i"), None),
    ("Signaler un bug (Ctrl+Maj+B)", key("Control+Shift+B"), None),
    ("Palette de commandes (Ctrl+K)", key("Control+k"), None),
    ("Master Nova", click("[data-nova-open-master]"), None),
    ("Tempo et mesure", click("[data-testid=open-tempo]"), None),
    ("Clic et décompte", click("[data-testid=open-metronome]"), None),
    ("Réglages du punch", click("button[aria-label^='Réglages du punch']"), None),
    ("Loudness (LUFS)", click("[data-testid=lufs-chip]"), None),
    ("Charge CPU / DSP", click("[data-testid=dsp-meter]"), None),
    ("Mix auto", click("[data-nova-target=mix-auto]"), None),
    ("Paroles", click("[data-nova-target=lyrics]"), None),
    ("Liste des pistes", click("[data-testid=dock-track-list]"), None),
    ("Groupes", click("[data-testid=dock-groups]"), None),
    ("Temps (bandeau)", click("[data-testid=dock-time]"), None),
    ("Session (notes, clips, versions)", click("[data-testid=dock-session]"), None),
    ("Effets de la piste (FX)", click("button:has-text('FX')"), None),
    ("Prises (comp)", click("button:has-text('Prises')"), None),
    ("Menu du clip (clic droit)", clip_menu, None),
    ("Supprimer les silences (Ctrl+U)", key("Control+u"), select_first_clip),
    ("Respirations (Ctrl+Alt+R)", key("Control+Alt+r"), select_first_clip),
    ("Répéter (Alt+R)", key("Alt+r"), select_first_clip),
    ("Mixer (Ctrl+=) puis Échap", key("Control+Equal"), None),
]

with sync_playwright() as p:
    b = launch(p)
    log = Log("fenetres")
    ctx, page = new_page(b, "pc", log=log)
    page.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
    install_mocks(page, "romain", SUPERADMIN, {})
    z = OUT / "fenetres.zip"; make_project(z)
    t = time.time()
    open_with_project(page, z)
    res["ouverture_projet_s"] = round(time.time() - t, 1)
    page.mouse.click(5, 300); page.keyboard.press("Escape")
    for name, action, pre in CASES:
        if name.startswith("Mixer"):
            before = page.evaluate("() => document.body.innerText.includes('MASTER')")
        case(page, log, name, action, pre)
        page.mouse.move(5, 5)
    ctx.close()
    b.close()

ok = [f for f in res["fenetres"] if f.get("ouverte")]
res["bilan"] = {"ouvertes": len(ok), "echap_ferme": sum(1 for f in ok if f["echap_ferme"]),
                "echap_ne_ferme_pas": [f["fenetre"] for f in ok if not f["echap_ferme"]],
                "pas_ouvertes": [f["fenetre"] for f in res["fenetres"] if not f.get("ouverte")],
                "ms_median": sorted(f["ms"] for f in ok)[len(ok) // 2] if ok else None,
                "ms_max": max((f["ms"], f["fenetre"]) for f in ok) if ok else None}
(OUT / "fenetres_echap.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
print("\nBILAN :", json.dumps(res["bilan"], ensure_ascii=False))
