"""Banc : Tube-Tech CL 1B mk II (Softube) -> effet NOVA « Opto Vintage »."""

ID = "tubetech_cl1b"
PLUGIN = "Tube-Tech CL 1B mk II.vst3"
NOVA_KIND = "OPTO_VINTAGE"
PY_PROFILE = "modeles.cl1b_profil"

VOIX = r"D:\1 WORK\CONTENU\nova-autotune\micro_sec_12s.wav"
BATTERIE = r"D:\1 WORK\CONTENU\nova-v20\materiaux\B_boucle_batterie.wav"

BASE = {
    "in": True, "bypass": False, "sidechain": "Int", "sidechain_low_cut": "Off",
    "parallel_compression": 100.0, "cl1b_generation": "Modern mk II", "meter": "Comp",
    "select_attack_release": "Man", "output_volume_db": 0.0,
    "threshold_db": "Off", "ratio": "4:1", "attack": 5.0, "release": 5.0,
}
NOVA_BASE = {}

LEVELS = [-50, -45, -40, -36, -32, -28, -26, -24, -22, -20, -18, -16, -14, -12, -10, -8, -6, -4, -2, 0]
THD_LEVELS = [-30, -20, -12, -6, -3, 0]


def to_nova(s):
    """Réglages du VST (texte) -> paramètres NOVA (mêmes positions de boutons)."""
    m = dict(BASE)
    m.update(s)
    thr = m["threshold_db"]
    ratio = m["ratio"]
    return {
        "threshold": 99.0 if str(thr) == "Off" else float(thr),
        "ratio": float(str(ratio).split(":")[0]),
        "attack": float(m["attack"]),
        "release": float(m["release"]),
        "mode": {"Fix": 0, "F/M": 1, "Man": 2}[m["select_attack_release"]],
        "output": float(m["output_volume_db"]),
        "mix": float(m["parallel_compression"]),
        "scLowCut": {"Off": 0, "80 Hz": 80, "220 Hz": 220}[m["sidechain_low_cut"]],
        "vintage": 1 if m["cl1b_generation"].startswith("Vintage") else 0,
    }


def _steps(prefix, settings, holds=(1.0,), steps=(20,), base=-45, rel_obs=4.0):
    tests = []
    for h in holds:
        for st in steps:
            tests.append({"type": "step_response", "name": f"{prefix}_h{h}_s{st}", "base_db": base, "step_db": st,
                          "hold": h, "rel_obs": rel_obs})
    return tests


CASES = [
    {"name": "lineaire", "settings": {"threshold_db": "Off"}, "tests": [
        {"type": "freq_response", "name": "fr_-30", "level_db": -30},
        {"type": "freq_response", "name": "fr_-12", "level_db": -12},
        {"type": "freq_response", "name": "fr_-3", "level_db": -3},
        {"type": "noise_response", "name": "rose_-20", "rms_db": -20},
        {"type": "tone_levels", "name": "thd_1k", "freq": 1000, "levels": [-40] + THD_LEVELS + [3, 6], "dur": 1.0},
        {"type": "tone_levels", "name": "thd_100", "freq": 100, "levels": THD_LEVELS, "dur": 1.0},
        {"type": "tone_levels", "name": "thd_50", "freq": 50, "levels": THD_LEVELS, "dur": 1.0},
        {"type": "tone_levels", "name": "thd_5k", "freq": 5000, "levels": THD_LEVELS, "dur": 1.0},
        {"type": "stereo_link", "loud_db": -6, "quiet_db": -30},
    ]},
    {"name": "lineaire_vintage", "settings": {"threshold_db": "Off", "cl1b_generation": "Vintage mk I"}, "tests": [
        {"type": "freq_response", "name": "fr_-12", "level_db": -12},
        {"type": "tone_levels", "name": "thd_1k", "freq": 1000, "levels": THD_LEVELS, "dur": 1.0},
        {"type": "tone_levels", "name": "thd_100", "freq": 100, "levels": THD_LEVELS, "dur": 1.0},
    ]},
    # Courbes statiques (seuil x taux)
    *[{"name": f"stat_t{t}_r{r}", "settings": {"threshold_db": float(t), "ratio": f"{r}:1"}, "tests": [
        {"type": "tone_levels", "name": "stat_1k", "freq": 1000, "levels": LEVELS, "dur": 2.5}]}
      for t, r in [(-20, 2), (-20, 4), (-20, 6), (-20, 10), (-30, 4), (-10, 4), (-40, 4), (0, 4)]],
    # Courbe statique : dépend-elle de la fréquence (filtre de détection) ?
    {"name": "stat_t-20_r4_f100", "settings": {"threshold_db": -20.0, "ratio": "4:1"}, "tests": [
        {"type": "tone_levels", "name": "stat_100", "freq": 100, "levels": LEVELS[::2], "dur": 2.5},
        {"type": "tone_levels", "name": "stat_5k", "freq": 5000, "levels": LEVELS[::2], "dur": 2.5},
        {"type": "freq_response", "name": "fr_comp_-10", "level_db": -10},
        {"type": "noise_response", "name": "rose_comp_-14", "rms_db": -14}]},
    *[{"name": f"stat_t-20_r4_sc{sc}", "settings": {"threshold_db": -20.0, "ratio": "4:1", "sidechain_low_cut": sc},
       "tests": [{"type": "tone_levels", "name": "stat_100", "freq": 100, "levels": LEVELS[::2], "dur": 2.5}]}
      for sc in ["80 Hz", "220 Hz"]],
    # Attaque (relâchement fixe), puis relâchement (attaque fixe), mode manuel
    *[{"name": f"att_{a}", "settings": {"threshold_db": -30.0, "ratio": "4:1", "attack": a, "release": 5.0},
       "tests": _steps("att", {}, holds=(1.0,), steps=(15, 25))} for a in [0.0, 2.5, 5.0, 7.5, 10.0]],
    *[{"name": f"rel_{r}", "settings": {"threshold_db": -30.0, "ratio": "4:1", "attack": 2.5, "release": r},
       "tests": _steps("rel", {}, holds=(0.1, 1.0, 4.0), steps=(25,), rel_obs=8.0)} for r in [0.0, 2.5, 5.0, 7.5, 10.0]],
    *[{"name": f"mode_{m}", "settings": {"threshold_db": -30.0, "ratio": "4:1", "attack": 5.0, "release": 5.0,
                                         "select_attack_release": m},
       "tests": _steps("m", {}, holds=(0.1, 1.0, 4.0), steps=(15, 25), rel_obs=8.0)} for m in ["Fix", "F/M"]],
    # Transitoires
    {"name": "transitoires", "settings": {"threshold_db": -30.0, "ratio": "6:1", "attack": 2.0, "release": 3.0}, "tests": [
        {"type": "bursts", "name": "salves_10ms", "base_db": -40, "burst_db": -10, "burst_ms": 10, "period_ms": 250},
        {"type": "bursts", "name": "salves_50ms", "base_db": -40, "burst_db": -10, "burst_ms": 50, "period_ms": 400},
        {"type": "real_signal", "name": "batterie", "path": BATTERIE, "seconds": 8, "rms_db": -18},
    ]},
    # Réglage de Romain (session LENNON, piste 1-2) et vrais signaux
    {"name": "romain_voix", "settings": {"threshold_db": -27.0, "ratio": "4:1", "attack": 3.0, "release": 3.0,
                                         "select_attack_release": "F/M", "output_volume_db": 6.0}, "tests": [
        {"type": "real_signal", "name": "voix", "path": VOIX, "seconds": 12, "rms_db": -20},
        {"type": "tone_levels", "name": "stat_1k", "freq": 1000, "levels": LEVELS[::2], "dur": 2.5},
    ]},
    {"name": "voix_man", "settings": {"threshold_db": -28.0, "ratio": "2:1", "attack": 2.0, "release": 4.0}, "tests": [
        {"type": "real_signal", "name": "voix", "path": VOIX, "seconds": 12, "rms_db": -20},
    ]},
    {"name": "parallele", "settings": {"threshold_db": -30.0, "ratio": "6:1", "parallel_compression": 50.0}, "tests": [
        {"type": "tone_levels", "name": "stat_1k", "freq": 1000, "levels": LEVELS[::2], "dur": 2.5},
        {"type": "freq_response", "name": "fr_-30", "level_db": -30},
    ]},
    {"name": "gain_sortie", "settings": {"threshold_db": "Off", "output_volume_db": 10.0}, "tests": [
        {"type": "tone_levels", "name": "thd_1k", "freq": 1000, "levels": [-40, -20, -10], "dur": 1.0},
    ]},
]

# ── Cartographie fine des boutons (sert au calage des tables du modèle) ──────
CARTO_LEVELS = [-60, -55, -52, -50, -48, -46, -44, -42, -40, -38, -36, -34, -32, -30, -28, -26, -24, -22, -20,
                -18, -16, -14, -12, -10, -8, -6, -4, -2, 0]
CARTO = [
    *[{"name": f"c_thr{t}", "settings": {"threshold_db": float(t), "ratio": "4:1"}, "tests": [
        {"type": "tone_levels", "name": "stat_1k", "freq": 1000, "levels": CARTO_LEVELS, "dur": 1.5}]}
      for t in [2, 0, -5, -10, -15, -20, -25, -30, -35, -40, -41]],
    *[{"name": f"c_ratio{r}", "settings": {"threshold_db": -25.0, "ratio": f"{r}:1"}, "tests": [
        {"type": "tone_levels", "name": "stat_1k", "freq": 1000, "levels": CARTO_LEVELS, "dur": 1.5}]}
      for r in [2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10]],
    *[{"name": f"c_att{a}", "settings": {"threshold_db": -30.0, "ratio": "4:1", "attack": float(a), "release": 5.0},
       "tests": [{"type": "step_response", "name": "s25", "base_db": -45, "step_db": 25, "hold": 1.0, "rel_obs": 1.5},
                 {"type": "step_response", "name": "s15", "base_db": -45, "step_db": 15, "hold": 1.0, "rel_obs": 1.5}]}
      for a in range(11)],
    *[{"name": f"c_rel{r}", "settings": {"threshold_db": -30.0, "ratio": "4:1", "attack": 2.5, "release": float(r)},
       "tests": [{"type": "step_response", "name": "s25", "base_db": -45, "step_db": 25, "hold": 0.5,
                  "rel_obs": 9.0 if r >= 8 else 4.0}]}
      for r in range(11)],
    *[{"name": f"c_fm_rel{r}", "settings": {"threshold_db": -30.0, "ratio": "4:1", "attack": 5.0, "release": float(r),
                                            "select_attack_release": "F/M"},
       "tests": [{"type": "step_response", "name": "s25", "base_db": -45, "step_db": 25, "hold": 0.5,
                  "rel_obs": 9.0 if r >= 8 else 4.0}]}
      for r in [0, 5, 10]],
]

CARTO += [
    *[{"name": f"c_out{o}", "settings": {"threshold_db": "Off", "output_volume_db": float(o)}, "tests": [
        {"type": "tone_levels", "name": "g_1k", "freq": 1000, "levels": [-40], "dur": 0.3}]}
      for o in [-30, -20, -10, -5, 0, 3, 6, 10, 15, 20, 25, 30]],
    *[{"name": f"c_sc{sc.split()[0]}_f{f}", "settings": {"threshold_db": -20.0, "ratio": "4:1", "sidechain_low_cut": sc},
       "tests": [{"type": "tone_levels", "name": "stat", "freq": f, "levels": [-30, -24, -18, -12], "dur": 2.0}]}
      for sc in ["Off", "80 Hz", "220 Hz"] for f in [40, 60, 100, 150, 250, 400, 1000]],
    *[{"name": f"c_att{a}", "settings": {"threshold_db": -30.0, "ratio": "4:1", "attack": float(a), "release": 5.0},
       "tests": [{"type": "step_response", "name": "s25", "base_db": -45, "step_db": 25, "hold": 1.0, "rel_obs": 1.5},
                 {"type": "step_response", "name": "s15", "base_db": -45, "step_db": 15, "hold": 1.0, "rel_obs": 1.5}]}
      for a in [2.5, 3.5, 4.5, 5.5, 6.5]],
    {"name": "c_vintage", "settings": {"threshold_db": "Off", "cl1b_generation": "Vintage mk I"}, "tests": [
        {"type": "freq_response", "name": "fr_-20", "level_db": -20}]},
]
