# Nova Bridge Python

Bridge Python pour connecter le DAW Nova Studio (web) aux ressources natives du PC.

## 🎛️ Modules Disponibles

### 1. Nova Bridge VST3 (`nova_bridge_server.py`)
Serveur WebSocket pour le streaming de plugins VST3 natifs.

- Port: **8765**
- Permet de charger et utiliser des plugins VST3 installés sur le PC
- Streaming audio bidirectionnel
- Support de 100+ instances simultanées

**Démarrage:**
```bash
# Windows
start_bridge.bat

# Ou manuellement
python nova_bridge_server.py
```

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
├── nova_bridge_server.py   # Bridge VST3
├── audio_processor.py      # Traitement audio multi-instances
├── vst3_manager.py         # Gestionnaire de plugins VST3
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