#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════════════════════╗
║                    VST3 MANAGER - Plugin Loader & Controller                 ║
║                                                                              ║
║  Gère le chargement, la configuration et l'interaction avec les plugins      ║
║  VST3 natifs installés sur le système.                                       ║
╚══════════════════════════════════════════════════════════════════════════════╝
"""

import os
import sys
import ctypes
import platform
import logging
import base64
import io
import threading
from typing import Dict, List, Optional, Any, Tuple
from dataclasses import dataclass, field
from pathlib import Path

# Import conditionnel selon la plateforme
try:
    if platform.system() == "Windows":
        import win32gui
        import win32con
        import win32api
        import win32ui
        from ctypes import windll, wintypes
        HAS_WIN32 = True
    else:
        HAS_WIN32 = False
except ImportError:
    HAS_WIN32 = False

try:
    from PIL import Image, ImageGrab
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

# Bibliothèque VST3 Python - On utilise pedalboard de Spotify (excellent support VST3)
try:
    from pedalboard import load_plugin, Plugin
    from pedalboard.io import AudioFile
    HAS_PEDALBOARD = True
except ImportError:
    HAS_PEDALBOARD = False

# Alternative: pyvst (moins stable mais plus bas niveau)
try:
    import pyvst
    HAS_PYVST = True
except ImportError:
    HAS_PYVST = False

logger = logging.getLogger('NovaBridge.VST3')


@dataclass
class VST3Instance:
    """Instance d'un plugin VST3 chargé"""
    id: str
    name: str
    path: str
    plugin: Any  # Plugin object from pedalboard or pyvst
    sample_rate: int
    block_size: int = 512
    num_inputs: int = 2
    num_outputs: int = 2
    has_editor: bool = False
    editor_window: Any = None
    editor_hwnd: int = 0
    parameters: Dict[str, float] = field(default_factory=dict)
    lock: threading.Lock = field(default_factory=threading.Lock)


class VST3Manager:
    """
    Gestionnaire principal pour les plugins VST3
    
    Fonctionnalités:
    - Scan des plugins VST3 installés
    - Chargement/déchargement de plugins
    - Traitement audio en temps réel
    - Capture de l'interface graphique
    - Gestion des paramètres
    - Interaction utilisateur (souris, clavier)
    """
    
    # Chemins standard des plugins VST3 selon l'OS
    VST3_PATHS = {
        "Windows": [
            r"C:\Program Files\Common Files\VST3",
            r"C:\Program Files (x86)\Common Files\VST3",
            os.path.expandvars(r"%LOCALAPPDATA%\Programs\Common\VST3"),
            os.path.expandvars(r"%PROGRAMDATA%\VST3"),
        ],
        "Darwin": [  # macOS
            "/Library/Audio/Plug-Ins/VST3",
            os.path.expanduser("~/Library/Audio/Plug-Ins/VST3"),
        ],
        "Linux": [
            "/usr/lib/vst3",
            "/usr/local/lib/vst3",
            os.path.expanduser("~/.vst3"),
        ]
    }
    
    def __init__(self):
        self.plugins: Dict[str, Dict[str, Any]] = {}  # path -> info
        self.instances: Dict[str, VST3Instance] = {}  # id -> instance
        self.instance_counter = 0
        self._lock = threading.Lock()
        
        # Vérifier les dépendances
        if not HAS_PEDALBOARD and not HAS_PYVST:
            logger.warning("⚠️ No VST3 library found! Install pedalboard: pip install pedalboard")
        
        logger.info(f"VST3Manager initialized (pedalboard: {HAS_PEDALBOARD}, pyvst: {HAS_PYVST})")

    def scan_plugins(self) -> Dict[str, Dict[str, Any]]:
        """
        Scanner tous les plugins VST3 disponibles sur le système
        
        Returns:
            Dict[str, Dict]: Dictionnaire {chemin: infos} des plugins trouvés
        """
        self.plugins.clear()
        system = platform.system()
        search_paths = self.VST3_PATHS.get(system, [])
        
        logger.info(f"Scanning VST3 paths for {system}...")
        
        for base_path in search_paths:
            if not os.path.exists(base_path):
                continue
                
            logger.debug(f"  Scanning: {base_path}")
            
            for root, dirs, files in os.walk(base_path):
                # Les plugins VST3 sont des dossiers .vst3
                for dirname in dirs:
                    if dirname.endswith('.vst3'):
                        plugin_path = os.path.join(root, dirname)
                        try:
                            info = self._get_plugin_info(plugin_path)
                            if info:
                                self.plugins[plugin_path] = info
                                logger.debug(f"    Found: {info['name']}")
                        except Exception as e:
                            logger.warning(f"    Error scanning {dirname}: {e}")
        
        logger.info(f"Found {len(self.plugins)} VST3 plugins")
        return self.plugins

    def _get_plugin_info(self, path: str) -> Optional[Dict[str, Any]]:
        """
        Extraire les informations d'un plugin VST3
        
        Args:
            path: Chemin vers le fichier/dossier .vst3
            
        Returns:
            Dict avec les informations du plugin ou None
        """
        if not os.path.exists(path):
            return None
            
        # Extraire le nom du fichier
        name = os.path.basename(path).replace('.vst3', '')
        
        info = {
            "name": name,
            "path": path,
            "vendor": "Unknown",
            "version": "1.0",
            "category": "Effect",
            "is_instrument": False,
            "has_editor": True,
        }
        
        # Si pedalboard est disponible, on peut charger temporairement pour plus d'infos
        if HAS_PEDALBOARD:
            try:
                # Charger temporairement pour récupérer les métadonnées
                plugin = load_plugin(path)
                info["name"] = getattr(plugin, 'name', name)
                info["is_instrument"] = getattr(plugin, 'is_instrument', False)
                info["category"] = "Instrument" if info["is_instrument"] else "Effect"
                
                # Libérer immédiatement
                del plugin
            except Exception as e:
                logger.debug(f"Could not load plugin for info: {e}")
        
        return info

    def load_plugin(self, path: str, sample_rate: int = 44100) -> Optional[VST3Instance]:
        """
        Charger une instance d'un plugin VST3
        
        Args:
            path: Chemin vers le plugin .vst3
            sample_rate: Fréquence d'échantillonnage
            
        Returns:
            Instance du plugin ou None en cas d'erreur
        """
        if not os.path.exists(path):
            logger.error(f"Plugin not found: {path}")
            return None
        
        with self._lock:
            self.instance_counter += 1
            instance_id = f"vst_{self.instance_counter}_{os.path.basename(path)}"
        
        plugin_name = os.path.basename(path).replace('.vst3', '')
        
        try:
            plugin = None
            
            if HAS_PEDALBOARD:
                try:
                    plugin = load_plugin(path)
                    logger.info(f"✅ Loaded with pedalboard: {plugin.name if hasattr(plugin, 'name') else path}")
                except ImportError as e:
                    # Plugin protégé (iLok, eLicenser, etc.)
                    error_msg = str(e)
                    if "unsupported plugin format" in error_msg or "scan failure" in error_msg:
                        logger.warning(f"⚠️ Plugin '{plugin_name}' requires native host (iLok/eLicenser protection)")
                        logger.warning(f"   Ce plugin nécessite le Nova VST Host C++ natif")
                        raise Exception(f"Plugin protégé (iLok/eLicenser) - Nécessite Nova VST Host natif")
                    raise
            elif HAS_PYVST:
                # Fallback vers pyvst si disponible
                plugin = pyvst.VstPlugin(path)
                plugin.set_sample_rate(sample_rate)
                logger.info(f"Loaded with pyvst: {path}")
            else:
                logger.error("No VST3 library available!")
                return None
            
            if plugin is None:
                return None
            
            # Créer l'instance
            instance = VST3Instance(
                id=instance_id,
                name=getattr(plugin, 'name', os.path.basename(path).replace('.vst3', '')),
                path=path,
                plugin=plugin,
                sample_rate=sample_rate,
                has_editor=self._check_has_editor(plugin)
            )
            
            # Ouvrir l'éditeur graphique si disponible
            if instance.has_editor:
                self._open_editor(instance)
            
            # Récupérer les paramètres initiaux
            instance.parameters = self._read_parameters(instance)
            
            with self._lock:
                self.instances[instance_id] = instance
            
            return instance
            
        except Exception as e:
            logger.error(f"Failed to load plugin {path}: {e}")
            import traceback
            traceback.print_exc()
            return None

    def _check_has_editor(self, plugin: Any) -> bool:
        """Vérifier si le plugin a une interface graphique"""
        if HAS_PEDALBOARD:
            # Pedalboard n'expose pas directement l'éditeur
            # On suppose qu'il y en a un
            return True
        elif HAS_PYVST:
            return hasattr(plugin, 'open_editor')
        return False

    def _open_editor(self, instance: VST3Instance):
        """
        Ouvrir l'éditeur graphique du plugin dans une fenêtre cachée
        
        L'éditeur est rendu dans une fenêtre off-screen pour capture
        """
        if not HAS_WIN32 or platform.system() != "Windows":
            logger.warning("Editor display only supported on Windows with win32")
            instance.has_editor = False
            return
        
        try:
            # Créer une fenêtre cachée pour héberger l'éditeur VST
            wc = win32gui.WNDCLASS()
            wc.lpfnWndProc = self._wnd_proc
            wc.lpszClassName = f"NovaVSTHost_{instance.id}"
            wc.hInstance = win32api.GetModuleHandle(None)
            
            try:
                class_atom = win32gui.RegisterClass(wc)
            except:
                class_atom = None
            
            # Créer la fenêtre (cachée initialement)
            hwnd = win32gui.CreateWindow(
                wc.lpszClassName,
                f"Nova Bridge - {instance.name}",
                win32con.WS_OVERLAPPEDWINDOW,
                0, 0, 800, 600,
                0, 0, wc.hInstance, None
            )
            
            if hwnd:
                instance.editor_hwnd = hwnd
                instance.editor_window = hwnd
                
                # Ouvrir l'éditeur VST dans cette fenêtre
                if HAS_PYVST and hasattr(instance.plugin, 'open_editor'):
                    instance.plugin.open_editor(hwnd)
                
                # Afficher la fenêtre (optionnel pour débogage)
                # win32gui.ShowWindow(hwnd, win32con.SW_SHOW)
                
                logger.debug(f"Editor window created: {hwnd}")
            
        except Exception as e:
            logger.error(f"Failed to open editor: {e}")
            instance.has_editor = False

    @staticmethod
    def _wnd_proc(hwnd, msg, wparam, lparam):
        """Window procedure pour la fenêtre hôte VST"""
        if msg == win32con.WM_DESTROY:
            win32gui.PostQuitMessage(0)
            return 0
        return win32gui.DefWindowProc(hwnd, msg, wparam, lparam)

    def unload_plugin(self, instance: VST3Instance):
        """
        Décharger un plugin
        
        Args:
            instance: Instance à décharger
        """
        if instance is None:
            return
            
        try:
            with instance.lock:
                # Fermer l'éditeur
                if instance.editor_hwnd and HAS_WIN32:
                    try:
                        if HAS_PYVST and hasattr(instance.plugin, 'close_editor'):
                            instance.plugin.close_editor()
                        win32gui.DestroyWindow(instance.editor_hwnd)
                    except:
                        pass
                
                # Libérer le plugin
                if instance.plugin:
                    del instance.plugin
                    instance.plugin = None
            
            with self._lock:
                if instance.id in self.instances:
                    del self.instances[instance.id]
            
            logger.info(f"Plugin unloaded: {instance.name}")
            
        except Exception as e:
            logger.error(f"Error unloading plugin: {e}")

    def process_audio(self, instance: VST3Instance, 
                      input_channels: List[Any], 
                      sample_rate: int = 44100) -> List[Any]:
        """
        Traiter un bloc audio à travers le plugin
        
        Args:
            instance: Instance du plugin
            input_channels: Liste de canaux d'entrée (numpy arrays float32)
            sample_rate: Fréquence d'échantillonnage
            
        Returns:
            Liste de canaux de sortie traités
        """
        import numpy as np
        
        if instance is None or instance.plugin is None:
            return input_channels
        
        try:
            with instance.lock:
                if HAS_PEDALBOARD:
                    # Pedalboard attend un array 2D (channels, samples)
                    if len(input_channels) == 1:
                        # Mono -> Stereo
                        audio = np.vstack([input_channels[0], input_channels[0]])
                    else:
                        audio = np.vstack(input_channels)
                    
                    # Assurer le bon dtype
                    audio = audio.astype(np.float32)
                    
                    # Traiter
                    output = instance.plugin.process(audio, sample_rate)
                    
                    # Séparer les canaux
                    return [output[i] for i in range(output.shape[0])]
                    
                elif HAS_PYVST:
                    # pyvst a une API différente
                    block_size = len(input_channels[0])
                    
                    # Préparer les buffers
                    inputs = input_channels
                    outputs = [np.zeros(block_size, dtype=np.float32) for _ in range(instance.num_outputs)]
                    
                    instance.plugin.process_replacing(inputs, outputs, block_size)
                    
                    return outputs
                else:
                    return input_channels
                    
        except Exception as e:
            logger.error(f"Audio processing error: {e}")
            return input_channels

    def get_parameters(self, instance: VST3Instance) -> List[Dict[str, Any]]:
        """
        Récupérer tous les paramètres d'un plugin
        
        Args:
            instance: Instance du plugin
            
        Returns:
            Liste des paramètres avec nom, valeur, etc.
        """
        params = []
        
        if instance is None or instance.plugin is None:
            return params
        
        try:
            with instance.lock:
                if HAS_PEDALBOARD:
                    # Pedalboard expose les paramètres comme attributs
                    for attr_name in dir(instance.plugin):
                        if not attr_name.startswith('_'):
                            try:
                                value = getattr(instance.plugin, attr_name)
                                if isinstance(value, (int, float)):
                                    params.append({
                                        "name": attr_name,
                                        "value": float(value),
                                        "display_name": attr_name.replace('_', ' ').title()
                                    })
                            except:
                                pass
                                
                elif HAS_PYVST:
                    num_params = instance.plugin.num_params
                    for i in range(num_params):
                        name = instance.plugin.get_param_name(i)
                        value = instance.plugin.get_param_value(i)
                        params.append({
                            "name": name,
                            "value": float(value),
                            "display_name": name,
                            "index": i
                        })
                        
        except Exception as e:
            logger.error(f"Error getting parameters: {e}")
        
        return params

    def _read_parameters(self, instance: VST3Instance) -> Dict[str, float]:
        """Lire les paramètres en dict interne"""
        params = {}
        for p in self.get_parameters(instance):
            params[p["name"]] = p["value"]
        return params

    def set_parameter(self, instance: VST3Instance, name: str, value: float):
        """
        Modifier un paramètre du plugin
        
        Args:
            instance: Instance du plugin
            name: Nom du paramètre
            value: Nouvelle valeur (0.0 - 1.0 généralement)
        """
        if instance is None or instance.plugin is None:
            return
        
        try:
            with instance.lock:
                if HAS_PEDALBOARD:
                    if hasattr(instance.plugin, name):
                        setattr(instance.plugin, name, value)
                        instance.parameters[name] = value
                        
                elif HAS_PYVST:
                    # Trouver l'index du paramètre
                    for i in range(instance.plugin.num_params):
                        if instance.plugin.get_param_name(i) == name:
                            instance.plugin.set_param_value(i, value)
                            instance.parameters[name] = value
                            break
                            
        except Exception as e:
            logger.error(f"Error setting parameter {name}: {e}")

    def capture_ui(self, instance: VST3Instance) -> Optional[str]:
        """
        Capturer l'interface graphique du plugin en image base64
        
        Args:
            instance: Instance du plugin
            
        Returns:
            Image encodée en base64 (JPEG) ou None
        """
        if not instance.has_editor or not instance.editor_hwnd:
            return None
        
        if not HAS_WIN32 or not HAS_PIL:
            return None
        
        try:
            hwnd = instance.editor_hwnd
            
            # Obtenir les dimensions de la fenêtre
            left, top, right, bottom = win32gui.GetWindowRect(hwnd)
            width = right - left
            height = bottom - top
            
            if width <= 0 or height <= 0:
                return None
            
            # Créer un DC compatible
            hwndDC = win32gui.GetWindowDC(hwnd)
            mfcDC = win32ui.CreateDCFromHandle(hwndDC)
            saveDC = mfcDC.CreateCompatibleDC()
            
            # Créer un bitmap
            saveBitMap = win32ui.CreateBitmap()
            saveBitMap.CreateCompatibleBitmap(mfcDC, width, height)
            saveDC.SelectObject(saveBitMap)
            
            # Copier le contenu de la fenêtre
            result = windll.user32.PrintWindow(hwnd, saveDC.GetSafeHdc(), 3)
            
            if result:
                # Convertir en PIL Image
                bmpinfo = saveBitMap.GetInfo()
                bmpstr = saveBitMap.GetBitmapBits(True)
                
                image = Image.frombuffer(
                    'RGB',
                    (bmpinfo['bmWidth'], bmpinfo['bmHeight']),
                    bmpstr, 'raw', 'BGRX', 0, 1
                )
                
                # Encoder en JPEG base64
                buffer = io.BytesIO()
                image.save(buffer, format='JPEG', quality=85)
                base64_image = base64.b64encode(buffer.getvalue()).decode('utf-8')
                
                # Nettoyer
                win32gui.DeleteObject(saveBitMap.GetHandle())
                saveDC.DeleteDC()
                mfcDC.DeleteDC()
                win32gui.ReleaseDC(hwnd, hwndDC)
                
                return base64_image
            
            # Nettoyer en cas d'échec
            win32gui.DeleteObject(saveBitMap.GetHandle())
            saveDC.DeleteDC()
            mfcDC.DeleteDC()
            win32gui.ReleaseDC(hwnd, hwndDC)
            
        except Exception as e:
            logger.debug(f"UI capture error: {e}")
        
        return None

    def send_mouse_click(self, instance: VST3Instance, x: int, y: int, button: str = "left"):
        """
        Envoyer un clic souris à l'éditeur du plugin
        
        Args:
            instance: Instance du plugin
            x, y: Coordonnées du clic
            button: "left", "right", ou "middle"
        """
        if not instance.editor_hwnd or not HAS_WIN32:
            return
        
        try:
            hwnd = instance.editor_hwnd
            lparam = win32api.MAKELONG(x, y)
            
            if button == "left":
                win32gui.SendMessage(hwnd, win32con.WM_LBUTTONDOWN, win32con.MK_LBUTTON, lparam)
                win32gui.SendMessage(hwnd, win32con.WM_LBUTTONUP, 0, lparam)
            elif button == "right":
                win32gui.SendMessage(hwnd, win32con.WM_RBUTTONDOWN, win32con.MK_RBUTTON, lparam)
                win32gui.SendMessage(hwnd, win32con.WM_RBUTTONUP, 0, lparam)
            elif button == "middle":
                win32gui.SendMessage(hwnd, win32con.WM_MBUTTONDOWN, win32con.MK_MBUTTON, lparam)
                win32gui.SendMessage(hwnd, win32con.WM_MBUTTONUP, 0, lparam)
                
        except Exception as e:
            logger.error(f"Mouse click error: {e}")

    def send_mouse_drag(self, instance: VST3Instance, x1: int, y1: int, x2: int, y2: int):
        """
        Envoyer un drag souris à l'éditeur du plugin
        
        Args:
            instance: Instance du plugin
            x1, y1: Position de départ
            x2, y2: Position d'arrivée
        """
        if not instance.editor_hwnd or not HAS_WIN32:
            return
        
        try:
            hwnd = instance.editor_hwnd
            
            # Mouse down au point de départ
            lparam1 = win32api.MAKELONG(x1, y1)
            win32gui.SendMessage(hwnd, win32con.WM_LBUTTONDOWN, win32con.MK_LBUTTON, lparam1)
            
            # Interpoler le mouvement
            steps = max(abs(x2 - x1), abs(y2 - y1), 1)
            for i in range(steps + 1):
                t = i / steps
                x = int(x1 + (x2 - x1) * t)
                y = int(y1 + (y2 - y1) * t)
                lparam = win32api.MAKELONG(x, y)
                win32gui.SendMessage(hwnd, win32con.WM_MOUSEMOVE, win32con.MK_LBUTTON, lparam)
            
            # Mouse up au point final
            lparam2 = win32api.MAKELONG(x2, y2)
            win32gui.SendMessage(hwnd, win32con.WM_LBUTTONUP, 0, lparam2)
            
        except Exception as e:
            logger.error(f"Mouse drag error: {e}")

    def send_mouse_scroll(self, instance: VST3Instance, x: int, y: int, delta: int):
        """
        Envoyer un événement de scroll à l'éditeur du plugin
        
        Args:
            instance: Instance du plugin
            x, y: Position de la souris
            delta: Direction du scroll (positif = haut, négatif = bas)
        """
        if not instance.editor_hwnd or not HAS_WIN32:
            return
        
        try:
            hwnd = instance.editor_hwnd
            
            # WHEEL_DELTA est 120 par "cran" de molette
            wheel_delta = delta * 120
            wparam = win32api.MAKELONG(0, wheel_delta)
            lparam = win32api.MAKELONG(x, y)
            
            win32gui.SendMessage(hwnd, win32con.WM_MOUSEWHEEL, wparam, lparam)
            
        except Exception as e:
            logger.error(f"Mouse scroll error: {e}")

    def send_key(self, instance: VST3Instance, key: str, modifiers: List[str] = None):
        """
        Envoyer une touche clavier à l'éditeur du plugin
        
        Args:
            instance: Instance du plugin
            key: Touche à envoyer
            modifiers: Liste de modificateurs ("ctrl", "shift", "alt")
        """
        if not instance.editor_hwnd or not HAS_WIN32:
            return
        
        modifiers = modifiers or []
        
        try:
            hwnd = instance.editor_hwnd
            
            # Enfoncer les modificateurs
            if "ctrl" in modifiers:
                win32gui.SendMessage(hwnd, win32con.WM_KEYDOWN, win32con.VK_CONTROL, 0)
            if "shift" in modifiers:
                win32gui.SendMessage(hwnd, win32con.WM_KEYDOWN, win32con.VK_SHIFT, 0)
            if "alt" in modifiers:
                win32gui.SendMessage(hwnd, win32con.WM_KEYDOWN, win32con.VK_MENU, 0)
            
            # Envoyer la touche
            vk_code = self._get_vk_code(key)
            if vk_code:
                win32gui.SendMessage(hwnd, win32con.WM_KEYDOWN, vk_code, 0)
                win32gui.SendMessage(hwnd, win32con.WM_KEYUP, vk_code, 0)
            
            # Relâcher les modificateurs
            if "alt" in modifiers:
                win32gui.SendMessage(hwnd, win32con.WM_KEYUP, win32con.VK_MENU, 0)
            if "shift" in modifiers:
                win32gui.SendMessage(hwnd, win32con.WM_KEYUP, win32con.VK_SHIFT, 0)
            if "ctrl" in modifiers:
                win32gui.SendMessage(hwnd, win32con.WM_KEYUP, win32con.VK_CONTROL, 0)
                
        except Exception as e:
            logger.error(f"Key send error: {e}")

    def _get_vk_code(self, key: str) -> Optional[int]:
        """Convertir une touche en code virtuel Windows"""
        if not HAS_WIN32:
            return None
            
        # Mapping des touches communes
        key_map = {
            'enter': win32con.VK_RETURN,
            'escape': win32con.VK_ESCAPE,
            'space': win32con.VK_SPACE,
            'backspace': win32con.VK_BACK,
            'tab': win32con.VK_TAB,
            'delete': win32con.VK_DELETE,
            'up': win32con.VK_UP,
            'down': win32con.VK_DOWN,
            'left': win32con.VK_LEFT,
            'right': win32con.VK_RIGHT,
        }
        
        key_lower = key.lower()
        if key_lower in key_map:
            return key_map[key_lower]
        
        # Pour les lettres et chiffres
        if len(key) == 1:
            return ord(key.upper())
        
        return None

    def set_window_rect(self, instance: VST3Instance, x: int, y: int, width: int, height: int):
        """
        Définir la position et taille de la fenêtre de l'éditeur
        
        Args:
            instance: Instance du plugin
            x, y: Position
            width, height: Dimensions
        """
        if not instance.editor_hwnd or not HAS_WIN32:
            return
        
        try:
            win32gui.SetWindowPos(
                instance.editor_hwnd,
                win32con.HWND_TOP,
                x, y, width, height,
                win32con.SWP_SHOWWINDOW
            )
        except Exception as e:
            logger.error(f"Set window rect error: {e}")

    def get_all_instances(self) -> Dict[str, VST3Instance]:
        """Retourner toutes les instances actives"""
        with self._lock:
            return dict(self.instances)

    def cleanup(self):
        """Nettoyer toutes les ressources"""
        with self._lock:
            for instance_id, instance in list(self.instances.items()):
                self.unload_plugin(instance)
            self.instances.clear()
        logger.info("VST3Manager cleaned up")
