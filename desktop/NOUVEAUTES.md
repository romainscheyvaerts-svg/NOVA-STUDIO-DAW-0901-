# Nouveautés de Nova Studio pour Windows

Ce fichier est lu par `build.py` : la section `## <version>` (= `APP_VERSION` de
`nova_desktop.py`) devient le champ `notes` du manifeste `public/downloads/nova-studio-latest.json`,
affiché aux utilisateurs dans la carte « Nova Studio X.Y.Z est prête » puis « Mis à jour en X.Y.Z ✓ ».

Règles : 3 à 6 lignes commençant par « - », en français simple, sans jargon, du point de vue
de l'utilisateur (ce qui change pour lui). Les 6 premières lignes seulement sont gardées.

## 1.5.16
- Studio allégé : les commandes rares sont rangées dans des menus (Options, Vue, Outils, Édition, Session, ⋯), rien n'a disparu.
- Nouveau séquenceur de batterie pro (probabilité, rolls, fills, polymétrie) avec un sampler complet par pad, et un piano roll plus pratique.
- Notes de la voix : corrige la justesse note par note au 2 cents près, et allonge ou raccourcis une note en mode élastique.
- Nova Tune calé sur les meilleurs autotunes (vitesse, flex, vibrato naturel, formant, notes cibles) ; pan pro, double pan stéréo et faders jusqu'à +12 dB.
- Effets mesurés : chaque réglage affiché est le vrai (coupe-bas, ratio, temps, LUFS…), lecture = export au bit près.
- Plus fiable : prises écrites au fil de l'eau, son qui repart seul après une panne, tablette et téléphone revus au doigt.

## 1.5.15
- Fenêtres de plugins comme dans un vrai DAW : plus d'icône par plugin dans la barre des tâches, elles restent devant Nova et se réduisent avec lui.
- Plugins plus rapides à ouvrir : Waves 4 fois plus vite, Auto-Tune 2 fois plus vite ; un projet de 12 plugins se charge en 3,5 s au lieu de 12.
- Un plugin qui se fige ne bloque plus Nova Studio.

## 1.5.14
- Musiciens de séance : un batteur, un bassiste (808) et des claviers qui jouent tout seuls en suivant tes accords ; styles Trap, Drill UK, Drill FR, Boom bap, R&B, Afro ; intensité, complexité et remplissages par section.
- Boucle avec un effet à latence : le début n'est plus coupé à chaque tour.
- Automation : toucher un réglage d'un effet du rack parallèle l'écrit (Touch, Latch, Write).
- Modulateurs : suiveur d'enveloppe (ex. le kick qui creuse le volume de la basse).

## 1.5.13
- Lecture avec un effet à latence (EQ phase linéaire, limiteur) : le début des sons n'est plus coupé.
- Piano roll : la grille suit les rampes de tempo.
- Collaboration : annuler un changement de tempo ramène tout le monde au même état.
- Rack parallèle : les réglages des effets de ses branches s'automatisent.
- Compresseur multibande et EQ dynamique : clé externe (side-chain), par exemple le kick qui creuse la basse.

## 1.5.12
- Tempo : le changer garde tes notes, clips et automation sur la grille ; rampes d'accélération ; option « garder les clips audio à leur place ».
- MIDI vivant : arpège, accords et gamme forcée en direct, clips liés (modifier un motif modifie ses copies), LFO calés sur le tempo.
- Mix pro : EQ centre/côtés et phase linéaire, racks d'effets parallèles, scènes de mix A/B/C/D, masteriser un EP ou un album.
- Voix : réparer (plosives, clics de bouche, bourdonnement, saturation), éditeur spectral, éditer la voix par le texte, étirement haute qualité.
- Pro : échange DAWproject, pistes épinglées et filtrées, macros, console sur un 2e écran, vidéo calée à l'image.

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
