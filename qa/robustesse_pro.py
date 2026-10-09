"""Robustesse pro de NOVA (tour 3 « utilisable et pro ») : trois épreuves, Chrome headless, 100 %
hors production (qa_hors_prod : catalogue Supabase simulé, production bloquée).

  recup  : sauvegarde automatique et récupération après un plantage. Projet ouvert, éditions
           et mix (clip déplacé, gain de clip, volume, pan, effet, envoi, automation), puis une
           1re prise, puis une 2e prise coupée NET (onglet tué : processus de rendu tué, ou onglet
           fermé) ; réouverture dans le même profil, « Récupérer la session » : on compare l'état
           récupéré à l'état d'avant (pistes, clips, réglages) et la durée de prise récupérée.
  longue : (à lancer sur un BUILD DE PRODUCTION : `vite build --outDir X` puis `vite preview --outDir X`,
           le React de développement rend chaque image 5 à 10 fois plus lentement)
           session de 40 pistes × 20 min (sons synthétiques partagés), lecture en boucle pendant
           QA_LONGUE_MIN minutes (10 par défaut) : tas JS (performance.memory) toutes les 30 s,
           pente (Mo/min) ; puis édition (déplacer / couper des clips, faders, zoom, défilement)
           en lecture : images longues (requestAnimationFrame) et tâches longues (> 100 ms ?).
  undo   : 200 opérations mêlées (clips, mix, effets, envois, automation), project.json (même
           sérialisation que la sauvegarde : utils/recoverySnapshot.snapshotOf) après chaque
           étape ; 200 × annuler → chaque étape revient à l'identique jusqu'au départ, puis
           200 × rétablir → jusqu'à l'état final.

  NOVA_URL=http://127.0.0.1:3487/ PYTHONIOENCODING=utf-8 python qa/robustesse_pro.py [recup] [longue] [undo]
Sorties : D:\\1 WORK\\CONTENU\\nova-pro3\\robustesse\\ (robustesse_<épreuve>.json + captures)
"""
import io, json, math, os, random, re, shutil, sys, tempfile, time, wave, zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-pro3\robustesse")
import qa_hors_prod  # noqa: E402,F401  (avant tout navigateur : Supabase simulé, production bloquée)
from qalib import BASE, OUT, CHROME, FAKE_WAV, APP_MODULE_INIT, Log, new_page, launch  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

SR = 44100
INIT = ("try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_welcome_seen', '1');"
        " localStorage.setItem('nova_simple_mode', '0'); localStorage.setItem('nova_count_in', '0');"
        " localStorage.setItem('nova_auto_clean', '0'); } catch (e) {}")
WS_LOCAL = re.compile(r"^ws://(127\.0\.0\.1|localhost):876[56]")
# Session longue : mesurée sur un build de production (NOVA_URL_PROD, serveur `vite preview`).
URL_PROD = os.environ.get("NOVA_URL_PROD", BASE)
# Rechargement à chaud de Vite coupé pour ces mesures : une modification d'un fichier source pendant la
# lecture de 10 min (autre session de travail) rechargeait l'appli et faussait mémoire et lecture.
WS_VITE = re.compile("^" + re.escape(BASE.replace("http://", "ws://").replace("https://", "wss://").rstrip("/")) + r"/?(\?|$)")


def no_hmr(page):
    page.route_web_socket(WS_VITE, lambda ws: None)   # socket simulé, muet : aucune mise à jour poussée
    page.route_web_socket(WS_LOCAL, lambda ws: ws.close())


def save(name, data):
    p = OUT / f"robustesse_{name}.json"
    p.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    return p


# ----------------------------------------------------------------------------- projets de test
def tone_wav(freq, dur, kind=0, sr=SR):
    t = np.arange(int(dur * sr)) / sr
    if kind == 0:
        x = 0.2 * np.sin(2 * np.pi * freq * t)
    elif kind == 1:
        x = 0.15 * np.sign(np.sin(2 * np.pi * freq * t)) * np.exp(-((t % 0.5) * 6))
    else:
        rng = np.random.default_rng(int(freq))
        x = 0.1 * rng.standard_normal(len(t)) * np.exp(-((t % 0.25) * 18))
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return b.getvalue()


def plugin(pid, ptype, enabled=True, params=None):
    return {"id": pid, "name": ptype.title(), "type": ptype, "isEnabled": enabled, "params": params or {}}


def track(tid, name, ttype="AUDIO", out="master", **kw):
    t = {"id": tid, "name": name, "type": ttype, "color": "#3b82f6", "isMuted": False, "isSolo": False,
         "isTrackArmed": False, "isFrozen": False, "volume": 0.8, "pan": 0, "outputTrackId": out,
         "sends": [], "clips": [], "plugins": [], "automationLanes": [], "totalLatency": 0}
    t.update(kw)
    return t


def clip(cid, name, start, dur, ref, offset=0.0):
    return {"id": cid, "name": name, "start": start, "duration": dur, "offset": offset, "fadeIn": 0, "fadeOut": 0,
            "color": "#22d3ee", "type": "AUDIO", "audioRef": ref, "gain": 1}


def state_of(name, tracks, **kw):
    s = {"id": f"proj-{re.sub(r'[^a-z0-9]', '', name.lower())[:20]}", "name": name, "bpm": 120,
         "timeSignature": {"numerator": 4, "denominator": 4}, "isPlaying": False, "isRecording": False, "currentTime": 0,
         "isLoopActive": False, "loopStart": 0, "loopEnd": 8, "tracks": tracks, "trackGroups": [],
         "markers": [{"id": "m1", "time": 4, "name": "Couplet", "type": "MARKER", "color": "#00f2ff", "number": 1}],
         "selectedTrackId": tracks[-1]["id"], "currentView": "ARRANGEMENT", "projectPhase": "RECORDING", "isLowLatencyMode": False,
         "isRecModeActive": False, "systemMaxLatency": 0, "recStartTime": None, "isDelayCompEnabled": True,
         "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
         "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0}}
    s.update(kw)
    return s


def write_zip(path, state, files):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        for k, v in files.items():
            z.writestr(k, v)


def mix_project(path):
    """Projet « séance » : 6 pistes audio avec effets, envois, automation ; un retour, un bus."""
    files = {f"audio/son{i}.wav": tone_wav(110 * (1 + i * 0.3), 12.0, i % 3) for i in range(4)}
    tracks = [track("master", "MASTER BUS", "BUS", "", plugins=[plugin("m-comp", "COMPRESSOR")]),
              track("send-verb", "REVERB", "SEND", "master", plugins=[plugin("sv-rev", "REVERB")]),
              track("bus-vox", "BUS VOIX", "BUS", "master", plugins=[plugin("bv-comp", "COMPRESSOR")])]
    for i in range(6):
        tid = f"t{i}"
        tracks.append(track(tid, f"Piste {i + 1}", "AUDIO", "bus-vox" if i >= 3 else "master",
                            clips=[clip(f"{tid}-c0", f"Son {i + 1}a", 0.5 * i, 6.0, f"audio/son{i % 4}.wav"),
                                   clip(f"{tid}-c1", f"Son {i + 1}b", 7.0 + 0.25 * i, 4.0, f"audio/son{(i + 1) % 4}.wav", 1.0)],
                            plugins=[plugin(f"{tid}-eq", "PROEQ12"), plugin(f"{tid}-comp", "COMPRESSOR", params={"threshold": -18, "ratio": 3})],
                            sends=[{"id": "send-verb", "level": 0.2, "isEnabled": True}],
                            automationLanes=[{"id": f"auto-{tid}-vol", "parameterName": "volume", "color": "#3b82f6", "isExpanded": False,
                                              "min": 0, "max": 1.5, "points": [{"id": f"p-{tid}-0", "time": 0, "value": 0.8},
                                                                               {"id": f"p-{tid}-1", "time": 8, "value": 0.6}]}]))
    tracks.append(track("rec", "VOIX", "AUDIO", "bus-vox", color="#ff0000"))
    write_zip(path, state_of("Robustesse séance", tracks), files)


def long_project(path, n=40, minutes=20):
    """40 pistes × 20 min : 4 sons de 30 s partagés, posés bout à bout (RAM raisonnable)."""
    files = {f"audio/long{i}.wav": tone_wav(90 * (1 + i * 0.37), 30.0, i % 3, sr=22050) for i in range(4)}
    dur = minutes * 60.0
    tracks = [track("master", "MASTER BUS", "BUS", "", plugins=[plugin("m-comp", "COMPRESSOR")]),
              track("send-verb", "REVERB", "SEND", "master", plugins=[plugin("sv-rev", "REVERB")])]
    for i in range(n):
        tid = f"L{i:02d}"
        cl = [clip(f"{tid}-c{k}", f"P{i + 1}.{k + 1}", k * 30.0, 30.0, f"audio/long{(i + k) % 4}.wav") for k in range(int(dur // 30))]
        tracks.append(track(tid, f"Piste {i + 1}", "AUDIO", "master", clips=cl, volume=0.15, pan=round(((i % 9) - 4) / 5, 2),
                            plugins=[plugin(f"{tid}-eq", "PROEQ12")] if i % 2 == 0 else [],
                            sends=[{"id": "send-verb", "level": 0.1, "isEnabled": True}] if i % 4 == 0 else []))
    write_zip(path, state_of(f"Session longue {n} pistes {minutes} min", tracks, isLoopActive=True, loopStart=0, loopEnd=dur), files)


# ----------------------------------------------------------------------------- navigateur
def open_project(page, f, min_tracks=1, timeout_s=120, base=None):
    page.goto(base or BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=60000)
    page.get_by_text("Charger Projet").first.click(); page.wait_for_timeout(700)
    with page.expect_file_chooser(timeout=8000) as fc:
        page.get_by_text("Charger depuis l'ordinateur").first.click()
    fc.value.set_files(str(f))
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        page.wait_for_timeout(500)
        if page.evaluate(f"() => !!(window.DAW_CONTROL && window.DAW_CONTROL.diag().tracks >= {min_tracks} && window.__novaEdit)"):
            break
    page.wait_for_timeout(1200)
    for name in ("C'est parti", "Plus tard"):
        b = page.get_by_role("button", name=name, exact=True).locator("visible=true").first
        try:
            if b.is_visible(): b.click(); page.wait_for_timeout(300)
        except Exception:
            pass
    page.keyboard.press("Escape")


SNAP_JS = """async () => { const m = await window.__novaAppModule('/utils/recoverySnapshot.ts');
  return m.snapshotOf(window.DAW_CONTROL.getState()).json; }"""

# Champs hors projet (non sauvegardés comme « contenu », et que l'annulation ne doit PAS toucher
# d'après son contrat : lecture, tête de lecture, piste et vue sélectionnées, état de la prise).
UI_KEYS = {"isPlaying", "isRecording", "currentTime", "recStartTime", "selectedTrackId", "currentView",
           "isRecModeActive", "projectPhase", "systemMaxLatency"}


def canon(js_text):
    d = json.loads(js_text)
    for k in UI_KEYS: d.pop(k, None)
    return d


def diff(a, b, path="", out=None, limit=40):
    out = [] if out is None else out
    if len(out) >= limit: return out
    if type(a) != type(b):
        out.append(f"{path}: {json.dumps(a, ensure_ascii=False)[:80]} ≠ {json.dumps(b, ensure_ascii=False)[:80]}"); return out
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a: out.append(f"{path}.{k}: absent → {json.dumps(b[k], ensure_ascii=False)[:80]}")
            elif k not in b: out.append(f"{path}.{k}: {json.dumps(a[k], ensure_ascii=False)[:80]} → absent")
            else: diff(a[k], b[k], f"{path}.{k}", out, limit)
    elif isinstance(a, list):
        if len(a) != len(b): out.append(f"{path}: {len(a)} éléments ≠ {len(b)}")
        for i, (x, y) in enumerate(zip(a, b)): diff(x, y, f"{path}[{i}]", out, limit)
    elif isinstance(a, float) or isinstance(b, float):
        if abs(float(a) - float(b)) > 1e-9: out.append(f"{path}: {a} ≠ {b}")
    elif a != b:
        out.append(f"{path}: {json.dumps(a, ensure_ascii=False)[:80]} ≠ {json.dumps(b, ensure_ascii=False)[:80]}")
    return out


# ============================================================================ 3. annuler / rétablir
OPS_JS = r"""async ([kind, r]) => {
  const D = window.DAW_CONTROL, E = window.__novaEdit, s = D.getState();
  const audio = s.tracks.filter(t => t.type === 'AUDIO' && t.clips.length);
  const pick = (arr) => arr[Math.floor(r[0] * arr.length) % arr.length];
  const t = pick(audio); const c = t.clips[Math.floor(r[1] * t.clips.length) % t.clips.length];
  const v = r[2];
  switch (kind) {
    case 'volume': D.updateTrack({ ...t, volume: +(0.2 + v).toFixed(4) }); return `volume ${t.name}`;
    case 'pan': D.updateTrack({ ...t, pan: +(v * 2 - 1).toFixed(4) }); return `pan ${t.name}`;
    case 'mute': D.updateTrack({ ...t, isMuted: !t.isMuted }); return `muet ${t.name}`;
    case 'solo': D.updateTrack({ ...t, isSolo: !t.isSolo }); return `solo ${t.name}`;
    case 'bypass': { const p = pick(t.plugins.length ? t.plugins : [null]); if (!p) return null; D.toggleBypass(t.id, p.id); return `effet on/off ${p.type} ${t.name}`; }
    case 'param': { const p = t.plugins.find(x => x.type === 'COMPRESSOR'); if (!p) return null; D.updatePluginParams(t.id, p.id, { threshold: Math.round(-40 + 35 * v), ratio: +(1.5 + 6 * r[0]).toFixed(2) }); return `réglage compresseur ${t.name}`; }
    case 'send': { if (!t.sends.length) return null; D.updateTrack({ ...t, sends: t.sends.map((x, i) => i === 0 ? { ...x, level: +(v * 0.9).toFixed(4) } : x) }); return `envoi ${t.name}`; }
    case 'auto': { const l = t.automationLanes.find(x => x.parameterName === 'volume'); if (!l) return null;
      const pts = [...l.points, { id: `p-qa-${Date.now()}-${Math.round(v * 1e6)}`, time: +(1 + v * 10).toFixed(3), value: +(0.3 + r[0]).toFixed(3) }].sort((a, b) => a.time - b.time);
      D.updateTrack({ ...t, automationLanes: t.automationLanes.map(x => x.id === l.id ? { ...x, points: pts } : x) }); return `point d'automation ${t.name}`; }
    case 'autoMove': { const l = t.automationLanes.find(x => x.parameterName === 'volume'); if (!l || !l.points.length) return null;
      const k = Math.floor(r[1] * l.points.length) % l.points.length;
      D.updateTrack({ ...t, automationLanes: t.automationLanes.map(x => x.id === l.id ? { ...x, points: x.points.map((p, i) => i === k ? { ...p, value: +(0.1 + v).toFixed(3) } : p) } : x) }); return `automation déplacée ${t.name}`; }
    case 'move': E.patchClips(t.id, { [c.id]: { start: Math.max(0, +(c.start + (v - 0.5) * 2).toFixed(4)) } }); return `clip déplacé ${c.name}`;
    case 'gain': E.patchClips(t.id, { [c.id]: { gain: +(0.4 + v).toFixed(4) } }); return `gain de clip ${c.name}`;
    case 'fade': E.patchClips(t.id, { [c.id]: { fadeIn: +(v * 0.5).toFixed(4), fadeOut: +(r[0] * 0.5).toFixed(4) } }); return `fondus ${c.name}`;
    case 'split': { if (c.duration < 0.6) return null; D.editClip(t.id, c.id, 'SPLIT', { time: +(c.start + 0.2 + v * (c.duration - 0.4)).toFixed(4) }); return `séparer ${c.name}`; }
    case 'dup': { if (t.clips.length > 8) return null; D.editClip(t.id, c.id, 'DUPLICATE', { start: +(c.start + c.duration + 0.5).toFixed(3) }); return `dupliquer ${c.name}`; }
    case 'del': { if (t.clips.length < 3) return null; D.editClip(t.id, c.id, 'DELETE'); return `supprimer ${c.name}`; }
    case 'clipMute': D.editClip(t.id, c.id, 'MUTE'); return `clip muet ${c.name}`;
    case 'rename': D.editClip(t.id, c.id, 'RENAME', { name: `${c.name.split(' ·')[0]} · ${Math.round(v * 99)}` }); return `renommer ${c.name}`;
  }
  return null;
}"""
OP_KINDS = [("volume", 3), ("pan", 2), ("mute", 1), ("solo", 1), ("bypass", 2), ("param", 2), ("send", 2), ("auto", 2), ("autoMove", 1),
            ("move", 3), ("gain", 2), ("fade", 2), ("split", 2), ("dup", 1), ("del", 1), ("clipMute", 1), ("rename", 1)]


def epreuve_undo(p, n_ops=200, seed=11):
    res = {"epreuve": "undo", "operations_demandees": n_ops, "seed": seed, "ok": False}
    log = Log("robustesse_undo")
    b = launch(p)
    ctx, page = new_page(b, "pc", log=log)
    ctx.add_init_script(INIT)
    no_hmr(page)
    page.set_default_timeout(30000)
    proj = OUT / "robustesse_seance.novaproj.zip"
    mix_project(proj)
    rng = random.Random(seed)
    try:
        open_project(page, proj, min_tracks=10)
        page.screenshot(path=str(OUT / "undo_01_depart.png"))
        snaps = [page.evaluate(SNAP_JS)]
        # Ctrl+Z juste après l'ouverture : le projet ouvert doit rester (avant : retour au projet précédent).
        page.evaluate("() => window.DAW_CONTROL.undo()"); page.wait_for_timeout(200)
        s_after = page.evaluate(SNAP_JS)
        res["annuler_apres_ouverture"] = {"projet_garde": s_after == snaps[0], "ecarts": diff(canon(snaps[0]), canon(s_after))[:5]}
        if s_after != snaps[0]:
            page.evaluate("() => window.DAW_CONTROL.redo()"); page.wait_for_timeout(200)
        ops, skipped = [], 0
        bag = [k for k, w in OP_KINDS for _ in range(w)]
        t0 = time.time()
        while len(ops) < n_ops and skipped < n_ops:
            kind = rng.choice(bag)
            what = page.evaluate(OPS_JS, [kind, [rng.random(), rng.random(), rng.random()]])
            page.wait_for_timeout(380)   # > anti-rebond de l'historique (300 ms) : une étape par opération
            s = page.evaluate(SNAP_JS)
            if not what or s == snaps[-1]:
                skipped += 1
                continue
            ops.append(what); snaps.append(s)
        res["operations"] = len(ops)
        res["operations_sans_effet_ignorees"] = skipped
        res["duree_operations_s"] = round(time.time() - t0, 1)
        res["types"] = {k: sum(1 for o in ops if o.split(" ")[0] in k) for k, _ in OP_KINDS}
        page.screenshot(path=str(OUT / "undo_02_apres_200.png"))
        final = snaps[-1]
        # --- 200 × annuler : chaque étape doit retrouver l'état d'avant l'opération
        undo_bad, undo_first = [], None
        for k in range(len(ops), 0, -1):
            page.evaluate("() => window.DAW_CONTROL.undo()")
            page.wait_for_timeout(40)
            s = page.evaluate(SNAP_JS)
            if s != snaps[k - 1]:
                d = diff(canon(snaps[k - 1]), canon(s))
                if d:
                    undo_bad.append({"etape": k, "operation_annulee": ops[k - 1], "ecarts": d[:8]})
                    if undo_first is None: undo_first = k
        start_diff = diff(canon(snaps[0]), canon(page.evaluate(SNAP_JS)))
        res["annuler"] = {"etapes_differentes": len(undo_bad), "premiere_etape_fausse": undo_first, "detail": undo_bad[:12],
                          "ecarts_avec_le_depart": start_diff[:30], "identique_au_depart": not start_diff}
        page.screenshot(path=str(OUT / "undo_03_tout_annule.png"))
        # --- 200 × rétablir
        redo_bad = []
        for k in range(1, len(ops) + 1):
            page.evaluate("() => window.DAW_CONTROL.redo()")
            page.wait_for_timeout(40)
            s = page.evaluate(SNAP_JS)
            if s != snaps[k]:
                d = diff(canon(snaps[k]), canon(s))
                if d: redo_bad.append({"etape": k, "operation_retablie": ops[k - 1], "ecarts": d[:8]})
        end_diff = diff(canon(final), canon(page.evaluate(SNAP_JS)))
        res["retablir"] = {"etapes_differentes": len(redo_bad), "detail": redo_bad[:12], "ecarts_avec_la_fin": end_diff[:30], "identique_a_la_fin": not end_diff}
        page.screenshot(path=str(OUT / "undo_04_tout_retabli.png"))
        (OUT / "undo_project_depart.json").write_text(json.dumps(canon(snaps[0]), ensure_ascii=False, sort_keys=True, indent=1), encoding="utf-8")
        (OUT / "undo_project_final.json").write_text(json.dumps(canon(final), ensure_ascii=False, sort_keys=True, indent=1), encoding="utf-8")
        res["journal_operations"] = ops
        res["ok"] = res["annuler_apres_ouverture"]["projet_garde"] and len(ops) >= n_ops and not undo_bad and not start_diff and not redo_bad and not end_diff
    except Exception as e:  # noqa
        res["erreur"] = f"{type(e).__name__}: {str(e)[:400]}"
        try: page.screenshot(path=str(OUT / "undo_ECHEC.png"))
        except Exception: pass
    res["erreurs_console"] = [e["text"][:200] for e in log.errors() if not WS_LOCAL.search(e["text"]) and "8765" not in e["text"]][:20]
    ctx.close(); b.close()
    return res


# ============================================================================ 1. récupération
def persistent(p, profile, log):
    ctx = p.chromium.launch_persistent_context(
        str(profile), headless=True, executable_path=CHROME, viewport={"width": 1600, "height": 900}, locale="fr-BE",
        permissions=["microphone"],
        args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={FAKE_WAV}",
              "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"])
    qa_hors_prod.install(ctx, log)
    ctx.add_init_script(INIT)
    ctx.add_init_script(APP_MODULE_INIT)

    def guard(route, request):
        url = request.url
        if qa_hors_prod.is_supabase(url):
            return route.fallback()
        if request.method in ("POST", "PATCH", "PUT", "DELETE") and not url.startswith(BASE.rstrip("/")):
            return route.abort()
        return route.continue_()
    ctx.route("**/*", guard)
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    no_hmr(page)
    page.set_default_timeout(30000)
    page.on("console", lambda m: log.add(f"console.{m.type}", m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: log.add("pageerror", e))
    return ctx, page


def browser_tree(profile):
    import psutil
    key = str(profile).lower()
    for pr in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            cmd = pr.info["cmdline"] or []
            if "chrome" in (pr.info["name"] or "").lower() and key in " ".join(cmd).lower() and not any(x.startswith("--type=") for x in cmd):
                return pr, pr.children(recursive=True)
        except Exception:
            pass
    return None, []


STATE_JS = """() => { const s = window.DAW_CONTROL.getState(); const r = (x) => Math.round((x || 0) * 1000) / 1000;
  return { bpm: s.bpm, markers: (s.markers || []).map(m => [m.name, r(m.time)]),
    tracks: s.tracks.map(t => ({ id: t.id, name: t.name, volume: r(t.volume), pan: r(t.pan), muted: !!t.isMuted,
      sends: (t.sends || []).map(x => [x.id, r(x.level)]), plugins: (t.plugins || []).map(p => [p.type, !!p.isEnabled, JSON.stringify(p.params || {})]),
      auto: (t.automationLanes || []).map(l => [l.parameterName, l.points.map(p => [r(p.time), r(p.value)])]),
      clips: t.clips.map(c => ({ id: c.id, name: c.name, start: r(c.start), duration: r(c.duration), offset: r(c.offset), gain: r(c.gain ?? 1), muted: !!c.isMuted, audio: !!(c.bufferId) })) })) }; }"""


def wait_rec(page, on=True, timeout=10000):
    t0 = time.time()
    while (time.time() - t0) * 1000 < timeout:
        if bool(page.evaluate("() => window.DAW_CONTROL.getState().isRecording")) == on: return True
        page.wait_for_timeout(50)
    return False


def edits_and_mix(page):
    """Ce que fait un ingé dans les secondes qui précèdent une prise : rien de tout ça ne doit se perdre."""
    page.evaluate("""() => { const D = window.DAW_CONTROL, E = window.__novaEdit; const s = D.getState();
      const t = s.tracks.find(x => x.id === 't1'), u = s.tracks.find(x => x.id === 't4');
      E.patchClips('t1', { 't1-c0': { start: 1.25, gain: 0.7 } }); }""")
    page.wait_for_timeout(400)
    page.evaluate("() => { const D = window.DAW_CONTROL; const t = D.getState().tracks.find(x => x.id === 't4'); D.updateTrack({ ...t, volume: 0.42, pan: -0.35, sends: t.sends.map(x => ({ ...x, level: 0.55 })) }); }")
    page.wait_for_timeout(400)
    page.evaluate("() => { const D = window.DAW_CONTROL; D.updatePluginParams('t2', 't2-comp', { threshold: -27, ratio: 4.5 }); }")
    page.wait_for_timeout(400)
    page.evaluate("""() => { const D = window.DAW_CONTROL; const t = D.getState().tracks.find(x => x.id === 't3'); const l = t.automationLanes[0];
      D.updateTrack({ ...t, automationLanes: [{ ...l, points: [...l.points, { id: 'p-recup', time: 5, value: 1.1 }].sort((a, b) => a.time - b.time) }] }); }""")
    page.wait_for_timeout(400)
    page.evaluate("() => { const D = window.DAW_CONTROL; D.toggleBypass('t5', 't5-eq'); }")
    page.wait_for_timeout(400)


def epreuve_recup(p, mode="onglet_tue", rec_s=8.0, first_take_s=4.0):
    import psutil  # noqa: F401
    res = {"epreuve": f"recup_{mode}", "ok": False}
    log = Log(f"robustesse_recup_{mode}")
    profile = Path(tempfile.mkdtemp(prefix=f"nova-robuste-{mode}-"))
    proj = OUT / "robustesse_seance.novaproj.zip"
    mix_project(proj)
    try:
        ctx, page = persistent(p, profile, log)
        open_project(page, proj, min_tracks=10)
        # 1re prise (complète), puis éditions et mix (moins de 15 s avant la 2e prise : pas encore
        # de sauvegarde automatique périodique), puis la 2e prise, coupée net.
        page.evaluate("() => { const D = window.DAW_CONTROL; const t = D.getState().tracks.find(x => x.id === 'rec'); D.updateTrack({ ...t, isTrackArmed: true }); D.seek(0); }")
        page.wait_for_timeout(800)
        page.evaluate("() => window.DAW_CONTROL.toggleRecord()")
        wait_rec(page, True)
        page.wait_for_timeout(int(first_take_s * 1000))
        page.evaluate("() => window.DAW_CONTROL.toggleRecord()")
        wait_rec(page, False)
        page.wait_for_timeout(2500)  # version « après prise » écrite
        edits_and_mix(page)
        before = page.evaluate(STATE_JS)
        page.evaluate("() => window.DAW_CONTROL.seek(10)")
        page.wait_for_timeout(300)
        page.evaluate("() => window.DAW_CONTROL.toggleRecord()")
        wait_rec(page, True)
        rec_start = time.time()
        page.screenshot(path=str(OUT / f"recup_{mode}_1_pendant_prise.png"))
        while time.time() - rec_start < rec_s:
            page.wait_for_timeout(100)
        res["prise_en_cours_s"] = round(time.time() - rec_start, 2)
        kill_ms = time.time() * 1000
        if mode == "onglet_tue":
            main, kids = browser_tree(profile)
            rend = [k for k in kids if any(a.startswith("--type=renderer") for a in (k.cmdline() or []))]
            res["processus_tues"] = len(rend)
            for k in rend:
                try: k.kill()
                except Exception: pass
            time.sleep(2)
            page = ctx.new_page()
            no_hmr(page)
            page.set_default_timeout(30000)
        else:  # onglet fermé (croix de l'onglet) en pleine prise, navigateur gardé
            page.close(run_before_unload=False)
            time.sleep(1.5)
            page = ctx.new_page()
            no_hmr(page)
            page.set_default_timeout(30000)
        page.goto(BASE, wait_until="domcontentloaded")
        dlg = page.get_by_test_id("crash-recovery")
        proposed = True
        try:
            dlg.wait_for(timeout=30000)
        except Exception:
            proposed = False
        res["recuperation_proposee"] = proposed
        page.wait_for_timeout(600)
        takes = page.evaluate("async () => { const m = await window.__novaAppModule('/utils/recoveryStore.ts'); return (await m.recoveryStore().pendingTakes()).map(t => ({ startedAt: t.startedAt, samples: t.samples, sr: t.sampleRate })); }")
        res["prises_dans_le_journal"] = len(takes or [])
        if takes:
            res["capte_jusqu_a_la_coupure_s"] = round((kill_ms - takes[-1]["startedAt"]) / 1000, 2)
        page.screenshot(path=str(OUT / f"recup_{mode}_2_proposition.png"))
        if proposed:
            res["proposition"] = dlg.inner_text()[:500]
            page.get_by_role("button", name="Récupérer la session").click()
        else:
            # Pas de proposition : on cherche par où l'utilisateur retrouverait sa session.
            res["accueil"] = page.evaluate("() => document.body.innerText.slice(0, 400)")
        for _ in range(60):
            page.wait_for_timeout(500)
            if page.evaluate("() => !!(window.DAW_CONTROL && window.DAW_CONTROL.getState().tracks.some(t => t.id === 'rec'))"):
                break
        page.wait_for_timeout(3000)
        after = page.evaluate(STATE_JS)
        page.screenshot(path=str(OUT / f"recup_{mode}_3_recuperee.png"))
        # --- comparaison piste par piste (hors la piste de prise, comparée à part)
        B = {t["id"]: t for t in before["tracks"]}; A = {t["id"]: t for t in after["tracks"]}
        lost = []
        for tid, t in B.items():
            if tid == "rec": continue
            a = A.get(tid)
            if not a: lost.append(f"piste {t['name']} absente"); continue
            for k in ("volume", "pan", "muted", "sends", "plugins", "auto"):
                if t[k] != a[k]: lost.append(f"{t['name']} · {k} : {str(t[k])[:90]} → {str(a[k])[:90]}")
            bc = {c["id"]: c for c in t["clips"]}; ac = {c["id"]: c for c in a["clips"]}
            for cid, c in bc.items():
                x = ac.get(cid)
                if not x: lost.append(f"clip {c['name']} absent"); continue
                for k in ("start", "duration", "offset", "gain", "muted"):
                    if c[k] != x[k]: lost.append(f"clip {c['name']} · {k} : {c[k]} → {x[k]}")
                if not x["audio"]: lost.append(f"clip {c['name']} sans son")
        if before["markers"] != after["markers"]: lost.append(f"repères : {before['markers']} → {after['markers']}")
        recB = next((t for t in before["tracks"] if t["id"] == "rec"), {"clips": []})
        recA = next((t for t in after["tracks"] if t["id"] == "rec"), {"clips": []})
        prev_takes = [c for c in recB["clips"] if not c["muted"]] or recB["clips"]
        res["prise_1_avant"] = [(c["name"], c["duration"]) for c in recB["clips"]]
        res["piste_voix_apres"] = [(c["name"], c["start"], c["duration"], c["offset"], c["audio"]) for c in recA["clips"]]
        for c in recB["clips"]:
            if not any(x["id"] == c["id"] and x["audio"] for x in recA["clips"]): lost.append(f"1re prise {c['name']} perdue")
        rec2 = [x for x in recA["clips"] if x["id"] not in {c["id"] for c in recB["clips"]}]
        got = max((x["duration"] + x["offset"] for x in rec2), default=0.0)
        ref = res.get("capte_jusqu_a_la_coupure_s", res["prise_en_cours_s"])
        res["prise_coupee_recuperee_s"] = round(got, 2)
        res["perte_prise_s"] = round(ref - got, 2)
        res["pertes"] = lost
        res["etat_avant"] = before; res["etat_apres"] = after
        res["ok"] = bool(proposed and not lost and rec2 and res["perte_prise_s"] < 1.0)
        try: ctx.close()
        except Exception: pass
    except Exception as e:  # noqa
        res["erreur"] = f"{type(e).__name__}: {str(e)[:400]}"
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    res["erreurs_console"] = [e["text"][:200] for e in log.errors() if "8765" not in e["text"] and "8766" not in e["text"]][:15]
    return res


# ============================================================================ 2. session longue
MEASURE_INIT = r"""
(() => {
  const S = window.__rob = { frames: [], longTasks: [], maxFrame: 0, big: [] };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) S.longTasks.push({ t: Math.round(e.startTime), d: Math.round(e.duration) }); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
  let last = 0; const raf = (t) => { if (last) { const d = t - last; S.frames.push(d); if (d > S.maxFrame) S.maxFrame = d; if (d > 100) S.big.push({ t: Math.round(t), d: Math.round(d) }); if (S.frames.length > 50000) S.frames.splice(0, 25000); } last = t; requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
})();
"""
FRAMES_JS = r"""() => { const S = window.__rob; const f = S.frames.splice(0).sort((a, b) => a - b); const lt = S.longTasks.splice(0); const big = S.big.splice(0);
  const pct = (q) => f.length ? Math.round(f[Math.min(f.length - 1, Math.floor(f.length * q))] * 10) / 10 : null;
  return { n: f.length, p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: f.length ? Math.round(f[f.length - 1] * 10) / 10 : null,
    over100: f.filter(x => x > 100).length, over50: f.filter(x => x > 50).length, longTasks: lt.length, longTaskMax: lt.reduce((m, x) => Math.max(m, x.d), 0), longTaskList: lt.slice(-10), imagesLongues: big.slice(-20) }; }"""


def epreuve_longue(p, minutes=10.0, edit_s=60.0):
    res = {"epreuve": "longue", "minutes_lecture": minutes, "ok": False, "memoire": [], "notes": []}
    log = Log("robustesse_longue")
    b = p.chromium.launch(headless=True, executable_path=CHROME, args=[
        "--autoplay-policy=no-user-gesture-required", "--enable-precise-memory-info", "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--js-flags=--expose-gc"])
    ctx, page = new_page(b, "pc", log=log)
    ctx.add_init_script(INIT)
    ctx.add_init_script(MEASURE_INIT)
    no_hmr(page)
    page.set_default_timeout(60000)
    proj = OUT / "robustesse_longue_40x20.novaproj.zip"
    if not proj.exists():
        long_project(proj)
    cdp = ctx.new_cdp_session(page)
    cdp.send("HeapProfiler.enable")

    def heap(gc=True):
        if gc:
            cdp.send("HeapProfiler.collectGarbage"); page.wait_for_timeout(300); cdp.send("HeapProfiler.collectGarbage"); page.wait_for_timeout(200)
        return page.evaluate("() => ({ used: performance.memory.usedJSHeapSize / 1048576, total: performance.memory.totalJSHeapSize / 1048576 })")
    try:
        t_open = time.time()
        res["url"] = URL_PROD
        open_project(page, proj, min_tracks=40, timeout_s=300, base=URL_PROD)
        res["ouverture_s"] = round(time.time() - t_open, 1)
        d = page.evaluate("() => window.DAW_CONTROL.diag()")
        res["session"] = {"pistes": d["tracks"], "clips": d["clips"], "sons": d["buffers"], "secondes_audio": d["bufferSeconds"],
                          "duree_projet_s": page.evaluate("() => Math.max(...window.DAW_CONTROL.getState().tracks.flatMap(t => t.clips.map(c => c.start + c.duration)))")}
        page.screenshot(path=str(OUT / "longue_01_session.png"))
        # Boucle de lecture : tout le morceau (20 min), départ à 0.
        page.evaluate("() => { window.DAW_CONTROL.setLoop(true, 0, 1200); window.DAW_CONTROL.seek(0); }")
        page.wait_for_timeout(500)
        page.evaluate("() => window.DAW_CONTROL.togglePlay()")
        page.wait_for_timeout(3000)
        h0 = heap()   # ramasse-miettes forcé au départ (et à la fin) seulement : pendant la lecture, il
        page.wait_for_timeout(1500)   # gèlerait lui-même l'image et fausserait la mesure des images longues
        page.evaluate(FRAMES_JS)  # remise à zéro après le démarrage
        t0 = time.time()
        res["t0_page_ms"] = page.evaluate("() => Math.round(performance.now())")
        res["memoire_gc_debut_Mo"] = round(h0["used"], 2)
        res["memoire"].append({"s": 0, "Mo": round(h0["used"], 2), "total_Mo": round(h0["total"], 1), "lecture": True}) 
        nxt = 30.0
        while time.time() - t0 < minutes * 60:
            page.wait_for_timeout(1000)
            el = time.time() - t0
            if el >= nxt:
                h = heap(gc=False)
                st = page.evaluate("() => { const s = window.DAW_CONTROL.getState(); return { playing: s.isPlaying, t: s.currentTime }; }")
                res["memoire"].append({"s": round(el), "Mo": round(h["used"], 2), "total_Mo": round(h["total"], 1), "lecture": st["playing"], "position_s": round(st["t"], 1)})
                print(json.dumps(res["memoire"][-1]), flush=True)
                if not st["playing"]:
                    res["notes"].append(f"lecture arrêtée à {round(el)} s : relancée"); page.evaluate("() => window.DAW_CONTROL.togglePlay()")
                nxt += 30.0
                save("longue", res)
        res["images_pendant_lecture"] = page.evaluate(FRAMES_JS)
        hg = heap()
        res["memoire_gc_fin_Mo"] = round(hg["used"], 2)
        res["memoire_gc_ecart_Mo"] = round(hg["used"] - h0["used"], 2)
        xs = np.array([m["s"] / 60 for m in res["memoire"]]); ys = np.array([m["Mo"] for m in res["memoire"]])
        # Pente sur la 2e moitié (après la mise en cache du début) et sur tout.
        res["pente_Mo_par_min"] = round(float(np.polyfit(xs, ys, 1)[0]), 3) if len(xs) > 2 else None
        half = xs >= xs[-1] / 2
        res["pente_2e_moitie_Mo_par_min"] = round(float(np.polyfit(xs[half], ys[half], 1)[0]), 3) if half.sum() > 2 else None
        res["memoire_debut_fin_Mo"] = [round(float(ys[0]), 1), round(float(ys[-1]), 1)]
        # --- Édition pendant la lecture : images longues ?
        page.evaluate(FRAMES_JS)
        ops = 0
        t1 = time.time()
        rng = random.Random(5)
        grid = page.locator(".nova-grille .custom-scroll").first
        box = grid.bounding_box() if grid.count() else None
        ids = page.evaluate("() => window.DAW_CONTROL.getState().tracks.filter(t => t.type === 'AUDIO' && t.clips.length > 10).map(t => t.id)")
        res["edition_pistes"] = len(ids)
        while time.time() - t1 < edit_s:
            k = ops % 6
            tid = rng.choice(ids)
            if k == 0:
                page.evaluate(f"() => {{ const t = window.DAW_CONTROL.getState().tracks.find(x => x.id === '{tid}'); const c = t.clips[{rng.randrange(10)}]; window.__novaEdit.patchClips('{tid}', {{ [c.id]: {{ start: c.start + 0.25 }} }}); }}")
            elif k == 1:
                page.evaluate(f"() => {{ const t = window.DAW_CONTROL.getState().tracks.find(x => x.id === '{tid}'); const c = t.clips[{rng.randrange(10)}]; window.DAW_CONTROL.editClip('{tid}', c.id, 'SPLIT', {{ time: c.start + 7.5 }}); }}")
            elif k == 2:
                for j in range(8):  # fader bougé (8 pas, comme un glisser)
                    page.evaluate(f"() => {{ const t = window.DAW_CONTROL.getState().tracks.find(x => x.id === '{tid}'); window.DAW_CONTROL.updateTrack({{ ...t, volume: {0.1 + j * 0.02} }}); }}")
                    page.wait_for_timeout(16)
            elif k == 3 and box:
                page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                for _ in range(6): page.mouse.wheel(0, 240); page.wait_for_timeout(30)   # défilement vertical
            elif k == 4 and box:
                page.keyboard.down("Control")
                for _ in range(3): page.mouse.wheel(0, -120); page.wait_for_timeout(40)   # zoom
                for _ in range(3): page.mouse.wheel(0, 120); page.wait_for_timeout(40)
                page.keyboard.up("Control")
            elif k == 5 and box:
                page.keyboard.down("Shift")
                for _ in range(6): page.mouse.wheel(0, 300); page.wait_for_timeout(30)   # défilement horizontal
                page.keyboard.up("Shift")
            ops += 1
            page.wait_for_timeout(120)
        res["edition"] = {"duree_s": edit_s, "gestes": ops, "images": page.evaluate(FRAMES_JS)}
        page.screenshot(path=str(OUT / "longue_02_fin.png"))
        h1 = heap()
        res["memoire_apres_edition_Mo"] = round(h1["used"], 1)
        page.evaluate("() => window.DAW_CONTROL.stop()")
        img = res["edition"]["images"]
        res["pire_image_edition_ms"] = img["max"]
        res["pire_image_lecture_ms"] = res["images_pendant_lecture"]["max"]
        # Fuite : tas après ramasse-miettes forcé, au début et à la fin des 10 min (les relevés sans
        # ramasse-miettes suivent la dent de scie normale du tas et ne disent rien d'une fuite).
        res["pente_gc_Mo_par_min"] = round(res["memoire_gc_ecart_Mo"] / max(1e-6, minutes), 3)
        # Image figée : critère sur l'ÉDITION (gestes de l'ingé) ; la lecture seule est relevée à part.
        res["ok"] = res["pente_gc_Mo_par_min"] < 0.5 and (img["max"] or 0) <= 100
    except Exception as e:  # noqa
        res["erreur"] = f"{type(e).__name__}: {str(e)[:400]}"
        try: page.screenshot(path=str(OUT / "longue_ECHEC.png"))
        except Exception: pass
    res["erreurs_console"] = [e["text"][:200] for e in log.errors() if "8765" not in e["text"] and "8766" not in e["text"]][:15]
    save("longue", res)
    ctx.close(); b.close()
    return res


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    which = [a for a in sys.argv[1:] if not a.startswith("-")] or ["recup", "undo", "longue"]
    allres = {}
    with sync_playwright() as p:
        if "undo" in which:
            r = epreuve_undo(p, n_ops=int(os.environ.get("QA_UNDO_OPS", "200")))
            save("undo", r); allres["undo"] = r
            print("UNDO", "OK" if r["ok"] else "ÉCHEC", json.dumps({k: r.get(k) for k in ("annuler_apres_ouverture", "operations", "annuler", "retablir", "erreur")}, ensure_ascii=False)[:1500], flush=True)
        if "recup" in which:
            for mode in ("onglet_tue", "onglet_ferme"):
                r = epreuve_recup(p, mode)
                save(f"recup_{mode}", r); allres[f"recup_{mode}"] = r
                print("RECUP", mode, "OK" if r["ok"] else "ÉCHEC", json.dumps({k: r.get(k) for k in ("recuperation_proposee", "prise_en_cours_s", "capte_jusqu_a_la_coupure_s", "prise_coupee_recuperee_s", "perte_prise_s", "pertes", "erreur")}, ensure_ascii=False)[:1500], flush=True)
        if "longue" in which:
            r = epreuve_longue(p, minutes=float(os.environ.get("QA_LONGUE_MIN", "10")), edit_s=float(os.environ.get("QA_LONGUE_EDIT_S", "60")))
            allres["longue"] = r
            print("LONGUE", "OK" if r["ok"] else "ÉCHEC", json.dumps({k: r.get(k) for k in ("session", "memoire_gc_debut_Mo", "memoire_gc_fin_Mo", "pente_gc_Mo_par_min", "pire_image_lecture_ms", "pire_image_edition_ms", "erreur")}, ensure_ascii=False), flush=True)
    ok = all(r.get("ok") for r in allres.values())
    print("TOUT OK" if ok else "ÉCHEC", "→", OUT)
    sys.exit(0 if ok else 1)
