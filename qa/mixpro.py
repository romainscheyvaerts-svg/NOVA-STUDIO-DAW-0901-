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


t0 = time.time()
if want("eq"):
    res["eq_sombre"] = eq_bureau("dark")
    res["eq_clair"] = eq_bureau("light")
    res["eq_audio"] = eq_audio()
res["secondes"] = round(time.time() - t0)
res["verifs"] = checks
res["ok"] = all(c["ok"] for c in checks)
(OUT / "mixpro.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
print(f"{sum(c['ok'] for c in checks)}/{len(checks)} vérifications OK · {res['secondes']} s · captures : {OUT}")
sys.exit(0 if res["ok"] else 1)
