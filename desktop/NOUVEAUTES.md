# Nouveautés de Nova Studio pour Windows

Ce fichier est lu par `build.py` : la section `## <version>` (= `APP_VERSION` de
`nova_desktop.py`) devient le champ `notes` du manifeste `public/downloads/nova-studio-latest.json`,
affiché aux utilisateurs dans la carte « Nova Studio X.Y.Z est prête » puis « Mis à jour en X.Y.Z ✓ ».

Règles : 3 à 6 lignes commençant par « - », en français simple, sans jargon, du point de vue
de l'utilisateur (ce qui change pour lui). Les 6 premières lignes seulement sont gardées.

## 1.5.11
- Talkback : touche N (appui court = reste ouvert, maintenu = tant que tu tiens), bouton « Talk » à côté de REC, en collaboration comme dans le casque de l'artiste au studio.
- Nouveaux effets de mix : compresseur multibande et EQ dynamique (calme une résonance seulement quand elle ressort).
- Écoute de l'ingé : mono, côtés, Dim −20 dB, volume d'écoute, solo AFL / PFL ; reverb avec ta propre réponse impulsionnelle (WAV).
- Grosses séances plus fluides : l'interface ne rame plus pendant la lecture, deux fois moins de mémoire, trois fois moins de charge à l'arrêt.
- Collaboration : le direct se rebranche tout seul après une coupure ou quand tu reviens sur l'onglet.

## 1.5.10
- Playlist : glisse simplement un clip vers le haut, dans la playlist au-dessus de ta piste : il y ajoute une ligne, la playlist grandit à chaque clip.
- Ça marche avec tous les clips audio, pas seulement les prises enregistrées dans Nova.

## 1.5.9
- Playlist des prises gardées visible dès l'ouverture, au-dessus de ta piste d'enregistrement : chaque prise gardée pendant le rec y ajoute une ligne.
- Onglet VST : tous tes plugins s'affichent (la liste s'arrêtait à 300).
- Waves : une seule ligne par plugin, avec Stéréo / Mono / Mono → stéréo en petits boutons (au lieu de 734 lignes).

## 1.5.8
- Waves : tous tes plugins sont détectés, même à la toute première ouverture (les groupes Waves sont lus l'un après l'autre).
- Un groupe Waves qui ne répond pas est relu tout de suite, au lieu d'attendre le prochain démarrage.

## 1.5.7
- Plus léger sur les PC peu puissants : presque rien ne tourne quand le studio est à l'arrêt.
- « Mode léger » (Réglages audio) : activé tout seul sur les petits PC, moins d'effets visuels, le son n'est pas touché.
- Ouvrir un plugin VST ouvre directement sa fenêtre.
- Waves : plus de groupes vides dans la liste des plugins.

## 1.5.6
- Waves : les groupes de plugins sont lus jusqu'au bout (plus de temps la 1re fois), et relus à chaque ouverture s'ils ont échoué.
- Un plugin qui met longtemps à s'ouvrir (licence en attente) : Nova te dit quoi faire au lieu de tourner sans fin.
- Plus de « pont VST » à connecter : les plugins démarrent et redémarrent tout seuls.

## 1.5.5
- Tes plugins VST3 (Waves, Antares…) sont détectés tout seuls à la première ouverture, sans clic.
- Onglet VST : la lecture des plugins s'affiche (compteur) et la liste se complète au fur et à mesure.
- Les plugins Waves apparaissent en premier.

## 1.5.4
- Nouvelle édition « hors ligne » sur clé USB : Nova Studio s'ouvre sans compte et sans Internet.
- Nova Pro offert par le studio : affiché « sans limite » au lieu d'un décompte en jours.
- Corrections et améliorations de stabilité.

## 1.5.3
- Nova Studio se met maintenant à jour tout seul : la nouvelle version se télécharge en arrière-plan.
- Tu es prévenu quand elle est prête : « Redémarrer et mettre à jour » ou « Plus tard ».
- Sans rien faire, elle s'installe quand tu fermes Nova Studio (jamais pendant un enregistrement).
- Réglages : « Mises à jour automatiques » et « Rechercher maintenant », avec la version installée.
- Mode simple plus clair : le beat et une seule piste pour enregistrer ta voix.
- « Créer un compte » crée directement ton compte Make Music.

## 1.5.2
- Corrections et améliorations de stabilité.
