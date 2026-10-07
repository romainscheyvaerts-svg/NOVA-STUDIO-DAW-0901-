"""Outils communs des scénarios « Feat à distance » (plusieurs artistes, un ingé).

Tout est simulé (qa/collab_sim.py) : la fonction daw-session, Supabase
Realtime, les comptes. Rien ne part vers Supabase (écritures bloquées par
qalib). Les navigateurs sont headless : aucune fenêtre.
"""
import json, re, time, zipfile
from pathlib import Path

from qalib import BASE, shot  # noqa
from gel_pre_effet import voice_wav, PHRASES, open_project_file  # noqa

BASE_T = {"isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "pan": 0, "automationLanes": [], "totalLatency": 0}

# Pas de question casque ni de décompte : la prise part tout de suite (micro simulé).
REC_INIT = "try { localStorage.setItem('nova_headphones', '1'); localStorage.setItem('nova_count_in', '0'); localStorage.setItem('nova_auto_clean', '0'); } catch (e) {}"


def feat_project(path: Path, name="Feat à distance"):
    """Session de départ de l'artiste A : une voix (« Voix lead », 3 phrases), 16 s."""
    clips = [{"id": f"p{i+1}", "name": f"Phrase {i+1}", "start": a, "duration": b - a, "offset": a, "fadeIn": 0, "fadeOut": 0,
              "color": "#22d3ee", "type": "AUDIO", "audioRef": "audio/voix.wav", "gain": 1, "takeNumber": 1} for i, (a, b) in enumerate(PHRASES)]
    tracks = [{**BASE_T, "id": "voix", "name": "Voix lead", "type": "AUDIO", "color": "#22d3ee", "volume": 1.0, "outputTrackId": "master",
               "sends": [], "clips": clips, "plugins": []}]
    state = {
        "id": "proj-feat", "name": name, "bpm": 120, "timeSignature": {"numerator": 4, "denominator": 4},
        "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False, "loopStart": 0, "loopEnd": 8,
        "tracks": tracks, "trackGroups": [], "markers": [], "selectedTrackId": "voix", "currentView": "ARRANGEMENT",
        "projectPhase": "RECORDING", "isLowLatencyMode": False, "isRecModeActive": False, "systemMaxLatency": 0,
        "recStartTime": None, "isDelayCompEnabled": True,
        "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
        "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0},
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        z.writestr("audio/voix.wav", voice_wav())


def dismiss(page):
    for name in ("C'est parti", "Plus tard", "C'est noté"):
        b = page.get_by_role("button", name=name, exact=True).locator("visible=true").first
        try:
            if b.is_visible():
                b.click(); page.wait_for_timeout(300)
        except Exception:
            pass


def wait_for(page, fn, timeout=40, step=400, what="condition"):
    t0 = time.time()
    last = None
    while time.time() - t0 < timeout:
        try:
            v = fn()
            if v:
                return round(time.time() - t0, 1)
        except Exception as e:  # noqa
            last = e
        page.wait_for_timeout(step)
    raise AssertionError(f"délai dépassé : {what}" + (f" ({last})" if last else ""))


def collab(page, expr):
    return page.evaluate(f"() => {{ const c = window.__novaCollab; return c ? ({expr}) : null; }}")


def tracks(page):
    """Pistes (nom, propriétaire, prises) vues par une page."""
    return page.evaluate("""() => { const e = window.__novaEdit; if (!e) return null; return e.getState().tracks
      .filter(t => t.id !== 'master').map(t => ({ id: t.id, name: t.name, color: t.color, owner: t.collabOwner || null,
        ownerKey: t.collabOwnerKey || null, ownerName: t.collabOwnerName || null,
        clips: (t.clips || []).map(c => ({ id: c.id, name: c.name, start: +(+c.start).toFixed(2), dur: +(+c.duration).toFixed(2), muted: !!c.isMuted, buf: c.bufferId || null })) })); }""")


def open_panel(page):
    if page.locator("[aria-labelledby='collab-title']").count():
        return
    b = page.get_by_role("button", name=re.compile(r"(Collaborer|en ligne · Chat)")).locator("visible=true").first
    b.click(); page.wait_for_timeout(600)


def close_panel(page):
    loc = page.locator("[aria-labelledby='collab-title']")
    if loc.count():
        loc.get_by_role("button", name="Fermer").first.click(); page.wait_for_timeout(300)


def panel_text(page):
    loc = page.locator("[aria-labelledby='collab-title']")
    return loc.first.inner_text() if loc.count() else ""


def rec_button(page):
    return page.get_by_role("button", name=re.compile(r"^(Enregistrer|Arrêter l'enregistrement)$")).locator("visible=true").first


def record(page, seconds=3.0):
    """Prise au micro simulé (REC, puis REC pour arrêter). Renvoie le temps d'enregistrement réel."""
    rec_button(page).click()
    t0 = time.time()
    page.wait_for_timeout(int(seconds * 1000))
    rec_button(page).click()
    page.wait_for_timeout(1500)
    return round(time.time() - t0, 2)
