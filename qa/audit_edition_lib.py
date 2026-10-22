"""Outils communs du tour « édition et navigation » (qa/audit_edition.py).

Projet de banc : N pistes audio × M clips (60 × 10 = 600 clips par défaut), sons synthétiques courts
(6 fichiers partagés), morceau de 3 min 20 à 90 BPM. Ouverture par « Charger Projet » (.zip),
Supabase simulé (qalib), navigateur headless.
"""
import io, json, math, os, re, struct, sys, wave, zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import qalib  # noqa: E402,F401  (Supabase simulé avant tout navigateur)
from qalib import BASE, shot  # noqa: E402

SR = 22050
BPM = 90
SND_S = 16.0


def _wav(k):
    n = int(SR * SND_S)
    f = 110 + 55 * k
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(b"".join(struct.pack("<h", int(0.3 * math.sin(2 * math.pi * f * i / SR) * (0.5 + 0.5 * math.sin(2 * math.pi * (k + 1) * i / SR / 4)) * 32767)) for i in range(n)))
    return b.getvalue()


def make_bench_project(path: Path, n_tracks=60, n_clips=10, clip_s=12.0, gap_s=8.0, name="Banc édition"):
    tracks = []
    for i in range(n_tracks):
        clips = []
        for j in range(n_clips):
            clips.append({"id": f"c{i}_{j}", "name": f"P{i + 1}-{j + 1}", "type": "AUDIO", "start": j * (clip_s + gap_s), "duration": clip_s,
                          "offset": 0, "audioRef": f"audio/s{i % 6}.wav", "color": None, "fadeIn": 0, "fadeOut": 0, "gain": 1, "isMuted": False})
        tracks.append({"id": f"t{i}", "name": f"Piste {i + 1}", "type": "AUDIO", "color": ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7"][i % 5],
                       "isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "volume": 0.8, "pan": 0,
                       "outputTrackId": "master", "sends": [], "clips": clips, "plugins": [], "automationLanes": [], "totalLatency": 0})
    tracks.append({"id": "master", "name": "MASTER", "type": "BUS", "color": "#64748b", "isMuted": False, "isSolo": False, "isTrackArmed": False,
                   "isFrozen": False, "volume": 1, "pan": 0, "outputTrackId": "", "sends": [], "clips": [], "plugins": [], "automationLanes": [], "totalLatency": 0})
    state = {"id": "qa-banc-edition", "name": name, "bpm": BPM, "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False,
             "loopStart": 0, "loopEnd": 8, "tracks": tracks, "selectedTrackId": "t0", "currentView": "ARRANGEMENT",
             "timeSignature": {"numerator": 4, "denominator": 4}, "trackGroups": [], "markers": [],
             "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
             "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0}}
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        for k in range(6):
            z.writestr(f"audio/s{k}.wav", _wav(k))
    return path


INIT = """
try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_count_in', '0'); localStorage.setItem('nova_auto_clean', '0');
      localStorage.setItem('nova_welcome_seen', '1'); } catch (e) {}
window.__perf = { long: [], frames: [] };
try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__perf.long.push(e.duration); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
"""

FRAMES_START = r"""() => { const P = window.__perf; P.frames = []; P.long = []; P.on = true; let last = performance.now();
  const tick = (t) => { if (!P.on) return; P.frames.push(t - last); last = t; requestAnimationFrame(tick); }; requestAnimationFrame(tick); return true; }"""
FRAMES_STOP = r"""() => { const P = window.__perf; P.on = false; const f = P.frames.slice(2).sort((a, b) => a - b); const tot = f.reduce((a, b) => a + b, 0);
  return { images: f.length, fps: f.length ? Math.round(1000 * f.length / tot) : null, mediane_ms: f.length ? +f[Math.floor(f.length / 2)].toFixed(1) : null,
           p95_ms: f.length ? +f[Math.floor(f.length * 0.95)].toFixed(1) : null, pire_ms: f.length ? Math.round(f[f.length - 1]) : null,
           taches_longues: P.long.length, taches_longues_ms: Math.round(P.long.reduce((a, b) => a + b, 0)) }; }"""

GEO = r"""() => { const l = document.querySelector("[data-arrange-scroll]");
  return { zoomH: l ? +l.dataset.zoomH : null, zoomV: l ? +l.dataset.zoomV : null, scrollLeft: l ? l.scrollLeft : null, scrollTop: l ? l.scrollTop : null, cw: l ? l.clientWidth : null }; }"""


def open_project(page, f: Path, label=None):
    page.add_init_script(INIT)
    page.route("**/functions/v1/nova-billing", lambda r: r.fulfill(status=200, content_type="application/json",
               body=json.dumps({"plans": [], "admin": True, "unlocked": True, "free_exports_left": 10})))
    page.goto(BASE, wait_until="domcontentloaded")
    page.get_by_text("Charger Projet").first.wait_for(timeout=60000)
    page.get_by_text("Charger Projet").first.click()
    page.wait_for_timeout(700)
    with page.expect_file_chooser(timeout=8000) as fc:
        page.get_by_text("Charger depuis l'ordinateur").first.click()
    fc.value.set_files(str(f))
    page.wait_for_timeout(5000)
    for nm in ("C'est parti", "Plus tard"):
        bb = page.get_by_role("button", name=nm, exact=True).locator("visible=true").first
        try:
            if bb.is_visible(): bb.click(); page.wait_for_timeout(300)
        except Exception:
            pass
    page.wait_for_function("() => !!window.DAW_CONTROL && window.DAW_CONTROL.getState().tracks.length > 1", timeout=60000)
    adv = page.get_by_role("button", name=re.compile("Mode avanc", re.I)).locator("visible=true").first
    try:
        if adv.is_visible(): adv.click(); page.wait_for_timeout(500)
    except Exception:
        pass
    page.wait_for_timeout(800)
    if label:
        shot(page, label)


def st(page, expr="s => s"):
    return page.evaluate(f"() => {{ const s = window.DAW_CONTROL.getState(); return ({expr})(s); }}")
