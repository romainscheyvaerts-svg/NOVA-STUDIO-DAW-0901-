"""Tableau avant / après des paliers (campagne A/B de qa/surcharge_cpu.py --paliers).

Lit D:\\1 WORK\\CONTENU\\nova-128-pistes\\ab\\paliers_<base|new>_<profil>_<N>_r<k>.json et écrit
ab\\tableau.md : par palier et par profil, médiane des répétitions (charge moyenne / max du fil
audio, sous-régimes par minute, pistes en veille, pire image en édition).

  python qa/grosses_seances_tableau.py
"""
import json, re, statistics, sys
from pathlib import Path

AB = Path(r"D:\1 WORK\CONTENU\nova-128-pistes\ab")


def med(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 1) if xs else None


def load():
    rows = {}
    for f in AB.glob("paliers_*.json"):
        m = re.match(r"paliers_(base|new)_(realiste|dense)_(\d+)_r(\w+)\.json", f.name)
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
    out = ["| Profil | Pistes | Fil audio moyen (avant → après) | Fil audio max | Sous-régimes / min (avant → après) | Pistes en veille (moy.) | Pire image en édition, ms (avant → après) | Mesures |",
           "|---|---|---|---|---|---|---|---|"]
    for prof in ("realiste", "dense"):
        for n in sorted({k[1] for k in rows if k[0] == prof}):
            a, b = rows.get((prof, n, "base"), []), rows.get((prof, n, "new"), [])
            f = lambda xs, k: med([x[k] for x in xs])
            out.append(f"| {prof} | {n} | {f(a, 'moy')} % → **{f(b, 'moy')} %** | {f(a, 'max')} % → {f(b, 'max')} % | {f(a, 'ur_min')} → **{f(b, 'ur_min')}** "
                       f"| {f(b, 'veille')} | {f(a, 'image')} → {f(b, 'image')} | {len(a)} + {len(b)} |")
    (AB / "tableau.md").write_text("\n".join(out) + "\n", encoding="utf-8")
    (AB / "tableau.json").write_text(json.dumps({f"{k[0]}_{k[1]}_{k[2]}": v for k, v in rows.items()}, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\n".join(out))


if __name__ == "__main__":
    sys.exit(main())
