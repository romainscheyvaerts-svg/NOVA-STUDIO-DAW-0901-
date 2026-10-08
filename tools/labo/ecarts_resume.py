"""Résumé lisible d'un fichier ecarts_*.json (une ligne par test)."""
import json
import sys


def fmt(v):
    t = v.get("type")
    if "erreur" in v:
        return "ERREUR " + str(v["erreur"])[:120]
    if t in ("fr", "bruit"):
        return f"{t}: max {v['max_abs_db']:.2f} dB, rms {v['rms_db']:.2f}"
    if t == "statique":
        return f"statique: max {v['max_abs_db']:.2f} dB ; harmoniques max {v['harm_max_abs_db']:.1f} dB"
    if t == "temps":
        def p(x):
            return "-" if x is None else f"{x:+.0f}%"
        return (f"temps: GR rms {v['gr_rms_db']:.2f} dB ; att t63 {v['attaque_t63_vst_ms']}/{v['attaque_t63_nova_ms']} ({p(v['attaque_ecart_pct'])}) ;"
                f" rel t63 {v['relachement_t63_vst_ms']}/{v['relachement_t63_nova_ms']} ({p(v['relachement_ecart_pct'])})")
    if t == "salves":
        return f"salves: gain moyen {v['gain_moyen_ecart_db']:+.2f} dB, dépassement vst {v['depassement_vst']} nova {v['depassement_nova']}"
    if t == "null":
        return f"NULL {v['null_db']:.1f} dB (gain égalisé {v['null_db_gain_egalise']:.1f}, écart gain {v['ecart_gain_db']:+.2f} dB)"
    if t == "stereo":
        return f"stéréo vst lié={v['vst']['linked']} nova lié={v['nova']['linked']}"
    return str(v)[:150]


d = json.load(open(sys.argv[1], encoding="utf-8"))
for c, tests in d.items():
    for n, v in tests.items():
        s = fmt(v)
        if s:
            print(f"{c:28s} {n:16s} {s}")
