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
from typing import Dict, Optional, Any, List, Callable
from dataclasses import dataclass, field
from collections import deque
import numpy as np

# Audio backend - sounddevice supporte ASIO sur Windows
try:
    import sounddevice as sd
    SOUNDDEVICE_AVAILABLE = True
except ImportError:
    SOUNDDEVICE_AVAILABLE = False
    print("⚠️ sounddevice non installé. Installez-le avec: pip install sounddevice")

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
    """
    
    def __init__(self):
        self.devices: List[Dict[str, Any]] = []
        self.current_device: Optional[str] = None
        self._scan_devices()
    
    def _scan_devices(self):
        """Scanner les périphériques audio disponibles"""
        if not SOUNDDEVICE_AVAILABLE:
            logger.error("sounddevice non disponible")
            return
        
        self.devices = []
        
        try:
            # Lister tous les périphériques
            devices = sd.query_devices()
            hostapis = sd.query_hostapis()
            
            # Trouver l'API ASIO
            asio_api_index = None
            for i, api in enumerate(hostapis):
                if 'ASIO' in api['name']:
                    asio_api_index = i
                    break
            
            for i, device in enumerate(devices):
                device_info = {
                    'id': i,
                    'name': device['name'],
                    'max_input_channels': device['max_input_channels'],
                    'max_output_channels': device['max_output_channels'],
                    'default_sample_rate': device['default_samplerate'],
                    'hostapi': hostapis[device['hostapi']]['name'],
                    'is_asio': device['hostapi'] == asio_api_index if asio_api_index is not None else False
                }
                self.devices.append(device_info)
                
                if device_info['is_asio']:
                    logger.info(f"🎛️ ASIO Device found: {device['name']}")
            
            logger.info(f"📊 Found {len(self.devices)} audio devices")
            
        except Exception as e:
            logger.error(f"Error scanning devices: {e}")
    
    def get_devices(self) -> List[Dict[str, Any]]:
        """Récupérer la liste des périphériques"""
        return self.devices
    
    def get_asio_devices(self) -> List[Dict[str, Any]]:
        """Récupérer uniquement les périphériques ASIO"""
        return [d for d in self.devices if d['is_asio']]
    
    def get_device_by_name(self, name: str) -> Optional[Dict[str, Any]]:
        """Trouver un périphérique par son nom"""
        for device in self.devices:
            if name.lower() in device['name'].lower():
                return device
        return None
    
    def get_default_device(self) -> Optional[Dict[str, Any]]:
        """Récupérer le périphérique par défaut"""
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
                    device = device_info['id']
            
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
        logger.info("  NOVA ASIO BRIDGE SERVER v1.0")
        logger.info("=" * 60)
        
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
            logger.info(f"🎛️ {len(self.device_manager.get_asio_devices())} ASIO devices available")
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
        self.device_manager._scan_devices()  # Rescanner
        
        await self._send(client_id, {
            "action": "DEVICES",
            "devices": self.device_manager.get_devices(),
            "asio_devices": self.device_manager.get_asio_devices()
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