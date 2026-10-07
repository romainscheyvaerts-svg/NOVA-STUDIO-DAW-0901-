# -*- coding: utf-8 -*-
"""Signalements NOVA -> liste de travail pour le prochain tour d'amélioration.

Lit la table nova_feedback (Supabase des comptes Make Music, migration
supabase/nova_feedback.sql) avec la clé SERVICE chargée par le module de
l'agent (%LOCALAPPDATA%\\AgentLocal\\supa_key.py ; la clé n'est jamais affichée),
regroupe les doublons proches, classe par priorité, télécharge les captures et
écrit D:\\1 WORK\\CONTENU\\nova-retours\\a_traiter.md (+ a_traiter.json).

Usage :
  python scripts/feedback_pull.py                         # signalements ouverts (reçus, en cours)
  python scripts/feedback_pull.py --tous                  # y compris corrigés / classés
  python scripts/feedback_pull.py --ia                    # regroupement affiné par Ollama LOCAL
  python scripts/feedback_pull.py --fichier test.json     # données factices, aucun réseau
  python scripts/feedback_pull.py --marquer-corrige K7P2QX4A,M3N4-P5Q6 --version 2026.10.08
  python scripts/feedback_pull.py --marquer-en-cours K7P2QX4A
  python scripts/feedback_pull.py --classer K7P2QX4A --note "doublon de …"

Les signalements peuvent contenir des données personnelles : l'option --ia
passe UNIQUEMENT par Ollama sur ce PC (ia.py -m ollama:…, sans repli vers une
IA en ligne). Si Ollama est éteint, le regroupement simple suffit.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import math
import os
import re
import shutil
import subprocess
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

PROJECT_URL = "https://mxdrxpzxbgybchzzvpkf.supabase.co"
TABLE = "nova_feedback"
BUCKET = "nova-feedback"
OUT_DEFAULT = Path(r"D:\1 WORK\CONTENU\nova-retours")
IA_PY = Path(r"D:\1 WORK\CODE\_ia\ia.py")
OLLAMA_MODEL = "ollama:qwen2.5:14b"   # local uniquement : jamais de repli vers le cloud
OPEN_STATUSES = ("recu", "en_cours")
CAT_LABEL = {"bug": "Bug", "amelioration": "Amélioration", "idee": "Idée"}
CAT_WEIGHT = {"bug": 3.0, "amelioration": 2.0, "idee": 1.0}
REF_RE = re.compile(r"^[2-9A-HJKMNP-Z]{8}$")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


# --- Clé service (jamais affichée) -------------------------------------------------------

def load_service_key() -> str:
    agent = Path(os.environ.get("LOCALAPPDATA", "")) / "AgentLocal"
    sys.path.insert(0, str(agent))
    try:
        import supa_key  # type: ignore
    except Exception as e:  # noqa: BLE001
        sys.exit(f"[retours] module supa_key introuvable dans {agent} ({type(e).__name__}).")
    key = supa_key.key() or ""
    role = key_role(key)
    if role != "service_role":
        sys.exit(f"[retours] la clé chargée par supa_key n'est pas la clé service (rôle : {role or 'inconnu'}). "
                 "La RLS cacherait tous les signalements : ajoute la clé service dans settings.json (makemusic_keys.studio).")
    return key


def key_role(key: str) -> str:
    """Rôle d'une clé Supabase, sans jamais l'afficher."""
    if key.startswith("sb_secret_"):
        return "service_role"
    if key.startswith("sb_publishable_"):
        return "anon"
    parts = key.split(".")
    if len(parts) != 3:
        return ""
    try:
        payload = parts[1] + "=" * (-len(parts[1]) % 4)
        return json.loads(base64.urlsafe_b64decode(payload)).get("role", "")
    except Exception:  # noqa: BLE001
        return ""


def _request(method: str, url: str, key: str, body=None, headers=None, raw=False):
    h = {"apikey": key, "Authorization": f"Bearer {key}"}
    if body is not None:
        h["Content-Type"] = "application/json"
    h.update(headers or {})
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            content = r.read()
            return content if raw else (json.loads(content) if content else None)
    except urllib.error.HTTPError as e:
        detail = e.read()[:300].decode("utf-8", "replace")
        raise RuntimeError(f"HTTP {e.code} sur {url.split('?')[0]} : {detail}") from None


def fetch_rows(key: str, include_closed: bool) -> list[dict]:
    rows, offset = [], 0
    status = "" if include_closed else "&status=in.(" + ",".join(OPEN_STATUSES) + ")"
    while True:
        url = f"{PROJECT_URL}/rest/v1/{TABLE}?select=*&order=created_at.asc{status}&limit=1000&offset={offset}"
        page = _request("GET", url, key) or []
        rows += page
        if len(page) < 1000:
            return rows
        offset += 1000


# --- Regroupement -----------------------------------------------------------------------

STOP = set("""
le la les l de des du d un une et ou a au aux en dans sur sous pour par avec sans ne n pas plus que qui quoi quand
je j il elle on ca ce c cet cette ces est sont se s sa son ses mon ma mes tu te t ton ta tes nous vous ils elles
y me m moi lui leur leurs tres trop bien fait faire peut etre avoir ai as avait meme aussi encore tout tous toute
toutes rien quelque chose fois parfois toujours quand alors mais donc car comme si lorsque apres avant pendant
nova studio app appli marche fonctionne probleme bug souci the to of and is it in on for not
""".split())


def norm(s: str) -> str:
    s = unicodedata.normalize("NFD", (s or "").lower())
    return "".join(ch for ch in s if unicodedata.category(ch) != "Mn")


def tokens(s: str) -> set[str]:
    out = set()
    for w in re.split(r"[^a-z0-9]+", norm(s)):
        if len(w) < 3 or w in STOP or w.isdigit():
            continue
        if len(w) > 4 and w.endswith(("s", "x")):
            w = w[:-1]
        out.add(w)
    return out


def jaccard(a: set, b: set) -> float:
    return len(a & b) / len(a | b) if a and b else 0.0


def error_signature(row: dict) -> str:
    errs = ((row.get("context") or {}).get("erreurs") or [])
    errs = [e for e in errs if isinstance(e, dict) and e.get("level") == "error"]
    if not errs:
        return ""
    msg = norm(str(errs[-1].get("message", "")))
    msg = re.sub(r"\d+", "#", msg)
    msg = re.sub(r"\[[^\]]*\]", "", msg)
    return msg[:80].strip()


def compatible(c1: str, c2: str) -> bool:
    return c1 == c2 or {c1, c2} == {"amelioration", "idee"}


def group_rows(rows: list[dict]) -> list[list[dict]]:
    """Doublons proches : titres voisins, textes voisins, ou même erreur console (bugs)."""
    n = len(rows)
    parent = list(range(n))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i, j):
        parent[find(i)] = find(j)

    tt = [tokens(r.get("title", "")) for r in rows]
    td = [tokens(r.get("title", "") + " " + r.get("description", "")) for r in rows]
    sig = [error_signature(r) for r in rows]
    for i in range(n):
        for j in range(i + 1, n):
            if not compatible(rows[i].get("category"), rows[j].get("category")):
                continue
            same_error = rows[i].get("category") == "bug" and sig[i] and sig[i] == sig[j]
            if jaccard(tt[i], tt[j]) >= 0.5 or jaccard(td[i], td[j]) >= 0.4 or same_error:
                union(i, j)
    groups: dict[int, list[dict]] = {}
    for i, r in enumerate(rows):
        groups.setdefault(find(i), []).append(r)
    return list(groups.values())


def refine_with_local_ai(groups: list[list[dict]]) -> list[list[dict]]:
    """Demande à Ollama (LOCAL) quels groupes parlent du même sujet. Rien ne quitte le PC."""
    if len(groups) < 2 or not IA_PY.exists():
        return groups
    lines = []
    for i, g in enumerate(groups):
        titles = " | ".join(sorted({r.get("title", "")[:90] for r in g})[:4])
        lines.append(f"{i}: [{g[0].get('category')}] {titles}")
    prompt = ("Voici des groupes de signalements d'utilisateurs d'un logiciel de musique (numéro: [catégorie] titres).\n"
              "Dis quels groupes décrivent EXACTEMENT le même problème ou la même demande. Réponds UNIQUEMENT en JSON : "
              "une liste de listes de numéros à fusionner, par exemple [[0,3],[2,5]] ; [] si aucun.\n\n" + "\n".join(lines))
    try:
        res = subprocess.run([sys.executable, str(IA_PY), "-m", OLLAMA_MODEL, "-t", "0", prompt],
                             stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300,
                             env={**os.environ, "PYTHONIOENCODING": "utf-8"},
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except Exception as e:  # noqa: BLE001
        print(f"[retours] IA locale indisponible ({type(e).__name__}) : regroupement simple.")
        return groups
    if res.returncode != 0:
        print("[retours] Ollama ne répond pas (éteint ? mode MAO ?) : regroupement simple gardé. "
              + (res.stderr or "").strip().splitlines()[-1][:160] if (res.stderr or "").strip() else
              "[retours] Ollama ne répond pas (éteint ? mode MAO ?) : regroupement simple gardé.")
        return groups
    m = re.search(r"\[\s*(?:\[[\d,\s]*\]\s*,?\s*)*\]", res.stdout)
    try:
        merges = json.loads(m.group(0)) if m else []
    except Exception:  # noqa: BLE001
        merges = []
    parent = list(range(len(groups)))

    def find(i):
        while parent[i] != i:
            i = parent[i]
        return i
    for mg in merges:
        ids = [k for k in mg if isinstance(k, int) and 0 <= k < len(groups)]
        # On ne fusionne jamais un bug avec une idée, même si l'IA le propose.
        for k in ids[1:]:
            if compatible(groups[ids[0]][0].get("category"), groups[k][0].get("category")):
                parent[find(k)] = find(ids[0])
    out: dict[int, list[dict]] = {}
    for i, g in enumerate(groups):
        out.setdefault(find(i), []).extend(g)
    merged = len(groups) - len(out)
    print(f"[retours] IA locale ({OLLAMA_MODEL}) : {merged} fusion(s) de groupes.")
    return list(out.values())


# --- Priorité et rendu ----------------------------------------------------------------------

def parse_ts(s: str) -> dt.datetime:
    try:
        return dt.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:  # noqa: BLE001
        return dt.datetime.now(dt.timezone.utc)


def score_group(g: list[dict], now: dt.datetime) -> tuple[float, str]:
    cat = Counter(r.get("category") for r in g).most_common(1)[0][0]
    count = len(g)
    people = len({r.get("user_id") or r.get("device_id") for r in g})
    s = CAT_WEIGHT.get(cat, 1.0) * (1 + math.log2(people or 1))
    freqs = Counter(r.get("frequency") for r in g)
    s += 2 * bool(freqs.get("toujours")) + 1 * bool(freqs.get("parfois"))
    if any(error_signature(r) for r in g):
        s += 1
    last = max(parse_ts(r.get("created_at")) for r in g)
    if (now - last).days <= 7:
        s += 1
    if count >= 5:
        s += 1
    prio = "P1" if s >= 7 or (cat == "bug" and people >= 3) else "P2" if s >= 4 else "P3"
    return round(s, 1), prio


def fmt_ref(ref: str) -> str:
    return f"{ref[:4]}-{ref[4:]}" if ref and len(ref) == 8 else (ref or "?")


def counter_line(c: Counter, n: int = 5) -> str:
    return ", ".join(f"{k} ×{v}" if v > 1 else str(k) for k, v in c.most_common(n) if k not in (None, ""))


def tech_summary(g: list[dict]) -> list[str]:
    ctx = [r.get("context") or {} for r in g]
    nova = Counter((c.get("nova") or {}).get("version") for c in ctx)
    desk = Counter((c.get("desktop") or {}).get("version") for c in ctx if c.get("desktop"))
    nav = Counter(c.get("navigateur") for c in ctx)
    mode = Counter({"simple": "simple", "avance": "avancé"}.get((c.get("studio") or {}).get("mode")) for c in ctx)
    vue = Counter((c.get("studio") or {}).get("view") for c in ctx)
    role = Counter((c.get("studio") or {}).get("collabRole") for c in ctx)
    pistes = [(c.get("studio") or {}).get("trackCount") for c in ctx if isinstance((c.get("studio") or {}).get("trackCount"), int)]
    ecran = Counter(f"{(c.get('ecran') or {}).get('fenetre', '?')}" for c in ctx)
    out = [f"NOVA {counter_line(nova)}" + (f" · appli Windows {counter_line(desk)}" if desk else " · navigateur web")]
    out.append(f"Navigateurs : {counter_line(nav)}")
    bits = [f"mode {counter_line(mode)}" if mode else "", f"vue {counter_line(vue)}" if vue else "",
            (f"{min(pistes)}–{max(pistes)} pistes" if min(pistes) != max(pistes) else f"{pistes[0]} piste{'s' if pistes[0] > 1 else ''}") if pistes else "", f"collab : {counter_line(role)}" if any(role) else ""]
    out.append("Studio : " + " · ".join(b for b in bits if b))
    out.append(f"Fenêtres : {counter_line(ecran, 3)}")
    errs = Counter()
    for c in ctx:
        for e in (c.get("erreurs") or [])[-10:]:
            if isinstance(e, dict) and e.get("message"):
                errs[f"{e.get('level', '?')}: {str(e['message'])[:140]}"] += 1
    if errs:
        out.append("Erreurs console les plus fréquentes :")
        out += [f"  - `{m}`" + (f" (×{n})" if n > 1 else "") for m, n in errs.most_common(5)]
    richest = max(ctx, key=lambda c: len(c.get("actions") or []))
    acts = [a.get("action") for a in (richest.get("actions") or []) if isinstance(a, dict)]
    if acts:
        out.append("Dernières actions (le signalement le plus complet) : " + " → ".join(acts[-12:]))
    return out


def download_captures(groups, out_dir: Path, key: str | None, source_dir: Path | None) -> dict[str, str]:
    cap_dir = out_dir / "captures"
    got: dict[str, str] = {}
    for g in groups:
        for r in g:
            path = r.get("screenshot_path")
            if not path:
                continue
            ext = path.rsplit(".", 1)[-1] if "." in path else "jpg"
            dest = cap_dir / f"{r.get('ref')}.{ext}"
            try:
                if source_dir is not None:
                    src = source_dir / path
                    if not src.exists():
                        continue
                    cap_dir.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(src, dest)
                else:
                    data = _request("GET", f"{PROJECT_URL}/storage/v1/object/{BUCKET}/{urllib.parse.quote(path)}", key, raw=True)
                    cap_dir.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes(data)
                got[r.get("ref")] = f"captures/{dest.name}"
            except Exception as e:  # noqa: BLE001
                print(f"[retours] capture {fmt_ref(r.get('ref'))} non téléchargée : {e}")
    return got


def render(groups, source_label: str, captures: dict[str, str], now: dt.datetime) -> tuple[str, list[dict]]:
    scored = []
    for g in groups:
        s, prio = score_group(g, now)
        g.sort(key=lambda r: parse_ts(r.get("created_at")))
        scored.append((prio, -s, g, s))
    scored.sort(key=lambda x: (x[0], x[1], -len(x[2])))
    total = sum(len(g) for g in groups)
    prios = Counter(p for p, *_ in scored)
    md = [
        "# Retours NOVA à traiter",
        "",
        f"Généré le {now.astimezone().strftime('%d/%m/%Y à %H:%M')} · source : {source_label}",
        f"**{total} signalement(s) en {len(groups)} sujet(s)** — P1 : {prios.get('P1', 0)} · P2 : {prios.get('P2', 0)} · P3 : {prios.get('P3', 0)}",
        "",
        "Priorité : bug > amélioration > idée, × nombre de personnes, + « à chaque fois », + erreurs console, + récent.",
        "Après correction : `python scripts/feedback_pull.py --marquer-corrige <refs> --version <version>` "
        "(statut visible par l'utilisateur dans « Mes signalements »).",
        "",
    ]
    data = []
    for n, (prio, _, g, s) in enumerate(scored, 1):
        cat = Counter(r.get("category") for r in g).most_common(1)[0][0]
        people = len({r.get("user_id") or r.get("device_id") for r in g})
        main = max(g, key=lambda r: len(r.get("description") or ""))
        refs = [r.get("ref") for r in g]
        freqs = Counter({"toujours": "à chaque fois", "parfois": "parfois"}.get(r.get("frequency"), None) for r in g)
        titles = sorted({r.get("title", "").strip() for r in g})
        md.append(f"## {n}. {prio} · {CAT_LABEL.get(cat, cat)} · « {main.get('title', '').strip()} »")
        md.append("")
        md.append(f"- **{len(g)} signalement(s)**, {people} personne(s)/appareil(s) · score {s}")
        md.append(f"- Réfs : {', '.join(fmt_ref(x) for x in refs)}")
        statuses = Counter(r.get("status") for r in g)
        md.append(f"- Statut : {counter_line(statuses)}")
        if any(freqs):
            md.append(f"- Fréquence : {counter_line(freqs)}")
        md.append(f"- Période : {parse_ts(g[0].get('created_at')).strftime('%d/%m/%Y')} → {parse_ts(g[-1].get('created_at')).strftime('%d/%m/%Y')}")
        if len(titles) > 1:
            md.append("- Titres : " + " | ".join(f"« {t[:90]} »" for t in titles[:6]))
        desc = (main.get("description") or "").strip()
        if desc:
            md.append("- Description (la plus détaillée) :")
            md += ["  > " + line for line in desc[:1200].splitlines() if line.strip()]
        md.append("- Contexte technique :")
        md += ["  - " + line if not line.startswith("  - ") else "    " + line[2:] for line in tech_summary(g)]
        caps = [captures[x] for x in refs if x in captures]
        for c in caps:
            md.append(f"- Capture : ![{c}]({c})")
        emails = sorted({r.get("email") for r in g if r.get("email")})
        if emails:
            md.append(f"- À recontacter : {', '.join(emails)}")
        md.append(f"- Clore : `python scripts/feedback_pull.py --marquer-corrige {','.join(refs)} --version X`")
        md.append("")
        data.append({"rang": n, "priorite": prio, "score": s, "categorie": cat, "titre": main.get("title"),
                     "refs": refs, "ids": [r.get("id") for r in g], "personnes": people, "captures": caps})
    if not groups:
        md.append("Rien à traiter pour l'instant. 🎉")
    return "\n".join(md) + "\n", data


# --- Statuts ------------------------------------------------------------------------------

def parse_targets(raw: str) -> tuple[list[str], list[str]]:
    refs, ids = [], []
    for x in re.split(r"[,\s]+", raw or ""):
        x = x.strip()
        if not x:
            continue
        if UUID_RE.match(x):
            ids.append(x.lower())
            continue
        r = x.replace("-", "").upper()
        if not REF_RE.match(r):
            sys.exit(f"[retours] « {x} » n'est ni un numéro de suivi (8 caractères) ni un id.")
        refs.append(r)
    return refs, ids


def set_status(args, status: str, version: str | None, note: str | None) -> int:
    refs, ids = parse_targets(args.cible)
    patch = {"status": status}
    if status == "corrige":
        patch["fixed_in_version"] = version
    if note:
        patch["admin_note"] = note[:5000]
    if args.fichier:
        path = Path(args.fichier)
        rows = json.loads(path.read_text(encoding="utf-8"))
        n = 0
        for r in rows:
            if r.get("ref") in refs or str(r.get("id", "")).lower() in ids:
                r.update(patch)
                r["updated_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
                n += 1
        path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    else:
        key = load_service_key()
        n = 0
        for col, vals in (("ref", refs), ("id", ids)):
            if not vals:
                continue
            url = f"{PROJECT_URL}/rest/v1/{TABLE}?{col}=in.({','.join(vals)})"
            res = _request("PATCH", url, key, body=patch, headers={"Prefer": "return=representation"}) or []
            n += len(res)
    wanted = len(refs) + len(ids)
    label = {"corrige": f"corrigé(s) dans la version {version}", "en_cours": "en cours", "ferme": "classé(s)"}[status]
    print(f"[retours] {n}/{wanted} signalement(s) passé(s) {label}.")
    return 0 if n == wanted else 2


# --- Principal ----------------------------------------------------------------------------

def main(argv=None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="Signalements NOVA -> liste de travail a_traiter.md")
    ap.add_argument("--fichier", help="lire des signalements depuis un JSON (tests, données factices) au lieu de la base")
    ap.add_argument("--sortie", help=f"dossier de sortie (défaut : {OUT_DEFAULT} ; avec --fichier : <défaut>\\test-factice)")
    ap.add_argument("--tous", action="store_true", help="inclure les signalements corrigés / classés")
    ap.add_argument("--ia", action="store_true", help="affiner les regroupements avec Ollama LOCAL (données personnelles : jamais en ligne)")
    ap.add_argument("--sans-captures", action="store_true", help="ne pas télécharger les captures")
    ap.add_argument("--marquer-corrige", dest="corrige", metavar="REFS", help="numéros de suivi ou ids, séparés par des virgules")
    ap.add_argument("--marquer-en-cours", dest="en_cours", metavar="REFS")
    ap.add_argument("--classer", dest="classer", metavar="REFS", help="classer sans suite (doublon, hors sujet…)")
    ap.add_argument("--version", help="version qui contient la correction (avec --marquer-corrige)")
    ap.add_argument("--note", help="note interne (jamais montrée à l'utilisateur)")
    args = ap.parse_args(argv)

    for flag, status in (("corrige", "corrige"), ("en_cours", "en_cours"), ("classer", "ferme")):
        if getattr(args, flag):
            if status == "corrige" and not (args.version or "").strip():
                ap.error("--marquer-corrige demande --version (ex. --version 2026.10.08)")
            args.cible = getattr(args, flag)
            return set_status(args, status, (args.version or "").strip()[:40] or None, args.note)

    now = dt.datetime.now(dt.timezone.utc)
    if args.fichier:
        src = Path(args.fichier)
        rows = json.loads(src.read_text(encoding="utf-8"))
        if not args.tous:
            rows = [r for r in rows if r.get("status", "recu") in OPEN_STATUSES]
        key, source_dir, label = None, src.parent, f"fichier {src.name} (données factices)"
        out_dir = Path(args.sortie) if args.sortie else OUT_DEFAULT / "test-factice"
    else:
        key = load_service_key()
        rows = fetch_rows(key, args.tous)
        source_dir, label = None, f"base Supabase {PROJECT_URL.split('//')[1].split('.')[0]}"
        out_dir = Path(args.sortie) if args.sortie else OUT_DEFAULT

    groups = group_rows(rows)
    if args.ia:
        groups = refine_with_local_ai(groups)
    out_dir.mkdir(parents=True, exist_ok=True)
    captures = {} if args.sans_captures else download_captures(groups, out_dir, key, source_dir)
    md, data = render(groups, label, captures, now)
    (out_dir / "a_traiter.md").write_text(md, encoding="utf-8")
    (out_dir / "a_traiter.json").write_text(json.dumps({"genere": now.isoformat(), "source": label, "sujets": data},
                                                       ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[retours] {len(rows)} signalement(s), {len(groups)} sujet(s), {len(captures)} capture(s) -> {out_dir / 'a_traiter.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
