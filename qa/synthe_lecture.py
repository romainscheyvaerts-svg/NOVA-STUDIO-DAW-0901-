"""Lecture réelle (AudioContext) contre export (renderProject) pour les sons du synthé NOVA.

Reprend la mesure de la V24 (qa/synth_v24_preuve.py, partie 4) : même projet joué en
lecture et rendu à l'export, écart en dB. Sert à prouver que la saturation et
l'enveloppe de hauteur (ajoutées le 14/10/2026) ne font pas diverger lecture et export.
Repères V24 : sons sans glissé −68 à −118 dB ; glissé (automatisation) ≈ −38 dB.

  NOVA_URL=http://127.0.0.1:3449/ python qa/synthe_lecture.py id1 id2 …
"""
import json, os, sys
from pathlib import Path

os.environ.setdefault("NOVA_URL", "http://127.0.0.1:3449/")
os.environ.setdefault("QA_OUT", r"D:\1 WORK\CONTENU\nova-synthe\captures")
sys.path.insert(0, str(Path(__file__).parent))
_argv = sys.argv
sys.argv = [_argv[0]]  # synth_v24_preuve lit sys.argv à l'import
from synth_v24_preuve import LIB, LIVE_JS  # noqa: E402
sys.argv = _argv
from qalib import BASE, Log, launch, new_page  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ids = [a for a in sys.argv[1:] if not a.startswith("--")]
    log = Log("synthe_lecture")
    with sync_playwright() as p:
        b = launch(p)
        ctx, page = new_page(b, "pc", log)
        page.goto(BASE, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(2500)
        page.evaluate(LIB)
        page.wait_for_function("() => window.__v24", timeout=30000)
        res = page.evaluate(LIVE_JS, ids)
        ctx.close(); b.close()
    for k, v in res.items():
        print(f"{k:22s} écart {v['ecart_dB']:7.1f} dB  pire {v['pire_ecart_echantillon_dBFS']:7.1f} dBFS  non reçus {v['echantillons_non_recus']}  glissé {v['glisse']}")
    out = Path(os.environ["QA_OUT"]) / "lecture_vs_export.json"
    out.write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
