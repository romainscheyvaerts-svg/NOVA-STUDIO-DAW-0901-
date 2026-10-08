"""Outils communs des sessions chronométrées « NOVA utilisable et pro » (qa/session_*.py).

- `Chrono` : compte les clics, les touches et le temps de chaque étape d'une tâche, note les
  hésitations (bouton introuvable, deux chemins…) et les erreurs de la console.
- Géométrie de l'arrangement (canvas) : cliquer un clip comme un vrai utilisateur.
- Chemins vers une action : bouton visible, raccourci, menu ☰, palette (Ctrl+K) ; la session
  prend le chemin le plus court DISPONIBLE et le note (avant / après comparables).
"""
import json, time, re
from pathlib import Path

ZOOM = 40      # px par seconde (zoom par défaut de l'arrangement)
LANE_H = 120   # hauteur d'une piste (px)


class Chrono:
    def __init__(self, name, page, log, out: Path):
        self.name, self.page, self.log, self.out = name, page, log, out
        self.steps = []
        self.cur = None

    # -- étapes -------------------------------------------------------------------
    def start(self, tache, etape, protools=None):
        self.end()
        self.cur = {"tache": tache, "etape": etape, "clics": 0, "touches": 0, "t0": time.time(), "chemin": [],
                    "frictions": [], "protools": protools, "n_err": len(self.log.errors())}

    def end(self, ok=True, note=None):
        c = self.cur
        if not c: return
        c["ms"] = round((time.time() - c.pop("t0")) * 1000)
        c["ok"] = bool(ok) and c.get("ok", True)
        errs = [e["text"][:160] for e in self.log.errors()[c.pop("n_err"):] if not re.search(r"876[56]|ERR_CONNECTION_REFUSED", e["text"])]
        c["erreurs_console"] = errs[:3]
        if note: c["note"] = note
        self.steps.append(c)
        mark = "OK " if c["ok"] else "KO "
        print(f"  {mark} {c['tache']} · {c['etape']} : {c['clics']} clic(s), {c['touches']} touche(s), {c['ms']} ms"
              + (f" — {' ; '.join(c['frictions'])}" if c["frictions"] else "") + (f" [console : {errs[0][:80]}]" if errs else ""))
        self.cur = None

    def fail(self, why):
        if self.cur:
            self.cur["ok"] = False
            self.cur["frictions"].append(why)

    def friction(self, why):
        if self.cur: self.cur["frictions"].append(why)

    # -- gestes comptés --------------------------------------------------------------
    def click(self, loc, label=None, **kw):
        loc.click(**kw)
        if self.cur: self.cur["clics"] += 1; self.cur["chemin"].append(f"clic {label or ''}".strip())
        self.page.wait_for_timeout(120)

    def tap(self, loc, label=None):
        loc.tap()
        if self.cur: self.cur["clics"] += 1; self.cur["chemin"].append(f"doigt {label or ''}".strip())
        self.page.wait_for_timeout(150)

    def mouse_click(self, x, y, label=None, **kw):
        self.page.mouse.click(x, y, **kw)
        if self.cur: self.cur["clics"] += 1; self.cur["chemin"].append(f"clic {label or ''}".strip())
        self.page.wait_for_timeout(120)

    def press(self, key, label=None):
        self.page.keyboard.press(key)
        if self.cur: self.cur["touches"] += 1; self.cur["chemin"].append(f"touche {key}")
        self.page.wait_for_timeout(100)

    def type(self, text):
        self.page.keyboard.type(text, delay=10)
        if self.cur: self.cur["touches"] += len(text); self.cur["chemin"].append(f"saisie « {text} »")

    def drag(self, x0, y0, x1, y1, label=None):
        m = self.page.mouse
        m.move(x0, y0); m.down(); m.move((x0 + x1) / 2, (y0 + y1) / 2, steps=4); m.move(x1, y1, steps=4); m.up()
        if self.cur: self.cur["clics"] += 1; self.cur["chemin"].append(f"glisser {label or ''}".strip())
        self.page.wait_for_timeout(150)

    # -- attentes ------------------------------------------------------------------
    def wait_js(self, js, timeout_ms=8000, what=""):
        t = time.time()
        while (time.time() - t) * 1000 < timeout_ms:
            try:
                if self.page.evaluate(js): return round((time.time() - t) * 1000)
            except Exception:
                pass
            self.page.wait_for_timeout(50)
        self.fail(f"attente dépassée : {what or js[:60]}")
        return None

    def report(self):
        return {"session": self.name, "etapes": self.steps,
                "total": {"clics": sum(s["clics"] for s in self.steps), "touches": sum(s["touches"] for s in self.steps),
                          "ms": sum(s["ms"] for s in self.steps), "etapes_ko": sum(1 for s in self.steps if not s["ok"]),
                          "frictions": sum(len(s["frictions"]) for s in self.steps)}}


# -- chemins vers une action ---------------------------------------------------------
def visible_first(page, sel):
    loc = page.locator(sel).locator("visible=true")
    return loc.first if loc.count() else None


def open_by_palette(ch, query, want_id=None):
    """Ctrl+K, la recherche, Entrée. Renvoie False si la palette n'existe pas (version avant)."""
    page = ch.page
    page.keyboard.press("Control+k")
    try:
        page.locator("[data-testid=command-palette]").wait_for(timeout=1500)
    except Exception:
        return False
    if ch.cur: ch.cur["touches"] += 1; ch.cur["chemin"].append("touche Ctrl+K")
    ch.type(query)
    page.wait_for_timeout(120)
    if want_id:
        first = page.locator("[data-testid=command-palette] [role=option]").first.get_attribute("data-palette-id")
        if first != want_id: ch.friction(f"palette : « {query} » donne d'abord {first}")
    ch.press("Enter")
    return True


def via_menu(ch, item_rx):
    """Menu ☰ puis l'entrée (2 clics). False si l'entrée n'y est pas."""
    page = ch.page
    b = visible_first(page, "button[aria-label='Ouvrir le menu']")
    if not b: return False
    ch.click(b, "menu ☰")
    it = page.locator("[role=dialog][aria-label=Menu] button", has_text=re.compile(item_rx)).locator("visible=true")
    if not it.count():
        page.keyboard.press("Escape"); return False
    ch.click(it.first, item_rx)
    return True


# -- arrangement (canvas) -------------------------------------------------------------
def canvas_box(page):
    return page.evaluate("""() => { const c = (document.querySelector('.nova-grille canvas[data-tracks-top]') || document.querySelectorAll('.nova-grille canvas')[1]); if (!c) return null; const r = c.getBoundingClientRect();
      const sc = document.querySelector('.nova-grille .custom-scroll'); return { x: r.left, y: r.top, w: r.width, h: r.height, sl: sc ? sc.scrollLeft : 0, st: sc ? sc.scrollTop : 0, tt: +(c.dataset.tracksTop || 40) }; }""")


def clip_point(page, track_index, t_sec, dy=60):
    b = canvas_box(page)
    return b["x"] + t_sec * ZOOM - b["sl"], b["y"] + b["tt"] + track_index * LANE_H - b["st"] + dy


def app_state(page, expr="s => s"):
    """Lit l'état du projet en mémoire (window.__novaEdit, posé par le studio) : expr = fonction JS."""
    return page.evaluate(f"() => {{ const s = window.__novaEdit && window.__novaEdit.getState(); return s ? ({expr})(s) : null; }}")


def save_json(path: Path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
