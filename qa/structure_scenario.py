"""Scénario « session à la LENNON » dans NOVA (navigateur headless, aucune fenêtre).

Session de démonstration : dossier de routage VOX (LEAD A, LEAD A 2, LEAD A BUS à
l'écoute du bus nommé « LEAD A »), BACK B masquée et inactive (prête à servir),
dossier simple SEND FX (retours RV, DL 1/4, DOUBLER), ALL VOX à l'écoute du bus
« VOX ALL », VCA « PRE ALL VOX », dossier BEAT masqué et inactif. Sur LEAD A :
Auto-Tune en bypass, compresseur actif, saturation inactive.

Gestes : « Prête » (afficher et activer) BACK B en un clic, Ctrl+Alt+clic sur la
saturation inactive (réactivée), Ctrl+clic (bypass), VCA, Send View, bus nommés.
Export mesuré avant / après. Captures PC, tablette, téléphone, clair et sombre.

NOVA_URL=http://127.0.0.1:3438/ PYTHONIOENCODING=utf-8 python qa/structure_scenario.py
"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(__file__))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-structure")
os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3438/")
from qalib import launch, new_page, OUT  # noqa: E402
from scenarios import open_studio  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

INJECT = r"""
async () => {
  const { TrackType } = await import('/types.ts');
  const S = await import('/utils/trackStructure.ts');
  const { structureBus } = await import('/utils/structureBus.ts');
  const { audioBufferRegistry } = await import('/utils/audioBufferRegistry.ts');
  const SR = 44100;
  // Sons de démonstration : une note par piste (fréquences différentes), 8 s.
  const tone = (id, f, at, amp = 0.25) => { const b = new AudioBuffer({ length: SR * 8, numberOfChannels: 1, sampleRate: SR }); const x = b.getChannelData(0);
    for (let i = Math.floor(at * SR); i < x.length; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / SR); audioBufferRegistry.register(b, id); return id; };
  const clip = (id, name, f, at = 0) => ({ id, name, type: TrackType.AUDIO, start: 0, duration: 8, offset: 0, fadeIn: 0, fadeOut: 0, color: '#3b82f6', bufferId: tone(`buf-${id}`, f, at) });
  const fx = (id, type, name, extra = {}) => ({ id, type, name, isEnabled: true, params: {}, latency: 0, ...extra });
  const T = (id, name, type, extra = {}) => ({ id, name, type, color: '#3b82f6', isMuted: false, isSolo: false, isTrackArmed: false, isFrozen: false,
    volume: 1, pan: 0, outputTrackId: 'master', sends: [], clips: [], plugins: [], automationLanes: [], totalLatency: 0, ...extra });
  let tr = [
    T('kick', 'KICK', TrackType.AUDIO, { color: '#be8911' }), T('808', '808', TrackType.AUDIO, { color: '#be8911' }),
    T('instru', 'INSTRU', TrackType.AUDIO, { color: '#22c55e', clips: [clip('c-instru', 'Instru', 110)], volume: 0.7 }),
    T('lead', 'LEAD A', TrackType.AUDIO, { color: '#3b82f6', clips: [clip('c-lead', 'Prise 1', 440)],
      plugins: [fx('pl-tune', 'AUTOTUNE', 'Auto-Tune', { isEnabled: false }), fx('pl-comp', 'COMPRESSOR', 'Compresseur'), fx('pl-sat', 'VOCALSATURATOR', 'Saturation', { isInactive: true })],
      sends: [{ id: 'rv', level: 0.32, isEnabled: true, slot: 0 }, { id: 'dl', level: 0.16, isEnabled: true, pan: -0.4, slot: 1 }, { id: 'dbl', level: 0.5, isEnabled: true, isMuted: true, slot: 2 }] }),
    T('lead2', 'LEAD A 2', TrackType.AUDIO, { color: '#60a5fa', volume: 0.5, clips: [clip('c-lead2', 'Double', 660)], sends: [{ id: 'rv', level: 0.25, isEnabled: true, slot: 0 }] }),
    T('leadbus', 'LEAD A BUS', TrackType.BUS, { color: '#3b82f6', plugins: [fx('pl-bcomp', 'COMPRESSOR', 'Compresseur bus')] }),
    T('backb', 'BACK B', TrackType.AUDIO, { color: '#a855f7', isHidden: true, isInactive: true, clips: [clip('c-backb', 'Back B', 880, 4)] }),
    T('rv', 'RV', TrackType.SEND, { color: '#10b981', plugins: [fx('pl-rv', 'REVERB', 'Reverb', { params: { decay: 1.6, mix: 1 } })] }),
    T('dl', 'DL 1/4', TrackType.SEND, { color: '#00f2ff', plugins: [fx('pl-dl', 'DELAY', 'Delay 1/4', { params: { division: '1/4', feedback: 0.3, mix: 1 } })] }),
    T('dbl', 'DOUBLER', TrackType.SEND, { color: '#f97316', plugins: [fx('pl-dbl', 'DOUBLER', 'Doubler')] }),
    T('allvox', 'ALL VOX', TrackType.BUS, { color: '#f59e0b' }),
    T('master', 'MASTER', TrackType.BUS, { color: '#00f2ff', outputTrackId: '' }),
  ];
  tr = S.createFolder(tr, { id: 'beat', name: 'BEAT', kind: 'basic', childIds: ['kick', '808'] });
  tr = S.setTracksInactive(S.setTracksHidden(tr, ['beat'], true), ['beat'], true);
  tr = S.createFolder(tr, { id: 'vox', name: 'VOX', kind: 'routing', childIds: ['lead', 'lead2', 'leadbus', 'backb'] });
  tr = S.createFolder(tr, { id: 'sendfx', name: 'SEND FX', kind: 'basic', childIds: ['rv', 'dl', 'dbl'] });
  let r = S.createBus(tr, 'LEAD A'); tr = r.tracks; const busLead = r.bus;
  r = S.createBus(tr, 'VOX ALL'); tr = r.tracks; const busAll = r.bus;
  tr = S.setTrackInputBus(tr, 'leadbus', busLead.id);
  tr = S.setTrackInputBus(tr, 'allvox', busAll.id);
  tr = S.setTrackOutput(tr, 'lead', { kind: 'bus', id: busLead.id });
  tr = S.setTrackOutput(tr, 'lead2', { kind: 'bus', id: busLead.id });
  tr = S.setTrackOutput(tr, 'vox', { kind: 'bus', id: busAll.id });
  tr = S.createVca(tr, { id: 'vca', name: 'PRE ALL VOX', memberIds: ['lead', 'lead2'] });
  structureBus.emit({ kind: 'tracks', apply: () => tr });
  return tr.map(t => t.name);
}
"""

CAPTURE = r"""
async () => {
  const { structureBus } = await import('/utils/structureBus.ts');
  let got = null;
  structureBus.emit({ kind: 'tracks', apply: ts => { got = ts; return ts; } });
  // React applique la mise à jour au rendu suivant : on l'attend.
  for (let i = 0; i < 100 && !got; i++) await new Promise(r => setTimeout(r, 20));
  window.__capTracks = got;
  const S = await import('/utils/trackStructure.ts');
  const v = S.engineView(got);
  return { joue: v.tracks.map(t => t.name), hors_moteur: got.filter(t => v.excluded.has(t.id)).map(t => t.name),
    masquees: got.filter(t => t.isHidden).map(t => t.name),
    effets_lead: (got.find(t => t.id === 'lead')?.plugins || []).map(p => `${p.name}:${S.pluginState(p)}`) };
}
"""

EXPORT = r"""
async () => {
  const { audioEngine } = await import('/engine/AudioEngine.ts');
  const tracks = window.__capTracks;
  const SR = 44100;
  const b = await audioEngine.renderProject(tracks, 6, 0, SR);
  const rms = (a, z) => { const x = b.getChannelData(0); let s = 0, n = 0; for (let i = Math.floor(a * SR); i < Math.floor(z * SR); i++) { s += x[i] * x[i]; n++; } return Math.round(Math.sqrt(s / Math.max(1, n)) * 10000) / 10000; };
  // BACK B entre à 4 s (880 Hz) : on mesure le niveau avant et après 4 s, et la part à 880 Hz (Goertzel).
  const goertzel = (f, a, z) => { const x = b.getChannelData(0); const k = 2 * Math.cos(2 * Math.PI * f / SR); let s1 = 0, s2 = 0; const i0 = Math.floor(a * SR), i1 = Math.floor(z * SR);
    for (let i = i0; i < i1; i++) { const s0 = x[i] + k * s1 - s2; s2 = s1; s1 = s0; } const p = s1 * s1 + s2 * s2 - k * s1 * s2; return Math.round(Math.sqrt(Math.max(0, p)) / (i1 - i0) * 2 * 10000) / 10000; };
  return { rms_1_3s: rms(1, 3), rms_4_6s: rms(4, 6), backb_880hz_4_6s: goertzel(880, 4.2, 5.8), lead_440hz_1_3s: goertzel(440, 1.2, 2.8) };
}
"""


def shot(pg, name):
    pg.screenshot(path=str(OUT / f"{name}.png"))


def setup(pg, theme, simple):
    pg.add_init_script(f"try {{ localStorage.setItem('nova_theme', '{theme}'); localStorage.setItem('nova_simple_mode', '{'1' if simple else '0'}'); }} catch (e) {{}}")


def run_pc(b, theme, res):
    ctx, pg = new_page(b, "pc")
    setup(pg, theme, False)
    r = res.setdefault(f"pc_{theme}", {"name": f"pc_{theme}"})
    open_studio(pg, r)
    r["pistes"] = pg.evaluate(INJECT)
    pg.wait_for_timeout(1500)
    pg.keyboard.press("Escape"); pg.mouse.click(5, 5)
    r["avant"] = pg.evaluate(CAPTURE)
    shot(pg, f"pc_{theme}_01_edition")
    if theme == "dark":
        r["export_avant"] = pg.evaluate(EXPORT)
    # Liste des pistes : BACK B masquée et inactive → « Prête » en un clic.
    pg.get_by_test_id("dock-track-list").click(); pg.wait_for_timeout(600)
    shot(pg, f"pc_{theme}_02_liste_des_pistes")
    pg.get_by_test_id("tracklist-filter-hidden").click(); pg.wait_for_timeout(300)
    shot(pg, f"pc_{theme}_03_liste_filtre_masquees")
    pg.get_by_test_id("tracklist-filter-all").click(); pg.wait_for_timeout(200)
    pg.get_by_test_id("tracklist-ready-backb").click(); pg.wait_for_timeout(800)
    r["apres_backb"] = pg.evaluate(CAPTURE)
    shot(pg, f"pc_{theme}_04_backb_prete")
    pg.get_by_role("button", name="Fermer").first.click(); pg.wait_for_timeout(300)
    # Effet inactif réactivé (Ctrl+Alt+clic), puis bypass (Ctrl+clic) sur le compresseur.
    sat = pg.locator("[data-testid='inserts-lead'] [data-fx-state='inactive']").first
    r["chip_inactif_visible"] = sat.count() > 0
    shot(pg, f"pc_{theme}_05_effets_lead")
    if sat.count():
        # (la pastille peut être rangée dans « +N » : clic envoyé directement, Ctrl+Alt comme au clavier)
        sat.dispatch_event("click", {"ctrlKey": True, "altKey": True, "bubbles": True}); pg.wait_for_timeout(600)
    comp = pg.locator("[data-testid='inserts-lead'] button[data-fx-state='active']").first
    if comp.count():
        comp.dispatch_event("click", {"ctrlKey": True, "bubbles": True}); pg.wait_for_timeout(600)
    r["apres_effets"] = pg.evaluate(CAPTURE)
    shot(pg, f"pc_{theme}_06_effets_apres")
    # Menu de l'effet (clic droit) : Actif / Bypass / Inactif.
    chip = pg.locator("[data-testid='inserts-lead'] .fx-slot button").first
    chip.click(button="right"); pg.wait_for_timeout(400)
    shot(pg, f"pc_{theme}_07_menu_effet")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
    if theme == "dark":
        r["export_apres"] = pg.evaluate(EXPORT)
    # Console : VCA, dossiers, entrées / sorties, Send View, bus nommés.
    pg.get_by_role("button", name="Console", exact=True).first.click(); pg.wait_for_timeout(1200)
    shot(pg, f"pc_{theme}_08_console")
    vca = pg.get_by_test_id("vca-fader-vca")
    if vca.count():
        vca.scroll_into_view_if_needed(); vca.fill("-6"); pg.wait_for_timeout(500)
        r["vca"] = pg.evaluate(CAPTURE)
        r["vca_volume_lead_effectif"] = pg.evaluate("async () => { const S = await import('/utils/trackStructure.ts'); return S.engineView(window.__capTracks).byId.get('lead').volume; }")
        shot(pg, f"pc_{theme}_09_vca")
    pg.get_by_test_id("send-view-picker").select_option("2"); pg.wait_for_timeout(600)
    pg.locator("[data-strip-id]").first.scroll_into_view_if_needed()
    pg.evaluate("() => { const c = document.querySelector('.snap-x'); if (c) c.scrollLeft = 0; }"); pg.wait_for_timeout(300)
    shot(pg, f"pc_{theme}_10_send_view_c")
    pg.get_by_test_id("send-view-picker").select_option(""); pg.wait_for_timeout(300)
    opener = pg.get_by_test_id("sends-open-lead")
    if opener.count():
        opener.scroll_into_view_if_needed(); opener.click(); pg.wait_for_timeout(500)
        shot(pg, f"pc_{theme}_11_envois_a_j")
        pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
    pg.get_by_test_id("mixer-open-buses").click(); pg.wait_for_timeout(500)
    shot(pg, f"pc_{theme}_12_bus_nommes")
    r["erreurs"] = [e for e in pg._blocked][:3]
    ctx.close()


def long_press(pg, loc):
    box = loc.bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    loc.dispatch_event("pointerdown", {"pointerType": "touch", "clientX": x, "clientY": y, "bubbles": True, "isPrimary": True})
    pg.wait_for_timeout(750)
    loc.dispatch_event("pointerup", {"pointerType": "touch", "clientX": x, "clientY": y, "bubbles": True})
    pg.wait_for_timeout(300)


def run_tab(b, theme, res):
    ctx, pg = new_page(b, "tab")
    setup(pg, theme, False)
    r = res.setdefault(f"tab_{theme}", {"name": f"tab_{theme}"})
    open_studio(pg, r, vp="tab")
    pg.evaluate(INJECT); pg.wait_for_timeout(1500)
    shot(pg, f"tab_{theme}_01_edition")
    chip = pg.locator("[data-testid='inserts-lead'] .fx-slot button").first
    if chip.count():
        long_press(pg, chip)
        r["menu_appui_long"] = pg.get_by_test_id("structure-menu").count() > 0
        shot(pg, f"tab_{theme}_02_appui_long_effet")
        pg.keyboard.press("Escape"); pg.wait_for_timeout(200)
    dock = pg.get_by_test_id("dock-track-list")
    if dock.count():
        dock.click(); pg.wait_for_timeout(600)
        row = pg.get_by_test_id("tracklist-row-lead2")
        if row.count():
            long_press(pg, row)
            shot(pg, f"tab_{theme}_03_liste_appui_long")
            pg.keyboard.press("Escape")
    ctx.close()


def run_tel(b, theme, res):
    ctx, pg = new_page(b, "tel")
    setup(pg, theme, True)
    r = res.setdefault(f"tel_{theme}", {"name": f"tel_{theme}"})
    open_studio(pg, r, vp="tel")
    pg.evaluate(INJECT); pg.wait_for_timeout(1500)
    shot(pg, f"tel_{theme}_01_pistes")
    btn = pg.get_by_test_id("mobile-hidden-tracks")
    r["bouton_pistes_masquees"] = btn.inner_text() if btn.count() else None
    if btn.count():
        btn.click(); pg.wait_for_timeout(600)
        shot(pg, f"tel_{theme}_02_pistes_masquees")
        act = pg.get_by_test_id("tracklist-row-backb").get_by_role("button", name="Afficher et activer")
        if act.count():
            act.click(); pg.wait_for_timeout(600)
        r["apres"] = pg.evaluate(CAPTURE)
        shot(pg, f"tel_{theme}_03_backb_affichee")
    ctx.close()


res = {}
t0 = time.time()
only = sys.argv[1:] or ["pc", "tab", "tel"]
with sync_playwright() as p:
    b = launch(p)
    for theme in ("dark", "light"):
        if "pc" in only: run_pc(b, theme, res)
        if "tab" in only: run_tab(b, theme, res)
        if "tel" in only: run_tel(b, theme, res)
    b.close()
res["secs"] = round(time.time() - t0, 1)
(OUT / "structure_scenario.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
print(json.dumps(res, ensure_ascii=False, indent=1)[:6000])
