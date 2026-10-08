"""
Automation des VST3 par le pont (R9) — logique pure, testable sans pedalboard.

Temps réel (trame type 1, drapeau FLAG_PARAMS) : chaque bloc audio porte les
changements de réglages qui le concernent, horodatés à l'échantillon près
(décalage dans le bloc). Le pont découpe le bloc aux décalages : la partie
avant le changement est traitée avec l'ancienne valeur, la suite avec la
nouvelle. pedalboard (JUCE) transmet la valeur au plugin au début de l'appel
process() suivant (IParameterChanges, décalage 0) : découper le bloc donne
donc un changement exact à l'échantillon.

    section paramètres (après l'audio, alignée sur 4 octets) :
      u16 count | u16 0 | count × (u16 index, u16 offset, f32 valeur brute 0–1)
    index : place du réglage dans la table d'automation du slot
            (SET_AUTOMATION_MAP slot_id names:[…]).

Hors ligne (RENDER, gel / export) : la requête porte
    automation: [{name, frames:[…], values:[…]}]
(images = échantillons depuis le début du son envoyé). Le rendu est découpé
aux mêmes instants, avec la même règle : une valeur appliquée à l'image f
vaut pour l'échantillon f et les suivants.

Écriture (Touch / Latch) : ParamWatch compare périodiquement les valeurs
brutes du plugin à celles que le pont connaît (posées par Nova ou par
l'automation) : une différence vient de la fenêtre du plugin.
"""

import struct
import time
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np

FLAG_PARAMS = 0x01
FLAG_SIDECHAIN = 0x02

PARAM_REC = struct.Struct("<HHf")
PARAM_HEAD = struct.Struct("<HH")

# Au plus ce nombre de changements par bloc (un bloc = 128 échantillons) :
# au-delà, la trame est refusée (garde-fou, le DAW en envoie 4 au plus par réglage).
MAX_CHANGES_PER_BLOCK = 512

Change = Tuple[int, int, float]          # (index, décalage, valeur)


def parse_param_section(buf: bytes, off: int) -> List[Change]:
    """Section paramètres d'une trame type 1 (à partir de l'octet off)."""
    if off + PARAM_HEAD.size > len(buf):
        return []
    count, _ = PARAM_HEAD.unpack_from(buf, off)
    count = min(int(count), MAX_CHANGES_PER_BLOCK, (len(buf) - off - PARAM_HEAD.size) // PARAM_REC.size)
    out: List[Change] = []
    p = off + PARAM_HEAD.size
    for _ in range(count):
        idx, offset, value = PARAM_REC.unpack_from(buf, p)
        p += PARAM_REC.size
        if np.isfinite(value):
            out.append((int(idx), int(offset), float(min(1.0, max(0.0, value)))))
    out.sort(key=lambda c: c[1])
    return out


def build_param_section(changes: Sequence[Change]) -> bytes:
    """(Tests, outils) Section paramètres prête à coller après l'audio."""
    b = bytearray(PARAM_HEAD.pack(len(changes), 0))
    for idx, offset, value in changes:
        b += PARAM_REC.pack(int(idx), int(offset), float(value))
    return bytes(b)


def segments(n: int, changes: Sequence[Change]) -> List[Tuple[int, int, List[Change]]]:
    """Découpe un bloc de n échantillons aux décalages des changements.
    Renvoie [(début, fin, changements à poser AVANT ce morceau)]. Les
    changements à un même décalage sont groupés ; un décalage hors du bloc
    est ramené dans [0, n-1]."""
    if not changes:
        return [(0, n, [])]
    by: Dict[int, List[Change]] = {}
    for c in changes:
        o = int(min(max(0, c[1]), max(0, n - 1)))
        by.setdefault(o, []).append(c)
    cuts = sorted(by)
    out: List[Tuple[int, int, List[Change]]] = []
    if cuts[0] > 0:
        out.append((0, cuts[0], []))
    for i, o in enumerate(cuts):
        end = cuts[i + 1] if i + 1 < len(cuts) else n
        out.append((o, end, by[o]))
    return out


def process_split(process: Callable[[np.ndarray], np.ndarray], apply: Callable[[List[Change]], None],
                  block: np.ndarray, changes: Sequence[Change]) -> List[np.ndarray]:
    """Traite block (nch, n) morceau par morceau, en posant les changements aux
    bons instants. Renvoie les sorties successives (leur longueur peut varier
    au tout début : pedalboard retient la latence du plugin)."""
    n = block.shape[1]
    outs = []
    for a, b, todo in segments(n, changes):
        if todo:
            apply(todo)
        if b > a:
            outs.append(process(np.ascontiguousarray(block[:, a:b])))
    return outs


# ─────────────────────────────────────────────────────────────────────────────
# Hors ligne
# ─────────────────────────────────────────────────────────────────────────────

Event = Tuple[int, str, float]           # (image, réglage, valeur)


def offline_events(automation: Any, total: int) -> List[Event]:
    """automation (JSON du DAW) → événements triés (image, nom, valeur), bornés au rendu."""
    out: List[Event] = []
    if not isinstance(automation, list):
        return out
    for lane in automation:
        if not isinstance(lane, dict):
            continue
        name = str(lane.get("name") or "")
        frames = lane.get("frames") or []
        values = lane.get("values") or []
        if not name or not isinstance(frames, list) or not isinstance(values, list):
            continue
        for f, v in zip(frames, values):
            try:
                f = int(f)
                v = float(v)
            except (TypeError, ValueError):
                continue
            if not np.isfinite(v) or f >= total:
                continue
            out.append((max(0, f), name, min(1.0, max(0.0, v))))
    out.sort(key=lambda e: e[0])
    return out


def render_chunks(total: int, events: Sequence[Event], chunk: int) -> Iterable[Tuple[int, int, List[Event]]]:
    """Morceaux [début, fin) de taille ≤ chunk, coupés aux images des événements ;
    chacun avec les événements à poser avant lui."""
    i = 0
    pos = 0
    ev = list(events)
    while pos < total:
        todo: List[Event] = []
        while i < len(ev) and ev[i][0] <= pos:
            todo.append(ev[i])
            i += 1
        nxt = ev[i][0] if i < len(ev) else total
        end = min(total, pos + chunk, max(nxt, pos + 1))
        yield pos, end, todo
        pos = end


# ─────────────────────────────────────────────────────────────────────────────
# Écriture : changements faits dans la fenêtre du plugin
# ─────────────────────────────────────────────────────────────────────────────

WATCH_EPS = 1e-4          # en dessous : bruit d'arrondi, pas un geste
EDITOR_HOLD_S = 0.4       # après un geste dans la fenêtre, l'automation ne reprend pas la main tout de suite


class ParamWatch:
    """Valeurs connues des réglages d'un slot. `note` : valeur posée par Nova
    ou l'automation ; `diff` : relevé des valeurs du plugin, renvoie ce qui a
    bougé ailleurs (la fenêtre du plugin)."""

    def __init__(self, clock: Callable[[], float] = time.monotonic):
        self.known: Dict[str, float] = {}
        self.touched: Dict[str, float] = {}
        self.clock = clock

    def note(self, name: str, value: float):
        self.known[name] = float(value)

    def forget(self):
        self.known.clear()
        self.touched.clear()

    def held(self, name: str) -> bool:
        """Geste récent dans la fenêtre : l'automation ne s'applique pas à ce réglage."""
        t = self.touched.get(name)
        return t is not None and self.clock() - t < EDITOR_HOLD_S

    def diff(self, current: Dict[str, float]) -> List[Tuple[str, float, float]]:
        """Réglages bougés ailleurs : (nom, nouvelle valeur, valeur d'avant)."""
        moved: List[Tuple[str, float, float]] = []
        now = self.clock()
        for name, v in current.items():
            if not np.isfinite(v):
                continue
            k = self.known.get(name)
            if k is None:
                self.known[name] = float(v)      # première lecture : référence, pas un geste
                continue
            if abs(v - k) > WATCH_EPS:
                self.known[name] = float(v)
                self.touched[name] = now
                moved.append((name, float(v), float(k)))
        return moved
