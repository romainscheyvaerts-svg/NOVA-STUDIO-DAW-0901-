"""R23 · Changer de beat en collaboration, dans de VRAIS navigateurs (headless, aucune fenêtre).

L'ARTISTE (A) ouvre la session « voix sur beat A » (94 BPM, Sol mineur) et démarre « En direct » ;
l'INGÉ (B) la rejoint par le lien. A remplace l'instru par le beat B (100 BPM, La mineur).
Preuves : UNE seule opération « beatswap » part dans le journal (pas de contenu, tempo, repères
ni accords envoyés à part) ; B reçoit le nouveau beat, les voix recalées (même son, même place),
le tempo, la tonalité, les repères et les accords ; Ctrl+Z chez B revient à l'ancien beat.
Serveur NOVA (daw-session) et Supabase Realtime SIMULÉS (qa/collab_sim.py) : rien ne part vers Supabase.

Prérequis : qa/r23_beat_repunch.py a fabriqué projet_voix_beat_A.zip et beat_B_100_la_mineur.wav.
NOVA_URL=http://127.0.0.1:3476/ PYTHONIOENCODING=utf-8 python qa/r23_collab.py
"""
import json, os, re, sys, time
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-r23\collab")
SRC_DIR = Path(r"D:\1 WORK\CONTENU\nova-r23")
from qalib import *  # noqa
from gel_pre_effet import prepare, open_project_file  # noqa
from collab_sim import FakeNovaCloud, FakeRealtime, FakeBridgeV7, connect  # noqa
from collab_direct import dismiss, wait_for, collab, open_panel  # noqa
from r13_transposition import buffer_of  # noqa

INIT = "try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_welcome_seen', '1'); localStorage.setItem('nova_count_in', '0'); } catch (e) {}"


def summary(page):
    return page.evaluate("""() => { const s = window.__novaEdit.getState(); const v = s.tracks.find(t => t.id === 'voix'); const b = s.tracks.find(t => t.id === 'instrumental');
      return { bpm: s.bpm, key: s.projectKey, beat: b.clips.map(c => ({ id: c.id, bufferId: c.bufferId, duration: c.duration })),
        voix: v.clips.map(c => ({ id: c.id, start: c.start, offset: c.offset, duration: c.duration, bufferId: c.bufferId })),
        markers: s.markers.map(m => [m.id, Math.round(m.time * 1e4) / 1e4]), chords: (s.chords || []).map(c => [c.id, c.root, Math.round(c.start * 1e4) / 1e4]) }; }""")


def close_overlays(page):
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    x = page.locator("[aria-labelledby='collab-title']")
    if x.count():
        try:
            x.first.get_by_role("button", name=re.compile("Fermer", re.I)).first.click(timeout=1500)
        except Exception:
            page.keyboard.press("Escape")
        page.wait_for_timeout(300)


def run():
    res = {"name": "r23_collab", "ok": True, "steps": [],
           "note": "Serveur NOVA (daw-session) et Supabase Realtime SIMULÉS (qa/collab_sim.py), protocole réel côté navigateur."}
    cloud, rt = FakeNovaCloud(), FakeRealtime()
    src = SRC_DIR / "projet_voix_beat_A.zip"
    link = {}

    def step(label, fn):
        t = time.time()
        try:
            o = fn()
            res["steps"].append({"step": label, "ok": True, "s": round(time.time() - t, 1), **({"info": o} if o else {})})
            return o
        except Exception as e:  # noqa
            res["ok"] = False
            res["steps"].append({"step": label, "ok": False, "err": f"{type(e).__name__}: {str(e)[:600]}"})
            return None

    with sync_playwright() as p:
        b = launch(p)
        logA, logB = Log("artiste_r23"), Log("inge_r23")
        ctxA, A = new_page(b, "pc", logA)
        ctxB, B = new_page(b, "pc", logB)
        for c in (ctxA, ctxB):
            c.add_init_script(INIT)
        A.set_default_timeout(30000); B.set_default_timeout(30000)
        prepare(A, FakeBridgeV7(), desktop=True)
        prepare(B, None, desktop=False)
        connect(A, cloud, rt, "A", "11111111-1111-4111-8111-111111111111", "lina@test.local")
        connect(B, cloud, rt, "B", "22222222-2222-4222-8222-222222222222", "max@test.local")

        def a_open():
            open_project_file(A, src, res, "A1_session_artiste")
            dismiss(A)
            open_panel(A)
            A.get_by_placeholder("Ton nom (affiché aux autres)").fill("Lina")
            A.get_by_role("button", name=re.compile("Démarrer la collaboration en direct")).click()
            wait_for(A, lambda: collab(A, "c.role()") == "artist", 90, what="collaboration ouverte chez l'artiste")
            sid = next(k for k, v in cloud.sessions.items() if v["manifest"])
            link["s"] = f"{sid}.{cloud.sessions[sid]['secret']}"
        step("A : ouvre sa session (voix sur beat A) et démarre la collaboration", a_open)

        def b_join():
            B.goto(f"{BASE}?session={link['s']}&role=engineer", wait_until="domcontentloaded")
            wait_for(B, lambda: collab(B, "c.role()") == "engineer", 90, what="B relié")
            dismiss(B)
            wait_for(B, lambda: B.evaluate("() => { const s = window.__novaEdit && window.__novaEdit.getState(); return !!s && s.tracks.some(t => t.id === 'voix' && t.clips.length); }"), 90, what="voix reçue chez B")
            close_overlays(A); close_overlays(B)
            return {"A": summary(A)["bpm"], "B": summary(B)["bpm"]}
        step("B : rejoint par le lien et reçoit la session", b_join)

        def a_swap():
            n0 = len(cloud.ops)
            res["_n0"] = n0
            A.evaluate("async () => { const m = await window.__novaAppModule('/utils/r23Store.ts'); m.r23Bus.emit({ kind: 'openSwap' }); }")
            A.wait_for_selector("[data-testid=beat-swap-dialog]", timeout=15000)
            with A.expect_file_chooser(timeout=10000) as fc:
                A.get_by_test_id("beatswap-file").click()
            fc.value.set_files(str(SRC_DIR / "beat_B_100_la_mineur.wav"))
            A.wait_for_selector("[data-testid=beatswap-plan]", timeout=180000)
            A.get_by_test_id("beatswap-go").click()
            A.wait_for_selector("[data-testid=beat-swap-result]", timeout=300000)
            sa = summary(A)
            res["_A"] = sa
            t0 = time.time()
            wait_for(B, lambda: summary(B)["bpm"] == 100 and [c["bufferId"] for c in summary(B)["voix"]] == [c["bufferId"] for c in sa["voix"]], 120, what="voix recalées reçues chez B")
            res["_delai"] = round(time.time() - t0, 1)
            B.wait_for_timeout(1500)
            shot(A, "A2_beat_change"); shot(B, "B2_beat_recu")
            ops = cloud.ops[n0:]
            kinds = [o["kind"] for o in ops]
            return {"operations_apres_le_changement": kinds, "beatswap": kinds.count("beatswap"), "delai_B_s": res["_delai"]}
        o = step("A remplace l'instru (beat B) → B reçoit tout en une opération", a_swap)

        def compare():
            sa, sb = res["_A"], summary(B)
            same = {k: sa[k] == sb[k] for k in ("bpm", "key", "markers", "chords")}
            same["voix_place"] = [round(c["start"], 6) for c in sa["voix"]] == [round(c["start"], 6) for c in sb["voix"]]
            same["beat"] = [round(c["duration"], 3) for c in sa["beat"]] == [round(c["duration"], 3) for c in sb["beat"]]
            va, sr = buffer_of(A, sa["voix"][0]["bufferId"])
            vb, _ = buffer_of(B, sb["voix"][0]["bufferId"])
            n = min(va.shape[1], vb.shape[1])
            diff = float(np.sqrt(np.mean((va[:, :n].mean(0) - vb[:, :n].mean(0)) ** 2)) / (np.sqrt(np.mean(va[:, :n].mean(0) ** 2)) + 1e-12))
            same["son_voix_ecart_relatif"] = round(diff, 4)
            assert all(v for k, v in same.items() if k != "son_voix_ecart_relatif") and diff < 0.02, same
            return same
        step("B : même tempo, tonalité, repères, accords, beat, voix (son et place)", compare)

        def b_undo():
            B.mouse.click(5, 5)
            B.keyboard.press("Control+z"); B.wait_for_timeout(1200)
            sb = summary(B)
            assert sb["bpm"] == 94 and sb["key"] == 7, sb
            return {"bpm": sb["bpm"], "key": sb["key"], "voix_start": sb["voix"][0]["start"]}
        step("B : un seul Ctrl+Z revient à l'ancien beat", b_undo)

        if o is not None:
            kinds = o["operations_apres_le_changement"]
            if o["beatswap"] != 1 or any(k in kinds for k in ("content", "tempo", "markers", "chords")):
                res["ok"] = False
                res["steps"].append({"step": "une seule opération", "ok": False, "err": f"journal : {kinds}"})
        res["erreurs_console"] = [e["text"][:300] for e in (logA.errors() + logB.errors())][:30]
        res["http_400_plus"] = [e["text"][:200] for e in (logA.entries + logB.entries) if e["kind"] == "http"][:20]
        save_log(logA); save_log(logB)
        for k in ("_A", "_n0", "_delai"):
            res.pop(k, None)
        b.close()
    (OUT / "r23_collab.json").write_text(json.dumps(res, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    print(json.dumps(res, ensure_ascii=False, indent=1, default=str))


if __name__ == "__main__":
    run()
