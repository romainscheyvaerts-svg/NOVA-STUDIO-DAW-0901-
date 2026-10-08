#!/usr/bin/env python3
"""
Plugins qui plantent : ce qu'il en reste depuis l'hôte VST3 natif.

Chaque plugin vit dans son propre processus (NovaVSTHost.exe) : un plantage n'emporte que ce
processus, le pont continue. L'ancien essai en processus jetable (`--trial-load`, plugins « à
risque », témoin de chargement), qui protégeait le pont quand les plugins tournaient dedans avec
pedalboard, est retiré. Restent :
  - PluginUnstable : le plugin a planté en se chargeant (processus perdu) ; refus net avec un
    message clair, le pont continue ;
  - la quarantaine, dans vst_host.CrashGuard : deux plantages au chargement → plus chargé
    automatiquement (« Chercher à nouveau » lève la quarantaine).
"""

import os
import re
from typing import Optional


class PluginUnstable(RuntimeError):
    """Le plugin a planté en se chargeant (son processus est perdu) : refusé, le pont continue."""


def _compact(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def key_of(path: str, plugin_name: Optional[str]) -> str:
    return f"{os.path.normcase(os.path.abspath(path))}#{plugin_name or ''}"


def display_name(path: str, plugin_name: Optional[str]) -> str:
    if plugin_name:
        return plugin_name
    base = os.path.basename(path.rstrip("\\/"))
    return base[:-5] if base.lower().endswith(".vst3") else base
