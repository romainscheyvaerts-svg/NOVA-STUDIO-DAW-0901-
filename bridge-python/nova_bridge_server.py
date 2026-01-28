#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════════════════════╗
║                    NOVA BRIDGE VST3 SERVER v3.0                              ║
║                                                                              ║
║  Serveur WebSocket haute performance pour le streaming VST3                  ║
║  Supporte 100+ instances de plugins simultanées                              ║
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
from typing import Dict, Optional, Any, List, Set
from dataclasses import dataclass, field
from concurrent.futures import ThreadPoolExecutor
import numpy as np

# WebSocket
import websockets
from websockets.server import WebSocketServerProtocol

# Composants locaux
from vst3_manager import VST3Manager, VST3Instance
from audio_processor import AudioProcessor, AudioConfig

# Configuration du logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)s | %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger('NovaBridge')


@dataclass
class ClientSession:
    """Session client avec ses plugins actifs"""
    websocket: WebSocketServerProtocol
    client_id: str
    active_plugins: Dict[str, VST3Instance] = field(default_factory=dict)
    audio_config: AudioConfig = field(default_factory=lambda: AudioConfig())
    last_activity: float = field(default_factory=time.time)
    

class NovaBridgeServer:
    """
    Serveur principal du bridge VST3
    
    Gère les connexions WebSocket, le routage des messages,
    et la coordination entre le DAW web et les plugins VST3 natifs.
    """
    
    def __init__(self, host: str = "0.0.0.0", port: int = 8765):
        self.host = host
        self.port = port
        
        # Gestionnaire VST3
        self.vst_manager = VST3Manager()
        
        # Processeur audio haute performance
        self.audio_processor = AudioProcessor(max_instances=128)
        
        # Sessions clients
        self.sessions: Dict[str, ClientSession] = {}
        self.session_lock = asyncio.Lock()
        
        # Thread pool pour opérations bloquantes
        self.executor = ThreadPoolExecutor(max_workers=16)
        
        # Statistiques
        self.stats = {
            "total_connections": 0,
            "active_plugins": 0,
            "audio_blocks_processed": 0,
            "ui_frames_sent": 0
        }
        
        # Flag de fonctionnement
        self.running = False
        
        # Tâche de capture UI
        self.ui_capture_task: Optional[asyncio.Task] = None

    async def start(self):
        """Démarrer le serveur"""
        logger.info("=" * 60)
        logger.info("  NOVA BRIDGE VST3 SERVER v3.0")
        logger.info("=" * 60)
        
        # Initialiser le gestionnaire VST3
        await self._init_vst_manager()
        
        # Démarrer le processeur audio
        self.audio_processor.start()
        
        self.running = True
        
        # Démarrer le serveur WebSocket
        async with websockets.serve(
            self._handle_connection,
            self.host,
            self.port,
            ping_interval=30,
            ping_timeout=10,
            max_size=10 * 1024 * 1024,  # 10MB max message
            compression=None  # Désactiver compression pour latence
        ):
            logger.info(f"✅ Server listening on ws://{self.host}:{self.port}/ws")
            logger.info(f"📦 {len(self.vst_manager.plugins)} VST3 plugins disponibles")
            logger.info("=" * 60)
            
            # Démarrer la capture UI en arrière-plan
            self.ui_capture_task = asyncio.create_task(self._ui_capture_loop())
            
            # Maintenir le serveur actif
            await asyncio.Future()

    async def _init_vst_manager(self):
        """Initialiser le gestionnaire VST3"""
        logger.info("🔍 Scanning VST3 plugins...")
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(self.executor, self.vst_manager.scan_plugins)
        logger.info(f"✅ Found {len(self.vst_manager.plugins)} plugins")

    async def _handle_connection(self, websocket: WebSocketServerProtocol):
        """Gérer une nouvelle connexion WebSocket"""
        # Note: 'path' parameter removed for websockets >= 10.0 compatibility
        client_id = f"client_{int(time.time() * 1000)}_{id(websocket)}"
        
        async with self.session_lock:
            self.sessions[client_id] = ClientSession(
                websocket=websocket,
                client_id=client_id
            )
        
        self.stats["total_connections"] += 1
        logger.info(f"🔗 New connection: {client_id} ({len(self.sessions)} active)")
        
        try:
            async for message in websocket:
                try:
                    data = json.loads(message)
                    await self._handle_message(client_id, data)
                except json.JSONDecodeError:
                    logger.warning(f"Invalid JSON from {client_id}")
                except Exception as e:
                    logger.error(f"Error handling message: {e}")
        finally:
            await self._cleanup_session(client_id)

    async def _cleanup_session(self, client_id: str):
        """Nettoyer une session client"""
        async with self.session_lock:
            if client_id in self.sessions:
                session = self.sessions[client_id]
                
                # Décharger tous les plugins du client
                for plugin_slot, instance in list(session.active_plugins.items()):
                    try:
                        self.audio_processor.remove_instance(plugin_slot)
                        self.vst_manager.unload_plugin(instance)
                    except Exception as e:
                        logger.error(f"Error unloading plugin: {e}")
                
                del self.sessions[client_id]
                logger.info(f"🔌 Disconnected: {client_id} ({len(self.sessions)} active)")

    async def _handle_message(self, client_id: str, data: dict):
        """Router les messages vers les handlers appropriés"""
        action = data.get("action", "")
        
        handlers = {
            "PING": self._handle_ping,
            "GET_PLUGIN_LIST": self._handle_get_plugins,
            "LOAD_PLUGIN": self._handle_load_plugin,
            "UNLOAD_PLUGIN": self._handle_unload_plugin,
            "PROCESS_AUDIO": self._handle_process_audio,
            "SET_PARAM": self._handle_set_param,
            "GET_PARAMS": self._handle_get_params,
            "CLICK": self._handle_ui_click,
            "DRAG": self._handle_ui_drag,
            "SCROLL": self._handle_ui_scroll,
            "KEY": self._handle_ui_key,
            "SET_WINDOW_RECT": self._handle_set_window,
        }
        
        handler = handlers.get(action)
        if handler:
            await handler(client_id, data)
        else:
            logger.warning(f"Unknown action: {action}")

    async def _send(self, client_id: str, data: dict):
        """Envoyer un message à un client"""
        if client_id in self.sessions:
            try:
                await self.sessions[client_id].websocket.send(json.dumps(data))
            except Exception as e:
                logger.error(f"Send error to {client_id}: {e}")

    async def _broadcast_to_session(self, client_id: str, data: dict):
        """Diffuser un message à une session spécifique"""
        await self._send(client_id, data)

    # ─────────────────────────────────────────────────────────────
    # HANDLERS DE MESSAGES
    # ─────────────────────────────────────────────────────────────

    async def _handle_ping(self, client_id: str, data: dict):
        """Répondre au ping"""
        await self._send(client_id, {"action": "PONG", "timestamp": time.time()})

    async def _handle_get_plugins(self, client_id: str, data: dict):
        """Envoyer la liste des plugins disponibles"""
        plugins = []
        for i, (path, info) in enumerate(self.vst_manager.plugins.items()):
            plugins.append({
                "id": i,
                "name": info.get("name", "Unknown"),
                "vendor": info.get("vendor", "Unknown"),
                "category": info.get("category", "Effect"),
                "path": path
            })
        
        await self._send(client_id, {
            "action": "GET_PLUGIN_LIST",
            "plugins": plugins
        })

    async def _handle_load_plugin(self, client_id: str, data: dict):
        """Charger un plugin VST3"""
        path = data.get("path")
        sample_rate = data.get("sample_rate", 44100)
        slot_id = data.get("slot_id", "default")  # Identifiant du slot (pour multi-instances)
        
        if not path:
            await self._send(client_id, {
                "action": "LOAD_PLUGIN",
                "success": False,
                "error": "Missing plugin path",
                "slot_id": slot_id
            })
            return
        
        try:
            # Charger le plugin dans un thread séparé
            loop = asyncio.get_event_loop()
            instance = await loop.run_in_executor(
                self.executor,
                self.vst_manager.load_plugin,
                path,
                sample_rate
            )
            
            if instance:
                # Enregistrer dans la session
                session = self.sessions.get(client_id)
                if session:
                    plugin_key = f"{client_id}_{slot_id}"
                    session.active_plugins[slot_id] = instance
                    
                    # Ajouter au processeur audio
                    self.audio_processor.add_instance(plugin_key, instance)
                    
                    # Récupérer les paramètres
                    params = self.vst_manager.get_parameters(instance)
                    
                    self.stats["active_plugins"] += 1
                    
                    await self._send(client_id, {
                        "action": "LOAD_PLUGIN",
                        "success": True,
                        "name": instance.name,
                        "slot_id": slot_id,
                        "parameters": params
                    })
                    
                    logger.info(f"✅ Plugin loaded: {instance.name} (slot: {slot_id})")
            else:
                await self._send(client_id, {
                    "action": "LOAD_PLUGIN",
                    "success": False,
                    "error": "Failed to load plugin",
                    "slot_id": slot_id
                })
                
        except Exception as e:
            logger.error(f"Failed to load plugin {path}: {e}")
            await self._send(client_id, {
                "action": "LOAD_PLUGIN",
                "success": False,
                "error": str(e),
                "slot_id": slot_id
            })

    async def _handle_unload_plugin(self, client_id: str, data: dict):
        """Décharger un plugin"""
        slot_id = data.get("slot_id", "default")
        
        session = self.sessions.get(client_id)
        if session and slot_id in session.active_plugins:
            instance = session.active_plugins[slot_id]
            plugin_key = f"{client_id}_{slot_id}"
            
            # Retirer du processeur audio
            self.audio_processor.remove_instance(plugin_key)
            
            # Décharger le plugin
            self.vst_manager.unload_plugin(instance)
            del session.active_plugins[slot_id]
            
            self.stats["active_plugins"] -= 1
            
            await self._send(client_id, {
                "action": "UNLOAD_PLUGIN",
                "success": True,
                "slot_id": slot_id
            })
            
            logger.info(f"🗑️ Plugin unloaded: slot {slot_id}")

    async def _handle_process_audio(self, client_id: str, data: dict):
        """Traiter un bloc audio"""
        channels = data.get("channels", [])
        sample_rate = data.get("sampleRate", 44100)
        slot_id = data.get("slot_id", "default")
        
        if not channels:
            return
        
        session = self.sessions.get(client_id)
        if not session or slot_id not in session.active_plugins:
            # Renvoyer l'audio original si pas de plugin
            await self._send(client_id, {
                "action": "AUDIO_PROCESSED",
                "channels": channels,
                "slot_id": slot_id
            })
            return
        
        try:
            # Convertir en numpy arrays
            input_channels = [np.array(ch, dtype=np.float32) for ch in channels]
            
            # Traiter via le processeur audio
            plugin_key = f"{client_id}_{slot_id}"
            output_channels = await asyncio.get_event_loop().run_in_executor(
                self.executor,
                self.audio_processor.process,
                plugin_key,
                input_channels,
                sample_rate
            )
            
            # Convertir en listes pour JSON
            output_data = [ch.tolist() for ch in output_channels]
            
            self.stats["audio_blocks_processed"] += 1
            
            await self._send(client_id, {
                "action": "AUDIO_PROCESSED",
                "channels": output_data,
                "slot_id": slot_id
            })
            
        except Exception as e:
            logger.error(f"Audio processing error: {e}")
            # Renvoyer l'audio original en cas d'erreur
            await self._send(client_id, {
                "action": "AUDIO_PROCESSED",
                "channels": channels,
                "slot_id": slot_id
            })

    async def _handle_set_param(self, client_id: str, data: dict):
        """Modifier un paramètre de plugin"""
        name = data.get("name")
        value = data.get("value")
        slot_id = data.get("slot_id", "default")
        
        session = self.sessions.get(client_id)
        if session and slot_id in session.active_plugins:
            instance = session.active_plugins[slot_id]
            
            await asyncio.get_event_loop().run_in_executor(
                self.executor,
                self.vst_manager.set_parameter,
                instance,
                name,
                value
            )
            
            await self._send(client_id, {
                "action": "PARAM_CHANGED",
                "name": name,
                "value": value,
                "slot_id": slot_id
            })

    async def _handle_get_params(self, client_id: str, data: dict):
        """Récupérer tous les paramètres d'un plugin"""
        slot_id = data.get("slot_id", "default")
        
        session = self.sessions.get(client_id)
        if session and slot_id in session.active_plugins:
            instance = session.active_plugins[slot_id]
            params = self.vst_manager.get_parameters(instance)
            
            await self._send(client_id, {
                "action": "PARAMS",
                "parameters": params,
                "slot_id": slot_id
            })

    async def _handle_ui_click(self, client_id: str, data: dict):
        """Gérer un clic sur l'UI du plugin"""
        x, y = data.get("x", 0), data.get("y", 0)
        button = data.get("button", "left")
        slot_id = data.get("slot_id", "default")
        
        session = self.sessions.get(client_id)
        if session and slot_id in session.active_plugins:
            instance = session.active_plugins[slot_id]
            await asyncio.get_event_loop().run_in_executor(
                self.executor,
                self.vst_manager.send_mouse_click,
                instance,
                x, y, button
            )

    async def _handle_ui_drag(self, client_id: str, data: dict):
        """Gérer un drag sur l'UI du plugin"""
        x1, y1 = data.get("x1", 0), data.get("y1", 0)
        x2, y2 = data.get("x2", 0), data.get("y2", 0)
        slot_id = data.get("slot_id", "default")
        
        session = self.sessions.get(client_id)
        if session and slot_id in session.active_plugins:
            instance = session.active_plugins[slot_id]
            await asyncio.get_event_loop().run_in_executor(
                self.executor,
                self.vst_manager.send_mouse_drag,
                instance,
                x1, y1, x2, y2
            )

    async def _handle_ui_scroll(self, client_id: str, data: dict):
        """Gérer le scroll sur l'UI du plugin"""
        x, y = data.get("x", 0), data.get("y", 0)
        delta = data.get("delta", 0)
        slot_id = data.get("slot_id", "default")
        
        session = self.sessions.get(client_id)
        if session and slot_id in session.active_plugins:
            instance = session.active_plugins[slot_id]
            await asyncio.get_event_loop().run_in_executor(
                self.executor,
                self.vst_manager.send_mouse_scroll,
                instance,
                x, y, delta
            )

    async def _handle_ui_key(self, client_id: str, data: dict):
        """Gérer une entrée clavier sur l'UI du plugin"""
        key = data.get("key", "")
        modifiers = data.get("modifiers", [])
        slot_id = data.get("slot_id", "default")
        
        session = self.sessions.get(client_id)
        if session and slot_id in session.active_plugins:
            instance = session.active_plugins[slot_id]
            await asyncio.get_event_loop().run_in_executor(
                self.executor,
                self.vst_manager.send_key,
                instance,
                key,
                modifiers
            )

    async def _handle_set_window(self, client_id: str, data: dict):
        """Configurer la taille de la fenêtre du plugin"""
        x = data.get("x", 0)
        y = data.get("y", 0)
        width = data.get("width", 800)
        height = data.get("height", 600)
        slot_id = data.get("slot_id", "default")
        
        session = self.sessions.get(client_id)
        if session and slot_id in session.active_plugins:
            instance = session.active_plugins[slot_id]
            await asyncio.get_event_loop().run_in_executor(
                self.executor,
                self.vst_manager.set_window_rect,
                instance,
                x, y, width, height
            )

    # ─────────────────────────────────────────────────────────────
    # CAPTURE UI EN ARRIÈRE-PLAN
    # ─────────────────────────────────────────────────────────────

    async def _ui_capture_loop(self):
        """Boucle de capture des interfaces plugin"""
        capture_interval = 1.0 / 30  # 30 FPS
        
        while self.running:
            try:
                async with self.session_lock:
                    for client_id, session in self.sessions.items():
                        for slot_id, instance in session.active_plugins.items():
                            if instance.has_editor:
                                # Capturer l'UI en thread séparé
                                frame = await asyncio.get_event_loop().run_in_executor(
                                    self.executor,
                                    self.vst_manager.capture_ui,
                                    instance
                                )
                                
                                if frame:
                                    await self._send(client_id, {
                                        "action": "UI_FRAME",
                                        "image": frame,
                                        "slot_id": slot_id
                                    })
                                    self.stats["ui_frames_sent"] += 1
                
                await asyncio.sleep(capture_interval)
                
            except Exception as e:
                logger.error(f"UI capture error: {e}")
                await asyncio.sleep(1)

    def stop(self):
        """Arrêter le serveur"""
        self.running = False
        if self.ui_capture_task:
            self.ui_capture_task.cancel()
        self.audio_processor.stop()
        self.executor.shutdown(wait=False)
        logger.info("🛑 Server stopped")


# ─────────────────────────────────────────────────────────────────
# POINT D'ENTRÉE
# ─────────────────────────────────────────────────────────────────

async def main():
    server = NovaBridgeServer(host="0.0.0.0", port=8765)
    try:
        await server.start()
    except KeyboardInterrupt:
        server.stop()

if __name__ == "__main__":
    asyncio.run(main())
