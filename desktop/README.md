# Nova Studio pour Windows

Application de bureau du DAW : une fenêtre **Microsoft Edge WebView2** qui affiche le DAW
et qui lance toute seule les deux ponts du studio (ASIO, VST).

Depuis la **1.1**, le DAW (le site construit : index.html, assets/, worklets/, sons de
batterie, polices, icônes Font Awesome) est **livré dans l'application** et servi depuis le
disque : il s'ouvre sans Internet, sans attendre le réseau, et ne dépend plus d'une panne
de Vercel ou du Wi-Fi du studio. Les mises à jour du site arrivent toujours sans réinstaller
(téléchargées en arrière-plan, prises au démarrage suivant).

Ce que ça ne change pas : l'interface reste le DAW web (React + Web Audio dans le moteur
Edge). Ce n'est pas une réécriture native ; l'appli supprime les faiblesses de « la page
web » (réseau, onglet ralenti, mise en veille, rechargement par erreur), pas le moteur.

Installateur : `public/downloads/NovaStudioSetup.exe` (~37 Mo), proposé dans le DAW
(réglages audio → pont ASIO, onglet VST) avec le libellé
« Télécharger Nova Studio pour Windows (recommandé au studio : pont ASIO et VST intégrés) ».

## Ce que fait l'application

| | |
|---|---|
| Interface embarquée | `_internal\ui\` (manifeste `desktop-ui.json` : chaque fichier avec taille et SHA-256). WebView2 intercepte les requêtes vers `https://nova-studio-daw-0901-9kzo.vercel.app/*` et répond depuis le disque (événement `WebResourceRequested`, plages d'octets gérées). **Même adresse qu'avant** : connexion Supabase, sessions locales (IndexedDB « Reprendre ma session »), réglages et permissions sont conservés en passant de la 1.0 à la 1.1. Règle de vercel.json reproduite (chemin inconnu sans extension → index.html). `/api/*` n'est pas intercepté : l'assistant Nova part sur Vercel / Supabase comme sur le web. Font Awesome (cdnjs) est aussi servi en local. Le service worker du site est désactivé dans l'appli (inutile, et celui de la 1.0 est effacé au démarrage). |
| Mises à jour de l'interface | 25 s après le démarrage puis toutes les 6 h : l'appli lit l'index.html en ligne ; s'il diffère, elle télécharge la nouvelle version dans `%LOCALAPPDATA%\NovaStudio\ui\ui-<empreinte>\` (dossier temporaire, chaque fichier vérifié : statut 200, taille, pas de page index.html renvoyée à la place d'un fichier absent ; puis manifeste, contrôle complet des empreintes et renommage atomique). Les fichiers versionnés (`assets/`, `drums/`) déjà livrés ne sont pas retéléchargés (~3 Mo par mise à jour). Bandeau discret « Mise à jour de Nova Studio prête » : **Redémarrer maintenant** (sauvegarde de la session puis rechargement) ou **Plus tard** (prise au prochain démarrage). Le site en ligne fait foi : s'il revient en arrière, l'appli suit. |
| Sécurité des mises à jour | Version téléchargée incomplète ou abîmée (taille différente) → ignorée au démarrage. Version qui ne démarre pas (DAW non monté en 40 s) ou qui plante 3 fois en 2 min → marquée défectueuse (`ui\bad-ids.txt`, jamais retéléchargée), retour à la version livrée, puis en dernier recours au site en ligne. Une installation plus récente que la dernière vérification reprend sa propre version. |
| Ponts | `NovaStudio.exe --bridge asio` (port 8766) et `--bridge vst` (port 8765) : le code de `bridge-python/` tel quel (pont VST protocole v6, fenêtres de licence), dans deux processus enfants cachés (un VST qui plante n'emporte pas la fenêtre ; le superviseur le relance). Si un port est déjà pris (ancien `NovaASIOBridge.exe` / `NovaVSTBridge.exe` lancé à la main), on ne lance pas de doublon. Arrêtés à la fermeture, et par Windows si l'appli est tuée (job object). |
| Réactivité / audio | Appli, ponts et processus WebView2 (navigateur, rendu, GPU, service audio) en priorité **supérieure à la normale** (jamais « temps réel »), **sans EcoQoS** ni bridage des minuteurs par Windows (`SetProcessInformation(ProcessPowerThrottling)`) : pas de ralentissement sur batterie ou fenêtre réduite. Chromium : `--autoplay-policy=no-user-gesture-required`, `--disable-background-timer-throttling`, `--disable-renderer-backgrounding`, `--disable-backgrounding-occluded-windows`, `--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,ElasticOverscroll,UseEcoQoSForBackgroundProcess`, `--enable-features=AudioWorkletThreadRealtimePriority`. Rien qui fragilise (pas de `--no-sandbox`, `--single-process`, taille de tampon audio forcée…). |
| Micro | Toutes les permissions (micro, MIDI, presse-papiers…) sont accordées d'office au DAW et mémorisées : aucune invite. |
| Fermeture | Clic sur la croix → la page reçoit `await window.__novaBeforeClose()` (gel des pistes VST + sauvegarde), attendue jusqu'à **90 s** ; petit bandeau « Sauvegarde de la session… ». Fonction absente ou en erreur → fermeture normale. Un 2e clic pendant la sauvegarde propose de quitter quand même. |
| Raccourcis | Raccourcis du navigateur désactivés (F5 / Ctrl+R, Alt+←, Ctrl+P, Ctrl+F, zoom clavier) : un rechargement ou un « retour » par erreur pendant une prise ne fait plus perdre l'enregistrement. Copier / coller / annuler restent actifs. |
| Détection | `window.__novaDesktop = { version, platform: 'windows', ui, bridges: { asio: 8766, vst: 8765 } }` (avant les scripts de la page) et user-agent suffixé `NovaStudioDesktop/<version>`. Côté DAW : `utils/desktopApp.ts` (`isNovaDesktop()`). |
| Plantages | Onglet planté → rechargement automatique (avec un délai s'il replante) ; moteur WebView2 arrêté → proposition de relancer Nova Studio. Instance unique (un 2e lancement ramène la fenêtre). Liens externes (Stripe, mail, site) ouverts dans le navigateur, téléchargements (exports) via le panneau Edge habituel. |

Données : `%LOCALAPPDATA%\NovaStudio\` (profil WebView2 = connexion et sessions locales,
interfaces téléchargées `ui\`, journaux `logs\app.log` (avec les temps de démarrage),
`logs\bridge-asio.log`, `logs\bridge-vst.log`). Elles sont conservées à la désinstallation.

### Ce qui a encore besoin d'Internet

Les beats et pochettes (Supabase Storage), la connexion au compte, la sauvegarde dans le
cloud, la collaboration, l'assistant Nova (`/api/chat` → fonction Supabase `nova-chat`),
les paiements Stripe (ouverts dans le navigateur ; la page de retour `?nova_paid=` s'ouvre
dans le navigateur, comme en 1.0) et les mises à jour. Hors ligne, le DAW s'ouvre, les
sessions locales, la batterie, les effets, les ponts ASIO / VST et l'enregistrement marchent.

## Installation

Par utilisateur (aucun droit administrateur), dans `%LOCALAPPDATA%\Programs\Nova Studio`,
raccourci menu Démarrer + Bureau (optionnel), désinstallation depuis Paramètres →
Applications. Windows 10/11 64 bits.

- **WebView2** : présent d'office sur Windows 11 et les Windows 10 à jour. S'il manque,
  l'installateur lance l'installateur officiel de Microsoft (« Evergreen Bootstrapper »,
  livré dans le setup, signé Microsoft, vérifié par build.py) en silencieux, par utilisateur
  (Internet requis à ce moment-là). En dernier recours l'appli affiche un message avec le lien.
- **Visual C++** : les DLL nécessaires (`vcruntime140.dll`, `vcruntime140_1.dll`,
  `msvcp140.dll`) sont livrées avec l'appli ; `build.py` vérifie les dépendances de chaque
  module natif (pedalboard, numpy, PortAudio…) et échoue s'il en manque une.
- **.NET Framework 4.7.2+** (pythonnet) : inclus dans Windows 10 (1803+) et 11.
- **SmartScreen** : l'installateur n'est pas signé. Au 1er lancement, Windows affiche
  « Windows a protégé votre ordinateur » → « Informations complémentaires » → « Exécuter
  quand même ». Pour supprimer l'avertissement, il faut un **certificat de signature de
  code** au nom de Make Music (voir plus bas).

## Reconstruire

Prérequis : Python 3.14 (le même que `bridge-python`), Node/npm (avec `npm install` fait à la
racine du dépôt), Git, Internet. Rien n'est installé sur le système : tout va dans
`desktop\venv`, `desktop\node_modules` (Inno Setup via le paquet npm `innosetup-compiler`)
et `desktop\vendor` (SDK WebView2 NuGet, installateur WebView2).

```bat
cd desktop
build.bat --ui-online
```

1. crée `desktop\venv` si besoin et installe `requirements.txt` ;
2. `build.py` : SDK WebView2 → installateur WebView2 → icône → **interface embarquée**
   (`build_ui.py` → `build\ui-bundle\`) → PyInstaller (`NovaStudio.spec` → `dist\NovaStudio\`)
   → contrôle des DLL Visual C++ → signature (si configurée) → Inno Setup (`installer.iss`
   → `dist\NovaStudioSetup.exe`) → copie dans `public\downloads\NovaStudioSetup.exe`.

Source de l'interface embarquée :

| option | interface livrée |
|---|---|
| `--ui-online` (recommandé pour publier) | copie exacte du site en ligne (ce que voient les utilisateurs) |
| `--ui-ref origin/main` | `vite build` (VERCEL=1, base `/`) de cette révision, à partir d'un instantané `git archive` (jamais les fichiers en cours d'édition) |
| (rien) | `vite build` de `HEAD` |
| `--ui-from-dir ..\dist` | un build déjà fait (`VERCEL=1 npm run build`) |
| `--skip-ui` | réutilise `build\ui-bundle\` |

`build_ui.py` retire `public/downloads` (installateurs) et le service worker, copie Font
Awesome en local et **refuse de continuer s'il trouve un secret** dans le build (clé
Gemini/Google, Groq, OpenAI, Stripe, Resend, JWT autre que `anon`). Le build se fait sans
aucune variable d'environnement de type clé/secret.

`build.bat --no-copy` construit sans toucher à `public/downloads`.

### Publier une version

- **Changement du site seulement** (DAW, composants…) : rien à faire. Une fois le site
  déployé sur Vercel, les applis installées le téléchargent toutes seules (bandeau
  « Mise à jour prête » ; appliqué au redémarrage).
- **Changement de l'appli ou des ponts** (`desktop/`, `bridge-python/`) : changer
  `APP_VERSION` dans `nova_desktop.py` (repris par l'installateur et par
  `window.__novaDesktop.version`), `build.bat --ui-online`, tester, committer
  `public/downloads/NovaStudioSetup.exe`, publier le site. Les utilisateurs réinstallent
  par-dessus (leurs données sont gardées).

### Signature de code (facultative)

Sans signature, SmartScreen avertit tant que l'installateur n'a pas de « réputation ».
Il faut acheter un certificat de signature de code au nom de l'entreprise (OV ≈ 200–400 €/an,
clé sur jeton matériel ou HSM depuis 2023 ; EV un peu plus cher, réputation SmartScreen
immédiate ; ou Azure Trusted Signing ≈ 10 $/mois si l'entreprise est éligible). Puis, avant
`build.bat` :

```bat
rem certificat en fichier .pfx
set NOVA_SIGN_PFX=C:\certs\makemusic.pfx
set NOVA_SIGN_PFX_PASSWORD=...
rem ou certificat installé dans Windows (jeton USB) : empreinte SHA-1
set NOVA_SIGN_CERT_SHA1=0123456789abcdef...
rem ou n'importe quel outil ({file} = fichier à signer)
set NOVA_SIGN_COMMAND=jsign --storetype TRUSTEDSIGNING ... {file}
rem facultatif
set NOVA_SIGN_TIMESTAMP=http://timestamp.digicert.com
set NOVA_SIGNTOOL=C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe
```

`build.py` signe alors `NovaStudio.exe` (signtool, SHA-256, horodatage), puis Inno Setup
signe l'installateur et le désinstallateur (directive `SignTool`).

## Développer / tester

```bat
rem depuis les sources : interface de build\ui-bundle (build_ui.py), comme l'appli installée
venv\Scripts\python.exe nova_desktop.py

rem sur un Vite local (pas d'interface embarquée)
set NOVA_DESKTOP_URL=http://localhost:5177/
set NOVA_DESKTOP_DEBUG=1
venv\Scripts\python.exe nova_desktop.py
```

Variables : `NOVA_DESKTOP_URL`, `NOVA_DESKTOP_UI_DIR`, `NOVA_DESKTOP_NO_UPDATE=1`,
`NOVA_DESKTOP_DEBUG=1` (F12), `NOVA_DESKTOP_CDP_PORT` (débogage distant),
`NOVA_DESKTOP_DATA_DIR` (chemin court : le profil WebView2 dépasse sinon la limite de 260
caractères de Windows et IndexedDB échoue), `NOVA_DESKTOP_NO_BRIDGES=1`,
`NOVA_DESKTOP_EXTRA_ARGS`, `NOVA_DESKTOP_CLOSE_TIMEOUT`, `NOVA_DESKTOP_WINDOW=x,y,l,h`
(fenêtre non activée : ne vole pas le focus pendant les tests), `NOVA_DESKTOP_UPDATE_DELAY`,
`NOVA_DESKTOP_BOOT_TIMEOUT`.

Tests automatiques :

```bat
venv\Scripts\python.exe test\test_ui_bundle.py
venv\Scripts\python.exe test\run_tests.py dist\NovaStudio\NovaStudio.exe
venv\Scripts\python.exe test\bridge_smoke.py dist\NovaStudio\NovaStudio.exe
venv\Scripts\python.exe test\measure_startup.py dist\NovaStudio\NovaStudio.exe --runs 3
venv\Scripts\python.exe test\measure_startup.py dist\NovaStudio\NovaStudio.exe --runs 1 --offline
```

- `test_ui_bundle.py` (sans Internet, faux site local) : choix de la version, téléchargement
  d'une mise à jour, fichiers repris, fichier absent en ligne refusé, version abîmée ou
  défectueuse écartée, retour en arrière du site, nouvelle installation, nettoyage.
- `run_tests.py` : marqueur + user-agent, micro sans invite, autoplay, ponts lancés puis
  arrêtés, fermeture qui attend `__novaBeforeClose` (succès / exception / rejet / promesse
  bloquée → délai max), page hors ligne (mode `NOVA_DESKTOP_URL`), instance unique.
- `bridge_smoke.py` : `GET_DEVICES` sur le pont ASIO, `HELLO` + liste + chargement d'un VST3.
- `measure_startup.py` : délai lancement → DAW monté, octets passés par le réseau, latence
  Web Audio (`baseLatency`, `outputLatency`) ; `--offline` coupe le réseau de la page.

Mesures (PC du studio, fibre, Windows 11, WebView2 154) :

| | 1.0 (site en ligne) | 1.1 (interface embarquée) |
|---|---|---|
| lancement → DAW monté | 1,3–1,9 s | 1,3 s dans l'appli (1,7 s vu de l'extérieur, exe) |
| document reçu / DOMContentLoaded | 92–120 ms / 177–503 ms | 22–34 ms / 125–145 ms |
| octets passés par le réseau pour l'interface | 23 ko (cache chaud) à 510 ko (1er lancement) | 0 |
| sans Internet | page « Impossible de charger Nova Studio » | DAW complet en 1,4–1,8 s |
| Web Audio (48 kHz, partagé) | baseLatency 10 ms, outputLatency 48 ms | identique (le pont ASIO reste la voie basse latence) |

Sur une bonne connexion, le temps de démarrage est le même (le chargement du moteur .NET
+ WebView2 domine, ~1 s) ; le gain est sur une connexion lente, instable ou absente.

Installation silencieuse (test) : `NovaStudioSetup.exe /VERYSILENT /DIR="C:\chemin" /TASKS=""`,
désinstallation : `"C:\chemin\unins000.exe" /VERYSILENT`.

## Fichiers

- `nova_desktop.py` — l'application (fenêtre, interface embarquée, superviseur des ponts, priorités)
- `ui_bundle.py` — interface embarquée : choix de la version, téléchargement et vérification des mises à jour
- `build_ui.py` — construction de l'interface embarquée (`build\ui-bundle\`)
- `offline.html` — page hors ligne (seulement sans interface embarquée utilisable)
- `NovaStudio.spec` — recette PyInstaller (inclut `../bridge-python/*.py` et l'interface)
- `installer.iss` — installateur Inno Setup (+ installation de WebView2 si absent)
- `build.bat`, `build.py`, `requirements.txt`, `package.json` — construction
- `assets/nova.ico` — icône
- `test/` — tests automatiques et mesures
