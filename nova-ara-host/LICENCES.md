# NovaARAHost : licences

NovaARAHost.exe est l'hôte ARA2 de Nova Studio (Melodyne, VocAlign). Programme séparé,
lancé par le pont VST ; il ne contient aucun code de Nova Studio lui-même.

| Composant | Origine | Licence |
|---|---|---|
| Sources de NovaARAHost (`Source/Main.cpp`, CMake) | Make Music | à publier sous AGPLv3 si l'exécutable est distribué avec JUCE sous AGPLv3 |
| JUCE 9.0.3 | https://github.com/juce-framework/JUCE (commit be29c81) | AGPLv3 **ou** licence commerciale JUCE 9 |
| ARA SDK 2.3 | https://github.com/Celemony/ARA_SDK (commit a2b1aac) | Apache 2.0 |
| VST3 SDK (inclus dans JUCE) | Steinberg | MIT (VST 3.8+) |

## Ce qu'il faut décider avant de livrer l'installateur à des clients

JUCE est utilisé ici sous **AGPLv3** (aucune licence commerciale acceptée au nom de Make Music).
Pour distribuer NovaARAHost.exe avec Nova Studio, deux possibilités :

1. **Rester en AGPLv3** : fournir les sources de NovaARAHost (ce dossier) à qui reçoit
   l'exécutable (dépôt public ou archive dans l'installateur). Nova Studio reste fermé :
   c'est un programme distinct qui dialogue par lignes JSON (stdin / stdout).
2. **Licence JUCE commerciale** (formule gratuite « Starter » selon le chiffre d'affaires, ou
   payante) : à souscrire par Romain sur juce.com, puis plus d'obligation AGPL.

Usage interne au studio (sans distribution) : aucune obligation particulière.
