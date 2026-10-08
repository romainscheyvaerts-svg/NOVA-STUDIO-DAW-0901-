"""
Side-chain des VST (R10) : point d'entrée du pont pour la clé, et contrat que
l'hôte VST3 natif devra remplir.

Ce que pedalboard (JUCE) sait faire — vérifié dans son code (ExternalPlugin.h,
pedalboard 0.9.25) et sur Pro-C 3 :
  - il DÉSACTIVE tous les bus d'entrée autres que le principal (setNumChannels :
    « Try to disable all non-main input buses ») ;
  - process() ne reçoit qu'un tableau (canaux du bus principal) ; les canaux
    supplémentaires que le plugin exigerait sont des tampons de zéros internes.
  → impossible d'alimenter l'entrée side-chain d'un VST3 avec pedalboard. Un
    Pro-C 3 réglé sur « External » n'entend que du silence en clé.

La voie : l'hôte VST3 natif (SDK VST3 sous licence MIT, en cours d'écriture :
branche hote-vst-natif-2026-10-08) active le bus d'entrée auxiliaire
(IComponent::activateBus(kAudio, kInput, 1, true), arrangement stéréo via
IAudioProcessor::setBusArrangements) et remplit ProcessData.inputs[1] avec la
clé ; les changements de réglages passent par IParameterChanges avec leur
décalage dans le bloc (échantillon-exact, sans découper le bloc).

Tout le reste est prêt côté NOVA et côté protocole :
  - trames temps réel nch=4, drapeau SIDECHAIN (canaux 3-4 = clé alignée sur
    l'audio, PDC comprise) ; RENDER sidechain=true, nch=4 ;
  - Slot.process_block(block, changes, key) ; render_offline(..., key=…) ;
  - LOAD_PLUGIN répond sidechain_inputs (None : hôte sans side-chain ; 0 : le
    plugin n'a pas d'entrée clé ; 2 : clé stéréo) ; HELLO sidechain=True quand
    l'hôte sait alimenter les bus.

CONTRAT DE L'HÔTE NATIF (ce qu'il doit fournir pour remplacer pedalboard)
-------------------------------------------------------------------------
Module Python importable (nom par défaut « nova_vst3host », ou variable
d'environnement NOVA_VST_HOST_MODULE) exposant :

    load(path: str, plugin_name: str | None, state_b64: str | None,
         sample_rate: int, max_block: int, offline: bool) -> Instance

et l'objet Instance :
    name: str ; manufacturer_name: str ; is_instrument: bool
    sidechain_channels: int          # canaux du 1er bus d'entrée auxiliaire (0 = aucun)
    latency_samples: int             # IAudioProcessor::getLatencySamples()
    process_keyed(main: np.ndarray[2, n] float32, key: np.ndarray[2, n] float32 | None,
                  changes: list[tuple[str, int, float]]) -> np.ndarray[2, n]
        # changes : (clé du réglage, décalage dans le bloc, valeur normalisée 0–1)
        # → IParameterChanges ; sortie de même longueur, latence du plugin NON
        # compensée (le Slot la gère comme aujourd'hui)
    process(x, sample_rate, buffer_size=..., reset=False)   # comme pedalboard, sans clé
    reset() ; raw_state: bytes (lecture / écriture, format libre mais stable)
    _parameters: liste d'objets réglage avec name, label, raw_value (get/set),
        string_value, get_text_for_raw_value(v), num_steps, is_boolean, is_automatable
        (les clés « python » sont calculées comme pedalboard : to_python_parameter_name)
    show_editor(close_event)          # fenêtre native (IPlugView), bloquante comme pedalboard

Tant que ce module n'existe pas, le pont garde pedalboard (aucun changement de
comportement) et signale la clé comme non prise en charge.

Pour les tests (NOVA_BRIDGE_DEBUG=1) : « nova:debug-ducker » est un effet à clé
de référence, écrit ici en numpy, qui suit exactement ce contrat (process_keyed,
_parameters, raw_state) : il prouve le chemin complet NOVA → pont → effet → retour
(routage de la clé, PDC, trames à 4 canaux, rendu d'export) sans plugin externe.
"""

import importlib
import json
import logging
import os
from typing import Any, List, Optional, Tuple

import numpy as np

logger = logging.getLogger("NovaBridge.Sidechain")

DEBUG_DUCKER = "nova:debug-ducker"


def native_host():
    """Module de l'hôte natif s'il est installé, sinon None."""
    name = os.environ.get("NOVA_VST_HOST_MODULE", "nova_vst3host")
    try:
        return importlib.import_module(name)
    except Exception:
        return None


NATIVE = native_host()


def host_feeds_sidechain() -> bool:
    """Le pont sait-il alimenter le bus side-chain des VST3 ?"""
    return NATIVE is not None


def is_debug_plugin(path: str) -> bool:
    return str(path or "").startswith("nova:debug-") and os.environ.get("NOVA_BRIDGE_DEBUG") == "1"


def sidechain_inputs(plugin) -> Optional[int]:
    """Canaux de l'entrée clé du plugin chargé : None si l'hôte ne sait pas les alimenter."""
    n = getattr(plugin, "sidechain_channels", None)
    if n is None:
        return None
    try:
        return int(n)
    except (TypeError, ValueError):
        return None


def keyed(plugin) -> bool:
    return callable(getattr(plugin, "process_keyed", None)) and (sidechain_inputs(plugin) or 0) > 0


# ─────────────────────────────────────────────────────────────────────────────
# Effet à clé de référence (tests)
# ─────────────────────────────────────────────────────────────────────────────

class _Param:
    def __init__(self, name: str, value: float, label: str, lo: float, hi: float):
        self.name, self.raw_value, self.label, self.lo, self.hi = name, float(value), label, lo, hi
        self.num_steps = 0
        self.is_boolean = False
        self.is_automatable = True

    def real(self, raw: Optional[float] = None) -> float:
        r = self.raw_value if raw is None else raw
        return self.lo + (self.hi - self.lo) * float(min(1.0, max(0.0, r)))

    def get_text_for_raw_value(self, v: float) -> str:
        return f"{self.real(v):.1f} {self.label}"

    @property
    def string_value(self) -> str:
        return self.get_text_for_raw_value(self.raw_value)


class DebugDucker:
    """Compresseur à clé minimal : détecteur crête (attaque 0,1 ms, retour
    Release ms) sur la clé, réduction = (niveau − seuil) × (1 − 1/ratio) au-dessus
    du seuil. Sans clé (process), il détecte sur son propre signal. Latence 0."""

    sidechain_channels = 2
    is_instrument = False
    manufacturer_name = "NOVA (test)"

    def __init__(self):
        self.name = "NOVA Debug Ducker"
        self.threshold = _Param("Threshold", 0.5, "dB", -60.0, 0.0)   # −30 dB
        self.ratio = _Param("Ratio", 0.5, ":1", 1.0, 21.0)            # 11:1
        self.release = _Param("Release", 0.1, "ms", 1.0, 1001.0)      # 101 ms
        self._parameters = [self.threshold, self.ratio, self.release]
        self.sr = 48000
        self.env = 0.0
        self.last_gr_db = 0.0

    # --- état ---
    @property
    def raw_state(self) -> bytes:
        return json.dumps({p.name: p.raw_value for p in self._parameters}).encode("utf-8")

    @raw_state.setter
    def raw_state(self, b: bytes):
        d = json.loads(bytes(b).decode("utf-8"))
        for p in self._parameters:
            if p.name in d:
                p.raw_value = float(d[p.name])

    def reset(self):
        self.env = 0.0

    # --- traitement ---
    def _run(self, main: np.ndarray, det: np.ndarray, sr: int) -> np.ndarray:
        self.sr = int(sr)
        n = main.shape[1]
        thr = self.threshold.real()
        slope = 1.0 - 1.0 / max(1.0, self.ratio.real())
        a_att = np.exp(-1.0 / (1e-4 * sr))
        a_rel = np.exp(-1.0 / (self.release.real() * 1e-3 * sr))
        lvl = np.max(np.abs(det), axis=0)
        g = np.empty(n, np.float32)
        e = self.env
        gr = 0.0
        for i in range(n):
            x = lvl[i]
            e = (a_att * e + (1 - a_att) * x) if x > e else (a_rel * e + (1 - a_rel) * x)
            d = 20.0 * np.log10(e + 1e-12) - thr
            r = d * slope if d > 0 else 0.0
            gr = max(gr, r)
            g[i] = 10.0 ** (-r / 20.0)
        self.env = e
        self.last_gr_db = gr
        return (main * g).astype(np.float32)

    def process_keyed(self, main: np.ndarray, key: Optional[np.ndarray], changes: List[Tuple[str, int, float]]) -> np.ndarray:
        return self._run(main, key if key is not None else main, self.sr)

    def process(self, x: np.ndarray, sample_rate: int = 48000, buffer_size: int = 512, reset: bool = False):
        if reset:
            self.reset()
        return self._run(np.asarray(x, np.float32), np.asarray(x, np.float32), sample_rate)
