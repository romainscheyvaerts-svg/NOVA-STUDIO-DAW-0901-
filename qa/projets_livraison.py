"""Tour « projets, fichiers, export, livraison » (22/10/2026) : les gestes d'un ingé qui enchaîne les séances.

Navigateur headless (aucune fenêtre), 100 % hors production (qalib → qa_hors_prod : Supabase simulé,
nova-billing simulé ici : export ouvert). Projets générés (sinus), profils jetables.

  ctrl_s    Ctrl+S enregistre tout de suite (aucune fenêtre, version « enregistrée », < 3 s), répété sans
            changement : rien de réécrit ; Ctrl+Maj+S = « Sauvegarder… », Ctrl+O = « Ouvrir » ; titre = projet.
  bascule   Piste renommée puis autre projet ouvert 1,5 s après : la modification est dans les versions du 1er.
  recents   Ctrl+O s'ouvre sur « Récents » : le 1er projet rouvert d'un clic, modification comprise ; l'accueil
            (« Charger Projet ») liste les deux ; téléphone 390 : rien ne déborde.
  plantage  Projet rouvert puis modifié, onglet rechargé net : « Récupérer » propose CE projet (pas le dernier enregistré).
  depot     .novaproj.zip glissé sur l'arrangement : il s'ouvre.
  manquant  .zip sans un des sons : bandeau, clip « Son manquant », « Relier » par le nom, Ctrl+Z.
  zip       20 pistes : « Sauvegarder… › Fichier .zip » sous « Client: v3 » → « Client - v3.novaproj.zip », plus
            longue tâche < 400 ms ; rouvert : le projet s'appelle « Client: v3 ».
  export    Morceau de 4 min, 8 pistes stéréo, WAV 24 bits : durée, nom propre, mix qui sature signalé.

Usage : NOVA_URL=http://127.0.0.1:3535/ PYTHONIOENCODING=utf-8 python qa/projets_livraison.py [cas ...]
"""
import io, json, os, sys, time, traceback, wave, zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-auditproj")
from qalib import BASE, OUT, Log, launch, new_page  # noqa: E402  (qa_hors_prod : Supabase simulé, prod bloquée)
from playwright.sync_api import sync_playwright  # noqa: E402

SR = 44100
WORK = OUT / "projets_livraison"
WORK.mkdir(parents=True, exist_ok=True)
RES = {"cas": {}, "ok": True}
INIT = "try { localStorage.setItem('nova_welcome_seen', '1'); localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_simple_mode', '0'); } catch (e) {}"


def check(cas, ok, quoi, **mesure):
    RES["cas"].setdefault(cas, []).append({"ok": bool(ok), "quoi": quoi, **mesure})
    if not ok:
        RES["ok"] = False
    print(("OK  " if ok else "KO  ") + f"[{cas}] {quoi}" + (f"  {mesure}" if mesure else ""), flush=True)


def wav(freq, dur, ch=1):
    t = np.arange(int(dur * SR)) / SR
    x = 0.2 * np.sin(2 * np.pi * freq * t)
    data = np.repeat(x[:, None], ch, axis=1) if ch > 1 else x
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(ch); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((data * 32767).astype("<i2").tobytes())
    return b.getvalue()


def make(path, pid, name, n=3, dur=5.0, ch=1, skip=(), gain=1):
    tr = lambda tid, tname, clips, **kw: {"id": tid, "name": tname, "type": "AUDIO", "color": "#3b82f6", "isMuted": False, "isSolo": False,
        "isTrackArmed": False, "isFrozen": False, "volume": 0.8, "pan": 0, "outputTrackId": "master", "sends": [], "clips": clips,
        "plugins": [], "automationLanes": [], "totalLatency": 0, **kw}
    tracks = [tr("master", "MASTER BUS", [], type="BUS", outputTrackId="")]
    with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as z:
        for i in range(n):
            ref = f"audio/p{i + 1}.wav"
            if ref not in skip:
                z.writestr(ref, wav(110 + 13 * i, dur, ch))
            tracks.append(tr(f"t{i + 1}", f"Prise {i + 1}", [{"id": f"c{i + 1}", "name": f"Prise {i + 1}", "start": (i % 8) * 2, "duration": dur,
                "offset": 0, "fadeIn": 0, "fadeOut": 0, "color": "#22d3ee", "type": "AUDIO", "audioRef": ref, "gain": gain}]))
        st = {"id": pid, "name": name, "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4}, "isPlaying": False, "isRecording": False,
              "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8, "tracks": tracks, "trackGroups": [], "markers": [],
              "selectedTrackId": "t1", "currentView": "ARRANGEMENT", "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False,
              "systemMaxLatency": 0, "recStartTime": None, "isDelayCompEnabled": True,
              "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
              "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0}}
        z.writestr("project.json", json.dumps(st))
    return path


def billing(page):
    def handle(route):
        body = json.loads(route.request.post_data or "{}")
        d = ({"unlocked": True, "via": "pro", "reason": None, "missing": [], "items": []} if body.get("action") == "export_access"
             else {"plans": [], "admin": False, "free_exports_left": 0})
        route.fulfill(status=200, content_type="application/json", body=json.dumps(d))
    page.route("**/functions/v1/nova-billing", handle)


def studio(p, vp="pc"):
    br = launch(p)
    ctx, page = new_page(br, vp, Log("projets"))
    ctx.add_init_script(INIT)
    billing(page)
    return br, ctx, page


def landing(page):
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=60000)


def ready(page, pid, n, timeout=120):
    page.wait_for_function(f"() => window.DAW_CONTROL && window.DAW_CONTROL.getState().id === {json.dumps(pid)}"
                           f" && window.DAW_CONTROL.getState().tracks.filter(t => t.clips.length && t.clips[0].bufferId).length >= {n}", timeout=timeout * 1000)


def open_from_landing(page, f, pid, n):
    landing(page)
    page.get_by_text("Charger Projet").first.click(); page.wait_for_timeout(700)
    with page.expect_file_chooser(timeout=10000) as fc:
        page.get_by_text("Charger depuis l'ordinateur").first.click()
    t0 = time.time()
    fc.value.set_files(str(f))
    ready(page, pid, n)
    return time.time() - t0


def open_in_studio(page, f, pid, n):
    page.mouse.click(900, 650)
    page.keyboard.press("Control+o"); page.wait_for_timeout(700)
    page.get_by_text("Fichier sur l'ordinateur").first.click(); page.wait_for_timeout(300)
    with page.expect_file_chooser(timeout=10000) as fc:
        page.get_by_text("Choisir mon fichier .zip").first.click()
    fc.value.set_files(str(f))
    ready(page, pid, n)


def versions(page, pid):
    return page.evaluate("""async (pid) => { const m = await window.__novaAppModule('/utils/recoveryStore.ts'); const s = m.recoveryStore();
      const out = []; for (const v of await s.listVersions(pid)) { const r = await s.getRecord(v.id); out.push({ id: v.id, reason: v.reason, json: r.json }); } return out; }""", pid)


def rename_t1(page, name):
    page.evaluate(f"() => window.DAW_CONTROL.updateTrack({{ ...window.DAW_CONTROL.getState().tracks.find(t => t.id === 't1'), name: {json.dumps(name)} }})")


def dialog_open(page, rx):
    return page.evaluate(f"() => !!Array.from(document.querySelectorAll('h2, h3')).find(h => /{rx}/i.test(h.innerText))")


# ─── cas ─────────────────────────────────────────────────────────────────────

def cas_ctrl_s(p):
    f = make(WORK / "ctrl_s.novaproj.zip", "proj-ctrlsqa0001", "Séance Ctrl S")
    br, ctx, page = studio(p)
    try:
        open_from_landing(page, f, "proj-ctrlsqa0001", 3)
        page.wait_for_timeout(1200)
        check("ctrl_s", "Séance Ctrl S" in page.title(), "titre de l'onglet = nom du projet", titre=page.title())
        page.mouse.click(900, 650)
        t0 = time.time()
        page.keyboard.press("Control+s")
        page.wait_for_function("async () => { const m = await window.__novaAppModule('/utils/recoveryStore.ts'); return (await m.recoveryStore().listVersions('proj-ctrlsqa0001')).some(v => v.reason === 'manual'); }", timeout=10000)
        dt = round(time.time() - t0, 2)
        check("ctrl_s", dt < 3 and not dialog_open(page, "Sauvegarder le projet"), "Ctrl+S : version « enregistrée » écrite, aucune fenêtre", secondes=dt)
        n1 = len(versions(page, "proj-ctrlsqa0001"))
        page.wait_for_timeout(300)
        page.keyboard.press("Control+s"); page.wait_for_timeout(1200)
        n2 = len(versions(page, "proj-ctrlsqa0001"))
        check("ctrl_s", n2 == n1, "Ctrl+S répété sans changement : rien de réécrit", avant=n1, apres=n2)
        page.keyboard.press("Control+Shift+s"); page.wait_for_timeout(600)
        check("ctrl_s", dialog_open(page, "Sauvegarder le projet"), "Ctrl+Maj+S : fenêtre « Sauvegarder… »")
        page.keyboard.press("Escape"); page.wait_for_timeout(400)
        page.keyboard.press("Control+o"); page.wait_for_timeout(700)
        check("ctrl_s", page.evaluate("() => !!document.getElementById('load-title')"), "Ctrl+O : « Ouvrir un projet »")
        page.screenshot(path=str(WORK / "ctrl_o.png"))
    finally:
        br.close()


def cas_bascule_recents_plantage(p):
    a = make(WORK / "A.novaproj.zip", "proj-aaaaqa000001", "Séance Kaaris")
    b = make(WORK / "B.novaproj.zip", "proj-bbbbqa000002", "Mix Drill")
    br, ctx, page = studio(p)
    try:
        open_from_landing(page, a, "proj-aaaaqa000001", 3)
        page.wait_for_timeout(1500)
        rename_t1(page, "Voix lead A")
        page.wait_for_timeout(1500)
        open_in_studio(page, b, "proj-bbbbqa000002", 3)
        va = versions(page, "proj-aaaaqa000001")
        check("bascule", any("Voix lead A" in v["json"] for v in va), "modification de A gardée en ouvrant B 1,5 s après", versions_A=len(va))
        # Récents
        page.mouse.click(900, 650)
        page.keyboard.press("Control+o"); page.wait_for_timeout(1200)
        rows = page.locator("[data-testid=recent-project]")
        names = rows.all_inner_texts()
        check("recents", rows.count() >= 1 and "Séance Kaaris" in names[0], "Ctrl+O s'ouvre sur « Récents », A en tête (B, ouvert, absent)", lignes=[n.split("\n")[0] for n in names])
        page.screenshot(path=str(WORK / "recents_studio.png"))
        t0 = time.time()
        page.locator("[data-testid=recent-project][data-project-id=proj-aaaaqa000001]").click()
        ready(page, "proj-aaaaqa000001", 3)
        dt = round(time.time() - t0, 2)
        name = page.evaluate("() => window.DAW_CONTROL.getState().tracks.find(t => t.id === 't1').name")
        check("recents", name == "Voix lead A" and dt < 8, "A rouvert d'un clic, modification comprise", secondes=dt, piste=name)
        # Plantage : A modifié puis onglet rechargé net (le drapeau de séance reste).
        page.wait_for_timeout(1000)
        rename_t1(page, "Voix lead A2")
        page.wait_for_timeout(200)
        landing(page)
        page.wait_for_timeout(2500)
        crash = page.locator("[data-testid=crash-recovery]")
        txt = crash.inner_text() if crash.count() else ""
        check("plantage", "Séance Kaaris" in txt and "Mix Drill" not in txt, "« Récupérer » propose le projet qui était ouvert", texte=txt[:160].replace("\n", " / "))
        if crash.count():
            page.get_by_text("Plus tard").first.click(); page.wait_for_timeout(500)
        page.get_by_text("Charger Projet").first.click(); page.wait_for_timeout(1500)
        lr = [t.split("\n")[0] for t in page.locator("[data-testid=landing-recents] [data-testid=recent-project]").all_inner_texts()]
        check("recents", {"Séance Kaaris", "Mix Drill"} <= set(lr), "accueil › Charger Projet : les deux projets récents", lignes=lr)
        page.screenshot(path=str(WORK / "recents_accueil.png"))
    finally:
        br.close()
    # Téléphone 390 : la liste de l'accueil tient dans l'écran.
    br = launch(p)
    try:
        ctx, page = new_page(br, "tel390", Log("tel"))
        ctx.add_init_script(INIT)
        landing(page)
        page.evaluate("""async () => { const r = await window.__novaAppModule('/utils/recentProjects.ts'); const m = await window.__novaAppModule('/utils/recoveryStore.ts');
          const s = m.recoveryStore(); const v = await s.saveVersion({ projectId: 'proj-teleph0001', name: 'Séance au téléphone avec un nom vraiment très long pour voir', json: '{"tracks":[]}', audioIds: [], getAudio: () => null, tracks: 12, takes: 3, beatTitle: 'Drill UK', hasLyrics: false, needsCatalogBeat: false, reason: 'auto' });
          r.rememberRecent({ projectId: 'proj-teleph0001', name: 'Séance au téléphone avec un nom vraiment très long pour voir', savedAt: v.versionId, versionId: v.versionId, tracks: 12, takes: 3, beatTitle: 'Drill UK' }); }""")
        page.get_by_text("Charger Projet").first.click(); page.wait_for_timeout(1500)
        over = page.evaluate("() => Array.from(document.querySelectorAll('[data-testid=recent-project]')).map(b => Math.round(b.getBoundingClientRect().right))")
        check("recents", over and max(over) <= 390 and page.evaluate("() => document.documentElement.scrollWidth <= innerWidth + 1"), "téléphone 390 : récents dans l'écran", droite=over)
        page.screenshot(path=str(WORK / "recents_tel390.png"))
    finally:
        br.close()


def cas_depot(p):
    a = make(WORK / "depot_A.novaproj.zip", "proj-depotqa0001", "Avant dépôt")
    b = make(WORK / "depot_B.novaproj.zip", "proj-depotqa0002", "Projet glissé")
    br, ctx, page = studio(p)
    try:
        open_from_landing(page, a, "proj-depotqa0001", 3)
        page.wait_for_timeout(1500)
        data = list(b.read_bytes())
        page.evaluate("""(bytes) => { const f = new File([new Uint8Array(bytes)], 'Projet glissé.novaproj.zip', { type: 'application/zip' });
          const dt = new DataTransfer(); dt.items.add(f);
          const el = document.elementFromPoint(900, 400);
          for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 900, clientY: 400 })); }""", data)
        try:
            ready(page, "proj-depotqa0002", 3, timeout=30)
            ok = True
        except Exception:
            ok = False
        check("depot", ok, ".novaproj.zip glissé sur l'arrangement : le projet s'ouvre")
    finally:
        br.close()


def cas_manquant(p):
    f = make(WORK / "manquant.novaproj.zip", "proj-manqqa00001", "Son manquant", skip=("audio/p2.wav",))
    son = WORK / "Prise 2.wav"; son.write_bytes(wav(220, 5.0))
    br, ctx, page = studio(p)
    try:
        open_from_landing(page, f, "proj-manqqa00001", 2)
        page.wait_for_timeout(2000)
        banner = page.locator("[data-testid=missing-banner]")
        check("manquant", banner.count() == 1 and "1 son manquant" in banner.inner_text(), "bandeau « 1 son manquant »")
        page.screenshot(path=str(WORK / "manquant.png"))
        page.get_by_test_id("missing-open").click(); page.wait_for_timeout(500)
        with page.expect_file_chooser() as fc:
            page.get_by_test_id("missing-pick-many").click()
        fc.value.set_files(str(son))
        page.wait_for_selector("[data-testid=missing-note]", timeout=10000)
        c = page.evaluate("() => { const c = window.DAW_CONTROL.getState().tracks.find(t => t.id === 't2').clips[0]; return { b: !!c.bufferId, off: !!c.isOffline }; }")
        check("manquant", c["b"] and not c["off"], "« Prise 2.wav » relié au clip « Prise 2 » par le nom", note=page.get_by_test_id("missing-note").inner_text())
        page.keyboard.press("Escape"); page.wait_for_timeout(400)
        check("manquant", page.locator("[data-testid=missing-banner]").count() == 0, "bandeau parti une fois tout relié")
        page.keyboard.press("Control+z"); page.wait_for_timeout(600)
        check("manquant", page.evaluate("() => !!window.DAW_CONTROL.getState().tracks.find(t => t.id === 't2').clips[0].isOffline"), "Ctrl+Z : le clip redevient muet (une étape)")
    finally:
        br.close()


def cas_zip(p):
    f = make(WORK / "zip20.novaproj.zip", "proj-zipqa000020", "Séance 20 pistes", n=20, dur=30.0)
    br, ctx, page = studio(p)
    try:
        open_from_landing(page, f, "proj-zipqa000020", 20)
        page.wait_for_timeout(2500)
        page.mouse.click(900, 650)
        page.keyboard.press("Control+Shift+s"); page.wait_for_timeout(800)
        inp = page.locator("input[placeholder='Ex. : Mon premier son']")
        inp.fill("Client: v3")
        page.evaluate("() => { window.__lt = []; new PerformanceObserver(l => l.getEntries().forEach(e => window.__lt.push(Math.round(e.duration)))).observe({ type: 'longtask' }); }")
        t0 = time.time()
        with page.expect_download(timeout=300000) as dl:
            page.get_by_text("Fichier sur cet appareil (.zip)").first.click()
        d = dl.value
        dt = round(time.time() - t0, 1)
        out = WORK / "zip20_sauve.zip"; d.save_as(str(out))
        lt = page.evaluate("() => window.__lt")
        check("zip", d.suggested_filename == "Client - v3.novaproj.zip", "nom du fichier propre", fichier=d.suggested_filename)
        check("zip", (max(lt) if lt else 0) < 400, "interface jamais figée pendant l'écriture", secondes=dt, plus_longue_tache_ms=max(lt) if lt else 0, mo=round(out.stat().st_size / 1e6))
        st = json.loads(zipfile.ZipFile(out).read("project.json"))
        check("zip", st.get("name") == "Client: v3" and page.evaluate("() => window.DAW_CONTROL.getState().name") == "Client: v3",
              "le projet prend le nom choisi (dans le .zip et le studio)", nom_zip=st.get("name"))
    finally:
        br.close()


def cas_export(p):
    # Gain de clip ×2 (+6 dB) : le mix doit dépasser 0 dBTP. Depuis la loi de pan pro (22/10/2026), ces prises
    # à deux canaux identiques sont mono, au centre à −3 dB : sans ce gain, la crête restait sous −2 dBTP.
    f = make(WORK / "export4min.novaproj.zip", "proj-exportqa0001", "Titre: test / mix", n=8, dur=240.0, ch=2, gain=2)
    br, ctx, page = studio(p)
    try:
        open_from_landing(page, f, "proj-exportqa0001", 8)
        page.wait_for_timeout(1500)
        page.mouse.click(900, 650)
        page.keyboard.press("Control+Shift+e"); page.wait_for_timeout(1500)
        go = page.get_by_test_id("export-go")
        for _ in range(40):
            if go.count() and go.is_enabled() and "EXPORTER" == go.inner_text().strip().upper():
                break
            page.wait_for_timeout(250)
        t0 = time.time()
        with page.expect_download(timeout=300000) as dl:
            go.click()
        d = dl.value
        dt = round(time.time() - t0, 1)
        page.wait_for_timeout(600)
        toast = " ".join(page.evaluate("() => Array.from(document.querySelectorAll('[data-export-job]')).map(e => e.innerText)"))
        check("export", d.suggested_filename == "Titre - test - mix.wav", "nom du fichier : caractères interdits → tirets", fichier=d.suggested_filename)
        check("export", dt < 60, "morceau de 4 min (8 pistes stéréo) exporté", secondes=dt)
        check("export", "⚠️ Ça sature" in toast and "44,1 kHz" in toast, "mix au-dessus de 0 dBTP : signalé avec quoi faire", fin=toast[:220].replace("\n", " / "))
    finally:
        br.close()


CAS = {"ctrl_s": cas_ctrl_s, "recents": cas_bascule_recents_plantage, "depot": cas_depot, "manquant": cas_manquant, "zip": cas_zip, "export": cas_export}


def main():
    todo = [a for a in sys.argv[1:] if a in CAS] or list(CAS)
    with sync_playwright() as p:
        for name in todo:
            try:
                CAS[name](p)
            except Exception as e:
                check(name, False, f"exception : {e}")
                traceback.print_exc()
    (WORK / "resultat.json").write_text(json.dumps(RES, ensure_ascii=False, indent=1), encoding="utf-8")
    print("RÉSULTAT :", "OK" if RES["ok"] else "ÉCHEC", "→", WORK / "resultat.json")
    sys.exit(0 if RES["ok"] else 1)


if __name__ == "__main__":
    main()
