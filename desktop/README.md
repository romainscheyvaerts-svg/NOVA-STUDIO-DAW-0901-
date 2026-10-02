# Nova Studio pour Windows

Application de bureau du DAW : une fenêtre **Microsoft Edge WebView2** qui charge le
DAW en ligne (`https://nova-studio-daw-0901-9kzo.vercel.app/`) et qui lance toute seule
les deux ponts du studio. Les mises à jour du site arrivent sans réinstaller.

Installateur : `public/downloads/NovaStudioSetup.exe` (~22 Mo), proposé dans le DAW
(réglages audio → pont ASIO, onglet VST) avec le libellé
« Télécharger Nova Studio pour Windows (recommandé au studio : pont ASIO et VST intégrés) ».

## Ce que fait l'application

| | |
|---|---|
| Ponts | `NovaStudio.exe --bridge asio` (port 8766) et `--bridge vst` (port 8765) : le code de `bridge-python/` tel quel, dans deux processus enfants cachés (un VST qui plante n'emporte pas la fenêtre ; le superviseur le relance). Si un port est déjà pris (ancien `NovaASIOBridge.exe` / `NovaVSTBridge.exe` lancé à la main), on ne lance pas de doublon. Arrêtés à la fermeture, et par Windows si l'appli est tuée (job object). |
| Micro | Toutes les permissions (micro, MIDI, presse-papiers…) sont accordées d'office au DAW (et à localhost) et mémorisées : aucune invite. |
| Lecture | Autoplay autorisé ; pas de ralentissement en arrière-plan / fenêtre masquée. |
| Fermeture | Clic sur la croix → la page reçoit `await window.__novaBeforeClose()` (gel des pistes VST + sauvegarde), attendue jusqu'à **90 s** ; petit bandeau « Sauvegarde de la session… ». Fonction absente ou en erreur → fermeture normale. Un 2e clic pendant la sauvegarde propose de quitter quand même. |
| Détection | `window.__novaDesktop = { version, platform: 'windows', bridges: { asio: 8766, vst: 8765 } }` (avant les scripts de la page) et user-agent suffixé `NovaStudioDesktop/<version>`. Côté DAW : `utils/desktopApp.ts` (`isNovaDesktop()`). |
| Hors ligne | Page française « Impossible de charger Nova Studio » + bouton « Réessayer » (et nouvel essai automatique). |
| Divers | Instance unique (un 2e lancement ramène la fenêtre), onglet planté → rechargement automatique, liens externes (Stripe, mail, site) ouverts dans le navigateur, téléchargements (exports) via le panneau Edge habituel. |

Données : `%LOCALAPPDATA%\NovaStudio\` (profil WebView2 = connexion et sessions locales,
journaux `logs\app.log`, `logs\bridge-asio.log`, `logs\bridge-vst.log`). Elles sont
conservées à la désinstallation.

Installation : par utilisateur (aucun droit administrateur), dans
`%LOCALAPPDATA%\Programs\Nova Studio`, raccourci menu Démarrer + Bureau (optionnel),
désinstallation depuis Paramètres → Applications. Prérequis : Windows 10/11 64 bits avec
le runtime WebView2 (présent d'office sur Windows 11 et sur les Windows 10 à jour ; sinon
l'appli affiche un message avec le lien Microsoft).

## Reconstruire

Prérequis : Python 3.14 (le même que `bridge-python`), Node/npm, Internet (1re fois).
Rien n'est installé sur le système : tout va dans `desktop\venv`, `desktop\node_modules`
(Inno Setup via le paquet npm `innosetup-compiler`) et `desktop\vendor` (SDK WebView2 NuGet).

```bat
cd desktop
build.bat
```

1. crée `desktop\venv` si besoin et installe `requirements.txt` ;
2. `build.py` : SDK WebView2 → icône (`assets\nova.ico`, depuis `public/icons/icon-512.png`)
   → PyInstaller (`NovaStudio.spec` → `dist\NovaStudio\`) → Inno Setup (`installer.iss`
   → `dist\NovaStudioSetup.exe`) → copie dans `public\downloads\NovaStudioSetup.exe`.

`build.bat --no-copy` construit sans toucher à `public/downloads`.

**Nouvelle version** : changer `APP_VERSION` dans `nova_desktop.py` (reprise par
l'installateur et par `window.__novaDesktop.version`), reconstruire, committer
`public/downloads/NovaStudioSetup.exe`. Une réinstallation n'est nécessaire que si le
code de l'appli ou des ponts change, pas pour le site.

## Développer / tester

```bat
rem depuis les sources, sur un Vite local
set NOVA_DESKTOP_URL=http://localhost:5177/
set NOVA_DESKTOP_DEBUG=1
venv\Scripts\python.exe nova_desktop.py
```

Variables : `NOVA_DESKTOP_URL`, `NOVA_DESKTOP_DEBUG=1` (F12), `NOVA_DESKTOP_CDP_PORT`
(débogage distant), `NOVA_DESKTOP_DATA_DIR`, `NOVA_DESKTOP_NO_BRIDGES=1`,
`NOVA_DESKTOP_EXTRA_ARGS`, `NOVA_DESKTOP_CLOSE_TIMEOUT`.

Tests automatiques (ouvrent et ferment la fenêtre plusieurs fois, ~1 min) :

```bat
venv\Scripts\python.exe test\run_tests.py dist\NovaStudio\NovaStudio.exe
venv\Scripts\python.exe test\bridge_smoke.py dist\NovaStudio\NovaStudio.exe
```

`run_tests.py` : marqueur + user-agent, micro sans invite, autoplay, ponts lancés puis
arrêtés, fermeture qui attend `__novaBeforeClose` (succès / exception / rejet / promesse
bloquée → délai max), page hors ligne, instance unique. `bridge_smoke.py` : `GET_DEVICES`
sur le pont ASIO, `HELLO` + liste + chargement d'un VST3 sur le pont VST.

Installation silencieuse (test) : `NovaStudioSetup.exe /VERYSILENT /DIR="C:\chemin" /TASKS=""`,
désinstallation : `"C:\chemin\unins000.exe" /VERYSILENT`.

## Fichiers

- `nova_desktop.py` — l'application (fenêtre, superviseur des ponts, aiguillage des rôles)
- `offline.html` — page hors ligne
- `NovaStudio.spec` — recette PyInstaller (inclut `../bridge-python/*.py`)
- `installer.iss` — installateur Inno Setup
- `build.bat`, `build.py`, `requirements.txt`, `package.json` — construction
- `assets/nova.ico` — icône
- `test/` — tests automatiques
