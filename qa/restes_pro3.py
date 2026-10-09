"""Restes du tour 2, finis au tour 3 (« utilisable et pro », 09/10/2026) — Chrome headless, hors production.

 A. Restaurer la dernière sélection (Pro Tools : Opt+Cmd+Z ; NOVA : Ctrl+Alt+Z) : plage, clips, va-et-vient.
 B. Repère qui garde une PLAGE (Memory Location « Selection ») : K avec une plage, rappel au pavé « . 1 . »
    et dans la liste des repères (Ctrl+5) : la plage revient sélectionnée.
 C. Revenir à la version enregistrée : sans sauvegarde → message clair ; après « Enregistrer comme nouvelle
    version » puis une modification : confirmation (Échap = rien ne bouge), « Revenir » → état d'avant,
    et la version qu'on quitte est gardée dans l'historique.
 D. « Master Nova » dans la première moitié du menu ☰ (tablette 1024 × 768, PC 1366 × 768).
 E. Question casque : en headless, la sortie audio simulée (qa/qalib : nom de sortie comme sur un vrai PC)
    suit le VRAI chemin de détection : REC part sans question ; QA_SORTIE_AUDIO=aucune la fait revenir.

  NOVA_URL=http://127.0.0.1:3487/ python qa/restes_pro3.py
Sorties : D:\\1 WORK\\CONTENU\\nova-pro3\\restes\\ (restes.json + captures)
"""
import json, os, re, sys, time
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3487/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-pro3\restes")
sys.path.insert(0, str(Path(__file__).parent))
from qalib import launch, new_page, OUT, Log, BASE  # noqa: E402
from desktop_gate import install_mocks, SUPERADMIN  # noqa: E402
from scenarios import close_welcome  # noqa: E402
from nova_pro_lib import app_state, canvas_box, save_json  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402
import seance_inge as S  # noqa: E402  (audio synthétique, glisser de fichiers)

checks, res = [], {}


def check(name, cond, detail=None):
    checks.append({"verif": name, "ok": bool(cond), **({"detail": detail} if detail is not None else {})})
    print(("  OK  " if cond else "  KO  ") + name + (f" — {json.dumps(detail, ensure_ascii=False)[:200]}" if detail is not None else ""), flush=True)


def sel(page):
    return page.evaluate("""async () => { const m = await window.__novaAppModule('/utils/editSelection.ts'); const s = m.editSelectionStore.get();
      return { time: s.time && [+s.time.start.toFixed(3), +s.time.end.toFixed(3), s.time.trackIds], clips: s.clipIds }; }""")


def toast(page):
    return page.evaluate("() => Array.from(document.querySelectorAll('[role=status], [aria-live]')).map(e => e.innerText.trim()).filter(Boolean).join(' | ').slice(0, 400)")


def studio(b, vp="pc", touch=False):
    log = Log(f"restes_{vp}")
    ctx, page = new_page(b, vp, log=log, touch=touch)
    page.set_default_timeout(20000)
    page.add_init_script("try { localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}")
    install_mocks(page, "romain", SUPERADMIN, {})
    page.goto(BASE, wait_until="domcontentloaded", timeout=180000)
    page.locator("button:visible", has_text=re.compile("Nouveau Projet")).first.wait_for(timeout=90000)
    (page.locator("[data-testid=landing-templates]:visible").first.tap() if touch else page.locator("[data-testid=landing-templates]:visible").first.click())
    use = page.locator("[data-template-id=tpl-make-music-voix] [data-testid=tpl-use]").first
    use.wait_for(timeout=20000)
    use.tap() if touch else use.click()
    page.wait_for_timeout(800); close_welcome(page)
    page.wait_for_function("() => !!document.querySelector('.nova-grille canvas') && !!window.__novaEdit", timeout=60000)
    page.wait_for_timeout(800)
    return ctx, page, log


def drag_range(page, track_id, a, b):
    y = S.lane_y(page, track_id)
    x0, x1 = S.time_x(page, a), S.time_x(page, b)
    m = page.mouse
    m.move(x0, y); m.down(); m.move((x0 + x1) / 2, y, steps=4); m.move(x1, y, steps=4); m.up()
    page.wait_for_timeout(450)  # comme un ingé : la sélection reste un instant avant la suivante


def part_ab(b, files):
    ctx, page, log = studio(b)
    page.keyboard.press("Escape")
    # Un son sur la lead et les backs (glisser), pour avoir des clips à sélectionner.
    S.drop_files(page, [files["back1"]], S.time_x(page, 0.2), S.lane_y(page, "voix-lead"))
    S.drop_files(page, [files["back2"]], S.time_x(page, 0.2), S.lane_y(page, "backs"))
    page.wait_for_function("() => window.__novaEdit.getState().tracks.filter(t => t.clips.length).length >= 2", timeout=20000)
    page.wait_for_timeout(500)
    page.keyboard.press("4")  # Sélecteur
    drag_range(page, "voix-lead", 2.0, 4.0)
    s1 = sel(page)
    drag_range(page, "backs", 6.0, 9.0)
    s2 = sel(page)
    page.keyboard.press("Control+Alt+z"); page.wait_for_timeout(300)
    s3 = sel(page); t3 = toast(page)
    check("A · Ctrl+Alt+Z rend la plage d'avant (lead 2 → 4 s)", s1["time"] and s3["time"] and s3["time"][:2] == s1["time"][:2] and s3["time"][2] == s1["time"][2], {"avant": s1, "rendue": s3})
    check("A · message clair", "Sélection précédente restaurée" in t3, t3)
    page.screenshot(path=str(OUT / "A1_selection_restauree.png"))
    page.keyboard.press("Control+Alt+z"); page.wait_for_timeout(300)
    s4 = sel(page)
    check("A · 2e Ctrl+Alt+Z : retour à l'autre plage (va-et-vient, comme Pro Tools)", s4["time"] and s4["time"][:2] == s2["time"][:2], {"rendue": s4, "attendue": s2})
    # Clips : clic sur le clip de la lead (Smart Tool), puis une plage ; Ctrl+Alt+Z rend le clip sélectionné.
    page.keyboard.press("5")
    page.mouse.click(S.time_x(page, 3.0), S.lane_y(page, "voix-lead") + 25); page.wait_for_timeout(450)
    c1 = sel(page)
    page.keyboard.press("4")
    drag_range(page, "backs", 1.0, 2.0)
    page.keyboard.press("Control+Alt+z"); page.wait_for_timeout(300)
    c2 = sel(page)
    check("A · les clips sélectionnés reviennent aussi", bool(c1["clips"]) and c2["clips"] == c1["clips"] and not c2["time"], {"avant": c1, "rendue": c2})
    res["A"] = {"plage1": s1, "plage2": s2, "rendue": s3, "va_et_vient": s4, "clips": [c1, c2]}

    # B. Repère de sélection --------------------------------------------------------------
    drag_range(page, "voix-lead", 6.857, 13.714)
    k_sel = sel(page)["time"]
    page.keyboard.press("k"); page.wait_for_timeout(400)
    mk = app_state(page, "s => s.markers.map(m => ({ n: m.number, name: m.name, t: +m.time.toFixed(3), sel: m.selection ? [+m.selection.end.toFixed(3), m.selection.trackIds] : null }))")
    tb = toast(page)
    check("B · K avec une plage : repère « Sélection 1 » qui garde la plage et les pistes", bool(k_sel) and any(m["sel"] and abs(m["t"] - k_sel[0]) < 0.002 and abs(m["sel"][0] - k_sel[1]) < 0.002 and m["sel"][1] == ["voix-lead"] for m in mk), {"plage": k_sel, "reperes": mk})
    check("B · message : la plage est mémorisée + comment la rappeler", "plage est mémorisée" in tb, tb)
    page.evaluate("async () => { const m = await window.__novaAppModule('/utils/editSelection.ts'); m.editSelectionStore.set({ time: null, clipIds: [] }); }")
    page.keyboard.press("NumpadDecimal"); page.keyboard.press("Numpad1"); page.keyboard.press("NumpadDecimal"); page.wait_for_timeout(400)
    r1 = sel(page)
    check("B · pavé « . 1 . » : la plage du refrain revient sélectionnée", r1["time"] and r1["time"][:2] == k_sel[:2], r1)
    page.evaluate("async () => { const m = await window.__novaAppModule('/utils/editSelection.ts'); m.editSelectionStore.set({ time: null, clipIds: [] }); }")
    page.keyboard.press("Control+5"); page.wait_for_timeout(500)
    item = page.locator("[data-testid=memory-locations] [data-selection-marker]").first
    check("B · la liste des repères montre la plage gardée", item.count() > 0 and "plage" in item.inner_text(), item.inner_text() if item.count() else None)
    page.screenshot(path=str(OUT / "B1_liste_reperes.png"))
    if item.count(): item.click(); page.wait_for_timeout(300)
    r2 = sel(page)
    check("B · clic dans la liste : la plage revient sélectionnée", r2["time"] and r2["time"][:2] == k_sel[:2], r2)
    page.keyboard.press("Escape")
    page.screenshot(path=str(OUT / "B2_plage_rappelee.png"))
    res["B"] = {"reperes": mk, "pave": r1, "liste": r2}
    res["erreurs_AB"] = [e["text"][:160] for e in log.errors() if not re.search(r"876[56]|ERR_CONNECTION_REFUSED", e["text"])][:5]
    ctx.close()


def part_c(b, files):
    ctx, page, log = studio(b)
    page.keyboard.press("Escape")
    # Sans sauvegarde : message clair.
    page.keyboard.press("Control+k"); page.locator("[data-testid=command-palette]").wait_for(timeout=4000)
    page.keyboard.type("revenir version enregistrée", delay=5); page.wait_for_timeout(200)
    first = page.locator("[data-testid=command-palette] [role=option]").first.get_attribute("data-palette-id")
    check("C · palette : « revenir version enregistrée » trouve l'action en 1er", first == "pal.revertSaved", first)
    page.keyboard.press("Enter"); page.wait_for_timeout(800)
    t0 = toast(page)
    check("C · sans sauvegarde : pas de fenêtre, message clair (sauvegarde d'abord)", not page.locator("[data-testid=revert-dialog]").count() and "pas encore de version enregistrée" in t0, t0)
    # Contenu + sauvegarde voulue (nouvelle version).
    S.drop_files(page, [files["back1"]], S.time_x(page, 0.2), S.lane_y(page, "voix-lead"))
    page.wait_for_function("() => window.__novaEdit.getState().tracks.find(t => t.id === 'voix-lead').clips.length === 1", timeout=20000)
    page.wait_for_timeout(500)
    page.keyboard.press("Control+s")
    page.locator("[data-testid=save-new-version]").wait_for(timeout=6000)
    page.locator("[data-testid=save-new-version-comment]").fill("prise validée")
    page.locator("[data-testid=save-new-version]").click()
    page.wait_for_timeout(2500)
    saved_name = app_state(page, "s => s.name")
    # Modification après la sauvegarde : le clip de la lead est supprimé, le fader du beat bouge.
    page.evaluate("() => { const e = window.__novaEdit; const s = e.getState(); }")
    page.keyboard.press("5")
    page.mouse.click(S.time_x(page, 3.0), S.lane_y(page, "voix-lead") + 25); page.wait_for_timeout(200)
    page.keyboard.press("Delete"); page.wait_for_timeout(500)
    after_edit = app_state(page, "s => s.tracks.find(t => t.id === 'voix-lead').clips.length")
    check("C · modification faite après la sauvegarde (clip de la lead supprimé)", after_edit == 0, after_edit)
    page.wait_for_timeout(300)
    # ☰ › Revenir à la version enregistrée… : confirmation.
    page.locator("button[aria-label='Ouvrir le menu']").first.click(); page.wait_for_timeout(300)
    page.locator("[data-testid=menu-revert-saved]").click(); page.wait_for_timeout(800)
    dlg = page.locator("[data-testid=revert-dialog]")
    txt = dlg.inner_text() if dlg.count() else ""
    check("C · fenêtre de confirmation claire (heure, ce qui est retiré, rien n'est perdu)", dlg.count() == 1 and "Tout ce que tu as fait depuis est retiré" in txt and "Rien n’est perdu" in txt, txt[:300])
    focus = page.evaluate("() => document.activeElement?.dataset?.testid || ''")
    check("C · « Garder mon travail » a le focus (Entrée ne jette rien)", focus == "revert-cancel", focus)
    page.screenshot(path=str(OUT / "C1_confirmation.png"))
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    check("C · Échap : fenêtre fermée, rien ne bouge", not dlg.count() and app_state(page, "s => s.tracks.find(t => t.id === 'voix-lead').clips.length") == 0)
    page.locator("button[aria-label='Ouvrir le menu']").first.click(); page.wait_for_timeout(300)
    page.locator("[data-testid=menu-revert-saved]").click(); page.wait_for_timeout(800)
    page.locator("[data-testid=revert-confirm]").click()
    page.wait_for_function("() => { const s = window.__novaEdit && window.__novaEdit.getState(); return s && s.tracks.find(t => t.id === 'voix-lead')?.clips.length === 1; }", timeout=30000)
    page.wait_for_timeout(2500)
    back = app_state(page, "s => ({ lead: s.tracks.find(t => t.id === 'voix-lead').clips.map(c => c.name), name: s.name })")
    check("C · « Revenir » : le projet est comme à la sauvegarde (clip de la lead revenu)", back and back["lead"] == ["back_1_haute"], back)
    t1 = toast(page)
    check("C · message : version enregistrée rouverte, version d'avant gardée", "Version enregistrée" in t1 and "gardée" in t1, t1)
    vers = page.evaluate("""async () => { const R = await window.__novaAppModule('/utils/recoveryStore.ts'); const l = await R.recoveryStore().listVersions();
      return l.map(v => ({ reason: v.reason, n: v.versionNumber || null, comment: v.comment || null })); }""")
    check("C · l'état quitté est gardé dans « Versions de la session » (avant le retour)", sum(1 for v in vers if v["reason"] in ("restore", "auto", "close")) >= 1 and any(v["n"] for v in vers), vers[:6])
    page.screenshot(path=str(OUT / "C2_revenu.png"))
    res["C"] = {"nom": saved_name, "apres_retour": back, "versions": vers[:8]}
    res["erreurs_C"] = [e["text"][:160] for e in log.errors() if not re.search(r"876[56]|ERR_CONNECTION_REFUSED", e["text"])][:5]
    ctx.close()


def part_d(b):
    out = {}
    for vp in ("tab", "pc1366"):
        ctx, page, log = studio(b, vp, touch=(vp == "tab"))
        page.keyboard.press("Escape")
        btn = page.locator("button[aria-label='Ouvrir le menu']").first
        btn.tap() if vp == "tab" else btn.click()
        page.wait_for_timeout(400)
        info = page.evaluate("""() => { const d = document.querySelector('[role=dialog][aria-label=Menu]'); if (!d) return null;
          const items = Array.from(d.querySelectorAll('button')).filter(b => b.getClientRects().length);
          const i = items.findIndex(b => /Master Nova/.test(b.innerText)); const r = i >= 0 ? items[i].getBoundingClientRect() : null;
          return { index: i, total: items.length, top: r && Math.round(r.top), bottom: r && Math.round(r.bottom), vh: innerHeight, scrollH: d.scrollHeight }; }""")
        out[vp] = info
        check(f"D · {vp} : « Master Nova » dans la 1re moitié du menu ☰ et visible sans défiler",
              info and info["index"] >= 0 and info["index"] < info["total"] / 2 and info["bottom"] <= info["vh"], info)
        page.screenshot(path=str(OUT / f"D_menu_{vp}.png"))
        ctx.close()
    res["D"] = out


def part_e(b):
    ctx, page, log = studio(b)
    page.keyboard.press("Escape")
    page.locator("[data-track-header='voix-lead'] button[aria-label^='Armer']").first.click()
    page.keyboard.press("r"); page.wait_for_timeout(700)
    note = toast(page)
    auto = page.evaluate("() => localStorage.getItem('nova_headphones_auto')")
    page.wait_for_timeout(2800)  # décompte d'une mesure compris
    q = page.get_by_role("button", name=re.compile("Oui, j.ai un casque")).locator("visible=true").count()
    rec = app_state(page, "s => s.isRecording")
    check("E · headless avec sortie simulée (« Casque (Realtek(R) Audio) ») : REC part sans question", q == 0 and rec, {"question": q, "rec": rec})
    check("E · c'est la vraie détection de l'appli (sortie lue et retenue, message « Casque détecté »)", auto and "Casque" in auto and "Casque détecté" in note, {"retenu": auto, "message": note[:160]})
    page.keyboard.press("Space"); page.wait_for_timeout(800)
    res["E"] = {"question": q, "rec": rec, "message": note[:200]}
    ctx.close()


def main():
    files = S.make_audio()
    with sync_playwright() as p:
        b = launch(p)
        t0 = time.time()
        for part in (lambda: part_ab(b, files), lambda: part_c(b, files), lambda: part_d(b), lambda: part_e(b)):
            try: part()
            except Exception as e:
                check(f"arrêt : {type(e).__name__}", False, str(e)[:300])
        b.close()
    rep = {"verifs": checks, "ok": sum(c["ok"] for c in checks), "total": len(checks), "mesures": res, "duree_s": round(time.time() - t0, 1)}
    save_json(OUT / "restes.json", rep)
    print(f"\n{rep['ok']} / {rep['total']} vérifications")
    sys.exit(0 if rep["ok"] == rep["total"] else 1)


if __name__ == "__main__":
    main()
