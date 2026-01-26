#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════════════════════╗
║                    NOVA ASIO BRIDGE - Audio Interface Bridge                 ║
║                                                                              ║
║  Bridge Python pour connecter le DAW web à une carte son ASIO                ║
║  Streaming audio bidirectionnel en temps réel via WebSocket                  ║
║                                                                              ║
║  Auteur: Nova Studio Team                                                    ║
║  License: MIT                                                                ║
╚══════════════════════════════════════════════════════════════════════════════╝
"""

import asyncio
import json
import logging
import time
import threading
import struct
import base64
import sys
import os
from typing import Dict, Optional, Any, List, Callable
from dataclasses import dataclass, field
from collections import deque
import numpy as np

# Windows Registry pour détecter les drivers ASIO
try:
    import winreg
    WINREG_AVAILABLE = True
except ImportError:
    WINREG_AVAILABLE = False

# Audio backend - sounddevice supporte ASIO sur Windows
try:
    import sounddevice as sd
    SOUNDDEVICE_AVAILABLE = True
except ImportError:
    SOUNDDEVICE_AVAILABLE = False
    print("⚠️ sounddevice non installé. Installez-le avec: pip install sounddevice")

# PyAudio comme alternative (supporte ASIO si compilé avec)
try:
    import pyaudio
    PYAUDIO_AVAILABLE = True
except ImportError:
    PYAUDIO_AVAILABLE = False

# WebSocket
import websockets
from websockets.server import WebSocketServerProtocol

# Configuration du logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)s | %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger('NovaASIO')


@dataclass
class ASIOConfig:
    """Configuration ASIO"""
    device_name: Optional[str] = None  # None = périphérique par défaut
    sample_rate: int = 44100
    block_size: int = 256  # Taille du buffer ASIO (latence)
    input_channels: int = 2
    output_channels: int = 2
    bit_depth: int = 32  # 16, 24 ou 32 bits float
    use_asio: bool = True  # Utiliser ASIO si disponible


@dataclass
class AudioStreamState:
    """État du flux audio"""
    is_running: bool = False
    is_recording: bool = False
    is_playing: bool = False
    input_level: float = 0.0
    output_level: float = 0.0
    latency_ms: float = 0.0
    buffer_underruns: int = 0
    buffer_overruns: int = 0


class ASIODeviceManager:
    """
    Gestionnaire des périphériques audio ASIO
    
    Lit le registre Windows pour trouver les drivers ASIO installés
    """
    
    def __init__(self):
        self.devices: List[Dict[str, Any]] = []
        self.asio_drivers: List[Dict[str, Any]] = []
        self.current_device: Optional[str] = None
        self._scan_asio_registry()
        self._scan_sounddevice_devices()
    
    def _scan_asio_registry(self):
        """
        Scanner le registre Windows pour trouver les drivers ASIO
        
        Les drivers ASIO sont enregistrés dans:
        HKEY_LOCAL_MACHINE\SOFTWARE\ASIO
        """
        self.asio_drivers = []
        
        if not WINREG_AVAILABLE:
            logger.warning("winreg non disponible - impossible de lire le registre ASIO")
            return
        
        try:
            # Ouvrir la clé ASIO dans le registre
            # Essayer d'abord la clé 64-bit, puis 32-bit
            asio_key_paths = [
                (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\ASIO"),
                (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\ASIO"),
            ]
            
            for hkey, path in asio_key_paths:
                try:
                    asio_key = winreg.OpenKey(hkey, path, 0, winreg.KEY_READ)
                    
                    # Énumérer les sous-clés (chaque sous-clé = un driver ASIO)
                    i = 0
                    while True:
                        try:
                            driver_name = winreg.EnumKey(asio_key, i)
                            
                            # Ouvrir la sous-clé du driver
                            driver_key = winreg.OpenKey(asio_key, driver_name)
                            
                            # Lire les informations du driver
                            try:
                                clsid, _ = winreg.QueryValueEx(driver_key, "CLSID")
                            except:
                                clsid = None
                            
                            try:
                                description, _ = winreg.QueryValueEx(driver_key, "Description")
                            except:
                                description = driver_name
                            
                            driver_info = {
                                'id': i,
                                'name': driver_name,
                                'description': description or driver_name,
                                'clsid': clsid,
                                'is_asio': True,
                                'max_input_channels': 2,  # Par défaut, sera mis à jour
                                'max_output_channels': 2,
                                'default_sample_rate': 44100,
                                'hostapi': 'ASIO'
                            }
                            
                            # Éviter les doublons
                            if not any(d['name'] == driver_name for d in self.asio_drivers):
                                self.asio_drivers.append(driver_info)
                                logger.info(f"🎛️ ASIO Driver trouvé: {driver_name}")
                            
                            winreg.CloseKey(driver_key)
                            i += 1
                            
                        except OSError:
                            # Plus de sous-clés
                            break
                    
                    winreg.CloseKey(asio_key)
                    
                except FileNotFoundError:
                    # Cette clé n'existe pas
                    continue
                except PermissionError:
                    logger.warning(f"Permission refusée pour accéder à {path}")
                    continue
            
            logger.info(f"📊 {len(self.asio_drivers)} drivers ASIO trouvés dans le registre")
            
        except Exception as e:
            logger.error(f"Erreur lors de la lecture du registre ASIO: {e}")
    
    def _scan_sounddevice_devices(self):
        """Scanner les périphériques via sounddevice"""
        if not SOUNDDEVICE_AVAILABLE:
            logger.warning("sounddevice non disponible")
            return
        
        self.devices = []
        
        try:
            # Lister tous les périphériques
            devices = sd.query_devices()
            hostapis = sd.query_hostapis()
            
            # Trouver l'API ASIO si disponible
            asio_api_index = None
            for i, api in enumerate(hostapis):
                if 'ASIO' in api['name'].upper():
                    asio_api_index = i
                    logger.info(f"✅ API ASIO détectée dans sounddevice: {api['name']}")
                    break
            
            for i, device in enumerate(devices):
                is_asio = device['hostapi'] == asio_api_index if asio_api_index is not None else False
                
                device_info = {
                    'id': i,
                    'name': device['name'],
                    'max_input_channels': device['max_input_channels'],
                    'max_output_channels': device['max_output_channels'],
                    'default_sample_rate': device['default_samplerate'],
                    'hostapi': hostapis[device['hostapi']]['name'],
                    'is_asio': is_asio
                }
                self.devices.append(device_info)
                
                if is_asio:
                    logger.info(f"🎛️ ASIO Device (sounddevice): {device['name']}")
                    
                    # Mettre à jour les infos du driver ASIO correspondant
                    for asio_driver in self.asio_drivers:
                        if asio_driver['name'].lower() in device['name'].lower() or \
                           device['name'].lower() in asio_driver['name'].lower():
                            asio_driver['max_input_channels'] = device['max_input_channels']
                            asio_driver['max_output_channels'] = device['max_output_channels']
                            asio_driver['default_sample_rate'] = device['default_samplerate']
                            asio_driver['sounddevice_id'] = i
            
            logger.info(f"📊 {len(self.devices)} périphériques audio trouvés via sounddevice")
            
        except Exception as e:
            logger.error(f"Erreur lors du scan sounddevice: {e}")
    
    def _scan_pyaudio_devices(self):
        """Scanner les périphériques via PyAudio (alternative)"""
        if not PYAUDIO_AVAILABLE:
            return
        
        try:
            p = pyaudio.PyAudio()
            
            # Chercher l'API ASIO
            asio_host_index = None
            for i in range(p.get_host_api_count()):
                api_info = p.get_host_api_info_by_index(i)
                if 'ASIO' in api_info['name'].upper():
                    asio_host_index = i
                    logger.info(f"✅ API ASIO trouvée dans PyAudio: {api_info['name']}")
                    break
            
            if asio_host_index is not None:
                api_info = p.get_host_api_info_by_index(asio_host_index)
                for i in range(api_info['deviceCount']):
                    device_index = p.get_host_api_info_by_index(asio_host_index)['defaultInputDevice']
                    # ... récupérer les infos du device
            
            p.terminate()
            
        except Exception as e:
            logger.error(f"Erreur PyAudio: {e}")
    
    def get_devices(self) -> List[Dict[str, Any]]:
        """Récupérer la liste de tous les périphériques"""
        return self.devices
    
    def get_asio_devices(self) -> List[Dict[str, Any]]:
        """
        Récupérer uniquement les périphériques ASIO
        
        Combine les drivers du registre et ceux détectés par sounddevice
        """
        # Commencer par les drivers ASIO du registre
        asio_devices = list(self.asio_drivers)
        
        # Ajouter les devices ASIO détectés par sounddevice qui ne sont pas déjà dans la liste
        for device in self.devices:
            if device.get('is_asio'):
                # Vérifier si ce device n'est pas déjà dans la liste
                device_name_lower = device['name'].lower()
                already_exists = False
                
                for asio in asio_devices:
                    if asio['name'].lower() in device_name_lower or \
                       device_name_lower in asio['name'].lower():
                        already_exists = True
                        break
                
                if not already_exists:
                    asio_devices.append(device)
        
        return asio_devices
    
    def get_device_by_name(self, name: str) -> Optional[Dict[str, Any]]:
        """Trouver un périphérique par son nom"""
        # Chercher d'abord dans les ASIO drivers
        for driver in self.asio_drivers:
            if name.lower() in driver['name'].lower() or driver['name'].lower() in name.lower():
                return driver
        
        # Puis dans tous les devices
        for device in self.devices:
            if name.lower() in device['name'].lower():
                return device
        return None
    
    def get_default_device(self) -> Optional[Dict[str, Any]]:
        """Récupérer le périphérique par défaut"""
        if not SOUNDDEVICE_AVAILABLE:
            return None
            
        try:
            default_input = sd.query_devices(kind='input')
            default_output = sd.query_devices(kind='output')
            return {
                'input': default_input,
                'output': default_output
            }
        except Exception as e:
            logger.error(f"Error getting default device: {e}")
            return None
    
    def rescan(self):
        """Rescanner tous les périphériques"""
        logger.info("🔄 Rescanning audio devices...")
        self._scan_asio_registry()
        self._scan_sounddevice_devices()


class ASIOAudioStream:
    """
    Flux audio ASIO bidirectionnel
    
    Gère l'entrée et la sortie audio en temps réel avec ASIO
    """
    
    def __init__(self, config: ASIOConfig, on_input_callback: Optional[Callable] = None):
        self.config = config
        self.on_input_callback = on_input_callback
        
        # État
        self.state = AudioStreamState()
        self.stream: Optional[sd.Stream] = None
        
        # Buffers circulaires pour l'audio
        self.input_buffer: deque = deque(maxlen=100)  # ~100 blocs d'entrée
        self.output_buffer: deque = deque(maxlen=100)  # ~100 blocs de sortie
        
        # Verrous pour thread-safety
        self._lock = threading.Lock()
        
        # Statistiques
        self.stats = {
            'blocks_in': 0,
            'blocks_out': 0,
            'total_samples': 0,
            'start_time': 0
        }
    
    def _audio_callback(self, indata: np.ndarray, outdata: np.ndarray, 
                        frames: int, time_info: Any, status: sd.CallbackFlags):
        """
        Callback audio ASIO
        
        Appelé par sounddevice pour chaque bloc audio
        """
        if status:
            if status.input_overflow:
                self.state.buffer_overruns += 1
                logger.warning("Input overflow!")
            if status.output_underflow:
                self.state.buffer_underruns += 1
                logger.warning("Output underflow!")
        
        # Calculer le niveau d'entrée
        if indata is not None:
            self.state.input_level = float(np.max(np.abs(indata)))
            
            # Stocker l'entrée dans le buffer
            with self._lock:
                self.input_buffer.append(indata.copy())
                self.stats['blocks_in'] += 1
            
            # Callback pour envoyer au DAW web
            if self.on_input_callback:
                try:
                    self.on_input_callback(indata.copy())
                except Exception as e:
                    logger.error(f"Input callback error: {e}")
        
        # Récupérer l'audio de sortie du buffer
        with self._lock:
            if len(self.output_buffer) > 0:
                output_data = self.output_buffer.popleft()
                # S'assurer que les dimensions correspondent
                if output_data.shape == outdata.shape:
                    outdata[:] = output_data
                else:
                    # Ajuster si nécessaire
                    outdata[:] = np.zeros_like(outdata)
                    min_frames = min(output_data.shape[0], outdata.shape[0])
                    min_channels = min(output_data.shape[1] if len(output_data.shape) > 1 else 1,
                                      outdata.shape[1] if len(outdata.shape) > 1 else 1)
                    outdata[:min_frames, :min_channels] = output_data[:min_frames, :min_channels]
                self.stats['blocks_out'] += 1
            else:
                # Silence si pas de données
                outdata.fill(0)
        
        # Calculer le niveau de sortie
        self.state.output_level = float(np.max(np.abs(outdata)))
        self.stats['total_samples'] += frames
    
    def start(self) -> bool:
        """Démarrer le flux audio"""
        if self.state.is_running:
            logger.warning("Stream already running")
            return True
        
        if not SOUNDDEVICE_AVAILABLE:
            logger.error("sounddevice not available")
            return False
        
        try:
            # Configurer le périphérique
            device = None
            if self.config.device_name:
                device_manager = ASIODeviceManager()
                device_info = device_manager.get_device_by_name(self.config.device_name)
                if device_info:
                    # Utiliser l'ID sounddevice si disponible
                    device = device_info.get('sounddevice_id', device_info.get('id'))
            
            # Créer le flux audio
            self.stream = sd.Stream(
                device=device,
                samplerate=self.config.sample_rate,
                blocksize=self.config.block_size,
                dtype=np.float32,
                channels=(self.config.input_channels, self.config.output_channels),
                callback=self._audio_callback,
                latency='low'  # Demander la latence la plus basse possible
            )
            
            # Démarrer
            self.stream.start()
            self.state.is_running = True
            self.stats['start_time'] = time.time()
            
            # Calculer la latence
            if self.stream.latency:
                input_latency = self.stream.latency[0] * 1000 if self.stream.latency[0] else 0
                output_latency = self.stream.latency[1] * 1000 if self.stream.latency[1] else 0
                self.state.latency_ms = input_latency + output_latency
            
            logger.info(f"✅ Audio stream started: {self.config.sample_rate}Hz, "
                       f"buffer: {self.config.block_size}, latency: {self.state.latency_ms:.1f}ms")
            
            return True
            
        except Exception as e:
            logger.error(f"Failed to start stream: {e}")
            return False
    
    def stop(self):
        """Arrêter le flux audio"""
        if self.stream:
            try:
                self.stream.stop()
                self.stream.close()
            except Exception as e:
                logger.error(f"Error stopping stream: {e}")
            
            self.stream = None
        
        self.state.is_running = False
        logger.info("🛑 Audio stream stopped")
    
    def write_output(self, audio_data: np.ndarray):
        """
        Écrire des données audio vers la sortie
        
        Args:
            audio_data: Array numpy avec les échantillons audio
        """
        with self._lock:
            self.output_buffer.append(audio_data)
    
    def read_input(self) -> Optional[np.ndarray]:
        """
        Lire les dernières données d'entrée
        
        Returns:
            Array numpy avec les échantillons audio ou None
        """
        with self._lock:
            if len(self.input_buffer) > 0:
                return self.input_buffer.popleft()
        return None
    
    def get_stats(self) -> Dict[str, Any]:
        """Récupérer les statistiques"""
        elapsed = time.time() - self.stats['start_time'] if self.stats['start_time'] > 0 else 0
        
        return {
            'is_running': self.state.is_running,
            'sample_rate': self.config.sample_rate,
            'block_size': self.config.block_size,
            'latency_ms': self.state.latency_ms,
            'input_level': self.state.input_level,
            'output_level': self.state.output_level,
            'buffer_underruns': self.state.buffer_underruns,
            'buffer_overruns': self.state.buffer_overruns,
            'blocks_processed': self.stats['blocks_in'],
            'elapsed_seconds': elapsed,
            'input_buffer_size': len(self.input_buffer),
            'output_buffer_size': len(self.output_buffer)
        }


class ASIOBridgeServer:
    """
    Serveur WebSocket pour le bridge ASIO
    
    Permet au DAW web de:
    - Envoyer de l'audio vers la carte son ASIO
    - Recevoir l'audio d'entrée de la carte son
    - Configurer les paramètres ASIO
    """
    
    def __init__(self, host: str = "127.0.0.1", port: int = 8766):
        self.host = host
        self.port = port
        
        # Gestionnaire de périphériques
        self.device_manager = ASIODeviceManager()
        
        # Configuration par défaut
        self.config = ASIOConfig()
        
        # Flux audio
        self.audio_stream: Optional[ASIOAudioStream] = None
        
        # Clients connectés
        self.clients: Dict[str, WebSocketServerProtocol] = {}
        self._client_lock = asyncio.Lock()
        
        # État
        self.running = False
        
        # Tâche d'envoi audio
        self._audio_send_task: Optional[asyncio.Task] = None
    
    async def start(self):
        """Démarrer le serveur"""
        logger.info("=" * 60)
        logger.info("  NOVA ASIO BRIDGE SERVER v1.1")
        logger.info("=" * 60)
        
        # Afficher les drivers ASIO détectés
        asio_devices = self.device_manager.get_asio_devices()
        logger.info(f"🎛️ {len(asio_devices)} ASIO drivers détectés:")
        for i, driver in enumerate(asio_devices):
            logger.info(f"   [{i}] {driver['name']}")
        
        self.running = True
        
        # Démarrer le serveur WebSocket
        async with websockets.serve(
            self._handle_connection,
            self.host,
            self.port,
            ping_interval=30,
            ping_timeout=10,
            max_size=10 * 1024 * 1024  # 10MB max
        ):
            logger.info(f"✅ ASIO Bridge listening on ws://{self.host}:{self.port}")
            logger.info("=" * 60)
            
            # Maintenir actif
            await asyncio.Future()
    
    async def _handle_connection(self, websocket: WebSocketServerProtocol):
        """Gérer une nouvelle connexion"""
        client_id = f"client_{int(time.time() * 1000)}"
        
        async with self._client_lock:
            self.clients[client_id] = websocket
        
        logger.info(f"🔗 New connection: {client_id}")
        
        try:
            async for message in websocket:
                try:
                    # Essayer de parser comme JSON
                    if isinstance(message, str):
                        data = json.loads(message)
                        await self._handle_message(client_id, data)
                    else:
                        # Message binaire = audio
                        await self._handle_binary(client_id, message)
                except json.JSONDecodeError:
                    logger.warning(f"Invalid JSON from {client_id}")
                except Exception as e:
                    logger.error(f"Error handling message: {e}")
        finally:
            async with self._client_lock:
                if client_id in self.clients:
                    del self.clients[client_id]
            logger.info(f"🔌 Disconnected: {client_id}")
    
    async def _handle_message(self, client_id: str, data: dict):
        """Router les messages"""
        action = data.get("action", "")
        
        handlers = {
            "PING": self._handle_ping,
            "GET_DEVICES": self._handle_get_devices,
            "SET_CONFIG": self._handle_set_config,
            "GET_CONFIG": self._handle_get_config,
            "START_STREAM": self._handle_start_stream,
            "STOP_STREAM": self._handle_stop_stream,
            "GET_STATS": self._handle_get_stats,
            "AUDIO_DATA": self._handle_audio_data,
            "RESCAN_DEVICES": self._handle_rescan_devices,
            "OPEN_CONTROL_PANEL": self._handle_open_control_panel,
        }
        
        handler = handlers.get(action)
        if handler:
            await handler(client_id, data)
        else:
            logger.warning(f"Unknown action: {action}")
    
    async def _handle_binary(self, client_id: str, data: bytes):
        """
        Gérer les données audio binaires
        
        Format: 4 bytes (num_samples int32) + audio data (float32)
        """
        if self.audio_stream and self.audio_stream.state.is_running:
            try:
                # Décoder l'en-tête
                num_samples = struct.unpack('<I', data[:4])[0]
                num_channels = struct.unpack('<I', data[4:8])[0]
                
                # Décoder les données audio
                audio_bytes = data[8:]
                audio_data = np.frombuffer(audio_bytes, dtype=np.float32)
                audio_data = audio_data.reshape((num_samples, num_channels))
                
                # Écrire vers la sortie
                self.audio_stream.write_output(audio_data)
                
            except Exception as e:
                logger.error(f"Error processing binary audio: {e}")
    
    async def _send(self, client_id: str, data: dict):
        """Envoyer un message à un client"""
        if client_id in self.clients:
            try:
                await self.clients[client_id].send(json.dumps(data))
            except Exception as e:
                logger.error(f"Send error: {e}")
    
    async def _send_binary(self, client_id: str, audio_data: np.ndarray):
        """Envoyer des données audio binaires"""
        if client_id in self.clients:
            try:
                # Encoder: 4 bytes (samples) + 4 bytes (channels) + data
                num_samples, num_channels = audio_data.shape
                header = struct.pack('<II', num_samples, num_channels)
                audio_bytes = audio_data.astype(np.float32).tobytes()
                
                await self.clients[client_id].send(header + audio_bytes)
            except Exception as e:
                logger.error(f"Send binary error: {e}")
    
    async def _broadcast_audio(self):
        """Diffuser l'audio d'entrée à tous les clients"""
        while self.running and self.audio_stream and self.audio_stream.state.is_running:
            try:
                # Lire l'audio d'entrée
                input_data = self.audio_stream.read_input()
                
                if input_data is not None:
                    # Envoyer à tous les clients
                    async with self._client_lock:
                        for client_id in list(self.clients.keys()):
                            await self._send_binary(client_id, input_data)
                else:
                    # Pas de données, attendre un peu
                    await asyncio.sleep(0.001)
                    
            except Exception as e:
                logger.error(f"Broadcast audio error: {e}")
                await asyncio.sleep(0.01)
    
    # ─────────────────────────────────────────────────────────────
    # HANDLERS
    # ─────────────────────────────────────────────────────────────
    
    async def _handle_ping(self, client_id: str, data: dict):
        """Répondre au ping"""
        await self._send(client_id, {
            "action": "PONG",
            "timestamp": time.time()
        })
    
    async def _handle_get_devices(self, client_id: str, data: dict):
        """Envoyer la liste des périphériques"""
        await self._send(client_id, {
            "action": "DEVICES",
            "devices": self.device_manager.get_devices(),
            "asio_devices": self.device_manager.get_asio_devices()
        })
    
    async def _handle_rescan_devices(self, client_id: str, data: dict):
        """Rescanner les périphériques"""
        self.device_manager.rescan()
        
        await self._send(client_id, {
            "action": "DEVICES",
            "devices": self.device_manager.get_devices(),
            "asio_devices": self.device_manager.get_asio_devices()
        })
    
    async def _handle_open_control_panel(self, client_id: str, data: dict):
        """
        Ouvrir le panneau de configuration du driver ASIO
        
        Utilise l'API ASIO native via COM pour ouvrir le panneau de configuration
        du driver sélectionné.
        """
        device_name = self.config.device_name or ""
        logger.info(f"🎛️ Ouverture du panneau de contrôle ASIO: {device_name}")
        
        success = False
        error_msg = ""
        
        try:
            # Méthode 1: Utiliser l'API ASIO via ctypes pour appeler ASIOControlPanel()
            if WINREG_AVAILABLE and device_name:
                clsid = None
                dll_path = None
                
                # Chercher le CLSID du driver dans le registre
                for reg_path in [r"SOFTWARE\ASIO", r"SOFTWARE\WOW6432Node\ASIO"]:
                    try:
                        asio_key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, reg_path, 0, winreg.KEY_READ)
                        try:
                            driver_key = winreg.OpenKey(asio_key, device_name)
                            clsid, _ = winreg.QueryValueEx(driver_key, "CLSID")
                            winreg.CloseKey(driver_key)
                            logger.info(f"   CLSID trouvé: {clsid}")
                        except:
                            pass
                        winreg.CloseKey(asio_key)
                        if clsid:
                            break
                    except:
                        continue
                
                # Trouver la DLL du driver
                if clsid:
                    for com_path in [f"SOFTWARE\\Classes\\CLSID\\{clsid}\\InprocServer32",
                                    f"SOFTWARE\\WOW6432Node\\Classes\\CLSID\\{clsid}\\InprocServer32"]:
                        try:
                            com_key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, com_path, 0, winreg.KEY_READ)
                            dll_path, _ = winreg.QueryValueEx(com_key, "")
                            winreg.CloseKey(com_key)
                            if dll_path and os.path.exists(dll_path):
                                logger.info(f"   DLL ASIO: {dll_path}")
                                break
                            dll_path = None
                        except:
                            continue
                
                # Méthode COM: Charger le driver ASIO et appeler ASIOControlPanel
                if clsid:
                    try:
                        import ctypes
                        from ctypes import wintypes
                        
                        # Initialiser COM
                        ole32 = ctypes.windll.ole32
                        ole32.CoInitialize(None)
                        
                        # Convertir CLSID string en structure
                        class GUID(ctypes.Structure):
                            _fields_ = [
                                ("Data1", wintypes.DWORD),
                                ("Data2", wintypes.WORD),
                                ("Data3", wintypes.WORD),
                                ("Data4", wintypes.BYTE * 8)
                            ]
                        
                        # Parser le CLSID
                        clsid_clean = clsid.strip('{}')
                        parts = clsid_clean.split('-')
                        guid = GUID()
                        guid.Data1 = int(parts[0], 16)
                        guid.Data2 = int(parts[1], 16)
                        guid.Data3 = int(parts[2], 16)
                        data4_hex = parts[3] + parts[4]
                        for i in range(8):
                            guid.Data4[i] = int(data4_hex[i*2:i*2+2], 16)
                        
                        # IID_IUnknown
                        IID_NULL = GUID()
                        
                        # Créer l'instance COM du driver ASIO
                        p_driver = ctypes.c_void_p()
                        hr = ole32.CoCreateInstance(
                            ctypes.byref(guid),
                            None,
                            1,  # CLSCTX_INPROC_SERVER
                            ctypes.byref(IID_NULL),
                            ctypes.byref(p_driver)
                        )
                        
                        if hr == 0 and p_driver:
                            # L'interface IASIO a controlPanel() à l'offset 52 (13 * 4 bytes pour x86)
                            # ou offset 104 (13 * 8 bytes pour x64)
                            # Méthode simplifiée: appeler via vtable
                            
                            vtable = ctypes.cast(p_driver, ctypes.POINTER(ctypes.c_void_p))[0]
                            vtable_ptr = ctypes.cast(vtable, ctypes.POINTER(ctypes.c_void_p))
                            
                            # Index 13 = controlPanel dans l'interface IASIO
                            # Note: Les indices peuvent varier selon le SDK ASIO
                            import sys
                            ptr_size = 8 if sys.maxsize > 2**32 else 4
                            control_panel_func = ctypes.cast(
                                vtable_ptr[13],
                                ctypes.CFUNCTYPE(ctypes.c_long, ctypes.c_void_p)
                            )
                            
                            # Appeler controlPanel()
                            result = control_panel_func(p_driver)
                            
                            if result == 0:  # ASE_OK
                                success = True
                                logger.info(f"   ✅ Panneau ASIO ouvert via COM")
                            else:
                                logger.warning(f"   ASIOControlPanel retourné: {result}")
                            
                            # Release l'interface
                            release_func = ctypes.cast(
                                vtable_ptr[2],  # Release est à l'index 2
                                ctypes.CFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)
                            )
                            release_func(p_driver)
                        else:
                            logger.warning(f"   CoCreateInstance échoué: {hr}")
                        
                        ole32.CoUninitialize()
                        
                    except Exception as e:
                        logger.warning(f"   Méthode COM échouée: {e}")
            
            # Méthode 2 de secours: Ouvrir des applications connues
            if not success:
                import subprocess
                
                # Liste des applications à ouvrir selon le driver
                known_apps = {
                    "FL Studio ASIO": [
                        r"C:\Program Files\Image-Line\FL Studio 21\FL64.exe",
                        r"C:\Program Files\Image-Line\FL Studio 20\FL64.exe",
                        r"C:\Program Files (x86)\Image-Line\FL Studio 21\FL.exe",
                    ],
                    "ASIO4ALL": [
                        r"C:\Program Files (x86)\ASIO4ALL v2\ASIO4ALL v2 Control Panel.exe",
                        r"C:\Program Files\ASIO4ALL v2\ASIO4ALL v2 Control Panel.exe",
                    ],
                    "Focusrite": [
                        r"C:\Program Files\Focusrite\Focusrite Control 2\Focusrite Control 2.exe",
                        r"C:\Program Files\Focusrite\Focusrite Control\Focusrite Control.exe",
                    ],
                    "Steinberg": [
                        r"C:\Program Files\Steinberg\Cubase 12\Cubase12.exe",
                    ],
                    "RME": [
                        r"C:\Program Files\RME\Fireface USB Settings\ffusbsettings.exe",
                    ],
                    "SSL": [
                        r"C:\Program Files\SSL\SSL USB Audio Control Panel\SSL USB Audio Control Panel.exe",
                    ],
                }
                
                for pattern, paths in known_apps.items():
                    if pattern.lower() in device_name.lower():
                        for app_path in paths:
                            if os.path.exists(app_path):
                                subprocess.Popen([app_path])
                                success = True
                                logger.info(f"   ✅ Application lancée: {app_path}")
                                break
                    if success:
                        break
            
            # Méthode 3: Ouvrir le panneau de son Windows comme fallback
            if not success:
                import subprocess
                # Ouvrir les paramètres de son Windows
                subprocess.Popen(['control', 'mmsys.cpl', 'sounds'])
                success = True
                error_msg = "Panneau ASIO natif non disponible. Panneau de son Windows ouvert à la place."
                logger.info(f"   ✅ Panneau de son Windows ouvert (fallback)")
            
        except Exception as e:
            error_msg = str(e)
            logger.error(f"   ❌ Erreur: {e}")
            import traceback
            traceback.print_exc()
        
        await self._send(client_id, {
            "action": "CONTROL_PANEL_RESULT",
            "success": success,
            "device": device_name,
            "error": error_msg if error_msg else None
        })
    
    async def _handle_set_config(self, client_id: str, data: dict):
        """Configurer le flux audio"""
        try:
            if "device_name" in data:
                self.config.device_name = data["device_name"]
            if "sample_rate" in data:
                self.config.sample_rate = int(data["sample_rate"])
            if "block_size" in data:
                self.config.block_size = int(data["block_size"])
            if "input_channels" in data:
                self.config.input_channels = int(data["input_channels"])
            if "output_channels" in data:
                self.config.output_channels = int(data["output_channels"])
            
            await self._send(client_id, {
                "action": "CONFIG_SET",
                "success": True,
                "config": {
                    "device_name": self.config.device_name,
                    "sample_rate": self.config.sample_rate,
                    "block_size": self.config.block_size,
                    "input_channels": self.config.input_channels,
                    "output_channels": self.config.output_channels
                }
            })
            
        except Exception as e:
            await self._send(client_id, {
                "action": "CONFIG_SET",
                "success": False,
                "error": str(e)
            })
    
    async def _handle_get_config(self, client_id: str, data: dict):
        """Récupérer la configuration actuelle"""
        await self._send(client_id, {
            "action": "CONFIG",
            "config": {
                "device_name": self.config.device_name,
                "sample_rate": self.config.sample_rate,
                "block_size": self.config.block_size,
                "input_channels": self.config.input_channels,
                "output_channels": self.config.output_channels
            }
        })
    
    async def _handle_start_stream(self, client_id: str, data: dict):
        """Démarrer le flux audio"""
        # Arrêter le flux existant si actif
        if self.audio_stream and self.audio_stream.state.is_running:
            self.audio_stream.stop()
        
        # Créer un nouveau flux
        self.audio_stream = ASIOAudioStream(self.config)
        
        if self.audio_stream.start():
            # Démarrer la diffusion audio
            self._audio_send_task = asyncio.create_task(self._broadcast_audio())
            
            await self._send(client_id, {
                "action": "STREAM_STARTED",
                "success": True,
                "latency_ms": self.audio_stream.state.latency_ms
            })
        else:
            await self._send(client_id, {
                "action": "STREAM_STARTED",
                "success": False,
                "error": "Failed to start audio stream"
            })
    
    async def _handle_stop_stream(self, client_id: str, data: dict):
        """Arrêter le flux audio"""
        if self._audio_send_task:
            self._audio_send_task.cancel()
            self._audio_send_task = None
        
        if self.audio_stream:
            self.audio_stream.stop()
        
        await self._send(client_id, {
            "action": "STREAM_STOPPED",
            "success": True
        })
    
    async def _handle_get_stats(self, client_id: str, data: dict):
        """Récupérer les statistiques"""
        stats = {}
        if self.audio_stream:
            stats = self.audio_stream.get_stats()
        
        await self._send(client_id, {
            "action": "STATS",
            "stats": stats
        })
    
    async def _handle_audio_data(self, client_id: str, data: dict):
        """
        Recevoir des données audio en JSON (base64)
        
        Alternative au format binaire pour les navigateurs
        """
        if self.audio_stream and self.audio_stream.state.is_running:
            try:
                # Décoder depuis base64
                audio_base64 = data.get("audio", "")
                channels = data.get("channels", 2)
                samples = data.get("samples", self.config.block_size)
                
                audio_bytes = base64.b64decode(audio_base64)
                audio_data = np.frombuffer(audio_bytes, dtype=np.float32)
                audio_data = audio_data.reshape((samples, channels))
                
                # Écrire vers la sortie
                self.audio_stream.write_output(audio_data)
                
            except Exception as e:
                logger.error(f"Error processing audio data: {e}")
    
    def stop(self):
        """Arrêter le serveur"""
        self.running = False
        
        if self._audio_send_task:
            self._audio_send_task.cancel()
        
        if self.audio_stream:
            self.audio_stream.stop()
        
        logger.info("🛑 ASIO Bridge stopped")


# ─────────────────────────────────────────────────────────────────
# POINT D'ENTRÉE
# ─────────────────────────────────────────────────────────────────

async def main():
    """Point d'entrée principal"""
    server = ASIOBridgeServer(host="127.0.0.1", port=8766)
    try:
        await server.start()
    except KeyboardInterrupt:
        server.stop()


if __name__ == "__main__":
    asyncio.run(main())