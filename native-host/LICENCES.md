# NovaVSTHost : licences

NovaVSTHost.exe est l'hôte VST3 natif de Nova Studio : il charge les plugins VST3 du PC
(un processus par plugin) pour le pont VST (`bridge-python/vst_native.py`). Il remplace
**pedalboard** (Spotify, GPLv3, qui embarque JUCE). Il est construit **sans JUCE** : aucune
composante sous GPL ni AGPL.

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

## Ce qui reste sous GPL dans l'installateur (à ce jour)

Seulement **pedalboard** (GPLv3, et ce qu'il embarque : JUCE sous GPL, Rubber Band sous GPL,
libmp3lame / libgsm…) : paquet Python `pedalboard` + module natif `pedalboard_native`,
collectés par `desktop/NovaStudio.spec` (`collect_all('pedalboard')`, `hiddenimports
pedalboard_native`) et par `bridge-python/NovaVSTBridge.spec`. Rien d'autre : websockets
(BSD), numpy (BSD), sounddevice (MIT), comtypes (MIT), pythonnet (MIT), WebView2 (Microsoft,
redistribuable), NovaARAHost (MIT + Apache 2.0). PyInstaller (GPL avec exception pour le
chargeur) n'impose rien aux programmes construits.

## Plan de retrait de pedalboard (une fois la parité prouvée sur toute la liste)

1. Moteur par défaut : `DEFAULT_ENGINE = "native"` dans `bridge-python/vst_native.py`
   (`NOVA_VST_ENGINE=pedalboard` reste possible tant que le paquet est installé).
2. `desktop/build.py` : étape `native_host()` sur le modèle de `ara_host()` (construit
   `native-host/build.bat` si l'exe manque) ; `desktop/NovaStudio.spec` : `binaries +=
   [('../native-host/build/NovaVSTHost_artefacts/Release/NovaVSTHost.exe', '.')]`, `datas +=
   [('../native-host/LICENCES.md', 'vst-host'), ('../native-host/licences/*.txt',
   'vst-host/licences')]`, `hiddenimports += ['vst_native', 'nova_vst3host']`.
3. Retirer pedalboard : `desktop/NovaStudio.spec` (`'pedalboard'` de la boucle
   `collect_all`, `hiddenimports pedalboard_native`), `desktop/requirements.txt`
   (`pedalboard==0.9.25`), `bridge-python/requirements.txt`, `bridge-python/NovaVSTBridge.spec`
   (`collect_all('pedalboard')`, `pedalboard_native`) ; `bridge-python/start_bridge.bat`
   (installation de pedalboard).
4. Code qui ne sert plus qu'avec pedalboard (garder pour le repli ou retirer ensuite) :
   `vst_shell.py` (relais de la fabrique des shells Waves), essai jetable de `plugin_guard.py`,
   `JuceThread` (garde un rôle : un seul fil pour les chargements) ; `capture_ir.py` et
   `juce_state.py` (outils, hors installateur) importent pedalboard directement.
5. Vérifier : `python -m unittest discover -s tests -q` sans pedalboard installé, banc
   `qa/vst_native_parite.py` et `qa/vst_native_mieux.py`, modèle LENNON
   (`scripts/template_from_spec.ts --activate-all`), puis l'installateur.
