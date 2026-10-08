"""Banc : UADx Manley VOXBOX -> effet NOVA « Vox Strip »."""

ID = "manley_voxbox"
PLUGIN = "uaudio_manley_voxbox.vst3"
NOVA_KIND = "VOXSTRIP"

VOIX = r"D:\1 WORK\CONTENU\nova-autotune\micro_sec_12s.wav"

BASE = {"power": True, "master_bypass": False, "source_select": "Line", "low_cut": "Off", "phase": 0.0,
        "input": 5.0, "gain": 50.0, "sc_link": "Link", "comp_byp": "Byp", "comp_thresh": 5.0,
        "comp_attack": "Medium", "comp_rel": "Medium", "eq_byp": "Byp", "lo_peak": 0.0, "lo_peak_freq": 70.0,
        "mid_dip": 0.0, "mid_dip_freq": 300.0, "hi_peak": 0.0, "hi_peak_freq": 12000.0, "de_ess_byp": "Byp",
        "de_ess_sel": "6K", "de_ess_thr": 5.0, "meter": "GR", "transformer_byp": "In", "output": 0.0}
NOVA_BASE = {}

LEVELS = [-60, -55, -50, -45, -40, -36, -32, -28, -25, -22, -19, -16, -13, -10, -7, -4, -2, 0]
THD_LEVELS = [-40, -30, -20, -12, -6, -3, 0]


def to_nova(s):
    m = dict(BASE)
    m.update(s)
    return dict(m)


def _step(name, base, step, hold, rel_obs, freq=1000):
    return {"type": "step_response", "name": name, "freq": freq, "base_db": base, "step_db": step, "hold": hold,
            "rel_obs": rel_obs}


CASES = [
    {"name": "lineaire", "settings": {}, "tests": [
        {"type": "freq_response", "name": "fr_-30", "level_db": -30},
        {"type": "freq_response", "name": "fr_-12", "level_db": -12},
        {"type": "noise_response", "name": "rose_-20", "rms_db": -20},
        {"type": "tone_levels", "name": "thd_1k", "freq": 1000, "levels": [-50] + THD_LEVELS, "dur": 1.0},
        {"type": "tone_levels", "name": "thd_100", "freq": 100, "levels": THD_LEVELS, "dur": 1.0},
        {"type": "tone_levels", "name": "thd_50", "freq": 50, "levels": THD_LEVELS, "dur": 1.0},
        {"type": "tone_levels", "name": "thd_5k", "freq": 5000, "levels": THD_LEVELS, "dur": 1.0},
        {"type": "stereo_link", "loud_db": -6, "quiet_db": -30},
    ]},
    {"name": "lineaire_sans_transfo", "settings": {"transformer_byp": "Byp"}, "tests": [
        {"type": "freq_response", "name": "fr_-12", "level_db": -12},
        {"type": "tone_levels", "name": "thd_1k", "freq": 1000, "levels": THD_LEVELS, "dur": 1.0},
        {"type": "tone_levels", "name": "thd_100", "freq": 100, "levels": THD_LEVELS, "dur": 1.0}]},
    {"name": "lineaire_mic", "settings": {"source_select": "Mic"}, "tests": [
        {"type": "freq_response", "name": "fr_-40", "level_db": -40},
        {"type": "tone_levels", "name": "thd_1k", "freq": 1000, "levels": [-60, -50, -40, -30], "dur": 1.0}]},
    *[{"name": f"gain_in{i}_g{g}", "settings": {"input": float(i), "gain": float(g)}, "tests": [
        {"type": "tone_levels", "name": "thd_1k", "freq": 1000, "levels": [-50, -30, -20, -10], "dur": 0.6}]}
      for i, g in [(0, 50), (2.5, 50), (5, 50), (7.5, 50), (10, 50), (5, 40), (5, 60)]],
    *[{"name": f"stat_th{t}", "settings": {"comp_byp": "In", "comp_thresh": float(t)}, "tests": [
        {"type": "tone_levels", "name": "stat_1k", "freq": 1000, "levels": LEVELS, "dur": 3.0}]}
      for t in [0, 2.5, 5, 7.5, 10]],
    {"name": "stat_th5_freq", "settings": {"comp_byp": "In", "comp_thresh": 5.0}, "tests": [
        {"type": "tone_levels", "name": "stat_100", "freq": 100, "levels": LEVELS[::2], "dur": 3.0},
        {"type": "tone_levels", "name": "stat_5k", "freq": 5000, "levels": LEVELS[::2], "dur": 3.0},
        {"type": "tone_levels", "name": "thd_100", "freq": 100, "levels": [-40, -30, -20, -10], "dur": 3.0},
        {"type": "noise_response", "name": "rose_comp_-16", "rms_db": -16}]},
    *[{"name": f"temps_a{a}_r{r}".replace(" ", ""), "settings": {"comp_byp": "In", "comp_thresh": 7.0,
                                                                "comp_attack": a, "comp_rel": r}, "tests": [
        _step("h0.1_s20", -50, 25, 0.1, 6.0), _step("h1_s20", -50, 25, 1.0, 6.0), _step("h3_s30", -50, 35, 3.0, 8.0)]}
      for a, r in [("Fast", "Medium"), ("Med Fast", "Medium"), ("Medium", "Medium"), ("Med Slow", "Medium"),
                   ("Slow", "Medium"), ("Medium", "Fast"), ("Medium", "Med Fast"), ("Medium", "Med Slow"),
                   ("Medium", "Slow")]],
    # Égaliseur (compresseur contourné)
    *[{"name": f"eq_lo{f}", "settings": {"eq_byp": "In", "lo_peak": 10.0, "lo_peak_freq": float(f)}, "tests": [
        {"type": "freq_response", "name": "fr_-30", "level_db": -30}]} for f in [20, 70, 200, 1000]],
    {"name": "eq_lo100_5", "settings": {"eq_byp": "In", "lo_peak": 5.0, "lo_peak_freq": 100.0}, "tests": [
        {"type": "freq_response", "name": "fr_-30", "level_db": -30}]},
    *[{"name": f"eq_mid{f}", "settings": {"eq_byp": "In", "mid_dip": -10.0, "mid_dip_freq": float(f)}, "tests": [
        {"type": "freq_response", "name": "fr_-30", "level_db": -30}]} for f in [200, 700, 2000, 7000]],
    {"name": "eq_mid700_5", "settings": {"eq_byp": "In", "mid_dip": -5.0, "mid_dip_freq": 700.0}, "tests": [
        {"type": "freq_response", "name": "fr_-30", "level_db": -30}]},
    *[{"name": f"eq_hi{f}", "settings": {"eq_byp": "In", "hi_peak": 10.0, "hi_peak_freq": float(f)}, "tests": [
        {"type": "freq_response", "name": "fr_-30", "level_db": -30}]} for f in [1500, 5000, 12000, 20000]],
    {"name": "eq_hi8k_5", "settings": {"eq_byp": "In", "hi_peak": 5.0, "hi_peak_freq": 8000.0}, "tests": [
        {"type": "freq_response", "name": "fr_-30", "level_db": -30}]},
    *[{"name": f"lowcut_{c}", "settings": {"low_cut": c}, "tests": [
        {"type": "freq_response", "name": "fr_-30", "level_db": -30}]} for c in ["80 Hz", "120 Hz"]],
    # De-esser
    *[{"name": f"deess_{s}", "settings": {"de_ess_byp": "In", "de_ess_sel": s, "de_ess_thr": 5.0}, "tests": [
        {"type": "tone_levels", "name": "stat_1k", "freq": 1000, "levels": LEVELS[::3], "dur": 1.5},
        {"type": "tone_levels", "name": "stat_8k", "freq": 8000, "levels": LEVELS[::3], "dur": 1.5}]}
      for s in ["3K", "6K", "9K", "12K", "Limit"]],
    {"name": "romain_voix", "settings": {"comp_byp": "In", "comp_thresh": 6.0, "comp_attack": "Medium",
                                         "comp_rel": "Medium"}, "tests": [
        {"type": "real_signal", "name": "voix", "path": VOIX, "seconds": 12, "rms_db": -20}]},
]
