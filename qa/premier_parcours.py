"""Premier parcours chronométré d'un nouveau venu (« le DAW le plus simple possible », 15/10/2026).

Parcours : ouverture du site → choisir une instru → première prise enregistrée → écouter → exporter
(jusqu'à la fenêtre d'export). Mode simple (celui du site par défaut), Chrome headless, aucune fenêtre.

Cas mesurés (thème sombre) :
  - pc_nouveau      bureau 1600 × 900, souris, sans compte, première visite (stockage vide) ;
  - pc_connecte     bureau 1600 × 900, compte connecté (session simulée), première visite sur cet appareil ;
  - tel_nouveau     téléphone 390 × 844, au doigt, sans compte ;
  - tel_connecte    téléphone 390 × 844, au doigt, compte connecté.
Captures seules (thème clair) : pc_nouveau_clair, tel_nouveau_clair.

Chaque étape compte les clics (ou touchers), les touches, le temps, et note les frictions : fenêtre qui
s'interpose, bouton hors de l'écran ou recouvert, question posée avant la prise, autorisation du micro
demandée sans explication à l'écran. Le navigateur headless accorde le micro tout seul : le clic
« Autoriser » d'un vrai navigateur est AJOUTÉ au compte (1 clic) la première fois que l'appli demande le
micro, et l'écran affiché à ce moment est capturé (l'explication est-elle là ?).

Inventaire de chaque écran (accueil, studio, pendant la prise, après la prise, fenêtre d'export) :
éléments interactifs visibles (boutons, liens, champs), éléments flottants, éléments recouverts par un
autre (un élément flottant ne doit en recouvrir aucun).

Objectif : moins de 60 s et au plus 5 clics jusqu'à la première prise (temps de chant compris : 3 s).

NOVA_URL=http://127.0.0.1:3464/ QA_PHASE=apres PYTHONIOENCODING=utf-8 python qa/premier_parcours.py [cas ...]
Sorties : D:\\1 WORK\\CONTENU\\nova-simplicite\\<phase>\\ (premier_parcours.json + captures)
"""
import json, os, re, sys, time
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3464/")
PHASE = os.environ.get("QA_PHASE", "apres")
os.environ.setdefault("QA_OUT", rf"D:\1 WORK\CONTENU\nova-simplicite\{PHASE}")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, OUT, Log, BASE  # noqa: E402
from nova_pro_lib import Chrono, app_state, save_json  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

PROJECT = "mxdrxpzxbgybchzzvpkf"
CHANT_S = 3          # durée chantée de la première prise
OBJ_S, OBJ_CLICS = 60, 5

CAS = {
    "pc_nouveau": dict(vp="pc", compte=False, theme="dark", mesure=True),
    "pc_connecte": dict(vp="pc", compte=True, theme="dark", mesure=True),
    "tel_nouveau": dict(vp="tel390", compte=False, theme="dark", mesure=True),
    "tel_connecte": dict(vp="tel390", compte=True, theme="dark", mesure=True),
    "pc_nouveau_clair": dict(vp="pc", compte=False, theme="light", mesure=False),
    "tel_nouveau_clair": dict(vp="tel390", compte=False, theme="light", mesure=False),
}
WANT = [a for a in sys.argv[1:] if a in CAS] or list(CAS)

# Session connectée simulée (aucun vrai compte : le jeton n'est accepté que par le simulateur ci-dessous).
USER = {"id": "33333333-3333-4333-8333-333333333333", "email": "nouvel.artiste@example.com"}


def session_json():
    now = int(time.time())
    return json.dumps({"access_token": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcCJ9.qa", "refresh_token": "qa-refresh", "token_type": "bearer",
                       "expires_in": 3600, "expires_at": now + 3600,
                       "user": {"id": USER["id"], "aud": "authenticated", "role": "authenticated", "email": USER["email"]}})


def install_compte(page):
    def auth(route, request):
        if "/auth/v1/user" in request.url:
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps({**USER, "aud": "authenticated", "role": "authenticated"}))
        if "/auth/v1/token" in request.url:
            return route.fulfill(status=200, content_type="application/json", body=session_json())
        return route.fulfill(status=204, body="")
    page.route(f"https://{PROJECT}.supabase.co/auth/v1/**", auth)
    page.add_init_script(f"try {{ localStorage.setItem('sb-{PROJECT}-auth-token', {json.dumps(session_json())}); }} catch (e) {{}}")


# Espion du micro (première visite) : l'autorisation est « à demander » (navigator.permissions → 'prompt')
# jusqu'à la première ouverture du micro, comme sur un navigateur neuf ; la première demande (getUserMedia
# audio) est notée avec ce qui est écrit à l'écran à cet instant (une explication du micro est-elle visible ?).
MIC_SPY = r"""(() => { const md = navigator.mediaDevices; if (!md || !md.getUserMedia) return;
  window.__ppMic = []; window.__ppMicOk = false;
  try { const pq = navigator.permissions && navigator.permissions.query && navigator.permissions.query.bind(navigator.permissions);
    if (pq) navigator.permissions.query = (d) => (d && d.name === 'microphone')
      ? Promise.resolve({ state: window.__ppMicOk ? 'granted' : 'prompt', name: 'microphone', onchange: null, addEventListener() {}, removeEventListener() {} })
      : pq(d); } catch (e) {}
  const orig = md.getUserMedia.bind(md);
  md.getUserMedia = (c) => { let first = false; try { if (c && c.audio) {
      first = !window.__ppMicOk;
      const vis = el => el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
      const hint = document.querySelector('[data-testid=mic-permission-hint]');
      const dlg = [...document.querySelectorAll('[role=dialog], [role=alertdialog], [aria-modal=true]')].filter(vis).map(d => d.innerText).join(' | ');
      window.__ppMic.push({ t: performance.now(), premiere: first, explication: vis(hint) ? hint.innerText : '', dialogue: dlg.slice(0, 400) }); } } catch (e) {}
    return orig(c).then(s => { if (c && c.audio) window.__ppMicOk = true; return s; }); }; })();"""

# Inventaire d'un écran.
INVENTAIRE = r"""() => {
  const W = innerWidth, H = innerHeight;
  const sel = 'button, [role=button], a[href], input:not([type=hidden]), select, textarea, [role=tab], [role=switch], [role=slider], [role=menuitem], summary';
  const vis = el => { if (!el.getClientRects().length) return false; const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0) return false;
    const r = el.getBoundingClientRect(); return r.width >= 4 && r.height >= 4 && r.bottom > 0 && r.right > 0 && r.top < H && r.left < W; };
  const label = el => (el.getAttribute('aria-label') || el.innerText || el.title || el.getAttribute('placeholder') || el.name || '').trim().replace(/\s+/g, ' ').slice(0, 50);
  const els = [...document.querySelectorAll(sel)].filter(vis).filter(el => !el.parentElement.closest(sel) || el.matches('input, select, textarea'));
  const floating = el => { for (let e = el; e && e !== document.body; e = e.parentElement) { const p = getComputedStyle(e).position; if (p === 'fixed' || p === 'sticky') return e; } return null; };
  const items = [], couverts = [], hors = [];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    const it = { t: label(el), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    items.push(it);
    if (r.right > W + 1 || r.bottom > H + 1 || r.left < -1 || r.top < -1) { hors.push(it.t); continue; }
    // Recouvert ? On sonde 3 points (centre et deux coins intérieurs) : recouvert si les 3 tombent ailleurs.
    const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 3, r.top + 3], [r.right - 3, r.bottom - 3]];
    let hits = 0, par = null;
    for (const [x, y] of pts) { const h = document.elementFromPoint(Math.min(W - 1, Math.max(0, x)), Math.min(H - 1, Math.max(0, y)));
      if (h && (el.contains(h) || h.contains(el))) hits++; else if (h && !par) par = h; }
    if (!hits && par) {
      // Une fenêtre (dialogue) recouvre légitimement ce qui est derrière elle. Un élément flottant
      // (position fixe) de petite taille — pastille, bouton rond, bulle, toast — qui cache un bouton est
      // un défaut (« pastille ») ; une carte ou une barre plus grande est notée à part (« carte »).
      const modal = par.closest('[aria-modal=true], [role=dialog], [role=alertdialog]');
      const f = floating(par);
      const fr = f && f.getBoundingClientRect();
      const fixe = f && getComputedStyle(f).position === 'fixed';
      if (!modal)
        couverts.push({ el: it.t, par: label(par.closest(sel) || par) || (par.className && String(par.className).slice(0, 60)) || par.tagName,
                        flottant: !!fixe, pastille: !!fixe && fr.width * fr.height < W * H * 0.12 && fr.width < W * 0.6 });
    }
  }
  const flottants = [...document.querySelectorAll('body *')].filter(e => { const s = getComputedStyle(e); return (s.position === 'fixed') && vis(e) && e.getBoundingClientRect().width < W * 0.9 && e.querySelector && (e.matches(sel) || e.querySelector(sel)); })
    .map(e => ({ t: label(e).slice(0, 40), cls: String(e.className || '').slice(0, 40) }));
  // Chevauchements entre éléments flottants (pastille sur un toast, bouton rond sur une carte…) :
  // éléments en position fixe de premier niveau, hors fenêtres modales et hors fonds plein écran.
  const fixes = [...document.querySelectorAll('body *')].filter(e => {
    const s = getComputedStyle(e); if (s.position !== 'fixed' || !vis(e)) return false;
    if (e.closest('[aria-modal=true], [role=dialog], [role=alertdialog]')) return false;
    const r = e.getBoundingClientRect(); if (r.width >= W * 0.9 && r.height >= H * 0.5) return false;
    if (!(e.innerText || '').trim() && !e.matches(sel) && !e.querySelector(sel)) return false;
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).position === 'fixed') return false;
    return true; });
  const chevauchements = [];
  for (let i = 0; i < fixes.length; i++) for (let j = i + 1; j < fixes.length; j++) {
    const a = fixes[i].getBoundingClientRect(), b = fixes[j].getBoundingClientRect();
    const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left), iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (ix > 4 && iy > 4 && !fixes[i].contains(fixes[j]) && !fixes[j].contains(fixes[i]))
      chevauchements.push({ a: label(fixes[i]).slice(0, 40) || String(fixes[i].className).slice(0, 30), b: label(fixes[j]).slice(0, 40) || String(fixes[j].className).slice(0, 30), px: Math.round(ix) + '×' + Math.round(iy) });
  }
  return { n: items.length, items, couverts, hors_ecran: hors, flottants: flottants.slice(0, 20), n_flottants: flottants.length, chevauchements };
}"""

# Trouve l'élément interactif VISIBLE dont l'aria-label / le texte / le titre colle le mieux à l'expression.
FIND = r"""([src, flags]) => {
  const rx = new RegExp(src, flags);
  document.querySelectorAll('[data-qa-pp]').forEach(e => e.removeAttribute('data-qa-pp'));
  const sel = 'button, [role=button], [role=menuitem], [role=tab], [role=option], a';
  let best = null, score = -1;
  for (const el of document.querySelectorAll(sel)) {
    if (!el.getClientRects().length) continue;
    const st = getComputedStyle(el); if (st.visibility === 'hidden' || st.display === 'none') continue;
    const al = (el.getAttribute('aria-label') || '').trim(), tx = (el.innerText || '').trim().replace(/\s+/g, ' '), ti = (el.title || '').trim();
    const s = rx.test(al) ? 3 : rx.test(tx) ? 2 : rx.test(ti) ? 1 : 0;
    if (s > score) { score = s; best = el; }
  }
  if (!best || score <= 0) return null;
  best.setAttribute('data-qa-pp', '1');
  const r = best.getBoundingClientRect();
  // Atteignable si son centre est à l'écran (une carte à moitié visible se touche très bien).
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const off = cy > innerHeight - 1 || cx > innerWidth - 1 || cy < 0 || cx < 0;
  const h = off ? null : document.elementFromPoint(cx, cy);
  return { off, couvert: !off && !(h && (best.contains(h) || h.contains(best))), par: h && !(best.contains(h) || h.contains(best)) ? ((h.closest('button,[role=button]') || h).getAttribute('aria-label') || (h.closest('button,[role=button]') || h).innerText || h.className || h.tagName).toString().trim().slice(0, 50) : null,
           t: (al => al)((best.getAttribute('aria-label') || best.innerText || '').trim().slice(0, 50)) };
}"""


class Parcours:
    def __init__(self, page, ch, doigt, nom):
        self.page, self.ch, self.doigt, self.nom = page, ch, doigt, nom
        self.inv = {}

    def find(self, rx, flags="i"):
        return self.page.evaluate(FIND, [rx, flags])

    def geste(self, rx, label, flags="i", scroll_ok=True):
        """Clic (ou toucher) sur l'élément ; s'il est hors de l'écran, défilement compté comme un geste."""
        info = self.find(rx, flags)
        if not info:
            return False
        loc = self.page.locator("[data-qa-pp]").first
        if info["off"]:
            if not scroll_ok:
                return False
            self.ch.friction(f"« {label} » hors de l'écran : il faut faire défiler")
            loc.scroll_into_view_if_needed()
            self.ch.cur["clics"] += 1; self.ch.cur["chemin"].append(f"défiler jusqu'à {label}")
            self.page.wait_for_timeout(200)
            info = self.find(rx, flags); loc = self.page.locator("[data-qa-pp]").first
        if info and info.get("couvert"):
            self.ch.friction(f"« {label} » recouvert par « {info.get('par')} »")
            loc.click(force=True) if not self.doigt else loc.tap(force=True)
            self.ch.cur["clics"] += 1; self.ch.cur["chemin"].append(f"{'doigt' if self.doigt else 'clic'} {label} (forcé)")
            self.page.wait_for_timeout(150)
            return True
        if self.doigt: self.ch.tap(loc, label)
        else: self.ch.click(loc, label)
        return True

    def capture(self, cle, inventaire=True):
        self.page.wait_for_timeout(250)
        self.page.screenshot(path=str(OUT / f"{self.nom}_{cle}.png"))
        if inventaire:
            inv = self.page.evaluate(INVENTAIRE)
            self.inv[cle] = {"elements": inv["n"], "flottants": inv["n_flottants"], "couverts": inv["couverts"][:20],
                             "hors_ecran": inv["hors_ecran"][:12], "chevauchements": inv["chevauchements"][:12], "liste": [i["t"] for i in inv["items"]][:160]}
            return inv

    def dialogue_ouvert(self):
        return self.page.evaluate("""() => [...document.querySelectorAll('[role=dialog], [role=alertdialog], [aria-modal=true]')]
          .filter(d => d.getClientRects().length && getComputedStyle(d).visibility !== 'hidden')
          .map(d => (d.getAttribute('aria-label') || d.querySelector('h1,h2,h3')?.innerText || d.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 70))""")

    def fermer_interpositions(self, contexte):
        """Ferme les fenêtres qui s'interposent dans le parcours (accueil, casque…) en comptant le geste."""
        for _ in range(4):
            dl = self.dialogue_ouvert()
            if not dl: return
            txt = " | ".join(dl)
            if re.search(r"casque ou des écouteurs", txt):
                self.ch.friction(f"{contexte} : question « casque ? » avant la prise")
                if not self.geste(r"^Oui, j'ai un casque", "Oui, j'ai un casque"): return
            elif re.search(r"en 3 gestes|C'est parti", txt):
                self.ch.friction(f"{contexte} : fenêtre d'accueil « 3 gestes » à fermer")
                if not self.geste(r"^(C'est parti|Plus tard)$", "C'est parti"): return
            elif re.search(r"micro", txt, re.I) and self.find(r"^(Activer|Autoriser|Continuer|OK)", "i"):
                self.ch.friction(f"{contexte} : fenêtre d'explication du micro")
                self.geste(r"^(Activer|Autoriser|Continuer|OK)", "Activer le micro")
            else:
                return
            self.page.wait_for_timeout(250)


def run_cas(p, nom, cfg):
    log = Log(f"premier_parcours_{nom}")
    b = launch(p)
    ctx, page = new_page(b, cfg["vp"], log=log)
    page.set_default_timeout(20000)
    page.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{cfg['theme']}'); }} catch (e) {{}}")
    page.add_init_script(MIC_SPY)
    if cfg["compte"]:
        install_compte(page)
    doigt = cfg["vp"].startswith("tel")
    ch = Chrono(nom, page, log, OUT)
    pc = Parcours(page, ch, doigt, nom)
    res = {"cas": nom, **cfg}
    t_debut = time.time()
    try:
        # 1. Ouverture du site -----------------------------------------------------------
        ch.start("Parcours", "Ouvrir le site (accueil prêt, instrus affichées)")
        page.goto(BASE, wait_until="domcontentloaded")
        page.locator("[aria-label^='Poser ma voix sur']").first.wait_for(timeout=60000)
        page.wait_for_timeout(400)
        inv = pc.capture("e1_accueil")
        ch.end(note=f"{inv['n']} éléments interactifs à l'écran")

        # 2. Choisir une instru ------------------------------------------------------------
        ch.start("Parcours", "Choisir une instru (studio prêt, beat chargé)")
        if not pc.geste(r"^Poser ma voix sur", "Poser ma voix sur l'instru"):
            ch.fail("aucune instru à choisir sur l'accueil")
        page.wait_for_timeout(500)
        pc.fermer_interpositions("après le choix de l'instru")
        ch.wait_js("() => !!window.__novaEdit && window.__novaEdit.getState().tracks.some(t => t.id === 'instrumental' && t.clips.length) && !/Chargement\\s*:/.test(document.body.innerText)", 60000, "beat chargé")
        page.wait_for_timeout(300)
        pc.fermer_interpositions("beat chargé")
        page.mouse.move(2, 2) if not doigt else None
        inv = pc.capture("e2_studio")
        ch.end(note=f"{inv['n']} éléments interactifs à l'écran")

        # 3. Première prise ----------------------------------------------------------------
        ch.start("Parcours", f"Première prise ({CHANT_S} s chantées)")
        n_prises0 = app_state(page, "s => s.tracks.reduce((n, t) => n + (t.id === 'instrumental' ? 0 : t.clips.length), 0)") or 0
        if not pc.geste(r"^Enregistrer$", "REC"):
            ch.fail("bouton REC introuvable")
        page.wait_for_timeout(400)
        mic = page.evaluate("() => (window.__ppMic || []).slice()")
        pc.fermer_interpositions("après REC")
        # Le navigateur demande le micro : le clic « Autoriser » est compté (headless l'accorde tout seul).
        mic = page.evaluate("() => (window.__ppMic || []).slice()")
        if mic:
            ch.cur["clics"] += 1; ch.cur["chemin"].append("clic Autoriser (micro, fenêtre du navigateur)")
            expl = (mic[0].get("explication") or "") + " " + (mic[0].get("dialogue") or "")
            ok_expl = bool(re.search(r"micro", expl, re.I) and re.search(r"autoris", expl, re.I))
            res["micro_demande"] = {"explication_a_l_ecran": ok_expl, "texte": expl.strip()[:240]}
            if not ok_expl:
                ch.friction("le navigateur demande le micro sans explication à l'écran")
        ok = ch.wait_js("() => !!window.__novaEdit && window.__novaEdit.getState().isRecording", 20000, "enregistrement lancé")
        pc.fermer_interpositions("pendant la prise")
        t_rec = time.time()
        page.wait_for_timeout(800)
        inv = pc.capture("e3_pendant_prise")
        res["pendant_prise_elements"] = inv["n"]
        page.wait_for_timeout(max(0, CHANT_S * 1000 - int((time.time() - t_rec) * 1000)))
        if not pc.geste(r"^Arrêter l'enregistrement$", "Arrêter"):
            ch.fail("bouton d'arrêt introuvable")
        ch.wait_js(f"() => !window.__novaEdit.getState().isRecording && window.__novaEdit.getState().tracks.reduce((n, t) => n + (t.id === 'instrumental' ? 0 : t.clips.length), 0) > {n_prises0}", 20000, "prise posée")
        ch.end()
        page.wait_for_timeout(2900)   # la carte « Et maintenant ? » arrive ~2,6 s après l'arrêt
        inv = pc.capture("e4_apres_prise")

        # 4. Écouter ----------------------------------------------------------------------
        ch.start("Parcours", "Écouter la prise")
        pc.fermer_interpositions("après la prise")
        if not pc.geste(r"^Lecture$", "Lecture"):
            ch.fail("bouton Lecture introuvable")
        ch.wait_js("() => window.__novaEdit.getState().isPlaying", 8000, "lecture")
        page.wait_for_timeout(1500)
        if not pc.geste(r"^Pause$", "Pause"):
            page.keyboard.press("Space")
        ch.end()

        # 5. Exporter ---------------------------------------------------------------------
        ch.start("Parcours", "Exporter (jusqu'à la fenêtre d'export)")
        if not pc.geste(r"^(Exporter le mix|Exporter|Exporter ma démo)$", "Exporter", scroll_ok=False):
            ch.friction("« Exporter » pas visible : menu ☰")
            if pc.geste(r"^Ouvrir le menu$", "menu ☰"):
                page.wait_for_timeout(300)
                if not pc.geste(r"Exporter", "Exporter (menu)"):
                    ch.fail("Exporter introuvable dans le menu")
            else:
                ch.fail("ni bouton Exporter ni menu")
        ok = ch.wait_js("() => [...document.querySelectorAll('[role=dialog], [aria-modal=true]')].some(d => d.getClientRects().length && /export/i.test(d.innerText))", 10000, "fenêtre d'export")
        page.wait_for_timeout(400)
        inv = pc.capture("e5_export")
        ch.end()
    except Exception as e:  # noqa
        ch.fail(f"arrêt : {type(e).__name__}: {str(e)[:200]}"); ch.end(ok=False)
        res["arret"] = str(e)[:300]
        try: page.screenshot(path=str(OUT / f"{nom}_arret.png"))
        except Exception: pass
    rep = ch.report()
    et = rep["etapes"]
    jusqu_prise = et[:3]
    res.update({
        "etapes": et, "total": rep["total"], "inventaire": pc.inv,
        "jusqu_a_la_prise": {"clics": sum(s["clics"] for s in jusqu_prise), "touches": sum(s["touches"] for s in jusqu_prise),
                             "s": round(sum(s["ms"] for s in jusqu_prise) / 1000, 1),
                             "frictions": [f for s in jusqu_prise for f in s["frictions"]]},
        "duree_reelle_s": round(time.time() - t_debut, 1),
        "erreurs_console": [e["text"][:200] for e in log.errors() if not re.search(r"876[56]|ERR_CONNECTION_REFUSED", e["text"])][:10],
    })
    jp = res["jusqu_a_la_prise"]
    # Temps d'un nouveau venu : temps mesuré (chargements, décompte, chant) + 2 s de lecture / décision par geste.
    jp["s_estime_humain"] = round(jp["s"] + 2 * jp["clics"], 1)
    res["objectif_tenu"] = bool(cfg["mesure"]) and jp["clics"] <= OBJ_CLICS and jp["s_estime_humain"] < OBJ_S and rep["total"]["etapes_ko"] == 0
    ctx.close(); b.close()
    return res


def main():
    out = {}
    with sync_playwright() as p:
        for nom in WANT:
            print(f"== {nom}", flush=True)
            out[nom] = run_cas(p, nom, CAS[nom])
            r = out[nom]
            jp = r["jusqu_a_la_prise"]
            print(f"   jusqu'à la prise : {jp['clics']} clic(s), {jp['s']} s mesurées, ~{jp['s_estime_humain']} s pour un humain"
                  f" ; total {r['total']['clics']} clic(s) ; écrans : " + ", ".join(f"{k}={v['elements']}" for k, v in r["inventaire"].items()), flush=True)
    save_json(OUT / "premier_parcours.json", {"phase": PHASE, "url": BASE, "date": time.strftime("%Y-%m-%d %H:%M"), "cas": out})
    ko = []
    for nom, r in out.items():
        if r["total"]["etapes_ko"]:
            ko.append(f"{nom} : {r['total']['etapes_ko']} étape(s) en échec")
        for k, v in r["inventaire"].items():
            past = [c for c in v["couverts"] if c.get("pastille")]
            if past:
                ko.append(f"{nom} {k} : élément recouvert par une pastille flottante {past[:3]}")
            if v.get("chevauchements"):
                ko.append(f"{nom} {k} : éléments flottants qui se chevauchent {v['chevauchements'][:3]}")
        if CAS[nom]["mesure"] and os.environ.get("QA_OBJECTIF") == "1" and not r["objectif_tenu"]:
            ko.append(f"{nom} : objectif non tenu ({r['jusqu_a_la_prise']})")
    for k in ko: print("KO", k)
    print("FIN premier_parcours :", "OK" if not ko else f"{len(ko)} problème(s)")
    sys.exit(1 if ko else 0)


if __name__ == "__main__":
    main()
