"""Mix et mastering pro (lot L4, 22/10/2026) dans le VRAI studio : EQ Mid/Side + phase linéaire,
rack d'effets parallèles, scènes de mix A/B, mastering d'un EP.

Navigateur headless (aucune fenêtre), QA 100 % hors production (Supabase simulé, qa_hors_prod).

EQ 12 bandes (écart 12) :
  1. ajouté par « Ajouter un effet » sur une piste puis sur le master ; en mode avancé, chaque bande a
     son canal (Stéréo / Centre / Côtés / Gauche / Droite) et la fenêtre a sa section « Phase » ;
  2. sur une piste, « Linéaire » est grisé (réservé au master et aux bus) ; sur le master il s'allume,
     la latence s'affiche (« Latence 43 ms · compensée ») et le moteur l'annonce au PDC ;
  3. une bande passée sur « Côtés » : le projet porte `channel: 'side'`, le moteur passe par le cœur pro,
     l'écran dessine deux courbes (Centre / Côtés) ;
  4. preuves audio par le moteur (renderProject) : bande Côtés → le centre ne bouge pas (< −100 dB) ;
     phase linéaire neutre + PDC = le son sec AU BIT PRÈS ; lecture = export (moteur de
     qa/fidelite_export.py) pour l'EQ en Mid/Side et en phase linéaire, 44,1 et 48 kHz ;
  5. sauvegarde locale (.zip) : project.json porte le canal et la phase ; rien de coupé, pas de débordement.

NOVA_URL=http://127.0.0.1:3522/ python qa/mixpro.py   (MIXPRO_ONLY=eq,rack,... pour une partie)
Sorties : QA_OUT (défaut D:\\1 WORK\\CONTENU\\nova-pro-2026\\qa-mixpro) : mixpro.json + captures.
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import json, os, re, sys, time, zipfile
from pathlib import Path

os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-pro-2026\qa-mixpro")
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass
sys.path.insert(0, os.path.dirname(__file__))
from qalib import APP_MODULE_INIT, CHROME, OUT, launch, new_page, Log  # noqa: E402
from scenarios import open_studio, close_welcome  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = Path(OUT)
OUT.mkdir(parents=True, exist_ok=True)
ONLY = [x for x in os.environ.get("MIXPRO_ONLY", "").split(",") if x]
checks = []
res = {}


# Gestes et contrôles communs (repris de qa/mixfx.py, qui s'exécute à l'import).
def close_plugin(pg):
    pg.keyboard.press("Escape"); pg.wait_for_timeout(500)
    if pg.locator("[data-nova-plugin]").count():
        btn = pg.get_by_role("button", name="Fermer", exact=True)
        for i in range(btn.count() - 1, -1, -1):
            try:
                if btn.nth(i).is_visible():
                    btn.nth(i).click(timeout=3000); pg.wait_for_timeout(500)
                    if not pg.locator("[data-nova-plugin]").count():
                        return
            except Exception:
                pass


def knob(win, pid):
    return win.locator(f"[data-nova-param='{pid}'] [role=slider]").first


def key_knob(pg, win, pid, key):
    k = knob(win, pid)
    k.scroll_into_view_if_needed()
    k.focus(); pg.keyboard.press(key); pg.wait_for_timeout(120)
    return k.get_attribute("aria-valuenow")


def faces_ok(pg, typ):
    """Rien de coupé : chaque bouton rotatif est dans la fenêtre (horizontalement), pas de débordement de page."""
    return pg.evaluate("""(typ) => {
      const w = document.querySelector(`[data-nova-plugin='${typ}']`); if (!w) return { ok: false, why: 'absente' };
      const r = w.getBoundingClientRect();
      const bad = [...w.querySelectorAll('[role=slider], .hw-push, .hw-lcd')].filter(el => { const b = el.getBoundingClientRect(); return b.width > 0 && (b.left < r.left - 1 || b.right > r.right + 1); }).map(el => el.closest('[data-nova-param]')?.getAttribute('data-nova-param') || el.className);
      // Chevauchement de boutons rotatifs (deux boîtes qui se recouvrent de plus de 4 px).
      const ks = [...w.querySelectorAll('.hw-knob-box')].map(el => el.getBoundingClientRect()).filter(b => b.width > 0);
      let over = 0;
      for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) { const a = ks[i], b = ks[j];
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top); if (ox > 4 && oy > 4) over++; }
      const pageOverflow = document.documentElement.scrollWidth > window.innerWidth + 1 || r.right > window.innerWidth + 1 || r.left < -1;
      return { ok: !bad.length && !over && !pageOverflow, coupes: bad.slice(0, 8), chevauchements: over, debordement_page: pageOverflow, largeur: Math.round(r.width) };
    }""", typ)


def shot_window(pg, win, name):
    pg.screenshot(path=str(OUT / f"{name}.png"))
    try:
        win.screenshot(path=str(OUT / f"{name}_fenetre.png"))
    except Exception:
        pass
    # La fenêtre défile au-delà de la hauteur de l'écran : capture du bas aussi.
    pg.evaluate("""() => { const w = document.querySelector('[data-nova-plugin]'); let el = w; while (el && el !== document.body) { if (el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== 'visible') { el.scrollTop = el.scrollHeight; break; } el = el.parentElement; } }""")
    pg.wait_for_timeout(250)
    pg.screenshot(path=str(OUT / f"{name}_bas.png"))
    pg.evaluate("""() => { const w = document.querySelector('[data-nova-plugin]'); let el = w; while (el && el !== document.body) { if (el.scrollTop) el.scrollTop = 0; el = el.parentElement; } }""")


def save_project(pg):
    pg.keyboard.press("Control+s"); pg.wait_for_timeout(900)
    loc = pg.get_by_role("button", name=re.compile("(Export local|cet appareil)", re.I)).first
    with pg.expect_download(timeout=30000) as dl:
        loc.click()
    path = OUT / "mixpro_projet.zip"
    dl.value.save_as(str(path))
    pg.wait_for_timeout(400)
    pg.keyboard.press("Escape")
    return json.loads(zipfile.ZipFile(path).read("project.json"))


def want(part):
    return not ONLY or part in ONLY


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("OK " if cond else "KO ") + name + ("" if cond else f" : {json.dumps(detail, ensure_ascii=False, default=str)[:700]}"), flush=True)


def open_mixer(pg):
    for label in ("Console", "Mixage", "Mixer"):
        t = pg.get_by_role("button", name=re.compile(f"^{label}$", re.I))
        if t.count() and t.first.is_visible():
            t.first.click(); pg.wait_for_timeout(1000); return True
    return False


def add_effect_on(pg, typ, q, track_name=None):
    """« Ajouter un effet » sur une piste (la première, ou celle nommée), recherche q, effet typ."""
    open_mixer(pg)
    sel = f"button[aria-label='Ajouter un effet sur {track_name}']" if track_name else "button[aria-label^='Ajouter un effet sur']"
    add = pg.locator(sel)
    if not add.count():
        return None, f"bouton « Ajouter un effet » introuvable ({track_name or 'première piste'})"
    add.first.scroll_into_view_if_needed(); add.first.click(); pg.wait_for_timeout(600)
    search = pg.locator("input[aria-label='Chercher un effet']")
    if search.count():
        search.first.fill(q); pg.wait_for_timeout(400)
    item = pg.locator(f"[data-testid='add-effect-menu'] [data-fx-id='{typ}']")
    if not item.count():
        pg.keyboard.press("Escape")
        return None, f"« {q} » absent du menu"
    item.first.click(); pg.wait_for_timeout(1500)
    win = pg.locator(f"[data-nova-plugin='{typ}']")
    if not win.count():
        chip = pg.locator(".fx-slot button[aria-label^='Ouvrir']").last
        if chip.count(): chip.click(); pg.wait_for_timeout(1500)
    if not win.count():
        return None, "fenêtre non ouverte"
    win.first.wait_for(timeout=10000)
    pg.wait_for_timeout(600)
    return win.first, add.first.get_attribute("aria-label")


def plugins_of(pg, typ):
    return pg.evaluate("""(typ) => { const st = window.DAW_CONTROL.getState(); const out = [];
      for (const t of st.tracks) for (const p of (t.plugins || [])) if (p.type === typ) out.push({ trackId: t.id, track: t.name, pluginId: p.id, params: p.params, isEnabled: p.isEnabled });
      return out; }""", typ)


ENGINE_NODE = """async (a) => { const { audioEngine: e } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const n = e.getPluginNodeInstance(a.t, a.p); if (!n) return null;
  return { pro: typeof n.isPro === 'function' ? n.isPro() : null, latency_ms: Math.round((n.latency || 0) * 100000) / 100,
           piste_latence_ms: Math.round(e.getTrackLatency(a.t) * 100000) / 100 }; }"""


# ─────────────────────────────── EQ 12 bandes (écart 12) ───────────────────────────────
def eq_bureau(theme="dark"):
    out = {}
    log = Log(f"mixpro_eq_{theme}")
    with sync_playwright() as p:
        b = launch(p)
        ctx, pg = new_page(b, "pc", log)
        pg.add_init_script(APP_MODULE_INIT)
        pg.add_init_script(f"try {{ localStorage.setItem('nova_simple_mode', '0'); localStorage.setItem('nova_theme', '{theme}'); localStorage.setItem('nova_welcome_seen', '1'); }} catch (e) {{}}")
        r = {"name": f"mixpro_eq_{theme}"}
        open_studio(pg, r, vp="pc")
        close_welcome(pg)
        pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
        # 1) Sur une piste
        win, where = add_effect_on(pg, "PROEQ12", "Pro-EQ")
        if not win:
            check(f"[{theme}] EQ : ajout sur une piste", False, where); ctx.close(); b.close(); return out
        out["piste"] = where
        out["canal_present"] = win.locator("[data-nova-param='channel'] [role=radio]").count()
        out["phase_present"] = win.locator("[data-nova-param='phase'] [role=radio]").count()
        lin = win.locator("[data-nova-phase='linear']").first
        out["lineaire_grise_sur_piste"] = lin.is_disabled() if lin.count() else None
        out["texte_latence_piste"] = win.locator("[data-nova-eq-latency]").first.inner_text() if win.locator("[data-nova-eq-latency]").count() else None
        check(f"[{theme}] EQ (piste) : 5 canaux par bande + section Phase, « Linéaire » réservé au master et aux bus",
              out["canal_present"] == 5 and out["phase_present"] == 2 and out["lineaire_grise_sur_piste"] is True, out)
        # Bande 5 : Côtés, +9 dB
        win.locator(".hw-band").nth(4).click(); pg.wait_for_timeout(200)
        win.locator("[data-nova-channel='side']").first.click(); pg.wait_for_timeout(300)
        for _ in range(6):
            key_knob(pg, win, "gain", "PageUp")
        pg.wait_for_timeout(600)
        st = [x for x in plugins_of(pg, "PROEQ12") if x["track"] and x["trackId"] != "master"]
        band = (st[0]["params"]["bands"][4] if st else {}) or {}
        out["bande5_projet"] = {k: band.get(k) for k in ("channel", "gain", "frequency")}
        node = pg.evaluate(ENGINE_NODE, {"t": st[0]["trackId"], "p": st[0]["pluginId"]}) if st else None
        out["moteur"] = node
        check(f"[{theme}] EQ : bande 5 sur « Côtés » (+{band.get('gain')} dB) dans le projet, moteur sur le cœur Mid/Side, latence 0",
              band.get("channel") == "side" and (band.get("gain") or 0) > 3 and node and node.get("pro") is True and node.get("latency_ms") == 0, out)
        shot_window(pg, win, f"eq_{theme}_piste_cotes")
        lay = faces_ok(pg, "PROEQ12")
        out["mise_en_page_piste"] = lay
        check(f"[{theme}] EQ (piste) : rien de coupé ni de chevauché, pas de débordement", lay.get("ok"), lay)
        close_plugin(pg)
        # 2) Sur le master : phase linéaire
        win, where = add_effect_on(pg, "PROEQ12", "Pro-EQ", "MASTER BUS")
        if not win:
            check(f"[{theme}] EQ : ajout sur le master", False, where)
        else:
            lin = win.locator("[data-nova-phase='linear']").first
            out["lineaire_actif_master"] = not lin.is_disabled()
            lin.click(); pg.wait_for_timeout(900)
            m = [x for x in plugins_of(pg, "PROEQ12") if x["trackId"] == "master"]
            out["master_projet"] = {"phase": m[0]["params"].get("phase") if m else None}
            node = pg.evaluate(ENGINE_NODE, {"t": "master", "p": m[0]["pluginId"]}) if m else None
            out["master_moteur"] = node
            out["texte_latence_master"] = win.locator("[data-nova-eq-latency]").first.inner_text()
            check(f"[{theme}] EQ (master) : « Linéaire » choisi → projet phase=linear, latence annoncée au PDC (≈ 43 ms), affichée",
                  out["lineaire_actif_master"] and out["master_projet"]["phase"] == "linear" and node and 40 <= (node.get("latency_ms") or 0) <= 47
                  and (node.get("piste_latence_ms") or 0) >= 40 and "Latence" in out["texte_latence_master"], out)
            win.locator("[data-nova-linq='haute']").first.click(); pg.wait_for_timeout(700)
            node2 = pg.evaluate(ENGINE_NODE, {"t": "master", "p": m[0]["pluginId"]}) if m else None
            out["master_haute"] = node2
            check(f"[{theme}] EQ (master) : haute résolution → latence ≈ 171 ms annoncée", node2 and 160 <= (node2.get("latency_ms") or 0) <= 190, node2)
            win.locator("[data-nova-linq='normale']").first.click(); pg.wait_for_timeout(400)
            shot_window(pg, win, f"eq_{theme}_master_lineaire")
            lay = faces_ok(pg, "PROEQ12")
            check(f"[{theme}] EQ (master) : rien de coupé, pas de débordement", lay.get("ok"), lay)
            close_plugin(pg)
        if theme == "dark":
            proj = save_project(pg)
            eqs = [(t.get("id"), pl.get("params", {})) for t in proj.get("tracks", []) for pl in (t.get("plugins") or []) if pl.get("type") == "PROEQ12"]
            out["sauvegarde"] = [{"piste": tid, "phase": pp.get("phase"), "canaux": [bb.get("channel") for bb in pp.get("bands", []) if bb.get("channel")]} for tid, pp in eqs]
            check("EQ : sauvegarde (.zip) → project.json porte le canal « side » et la phase linéaire du master",
                  any("side" in x["canaux"] for x in out["sauvegarde"]) and any(x["phase"] == "linear" for x in out["sauvegarde"]), out["sauvegarde"])
        out["erreurs_page"] = [x["text"][:200] for x in log.errors()][:6]
        check(f"[{theme}] EQ : aucune erreur de page liée à l'égaliseur", not [x for x in log.errors() if re.search(r"eqpro|EqPro|ProEQ", x["text"])], out["erreurs_page"])
        ctx.close(); b.close()
    return out


EQ_AUDIO = r"""
async () => {
  const M = p => window.__novaAppModule(p);
  const { audioEngine: e } = await M('/engine/AudioEngine.ts'); const { TrackType } = await M('/types.ts');
  const { builtinPlugin } = await M('/utils/sessionTemplate.ts');
  await e.init(); const SR = e.ctx.sampleRate; const n = Math.round(1.0 * SR);
  const buf = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: SR });
  let s = 5; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5; };
  for (let c = 0; c < 2; c++) { const x = buf.getChannelData(c); for (let i = 0; i < n; i++) x[i] = 0.3 * rnd(); }
  const eq = (over, patch) => { const p = builtinPlugin('PROEQ12', {}, 'eq'); Object.assign(p.params, over);
    for (const [i, b] of Object.entries(patch || {})) p.params.bands[i] = { ...p.params.bands[i], ...b }; return p; };
  const tr = (plugins) => [{ id: 'v', name: 'v', type: TrackType.AUDIO, volume: 1, pan: 0, isMuted: false, isSolo: false, sends: [], automationLanes: [], outputTrackId: 'master', plugins,
     clips: [{ id: 'c', type: TrackType.AUDIO, start: 0.1, duration: buf.duration, offset: 0, buffer: buf, gain: 1, name: 'c', fadeIn: 0, fadeOut: 0, color: '#fff' }] }];
  const r = async (pl) => await e.renderProject(tr(pl), 1.4, 0, SR);
  const dry = await r([]);
  const L = (b) => b.getChannelData(0), R = (b) => b.getChannelData(1);
  const worst = (a, b, f) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(f(i))); return m; };
  const dB = (x) => x > 0 ? +(20 * Math.log10(x)).toFixed(1) : -999;
  const off = { 0: { isEnabled: false }, 11: { isEnabled: false } };
  const side = await r([eq({}, { ...off, 6: { gain: 9, frequency: 4000, channel: 'side' } })]);
  const sideLin = await r([eq({ phase: 'linear' }, { ...off, 6: { gain: 9, frequency: 4000, channel: 'side' } })]);
  const linNeutral = await r([eq({ phase: 'linear' }, off)]);
  const linHaute = await r([eq({ phase: 'linear', linQuality: 'haute' }, off)]);
  const mid = (b, i) => (L(b)[i] + R(b)[i]) / 2, sd = (b, i) => (L(b)[i] - R(b)[i]) / 2;
  return {
    cotes_ecart_centre_db: dB(worst(side, dry, i => mid(side, i) - mid(dry, i))),
    cotes_ecart_cotes_db: dB(worst(side, dry, i => sd(side, i) - sd(dry, i))),
    cotes_lineaire_ecart_centre_db: dB(worst(sideLin, dry, i => mid(sideLin, i) - mid(dry, i))),
    lineaire_neutre_ecart_max: Math.max(worst(linNeutral, dry, i => L(linNeutral)[i] - L(dry)[i]), worst(linNeutral, dry, i => R(linNeutral)[i] - R(dry)[i])),
    lineaire_haute_neutre_ecart_max: Math.max(worst(linHaute, dry, i => L(linHaute)[i] - L(dry)[i]), worst(linHaute, dry, i => R(linHaute)[i] - R(dry)[i])),
  };
}
"""


def eq_audio():
    """Preuves par le moteur + lecture = export (moteur de qa/fidelite_export.py)."""
    from fidelite_export import JS as FJS, SEUIL
    out = {}
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, executable_path=CHROME, args=["--autoplay-policy=no-user-gesture-required"])
        pg = b.new_page()
        errs = []
        pg.on("pageerror", lambda x: errs.append(str(x)[:300]))
        pg.add_init_script(APP_MODULE_INIT)
        pg.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
        pg.goto(os.environ.get("NOVA_URL", "http://127.0.0.1:3522/"), wait_until="domcontentloaded", timeout=120000)
        pg.wait_for_timeout(4000)
        pg.set_default_timeout(900000)
        a = pg.evaluate(EQ_AUDIO)
        out["moteur"] = a
        check("EQ (export) : bande sur les Côtés → le centre ne bouge pas (< −100 dB), les côtés changent",
              a["cotes_ecart_centre_db"] < -100 and a["cotes_ecart_cotes_db"] > -30, a)
        check("EQ (export) : même chose en phase linéaire (centre < −100 dB, PDC compris)", a["cotes_lineaire_ecart_centre_db"] < -100, a)
        check("EQ (export) : phase linéaire neutre + PDC = son sec AU BIT PRÈS (normale et haute)",
              a["lineaire_neutre_ecart_max"] == 0 and a["lineaire_haute_neutre_ecart_max"] == 0, a)
        bands = [{"id": i, "type": "highpass" if i == 0 else "lowpass" if i == 11 else "peaking", "frequency": f, "gain": 0, "q": 1, "isEnabled": True, "isSolo": False}
                 for i, f in enumerate([80, 150, 300, 500, 1000, 2000, 4000, 6000, 8000, 10000, 12000, 18000])]
        ms = [dict(x) for x in bands]; ms[3].update(gain=4, frequency=1800, q=1.2, channel="mid"); ms[9].update(gain=-3, frequency=9000, q=0.8, channel="side")
        lin = [dict(x) for x in bands]; lin[3].update(gain=4, frequency=1800, q=1.2); lin[9].update(gain=-3, frequency=9000, q=0.8, channel="side")
        cfgs = {"EQ_MS": {"bands": ms}, "EQ_LINEAIRE": {"bands": lin, "phase": "linear"}}
        for rate in (44100, 48000):
            for name, over in cfgs.items():
                rr = pg.evaluate(FJS, {"rate": rate, "cfg": {"kind": "seul", "type": "PROEQ12", "over": over}})
                worst = max((rr.get(k) or {}).get("ecart_max_lsb16", 99) for k in ("depuis_0", "depuis_milieu"))
                out[f"{name}_{rate}"] = {"pire_lsb16": worst, "depuis_0": (rr.get("depuis_0") or {}).get("ecart_max_lsb16"),
                                         "depuis_milieu": (rr.get("depuis_milieu") or {}).get("ecart_max_lsb16")}
                check(f"Lecture = export {name} à {rate} Hz : écart ≤ {SEUIL} LSB 16 bits", worst <= SEUIL, out[f"{name}_{rate}"])
        out["erreurs_page"] = errs[:5]
        check("EQ (moteur) : aucune erreur de page", not errs, errs[:5])
        b.close()
    return out


# ─────────────────────────────── Rack parallèle (écart 13) ───────────────────────────────
def rack_bureau(theme="dark"):
    out = {}
    log = Log(f"mixpro_rack_{theme}")
    with sync_playwright() as p:
        b = launch(p)
        ctx, pg = new_page(b, "pc", log)
        pg.add_init_script(APP_MODULE_INIT)
        pg.add_init_script(f"try {{ localStorage.setItem('nova_simple_mode', '0'); localStorage.setItem('nova_theme', '{theme}'); localStorage.setItem('nova_welcome_seen', '1'); }} catch (e) {{}}")
        r = {"name": f"mixpro_rack_{theme}"}
        open_studio(pg, r, vp="pc")
        close_welcome(pg)
        pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
        win, where = add_effect_on(pg, "FXRACK", "rack")
        if not win:
            check(f"[{theme}] Rack : ajout par « Ajouter un effet » (recherche « rack »)", False, where); ctx.close(); b.close(); return out
        out["piste"] = where
        out["titre"] = win.locator("h2").first.inner_text()
        out["branches"] = win.locator("[data-nova-rack-branch]").count()
        check(f"[{theme}] Rack : ajouté (« {out['titre']} »), 2 branches vides par défaut", "rack" in out["titre"].lower() and out["branches"] == 2, out)
        # Compresseur dans la branche 2 : la fenêtre de l'effet s'ouvre sous la façade.
        win.locator("[data-nova-rack-add-fx='2']").click(); pg.wait_for_timeout(300)
        win.locator(".hw-rack-menu [data-fx-id='COMPRESSOR']").click(); pg.wait_for_timeout(1200)
        child = win.locator("[data-nova-rack-child='COMPRESSOR']")
        out["fenetre_effet"] = child.count()
        st = plugins_of(pg, "FXRACK")
        rp = st[0]["params"] if st else {}
        out["branche2"] = [x.get("type") for x in (rp.get("branches") or [{}, {}])[1].get("plugins", [])] if rp else None
        check(f"[{theme}] Rack : « + Effet » dans la branche 2 → Compresseur dans le projet, sa fenêtre s'ouvre dans le rack",
              out["fenetre_effet"] == 1 and out["branche2"] == ["COMPRESSOR"], out)
        if child.count():
            sl = child.locator("[role=slider]").first
            before = sl.get_attribute("aria-valuenow")
            sl.focus(); pg.keyboard.press("End"); pg.wait_for_timeout(400)
            after = sl.get_attribute("aria-valuenow")
            st = plugins_of(pg, "FXRACK")
            cparams = st[0]["params"]["branches"][1]["plugins"][0]["params"] if st else {}
            out["bouton_effet"] = [before, after]
            check(f"[{theme}] Rack : un bouton de l'effet de la branche tourne et le réglage arrive dans le projet",
                  before != after and bool(cparams), {"bouton": out["bouton_effet"], "reglages": {k: cparams.get(k) for k in list(cparams)[:6]}})
        shot_window(pg, win, f"rack_{theme}_compresseur_branche2")
        lay = faces_ok(pg, "FXRACK")
        out["mise_en_page"] = lay
        check(f"[{theme}] Rack : rien de coupé ni de chevauché, pas de débordement", lay.get("ok"), lay)
        node = pg.evaluate(ENGINE_NODE, {"t": st[0]["trackId"], "p": st[0]["pluginId"]}) if st else None
        out["moteur"] = node
        check(f"[{theme}] Rack : le moteur a créé le rack (latence 0 avec un compresseur)", node is not None and node.get("latency_ms") == 0, node)
        if theme == "dark":
            # Mélange, branche ajoutée, division en bandes puis centre / côtés.
            key_knob(pg, win, "mix", "Home")
            win.locator("[data-nova-rack-add-branch]").click(); pg.wait_for_timeout(500)
            n3 = win.locator("[data-nova-rack-branch]").count()
            st = plugins_of(pg, "FXRACK")
            out["mix_et_branches"] = {"mix": st[0]["params"].get("mix"), "branches_ecran": n3, "branches_projet": len(st[0]["params"].get("branches") or [])}
            check("Rack : mélange à 0 % et 3e branche dans le projet", out["mix_et_branches"] == {"mix": 0, "branches_ecran": 3, "branches_projet": 3}, out["mix_et_branches"])
            key_knob(pg, win, "mix", "End")
            win.locator("[data-nova-rack-mode='bandes']").click(); pg.wait_for_timeout(600)
            labels = [x.strip() for x in win.locator("[data-nova-rack-label]").all_inner_texts()]
            out["bandes"] = {"noms": labels, "coupures": win.locator("[data-nova-param='x1'], [data-nova-param='x2']").count()}
            shot_window(pg, win, f"rack_{theme}_bandes")
            check("Rack : division en 3 bandes (Grave / Médium / Aigu, 2 coupures)", labels[:3] == ["Grave", "Médium", "Aigu"] and out["bandes"]["coupures"] == 2, out["bandes"])
            win.locator("[data-nova-rack-mode='ms']").click(); pg.wait_for_timeout(600)
            labels = [x.strip() for x in win.locator("[data-nova-rack-label]").all_inner_texts()]
            out["ms"] = labels
            shot_window(pg, win, f"rack_{theme}_centre_cotes")
            lay = faces_ok(pg, "FXRACK")
            check("Rack : division centre / côtés (2 branches), rien de coupé", labels[:2] == ["Centre", "Côtés"] and win.locator("[data-nova-rack-branch]").count() == 2 and lay.get("ok"), {"noms": labels, "mise_en_page": lay})
            close_plugin(pg)
            proj = save_project(pg)
            racks = [pl.get("params", {}) for t in proj.get("tracks", []) for pl in (t.get("plugins") or []) if pl.get("type") == "FXRACK"]
            out["sauvegarde"] = [{"mode": x.get("mode"), "branches": [[y.get("type") for y in bb.get("plugins", [])] for bb in x.get("branches", [])]} for x in racks]
            check("Rack : sauvegarde (.zip) → project.json porte la division et le Compresseur de la branche 2",
                  any(x["mode"] == "ms" and any("COMPRESSOR" in bb for bb in x["branches"]) for x in out["sauvegarde"]), out["sauvegarde"])
        else:
            close_plugin(pg)
        out["erreurs_page"] = [x["text"][:200] for x in log.errors()][:6]
        check(f"[{theme}] Rack : aucune erreur de page liée au rack", not [x for x in log.errors() if re.search(r"rack|Rack", x["text"])], out["erreurs_page"])
        ctx.close(); b.close()
    return out


RACK_AUDIO = r"""
async () => {
  const M = p => window.__novaAppModule(p);
  const { audioEngine: e } = await M('/engine/AudioEngine.ts'); const { TrackType } = await M('/types.ts');
  const { builtinPlugin } = await M('/utils/sessionTemplate.ts');
  const R = await M('/engine/fxRack.ts');
  await e.init(); const SR = e.ctx.sampleRate; const n = Math.round(1.0 * SR);
  const buf = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: SR });
  let s = 11; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5; };
  for (let c = 0; c < 2; c++) { const x = buf.getChannelData(c); for (let i = 0; i < n; i++) x[i] = 0.3 * rnd(); }
  const rack = (p) => ({ id: 'rk', name: 'Rack', type: 'FXRACK', isEnabled: true, latency: 0, params: p });
  const tr = (plugins, b = buf) => [{ id: 'v', name: 'v', type: TrackType.AUDIO, volume: 1, pan: 0, isMuted: false, isSolo: false, sends: [], automationLanes: [], outputTrackId: 'master', plugins,
     clips: [{ id: 'c', type: TrackType.AUDIO, start: 0.1, duration: b.duration, offset: 0, buffer: b, gain: 1, name: 'c', fadeIn: 0, fadeOut: 0, color: '#fff' }] }];
  const r = async (pl, b) => await e.renderProject(tr(pl, b), 1.3, 0, SR);
  const dry = await r([]);
  const worst = (a, b, k = 1) => { let m = 0; for (let c = 0; c < 2; c++) { const x = a.getChannelData(c), y = b.getChannelData(c); for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - k * y[i])); } return m; };
  const out = {};
  out.defauts_ecart = worst(await r([rack(R.rackDefaults())]), dry);
  const two = R.rackDefaults(); two.branches.forEach(b => { b.level = 0; });
  out.deux_branches_0db_ecart_x2 = worst(await r([rack(two)]), dry, 2);
  const eqLin = builtinPlugin('PROEQ12', { phase: 'linear' }, 'eq-lin'); eqLin.params.bands[0].isEnabled = false; eqLin.params.bands[11].isEnabled = false;
  const lat = R.rackDefaults(); lat.branches[1].plugins = [eqLin]; lat.mix = 70;
  out.latence_realignee_ecart = worst(await r([rack(lat)]), dry);
  // 3 bandes : sinus à 60 Hz, 200 Hz, 1 kHz, 3 kHz, 12 kHz — niveau rendu / niveau sec.
  const bands = R.withMode(R.rackDefaults(), 'bandes', 3);
  out.bandes_db = {};
  for (const f of [60, 200, 1000, 3000, 12000]) {
    const sb = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: SR });
    for (let c = 0; c < 2; c++) { const x = sb.getChannelData(c); for (let i = 0; i < n; i++) x[i] = 0.25 * Math.sin(2 * Math.PI * f * i / SR); }
    const a = (await r([rack(bands)], sb)).getChannelData(0), d = (await r([], sb)).getChannelData(0);
    let ea = 0, ed = 0; for (let i = Math.round(0.4 * SR); i < Math.round(1.0 * SR); i++) { ea += a[i] * a[i]; ed += d[i] * d[i]; }
    out.bandes_db[f] = +(10 * Math.log10(ea / ed)).toFixed(3);
  }
  return out;
}
"""


def rack_audio():
    from fidelite_export import JS as FJS, SEUIL
    out = {}
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, executable_path=CHROME, args=["--autoplay-policy=no-user-gesture-required"])
        pg = b.new_page()
        errs = []
        pg.on("pageerror", lambda x: errs.append(str(x)[:300]))
        pg.add_init_script(APP_MODULE_INIT)
        pg.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
        pg.goto(os.environ.get("NOVA_URL", "http://127.0.0.1:3522/"), wait_until="domcontentloaded", timeout=120000)
        pg.wait_for_timeout(4000)
        pg.set_default_timeout(900000)
        a = pg.evaluate(RACK_AUDIO)
        out["moteur"] = a
        check("Rack (export) : réglages par défaut (2 branches vides à −6 dB) = son sec AU BIT PRÈS", a["defauts_ecart"] == 0, a)
        check("Rack (export) : 2 branches vides à 0 dB = +6,02 dB exact (×2)", a["deux_branches_0db_ecart_x2"] == 0, a)
        check("Rack (export) : branche avec un EQ à phase linéaire (43 ms) → branches et son sec réalignés, PDC : son sec (< −90 dB)",
              a["latence_realignee_ecart"] < 3.2e-5, a)
        check("Rack (export) : 3 bandes vides → la somme se reconstruit à ±0,1 dB (60 Hz – 12 kHz)", all(abs(v) <= 0.1 for v in a["bandes_db"].values()), a["bandes_db"])
        comp = {"id": "rk-comp", "name": "Compresseur", "type": "COMPRESSOR", "isEnabled": True, "latency": 0,
                "params": {"threshold": -24, "ratio": 4, "knee": 6, "attack": 0.005, "release": 0.1, "makeupGain": 1.4, "isEnabled": True}}
        over = {"branches": [{"id": "rb-1", "level": -6.020599913279624, "plugins": []}, {"id": "rb-2", "level": -3, "plugins": [comp]}], "mix": 80}
        for rate in (44100, 48000):
            rr = pg.evaluate(FJS, {"rate": rate, "cfg": {"kind": "seul", "type": "FXRACK", "over": over}})
            worst = max((rr.get(k) or {}).get("ecart_max_lsb16", 99) for k in ("depuis_0", "depuis_milieu"))
            out[f"FXRACK_{rate}"] = {"pire_lsb16": worst, "depuis_0": (rr.get("depuis_0") or {}).get("ecart_max_lsb16"), "depuis_milieu": (rr.get("depuis_milieu") or {}).get("ecart_max_lsb16")}
            check(f"Lecture = export rack (compression parallèle) à {rate} Hz : écart ≤ {SEUIL} LSB 16 bits", worst <= SEUIL, out[f"FXRACK_{rate}"])
        out["erreurs_page"] = errs[:5]
        check("Rack (moteur) : aucune erreur de page", not errs, errs[:5])
        b.close()
    return out


# ─────────────────────────────── Scènes de mix (écart 20) ───────────────────────────────
STATE_MIX = """() => { const st = window.DAW_CONTROL.getState();
  return { tracks: st.tracks.map(t => ({ id: t.id, volume: t.volume, pan: t.pan, isMuted: !!t.isMuted, sends: (t.sends || []).map(s => [s.id, s.level, !!s.isEnabled]), plugins: (t.plugins || []).map(p => [p.id, !!p.isEnabled, JSON.stringify(p.params)]) })),
           scenes: (st.mixScenes || []).map(s => ({ slot: s.slot, deleted: !!s.deleted, n: Object.keys(s.tracks || {}).length })) }; }"""

RENDER_SIG = """async () => { const { audioEngine: e } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const st = window.DAW_CONTROL.getState(); const b = await e.renderProject(st.tracks, 6, 4);
  let h = 0, energy = 0; for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i += 1) { const v = Math.round(d[i] * 1e9); h = (h * 31 + v) | 0; energy += d[i] * d[i]; } }
  return { h, energy: +energy.toFixed(6) }; }"""

MOVE_MIX = """() => { const c = window.DAW_CONTROL; const st = c.getState();
  const ts = st.tracks.filter(t => t.type === 'AUDIO' || t.id === 'master').slice(0, 3);
  ts.forEach((t, i) => c.updateTrack({ ...t, volume: Math.max(0.05, t.volume * (0.4 + 0.2 * i)), pan: i === 0 ? -0.6 : 0.5, isMuted: i === 1 ? !t.isMuted : t.isMuted,
    plugins: (t.plugins || []).map(p => ({ ...p, isEnabled: !p.isEnabled })) }));
  return ts.map(t => t.id); }"""


def scenes_bureau(theme="dark"):
    out = {}
    log = Log(f"mixpro_scenes_{theme}")
    with sync_playwright() as p:
        b = launch(p)
        ctx, pg = new_page(b, "pc", log)
        pg.add_init_script(APP_MODULE_INIT)
        pg.add_init_script(f"try {{ localStorage.setItem('nova_simple_mode', '0'); localStorage.setItem('nova_theme', '{theme}'); localStorage.setItem('nova_welcome_seen', '1'); localStorage.removeItem('nova_scene_parts'); }} catch (e) {{}}")
        r = {"name": f"mixpro_scenes_{theme}"}
        open_studio(pg, r, vp="pc")
        close_welcome(pg)
        pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
        open_mixer(pg)
        panel = pg.locator("[data-nova-scenes]")
        out["panneau"] = panel.count()
        check(f"[{theme}] Scènes : panneau A / B / C / D dans la console", panel.count() == 1 and pg.locator("[data-nova-scene]").count() == 4, out)
        if not panel.count():
            ctx.close(); b.close(); return out
        panel.scroll_into_view_if_needed()
        # Sur la piste du beat : un effet, pour que la scène porte aussi des réglages d'effet.
        if theme == "dark":
            win, _ = add_effect_on(pg, "PROEQ12", "Pro-EQ")
            if win:
                win.locator(".hw-band").nth(4).click(); key_knob(pg, win, "gain", "PageUp"); close_plugin(pg)
            open_mixer(pg)
        base = pg.evaluate(STATE_MIX)
        sig0 = pg.evaluate(RENDER_SIG) if theme == "dark" else None
        pg.locator("[data-nova-scene='A']").click(); pg.wait_for_timeout(500)
        s1 = pg.evaluate(STATE_MIX)
        out["apres_A"] = s1["scenes"]
        st_a = pg.locator("[data-nova-scene='A']").get_attribute("data-state")
        check(f"[{theme}] Scènes : clic sur A vide → console enregistrée (scène A dans le projet, allumée)",
              any(x["slot"] == "A" and not x["deleted"] and x["n"] >= 2 for x in s1["scenes"]) and st_a == "active", {"scenes": s1["scenes"], "etat_A": st_a})
        moved_ids = pg.evaluate(MOVE_MIX); pg.wait_for_timeout(700)
        pg.locator("[data-nova-scene='B']").click(); pg.wait_for_timeout(500)
        moved = pg.evaluate(STATE_MIX)
        out["pistes_bougees"] = moved_ids
        check(f"[{theme}] Scènes : console bougée puis enregistrée en B (B allumée, A éteinte)",
              moved["tracks"] != base["tracks"] and pg.locator("[data-nova-scene='B']").get_attribute("data-state") == "active"
              and pg.locator("[data-nova-scene='A']").get_attribute("data-state") == "pleine", {"bougees": moved_ids})
        shot_window(pg, panel, f"scenes_{theme}_ab")
        # Rappel de A : la console revient exactement, en une étape d'annulation.
        pg.locator("[data-nova-scene='A']").click(); pg.wait_for_timeout(900)
        back = pg.evaluate(STATE_MIX)
        check(f"[{theme}] Scènes : rappel de A → volumes, pans, muets et effets EXACTEMENT ceux de A", back["tracks"] == base["tracks"],
              {"ecarts": [t["id"] for t, u in zip(back["tracks"], base["tracks"]) if t != u]})
        if theme == "dark":
            sig1 = pg.evaluate(RENDER_SIG)
            out["rendu"] = {"avant": sig0, "apres_rappel": sig1}
            check("Scènes : export après le rappel de A identique au bit près à l'export d'origine", sig0 == sig1 and sig0["energy"] > 0, out["rendu"])
            pg.evaluate("() => window.DAW_CONTROL.undo()"); pg.wait_for_timeout(700)
            und = pg.evaluate(STATE_MIX)
            check("Scènes : un seul Ctrl+Z annule le rappel (console de B)", und["tracks"] == moved["tracks"], {"egal_B": und["tracks"] == moved["tracks"]})
            pg.evaluate("() => window.DAW_CONTROL.redo()"); pg.wait_for_timeout(500)
            # Comparaison A ⇄ B
            pg.locator("[data-nova-scene-compare]").click(); pg.wait_for_timeout(700)
            cmp1 = pg.evaluate(STATE_MIX)
            pg.locator("[data-nova-scene-compare]").click(); pg.wait_for_timeout(700)
            cmp2 = pg.evaluate(STATE_MIX)
            check("Scènes : « A⇄B » passe de A à B puis revient à A", cmp1["tracks"] == moved["tracks"] and cmp2["tracks"] == base["tracks"], {})
            # Rappel partiel : seulement les volumes.
            pg.locator("[data-nova-scenes-menu]").click(); pg.wait_for_timeout(300)
            menu = pg.locator("[data-testid='scenes-menu']")
            for part in ("pans", "mutes", "sends", "plugins"):
                menu.locator(f"[data-nova-scene-part='{part}']").uncheck()
            shot_window(pg, menu, f"scenes_{theme}_menu")
            menu.get_by_role("button", name="Fermer").click(); pg.wait_for_timeout(200)
            pg.locator("[data-nova-scene='B']").click(); pg.wait_for_timeout(700)
            part = pg.evaluate(STATE_MIX)
            vol_ok = [t["volume"] for t in part["tracks"]] == [t["volume"] for t in moved["tracks"]]
            rest_ok = [(t["pan"], t["isMuted"], t["plugins"]) for t in part["tracks"]] == [(t["pan"], t["isMuted"], t["plugins"]) for t in base["tracks"]]
            check("Scènes : rappel partiel « Volumes » seulement → volumes de B, pans / muets / effets de A gardés", vol_ok and rest_ok, {"volumes": vol_ok, "reste": rest_ok})
            proj = save_project(pg)
            out["sauvegarde"] = [(s.get("slot"), len(s.get("tracks") or {})) for s in (proj.get("mixScenes") or [])]
            check("Scènes : sauvegarde (.zip) → project.json porte les scènes A et B", [x[0] for x in out["sauvegarde"]] == ["A", "B"], out["sauvegarde"])
        out["erreurs_page"] = [x["text"][:200] for x in log.errors()][:6]
        check(f"[{theme}] Scènes : aucune erreur de page", not [x for x in log.errors() if re.search(r"scene|Scène|mixSnapshots", x["text"], re.I)], out["erreurs_page"])
        ctx.close(); b.close()
    return out


# ─────────────────────────────── Mastering d'un EP / album (écart 22) ───────────────────────────────
ALBUM_DIR = OUT / "album_titres"


def make_titles():
    """6 titres d'essai (12 s, « même caractère » : rap, niveaux de départ très différents), un à 44,1 kHz."""
    import math, random, struct, wave
    ALBUM_DIR.mkdir(parents=True, exist_ok=True)
    amps = [0.05, 0.12, 0.3, 0.08, 0.2, 0.4]
    paths = []
    for i, a in enumerate(amps):
        sr = 44100 if i == 3 else 48000
        n = 12 * sr
        rnd = random.Random(10 + i)
        f = 55 + 10 * i
        frames = bytearray()
        for k in range(n):
            t = k / sr
            beat = math.exp(-((t * 2) % 1) * 9)                       # kick 2 fois par seconde
            v = a * (0.7 * beat * math.sin(2 * math.pi * f * t) + 0.25 * math.sin(2 * math.pi * 4 * f * t) * (0.6 + 0.4 * math.sin(2 * math.pi * 3 * t)) + 0.08 * (rnd.random() - 0.5))
            w = a * (0.7 * beat * math.sin(2 * math.pi * f * t + 0.2) + 0.25 * math.sin(2 * math.pi * 5 * f * t) * (0.6 + 0.4 * math.sin(2 * math.pi * 2 * t)) + 0.08 * (rnd.random() - 0.5))
            v = v if abs(v) > 1e-4 else 1e-3
            w = w if abs(w) > 1e-4 else 1e-3
            frames += struct.pack("<hh", int(max(-1, min(1, v)) * 32767), int(max(-1, min(1, w)) * 32767))
        p = ALBUM_DIR / f"{i + 1:02d}_Titre {i + 1}.wav"
        with wave.open(str(p), "wb") as wf:
            wf.setnchannels(2); wf.setsampwidth(2); wf.setframerate(sr); wf.writeframes(bytes(frames))
        paths.append(str(p))
    return paths


def wav_info(data):
    import io, wave
    with wave.open(io.BytesIO(data), "rb") as wf:
        return {"sr": wf.getframerate(), "bits": wf.getsampwidth() * 8, "ch": wf.getnchannels(), "frames": wf.getnframes(), "raw": wf.readframes(wf.getnframes())}


def trailing_zero_frames(info):
    raw, step, n = info["raw"], info["ch"] * info["bits"] // 8, 0
    for k in range(info["frames"] - 1, -1, -1):
        if any(raw[k * step:(k + 1) * step]):
            break
        n += 1
    return n


def album_page(vp="pc", theme="dark"):
    from desktop_gate import install_mocks
    from tarifs import Billing as TarifsBilling, route_billing

    class Billing(TarifsBilling):
        def access(self, body):
            return {"grille": "2026-10-14", "missing": [], "items": [], "login_required": False, "kits": False, "offers": None,
                    "pro": None, "unlocked": True, "via": "admin", "reason": None}

        def reply(self, body):
            st, payload = super().reply(body)
            return (st, {**payload, "admin": True}) if body.get("action") == "status" else (st, payload)

    out = {}
    files = make_titles()
    log = Log(f"mixpro_album_{vp}_{theme}")
    with sync_playwright() as p:
        b = launch(p)
        ctx, pg = new_page(b, vp, log)
        pg.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); localStorage.setItem('nova_welcome_seen', '1'); }} catch (e) {{}}")
        install_mocks(pg, "romain", {}, {})
        route_billing(pg, Billing("admin"))
        pg.set_default_timeout(60000)
        pg.goto(os.environ.get("NOVA_URL", "http://127.0.0.1:3522/") + "?album", wait_until="domcontentloaded", timeout=120000)
        root = pg.locator("[data-nova-album]")
        root.wait_for(timeout=60000)
        pg.wait_for_timeout(800)
        tag = f"[{vp}/{theme}] Album"
        pg.screenshot(path=str(OUT / f"album_{vp}_{theme}_vide.png"))
        pg.locator("[data-album-input]").set_input_files(files)
        pg.wait_for_function("() => document.querySelectorAll('[data-album-title]').length === 6", timeout=120000)
        pg.wait_for_timeout(500)
        out["titres"] = pg.locator("[data-album-title]").count()
        check(f"{tag} : 6 titres déposés en une fois (dont un à 44,1 kHz), dans l'ordre des fichiers", out["titres"] == 6,
              [pg.locator(f"[data-album-name='{i}']").input_value() for i in range(1, 7)])
        if vp != "pc":
            pg.screenshot(path=str(OUT / f"album_{vp}_{theme}_liste.png"), full_page=True)
            ov = pg.evaluate("() => document.documentElement.scrollWidth > window.innerWidth + 1")
            small = pg.evaluate("""() => [...document.querySelectorAll('[data-nova-album] button')].filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.height < 32 || r.width < 32); }).length""")
            check(f"{tag} (téléphone) : liste des titres sans débordement horizontal", not ov, {"debordement": ov, "boutons_petits": small})
            ctx.close(); b.close(); return out
        # ISRC : un invalide (refusé, export bloqué), puis corrigé ; deux valides.
        pg.locator("[data-album-isrc='1']").fill("FR-Z03-26-00001")
        pg.locator("[data-album-isrc='2']").fill("ABC")
        pg.wait_for_timeout(200)
        bad = pg.locator("[data-album-title='2'] [role=alert]").count()
        pg.locator("[data-album-isrc='2']").fill("FRZ032600002")
        check(f"{tag} : ISRC invalide signalé puis accepté une fois corrigé", bad == 1 and pg.locator("[data-album-title='2'] [role=alert]").count() == 0, {"alerte": bad})
        # Ordre : le titre 6 monte en 5e position.
        pg.get_by_role("button", name=re.compile("^Monter Titre 6$")).click(); pg.wait_for_timeout(200)
        order = [pg.locator(f"[data-album-name='{i}']").input_value() for i in range(1, 7)]
        check(f"{tag} : réordonner (titre 6 monté d'un cran)", order[4] == "Titre 6" and order[5] == "Titre 5", order)
        # Enchaînements : fondu 2 s entre 1 et 2, blanc de 3 s entre 2 et 3.
        pg.locator("[data-album-transition='1'] select").select_option("x:2")
        pg.locator("[data-album-transition='2'] select").select_option("g:3")
        pg.locator("[data-album-artist]").fill("Nina")
        pg.locator("[data-album-name-disque]").fill("Premier EP")
        t0m = time.time()
        pg.locator("[data-album-master]").click()
        pg.wait_for_selector("[data-album-spread]", timeout=900000)
        out["mastering_s"] = round(time.time() - t0m)
        spread = float(pg.locator("[data-album-spread]").get_attribute("data-album-spread"))
        lufs = [pg.locator(f"[data-album-lufs='{i}']").inner_text() for i in range(1, 7)]
        out["ecart_lu"] = spread
        out["lufs"] = lufs
        pg.screenshot(path=str(OUT / f"album_{vp}_{theme}_masterise.png"), full_page=True)
        check(f"{tag} : 6 titres masterisés (même style, même cible) : écart de LUFS intégré ≤ 0,5 LU", spread <= 0.5, {"ecart": spread, "lufs": lufs, "secondes": out["mastering_s"]})
        # Enchaînement écouté (bouton actif, sans erreur).
        pg.locator("[data-album-play-transition='1']").click(); pg.wait_for_timeout(600)
        playing = "fa-stop" in (pg.locator("[data-album-play-transition='1'] i").get_attribute("class") or "")
        pg.locator("[data-album-play-transition='1']").click()
        check(f"{tag} : « Écouter l'enchaînement » joue la transition 1 → 2", playing, {})
        # Export : un fichier par titre.
        with pg.expect_download(timeout=300000) as dl:
            pg.locator("[data-album-export-zip]").click()
        zp = OUT / "album_titres.zip"
        dl.value.save_as(str(zp))
        z = zipfile.ZipFile(zp)
        names = sorted(z.namelist())
        wavs = [n for n in names if n.endswith(".wav")]
        cue = next((z.read(n).decode("utf-8") for n in names if n.endswith(".cue")), "")
        meta = json.loads(next((z.read(n) for n in names if n.endswith(".json")), b"{}"))
        infos = [wav_info(z.read(n)) for n in wavs]
        out["zip"] = {"fichiers": [n.split("/")[-1] for n in names], "wav": [{k: v for k, v in i.items() if k != "raw"} for i in infos]}
        gap = trailing_zero_frames(infos[1]) if len(infos) > 1 else None
        out["blanc_titre2_echantillons"] = gap
        check(f"{tag} : .zip = 6 WAV 24 bits « 01 - … » + minutage .cue + fiche JSON", len(wavs) == 6 and all(i["bits"] == 24 and i["sr"] == 48000 for i in infos)
              and wavs[0].split("/")[-1].startswith("01 - ") and bool(cue) and bool(meta.get("titres")), out["zip"]["fichiers"])
        check(f"{tag} : blanc de 3 s exact à l'échantillon à la fin du fichier du titre 2 (144 000 zéros)", gap == 144000, gap)
        check(f"{tag} : feuille .cue : 6 TRACK, ISRC des titres 1 et 2, INDEX 01", cue.count("TRACK ") == 6 and "ISRC FRZ032600001" in cue and "ISRC FRZ032600002" in cue and cue.count("INDEX 01") == 6, cue[:400])
        check(f"{tag} : fiche JSON : ordre, ISRC, écart ≤ 0,5 LU", [t["titre"] for t in meta["titres"]][4] == "Titre 6" and meta["titres"][0]["isrc"] == "FRZ032600001"
              and meta.get("ecart_lufs_entre_titres") is not None and meta["ecart_lufs_entre_titres"] <= 0.5, {"ecart": meta.get("ecart_lufs_entre_titres")})
        # Album d'un seul tenant : longueur = somme des fichiers.
        with pg.expect_download(timeout=300000) as dl2:
            pg.locator("[data-album-export-wav]").click()
        zp2 = OUT / "album_seul_tenant.zip"
        dl2.value.save_as(str(zp2))
        z2 = zipfile.ZipFile(zp2)
        w2 = [n for n in z2.namelist() if n.endswith(".wav")]
        full = wav_info(z2.read(w2[0])) if w2 else {"frames": -1}
        check(f"{tag} : album d'un seul tenant (.wav + .cue) = les 6 fichiers bout à bout (même nombre d'échantillons)",
              full["frames"] == sum(i["frames"] for i in infos) and any(n.endswith(".cue") for n in z2.namelist()), {"album": full["frames"], "somme": sum(i["frames"] for i in infos)})
        msg = pg.locator("[data-album-export-msg]").inner_text() if pg.locator("[data-album-export-msg]").count() else ""
        out["message"] = msg
        out["erreurs_page"] = [x["text"][:200] for x in log.errors()][:6]
        check(f"{tag} : aucune erreur de page", not [x for x in log.errors() if re.search(r"album|Album|quickMaster", x["text"])], out["erreurs_page"])
        ctx.close(); b.close()
    return out


# ─────────────────────────────── Téléphone 390 × 844 (EQ et rack) ───────────────────────────────
def telephone():
    out = {}
    log = Log("mixpro_tel390")
    with sync_playwright() as p:
        b = launch(p)
        ctx, pg = new_page(b, "tel390", log)
        pg.add_init_script("try { localStorage.setItem('nova_simple_mode', '0'); localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
        open_studio(pg, {"name": "mixpro_tel"}, vp="tel390")
        close_welcome(pg)
        pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
        for typ, q in (("PROEQ12", "Pro-EQ"), ("FXRACK", "rack")):
            m = pg.get_by_text("Mixer", exact=True)
            if m.count():
                m.last.click(); pg.wait_for_timeout(900)
            add = pg.get_by_role("button", name=re.compile("Ajouter un effet"))
            if not add.count():
                check(f"[téléphone] {typ} : bouton « Ajouter un effet »", False); continue
            add.first.scroll_into_view_if_needed(); add.first.click(); pg.wait_for_timeout(700)
            search = pg.locator("input[aria-label='Chercher un effet']")
            if search.count():
                search.first.fill(q); pg.wait_for_timeout(400)
            item = pg.locator(f"[data-testid='add-effect-menu'] [data-fx-id='{typ}']")
            if not item.count():
                check(f"[téléphone] {typ} : dans le menu", False); pg.keyboard.press("Escape"); continue
            item.first.click(); pg.wait_for_timeout(1500)
            win = pg.locator(f"[data-nova-plugin='{typ}']")
            if not win.count():
                check(f"[téléphone] {typ} : fenêtre ouverte", False); continue
            if typ == "PROEQ12":
                ch = win.locator("[data-nova-channel='mid']").first
                ch.scroll_into_view_if_needed(); bx = ch.bounding_box(); ch.click(); pg.wait_for_timeout(300)
                st = plugins_of(pg, "PROEQ12")
                got = (st[0]["params"]["bands"][0].get("channel") if st else None)
                extra = {"canal_bande1": got, "hauteur_bouton": round(bx["height"]) if bx else None}
                ok_extra = got == "mid" and (bx or {}).get("height", 0) >= 44
            else:
                add_fx = win.locator("[data-nova-rack-add-fx='1']").first
                add_fx.scroll_into_view_if_needed(); bx = add_fx.bounding_box()
                add_fx.click(); pg.wait_for_timeout(300)
                win.locator(".hw-rack-menu [data-fx-id='VOCALSATURATOR']").click(); pg.wait_for_timeout(1000)
                st = plugins_of(pg, "FXRACK")
                got = [x.get("type") for x in st[0]["params"]["branches"][0]["plugins"]] if st else None
                extra = {"branche1": got, "hauteur_bouton": round(bx["height"]) if bx else None}
                ok_extra = got == ["VOCALSATURATOR"]
            shot_window(pg, win, f"{typ.lower()}_tel390")
            lay = faces_ok(pg, typ)
            out[typ] = {**extra, "mise_en_page": lay}
            check(f"[téléphone] {typ} : réglage au doigt arrivé dans le projet, rien de coupé, pas de débordement", ok_extra and lay.get("ok"), out[typ])
            close_plugin(pg)
        ctx.close(); b.close()
    return out


t0 = time.time()
if want("eq"):
    res["eq_sombre"] = eq_bureau("dark")
    res["eq_clair"] = eq_bureau("light")
    res["eq_audio"] = eq_audio()
if want("rack"):
    res["rack_sombre"] = rack_bureau("dark")
    res["rack_clair"] = rack_bureau("light")
    res["rack_audio"] = rack_audio()
if want("scenes"):
    res["scenes_sombre"] = scenes_bureau("dark")
    res["scenes_clair"] = scenes_bureau("light")
if want("telephone"):
    res["telephone"] = telephone()
if want("album"):
    res["album_sombre"] = album_page("pc", "dark")
    res["album_telephone_clair"] = album_page("tel390", "light")
res["secondes"] = round(time.time() - t0)
res["verifs"] = checks
res["ok"] = all(c["ok"] for c in checks)
(OUT / "mixpro.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
print(f"{sum(c['ok'] for c in checks)}/{len(checks)} vérifications OK · {res['secondes']} s · captures : {OUT}")
sys.exit(0 if res["ok"] else 1)
