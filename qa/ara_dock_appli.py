"""Éditeur de Melodyne ANCRÉ dans la fenêtre de l'appli Nova Studio (comme le panneau ARA de Pro Tools).

L'appli Windows est lancée depuis le worktree (desktop/nova_desktop.py, fenêtre HORS ÉCRAN, sans
prendre le focus), sur le serveur de dev (npx vite --port 3479) ; le VRAI pont (8782) et le VRAI
hôte ARA servent Melodyne. Le script pilote la page par CDP (comme un utilisateur) :

  1. projet voix ouvert ; onglet VST → « Melodyne » : l'insert se pose en tête de la piste et le
     panneau ARA s'ouvre en bas de la fenêtre Édition ;
  2. la fenêtre native du plugin devient ENFANT de la fenêtre de l'appli, posée sur le repère du
     panneau (vérifié par Windows : parent, rectangle, visibilité) ; capture de la fenêtre de l'appli ;
  3. panneau agrandi → la fenêtre suit ; vue Console → masquée ; retour → ramenée ;
     « Détacher » → fenêtre flottante ; « Ancrer » → de nouveau dans le panneau ; fermeture → masquée.

Usage : NOVA_URL=http://localhost:3479/ python qa/ara_dock_appli.py
"""
import ctypes, json, os, subprocess, sys, tempfile, time
from ctypes import wintypes
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-ara\insert")
os.environ.setdefault("NOVA_URL", "http://localhost:3479/")
from qalib import APP_MODULE_INIT, OUT, BASE  # noqa: E402
from gel_pre_effet import fake_login, DESKTOP_INIT  # noqa: E402,F401
import ara_preuve  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
PORT = int(os.environ.get("NOVA_TEST_PORT", "8782"))
CDP = int(os.environ.get("NOVA_TEST_CDP", "9339"))
BRIDGE_PY = Path(os.environ.get("NOVA_BRIDGE_PYTHON", r"D:\1 WORK\CODE\NOVA-STUDIO-DAW-0901-\bridge-python\venv\Scripts\python.exe"))
DESKTOP_PY = Path(os.environ.get("NOVA_DESKTOP_PYTHON", r"D:\1 WORK\CODE\NOVA-STUDIO-DAW-0901-\desktop\venv\Scripts\python.exe"))
HOST_EXE = ROOT / "nova-ara-host" / "build" / "NovaARAHost_artefacts" / "Release" / "NovaARAHost.exe"
GEOM = os.environ.get("NOVA_TEST_WINDOW", "-20000,-20000,2600,1500")

u32 = ctypes.WinDLL("user32", use_last_error=True)
gdi = ctypes.WinDLL("gdi32")
u32.GetParent.restype = wintypes.HWND
u32.GetAncestor.restype = wintypes.HWND
u32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
u32.IsWindowVisible.argtypes = [wintypes.HWND]
u32.IsWindow.argtypes = [wintypes.HWND]
u32.GetParent.argtypes = [wintypes.HWND]
u32.GetAncestor.argtypes = [wintypes.HWND, ctypes.c_uint]
u32.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
u32.PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, ctypes.c_uint]


def win_info(h):
    h = wintypes.HWND(int(h))
    if not u32.IsWindow(h):
        return {"existe": False}
    r = wintypes.RECT()
    u32.GetWindowRect(h, ctypes.byref(r))
    parent = u32.GetParent(h)
    top = u32.GetAncestor(h, 2)
    p = wintypes.POINT(0, 0)
    if parent:
        u32.ClientToScreen(parent, ctypes.byref(p))
    return {"existe": True, "visible": bool(u32.IsWindowVisible(h)), "parent": int(parent or 0), "racine": int(top or 0),
            "x_dans_parent": r.left - p.x, "y_dans_parent": r.top - p.y, "w": r.right - r.left, "h": r.bottom - r.top}


def capture_window(hwnd, path):
    """Capture d'une fenêtre (même hors écran) par PrintWindow(PW_RENDERFULLCONTENT) → PNG."""
    h = wintypes.HWND(int(hwnd))
    r = wintypes.RECT()
    u32.GetWindowRect(h, ctypes.byref(r))
    w, hh = r.right - r.left, r.bottom - r.top
    hdc = u32.GetDC(None)
    mem = gdi.CreateCompatibleDC(hdc)
    bmp = gdi.CreateCompatibleBitmap(hdc, w, hh)
    gdi.SelectObject(mem, bmp)
    ok = u32.PrintWindow(h, mem, 2)
    class BIH(ctypes.Structure):
        _fields_ = [("biSize", ctypes.c_uint32), ("biWidth", ctypes.c_int32), ("biHeight", ctypes.c_int32), ("biPlanes", ctypes.c_uint16),
                    ("biBitCount", ctypes.c_uint16), ("biCompression", ctypes.c_uint32), ("biSizeImage", ctypes.c_uint32),
                    ("biXPelsPerMeter", ctypes.c_int32), ("biYPelsPerMeter", ctypes.c_int32), ("biClrUsed", ctypes.c_uint32), ("biClrImportant", ctypes.c_uint32)]
    bi = BIH(ctypes.sizeof(BIH), w, -hh, 1, 32, 0, 0, 0, 0, 0, 0)
    buf = ctypes.create_string_buffer(w * hh * 4)
    gdi.GetDIBits(mem, bmp, 0, hh, buf, ctypes.byref(bi), 0)
    gdi.DeleteObject(bmp); gdi.DeleteDC(mem); u32.ReleaseDC(None, hdc)
    import numpy as np
    from PIL import Image
    a = np.frombuffer(buf.raw, np.uint8).reshape(hh, w, 4)[:, :, [2, 1, 0]]
    Image.fromarray(a).save(path)
    return {"path": str(path), "w": w, "h": hh, "print_window": bool(ok)}


def find_app_window(timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        found = []
        CB = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

        def cb(h, _):
            buf = ctypes.create_unicode_buffer(256)
            u32.GetWindowTextW(h, buf, 256)
            if buf.value.startswith("Nova Studio") and u32.IsWindowVisible(h):
                found.append(int(h))
            return True
        u32.EnumWindows(CB(cb), 0)
        if found:
            return found[0]
        time.sleep(0.5)
    return None


INFO_JS = """async () => {
  const { liveAraInserts } = await window.__novaAppModule('/engine/AraInsertNode.ts');
  const n = Array.from(liveAraInserts.values())[0];
  const el = document.querySelector('[data-testid=ara-dock-slot]');
  const r = el ? el.getBoundingClientRect() : null;
  return { info: n ? n.getAraInfo() : null, status: n ? n.getInfo().status : null, dpr: window.devicePixelRatio,
           repere: r ? { x: Math.round(r.left * devicePixelRatio), y: Math.round(r.top * devicePixelRatio), w: Math.round(r.width * devicePixelRatio), h: Math.round(r.height * devicePixelRatio) } : null,
           hwnd_page: window.__novaDesktop && window.__novaDesktop.hwnd };
}"""


def main():
    from playwright.sync_api import sync_playwright
    OUT.mkdir(parents=True, exist_ok=True)
    ara_preuve.make_project()
    rep = {}
    env_b = dict(os.environ, NOVA_BRIDGE_PORT=str(PORT), NOVA_ARA_HOST=str(HOST_EXE), PYTHONIOENCODING="utf-8")
    br = subprocess.Popen([str(BRIDGE_PY), "nova_bridge_server.py"], cwd=str(ROOT / "bridge-python"), env=env_b,
                          stdout=open(OUT / "pont-dock.log", "w", encoding="utf-8"), stderr=subprocess.STDOUT, creationflags=0x08000000)
    data_dir = tempfile.mkdtemp(prefix="nova-desktop-qa-")
    env_a = dict(os.environ, NOVA_DESKTOP_URL=BASE, NOVA_DESKTOP_DATA_DIR=data_dir, NOVA_DESKTOP_CDP_PORT=str(CDP),
                 NOVA_DESKTOP_NO_BRIDGES="1", NOVA_DESKTOP_NO_UPDATE="1", NOVA_DESKTOP_WINDOW=GEOM,
                 NOVA_DESKTOP_EXTRA_ARGS="--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding")
    app = subprocess.Popen([str(DESKTOP_PY), str(ROOT / "desktop" / "nova_desktop.py")], cwd=str(ROOT / "desktop"), env=env_a,
                           stdout=open(OUT / "appli-dock.log", "w", encoding="utf-8"), stderr=subprocess.STDOUT, creationflags=0x08000000)
    try:
        hwnd_app = find_app_window(90)
        rep["fenetre_appli"] = hwnd_app
        with sync_playwright() as p:
            b = None
            for _ in range(120):
                try:
                    b = p.chromium.connect_over_cdp(f"http://127.0.0.1:{CDP}")
                    break
                except Exception:
                    time.sleep(0.5)
            ctx = b.contexts[0]
            page = ctx.pages[0]
            page.set_default_timeout(30000)
            ctx.add_init_script(APP_MODULE_INIT)
            ctx.add_init_script(f"try {{ localStorage.setItem('nova.bridge.url', 'ws://127.0.0.1:{PORT}'); localStorage.setItem('nova_welcome_seen', '1'); }} catch (e) {{}}")
            fake_login(page)
            page.route("**/functions/v1/nova-billing", lambda r: r.fulfill(status=200, content_type="application/json",
                       body=json.dumps({"plans": [], "admin": True, "unlocked": True, "free_exports_left": 10})))
            # Projet voix (lead + double), comme qa/ara_preuve.py.
            from gel_pre_effet import open_project_file
            open_project_file(page, ara_preuve.PROJECT, rep, "D0_appli_projet")
            page.wait_for_timeout(3000)
            ara_preuve.dismiss_popups(page)
            rep["marqueur_appli"] = page.evaluate("() => window.__novaDesktop")
            page.evaluate("async () => { const { novaBridge } = await window.__novaAppModule('/services/NovaBridge.ts'); await novaBridge.connect(); await novaBridge.listPlugins(); }")
            # Piste « Voix lead » choisie, onglet VST, Melodyne.
            # (le projet choisit déjà la piste « Voix lead »)
            show = page.get_by_role("button", name="Afficher le navigateur")
            if show.count():
                show.first.click(); page.wait_for_timeout(800)
            page.screenshot(path=str(OUT / "D0_avant_vst.png"))
            page.locator("aside").get_by_text("VST", exact=True).first.click()
            page.wait_for_timeout(1500)
            con = page.get_by_role("button", name="Connecter le pont VST")
            if con.count():
                con.first.click(); page.wait_for_timeout(4000)
            page.screenshot(path=str(OUT / "D0_onglet_vst.png"))
            rep["pont_page"] = page.evaluate("async () => { const { novaBridge } = await window.__novaAppModule('/services/NovaBridge.ts'); const s = novaBridge.getBridgeState(); return { status: s.status, version: s.version, araInsert: s.araInsert, plugins: novaBridge.getCachedPlugins().filter(p => /melodyne|vocalign/i.test(p.name)).map(p => p.name) }; }")
            page.get_by_label("Chercher un plugin VST").fill("Melodyne"); page.wait_for_timeout(800)
            page.screenshot(path=str(OUT / "D0_recherche_melodyne.png"))
            page.locator('[data-vst-plugin="Melodyne"]').first.click()
            page.get_by_test_id("ara-dock").wait_for(timeout=60000)
            t0 = time.time()
            info = {}
            while time.time() - t0 < 180:
                info = page.evaluate(INFO_JS)
                if info.get("info") and info["info"].get("dock") == "docked" and info["info"].get("docVersion"):
                    break
                page.wait_for_timeout(500)
            rep["insert"] = info
            rep["insert_s"] = round(time.time() - t0, 1)
            page.wait_for_timeout(2500)
            st = page.evaluate("""async () => { const { liveAraInserts } = await window.__novaAppModule('/engine/AraInsertNode.ts');
                const { novaBridge } = await window.__novaAppModule('/services/NovaBridge.ts');
                const n = Array.from(liveAraInserts.values())[0];
                return novaBridge.araInsertEditor(n.getSlotId(), { mode: 'bounds', ...(${REP}), visible: true }); }""".replace("${REP}", json.dumps(info.get("repere") or {"x": 0, "y": 0, "w": 800, "h": 300})))
            rep["editeur_ancre"] = {k: st.get(k) for k in ("child", "visible", "view_width", "view_height", "resizable", "hwnd")}
            child = st.get("hwnd")
            rep["windows_editeur"] = win_info(child)
            rep["windows_editeur"]["parent_est_la_page"] = rep["windows_editeur"].get("parent") == info.get("hwnd_page")
            rep["windows_editeur"]["racine_est_l_appli"] = rep["windows_editeur"].get("racine") == hwnd_app
            rep["capture_appli"] = capture_window(hwnd_app, OUT / "D1_appli_melodyne_ancre.png")
            page.screenshot(path=str(OUT / "D1_page_seule.png"))
            # Vue du plugin elle-même (PrintWindow sur la fenêtre enfant, par l'hôte), recollée à sa
            # place dans la capture de l'appli (DirectComposition de WebView2 + fenêtre enfant GDI).
            snap = page.evaluate("""async (p) => { const { liveAraInserts } = await window.__novaAppModule('/engine/AraInsertNode.ts');
                const { novaBridge } = await window.__novaAppModule('/services/NovaBridge.ts');
                const n = Array.from(liveAraInserts.values())[0]; return novaBridge.araInsertSnapshot(n.getSlotId(), p); }""", str(OUT / "D1_editeur_ancre_seul.png"))
            rep["capture_editeur"] = snap
            try:
                from PIL import Image
                app_img = Image.open(OUT / "D1_appli_melodyne_ancre.png").convert("RGB")
                ed = Image.open(OUT / "D1_editeur_ancre_seul.png").convert("RGB")
                ar = wintypes.RECT(); u32.GetWindowRect(wintypes.HWND(hwnd_app), ctypes.byref(ar))
                cr = wintypes.RECT(); u32.GetWindowRect(wintypes.HWND(int(child)), ctypes.byref(cr))
                app_img.paste(ed, (cr.left - ar.left, cr.top - ar.top))
                app_img.save(OUT / "D1_appli_melodyne_ancre_composite.png")
                rep["capture_composite"] = str(OUT / "D1_appli_melodyne_ancre_composite.png")
            except Exception as e:
                rep["capture_composite"] = f"échec : {e}"
            # Panneau agrandi : la fenêtre suit.
            grip = page.locator('[data-testid=ara-dock] > div').first
            bb = grip.bounding_box()
            page.mouse.move(bb["x"] + 40, bb["y"] + 2); page.mouse.down(); page.mouse.move(bb["x"] + 40, bb["y"] - 120, steps=6); page.mouse.up()
            page.wait_for_timeout(1500)
            i2 = page.evaluate(INFO_JS)
            rep["agrandi"] = {"repere": i2.get("repere"), "fenetre": win_info(child)}
            capture_window(hwnd_app, OUT / "D2_appli_panneau_agrandi.png")
            # Vue Console : masquée ; retour : ramenée.
            page.keyboard.press("Escape"); page.keyboard.press("Control+Equal")   # Pro Tools : Ctrl+= (Mix / Edit)
            page.wait_for_timeout(1500)
            rep["vue_console"] = {"fenetre": win_info(child), "info": page.evaluate(INFO_JS).get("info", {}).get("dock")}
            page.keyboard.press("Control+Equal")
            page.wait_for_timeout(1500)
            if not page.get_by_test_id("ara-dock").count():
                page.evaluate("async () => { const m = await window.__novaAppModule('/components/AraEditorDock.tsx'); m.openAraDock('lead'); }")
                page.wait_for_timeout(2500)
            i3 = page.evaluate(INFO_JS)
            rep["retour_edition"] = {"info": (i3.get("info") or {}).get("dock")}
            # Détacher / Ancrer.
            page.get_by_test_id("ara-dock-detach").click(); page.wait_for_timeout(2500)
            rep["detache"] = {"info": page.evaluate(INFO_JS).get("info", {}).get("dock"), "ancienne_fenetre": win_info(child)}
            page.get_by_test_id("ara-dock-attach").click(); page.wait_for_timeout(3000)
            i4 = page.evaluate(INFO_JS)
            rep["ancre_de_nouveau"] = {"info": (i4.get("info") or {}).get("dock")}
            capture_window(hwnd_app, OUT / "D3_appli_reancre.png")
            # Fermeture du panneau : masquée (l'insert reste actif).
            page.get_by_role("button", name="Fermer le panneau").click(); page.wait_for_timeout(1500)
            rep["panneau_ferme"] = {"info": page.evaluate(INFO_JS).get("info", {}).get("dock")}
            b.close()
    finally:
        for proc in (app, br):
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, creationflags=0x08000000)
        (OUT / "ara_dock_appli.json").write_text(json.dumps(rep, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
        print(json.dumps(rep, ensure_ascii=False, indent=1, default=str)[:8000])


if __name__ == "__main__":
    main()
