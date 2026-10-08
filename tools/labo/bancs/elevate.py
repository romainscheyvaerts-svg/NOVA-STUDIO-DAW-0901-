"""Banc : Newfangled Elevate (limiteur de mastering) -> effet NOVA « Mastering Transient ».

Modélisation en boîte noire : le plugin est chargé hors ligne, SANS fenêtre.
"""
import json

ID = "elevate"
PLUGIN = r"Newfangled Audio\Newfangled Elevate.vst3"
NOVA_KIND = "MASTERTRANSIENT"

BATTERIE = r"D:\1 WORK\CONTENU\nova-v20\materiaux\B_boucle_batterie.wav"
MIX = r"D:\1 WORK\CONTENU\nova-autotune\mix\mix_2_rends_ma_voix_plus_pro.wav"
ROMAIN_JSON = r"D:\1 WORK\CONTENU\nova-modeles\lennon\plugins\PRE_MASTER__PatchWork_Elevate.json"

# Centres des 26 bandes (Hz) tels qu'affichés par le plugin (échelle MEL)
CENTERS = [0.0, 101.55, 217.84, 351.0, 503.48, 678.07, 878.0, 1106.93, 1369.08, 1669.26, 2012.98, 2406.58,
           2857.27, 3373.35, 3964.3, 4640.99, 5415.84, 6303.12, 7319.11, 8482.5, 9814.68, 11340.12, 13086.87,
           15087.04, 17377.38, 20000.0]

# Réglages « neutres » : niveau de sortie manuel à 0 dB, pas de limiteur ni de clipper, pas d'égaliseur
NEUTRE = {
    "active": True, "bypass": False, "delta": False, "match_level": False, "gain_lock": False,
    "input_level_db": 0.0, "output_level_db": 0.0, "output_level_compensation": False,
    "output_level_control_select": "Manual", "dither": "Off",
    "gain_active": True, "gain_db": 0.0, "adaptive_gain_active": False, "adaptive_gain_db": 0.0,
    "ceiling_db": 0.0, "true_peak": False, "speed_ms": 1.0, "adaptive_speed_active": False, "adaptive_speed": 0.0,
    "clipper_drive_active": False, "clipper_drive_db": 0.0, "clipper_shape_active": False, "clipper_shape": 0.0,
    "clipper_detail_active": False,
    "transient_emphasis_active": False, "transient_emphasis": 0.0, "adaptive_transient_active": False,
    "adaptive_transient": 0.0, "transient_eq_active": True, "eq_active": True, "number_of_filters": "26 Band",
    **{f"band_gain_{k}_db": 0.0 for k in range(1, 27)},
    **{f"band_transient_{k}": 100.0 for k in range(1, 27)},
    **{f"band_solo_{k}": False for k in range(1, 27)},
}


def romain_band_transient():
    d = json.load(open(ROMAIN_JSON, encoding="utf-8"))
    per = d["transient"]["emphasis_per_band_pct"]
    vals = [float(v) for _, v in sorted(per.items(), key=lambda kv: float(kv[0]))]
    assert len(vals) == 26
    return vals


def romain_settings():
    """Réglages de Romain sur le PRE MASTER (lus dans la fenêtre du plugin le 08/10/2026)."""
    s = dict(NEUTRE)
    s.update({
        "output_level_control_select": "Automatic", "match_level": False,
        "gain_db": 8.0, "adaptive_gain_active": True, "adaptive_gain_db": 6.0,
        "speed_ms": 1.0, "adaptive_speed_active": True, "adaptive_speed": 100.0,
        "ceiling_db": -0.1, "true_peak": True,
        "transient_emphasis_active": True, "transient_emphasis": 27.0,
        "adaptive_transient_active": True, "adaptive_transient": 50.0,
        "clipper_drive_active": True, "clipper_drive_db": 0.0, "clipper_shape_active": True, "clipper_shape": 0.0,
    })
    for k, v in enumerate(romain_band_transient(), 1):
        s[f"band_transient_{k}"] = v
    return s


def transient_only(emphasis, adaptive=0.0, bands=None):
    s = dict(NEUTRE)
    s.update({"transient_emphasis_active": True, "transient_emphasis": float(emphasis),
              "adaptive_transient_active": adaptive > 0, "adaptive_transient": float(adaptive)})
    if bands is not None:
        for k, v in enumerate(bands, 1):
            s[f"band_transient_{k}"] = float(v)
    return s


def limiter_only(gain_db=8.0, speed_ms=1.0, ceiling=-0.1, tp=True, again=6.0, aspeed=100.0):
    s = dict(NEUTRE)
    s.update({"gain_db": gain_db, "speed_ms": speed_ms, "ceiling_db": ceiling, "true_peak": tp,
              "adaptive_gain_active": again > 0, "adaptive_gain_db": again,
              "adaptive_speed_active": aspeed > 0, "adaptive_speed": aspeed})
    return s
