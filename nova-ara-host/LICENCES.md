# NovaARAHost : licences

NovaARAHost.exe est l'hôte ARA2 de Nova Studio (Melodyne, VocAlign). Programme séparé, lancé
par le pont VST ; il ne contient aucun code de Nova Studio lui-même. Depuis la version 2.0.0,
il est construit **sans JUCE** : plus aucune composante sous AGPL ni GPL.

| Composant | Origine | Licence |
|---|---|---|
| Sources de NovaARAHost (`Source/*`, CMake) | Make Music | propriétaire (Make Music) |
| VST3 SDK 3.8.1 (`pluginterfaces`, `public.sdk/source/common` et `vst/hosting`) | https://github.com/steinbergmedia/vst3sdk, tag `v3.8.1_build_84` (commit 3cdf9ca ; pluginterfaces 4f547e8, public.sdk 586dc5e) | **MIT** (Steinberg Media Technologies GmbH), texte : `licences/VST3_SDK-MIT.txt` |
| ARA SDK 2.3 (`ARA_API`, `ARA_Library/Dispatch`, `ARA_Library/Debug`) | https://github.com/Celemony/ARA_SDK (commit a2b1aac ; ARA_API 65ec5c4, ARA_Library d18a6a5) | **Apache 2.0** (Celemony Software GmbH), texte : `licences/ARA_SDK-Apache-2.0.txt` |

Les fichiers des deux SDK sont compilés tels quels (aucune modification). L'enchaînement ARA
(initialisation de la fabrique, document, liaison au plugin) suit l'hôte d'exemple ARATestHost
d'ARA_Examples (Apache 2.0), qui a servi de référence ; aucun fichier d'ARA_Examples n'est copié.
Le mode capture de VocAlign, la fenêtre Win32, la sortie WASAPI, le JSON et les WAV sont écrits
par Make Music.

## Ce qu'implique la distribution

- **MIT (VST3 SDK)** : garder la mention de copyright et le texte de la licence MIT avec
  l'exécutable. Aucune obligation de publier nos sources.
- **Apache 2.0 (ARA SDK)** : fournir une copie de la licence Apache 2.0 ; aucun fichier NOTICE
  n'accompagne ARA_API ni ARA_Library. Aucune obligation de publier nos sources.

L'installateur de Nova Studio embarque donc l'hôte **par défaut** (`NOVA_EXCLUDE_ARA=1` pour
l'exclure), avec ce fichier et le dossier `licences/` copiés dans `_internal/ara-host/`.

« VST » est une marque de Steinberg Media Technologies GmbH ; « Melodyne » et « ARA » sont des
marques de Celemony Software GmbH ; « VocAlign » est une marque de Synchro Arts. Nova Studio
n'est affilié à aucune de ces sociétés.
