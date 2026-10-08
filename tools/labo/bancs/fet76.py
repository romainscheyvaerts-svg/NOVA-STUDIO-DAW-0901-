"""Banc : UADx 1176AE Compressor -> effet NOVA « FET 76 »."""

ID = "ua_1176"
PLUGIN = "uaudio_ua_1176ae.vst3"
NOVA_KIND = "FET76"
PY_PROFILE = "modeles.fet76_profil"

VOIX = r"D:\1 WORK\CONTENU\nova-autotune\micro_sec_12s.wav"
BATTERIE = r"D:\1 WORK\CONTENU\nova-v20\materiaux\B_boucle_batterie.wav"

BASE = {"power": True, "master_bypass": False, "mix": 100.0, "meter": "GR", "sc_filter": False, "headroom": 16.0,
        "input": -24.0, "output": -24.0, "attack": 4.0, "release": 4.0, "ratio": "4:1"}
NOVA_BASE = {}

LEVELS = [-60, -55, -50, -46, -42, -38, -35, -32, -29, -26, -23, -20, -17, -14, -11, -8, -5, -2, 0]
THD_LEVELS = [-40, -30, -20, -12, -6, -3, 0]


def to_nova(s):
    m = dict(BASE)
    m.update(s)
    att = m["attack"]
    rmap = {"None": 0.0, "2:1": 2.0, "4:1": 4.0, "8:1": 8.0, "20:1": 20.0, "4:1+20:1": 24.0}
    return {"input": float(m["input"]), "output": float(m["output"]),
            "attack": 1.0 if str(att) == "SLO" else float(att), "slo": 1 if str(att) == "SLO" else 0,
            "release": float(m["release"]), "ratio": rmap.get(str(m["ratio"]), 4.0), "mix": float(m["mix"]),
            "scFilter": 1 if m["sc_filter"] in (True, "True") else 0, "headroom": float(m["headroom"])}


def _step(name, base, step, hold, rel_obs, freq=1000):
    return {"type": "step_response", "name": name, "freq": freq, "base_db": base, "step_db": step, "hold": hold,
            "rel_obs": rel_obs}


CASES = [
    {"name": "lineaire", "settings": {"ratio": "None"}, "tests": [
        {"type": "freq_response", "name": "fr_-30", "level_db": -30},
        {"type": "freq_response", "name": "fr_-12", "level_db": -12},
        {"type": "noise_response", "name": "rose_-20", "rms_db": -20},
        {"type": "tone_levels", "name": "thd_1k", "freq": 1000, "levels": [-50] + THD_LEVELS, "dur": 1.0},
        {"type": "tone_levels", "name": "thd_100", "freq": 100, "levels": THD_LEVELS, "dur": 1.0},
        {"type": "tone_levels", "name": "thd_50", "freq": 50, "levels": THD_LEVELS, "dur": 1.0},
        {"type": "tone_levels", "name": "thd_5k", "freq": 5000, "levels": THD_LEVELS, "dur": 1.0},
        {"type": "stereo_link", "loud_db": -6, "quiet_db": -30},
    ]},
    # Gain des boutons d'entrée / sortie (sans compression)
    *[{"name": f"gain_in{i}_out{o}", "settings": {"ratio": "None", "input": float(i), "output": float(o)}, "tests": [
        {"type": "tone_levels", "name": "thd_1k", "freq": 1000, "levels": [-50, -30, -20, -10], "dur": 0.6}]}
      for i, o in [(-48, -24), (-36, -24), (-24, -24), (-12, -24), (-6, -24), (0, -24), (-24, -48), (-24, -36),
                   (-24, -12), (-24, 0)]],
    # Courbes statiques : taux x entrée
    *[{"name": f"stat_r{r}_in{i}", "settings": {"ratio": r, "input": float(i)}, "tests": [
        {"type": "tone_levels", "name": "stat_1k", "freq": 1000, "levels": LEVELS, "dur": 1.5}]}
      for r, i in [("2:1", -24), ("4:1", -24), ("8:1", -24), ("20:1", -24), ("4:1+20:1", -24), ("2:1+20:1", -24),
                   ("4:1", -36), ("4:1", -12), ("4:1", -48), ("4:1", 0)]],
    {"name": "stat_r4_freq", "settings": {"ratio": "4:1", "input": -24.0}, "tests": [
        {"type": "tone_levels", "name": "stat_100", "freq": 100, "levels": LEVELS[::2], "dur": 1.5},
        {"type": "tone_levels", "name": "stat_5k", "freq": 5000, "levels": LEVELS[::2], "dur": 1.5},
        {"type": "freq_response", "name": "fr_comp_-15", "level_db": -15},
        {"type": "noise_response", "name": "rose_comp_-14", "rms_db": -14}]},
    {"name": "stat_r4_scfilter", "settings": {"ratio": "4:1", "input": -24.0, "sc_filter": True}, "tests": [
        {"type": "tone_levels", "name": "stat_100", "freq": 100, "levels": LEVELS[::2], "dur": 1.5},
        {"type": "tone_levels", "name": "stat_1k", "freq": 1000, "levels": LEVELS[::2], "dur": 1.5}]},
    *[{"name": f"stat_r4_hr{h}", "settings": {"ratio": "4:1", "input": -24.0, "headroom": float(h)}, "tests": [
        {"type": "tone_levels", "name": "stat_1k", "freq": 1000, "levels": LEVELS[::2], "dur": 1.5}]}
      for h in [4, 28]],
    # Distorsion en compression (relâchement rapide = distorsion grave)
    *[{"name": f"thd_comp_a{a}_r{r}", "settings": {"ratio": "4:1", "input": -24.0, "attack": a, "release": r}, "tests": [
        {"type": "tone_levels", "name": "thd_100", "freq": 100, "levels": [-40, -30, -20, -10], "dur": 1.5},
        {"type": "tone_levels", "name": "thd_1k", "freq": 1000, "levels": [-40, -30, -20, -10], "dur": 1.5}]}
      for a, r in [(7.0, 7.0), (1.0, 1.0), (4.0, 4.0)]],
    # Attaque / relâchement
    *[{"name": f"att_{a}", "settings": {"ratio": "4:1", "input": -24.0, "attack": a, "release": 4.0}, "tests": [
        _step("att_s15", -55, 25, 0.5, 2.0, freq=2000), _step("att_s30", -55, 40, 0.5, 2.0, freq=2000)]}
      for a in ["SLO", 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]],
    *[{"name": f"rel_{r}", "settings": {"ratio": "4:1", "input": -24.0, "attack": 4.0, "release": r}, "tests": [
        _step("rel_h0.1", -55, 35, 0.1, 3.0), _step("rel_h1", -55, 35, 1.0, 3.0), _step("rel_h1_s20", -55, 25, 1.0, 3.0)]}
      for r in [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]],
    {"name": "ratio20_temps", "settings": {"ratio": "20:1", "input": -24.0, "attack": 4.0, "release": 4.0}, "tests": [
        _step("rel_h1", -55, 35, 1.0, 3.0), _step("att_s30", -55, 40, 0.5, 2.0, freq=2000)]},
    # Transitoires et vrais signaux
    {"name": "transitoires", "settings": {"ratio": "4:1", "input": -18.0, "attack": 3.0, "release": 5.0}, "tests": [
        {"type": "bursts", "name": "salves_10ms", "base_db": -45, "burst_db": -15, "burst_ms": 10, "period_ms": 250},
        {"type": "bursts", "name": "salves_2ms", "base_db": -45, "burst_db": -15, "burst_ms": 2, "period_ms": 200},
        {"type": "real_signal", "name": "batterie", "path": BATTERIE, "seconds": 8, "rms_db": -18},
    ]},
    {"name": "romain_bus", "settings": {"ratio": "4:1", "input": -28.0, "output": -15.0, "attack": 5.0,
                                        "release": 6.0}, "tests": [
        {"type": "real_signal", "name": "voix", "path": VOIX, "seconds": 12, "rms_db": -16},
        {"type": "tone_levels", "name": "stat_1k", "freq": 1000, "levels": LEVELS[::2], "dur": 1.5}]},
    {"name": "voix_r8", "settings": {"ratio": "8:1", "input": -20.0, "attack": 3.0, "release": 5.0}, "tests": [
        {"type": "real_signal", "name": "voix", "path": VOIX, "seconds": 12, "rms_db": -16}]},
    {"name": "melange", "settings": {"ratio": "8:1", "input": -16.0, "mix": 50.0}, "tests": [
        {"type": "tone_levels", "name": "stat_1k", "freq": 1000, "levels": LEVELS[::2], "dur": 1.5},
        {"type": "freq_response", "name": "fr_-40", "level_db": -40}]},
]

# ── Cartographie fine (calage du profil FET 76) ─────────────────────────────
CARTO_LEVELS = [-60, -50, -45, -42, -40, -38, -36, -34, -32, -30, -28, -26, -24, -22, -20, -18, -16, -14, -12, -10,
                -8, -6, -4, -2, 0]
CARTO = [
    *[{"name": f"c_in{i}", "settings": {"ratio": "None", "input": float(i), "output": -24.0}, "tests": [
        {"type": "tone_levels", "name": "g", "freq": 1000, "levels": [-60, -50], "dur": 0.3}]}
      for i in range(-60, 1, 3)],
    *[{"name": f"c_out{o}", "settings": {"ratio": "None", "input": -24.0, "output": float(o)}, "tests": [
        {"type": "tone_levels", "name": "g", "freq": 1000, "levels": [-60, -50], "dur": 0.3}]}
      for o in range(-60, 1, 3)],
    *[{"name": f"c_ratio{r}", "settings": {"ratio": r, "input": -24.0}, "tests": [
        {"type": "tone_levels", "name": "stat_1k", "freq": 1000, "levels": CARTO_LEVELS, "dur": 1.5}]}
      for r in ["2:1", "4:1", "8:1", "20:1", "4:1+20:1"]],
    *[{"name": f"c_att{a}", "settings": {"ratio": "4:1", "input": -24.0, "attack": a, "release": 4.0}, "tests": [
        {"type": "step_response", "name": "s30", "freq": 2000, "base_db": -55, "step_db": 40, "hold": 0.3, "rel_obs": 2.0},
        {"type": "step_response", "name": "s20", "freq": 2000, "base_db": -55, "step_db": 30, "hold": 0.3, "rel_obs": 2.0}]}
      for a in ["SLO", 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0]],
    *[{"name": f"c_rel{r}", "settings": {"ratio": "4:1", "input": -24.0, "attack": 4.0, "release": r}, "tests": [
        {"type": "step_response", "name": "s30", "base_db": -55, "step_db": 40, "hold": 1.0, "rel_obs": 3.0},
        {"type": "step_response", "name": "s20", "base_db": -55, "step_db": 30, "hold": 1.0, "rel_obs": 3.0},
        {"type": "step_response", "name": "s30h01", "base_db": -55, "step_db": 40, "hold": 0.1, "rel_obs": 3.0}]}
      for r in [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0]],
]
