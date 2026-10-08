"""Tour 2 : jeux de signaux réels rendus par les VST d'origine (calage + validation).
Chaque entrée : (nom, réglages VST, signal, rôle) ; rôle = 'fit' (sert au calage)
ou 'val' (validation : jamais vu pendant le calage)."""
V1 = (r"D:\1 WORK\CONTENU\nova-autotune\micro_sec_12s.wav", 0.0, 12)
V2 = (r"D:\1 WORK\CONTENU\nova-protools\automation\strip_source_1306_voix_24-34s.wav", 0.0, 10)
V3 = (r"D:\1 WORK\CONTENU\nova-finitions\regression-respirations\lead_avant.wav", 5.0, 12)
V4 = (r"D:\1 WORK\CONTENU\nova-finitions\regression-respirations\lead_avant.wav", 25.0, 12)
D = (r"D:\1 WORK\CONTENU\nova-v20\materiaux\B_boucle_batterie.wav", 0.0, 8)
SIG = {"V1": V1, "V2": V2, "V3": V3, "V4": V4, "D": D}


def _x(name, settings, sig, rms, role):
    return {"name": name, "settings": settings, "sig": sig, "rms_db": rms, "role": role}


def sets(bn):
    if bn == "cl1b":
        rv = {"threshold_db": -27.0, "ratio": "4:1", "attack": 3.0, "release": 3.0, "select_attack_release": "F/M", "output_volume_db": 6.0}
        vm = {"threshold_db": -28.0, "ratio": "2:1", "attack": 2.0, "release": 4.0}
        tr = {"threshold_db": -30.0, "ratio": "6:1", "attack": 2.0, "release": 3.0}
        out = [_x("romain_voix", rv, "V1", -20, "fit"), _x("voix_man", vm, "V1", -20, "fit"), _x("transitoires", tr, "D", -18, "fit"),
               _x("man_a5r5", {"threshold_db": -28.0, "ratio": "4:1", "attack": 5.0, "release": 5.0}, "V1", -20, "fit"),
               _x("man_a0r0", {"threshold_db": -28.0, "ratio": "4:1", "attack": 0.0, "release": 0.0}, "V1", -20, "fit"),
               _x("man_a8r8", {"threshold_db": -28.0, "ratio": "4:1", "attack": 8.0, "release": 8.0}, "V1", -20, "fit"),
               _x("fm_a6r6", {"threshold_db": -28.0, "ratio": "4:1", "attack": 6.0, "release": 6.0, "select_attack_release": "F/M"}, "V1", -20, "fit"),
               _x("fm_a1r1", {"threshold_db": -28.0, "ratio": "4:1", "attack": 1.0, "release": 1.0, "select_attack_release": "F/M"}, "V1", -20, "fit"),
               _x("fix", {"threshold_db": -28.0, "ratio": "4:1", "select_attack_release": "Fix"}, "V1", -20, "fit"),
               _x("fm_batterie", dict(tr, select_attack_release="F/M"), "D", -18, "fit"),
               _x("romain_voix", rv, "V4", -20, "fit"), _x("voix_man", vm, "V4", -20, "fit"),
               _x("fix", {"threshold_db": -28.0, "ratio": "4:1", "select_attack_release": "Fix"}, "V4", -20, "fit")]
        for s in ("V2", "V3"):
            out += [_x("romain_voix", rv, s, -20, "val"), _x("voix_man", vm, s, -20, "val"),
                    _x("fix", {"threshold_db": -28.0, "ratio": "4:1", "select_attack_release": "Fix"}, s, -20, "val")]
        return out
    if bn == "fet76":
        rb = {"ratio": "4:1", "input": -28.0, "output": -15.0, "attack": 5.0, "release": 6.0}
        r8 = {"ratio": "8:1", "input": -20.0, "attack": 3.0, "release": 5.0}
        tr = {"ratio": "4:1", "input": -18.0, "attack": 3.0, "release": 5.0}
        out = [_x("romain_bus", rb, "V1", -16, "fit"), _x("voix_r8", r8, "V1", -16, "fit"), _x("transitoires", tr, "D", -18, "fit"),
               _x("a1r1", {"ratio": "4:1", "input": -22.0, "attack": 1.0, "release": 1.0}, "V1", -16, "fit"),
               _x("a7r7", {"ratio": "4:1", "input": -22.0, "attack": 7.0, "release": 7.0}, "V1", -16, "fit"),
               _x("slo", {"ratio": "4:1", "input": -22.0, "attack": "SLO", "release": 4.0}, "V1", -16, "fit"),
               _x("r20", {"ratio": "20:1", "input": -24.0, "attack": 4.0, "release": 4.0}, "V1", -16, "fit"),
               _x("r2_a4r2", {"ratio": "2:1", "input": -18.0, "attack": 4.0, "release": 2.0}, "V1", -16, "fit"),
               _x("romain_bus", rb, "V4", -16, "fit"), _x("voix_r8", r8, "V4", -16, "fit")]
        for s in ("V2", "V3"):
            out += [_x("romain_bus", rb, s, -16, "val"), _x("voix_r8", r8, s, -16, "val")]
        return out
    if bn == "la2a":
        out = [_x("romain_bus", {"peak_reduct": "20", "gain": "25"}, "V1", -14, "fit"),
               _x("voix_pr55", {"peak_reduct": "55"}, "V1", -18, "fit"),
               _x("transitoires", {"peak_reduct": "60"}, "D", -18, "fit"),
               _x("pr40", {"peak_reduct": "40"}, "V1", -18, "fit"),
               _x("pr75", {"peak_reduct": "75"}, "V1", -18, "fit"),
               _x("lim60", {"peak_reduct": "60", "comp_limit": "Limit"}, "V1", -18, "fit"),
               _x("pr45_batterie", {"peak_reduct": "45"}, "D", -18, "fit"),
               _x("romain_bus", {"peak_reduct": "20", "gain": "25"}, "V4", -14, "fit"), _x("voix_pr55", {"peak_reduct": "55"}, "V4", -18, "fit"),
               _x("lim60", {"peak_reduct": "60", "comp_limit": "Limit"}, "V4", -18, "fit")]
        for s in ("V2", "V3"):
            out += [_x("romain_bus", {"peak_reduct": "20", "gain": "25"}, s, -14, "val"), _x("voix_pr55", {"peak_reduct": "55"}, s, -18, "val")]
        return out
    if bn == "voxbox":
        rv = {"comp_byp": "In", "comp_thresh": 6.0, "comp_attack": "Medium", "comp_rel": "Medium"}
        out = [_x("romain_voix", rv, "V1", -20, "fit")]
        for a, r in (("Fast", "Fast"), ("Slow", "Slow"), ("Fast", "Slow"), ("Slow", "Fast"), ("Med Fast", "Med Slow")):
            out.append(_x(f"a{a}_r{r}".replace(" ", ""), {"comp_byp": "In", "comp_thresh": 6.0, "comp_attack": a, "comp_rel": r}, "V1", -20, "fit"))
        out.append(_x("batterie", rv, "D", -18, "fit"))
        out.append(_x("romain_voix", rv, "V4", -20, "fit"))
        for s in ("V2", "V3"):
            out.append(_x("romain_voix", rv, s, -20, "val"))
        return out
    raise ValueError(bn)
