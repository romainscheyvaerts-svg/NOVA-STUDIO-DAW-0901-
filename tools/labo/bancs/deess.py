"""Banc : de-essers (DeEdger, de-esser NOVA avant / après) sur de vraies sibilances.

Voix de D:\\1 WORK\\CONTENU, ramenées à -20 dBFS RMS, 48 kHz, 12 s max.
"""
import os

ID = "deesser"
C = r"D:\1 WORK\CONTENU"
VOIX = {
    "voix_micro": (os.path.join(C, r"nova-audit-ux\2026-10-08\voix_micro.wav"), 0.0),
    "lead_avant": (os.path.join(C, r"nova-finitions\regression-respirations\lead_avant.wav"), 0.0),
    "stem_voix": (os.path.join(C, r"nova-v18-stems\sorties-pont\Test stems\Silence blanc (extrait) 2026-10-07 22-59-43\Voix.wav"), 0.0),
    "voix_extrait": (os.path.join(C, r"nova-v20\materiaux\A_voix_extrait.wav"), 0.0),
    "vraie_voix": (os.path.join(C, r"nova-v19\D_vraie_voix_avant.wav"), 0.0),
    "voix_douce": (os.path.join(C, r"nova-ara\melodyne\voix_originale.wav"), 0.0),
    # contrôles sans sibilances marquées : le de-esser ne doit presque rien y faire
    "micro_sec": (os.path.join(C, r"nova-autotune\micro_sec_12s.wav"), 0.0),
    "strip_1306": (os.path.join(C, r"nova-protools\automation\strip_source_1306_voix_24-34s.wav"), 0.0),
}
RMS_DB = -20.0
SECONDS = 12.0

DEEDGER = "DeEdger.vst3"
DEEDGER_BASE = {"active": True, "bypass_master": False, "freq_hz": 8000.0, "q": 1.0, "depth": 10.0,
                "compensate": False, "focus_listen": False, "ch_mode": "L+R", "delta": False, "quality": "Normal"}


def load_voices():
    import numpy as np
    import bench
    out = {}
    for k, (p, off) in VOIX.items():
        if not os.path.exists(p):
            continue
        x = bench.load_audio(p, SECONDS, off, RMS_DB)
        if x.shape[1] < 48000:
            continue
        out[k] = np.ascontiguousarray(x)
    return out
