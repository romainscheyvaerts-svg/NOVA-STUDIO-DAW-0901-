# Nova Bridge Python

Bridge Python pour connecter le DAW Nova Studio (web) aux ressources natives du PC.

## 🎛️ Modules Disponibles

### 1. Nova Bridge VST3 (`nova_bridge_server.py` + `vst_host.py`)
Les plugins VST3 installés sur le PC, utilisables dans Nova Studio (navigateur).

- Port : **8765**, uniquement sur `127.0.0.1` (jamais visible du réseau local)
- Origines acceptées : `localhost`, `nova-studio-daw-0901(-*).vercel.app`,
  `*.studiomakemusic.com`, plus `NOVA_BRIDGE_ALLOWED_ORIGINS`
  (virgules ; préfixe `re:` pour une expression régulière)
- Audio temps réel en trames binaires, traité dans l'ordre, une instance
  persistante par effet du DAW (id du plugin côté DAW = id du slot)
- Latence du plugin annoncée au DAW (compensée à la lecture)
- État du plugin (GET/SET_STATE, base64) enregistré dans le projet
- `RENDER` : rendu hors temps réel d'un buffer complet + queue (gel à la sauvegarde, export)
- Fenêtre native du plugin (`SHOW_EDITOR`) via pedalboard : l'hôte JUCE
  `nova-vst-host` n'est plus nécessaire, un seul exécutable suffit
- **v5 – instruments VST3** (mode instru du DAW) : `GET_PLUGIN_LIST` indique
  `is_instrument` ; `RENDER_INSTRUMENT` rend des notes en audio hors temps réel
  (avec le son réglé dans la fenêtre du plugin si le slot est chargé). Les
  plugins sans `moduleinfo.json` (Vital, Omnisphere, Kontakt…) sont lus une fois
  en arrière-plan par `vst_probe.py` (processus enfant `--probe-vst3`, plusieurs
  en parallèle, délai par plugin) ; résultat en cache dans
  `%LOCALAPPDATA%\NovaStudio\vst3_classes.json` (~3 min la 1re fois pour ~600
  plugins, instantané ensuite)
- **v6 – fenêtres de licence** (`license_watch.py`) : après chaque création
  d'instance (slot, rendu), les nouvelles fenêtres du pont et des programmes
  qu'il lance sont surveillées ~20 s ; une fenêtre d'activation / de licence est
  ramenée au premier plan et signalée au DAW (`LICENSE_WINDOW`), le chargement
  l'attend jusqu'à 15 min. Pendant la lecture en arrière-plan, une telle fenêtre
  est cachée aussitôt et le plugin noté « activation » (jamais relu tout seul ;
  « Chercher à nouveau » le relit). Les rendus hors slot réutilisent une
  instance par plugin (`OfflinePool`) : plus de fenêtre à chaque gel / export.
  Plugins qui rouvrent leur fenêtre à chaque lancement : notés « nag » dans
  `%LOCALAPPDATA%\NovaStudio\license_windows.json`.
  Test sans plugin protégé : `NOVA_BRIDGE_DEBUG=1` active `DEBUG_LICENSE_WINDOW`
  (fenêtre simulée) et `DEBUG_WINDOWS` (premier plan, fenêtres du pont)

Le protocole complet est décrit en tête de `nova_bridge_server.py`.

### v8 – séparation de stems (module optionnel)
Comme Stem Splitter (Logic) ou Stem Separation (FL Studio) : clic droit sur un clip
audio → « Séparer en stems… » → 2 stems (voix / instru) ou 4 (voix, batterie, basse,
autres), en nouvelles pistes calées sur le clip.

- **Rien dans l'installateur** : le module (~0,7 Go une fois installé) est téléchargé
  à la demande par `stems_install.py`, bouton « Installer la séparation de stems »
  dans NOVA, dans `%LOCALAPPDATA%\NovaStudio\stems\` (Python 3.12 via `uv`,
  PyTorch 2.8 CPU, Demucs 4.0.1, modèle `htdemucs`). Supprimer ce dossier le désinstalle.
  `--variant cuda` installe PyTorch CUDA 12.8 (bien plus gros, plus rapide si la
  carte NVIDIA est active ; repli CPU automatique sinon).
- `stems_service.py` (dans le pont) lance `stems_worker.py` avec le Python du module,
  caché (CREATE_NO_WINDOW), progression JSON, annulation (processus tué), erreurs claires.
- WAV écrits dans `Documents\Nova Studio\Stems\<projet>\<clip> <date>\`
  (`Original.wav`, `Voix.wav`, `Instru.wav` ou `Batterie.wav`, `Basse.wav`, `Autres.wav`).
- Tests : `venv\Scripts\python.exe -m unittest discover -s tests -p "test_stems*.py"`.
- Licences : Demucs (code et modèles pré-entraînés publiés avec) MIT, Meta Platforms ;
  PyTorch BSD-3 ; torchaudio BSD-2 ; uv MIT/Apache-2.0 ; python-build-standalone
  (Python PSF) ; soundfile BSD-3 / libsndfile LGPL-2.1 (bibliothèque dynamique) ;
  julius, openunmix, dora-search, einops MIT ; lameenc LGPL-3 (dépendance de Demucs pour
  le MP3, inutilisée par NOVA). Tout est téléchargé depuis PyPI / pytorch.org sur le PC
  de l'utilisateur : rien n'est redistribué dans l'installateur de Nova Studio.

**Pour l'artiste :** lancer `NovaVSTBridge.exe`, laisser la fenêtre ouverte,
puis dans Nova Studio (sur ordinateur) : onglet **VST** → « Connecter le pont VST ».

**Construire l'exécutable** (dans `bridge-python/`, avec le venv) :
```bash
venv\Scripts\python.exe -m pip install pyinstaller websockets numpy pedalboard
venv\Scripts\python.exe -m PyInstaller NovaVSTBridge.spec --noconfirm --workpath %TEMP%\nova-vst-build
# → dist\NovaVSTBridge.exe (~25 Mo, Python non requis)
# puis copier dist\NovaVSTBridge.exe dans ..\public\downloads\ (lien de téléchargement du DAW)
```
(`build.bat` / `build_exe.py` construisent le pont ASIO, pas celui-ci.)

**En développement :**
```bash
start_bridge.bat            # ou : python nova_bridge_server.py
```

Contraintes de pedalboard/JUCE prises en compte : un seul thread « message »
(le thread principal du pont) prépare, détruit et affiche les plugins ; le
traitement audio tourne dans un thread par slot avec `reset=False`. Une
fenêtre de plugin ouverte se ferme si un autre plugin doit être chargé ou
rendu pendant ce temps. Les plugins que pedalboard ne sait pas charger
(certaines protections iLok) renvoient une erreur claire au DAW.

### v11 – automation et side-chain des VST (R9, R10)

- **Automation** (`vst_automation.py`) : chaque bloc temps réel peut porter des
  réglages horodatés à l'échantillon près (drapeau PARAMS) ; le pont découpe le
  bloc aux décalages. `RENDER` accepte `automation` (mêmes changements pour
  l'export / le gel). `AUTOMATABLE`, `SET_AUTOMATION_MAP`, `PARAM_TEXTS`,
  `WATCH_PARAMS` → `PARAM_CHANGED` (gestes faits dans la fenêtre du plugin,
  écriture Touch / Latch), `AUTOMATION_STATS`. Les réglages sont lus / écrits par
  les poignées C++ de pedalboard (aucune conversion texte pendant le traitement).
- **Side-chain** (`vst_sidechain.py`) : trames à 4 canaux (drapeau SIDECHAIN) et
  `RENDER sidechain=true` ; `Slot.process_block(block, changes, key)` passe la clé
  à un hôte qui sait alimenter l'entrée side-chain. **pedalboard ne le peut pas**
  (il désactive les bus d'entrée auxiliaires) : `LOAD_PLUGIN` répond
  `sidechain_inputs: null` et NOVA affiche « clé routée, pas encore reçue ».
  Le contrat exact que l'hôte VST3 natif (SDK VST3 MIT) devra remplir est décrit
  en tête de `vst_sidechain.py` ; `nova:debug-ducker` (NOVA_BRIDGE_DEBUG=1) est un
  effet à clé de référence qui suit ce contrat, pour les tests.
- Tests : `venv\Scripts\python.exe -m unittest discover -s tests -p "test_vst_*.py"`.

### 2. ASIO Bridge (`asio_bridge.py`) ⭐ NOUVEAU
Bridge pour connecter le DAW web à une carte son ASIO.

- Port: **8766**
- Streaming audio bidirectionnel en temps réel
- Support ASIO pour une latence minimale (<10ms)
- Compatible avec toutes les cartes son ASIO (Focusrite, RME, MOTU, etc.)
- Fonctionne aussi avec ASIO4ALL (drivers ASIO génériques)

**Démarrage:**
```bash
# Windows
start_asio_bridge.bat

# Ou manuellement
python asio_bridge.py
```

## � Installation

### Prérequis
- Python 3.9 ou supérieur
- Windows 10/11 (pour ASIO)
- Drivers ASIO de votre carte son (ou ASIO4ALL)

### Installation des dépendances
```bash
pip install -r requirements.txt
```

## 🔧 Configuration ASIO

### Vérifier les périphériques ASIO
Lancez `start_asio_bridge.bat` et observez les messages pour voir les périphériques détectés.

### Paramètres disponibles
| Paramètre | Valeur par défaut | Description |
|-----------|-------------------|-------------|
| `device_name` | `null` (défaut) | Nom du périphérique ASIO |
| `sample_rate` | `44100` | Fréquence d'échantillonnage |
| `block_size` | `256` | Taille du buffer (latence) |
| `input_channels` | `2` | Nombre de canaux d'entrée |
| `output_channels` | `2` | Nombre de canaux de sortie |

### Latence typique
| Block Size | Latence approximative |
|------------|----------------------|
| 64 | ~1.5ms |
| 128 | ~3ms |
| 256 | ~6ms |
| 512 | ~12ms |
| 1024 | ~23ms |

## 🌐 API WebSocket (ASIO Bridge)

### Messages JSON

#### Récupérer les périphériques
```json
{ "action": "GET_DEVICES" }
```
Réponse:
```json
{
  "action": "DEVICES",
  "devices": [...],
  "asio_devices": [...]
}
```

#### Configurer le flux audio
```json
{
  "action": "SET_CONFIG",
  "device_name": "Focusrite USB ASIO",
  "sample_rate": 48000,
  "block_size": 256
}
```

#### Démarrer le streaming
```json
{ "action": "START_STREAM" }
```

#### Arrêter le streaming
```json
{ "action": "STOP_STREAM" }
```

#### Récupérer les statistiques
```json
{ "action": "GET_STATS" }
```

### Messages Binaires (Audio)

Format: `[4 bytes: num_samples][4 bytes: num_channels][audio_data: float32[]]`

## 💻 Utilisation côté DAW (TypeScript)

```typescript
import { getASIOBridge, ASIOBridgeClient } from './services/ASIOBridge';

// Récupérer l'instance du bridge
const bridge = getASIOBridge();

// Définir les handlers
bridge.setHandlers({
  onConnect: () => console.log('Connecté au bridge ASIO'),
  onDevices: (devices, asioDevices) => {
    console.log('Périphériques ASIO:', asioDevices);
  },
  onStreamStarted: (success, latency) => {
    console.log(`Stream démarré, latence: ${latency}ms`);
  },
  onAudioInput: (audioData, channels) => {
    // Traiter l'audio d'entrée (micro/instrument)
  }
});

// Se connecter
await bridge.connect();

// Configurer
bridge.setConfig({
  device_name: 'Focusrite USB ASIO',
  sample_rate: 48000,
  block_size: 256
});

// Démarrer le streaming
bridge.startStream();

// Envoyer de l'audio vers la carte son
bridge.sendAudio(audioFloat32Array, 2);
```

## � Dépannage

### "sounddevice non disponible"
```bash
pip install sounddevice
```

### "Aucun périphérique ASIO détecté"
1. Vérifiez que vos drivers ASIO sont installés
2. Installez [ASIO4ALL](https://www.asio4all.org/) si nécessaire
3. Fermez les autres applications qui utilisent l'audio

### Latence élevée
1. Réduisez la `block_size` (ex: 128 ou 64)
2. Utilisez des drivers ASIO natifs (pas ASIO4ALL)
3. Fermez les autres applications

### Buffer underruns/overruns
1. Augmentez la `block_size`
2. Vérifiez les performances CPU
3. Désactivez les économies d'énergie

## � Structure des fichiers

```
bridge-python/
├── asio_bridge.py          # Bridge ASIO principal
├── nova_bridge_server.py   # Pont VST3 (WebSocket, protocole)
├── vst_host.py             # Hôte VST3 : inventaire, instances, rendu, fenêtres
├── NovaVSTBridge.spec      # Recette PyInstaller du pont VST3
├── requirements.txt        # Dépendances Python
├── start_asio_bridge.bat   # Démarrer le bridge ASIO
├── start_bridge.bat        # Démarrer le bridge VST3
└── README.md               # Cette documentation
```

## � Roadmap

- [ ] Support macOS (Core Audio)
- [ ] Support Linux (JACK/PipeWire)
- [ ] Conversion en exécutable (.exe)
- [ ] Interface graphique de configuration
- [ ] Monitoring en temps réel

## 📝 Licence

MIT License - Nova Studio Team