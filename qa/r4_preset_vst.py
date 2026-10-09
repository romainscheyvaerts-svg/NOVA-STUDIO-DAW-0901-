"""R4 · preset d'un VST RÉEL par le pont (port 8775), sans aucune fenêtre de plugin.

  1. Le pont charge FabFilter Pro-C 3 en mode discret (sinon ValhallaSupermassive) ;
  2. on enregistre un preset : état binaire (GET_STATE) + paramètres relus (GET_PARAMS),
     passé par le fichier .novapreset (aller-retour texte) ;
  3. on dérègle plusieurs paramètres (SET_PARAMS) : la relecture doit différer ;
  4. on recharge le preset (SET_STATE) puis on RELIT les paramètres : identiques.

NOVA_URL=http://127.0.0.1:3444/ PYTHONIOENCODING=utf-8 python qa/r4_preset_vst.py
Sortie : D:\\1 WORK\\CONTENU\\nova-r4-r6\\r4_preset_vst.json
"""
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import qa_hors_prod  # noqa: E401,E402,F401  QA hors production : Supabase simulé, prod bloquée
import json, os, sys
from pathlib import Path
sys.path.insert(0, os.path.dirname(__file__))
from playwright.sync_api import sync_playwright  # noqa: E402
from stems_separation import start_bridge, stop_bridge, prepare  # noqa: E402

EXE = r"C:\Users\lenno\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe"
OUT = Path(r"D:\1 WORK\CONTENU\nova-r4-r6")
OUT.mkdir(parents=True, exist_ok=True)
PORT = 8775

JS = r"""
async () => {
  const { novaBridge } = await import('/services/NovaBridge.ts');
  const VP = await import('/services/VstPresets.ts');
  const P = await import('/utils/presets.ts');
  await novaBridge.connect();
  for (let i = 0; i < 100 && !novaBridge.isConnected(); i++) await new Promise(r => setTimeout(r, 200));
  if (!novaBridge.isConnected()) return { erreur: 'pont injoignable' };
  const st = novaBridge.getBridgeState();
  let list = novaBridge.getCachedPlugins();
  if (!list.length) list = await novaBridge.listPlugins();
  const wanted = [/Pro-C 3/i, /ValhallaSupermassive/i, /ValhallaPlate/i];
  const out = { pont: { version: st.version, paramsText: !!st.paramsText, plugins: list.length }, essais: [] };
  for (const re of wanted) {
    const c = list.find(p => re.test(p.name || '') || re.test(p.path || ''));
    if (!c) { out.essais.push({ plugin: String(re), erreur: 'absent du PC' }); continue; }
    const slot = novaBridge.claimSlot('qa-preset-' + Date.now());
    try {
      const sr = 48000;
      const r = await novaBridge.loadPlugin({ slotId: slot, path: c.path, pluginName: c.pluginName ?? null, sampleRate: sr, quiet: true });
      const before = await VP.readVstSlot(slot);
      const plugin = { id: 'qa-vst', name: r.name || c.name, type: 'VST3', isEnabled: true, latency: 0,
        params: { name: r.name || c.name, vendor: r.vendor || c.vendor, localPath: c.path, pluginName: c.pluginName ?? null, stateB64: before.stateB64 } };
      const preset = P.parsePresetFile(P.serializePreset(P.makePluginPreset(plugin, 'Preset QA', { readback: before.readback })));
      // Dérégler : 4 paramètres continus poussés à l'autre bout de leur course.
      const all = await novaBridge.getParams(slot);
      const cont = all.filter(p => !p.is_boolean && !p.is_discrete && typeof p.value === 'number' && !/bypass|midi|program/i.test(p.name)).slice(0, 4);
      await novaBridge.setParams(slot, cont.map(p => ({ name: p.name, value: p.value > 0.5 ? 0.15 : 0.85 })));
      const changed = await VP.readVstSlot(slot);
      const derégle = P.compareReadback(before.readback, changed.readback).diffs;
      // Recharger le preset, relire.
      const rep = await VP.applyVstStateVerified(slot, preset.params.stateB64, preset.readback);
      out.essais.push({
        plugin: r.name || c.name, editeur: r.vendor || c.vendor,
        etat_octets: Math.round((before.stateB64 || '').length * 3 / 4),
        parametres_relus: before.readback.length,
        exemple: before.readback.slice(0, 5),
        dereglages: derégle.slice(0, 4),
        rechargement: { ok: rep.ok, compares: rep.checked, ecarts: rep.diffs, message: rep.message },
      });
      novaBridge.unloadPlugin(slot);
      if (rep.ok && derégle.length) break; // un plugin prouvé suffit
    } catch (e) {
      out.essais.push({ plugin: c.name, erreur: String(e && e.message || e), licence: !!(e && e.licenseRequired) });
      try { novaBridge.unloadPlugin(slot); } catch (_) {}
    }
  }
  return out;
}
"""

br = start_bridge(PORT)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, executable_path=EXE, args=["--autoplay-policy=no-user-gesture-required"])
        ctx = b.new_context()
        pg = ctx.new_page()
        prepare(pg, port=PORT, desktop=False)
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)[:300]))
        pg.goto(os.environ.get("NOVA_URL", "http://127.0.0.1:3444/"), wait_until="domcontentloaded", timeout=90000)
        pg.wait_for_timeout(3000)
        res = pg.evaluate(JS)
        res["_erreurs_page"] = errs[:5]
        ok = any(e.get("rechargement", {}).get("ok") and e.get("dereglages") for e in res.get("essais", []))
        res["_verdict"] = "PRESET VST RECHARGÉ À L'IDENTIQUE" if ok else "ÉCART"
        (OUT / "r4_preset_vst.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
        print(json.dumps(res, ensure_ascii=False, indent=1)[:5000])
        b.close()
finally:
    stop_bridge(br)
