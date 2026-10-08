#!/usr/bin/env python3
"""
Module de l'hôte VST3 natif attendu par vst_sidechain (contrat écrit en tête de
vst_sidechain.py) : il n'est importable que si le moteur natif est choisi
(NOVA_VST_ENGINE=native, ou moteur par défaut, avec NovaVSTHost.exe présent).
Sinon (NOVA_VST_ENGINE=pedalboard, ou NovaVSTHost.exe absent) ImportError : la clé est annoncée
non prise en charge.

    load(path, plugin_name, state_b64, sample_rate, max_block, offline) -> Instance
    Instance = vst_native.NativePlugin : sidechain_channels, latency_samples,
    process_keyed(main, key, changes), process(...), reset(), raw_state, _parameters,
    show_editor(close_event).
"""

import vst_native

if vst_native.select_engine(vst_native.load_pedalboard() is not None) != "native":
    raise ImportError("moteur VST natif non choisi (NOVA_VST_ENGINE) ou NovaVSTHost.exe absent")

NativePlugin = vst_native.NativePlugin
HostCrashed = vst_native.HostCrashed


def load(path, plugin_name=None, state_b64=None, sample_rate=48000, max_block=128, offline=True):
    return vst_native.load_prepared(path, plugin_name, state_b64, sample_rate, max_block, offline)
