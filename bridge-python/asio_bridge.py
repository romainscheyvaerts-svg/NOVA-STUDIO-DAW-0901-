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
# Depuis sounddevice 0.5, la DLL PortAudio avec ASIO n'est chargée que si
# SD_ENABLE_ASIO est défini AVANT l'import ; sans ça aucune carte n'est ouverte
# en ASIO (seulement MME / WASAPI) et le pont perd son intérêt.
os.environ.setdefault("SD_ENABLE_ASIO", "1")
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

# comtypes pour l'interface COM ASIO
try:
    import comtypes
    import comtypes.client
    COMTYPES_AVAILABLE = True
except ImportError:
    COMTYPES_AVAILABLE = False

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
    # 0 = toutes les entrées / sorties de la carte (32 au plus) : plusieurs pistes armées
    # lisent chacune leur canal, les mixes casque sortent sur leurs paires (R15).
    input_channels: int = 0
    output_channels: int = 0
    bit_depth: int = 32  # 16, 24 ou 32 bits float
    use_asio: bool = True  # Utiliser ASIO si disponible
    # Retour direct : la voix repart vers le casque DANS le pont (latence = buffer
    # ASIO seulement), au lieu de faire l'aller-retour pont -> navigateur -> pont.
    direct_monitor: bool = False
    monitor_gain: float = 1.0
    monitor_channel: int = -1  # -1 = mélange des entrées 1+2, sinon index d'entrée
    # Retour direct multicanal (R15) : [(entrée, sortie, gain)] ; vide = ancien réglage ci-dessus.
    monitor_routes: List[tuple] = field(default_factory=list)


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


class ASIODriverInstance:
    """
    Instance d'un driver ASIO chargé en mémoire
    
    Garde le driver actif pour qu'il apparaisse dans la barre des tâches
    et puisse être utilisé pour l'audio
    """
    
    def __init__(self):
        self.driver_name: Optional[str] = None
        self.clsid: Optional[str] = None
        self.p_driver: Optional[Any] = None  # Pointeur COM vers le driver
        self.vtable_ptr: Optional[Any] = None
        self.is_loaded: bool = False
        self.is_initialized: bool = False
        self._ole32 = None
        self._lock = threading.Lock()
        
        # Info du driver chargé
        self.sample_rate: int = 44100
        self.input_channels: int = 2
        self.output_channels: int = 2
        self.buffer_size: int = 256
    
    def load(self, driver_name: str) -> bool:
        """
        Charger un driver ASIO par son nom
        
        Le driver restera actif jusqu'à ce qu'on appelle unload()
        """
        with self._lock:
            # Si un driver est déjà chargé, le décharger d'abord
            if self.is_loaded:
                self._unload_internal()
            
            logger.info(f"🔌 Chargement du driver ASIO: {driver_name}")
            
            # Trouver le CLSID dans le registre
            clsid = self._find_driver_clsid(driver_name)
            if not clsid:
                logger.error(f"   ❌ CLSID non trouvé pour: {driver_name}")
                return False
            
            logger.info(f"   CLSID: {clsid}")
            
            try:
                import ctypes
                from ctypes import wintypes
                
                self._ole32 = ctypes.windll.ole32
                self._ole32.CoInitialize(None)
                
                # Structures GUID
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
                IID_IUnknown = GUID()
                IID_IUnknown.Data1 = 0x00000000
                IID_IUnknown.Data2 = 0x0000
                IID_IUnknown.Data3 = 0x0000
                IID_IUnknown.Data4[0] = 0xC0
                IID_IUnknown.Data4[1] = 0x00
                IID_IUnknown.Data4[7] = 0x46
                
                # Créer l'instance COM
                p_driver = ctypes.c_void_p()
                hr = self._ole32.CoCreateInstance(
                    ctypes.byref(guid),
                    None,
                    1,  # CLSCTX_INPROC_SERVER
                    ctypes.byref(IID_IUnknown),
                    ctypes.byref(p_driver)
                )
                
                if hr != 0 or not p_driver.value:
                    logger.error(f"   ❌ CoCreateInstance échoué: 0x{hr:08X}")
                    self._ole32.CoUninitialize()
                    return False
                
                logger.info(f"   ✅ Driver COM créé: {hex(p_driver.value)}")
                
                # Lire la vtable
                vtable = ctypes.cast(p_driver, ctypes.POINTER(ctypes.c_void_p))[0]
                self.vtable_ptr = ctypes.cast(vtable, ctypes.POINTER(ctypes.c_void_p * 24))[0]
                
                # Initialiser le driver ASIO
                ASIO_INIT_FUNC = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p)
                init_func = ASIO_INIT_FUNC(self.vtable_ptr[3])
                init_result = init_func(p_driver.value, None)
                
                logger.info(f"   ASIO init() result: {init_result}")
                
                if init_result != 1:  # ASIOTrue = 1
                    logger.warning(f"   ⚠️ init() n'a pas retourné ASIOTrue, mais on continue...")
                
                # Stocker les références
                self.p_driver = p_driver
                self.driver_name = driver_name
                self.clsid = clsid
                self.is_loaded = True
                self.is_initialized = True
                
                # Récupérer les infos du driver
                self._query_driver_info()
                
                logger.info(f"   ✅ Driver ASIO chargé et actif!")
                logger.info(f"   📊 Channels: {self.input_channels}in / {self.output_channels}out")
                logger.info(f"   📊 Sample rate: {self.sample_rate}Hz")
                
                return True
                
            except Exception as e:
                logger.error(f"   ❌ Erreur lors du chargement: {e}")
                import traceback
                traceback.print_exc()
                if self._ole32:
                    self._ole32.CoUninitialize()
                return False
    
    def _find_driver_clsid(self, driver_name: str) -> Optional[str]:
        """Trouver le CLSID d'un driver dans le registre"""
        if not WINREG_AVAILABLE:
            return None
        
        for reg_path in [r"SOFTWARE\ASIO", r"SOFTWARE\WOW6432Node\ASIO"]:
            try:
                asio_key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, reg_path, 0, winreg.KEY_READ)
                try:
                    driver_key = winreg.OpenKey(asio_key, driver_name)
                    clsid, _ = winreg.QueryValueEx(driver_key, "CLSID")
                    winreg.CloseKey(driver_key)
                    winreg.CloseKey(asio_key)
                    return clsid
                except:
                    pass
                winreg.CloseKey(asio_key)
            except:
                continue
        return None
    
    def _query_driver_info(self):
        """Récupérer les informations du driver chargé"""
        if not self.p_driver or not self.vtable_ptr:
            return
        
        try:
            import ctypes
            
            # getChannels() - index 9
            GET_CHANNELS_FUNC = ctypes.WINFUNCTYPE(
                ctypes.c_long, 
                ctypes.c_void_p,
                ctypes.POINTER(ctypes.c_long),
                ctypes.POINTER(ctypes.c_long)
            )
            get_channels = GET_CHANNELS_FUNC(self.vtable_ptr[9])
            
            num_inputs = ctypes.c_long()
            num_outputs = ctypes.c_long()
            result = get_channels(self.p_driver.value, ctypes.byref(num_inputs), ctypes.byref(num_outputs))
            
            if result == 0:  # ASE_OK
                self.input_channels = num_inputs.value
                self.output_channels = num_outputs.value
            
            # getSampleRate() - index 13
            GET_SAMPLERATE_FUNC = ctypes.WINFUNCTYPE(
                ctypes.c_long,
                ctypes.c_void_p,
                ctypes.POINTER(ctypes.c_double)
            )
            get_samplerate = GET_SAMPLERATE_FUNC(self.vtable_ptr[13])
            
            sample_rate = ctypes.c_double()
            result = get_samplerate(self.p_driver.value, ctypes.byref(sample_rate))
            
            if result == 0:
                self.sample_rate = int(sample_rate.value)
                
        except Exception as e:
            logger.warning(f"   Impossible de récupérer les infos du driver: {e}")
    
    def open_control_panel(self) -> bool:
        """Ouvrir le panneau de configuration du driver"""
        if not self.is_loaded or not self.p_driver:
            logger.warning("Aucun driver chargé")
            return False
        
        try:
            import ctypes
            
            # controlPanel() - index 21
            CTRL_FUNC = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p)
            control_panel = CTRL_FUNC(self.vtable_ptr[21])
            result = control_panel(self.p_driver.value)
            
            logger.info(f"   controlPanel() result: {result}")
            return True
            
        except Exception as e:
            logger.error(f"   Erreur controlPanel: {e}")
            return False
    
    def unload(self):
        """Décharger le driver ASIO"""
        with self._lock:
            self._unload_internal()
    
    def _unload_internal(self):
        """Déchargement interne (sans lock)"""
        if not self.is_loaded:
            return
        
        logger.info(f"🔌 Déchargement du driver ASIO: {self.driver_name}")
        
        try:
            if self.p_driver and self.vtable_ptr:
                import ctypes
                
                # Release() - index 2
                RELEASE_FUNC = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)
                release = RELEASE_FUNC(self.vtable_ptr[2])
                release(self.p_driver.value)
            
            if self._ole32:
                self._ole32.CoUninitialize()
                
        except Exception as e:
            logger.error(f"   Erreur lors du déchargement: {e}")
        
        self.p_driver = None
        self.vtable_ptr = None
        self.driver_name = None
        self.clsid = None
        self.is_loaded = False
        self.is_initialized = False
        self._ole32 = None
        
        logger.info("   ✅ Driver déchargé")
    
    def get_info(self) -> Dict[str, Any]:
        """Récupérer les informations du driver chargé"""
        return {
            "is_loaded": self.is_loaded,
            "driver_name": self.driver_name,
            "sample_rate": self.sample_rate,
            "input_channels": self.input_channels,
            "output_channels": self.output_channels,
            "buffer_size": self.buffer_size
        }


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


MAX_BRIDGE_CHANNELS = 32
"""Canaux transportés au plus dans chaque sens (entrées de la carte, sorties) : au-delà, le
réseau local et le navigateur porteraient des canaux que personne n'écoute."""

# Protocole binaire v2 (R15) : chaque bloc d'entrée porte son numéro d'échantillon (depuis le
# démarrage du flux) et l'heure de son convertisseur, pour recaler à l'échantillon près et
# détecter les blocs perdus. Le client l'annonce par {"action": "HELLO", "protocol": 2} ;
# sans cette annonce, l'ancien format (8 octets d'en-tête) reste envoyé.
INPUT_MAGIC_V2 = b'NVI2'
OUTPUT_MAGIC_V2 = b'NVO2'
INPUT_HEADER_V2 = struct.Struct('<4sIIIQd')   # magie, images, canaux, fréquence, n° de la 1re image, heure ADC (s)


def encode_input_block_v2(block: np.ndarray, frame_index: int, sample_rate: int, adc_time: float) -> bytes:
    """Bloc d'entrée (images × canaux) → message binaire v2."""
    frames, channels = block.shape
    head = INPUT_HEADER_V2.pack(INPUT_MAGIC_V2, frames, channels, int(sample_rate), int(frame_index), float(adc_time))
    return head + np.ascontiguousarray(block, dtype=np.float32).tobytes()


def decode_output_message(data: bytes):
    """Message de sortie du DAW → (échantillons images × canaux, destinations ou None).

    v2 : 'NVO2', images (u32), canaux (u32), puis une sortie de la carte par canal (i32,
    -1 = ignoré), puis les échantillons float32 entrelacés. Ancien format : images, canaux,
    échantillons (canaux posés sur les sorties 1, 2…)."""
    if data[:4] == OUTPUT_MAGIC_V2:
        frames, channels = struct.unpack_from('<II', data, 4)
        if channels <= 0 or channels > 2 * MAX_BRIDGE_CHANNELS:
            raise ValueError(f"nombre de canaux invalide : {channels}")
        dests = list(struct.unpack_from(f'<{channels}i', data, 12))
        off = 12 + 4 * channels
        audio = np.frombuffer(data, dtype=np.float32, count=frames * channels, offset=off).reshape((frames, channels))
        return audio, dests
    frames, channels = struct.unpack_from('<II', data, 0)
    audio = np.frombuffer(data, dtype=np.float32, count=frames * channels, offset=8).reshape((frames, channels))
    return audio, None


def find_impulse_delays(recorded: np.ndarray, emit_frame: int, min_level: float = 0.05) -> List[Optional[int]]:
    """Retard (en échantillons) de l'impulsion de mesure sur chaque canal enregistré.

    `recorded` : images × canaux, la 1re image étant l'image 0 du test ; l'impulsion est
    partie à `emit_frame`. Canal sans retour (pas de boucle câblée) : None."""
    out: List[Optional[int]] = []
    if recorded.ndim != 2 or recorded.shape[0] == 0:
        return out
    for c in range(recorded.shape[1]):
        x = np.abs(recorded[:, c])
        k = int(np.argmax(x))
        if x[k] < min_level or k < emit_frame:
            out.append(None)
        else:
            out.append(k - emit_frame)
    return out


class ASIOAudioStream:
    """
    Flux audio ASIO bidirectionnel, multicanal (R15).

    - Ouvre TOUTES les entrées et sorties de la carte (32 au plus) : chaque piste armée
      lit son canal, chaque mix casque sort sur sa paire.
    - Chaque bloc d'entrée garde son numéro d'échantillon (horodatage) ;
    - Sortie : anneau d'échantillons à latence bornée ; le DAW dit sur quelle sortie
      part chaque canal (master sur 1-2, mixes casque sur 3-4, 5-6…).
    - Retour direct (monitoring) : matrice entrée → sortie dans le callback, latence =
      tampon de la carte seulement.
    - Mesure de latence par canal : une impulsion sort, on la retrouve sur chaque entrée.
    """

    def __init__(self, config: ASIOConfig, on_input_callback: Optional[Callable] = None, device_manager: Optional['ASIODeviceManager'] = None):
        self.config = config
        self.on_input_callback = on_input_callback
        self.device_manager = device_manager

        # État
        self.state = AudioStreamState()
        self.stream = None

        # Canaux réellement ouverts (fixés au démarrage)
        self.in_channels = max(1, config.input_channels or 2)
        self.out_channels = max(1, config.output_channels or 2)
        self.block_size = config.block_size
        self.input_latency_ms = 0.0
        self.output_latency_ms = 0.0

        # Entrée : blocs (n° de la 1re image, heure ADC, données)
        self.input_buffer: deque = deque(maxlen=200)
        self.output_buffer: deque = deque(maxlen=100)  # (compat stats)
        self.frames_in = 0                              # images reçues depuis le démarrage
        self.dropped_input_blocks = 0
        # Sortie : anneau d'échantillons. L'ancienne file de 100 blocs pouvait
        # accumuler ~0,6 s de retard ; ici le remplissage est borné et ramené
        # vers ~2 blocs (le minimum qui absorbe la gigue du réseau local).
        self._out_cap = 1 << 16
        self._alloc_output(self.out_channels)
        self.dropped_frames = 0
        # Mesure de latence en cours (voir start_latency_probe)
        self._probe: Optional[Dict[str, Any]] = None

        self._lock = threading.Lock()
        self.stats = {'blocks_in': 0, 'blocks_out': 0, 'total_samples': 0, 'start_time': 0}

    def _alloc_output(self, channels: int):
        self._out = np.zeros((self._out_cap, max(1, channels)), dtype=np.float32)
        self._out_r = 0
        self._out_fill = 0
        self._out_started = False

    # ── callback temps réel ──────────────────────────────────────────────────
    def _audio_callback(self, indata: np.ndarray, outdata: np.ndarray,
                        frames: int, time_info: Any, status: Any):
        if status:
            if getattr(status, 'input_overflow', False):
                self.state.buffer_overruns += 1
            if getattr(status, 'output_underflow', False):
                self.state.buffer_underruns += 1

        frame_index = self.frames_in
        self.frames_in += frames
        adc = 0.0
        try:
            adc = float(getattr(time_info, 'inputBufferAdcTime', 0.0) or 0.0)
        except Exception:
            adc = 0.0

        if indata is not None:
            self.state.input_level = float(np.max(np.abs(indata))) if indata.size else 0.0
            block = indata.copy()
            with self._lock:
                if len(self.input_buffer) == self.input_buffer.maxlen:
                    self.dropped_input_blocks += 1
                self.input_buffer.append((frame_index, adc, block))
                self.stats['blocks_in'] += 1
            if self.on_input_callback:
                try:
                    self.on_input_callback(block)
                except Exception as e:
                    logger.error(f"Input callback error: {e}")

        # Sortie (anneau à latence bornée)
        outdata.fill(0)
        with self._lock:
            target = 2 * frames
            if not self._out_started and self._out_fill >= target:
                self._out_started = True
            if self._out_started and self._out_fill > 0:
                n = min(frames, self._out_fill)
                ch = min(outdata.shape[1], self._out.shape[1])
                first = min(n, self._out_cap - self._out_r)
                outdata[:first, :ch] = self._out[self._out_r:self._out_r + first, :ch]
                if n > first:
                    outdata[first:n, :ch] = self._out[0:n - first, :ch]
                self._out_r = (self._out_r + n) % self._out_cap
                self._out_fill -= n
                if self._out_fill == 0:
                    self._out_started = False
                self.stats['blocks_out'] += 1

        # Retour direct (matrice entrée → sortie), comme le monitoring d'une console
        if self.config.direct_monitor and indata is not None:
            try:
                for (cin, cout, g) in self.monitor_routes():
                    if 0 <= cin < indata.shape[1] and 0 <= cout < outdata.shape[1] and g > 0:
                        outdata[:, cout] += indata[:, cin] * g
                np.clip(outdata, -1.0, 1.0, out=outdata)
            except Exception as e:
                logger.error(f"Direct monitor error: {e}")

        # Mesure de latence : impulsion émise, entrées enregistrées
        p = self._probe
        if p is not None and not p['done']:
            try:
                rel0 = frame_index - p['start_frame']      # position du bloc dans le test
                e = p['emit_at'] - rel0
                if 0 <= e < frames:
                    for c in p['out_channels']:
                        if 0 <= c < outdata.shape[1]:
                            outdata[e, c] = p['amp']
                rec = p['rec']
                i0 = max(0, -rel0)
                dst0 = rel0 + i0
                cnt = min(frames - i0, rec.shape[0] - dst0)
                if cnt > 0 and indata is not None:
                    ch = min(rec.shape[1], indata.shape[1])
                    rec[dst0:dst0 + cnt, :ch] = indata[i0:i0 + cnt, :ch]
                    p['pos'] = max(p['pos'], dst0 + cnt)
                if p['pos'] >= rec.shape[0]:
                    p['done'] = True
                    p['event'].set()
            except Exception as e:
                logger.error(f"Latency probe error: {e}")
                p['done'] = True
                p['event'].set()

        self.state.output_level = float(np.max(np.abs(outdata))) if outdata.size else 0.0
        self.stats['total_samples'] += frames

    def monitor_routes(self) -> List[tuple]:
        """Routes du retour direct : [(entrée, sortie, gain)].

        Format R15 : config.monitor_routes. Ancien format : un canal (ou le mélange 1+2)
        envoyé sur les sorties 1 et 2 au gain monitor_gain."""
        routes = getattr(self.config, 'monitor_routes', None)
        if routes:
            return routes
        g = float(self.config.monitor_gain)
        if self.config.monitor_channel >= 0:
            return [(self.config.monitor_channel, 0, g), (self.config.monitor_channel, 1, g)]
        return [(0, 0, g), (0, 1, g), (1, 0, g), (1, 1, g)]

    # ── ouverture ────────────────────────────────────────────────────────────
    def _resolve_device(self):
        device = None
        info = None
        if self.config.device_name:
            dm = self.device_manager or ASIODeviceManager()
            info = dm.get_device_by_name(self.config.device_name)
            if info:
                device = info.get('sounddevice_id', info.get('id'))
        return device, info

    def _resolve_channels(self, device) -> None:
        """Toutes les entrées / sorties de la carte (0 = toutes), 32 au plus."""
        max_in, max_out = 2, 2
        try:
            if device is not None:
                d = sd.query_devices(device)
                max_in = int(d.get('max_input_channels', 2) or 0)
                max_out = int(d.get('max_output_channels', 2) or 0)
            else:
                max_in = int(sd.query_devices(kind='input').get('max_input_channels', 2) or 0)
                max_out = int(sd.query_devices(kind='output').get('max_output_channels', 2) or 0)
        except Exception:
            pass
        max_in, max_out = max(1, max_in), max(1, max_out)
        want_in = self.config.input_channels
        want_out = self.config.output_channels
        self.in_channels = max(1, min(MAX_BRIDGE_CHANNELS, max_in if not want_in or want_in <= 0 else min(want_in, max_in or want_in)))
        self.out_channels = max(1, min(MAX_BRIDGE_CHANNELS, max_out if not want_out or want_out <= 0 else min(want_out, max_out or want_out)))

    def start(self) -> bool:
        """Démarrer le flux audio"""
        if self.state.is_running:
            return True
        if not SOUNDDEVICE_AVAILABLE:
            logger.error("sounddevice not available")
            return False
        try:
            device, _ = self._resolve_device()
            self._resolve_channels(device)
            self._alloc_output(self.out_channels)
            self.frames_in = 0
            self.stream = sd.Stream(
                device=device,
                samplerate=self.config.sample_rate,
                blocksize=self.config.block_size,
                dtype=np.float32,
                channels=(self.in_channels, self.out_channels),
                callback=self._audio_callback,
                latency='low'
            )
            self.stream.start()
            self.state.is_running = True
            self.stats['start_time'] = time.time()
            # Taille de tampon réellement obtenue (certains pilotes imposent la leur)
            try:
                bs = int(getattr(self.stream, 'blocksize', 0) or 0)
                self.block_size = bs if bs > 0 else self.config.block_size
            except Exception:
                self.block_size = self.config.block_size
            lat = getattr(self.stream, 'latency', None)
            if lat:
                try:
                    self.input_latency_ms = float(lat[0] or 0) * 1000
                    self.output_latency_ms = float(lat[1] or 0) * 1000
                except Exception:
                    self.input_latency_ms = self.output_latency_ms = 0.0
            self.state.latency_ms = self.input_latency_ms + self.output_latency_ms
            logger.info(f"✅ Audio stream started: {self.config.sample_rate}Hz, buffer: {self.block_size}, "
                        f"{self.in_channels} in / {self.out_channels} out, latency: {self.state.latency_ms:.1f}ms")
            return True
        except Exception as e:
            logger.error(f"Failed to start stream: {e}")
            self.stream = None
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
        p = self._probe
        if p is not None and not p['done']:
            p['done'] = True
            p['event'].set()
        logger.info("🛑 Audio stream stopped")

    # ── échanges avec le DAW ─────────────────────────────────────────────────
    def write_output(self, audio_data: np.ndarray, dests: Optional[List[int]] = None):
        """Écrit des échantillons vers la sortie.

        `dests` : sortie de la carte de chaque canal (-1 = ignoré) ; sans `dests`, les
        canaux vont sur les sorties 1, 2…"""
        if audio_data.ndim == 1:
            audio_data = audio_data.reshape(-1, 1)
        nch_out = self._out.shape[1]
        if dests is None:
            cols = [(j, j) for j in range(min(audio_data.shape[1], nch_out))]
        else:
            cols = [(j, d) for j, d in enumerate(dests[:audio_data.shape[1]]) if 0 <= d < nch_out]
        with self._lock:
            n = audio_data.shape[0]
            if n >= self._out_cap:
                audio_data = audio_data[-(self._out_cap - 1):]
                n = audio_data.shape[0]
            w = (self._out_r + self._out_fill) % self._out_cap
            first = min(n, self._out_cap - w)
            # Zone neuve : remise à zéro (des sorties sans canal ce bloc-ci restent muettes)
            self._out[w:w + first, :] = 0
            if n > first:
                self._out[0:n - first, :] = 0
            for (j, d) in cols:
                self._out[w:w + first, d] += audio_data[:first, j]
                if n > first:
                    self._out[0:n - first, d] += audio_data[first:n, j]
            self._out_fill = min(self._out_cap - 1, self._out_fill + n)
            block = max(64, self.block_size)
            if self._out_fill > 6 * block:
                drop = self._out_fill - 2 * block
                self._out_r = (self._out_r + drop) % self._out_cap
                self._out_fill -= drop
                self.dropped_frames += drop

    def read_input(self) -> Optional[np.ndarray]:
        """Dernier bloc d'entrée (ancien format, sans horodatage)."""
        b = self.read_input_block()
        return b[2] if b else None

    def read_input_block(self):
        """(n° de la 1re image, heure ADC, données) ou None."""
        with self._lock:
            if len(self.input_buffer) > 0:
                return self.input_buffer.popleft()
        return None

    # ── mesure de latence par canal ──────────────────────────────────────────
    def start_latency_probe(self, out_channels: List[int], seconds: float = 0.6, amp: float = 0.5) -> Dict[str, Any]:
        """Prépare une mesure : impulsion sur `out_channels`, enregistrement de toutes les entrées."""
        sr = int(self.config.sample_rate)
        n = max(256, int(seconds * sr))
        emit_at = max(64, int(0.05 * sr))
        p = {
            'out_channels': [int(c) for c in out_channels], 'amp': float(amp),
            'rec': np.zeros((n, self.in_channels), dtype=np.float32), 'pos': 0,
            'emit_at': emit_at, 'start_frame': self.frames_in + 2 * max(64, self.block_size),
            'done': False, 'event': threading.Event(),
        }
        self._probe = p
        return p

    def finish_latency_probe(self, p: Dict[str, Any]) -> Dict[str, Any]:
        self._probe = None
        delays = find_impulse_delays(p['rec'][:p['pos']], p['emit_at'])
        return {'delays': delays, 'sample_rate': int(self.config.sample_rate), 'complete': p['pos'] >= p['rec'].shape[0]}

    def get_stats(self) -> Dict[str, Any]:
        """Récupérer les statistiques"""
        elapsed = time.time() - self.stats['start_time'] if self.stats['start_time'] > 0 else 0
        return {
            'is_running': self.state.is_running,
            'sample_rate': self.config.sample_rate,
            'block_size': self.block_size,
            'latency_ms': self.state.latency_ms,
            'input_latency_ms': self.input_latency_ms,
            'output_latency_ms': self.output_latency_ms,
            'input_channels': self.in_channels,
            'output_channels': self.out_channels,
            'input_level': self.state.input_level,
            'output_level': self.state.output_level,
            'buffer_underruns': self.state.buffer_underruns,
            'buffer_overruns': self.state.buffer_overruns,
            'blocks_processed': self.stats['blocks_in'],
            'frames_in': self.frames_in,
            'dropped_input_blocks': self.dropped_input_blocks,
            'elapsed_seconds': elapsed,
            'input_buffer_size': len(self.input_buffer),
            'output_buffer_size': len(self.output_buffer),
            # Attente actuelle dans la file de sortie (ms) : sert au calage des prises
            'queue_ms': (self._out_fill / float(self.config.sample_rate)) * 1000.0 if self.config.sample_rate else 0.0,
            'dropped_frames': self.dropped_frames,
            'direct_monitor': self.config.direct_monitor,
            'monitor_gain': self.config.monitor_gain,
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
        
        # Instance du driver ASIO chargé (reste actif)
        self.asio_driver = ASIODriverInstance()
        
        # Flux audio
        self.audio_stream: Optional[ASIOAudioStream] = None
        
        # Clients connectés (et version du protocole binaire de chacun : 1 ou 2)
        self.clients: Dict[str, WebSocketServerProtocol] = {}
        self.client_proto: Dict[str, int] = {}
        self._client_seq = 0
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
        self._client_seq += 1
        client_id = f"client_{int(time.time() * 1000)}_{self._client_seq}"
        
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
                self.client_proto.pop(client_id, None)
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
            "SET_MONITOR": self._handle_set_monitor,
            "HELLO": self._handle_hello,
            "MEASURE_LATENCY": self._handle_measure_latency,
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
                # v2 (R15) : chaque canal dit sa sortie (master 1-2, mixes casque 3-4…)
                audio_data, dests = decode_output_message(data)
                self.audio_stream.write_output(audio_data, dests)
            except Exception as e:
                logger.error(f"Error processing binary audio: {e}")
    
    async def _send(self, client_id: str, data: dict):
        """Envoyer un message à un client"""
        if client_id in self.clients:
            try:
                await self.clients[client_id].send(json.dumps(data))
            except Exception as e:
                logger.error(f"Send error: {e}")
    
    async def _send_binary(self, client_id: str, audio_data: np.ndarray, frame_index: int = 0, adc_time: float = 0.0):
        """Envoyer des données audio binaires (v2 : avec n° d'échantillon et heure ADC)"""
        if client_id in self.clients:
            if self.client_proto.get(client_id, 1) >= 2:
                try:
                    sr = self.audio_stream.config.sample_rate if self.audio_stream else self.config.sample_rate
                    await self.clients[client_id].send(encode_input_block_v2(audio_data, frame_index, sr, adc_time))
                except Exception as e:
                    logger.error(f"Send binary error: {e}")
                return
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
                # Lire l'audio d'entrée (bloc horodaté)
                blk = self.audio_stream.read_input_block()
                
                if blk is not None:
                    frame_index, adc_time, input_data = blk
                    # Envoyer à tous les clients
                    async with self._client_lock:
                        for client_id in list(self.clients.keys()):
                            await self._send_binary(client_id, input_data, frame_index, adc_time)
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
        
        Lance un processus séparé qui:
        1. Initialise COM en mode STA
        2. Crée une fenêtre cachée (HWND)
        3. Charge le driver ASIO via CoCreateInstance
        4. Appelle init(hwnd) puis controlPanel()
        5. Exécute un message pump Windows pour le dialogue
        """
        device_name = self.config.device_name or ""
        logger.info(f"🎛️ Ouverture du panneau de contrôle ASIO: {device_name}")
        
        if not device_name:
            await self._send(client_id, {
                "action": "CONTROL_PANEL_RESULT",
                "success": False,
                "device": device_name,
                "error": "Aucun driver ASIO sélectionné"
            })
            return
        
        try:
            import subprocess
            
            # Chemin vers le script autonome
            script_path = os.path.join(os.path.dirname(__file__), "asio_control_panel.py")
            
            logger.info(f"   Lancement du script: {script_path}")
            logger.info(f"   Driver: {device_name}")
            
            # Lancer dans un processus séparé (non-bloquant)
            # Le processus gère son propre COM, HWND et message pump
            process = subprocess.Popen(
                [sys.executable, script_path, device_name],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP
            )
            
            logger.info(f"   ✅ Processus lancé (PID: {process.pid})")
            
            # Attendre un court moment pour voir si le processus démarre correctement
            await asyncio.sleep(1.0)
            
            # Vérifier si le processus est toujours actif
            if process.poll() is not None:
                # Le processus s'est terminé, lire la sortie
                output = process.stdout.read() if process.stdout else ""
                logger.warning(f"   Le processus s'est terminé avec code: {process.returncode}")
                if output:
                    for line in output.strip().split('\n'):
                        logger.info(f"   [subprocess] {line}")
                
                await self._send(client_id, {
                    "action": "CONTROL_PANEL_RESULT",
                    "success": process.returncode == 0,
                    "device": device_name,
                    "error": f"Process exited with code {process.returncode}" if process.returncode != 0 else None
                })
            else:
                # Le processus est en cours (le dialogue est probablement ouvert)
                logger.info(f"   ✅ Panneau ASIO en cours d'affichage (PID: {process.pid})")
                
                # Lire la sortie en arrière-plan
                def _log_subprocess_output():
                    try:
                        for line in process.stdout:
                            line = line.strip()
                            if line:
                                logger.info(f"   [asio-panel] {line}")
                    except:
                        pass
                
                log_thread = threading.Thread(target=_log_subprocess_output, daemon=True)
                log_thread.start()
                
                await self._send(client_id, {
                    "action": "CONTROL_PANEL_RESULT",
                    "success": True,
                    "device": device_name,
                    "error": None
                })
            
        except Exception as e:
            logger.error(f"   ❌ Erreur: {e}")
            import traceback
            traceback.print_exc()
            
            await self._send(client_id, {
                "action": "CONTROL_PANEL_RESULT",
                "success": False,
                "device": device_name,
                "error": str(e)
            })
    
    async def _handle_hello(self, client_id: str, data: dict):
        """Le client annonce sa version du protocole binaire (2 = blocs horodatés, sorties multiples)."""
        try:
            proto = int(data.get("protocol", 1))
        except (TypeError, ValueError):
            proto = 1
        self.client_proto[client_id] = 2 if proto >= 2 else 1
        await self._send(client_id, {
            "action": "HELLO_OK",
            "protocol": self.client_proto[client_id],
            "features": ["multichannel", "timestamps", "multi_output", "monitor_routes", "latency_probe", "live_buffer_size"],
            "max_channels": MAX_BRIDGE_CHANNELS,
        })

    def _config_payload(self) -> dict:
        st = self.audio_stream if (self.audio_stream and self.audio_stream.state.is_running) else None
        return {
            "device_name": self.config.device_name,
            "sample_rate": self.config.sample_rate,
            "block_size": st.block_size if st else self.config.block_size,
            "input_channels": st.in_channels if st else self.config.input_channels,
            "output_channels": st.out_channels if st else self.config.output_channels,
        }

    def _stream_payload(self) -> dict:
        st = self.audio_stream
        if not st:
            return {}
        return {
            "latency_ms": st.state.latency_ms,
            "input_latency_ms": st.input_latency_ms,
            "output_latency_ms": st.output_latency_ms,
            "block_size": st.block_size,
            "sample_rate": st.config.sample_rate,
            "input_channels": st.in_channels,
            "output_channels": st.out_channels,
        }

    async def _restart_stream(self) -> bool:
        """Recrée PROPREMENT le flux avec la configuration courante (taille de tampon,
        fréquence, canaux) : arrêt de la diffusion, fermeture du flux, réouverture, reprise.
        Le retour direct et ses routes sont conservés (ils vivent dans self.config)."""
        if self._audio_send_task:
            self._audio_send_task.cancel()
            try:
                await self._audio_send_task
            except (asyncio.CancelledError, Exception):
                pass
            self._audio_send_task = None
        if self.audio_stream:
            self.audio_stream.stop()
        self.audio_stream = ASIOAudioStream(self.config, device_manager=self.device_manager)
        if not self.audio_stream.start():
            return False
        self._audio_send_task = asyncio.create_task(self._broadcast_audio())
        return True

    async def _handle_set_config(self, client_id: str, data: dict):
        """
        Configurer le flux audio

        Quand un driver ASIO est sélectionné, il est chargé immédiatement
        pour qu'il apparaisse dans la barre des tâches Windows.
        Flux en cours : un changement de taille de tampon, de fréquence ou de canaux
        recrée VRAIMENT le flux (avant, la valeur était notée mais le flux gardait
        son ancien tampon).
        """
        try:
            driver_changed = False
            stream_changed = False
            new_device_name = data.get("device_name")

            if new_device_name and new_device_name != self.config.device_name:
                driver_changed = True
                stream_changed = True
                self.config.device_name = new_device_name

            for key in ("sample_rate", "block_size", "input_channels", "output_channels"):
                if key in data and data[key] is not None:
                    try:
                        v = int(data[key])
                    except (TypeError, ValueError):
                        continue
                    if key == "block_size":
                        v = max(16, min(8192, v))
                    if v != getattr(self.config, key):
                        setattr(self.config, key, v)
                        stream_changed = True

            driver_loaded = False
            driver_info = {}

            if driver_changed and self.config.device_name:
                logger.info(f"🔄 Changement de driver ASIO: {self.config.device_name}")
                driver_loaded = self.asio_driver.load(self.config.device_name)
                if driver_loaded:
                    driver_info = self.asio_driver.get_info()
                    # 0 = toutes les entrées / sorties : on le garde (le flux prend tout ce que la carte a)
                    if self.config.input_channels > 0:
                        self.config.input_channels = self.asio_driver.input_channels
                    if self.config.output_channels > 0:
                        self.config.output_channels = self.asio_driver.output_channels
                    self.config.sample_rate = self.asio_driver.sample_rate

            restarted = False
            restart_error = None
            if stream_changed and self.audio_stream and self.audio_stream.state.is_running:
                restarted = await self._restart_stream()
                if not restarted:
                    restart_error = "Le flux n'a pas pu être rouvert avec ce réglage"

            await self._send(client_id, {
                "action": "CONFIG_SET",
                "success": restart_error is None,
                "driver_loaded": driver_loaded,
                "driver_info": driver_info,
                "stream_restarted": restarted,
                "error": restart_error,
                "config": self._config_payload(),
                "stream": self._stream_payload() if restarted else None,
            })
            if restarted:
                await self._send(client_id, {"action": "STREAM_STARTED", "success": True, **self._stream_payload()})

        except Exception as e:
            logger.error(f"Erreur SET_CONFIG: {e}")
            import traceback
            traceback.print_exc()
            await self._send(client_id, {
                "action": "CONFIG_SET",
                "success": False,
                "error": str(e)
            })

    async def _handle_get_config(self, client_id: str, data: dict):
        """Récupérer la configuration actuelle"""
        await self._send(client_id, {"action": "CONFIG", "config": self._config_payload()})

    async def _handle_start_stream(self, client_id: str, data: dict):
        """Démarrer le flux audio"""
        if await self._restart_stream():
            await self._send(client_id, {"action": "STREAM_STARTED", "success": True, **self._stream_payload()})
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

    async def _handle_set_monitor(self, client_id: str, data: dict):
        """Retour direct dans le pont : {enabled, gain, channel} ou, en R15, {enabled, routes:[{in, out, gain}]}."""
        if "enabled" in data:
            self.config.direct_monitor = bool(data["enabled"])
        if "gain" in data:
            try:
                self.config.monitor_gain = max(0.0, min(2.0, float(data["gain"])))
            except (TypeError, ValueError):
                pass
        if "channel" in data:
            try:
                self.config.monitor_channel = int(data["channel"])
            except (TypeError, ValueError):
                pass
        if "routes" in data:
            routes = []
            for r in (data.get("routes") or [])[:256]:
                try:
                    cin, cout, g = int(r.get("in")), int(r.get("out")), float(r.get("gain", 0))
                except (TypeError, ValueError, AttributeError):
                    continue
                if 0 <= cin < MAX_BRIDGE_CHANNELS and 0 <= cout < MAX_BRIDGE_CHANNELS and g > 0:
                    routes.append((cin, cout, max(0.0, min(4.0, g))))
            self.config.monitor_routes = routes
        if self.audio_stream:
            self.audio_stream.config = self.config
        await self._send(client_id, {
            "action": "MONITOR_SET",
            "enabled": self.config.direct_monitor,
            "gain": self.config.monitor_gain,
            "channel": self.config.monitor_channel,
            "routes": [{"in": a, "out": b, "gain": g} for (a, b, g) in self.config.monitor_routes],
        })

    async def _handle_measure_latency(self, client_id: str, data: dict):
        """Latence aller-retour PAR CANAL : une impulsion part sur les sorties demandées, on
        la retrouve sur chaque entrée (câble de boucle, ou micro devant l'enceinte)."""
        st = self.audio_stream
        if not st or not st.state.is_running:
            await self._send(client_id, {"action": "LATENCY_MEASURED", "success": False, "error": "Flux arrêté : lance d'abord le flux de la carte."})
            return
        outs = data.get("out_channels") or [0, 1]
        try:
            outs = [int(c) for c in outs][:8]
        except (TypeError, ValueError):
            outs = [0, 1]
        try:
            seconds = float(data.get("seconds", 0.6) or 0.6)
        except (TypeError, ValueError):
            seconds = 0.6
        p = st.start_latency_probe(outs, max(0.2, min(3.0, seconds)))
        loop = asyncio.get_running_loop()
        ok = await loop.run_in_executor(None, p['event'].wait, 5.0)
        res = st.finish_latency_probe(p)
        await self._send(client_id, {
            "action": "LATENCY_MEASURED",
            "success": bool(ok) and res['complete'],
            "delays": res['delays'],
            "sample_rate": res['sample_rate'],
            "block_size": st.block_size,
            "input_latency_ms": st.input_latency_ms,
            "output_latency_ms": st.output_latency_ms,
            "out_channels": outs,
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
    # NOVA_ASIO_PORT : autre port (tests avec un pont simulé, sans toucher au pont du studio)
    try:
        port = int(os.environ.get("NOVA_ASIO_PORT", "8766"))
    except ValueError:
        port = 8766
    server = ASIOBridgeServer(host="127.0.0.1", port=port)
    try:
        await server.start()
    except KeyboardInterrupt:
        server.stop()


if __name__ == "__main__":
    asyncio.run(main())