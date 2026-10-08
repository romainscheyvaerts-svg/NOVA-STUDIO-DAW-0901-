"""Banc : UADx LA-2A Silver Compressor -> effet NOVA « Leveler 2A »."""

ID = "ua_la2a"
PLUGIN = "uaudio_teletronix_la-2a_silver.vst3"
NOVA_KIND = "LEVELER2A"
PY_PROFILE = "modeles.la2a_profil"

VOIX = r"D:\1 WORK\CONTENU\nova-autotune\micro_sec_12s.wav"
BATTERIE = r"D:\1 WORK\CONTENU\nova-v20\materiaux\B_boucle_batterie.wav"

BASE = {"power": True, "master_bypass": False, "mix": 100.0, "meter": "GR", "comp_limit": "Comp",
        "emphasis": 0.0, "peak_reduct": "0", "gain": "50"}
NOVA_BASE = {}

LEVELS = [-50, -45, -40, -36, -32, -28, -25, -22, -19, -16, -13, -10, -7, -4, -2, 0]
THD_LEVELS = [-40, -30, -20, -12, -6, -3, 0]


def _num(v, lo_word=0.0, hi_word=100.0):
    if str(v) == "Min":
        return lo_word
    if str(v) == "Max":
        return hi_word
    return float(v)


def to_nova(s):
    m = dict(BASE)
    m.update(s)
    return {"peakReduction": _num(m["peak_reduct"]), "gain": _num(m["gain"]),
            "limit": 1 if m["comp_limit"] == "Limit" else 0, "emphasis": float(m["emphasis"]),
            "mix": float(m["mix"])}


def _step(name, base, step, hold, rel_obs, freq=1000):
    return {"type": "step_response", "name": name, "freq": freq, "base_db": base, "step_db": step, "hold": hold,
            "rel_obs": rel_obs}


CASES = [
    {"name": "lineaire", "settings": {"peak_reduct": "0"}, "tests": [
        {"type": "freq_response", "name": "fr_-30", "level_db": -30},
        {"type": "freq_response", "name": "fr_-12", "level_db": -12},
        {"type": "noise_response", "name": "rose_-20", "rms_db": -20},
        {"type": "tone_levels", "name": "thd_1k", "freq": 1000, "levels": [-50] + THD_LEVELS, "dur": 1.0},
        {"type": "tone_levels", "name": "thd_100", "freq": 100, "levels": THD_LEVELS, "dur": 1.0},
        {"type": "tone_levels", "name": "thd_50", "freq": 50, "levels": THD_LEVELS, "dur": 1.0},
        {"type": "tone_levels", "name": "thd_5k", "freq": 5000, "levels": THD_LEVELS, "dur": 1.0},
        {"type": "stereo_link", "loud_db": -6, "quiet_db": -30},
    ]},
    *[{"name": f"gain_{g}", "settings": {"peak_reduct": "0", "gain": str(g)}, "tests": [
        {"type": "tone_levels", "name": "thd_1k", "freq": 1000, "levels": [-50, -30, -20, -10], "dur": 0.6}]}
      for g in [0, 20, 40, 60, 80, 100]],
    *[{"name": f"stat_pr{p}", "settings": {"peak_reduct": str(p)}, "tests": [
        {"type": "tone_levels", "name": "stat_1k", "freq": 1000, "levels": LEVELS, "dur": 4.0}]}
      for p in [10, 20, 30, 40, 50, 60, 80, 100]],
    *[{"name": f"stat_limit_pr{p}", "settings": {"peak_reduct": str(p), "comp_limit": "Limit"}, "tests": [
        {"type": "tone_levels", "name": "stat_1k", "freq": 1000, "levels": LEVELS, "dur": 4.0}]}
      for p in [30, 60]],
    {"name": "stat_pr50_freq", "settings": {"peak_reduct": "50"}, "tests": [
        {"type": "tone_levels", "name": "stat_100", "freq": 100, "levels": LEVELS[::2], "dur": 4.0},
        {"type": "tone_levels", "name": "stat_5k", "freq": 5000, "levels": LEVELS[::2], "dur": 4.0},
        {"type": "tone_levels", "name": "stat_10k", "freq": 10000, "levels": LEVELS[::2], "dur": 4.0},
        {"type": "freq_response", "name": "fr_comp_-15", "level_db": -15},
        {"type": "noise_response", "name": "rose_comp_-16", "rms_db": -16}]},
    *[{"name": f"stat_pr50_emph{e}", "settings": {"peak_reduct": "50", "emphasis": float(e)}, "tests": [
        {"type": "tone_levels", "name": "stat_5k", "freq": 5000, "levels": LEVELS[::2], "dur": 4.0},
        {"type": "tone_levels", "name": "stat_1k", "freq": 1000, "levels": LEVELS[::2], "dur": 4.0}]}
      for e in [50, 100]],
    {"name": "thd_comp", "settings": {"peak_reduct": "50"}, "tests": [
        {"type": "tone_levels", "name": "thd_100", "freq": 100, "levels": [-40, -30, -20, -10, -4], "dur": 3.0},
        {"type": "tone_levels", "name": "thd_1k", "freq": 1000, "levels": [-40, -30, -20, -10, -4], "dur": 3.0}]},
    # Temps : attaque, relâchement à deux temps et mémoire de programme
    *[{"name": f"temps_pr{p}", "settings": {"peak_reduct": str(p)}, "tests": [
        _step("h0.1_s20", -45, 20, 0.1, 12.0), _step("h1_s20", -45, 20, 1.0, 12.0), _step("h5_s20", -45, 20, 5.0, 15.0),
        _step("h1_s30", -45, 30, 1.0, 12.0), _step("h1_s10", -45, 10, 1.0, 12.0)]}
      for p in [50, 80]],
    {"name": "temps_limit", "settings": {"peak_reduct": "60", "comp_limit": "Limit"}, "tests": [
        _step("h1_s20", -45, 20, 1.0, 12.0)]},
    {"name": "transitoires", "settings": {"peak_reduct": "60"}, "tests": [
        {"type": "bursts", "name": "salves_10ms", "base_db": -40, "burst_db": -10, "burst_ms": 10, "period_ms": 250},
        {"type": "bursts", "name": "salves_50ms", "base_db": -40, "burst_db": -10, "burst_ms": 50, "period_ms": 400},
        {"type": "real_signal", "name": "batterie", "path": BATTERIE, "seconds": 8, "rms_db": -18},
    ]},
    {"name": "romain_bus", "settings": {"peak_reduct": "20", "gain": "25"}, "tests": [
        {"type": "real_signal", "name": "voix", "path": VOIX, "seconds": 12, "rms_db": -14},
        {"type": "tone_levels", "name": "stat_1k", "freq": 1000, "levels": LEVELS[::2], "dur": 4.0}]},
    {"name": "voix_pr55", "settings": {"peak_reduct": "55"}, "tests": [
        {"type": "real_signal", "name": "voix", "path": VOIX, "seconds": 12, "rms_db": -18}]},
    {"name": "melange", "settings": {"peak_reduct": "70", "mix": 50.0}, "tests": [
        {"type": "tone_levels", "name": "stat_1k", "freq": 1000, "levels": LEVELS[::2], "dur": 4.0}]},
]

PY_PROFILE = "modeles.la2a_profil"

# ── Cartographie fine (calage du profil Leveler 2A) ──────────────────────────
CARTO_LEVELS = [-60, -55, -50, -46, -42, -39, -36, -33, -30, -28, -26, -24, -22, -20, -18, -16, -14, -12, -10, -8,
                -6, -4, -2, 0]
CARTO = [
    *[{"name": f"c_pr{p}", "settings": {"peak_reduct": str(p)}, "tests": [
        {"type": "tone_levels", "name": "stat_1k", "freq": 1000, "levels": CARTO_LEVELS, "dur": 3.0}]}
      for p in [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]],
    *[{"name": f"c_lim{p}", "settings": {"peak_reduct": str(p), "comp_limit": "Limit"}, "tests": [
        {"type": "tone_levels", "name": "stat_1k", "freq": 1000, "levels": CARTO_LEVELS, "dur": 3.0}]}
      for p in [20, 40, 60, 80, 100]],
    *[{"name": f"c_emph{e}_f{f}", "settings": {"peak_reduct": "50", "emphasis": float(e)}, "tests": [
        {"type": "tone_levels", "name": "stat", "freq": f, "levels": [-30, -24, -18, -12, -6], "dur": 3.0}]}
      for e in [0, 10, 25, 40, 50, 75, 100] for f in [100, 300, 1000, 3000, 5000, 10000]],
    *[{"name": f"c_gain{g}", "settings": {"peak_reduct": "0", "gain": str(g)}, "tests": [
        {"type": "tone_levels", "name": "g", "freq": 1000, "levels": [-60, -50], "dur": 0.3}]}
      for g in range(0, 101, 5)],
    *[{"name": f"c_t_pr{p}", "settings": {"peak_reduct": str(p)}, "tests": [
        {"type": "step_response", "name": f"h{h}", "base_db": -50, "step_db": 25, "hold": h, "rel_obs": 10.0}
        for h in [0.05, 0.1, 0.3, 1.0, 3.0]]}
      for p in [40, 60, 80]],
    *[{"name": f"c_t_lim{p}", "settings": {"peak_reduct": str(p), "comp_limit": "Limit"}, "tests": [
        {"type": "step_response", "name": f"h{h}", "base_db": -50, "step_db": 25, "hold": h, "rel_obs": 10.0}
        for h in [0.1, 1.0]]}
      for p in [60]],
]
