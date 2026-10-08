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

## Plan de retrait de pedalboard

Parité prouvée le 08/10/2026 sur la liste de référence (voir
`D:\1 WORK\CONTENU\nova-hote-vst\SYNTHESE.md`). Déjà fait dans cette branche :

1. Moteur par défaut : `DEFAULT_ENGINE = "native"` (`bridge-python/vst_native.py`) ;
   `NOVA_VST_ENGINE=pedalboard` reste possible tant que le paquet est installé.
2. `desktop/build.py` : étape `native_host()` (construit `native-host/build.bat` si l'exe manque) ;
   `desktop/NovaStudio.spec` et `bridge-python/NovaVSTBridge.spec` : `NovaVSTHost.exe`, ce fichier
   et `licences/` livrés (`_internal/vst-host/`), `vst_native` / `nova_vst3host` en imports cachés.

Reste à faire pour retirer pedalboard (et donc toute composante GPL) :

3. `desktop/NovaStudio.spec` : retirer `'pedalboard'` de la boucle `collect_all` et
   `hiddenimports += ['pedalboard_native']` ; `desktop/requirements.txt` : `pedalboard==0.9.25` ;
   `bridge-python/NovaVSTBridge.spec` : `collect_all('pedalboard')`, `pedalboard_native` ;
   `bridge-python/requirements.txt` et `start_bridge.bat` (installation de pedalboard).
4. Code qui ne sert plus qu'avec pedalboard (à garder pour le repli tant qu'il est livré, à
   retirer ensuite) : `vst_shell.py` (relais de la fabrique des shells Waves), essai jetable de
   `plugin_guard.py` ; outils hors installateur qui importent pedalboard : `capture_ir.py`,
   `juce_state.py`, `qa/vst_native_parite.py` (comparaison, reste un outil de développement).
5. Vérifier : `python -m unittest discover -s tests -q` sans pedalboard installé, puis
   l'installateur (sans lancer `desktop\build.bat` hors de la machine de construction).

Points connus (voir la synthèse) : EchoBoy (modulation aléatoire) et Vital (phases aléatoires)
ne sont pas déterministes, y compris avec pedalboard ; `is_discrete` de pedalboard est une valeur
non initialisée dans sa version de JUCE (le natif répond « vrai », sa réponse dominante).
