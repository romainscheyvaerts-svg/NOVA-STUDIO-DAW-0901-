# NovaVSTHost : licences

NovaVSTHost.exe est l'hôte VST3 natif de Nova Studio : il charge les plugins VST3 du PC
(un processus par plugin) pour le pont VST (`bridge-python/vst_native.py`). Il remplace
**pedalboard** (Spotify, GPLv3, qui embarque JUCE), qui n'est plus livré. Il est construit
**sans JUCE** : aucune composante sous GPL ni AGPL.

| Composant | Origine | Licence |
|---|---|---|
| Sources de NovaVSTHost (`native-host/Source/*`, CMake) et code commun (`native-common/*`) | Make Music | propriétaire (Make Music) |
| Moteur natif du pont (`bridge-python/vst_native.py`, `nova_vst3host.py`) | Make Music, écrit sans reprendre de code de pedalboard (les règles reproduites — clés des réglages, relevé des textes, enveloppe d'état — sont des comportements, réécrits) | propriétaire (Make Music) |
| VST3 SDK 3.8.1 (`pluginterfaces`, `base`, `public.sdk/source/common` et `vst/hosting`) | https://github.com/steinbergmedia/vst3sdk, tag `v3.8.1_build_84` (commit 3cdf9ca ; pluginterfaces 4f547e8, public.sdk 586dc5e, base fcf9da0) | **MIT** (Steinberg Media Technologies GmbH), texte : `licences/VST3_SDK-MIT.txt` |

Les fichiers du SDK sont compilés tels quels (aucune modification) et ne sont pas copiés dans
le dépôt (sources dans `D:\1 WORK\CODE\_libs\ara-host-sources\vst3sdk`, voir `build.bat`).

## Ce qu'implique la distribution

- **MIT (VST3 SDK)** : garder la mention de copyright et le texte de la licence MIT avec
  l'exécutable (ce fichier et `licences/`). Aucune obligation de publier nos sources.
- « VST » est une marque de Steinberg Media Technologies GmbH ; Nova Studio n'est pas affilié à
  Steinberg. Le logo VST n'est pas utilisé (il demanderait l'accord de licence VST3 de Steinberg).

## Licences de tout ce que l'installateur embarque (vérifié le 08/10/2026)

**pedalboard n'est plus livré** (ni le paquet Python ni `pedalboard_native`, ni JUCE, Rubber
Band, etc.) : retiré des recettes PyInstaller et exclu explicitement (`excludes`), vérifié sur
un build PyInstaller complet fait avec une venv où pedalboard est installé (aucun fichier ni
module « pedalboard » dans `dist/NovaStudio`). Le pont ne l'importe que sur demande explicite
(`NOVA_VST_ENGINE=pedalboard`, paquet installé à part, outil de comparaison).

| Composant embarqué | Licence |
|---|---|
| Nova Studio, pont Python, NovaVSTHost, NovaARAHost | propriétaire (Make Music) |
| VST3 SDK (NovaVSTHost, NovaARAHost) | MIT |
| ARA SDK (NovaARAHost) | Apache 2.0 |
| CPython 3.14 (`python314.dll`, bibliothèque standard) | PSF License |
| OpenSSL 3 (`libcrypto-3.dll`, `libssl-3.dll`) | Apache 2.0 |
| libffi (`libffi-8.dll`) | MIT |
| numpy 2.5.3 | BSD-3-Clause ; y sont liés OpenBLAS (BSD-3-Clause), LAPACK (BSD-3-Clause-Open-MPI) et la **bibliothèque d'exécution de GCC** (GPL-3.0-or-later **avec l'exception GCC Runtime Library 3.1** : n'impose rien au programme qui l'utilise) |
| websockets 17.1 | BSD-3-Clause |
| sounddevice 0.5.6 | MIT |
| PortAudio (`_sounddevice_data`) | MIT (licence PortAudio) |
| **ASIO SDK de Steinberg** compilé dans `libportaudio*-asio.dll` | licence propriétaire Steinberg (« ASIO SDK Licensing Agreement ») **ou** GPLv3 au choix depuis le SDK 2.3.3 (2023) : la distribution sous licence propriétaire suppose l'accord ASIO de Steinberg ; c'est la seule composante à statut GPL possible restante, à régler par l'accord (gratuit) ou en livrant la DLL sans ASIO |
| comtypes | MIT |
| pythonnet, clr_loader | MIT |
| cffi | MIT-0 ; pycparser BSD-3-Clause |
| setuptools (tiré par pythonnet) | MIT |
| SDK WebView2 (DLL de Microsoft) | licence de redistribution Microsoft (BSD-3-Clause pour le SDK) |
| Visual C++ (`vcruntime140*.dll`, `msvcp140*.dll`) | redistribuables Microsoft |
| PyInstaller (chargeur) | GPLv2 **avec l'exception PyInstaller** : n'impose rien au programme construit |

Aucune composante sous LGPL n'est embarquée.

## Retrait de pedalboard (fait le 08/10/2026)

Parité prouvée sur la liste de référence (voir
`D:\1 WORK\CONTENU\nova-hote-vst\SYNTHESE.md`) ; moteur natif par défaut et seul livré.

- `desktop/NovaStudio.spec`, `bridge-python/NovaVSTBridge.spec` : pedalboard retiré et exclu,
  `NovaVSTHost.exe` + ce fichier + `licences/` livrés (`_internal/vst-host/`) ;
  `desktop/requirements.txt`, `bridge-python/requirements.txt`, `start_bridge.bat` : sans pedalboard.
- Retirés : `vst_shell.py` (relais de la fabrique des shells Waves pour pedalboard) et l'essai en
  processus jetable de `plugin_guard.py` (inutiles : un plugin = un processus). Restent
  `plugin_guard.PluginUnstable` (plantage au chargement) et la quarantaine (`vst_host.CrashGuard`).
- Outils de développement qui peuvent encore comparer avec pedalboard s'il est installé à part :
  `qa/vst_native_parite.py`, `qa/vst_native_charge.py`, `capture_ir.py`, `juce_state.py`.

Points connus (voir la synthèse) : EchoBoy (modulation aléatoire) et Vital (phases aléatoires)
ne sont pas déterministes, y compris avec pedalboard.
