"""Vérifie que CHAQUE script QA qui pilote un navigateur passe par qa_hors_prod.

Un script est couvert s'il importe qa_hors_prod, ou un module local qui l'importe
(qalib, scenarios, collab_sim…), de proche en proche. Sinon ses chromium.launch /
new_context échapperaient au catalogue simulé et pourraient joindre la production.

  python qa/verif_hors_prod.py     → liste les scripts non couverts (code 1 s'il y en a)
"""
import ast
import sys
import warnings
from pathlib import Path

QA = Path(__file__).resolve().parent


def local_imports(path: Path) -> set:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            tree = ast.parse(path.read_text(encoding="utf-8"))
    except Exception:
        return set()
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            out |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
            out.add(node.module.split(".")[0])
        elif isinstance(node, ast.Call) and getattr(node.func, "id", "") == "__import__" and node.args \
                and isinstance(node.args[0], ast.Constant):
            out.add(str(node.args[0].value).split(".")[0])
    return out


def main() -> int:
    mods = {p.stem: p for p in QA.glob("*.py")}
    graph = {name: local_imports(p) & set(mods) | ({"qa_hors_prod"} & local_imports(p)) for name, p in mods.items()}
    covered = {"qa_hors_prod"}
    changed = True
    while changed:
        changed = False
        for name, deps in graph.items():
            if name not in covered and deps & covered:
                covered.add(name); changed = True
    missing = []
    for name, p in sorted(mods.items()):
        txt = p.read_text(encoding="utf-8", errors="replace")
        if "playwright" in txt and name not in covered and name != "verif_hors_prod":
            missing.append(p.name)
    if missing:
        print("Scripts QA qui lancent un navigateur SANS le catalogue simulé :")
        for m in missing:
            print("  -", m)
        return 1
    print(f"OK : {sum(1 for n, p in mods.items() if 'playwright' in p.read_text(encoding='utf-8', errors='replace'))} scripts "
          "pilotant un navigateur passent tous par qa_hors_prod.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
