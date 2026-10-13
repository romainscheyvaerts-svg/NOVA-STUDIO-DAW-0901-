"""Tableau avant / après des paliers (campagne A/B de qa/surcharge_cpu.py --paliers).

Lit D:\\1 WORK\\CONTENU\\nova-128-pistes\\ab\\paliers_<base|new>_<profil>_<N>_r<k>.json et écrit
ab\\tableau.md : par palier et par profil, médiane des répétitions (charge moyenne / max du fil
audio, sous-régimes par minute, pistes en veille, pire image en édition).

  python qa/grosses_seances_tableau.py
"""
import json, re, statistics, sys
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
from pathlib import Path

AB = Path(r"D:\1 WORK\CONTENU\nova-128-pistes\ab")


def med(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 1) if xs else None


def load():
    rows = {}
    for f in AB.glob("paliers_*.json"):
        m = re.match(r"paliers_(base|new2|new|fin)_(realiste|dense)_(\d+)_([rsf]\w+)\.json", f.name)
        if not m:
            continue
        ver, prof, n, rep = m.group(1), m.group(2), int(m.group(3)), m.group(4)
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        for p in d.get("paliers", []):
            c = p.get("charge") or {}
            sr = p.get("sous_regimes") or {}
            dur = sr.get("duree_mesure_s") or 0
            im = p.get("images_edition") or {}
            worst = max([v.get("pire_image_ms") or 0 for v in im.values() if isinstance(v, dict)] or [None]) if im else None
            rows.setdefault((prof, n, ver), []).append({
                "moy": c.get("charge_cpu_moy_pct"), "max": c.get("charge_cpu_max_pct"),
                "ur_min": round(sr.get("evenements", 0) / dur * 60, 1) if dur else None, "ur": sr.get("evenements"), "dur": dur,
                "veille": (p.get("veille") or {}).get("pistes_en_veille_moy"), "image": worst,
                "img_detail": {k: v.get("pire_image_ms") for k, v in im.items() if isinstance(v, dict)}, "rep": rep})
    return rows


def main():
    rows = load()
    vers = [v for v in ("base", "new", "new2", "fin") if any(k[2] == v for k in rows)]
    names = {"base": "avant", "new": "étape 1", "new2": "étape 2", "fin": "final"}
    hdr = " → ".join(names[v] for v in vers)
    out = [f"| Profil | Pistes | Fil audio moyen ({hdr}) | Fil audio max | Sous-régimes / min | Pistes en veille (moy.) | Pire image en édition, ms | Mesures |",
           "|---|---|---|---|---|---|---|---|"]
    f = lambda xs, k: med([x[k] for x in xs])
    for prof in ("realiste", "dense"):
        for n in sorted({k[1] for k in rows if k[0] == prof}):
            rs = [rows.get((prof, n, v), []) for v in vers]
            j = lambda k, fmt="{}": " → ".join(fmt.format(f(r, k)) for r in rs)
            out.append(f"| {prof} | {n} | {j('moy', '{} %')} | {j('max', '{} %')} | {j('ur_min')} | {f(rs[-1], 'veille')} | {j('image')} | {' + '.join(str(len(r)) for r in rs)} |")
    (AB / "tableau.md").write_text("\n".join(out) + "\n", encoding="utf-8")
    (AB / "tableau.json").write_text(json.dumps({f"{k[0]}_{k[1]}_{k[2]}": v for k, v in rows.items()}, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\n".join(out))


if __name__ == "__main__":
    sys.exit(main())
