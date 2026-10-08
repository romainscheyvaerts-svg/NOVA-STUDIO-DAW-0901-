"""Projet de mix réaliste (rap / trap) pour les sessions chronométrées : N pistes audio, bus, retours.

Pistes : batterie (kick, snare, hi-hats, perc, 808), musique (synthé, piano, nappe), voix (lead,
double, 4 backs, 2 adlibs, 2 harmonies…), puis bus Drums / Voix, retours Reverb et Écho, master.
Audio synthétique court (8 s, 140 BPM) : chaque piste a son propre son (fréquence, rythme).
`make_mix_project(path, n)` : n pistes audio (20 par défaut, 40 pour la mesure de charge).
"""
import io, json, math, struct, wave, zipfile

SR = 22050
DUR = 8.0
BPM = 140

NAMES = ["Kick", "Snare", "Hi-hats", "Perc", "808", "Synthé", "Piano", "Nappe", "Lead", "Double",
         "Back 1", "Back 2", "Back 3", "Back 4", "Adlib 1", "Adlib 2", "Harmo 1", "Harmo 2", "Ambiance", "FX montée"]


def _wav(fn):
    n = int(SR * DUR)
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, fn(i / SR))) * 20000)) for i in range(n)))
    return b.getvalue()


def _sound(k):
    spb = 60 / BPM
    f = 80 + 37 * k
    if k == 0:   # kick
        return lambda t: 0.9 * math.sin(2 * math.pi * (50 + 80 * math.exp(-(t % spb) * 30)) * (t % spb)) * math.exp(-(t % spb) * 8)
    if k == 4:   # 808 tenue
        return lambda t: 0.6 * math.sin(2 * math.pi * 49 * t) * (0.4 + 0.6 * math.exp(-(t % (2 * spb)) * 1.5))
    if k == 2:   # hi-hats
        return lambda t: 0.25 * math.sin(2 * math.pi * 7500 * t) * math.exp(-(t % (spb / 2)) * 60)
    return lambda t: 0.3 * math.sin(2 * math.pi * f * t) * (0.5 + 0.5 * math.sin(2 * math.pi * (k % 5 + 1) * t / DUR))


def make_mix_project(path, n=20, name="Mix QA"):
    names = [NAMES[i] if i < len(NAMES) else f"Piste {i + 1}" for i in range(n)]
    drums = {"Kick", "Snare", "Hi-hats", "Perc", "808"}
    voix = {"Lead", "Double", "Back 1", "Back 2", "Back 3", "Back 4", "Adlib 1", "Adlib 2", "Harmo 1", "Harmo 2"}
    tracks, audio = [], {}
    for i, nm in enumerate(names):
        tid = f"t{i}"
        out = "bus-drums" if nm in drums else ("bus-voix" if nm in voix else "master")
        clip = {"id": f"c{i}", "name": nm, "type": "AUDIO", "start": 0, "duration": DUR, "offset": 0, "audioRef": f"audio/{tid}.wav",
                "color": "#22d3ee", "fadeIn": 0, "fadeOut": 0, "gain": 1, "isMuted": False}
        tracks.append({"id": tid, "name": nm, "type": "AUDIO", "color": ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7"][i % 5],
                       "isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False, "volume": 0.8, "pan": 0,
                       "outputTrackId": out, "sends": [], "clips": [clip], "plugins": [], "automationLanes": [], "totalLatency": 0})
        audio[tid] = _wav(_sound(i))
    def bus(tid, nm, typ="BUS", plugins=None):
        return {"id": tid, "name": nm, "type": typ, "color": "#64748b", "isMuted": False, "isSolo": False, "isTrackArmed": False, "isFrozen": False,
                "volume": 1, "pan": 0, "outputTrackId": "master" if tid != "master" else "", "sends": [], "clips": [], "plugins": plugins or [],
                "automationLanes": [], "totalLatency": 0}
    verb = {"id": "verb1", "type": "REVERB", "name": "Reverb", "isEnabled": True, "params": {"mix": 1, "decay": 1.8, "preDelay": 0.02, "size": 0.6}}
    echo = {"id": "echo1", "type": "DELAY", "name": "Écho", "isEnabled": True, "params": {"mix": 1, "time": 0.214, "feedback": 0.3}}
    tracks += [bus("bus-drums", "Bus Drums"), bus("bus-voix", "Bus Voix"), bus("ret-verb", "Reverb", "SEND", [verb]), bus("ret-echo", "Écho", "SEND", [echo]), bus("master", "MASTER")]
    state = {"id": f"qa-mix-{n}", "name": name, "bpm": BPM, "isPlaying": False, "isRecording": False, "currentTime": 0, "isLoopActive": False,
             "loopStart": 0, "loopEnd": DUR, "tracks": tracks, "selectedTrackId": "t8", "currentView": "ARRANGEMENT",
             "timeSignature": {"numerator": 4, "denominator": 4}, "trackGroups": [], "markers": [], "projectKey": 9, "projectScale": "MINOR",
             "metronome": {"enabled": False, "volume": 0.7, "countIn": 0, "accentDownbeat": True, "sound": "CLICK"},
             "punch": {"enabled": False, "punchIn": 0, "punchOut": 0, "preRoll": 0, "postRoll": 0}}
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("project.json", json.dumps(state))
        for k, v in audio.items():
            z.writestr(f"audio/{k}.wav", v)
    return [t["id"] for t in tracks]
