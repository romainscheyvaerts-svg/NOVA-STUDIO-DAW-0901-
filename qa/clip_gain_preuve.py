"""Preuves R5 (gain de clip en ligne, crayon, Heal, boucle de clip), navigateur headless, aucune fenêtre.

  pc   : ligne de gain posée À LA SOURIS (clics sur la ligne, point tiré, Alt+clic), crayon
         (triangle sur le clip, tracé libre sur une ligne d'automation), nudge Ctrl+Maj+↑ ;
         export mesuré (niveau à chaque point à ±0,1 dB, partout le gain attendu), lecture
         réelle (capture de l'entrée de piste) = export, aucun clic aux points ; Heal (Ctrl+H)
         = son identique à l'original ; boucle tirée au bord (mode Boucle) mesurée, fenêtre
         « Boucler » avec fondus aux jonctions (pas de clic) ; Répéter (Alt+R) ; rendre le gain
         dans le fichier puis « Revenir » (même son) ; captures en sombre.
  clair: captures en thème clair (ligne, infos de gain, boucle, menu du crayon, menu du clip).
  tab  : tablette au doigt (crayon au doigt sur le clip), captures.
  tel  : téléphone, version simple (gain du clip ±1 dB), captures.

Usage : serveur `npx vite --port 3445 --strictPort` dans le worktree, puis
  python qa/clip_gain_preuve.py [pc] [clair] [tab] [tel]
Sorties : D:\\1 WORK\\CONTENU\\nova-r5\\
"""
import base64, io, json, math, os, sys, time, wave
from pathlib import Path

import numpy as np

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3445/")
os.environ["QA_OUT"] = r"D:\1 WORK\CONTENU\nova-r5"
sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa
from qalib import OUT, Log, new_page, shot, save_log  # noqa
import protools_edition as pe  # noqa
from playwright.sync_api import sync_playwright

SR = 44100
ZOOM = 40
ZOOMV = 120
H = ZOOMV - 4


def wav_bytes(x, sr=SR) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return buf.getvalue()


def voice_wav():
    t = np.arange(int(12 * SR)) / SR
    return wav_bytes(0.25 * np.sin(2 * np.pi * 220 * t))


def loop_wav():
    """1 s : un sinus qui ne se raccorde pas (331,7 Hz) + une rafale de bruit à 0,1 s (repère de chaque tour)."""
    n = SR
    t = np.arange(n) / SR
    x = 0.2 * np.sin(2 * np.pi * 331.7 * t + 0.4)
    rng = np.random.default_rng(7)
    i0 = int(0.1 * SR)
    x[i0:i0 + int(0.02 * SR)] += 0.5 * rng.standard_normal(int(0.02 * SR))
    return wav_bytes(x)


def project():
    f = OUT / "projet_r5.zip"
    lane = {"id": "lane-vol", "parameterName": "volume", "points": [], "color": "#22c55e", "isExpanded": True, "min": 0, "max": 1.5}
    pe.make_project(f, [
        pe.track("lead", "Voix lead", [pe.clip("v", "Prise 1", 1.0, 9.0, "audio/voix.wav", takeNumber=1)]),
        pe.track("boucle", "Boucle", [pe.clip("l", "Boucle", 1.0, 1.0, "audio/boucle.wav")], color="#f97316"),
        pe.track("auto", "Automation", [], color="#22c55e", automationLanes=[lane]),
    ], {"audio/voix.wav": voice_wav(), "audio/boucle.wav": loop_wav()}, "R5 gain de clip")
    return f


# ------------------------------------------------------------------ géométrie

def frac(db):
    if db >= 0:
        return 0.8 + 0.2 * min(1.0, db / 12)
    return 0.8 * (1 - min(1.0, db / -40))


def line_y(db, h=H):
    return 18 + max(4, h - 22) * (1 - frac(db))


def box(page):
    return pe.canvas_box(page)


def x_of(b, t):
    return b["x"] + t * ZOOM - b["sl"]


def lane_top(b, idx):
    return b["y"] + b["tt"] + idx * ZOOMV - b["st"]


def y_line(b, idx, db):
    return lane_top(b, idx) + 2 + line_y(db)


def st(page, expr):
    return page.evaluate(f"() => {{ const s = window.__novaEdit.getState(); return ({expr})(s); }}")


def clip_state(page, tid):
    return st(page, f"""s => s.tracks.find(t => t.id === '{tid}').clips.map(c => ({{ id: c.id, start: +c.start.toFixed(5), dur: +c.duration.toFixed(5), off: +(c.offset||0).toFixed(5),
      gain: +(c.gain ?? 1).toFixed(5), pts: (c.gainPoints || []).map(p => [+p.t.toFixed(4), +p.db.toFixed(3)]), loop: c.loop ? [c.loop.index, +c.loop.unit.toFixed(4)] : null,
      fi: +(c.fadeIn||0).toFixed(4), fo: +(c.fadeOut||0).toFixed(4), buf: c.bufferId, render: !!c.gainRender }})).sort((a, b) => a.start - b.start)""")


def close_overlays(page):
    for _ in range(2):
        page.keyboard.press("Escape"); page.wait_for_timeout(120)


def drag(page, x0, y0, x1, y1, steps=16, mods=()):
    for m in mods: page.keyboard.down(m)
    page.mouse.move(x0, y0); page.mouse.down()
    page.mouse.move(x1, y1, steps=steps)
    page.mouse.up()
    for m in mods: page.keyboard.up(m)
    page.wait_for_timeout(250)


def click(page, x, y, mods=()):
    for m in mods: page.keyboard.down(m)
    page.mouse.move(x, y); page.mouse.down(); page.mouse.up()
    for m in mods: page.keyboard.up(m)
    page.wait_for_timeout(250)


# ------------------------------------------------------------------- mesures

MEASURE_JS = r"""
async ([tid, dur]) => {
  const { audioEngine: e } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const F = await window.__novaAppModule('/utils/fades.ts');
  const s = window.__novaEdit.getState();
  const SR = e.ctx ? e.ctx.sampleRate : 44100;
  const raw = t => ({ ...t, plugins: [], sends: [], volume: 1, pan: 0, outputTrackId: undefined, automationLanes: [] });
  const t = s.tracks.find(x => x.id === tid);
  const flat = { ...t, clips: t.clips.map(c => ({ ...c, gainPoints: undefined, gain: 1, fadeIn: 0, fadeOut: 0 })) };
  const out = (await e.renderProject([raw(t)], dur, 0, SR)).getChannelData(0);
  const ref = (await e.renderProject([raw(flat)], dur, 0, SR)).getChannelData(0);
  const db = g => 20 * Math.log10(Math.max(g, 1e-9));
  // Gain mesuré autour d'un instant : moindres carrés (sortie / référence) sur ±1 ms.
  const gainAt = T => { const a = Math.round((T - 0.001) * SR), b = Math.round((T + 0.001) * SR); let num = 0, den = 0; for (let i = a; i <= b; i++) { num += out[i] * ref[i]; den += ref[i] * ref[i]; } return den > 0 ? num / den : 0; };
  const c = t.clips[0];
  const pts = (c.gainPoints || []).filter(p => p.t >= c.offset && p.t <= c.offset + c.duration);
  const g0 = db(c.gain ?? 1);
  const points = pts.map(p => { const T = c.start + (p.t - c.offset); const m = db(gainAt(T)); return { t: +T.toFixed(3), attendu_db: +(g0 + p.db).toFixed(3), mesure_db: +m.toFixed(3), ecart_db: +(m - g0 - p.db).toFixed(3) }; });
  // Partout dans le clip (pas de 5 ms) : gain mesuré vs gain prévu (utils/fades.clipGainAt).
  let worst = 0, n = 0;
  for (let T = c.start + 0.01; T < c.start + c.duration - 0.01; T += 0.005) {
    const g = gainAt(T), want = F.clipGainAt(c, T - c.start);
    if (want > 0.003) { worst = Math.max(worst, Math.abs(db(g) - db(want))); n++; }
  }
  // Clics : pas de gain d'un échantillon à l'autre (sortie / référence) et saut max autour de chaque point.
  let maxStep = 0, prev = null;
  for (let i = Math.round((c.start + 0.02) * SR); i < Math.round((c.start + c.duration - 0.02) * SR); i++) {
    if (Math.abs(ref[i]) > 0.08) { const g = out[i] / ref[i]; if (prev !== null) maxStep = Math.max(maxStep, Math.abs(g - prev)); prev = g; } else prev = null;
  }
  let worstJump = 0;
  for (const p of pts) {
    const T = c.start + (p.t - c.offset);
    const a = Math.round((T - 0.02) * SR), b = Math.round((T + 0.02) * SR);
    let jo = 0, gmax = 0;
    for (let i = a + 1; i < b; i++) { jo = Math.max(jo, Math.abs(out[i] - out[i - 1])); gmax = Math.max(gmax, Math.abs(gainAt(i / SR))); }
    let jr = 0; for (let i = a + 1; i < b; i++) jr = Math.max(jr, Math.abs(ref[i] - ref[i - 1]));
    if (jr > 0 && gmax > 0) worstJump = Math.max(worstJump, jo / (jr * gmax));
  }
  const toB64 = x => { const n = x.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf); const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), true);
    let bin = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(bin); };
  return { SR, gain_global_db: +g0.toFixed(3), points, ecart_max_partout_db: +worst.toFixed(4), mesures_partout: n,
           pas_de_gain_max_par_echantillon: +maxStep.toFixed(5), pire_rapport_sauts_aux_points: +worstJump.toFixed(3), wav: toB64(out) };
}
"""

LIVE_JS = r"""
async ([tid, dur]) => {
  const { audioEngine: e } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const R = await window.__novaAppModule('/engine/NovaRecorder.ts');
  const s = window.__novaEdit.getState();
  const SR = e.ctx.sampleRate;
  const raw = t => ({ ...t, plugins: [], sends: [], volume: 1, pan: 0, outputTrackId: undefined, automationLanes: [] });
  const tr = [raw(s.tracks.find(x => x.id === tid))];
  const exp = (await e.renderProject(tr, dur, 0, SR)).getChannelData(0);
  // Plans de gain programmés (setValueCurveAtTime) : lecture et export doivent être les mêmes.
  const plans = { live: [], exp: [] };
  const orig = AudioParam.prototype.setValueCurveAtTime;
  let mode = 'exp';
  AudioParam.prototype.setValueCurveAtTime = function (v, t, d) { plans[mode].push([+d.toFixed(6), v.length, +v[0].toFixed(6), +v[v.length - 1].toFixed(6)]); return orig.call(this, v, t, d); };
  await e.renderProject(tr, dur, 0, SR);
  mode = 'live';
  e.updateTrack(tr[0], tr);
  await new Promise(r => setTimeout(r, 300));
  const dsp = e.tracksDSP.get(tid);
  await R.ensureRecorderModule(e.ctx);
  const keep = e.ctx.createConstantSource(); keep.offset.value = 0; keep.connect(dsp.input); keep.start();
  const session = new R.NovaRecorderSession(e.ctx, dsp.input);
  await new Promise(r => setTimeout(r, 200));
  e.startPlayback(0, tr); const t0 = e.playbackStartTime;
  await new Promise(r => setTimeout(r, (dur + 0.5) * 1000));
  e.stopAll();
  AudioParam.prototype.setValueCurveAtTime = orig;
  const { samples, firstFrame } = await session.stop(dsp.input);
  keep.stop(); keep.disconnect();
  const shift = Math.round(t0 * SR) - firstFrame;
  const first = (arr, from) => { for (let i = from; i < arr.length; i++) if (Math.abs(arr[i]) > 1e-4) return i; return -1; };
  const f0 = first(samples, Math.max(0, shift - SR)), fe = first(exp, 0);
  const start = f0 >= 0 ? f0 - fe : shift;
  const live = samples.subarray(Math.max(0, start), Math.max(0, start) + exp.length);
  let maxDiff = 0, peak = 0;
  for (let i = 0; i < Math.min(live.length, exp.length); i++) { maxDiff = Math.max(maxDiff, Math.abs(live[i] - exp[i])); peak = Math.max(peak, Math.abs(exp[i])); }
  const rmsDb = (x, a, b) => { let q = 0; for (let i = a; i < b; i++) q += x[i] * x[i]; return 10 * Math.log10(Math.max(q / Math.max(1, b - a), 1e-20)); };
  const c = tr[0].clips[0];
  const pts = (c.gainPoints || []).filter(p => p.t >= c.offset && p.t <= c.offset + c.duration);
  const per = pts.map(p => { const T = c.start + (p.t - c.offset); const a = Math.round((T - 0.0025) * SR), b = Math.round((T + 0.0025) * SR);
    return { t: +T.toFixed(3), lecture_db: +rmsDb(live, a, b).toFixed(3), export_db: +rmsDb(exp, a, b).toFixed(3) }; });
  const same = plans.live.length === plans.exp.length && plans.live.every((p, i) => JSON.stringify(p) === JSON.stringify(plans.exp[i]));
  return { ecart_max_echantillon: +maxDiff.toExponential(3), crete_export: +peak.toFixed(4), points: per,
           ecart_max_points_db: +Math.max(0, ...per.map(x => Math.abs(x.lecture_db - x.export_db))).toFixed(4),
           courbes_programmees: { lecture: plans.live.length, export: plans.exp.length, identiques: same }, decalage_demarrage_ech: start - shift };
}
"""

RENDER_RAW = r"""
async ([tid, dur]) => {
  const { audioEngine: e } = await window.__novaAppModule('/engine/AudioEngine.ts');
  const s = window.__novaEdit.getState();
  const SR = e.ctx ? e.ctx.sampleRate : 44100;
  const t = s.tracks.find(x => x.id === tid);
  const b = await e.renderProject([{ ...t, plugins: [], sends: [], volume: 1, pan: 0, outputTrackId: undefined, automationLanes: [] }], dur, 0, SR);
  return Array.from(b.getChannelData(0));
}
"""


def render(page, tid, dur):
    return np.array(page.evaluate(RENDER_RAW, [tid, dur]), dtype=np.float64)


def save_wav(name, x):
    (OUT / name).write_bytes(wav_bytes(np.asarray(x)))


# ------------------------------------------------------------------ scénarios

def open_r5(page, label, theme="dark"):
    page.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); localStorage.setItem('nova_simple_mode', '0'); localStorage.removeItem('nova_clip_gain_view'); }} catch (e) {{}}")
    pe.open_project(page, project(), label)
    close_overlays(page)


def scenario_pc(page, res):
    open_r5(page, "pc_00_projet")
    b = box(page)
    page.mouse.click(x_of(b, 20), lane_top(b, 0) + 100); page.wait_for_timeout(200)
    # --- Ligne de gain affichée (bouton) ; Alt+G la masque / la remet.
    page.get_by_test_id("toggle-gain-line").click(); page.wait_for_timeout(200)
    res["ligne_affichee"] = page.get_by_test_id("toggle-gain-line").get_attribute("aria-pressed")
    page.keyboard.press("Alt+g"); page.wait_for_timeout(150)
    res["alt_g_masque"] = page.get_by_test_id("toggle-gain-line").get_attribute("aria-pressed")
    page.keyboard.press("Alt+g"); page.wait_for_timeout(150)
    res["alt_g_remet"] = page.get_by_test_id("toggle-gain-line").get_attribute("aria-pressed")
    b = box(page)
    # --- Points à la souris : clic sur la ligne (grille 1/4 = 0,5 s), point tiré vers −10 dB.
    for t in (3.0, 3.5, 5.0, 5.5):
        click(page, x_of(b, t), y_line(b, 0, 0))
    res["points_poses"] = clip_state(page, "lead")[0]["pts"]
    # Tirer le point de 3,5 s vers −10 dB : la ligne tient −10 jusqu'au point de 5 s, tiré lui aussi.
    drag(page, x_of(b, 3.5), y_line(b, 0, 0), x_of(b, 3.5), y_line(b, 0, -10))
    drag(page, x_of(b, 5.0), y_line(b, 0, 0), x_of(b, 5.0), y_line(b, 0, -10))
    # Un point de trop à 7 s, enlevé par Alt+clic.
    click(page, x_of(b, 7.0), y_line(b, 0, 0))
    n_avant = len(clip_state(page, "lead")[0]["pts"])
    click(page, x_of(b, 7.0), y_line(b, 0, 0), mods=("Alt",))
    res["alt_clic_enleve"] = {"avant": n_avant, "apres": len(clip_state(page, "lead")[0]["pts"])}
    shot(page, "pc_01_ligne_de_gain_points")
    # --- Crayon (forme triangle) sur le clip, de 6,5 s à 8,5 s entre 0 et −12 dB.
    page.get_by_test_id("tool-pencil").click(); page.wait_for_timeout(150)
    page.get_by_test_id("pencil-shape").click(); page.wait_for_timeout(200)
    shot(page, "pc_02_formes_du_crayon")
    page.get_by_test_id("pencil-shape-triangle").click(); page.wait_for_timeout(150)
    drag(page, x_of(b, 6.5), y_line(b, 0, 0), x_of(b, 8.5), y_line(b, 0, -12), steps=24)
    res["apres_crayon_triangle"] = clip_state(page, "lead")[0]["pts"]
    # --- Crayon libre sur la ligne d'automation (volume) de la piste « Automation ».
    page.get_by_test_id("pencil-shape").click(); page.wait_for_timeout(150)
    page.get_by_test_id("pencil-shape-free").click(); page.wait_for_timeout(150)
    ly = lane_top(b, 2) + ZOOMV
    page.mouse.move(x_of(b, 2), ly + 15); page.mouse.down()
    for k in range(1, 41):
        page.mouse.move(x_of(b, 2 + 4 * k / 40), ly + 15 + 45 * (0.5 - 0.5 * math.cos(math.pi * k / 40)))
    page.mouse.up(); page.wait_for_timeout(300)
    res["automation_crayon"] = st(page, "s => { const l = s.tracks.find(t => t.id === 'auto').automationLanes[0]; return { points: l.points.length, premier: l.points[0] && [+l.points[0].time.toFixed(2), +l.points[0].value.toFixed(3)], dernier: l.points.length && [+l.points[l.points.length-1].time.toFixed(2), +l.points[l.points.length-1].value.toFixed(3)] }; }")
    shot(page, "pc_03_crayon_clip_et_automation")
    page.get_by_test_id("tool-pencil").click(); page.wait_for_timeout(150)   # retour au Smart Tool
    # --- Nudge : clip sélectionné, Ctrl+Maj+↑ deux fois = +1 dB.
    page.mouse.click(x_of(b, 9.5), lane_top(b, 0) + 100); page.wait_for_timeout(200)
    for _ in range(2):
        page.keyboard.press("Control+Shift+ArrowUp"); page.wait_for_timeout(150)
    res["gain_apres_nudge_db"] = round(20 * math.log10(clip_state(page, "lead")[0]["gain"]), 3)
    page.keyboard.press("Control+Alt+Shift+ArrowDown"); page.wait_for_timeout(150)
    res["gain_apres_nudge_fin_db"] = round(20 * math.log10(clip_state(page, "lead")[0]["gain"]), 3)
    # Gain sur la plage (Pro Tools : Clip Gain sur la sélection) : 9,0 → 9,5 s, Ctrl+Maj+↓ ×2 = −1 dB.
    page.evaluate("() => window.__novaEdit.selectRange(9.0, 9.5, ['lead'])"); page.wait_for_timeout(150)
    for _ in range(2):
        page.keyboard.press("Control+Shift+ArrowDown"); page.wait_for_timeout(150)
    page.evaluate("() => window.__novaEdit.clearSelection()"); page.wait_for_timeout(150)
    res["gain_sur_la_plage"] = [p for p in clip_state(page, "lead")[0]["pts"] if p[0] >= 7.9]
    shot(page, "pc_04_infos_de_gain")
    # --- Export mesuré
    m = page.evaluate(MEASURE_JS, ["lead", 11.0])
    (OUT / "export_ligne_de_gain.wav").write_bytes(base64.b64decode(m.pop("wav")))
    res["export"] = m
    # --- Lecture réelle = export
    res["lecture_vs_export"] = page.evaluate(LIVE_JS, ["lead", 11.0])
    # --- Heal : couper à 4,25 s puis recoller (Ctrl+H) : son identique à l'original.
    before = render(page, "lead", 11.0)
    page.evaluate("async () => (await window.__novaAppModule('/utils/playheadStore.ts')).playheadStore.set(4.25)")
    page.mouse.click(x_of(b, 9.5), lane_top(b, 0) + 100); page.wait_for_timeout(200)
    page.evaluate("async () => (await window.__novaAppModule('/utils/playheadStore.ts')).playheadStore.set(4.25)")
    page.keyboard.press("s"); page.wait_for_timeout(300)
    coupe = clip_state(page, "lead")
    page.mouse.click(x_of(b, 20), lane_top(b, 0) + 100); page.wait_for_timeout(200)   # plus de sélection
    page.evaluate("async () => (await window.__novaAppModule('/utils/playheadStore.ts')).playheadStore.set(4.25)")
    shot(page, "pc_05_avant_heal_coupe")
    page.keyboard.press("Control+h"); page.wait_for_timeout(400)
    recolle = clip_state(page, "lead")
    after = render(page, "lead", 11.0)
    save_wav("heal_avant.wav", before); save_wav("heal_apres.wav", after)
    res["heal"] = {"morceaux_apres_coupe": len(coupe), "clips_apres_heal": len(recolle), "clip": recolle[0] if recolle else None,
                   "ecart_max_echantillon_vs_original": float(np.max(np.abs(after - before))), "message": page.locator("text=Heal").first.inner_text() if page.locator("text=Heal :").count() else None}
    shot(page, "pc_06_apres_heal")
    # --- Rendre le gain dans le fichier, puis Revenir : même son.
    page.mouse.click(x_of(b, 9.5), lane_top(b, 0) + 100, button="right"); page.wait_for_timeout(300)
    shot(page, "pc_07_menu_du_clip")
    qalib.menu_pick(page, "Rendre le gain dans le fichier"); page.wait_for_timeout(500)
    rendu = clip_state(page, "lead")[0]
    x_rendu = render(page, "lead", 11.0)
    page.mouse.click(x_of(b, 9.5), lane_top(b, 0) + 100, button="right"); page.wait_for_timeout(300)
    qalib.menu_pick(page, "Revenir au gain d"); page.wait_for_timeout(400)
    revenu = clip_state(page, "lead")[0]
    x_revenu = render(page, "lead", 11.0)
    res["rendre_le_gain"] = {"clip_rendu": {k: rendu[k] for k in ("gain", "pts", "render")}, "ecart_max_rendu_vs_ligne": float(np.max(np.abs(x_rendu - after))),
                             "clip_revenu": {k: revenu[k] for k in ("gain", "render")}, "points_revenus": len(revenu["pts"]), "ecart_max_revenu": float(np.max(np.abs(x_revenu - after)))}
    # --- Boucle : mode Boucle, tirer le bord droit du clip (1 s → 5,5 s).
    page.get_by_test_id("toggle-loop-trim").click(); page.wait_for_timeout(150)
    sans = render(page, "boucle", 7.0)
    drag(page, x_of(b, 2.0) - 2, lane_top(b, 1) + 2 + 0.8 * H, x_of(b, 5.5), lane_top(b, 1) + 2 + 0.8 * H, steps=20)
    tours = clip_state(page, "boucle")
    xb = render(page, "boucle", 7.0)
    save_wav("boucle_tiree.wav", xb)
    src = np.array(sans[int(1.0 * SR):int(2.0 * SR)])
    burst = src[int(0.09 * SR):int(0.13 * SR)]
    onsets = []
    for k, c in enumerate(tours):
        a = int((c["start"] + 0.05) * SR); seg = xb[a:a + int(0.1 * SR)]
        if len(seg) < len(burst): continue
        cor = np.correlate(seg, burst, mode="valid")
        i = int(np.argmax(cor))
        onsets.append(round((a + i) / SR - (c["start"] + 0.09), 6))
    res["boucle_tiree"] = {"iterations": [(c["start"], c["dur"], c["loop"]) for c in tours], "decalage_rafale_par_tour_s": onsets,
                           "niveau_par_tour_db": [round(pe.rms_db(xb[int((c['start'] + 0.15) * SR):int((c['start'] + 0.45) * SR)]), 3) for c in tours]}
    shot(page, "pc_08_boucle_tiree")
    # Jonctions sans fondu : le son d'origine ne se raccorde pas (saut) ; fenêtre Boucler avec fondus 5 ms.
    def junction_jumps(x, cl):
        return [round(pe.max_step(x[int((c["start"] - 0.004) * SR):int((c["start"] + 0.004) * SR)]), 4) for c in cl[1:]]
    sauts_sans = junction_jumps(xb, tours)
    page.mouse.click(x_of(b, 1.4), lane_top(b, 1) + 100); page.wait_for_timeout(200)
    page.keyboard.press("Control+Alt+l"); page.wait_for_timeout(300)
    dlg = page.get_by_test_id("loop-dialog")
    res["fenetre_boucler"] = dlg.is_visible()
    dlg.locator("input[type=number]").fill("3")
    dlg.locator("select").select_option("5")
    shot(page, "pc_09_fenetre_boucler")
    page.get_by_test_id("loop-dialog-ok").click(); page.wait_for_timeout(400)
    tours2 = clip_state(page, "boucle")
    xb2 = render(page, "boucle", 7.0)
    save_wav("boucle_fondus_5ms.wav", xb2)
    sauts_avec = junction_jumps(xb2, tours2)
    regime = round(pe.max_step(xb2[int(1.3 * SR):int(1.6 * SR)]), 4)
    res["boucle_fondus"] = {"iterations": [(c["start"], c["dur"], c["fi"], c["fo"]) for c in tours2], "saut_max_jonctions_sans_fondu": sauts_sans,
                            "saut_max_jonctions_fondus_5ms": sauts_avec, "saut_max_sinus_en_regime": regime}
    shot(page, "pc_10_boucle_fondus")
    # --- Répéter (Alt+R) : 2 copies de la prise de voix, collées à la suite.
    page.mouse.click(x_of(b, 9.5), lane_top(b, 0) + 100); page.wait_for_timeout(200)
    n0 = len(clip_state(page, "lead"))
    page.keyboard.press("Alt+r"); page.wait_for_timeout(300)
    res["fenetre_repeter"] = page.get_by_test_id("repeat-dialog").is_visible()
    page.get_by_test_id("repeat-dialog").locator("input[type=number]").fill("2")
    page.get_by_test_id("repeat-dialog-ok").click(); page.wait_for_timeout(300)
    rep = clip_state(page, "lead")
    res["repeter"] = {"avant": n0, "apres": len(rep), "debuts": [c["start"] for c in rep], "lignes_copiees": [len(c["pts"]) for c in rep]}
    page.evaluate("() => { const sc = document.querySelector('.nova-grille .custom-scroll'); if (sc) sc.scrollLeft = 0; }")
    page.locator('.nova-grille input[type=range]').first.fill('20'); page.wait_for_timeout(300)
    shot(page, "pc_11_repeter")
    page.locator('.nova-grille input[type=range]').first.fill('40'); page.wait_for_timeout(300)
    # --- Annuler (Ctrl+Z) défait Répéter en une étape.
    page.keyboard.press("Control+z"); page.wait_for_timeout(400)
    res["annuler_repeter"] = len(clip_state(page, "lead"))
    # --- Verdict
    e = res["export"]; lv = res["lecture_vs_export"]; hl = res["heal"]; bt = res["boucle_tiree"]; bf = res["boucle_fondus"]
    res["verdict"] = {
        "ligne_a_la_souris": len(res["points_poses"]) == 4 and res["alt_clic_enleve"]["apres"] == res["alt_clic_enleve"]["avant"] - 1,
        "crayon_clip": len(res["apres_crayon_triangle"]) > len(res["points_poses"]) + 4,
        "crayon_automation": res["automation_crayon"]["points"] >= 3 and res["automation_crayon"]["premier"][1] > 1.0 and 0.02 < res["automation_crayon"]["dernier"][1] < 0.2,
        "nudge": abs(res["gain_apres_nudge_db"] - 1.0) < 1e-3 and abs(res["gain_apres_nudge_fin_db"] - 0.9) < 1e-3,
        "gain_sur_la_plage": [p[1] for p in res["gain_sur_la_plage"]] == [0, -1.0, -1.0, 0] and [p[0] for p in res["gain_sur_la_plage"]] == [7.995, 8.0, 8.5, 8.505],
        "points_a_0_1_dB": all(abs(p["ecart_db"]) <= 0.1 for p in e["points"]) and len(e["points"]) > 0,
        "gain_partout_0_1_dB": e["ecart_max_partout_db"] <= 0.1,
        "pas_de_clic": e["pas_de_gain_max_par_echantillon"] < 0.01 and e["pire_rapport_sauts_aux_points"] <= 1.05,
        "lecture_egale_export": lv["courbes_programmees"]["identiques"] and lv["ecart_max_points_db"] <= 0.1,
        "heal_identique": hl["morceaux_apres_coupe"] == 2 and hl["clips_apres_heal"] == 1 and hl["ecart_max_echantillon_vs_original"] < 1e-6,
        "rendre_puis_revenir_meme_son": res["rendre_le_gain"]["ecart_max_rendu_vs_ligne"] < 2e-3 and res["rendre_le_gain"]["ecart_max_revenu"] < 1e-6,
        "boucle_tours_exacts": len(bt["iterations"]) == 5 and all(abs(o) <= 1.5 / SR for o in bt["decalage_rafale_par_tour_s"]) and max(bt["niveau_par_tour_db"]) - min(bt["niveau_par_tour_db"]) < 0.05,
        "fondus_jonctions_sans_clic": max(bf["saut_max_jonctions_fondus_5ms"]) <= 1.05 * bf["saut_max_sinus_en_regime"],
        "repeter": res["repeter"]["apres"] == res["repeter"]["avant"] + 2 and res["annuler_repeter"] == res["repeter"]["avant"],
    }


def scenario_clair(page, res):
    open_r5(page, "clair_00_projet", theme="light")
    page.evaluate("""() => {
      const ed = window.__novaEdit;
      ed.patchClips('lead', { v: { gainPoints: [{ t: 1, db: 0 }, { t: 2.5, db: 0 }, { t: 3, db: -9 }, { t: 5, db: -9, curve: 0.5 }, { t: 6, db: 3 }, { t: 7, db: 3 }, { t: 7.5, db: -4 }] } });
    }""")
    b = box(page)
    page.get_by_test_id("toggle-gain-line").click(); page.wait_for_timeout(200)
    page.get_by_test_id("toggle-loop-trim").click(); page.wait_for_timeout(150)
    drag(page, x_of(b, 2.0) - 2, lane_top(b, 1) + 2 + 0.8 * H, x_of(b, 4.5), lane_top(b, 1) + 2 + 0.8 * H, steps=12)
    page.mouse.move(x_of(b, 6.5), y_line(b, 0, 3)); page.wait_for_timeout(300)
    shot(page, "clair_01_ligne_infos_boucle")
    page.get_by_test_id("pencil-shape").click(); page.wait_for_timeout(200)
    shot(page, "clair_02_formes_du_crayon")
    close_overlays(page)
    page.mouse.click(x_of(b, 9.5), lane_top(b, 0) + 100, button="right"); page.wait_for_timeout(300)
    shot(page, "clair_03_menu_du_clip")
    close_overlays(page)
    res["boucle"] = len(clip_state(page, "boucle"))


def scenario_tab(page, res):
    open_r5(page, "tab_00_projet")
    b = box(page)
    page.get_by_test_id("toggle-gain-line").tap(); page.wait_for_timeout(200)
    page.get_by_test_id("tool-pencil").tap(); page.wait_for_timeout(200)
    page.get_by_test_id("pencil-shape").tap(); page.wait_for_timeout(200)
    page.get_by_test_id("pencil-shape-line").tap(); page.wait_for_timeout(200)
    res["outils_au_doigt"] = page.evaluate("() => ['tool-pencil','pencil-shape','toggle-gain-line'].map(id => { const r = document.querySelector(`[data-testid=${id}]`).getBoundingClientRect(); return [id, Math.round(r.width), Math.round(r.height)]; })")
    cdp = page.context.new_cdp_session(page)
    x0, y0, x1, y1 = x_of(b, 2.0), y_line(b, 0, 0), x_of(b, 6.0), y_line(b, 0, -15)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x0, "y": y0}]})
    for k in range(1, 13):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x0 + (x1 - x0) * k / 12, "y": y0 + (y1 - y0) * k / 12}]})
        page.wait_for_timeout(20)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    page.wait_for_timeout(400)
    res["crayon_au_doigt"] = clip_state(page, "lead")[0]["pts"]
    res["page_n_a_pas_defile"] = box(page)["sl"] == b["sl"] and box(page)["st"] == b["st"]
    shot(page, "tab_01_crayon_au_doigt")
    res["ok"] = res.get("ok", True) and len(res["crayon_au_doigt"]) >= 2


def scenario_tel(page, res):
    open_r5(page, "tel_00_projet")
    page.wait_for_timeout(800)
    clip = page.locator("[data-clip-id=v]").first
    clip.tap(); page.wait_for_timeout(400)
    g = page.get_by_test_id("mobile-clip-gain")
    res["controle_visible"] = g.is_visible()
    shot(page, "tel_01_clip_selectionne")
    g.get_by_label("Monter le gain du clip d’1 dB").tap(); page.wait_for_timeout(200)
    g.get_by_label("Monter le gain du clip d’1 dB").tap(); page.wait_for_timeout(200)
    g.get_by_label("Baisser le gain du clip d’1 dB").tap(); page.wait_for_timeout(200)
    res["gain_db"] = round(20 * math.log10(clip_state(page, "lead")[0]["gain"]), 3)
    res["texte"] = g.inner_text()
    shot(page, "tel_02_gain_plus_1_dB")
    res["ok"] = res.get("ok", True) and abs(res["gain_db"] - 1.0) < 1e-3


SCENARIOS = {"pc": scenario_pc, "clair": scenario_clair, "tab": scenario_tab, "tel": scenario_tel}


def main(names):
    summary = {}
    with sync_playwright() as p:
        br = pe.launch(p)
        for n in names:
            log = Log(f"r5_{n}")
            res = {"name": n, "ok": True}
            vp = "tab" if n == "tab" else "tel" if n == "tel" else "pc"
            ctx, page = new_page(br, vp, log, touch=(n in ("tab", "tel")))
            t = time.time()
            try:
                SCENARIOS[n](page, res)
            except Exception as e:  # noqa
                res["ok"] = False
                res["exception"] = f"{type(e).__name__}: {str(e)[:800]}"
                try: shot(page, f"{n}__ECHEC")
                except Exception: pass
            if "verdict" in res:
                res["ok"] = res["ok"] and all(res["verdict"].values())
            res["secs"] = round(time.time() - t, 1)
            res["erreurs_page"] = [e["text"][:300] for e in log.errors()][:20]
            save_log(log, {"result": res})
            (OUT / f"mesures_{n}.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
            summary[n] = res
            ctx.close()
        br.close()
    print(json.dumps(summary, ensure_ascii=False, indent=1)[:12000])


if __name__ == "__main__":
    main([a for a in sys.argv[1:] if a in SCENARIOS] or list(SCENARIOS))
