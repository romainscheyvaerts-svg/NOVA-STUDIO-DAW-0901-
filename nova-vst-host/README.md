# Nova VST Host

Hôte VST3 natif pour Nova Studio DAW - Supporte TOUS les plugins VST3 y compris ceux avec protection iLok, Waves, etc.

## 🎯 Fonctionnalités

- ✅ Charge tous les plugins VST3 (y compris iLok, Waves, SSL, FabFilter, etc.)
- ✅ Capture et streaming de l'interface graphique (30 FPS)
- ✅ Traitement audio en temps réel
- ✅ Support multi-instances (100+ plugins simultanés)
- ✅ Communication WebSocket avec le DAW web

## 📋 Prérequis

### 1. Visual Studio 2022
- Téléchargez : https://visualstudio.microsoft.com/fr/downloads/
- Lors de l'installation, cochez **"Développement Desktop en C++"**

### 2. CMake
- Téléchargez : https://cmake.org/download/
- Cochez "Add CMake to PATH" pendant l'installation

### 3. JUCE Framework
```bash
cd nova-vst-host
git clone https://github.com/juce-framework/JUCE.git
```

## 🔧 Compilation

### Option A : Via CMake (recommandé)

```bash
cd nova-vst-host

# Créer le dossier de build
mkdir build
cd build

# Configurer avec CMake
cmake .. -G "Visual Studio 17 2022" -A x64

# Compiler
cmake --build . --config Release
```

L'exécutable sera dans `build/NovaVSTHost_artefacts/Release/NovaVSTHost.exe`

### Option B : Via Visual Studio

1. Ouvrez Visual Studio 2022
2. Fichier > Ouvrir > Dossier CMake...
3. Sélectionnez le dossier `nova-vst-host`
4. Attendez que CMake configure le projet
5. Générer > Générer tout (Ctrl+Shift+B)

## 🚀 Utilisation

### 1. Lancer le Nova VST Host

Double-cliquez sur `NovaVSTHost.exe`

L'application démarre en arrière-plan et écoute sur `ws://localhost:8765`

### 2. Le DAW web se connecte automatiquement

Ouvrez Nova Studio DAW (http://localhost:3000) et les plugins VST3 seront disponibles dans le panneau "Bridge".

### 3. L'application peut être réduite

L'hôte peut fonctionner minimisé dans la barre des tâches. Il scanne automatiquement vos plugins VST3 au démarrage.

## 📁 Dossiers VST3 scannés

### Windows
- `C:\Program Files\Common Files\VST3`
- `C:\Program Files (x86)\Common Files\VST3`
- `%APPDATA%\VST3`

### macOS
- `/Library/Audio/Plug-Ins/VST3`
- `~/Library/Audio/Plug-Ins/VST3`

## 🔌 Communication WebSocket

Le serveur écoute sur le port **8765** et accepte les messages JSON :

```json
// Obtenir la liste des plugins
{ "action": "GET_PLUGIN_LIST" }

// Charger un plugin
{ "action": "LOAD_PLUGIN", "path": "C:\\...\\Plugin.vst3", "slot_id": "track1_fx0", "sample_rate": 44100 }

// Décharger un plugin
{ "action": "UNLOAD_PLUGIN", "slot_id": "track1_fx0" }

// Traiter l'audio
{ "action": "PROCESS_AUDIO", "channels": [[...], [...]], "sampleRate": 44100, "slot_id": "track1_fx0" }

// Modifier un paramètre
{ "action": "SET_PARAM", "name": "Gain", "value": 0.5, "slot_id": "track1_fx0" }

// Interaction souris
{ "action": "CLICK", "x": 100, "y": 200, "slot_id": "track1_fx0" }
{ "action": "DRAG", "x1": 100, "y1": 200, "x2": 150, "y2": 250, "slot_id": "track1_fx0" }
{ "action": "SCROLL", "x": 100, "y": 200, "delta": 1, "slot_id": "track1_fx0" }
```

## 🛠️ Dépannage

### L'application ne démarre pas
- Vérifiez que Visual C++ Redistributable 2022 est installé
- Lancez en tant qu'administrateur

### Les plugins ne sont pas détectés
- Vérifiez que vos plugins sont dans les dossiers standards
- Certains plugins peuvent nécessiter leur licence activée (iLok, etc.)

### Le DAW ne se connecte pas
- Vérifiez que le port 8765 n'est pas utilisé par une autre application
- Désactivez temporairement le pare-feu Windows

## 📄 Licence

MIT License - Nova Studio Team
