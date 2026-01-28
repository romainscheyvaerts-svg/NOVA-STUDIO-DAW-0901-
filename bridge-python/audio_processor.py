#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════════════════════╗
║                    AUDIO PROCESSOR - High Performance Multi-Instance         ║
║                                                                              ║
║  Traitement audio parallèle haute performance pour 100+ plugins VST3         ║
║  simultanés avec gestion de la latence et synchronisation.                   ║
╚══════════════════════════════════════════════════════════════════════════════╝
"""

import threading
import queue
import time
import logging
from typing import Dict, List, Optional, Any, Tuple, Callable
from dataclasses import dataclass, field
from concurrent.futures import ThreadPoolExecutor, as_completed
import numpy as np

logger = logging.getLogger('NovaBridge.Audio')


@dataclass
class AudioConfig:
    """Configuration audio"""
    sample_rate: int = 44100
    block_size: int = 512
    num_channels: int = 2
    buffer_count: int = 4  # Ring buffer count for latency management
    max_latency_ms: float = 50.0


@dataclass 
class AudioBlock:
    """Bloc audio pour le traitement"""
    plugin_key: str
    input_channels: List[np.ndarray]
    sample_rate: int
    timestamp: float = field(default_factory=time.time)
    sequence: int = 0


@dataclass
class ProcessedBlock:
    """Résultat du traitement audio"""
    plugin_key: str
    output_channels: List[np.ndarray]
    latency_ms: float
    sequence: int = 0


class RingBuffer:
    """
    Buffer circulaire lock-free pour la gestion de la latence audio
    """
    
    def __init__(self, size: int, channels: int, samples_per_block: int):
        self.size = size
        self.channels = channels
        self.samples_per_block = samples_per_block
        
        # Pré-allouer les buffers
        self.buffers = [
            [np.zeros(samples_per_block, dtype=np.float32) for _ in range(channels)]
            for _ in range(size)
        ]
        
        self.write_pos = 0
        self.read_pos = 0
        self._lock = threading.Lock()
    
    def write(self, channels: List[np.ndarray]) -> bool:
        """Écrire un bloc dans le buffer"""
        with self._lock:
            next_pos = (self.write_pos + 1) % self.size
            if next_pos == self.read_pos:
                return False  # Buffer plein
            
            for i, ch in enumerate(channels):
                if i < self.channels:
                    np.copyto(self.buffers[self.write_pos][i], ch[:self.samples_per_block])
            
            self.write_pos = next_pos
            return True
    
    def read(self) -> Optional[List[np.ndarray]]:
        """Lire un bloc depuis le buffer"""
        with self._lock:
            if self.read_pos == self.write_pos:
                return None  # Buffer vide
            
            result = [ch.copy() for ch in self.buffers[self.read_pos]]
            self.read_pos = (self.read_pos + 1) % self.size
            return result
    
    def available(self) -> int:
        """Nombre de blocs disponibles en lecture"""
        with self._lock:
            if self.write_pos >= self.read_pos:
                return self.write_pos - self.read_pos
            return self.size - self.read_pos + self.write_pos
    
    def clear(self):
        """Vider le buffer"""
        with self._lock:
            self.write_pos = 0
            self.read_pos = 0


class PluginProcessor:
    """
    Processeur pour une instance de plugin unique
    Gère le buffering et le traitement asynchrone
    """
    
    def __init__(self, plugin_key: str, instance: Any, config: AudioConfig):
        self.plugin_key = plugin_key
        self.instance = instance
        self.config = config
        
        # Ring buffers pour entrée/sortie
        self.input_buffer = RingBuffer(
            config.buffer_count, 
            config.num_channels, 
            config.block_size
        )
        self.output_buffer = RingBuffer(
            config.buffer_count, 
            config.num_channels, 
            config.block_size
        )
        
        # Statistiques
        self.blocks_processed = 0
        self.total_latency_ms = 0.0
        self.last_process_time = 0.0
        
        # État
        self.is_active = True
        self._lock = threading.Lock()
    
    def process(self, input_channels: List[np.ndarray], sample_rate: int) -> List[np.ndarray]:
        """
        Traiter un bloc audio à travers le plugin
        
        Args:
            input_channels: Canaux d'entrée
            sample_rate: Fréquence d'échantillonnage
            
        Returns:
            Canaux de sortie traités
        """
        start_time = time.perf_counter()
        
        try:
            with self._lock:
                if not self.is_active or self.instance is None:
                    return input_channels
                
                # Importer le gestionnaire VST pour le traitement
                from vst3_manager import VST3Manager
                
                # Utiliser le plugin pour traiter
                if hasattr(self.instance, 'plugin') and self.instance.plugin is not None:
                    # Format attendu par pedalboard: (channels, samples)
                    if len(input_channels) == 1:
                        audio = np.vstack([input_channels[0], input_channels[0]])
                    else:
                        audio = np.vstack(input_channels)
                    
                    audio = audio.astype(np.float32)
                    
                    # Traitement
                    output = self.instance.plugin.process(audio, sample_rate)
                    
                    # Séparer les canaux
                    result = [output[i] for i in range(min(output.shape[0], 2))]
                else:
                    result = input_channels
                
                # Statistiques
                elapsed_ms = (time.perf_counter() - start_time) * 1000
                self.blocks_processed += 1
                self.total_latency_ms += elapsed_ms
                self.last_process_time = elapsed_ms
                
                return result
                
        except Exception as e:
            logger.error(f"Plugin {self.plugin_key} process error: {e}")
            return input_channels
    
    def get_stats(self) -> Dict[str, Any]:
        """Récupérer les statistiques de traitement"""
        avg_latency = 0.0
        if self.blocks_processed > 0:
            avg_latency = self.total_latency_ms / self.blocks_processed
        
        return {
            "plugin_key": self.plugin_key,
            "blocks_processed": self.blocks_processed,
            "avg_latency_ms": avg_latency,
            "last_process_ms": self.last_process_time,
            "input_buffer_available": self.input_buffer.available(),
            "output_buffer_available": self.output_buffer.available()
        }
    
    def deactivate(self):
        """Désactiver le processeur"""
        with self._lock:
            self.is_active = False
            self.input_buffer.clear()
            self.output_buffer.clear()


class AudioProcessor:
    """
    Gestionnaire principal du traitement audio multi-instances
    
    Optimisé pour:
    - 100+ instances de plugins simultanées
    - Traitement parallèle via thread pool
    - Gestion de la latence et synchronisation
    - Priorité aux instances les plus actives
    """
    
    def __init__(self, max_instances: int = 128):
        self.max_instances = max_instances
        self.default_config = AudioConfig()
        
        # Pool de threads pour le traitement parallèle
        # Utiliser min(32, cpu_count * 2) threads
        import os
        cpu_count = os.cpu_count() or 4
        self.thread_count = min(32, cpu_count * 2)
        self.executor: Optional[ThreadPoolExecutor] = None
        
        # Processeurs par instance
        self.processors: Dict[str, PluginProcessor] = {}
        self._lock = threading.RLock()
        
        # File de traitement prioritaire
        self.priority_queue: queue.PriorityQueue = queue.PriorityQueue()
        
        # Statistiques globales
        self.stats = {
            "total_blocks": 0,
            "total_instances": 0,
            "avg_latency_ms": 0.0,
            "peak_latency_ms": 0.0,
            "buffer_underruns": 0
        }
        
        # État
        self.is_running = False
        self._processing_thread: Optional[threading.Thread] = None
        
        logger.info(f"AudioProcessor initialized (max_instances: {max_instances}, threads: {self.thread_count})")
    
    def start(self):
        """Démarrer le processeur audio"""
        if self.is_running:
            return
        
        self.is_running = True
        self.executor = ThreadPoolExecutor(max_workers=self.thread_count)
        
        logger.info("AudioProcessor started")
    
    def stop(self):
        """Arrêter le processeur audio"""
        self.is_running = False
        
        if self.executor:
            self.executor.shutdown(wait=False)
            self.executor = None
        
        # Nettoyer tous les processeurs
        with self._lock:
            for processor in self.processors.values():
                processor.deactivate()
            self.processors.clear()
        
        logger.info("AudioProcessor stopped")
    
    def add_instance(self, plugin_key: str, instance: Any, config: Optional[AudioConfig] = None):
        """
        Ajouter une nouvelle instance de plugin
        
        Args:
            plugin_key: Identifiant unique du plugin
            instance: Instance VST3Instance
            config: Configuration audio optionnelle
        """
        with self._lock:
            if len(self.processors) >= self.max_instances:
                logger.warning(f"Max instances reached ({self.max_instances}), cannot add {plugin_key}")
                return False
            
            if plugin_key in self.processors:
                logger.warning(f"Plugin {plugin_key} already exists, replacing")
                self.processors[plugin_key].deactivate()
            
            cfg = config or self.default_config
            self.processors[plugin_key] = PluginProcessor(plugin_key, instance, cfg)
            self.stats["total_instances"] = len(self.processors)
            
            logger.debug(f"Added plugin processor: {plugin_key}")
            return True
    
    def remove_instance(self, plugin_key: str):
        """
        Retirer une instance de plugin
        
        Args:
            plugin_key: Identifiant du plugin à retirer
        """
        with self._lock:
            if plugin_key in self.processors:
                self.processors[plugin_key].deactivate()
                del self.processors[plugin_key]
                self.stats["total_instances"] = len(self.processors)
                logger.debug(f"Removed plugin processor: {plugin_key}")
    
    def process(self, plugin_key: str, 
                input_channels: List[np.ndarray], 
                sample_rate: int) -> List[np.ndarray]:
        """
        Traiter un bloc audio pour un plugin spécifique
        
        Args:
            plugin_key: Identifiant du plugin
            input_channels: Canaux audio d'entrée
            sample_rate: Fréquence d'échantillonnage
            
        Returns:
            Canaux audio traités
        """
        with self._lock:
            processor = self.processors.get(plugin_key)
        
        if processor is None:
            logger.warning(f"No processor for {plugin_key}")
            return input_channels
        
        # Traiter
        result = processor.process(input_channels, sample_rate)
        
        # Mettre à jour les statistiques globales
        self.stats["total_blocks"] += 1
        
        return result
    
    def process_batch(self, 
                      blocks: List[Tuple[str, List[np.ndarray], int]]) -> Dict[str, List[np.ndarray]]:
        """
        Traiter plusieurs blocs audio en parallèle
        
        Args:
            blocks: Liste de tuples (plugin_key, input_channels, sample_rate)
            
        Returns:
            Dict {plugin_key: output_channels}
        """
        if not self.executor:
            return {key: channels for key, channels, _ in blocks}
        
        results = {}
        futures = {}
        
        # Soumettre tous les traitements en parallèle
        for plugin_key, input_channels, sample_rate in blocks:
            future = self.executor.submit(
                self.process, 
                plugin_key, 
                input_channels, 
                sample_rate
            )
            futures[future] = plugin_key
        
        # Collecter les résultats
        for future in as_completed(futures):
            plugin_key = futures[future]
            try:
                results[plugin_key] = future.result()
            except Exception as e:
                logger.error(f"Batch process error for {plugin_key}: {e}")
                # Retourner l'entrée originale en cas d'erreur
                for key, channels, _ in blocks:
                    if key == plugin_key:
                        results[plugin_key] = channels
                        break
        
        return results
    
    def process_chain(self, 
                      plugin_keys: List[str], 
                      input_channels: List[np.ndarray],
                      sample_rate: int) -> List[np.ndarray]:
        """
        Traiter l'audio à travers une chaîne de plugins (série)
        
        Args:
            plugin_keys: Liste ordonnée des plugins
            input_channels: Canaux d'entrée initiaux
            sample_rate: Fréquence d'échantillonnage
            
        Returns:
            Canaux de sortie après tous les plugins
        """
        current = input_channels
        
        for plugin_key in plugin_keys:
            current = self.process(plugin_key, current, sample_rate)
        
        return current
    
    def get_instance_stats(self, plugin_key: str) -> Optional[Dict[str, Any]]:
        """Récupérer les statistiques d'une instance"""
        with self._lock:
            processor = self.processors.get(plugin_key)
            if processor:
                return processor.get_stats()
        return None
    
    def get_all_stats(self) -> Dict[str, Any]:
        """Récupérer toutes les statistiques"""
        with self._lock:
            instance_stats = {}
            total_latency = 0.0
            peak_latency = 0.0
            
            for key, processor in self.processors.items():
                stats = processor.get_stats()
                instance_stats[key] = stats
                total_latency += stats["avg_latency_ms"]
                peak_latency = max(peak_latency, stats["last_process_ms"])
            
            if len(self.processors) > 0:
                self.stats["avg_latency_ms"] = total_latency / len(self.processors)
            self.stats["peak_latency_ms"] = peak_latency
            
            return {
                **self.stats,
                "instances": instance_stats
            }
    
    def optimize_for_latency(self, target_latency_ms: float):
        """
        Ajuster les paramètres pour une latence cible
        
        Args:
            target_latency_ms: Latence souhaitée en millisecondes
        """
        # Calculer la taille de bloc optimale
        # block_size = sample_rate * latency_ms / 1000
        sample_rate = self.default_config.sample_rate
        optimal_block_size = int(sample_rate * target_latency_ms / 1000)
        
        # Arrondir à une puissance de 2
        optimal_block_size = 2 ** int(np.log2(optimal_block_size))
        optimal_block_size = max(64, min(2048, optimal_block_size))
        
        self.default_config.block_size = optimal_block_size
        
        # Ajuster le nombre de buffers
        if target_latency_ms < 10:
            self.default_config.buffer_count = 2
        elif target_latency_ms < 25:
            self.default_config.buffer_count = 4
        else:
            self.default_config.buffer_count = 8
        
        logger.info(f"Optimized for {target_latency_ms}ms latency: "
                    f"block_size={optimal_block_size}, buffers={self.default_config.buffer_count}")


class AudioMixer:
    """
    Mixeur audio pour combiner plusieurs sources/plugins
    """
    
    @staticmethod
    def mix(channels_list: List[List[np.ndarray]], 
            gains: Optional[List[float]] = None) -> List[np.ndarray]:
        """
        Mixer plusieurs sources audio
        
        Args:
            channels_list: Liste de sources (chaque source = liste de canaux)
            gains: Gains optionnels pour chaque source
            
        Returns:
            Canaux mixés
        """
        if not channels_list:
            return []
        
        if gains is None:
            gains = [1.0] * len(channels_list)
        
        # Trouver le nombre de canaux et de samples
        num_channels = max(len(chs) for chs in channels_list)
        num_samples = max(len(ch) for chs in channels_list for ch in chs)
        
        # Initialiser le mix
        mixed = [np.zeros(num_samples, dtype=np.float32) for _ in range(num_channels)]
        
        # Mixer
        for i, channels in enumerate(channels_list):
            gain = gains[i] if i < len(gains) else 1.0
            for j, channel in enumerate(channels):
                if j < num_channels:
                    mixed[j][:len(channel)] += channel * gain
        
        return mixed
    
    @staticmethod
    def apply_gain(channels: List[np.ndarray], gain: float) -> List[np.ndarray]:
        """Appliquer un gain à tous les canaux"""
        return [ch * gain for ch in channels]
    
    @staticmethod
    def apply_pan(channels: List[np.ndarray], pan: float) -> List[np.ndarray]:
        """
        Appliquer un panoramique stéréo
        
        Args:
            channels: Canaux stéréo
            pan: -1.0 (gauche) à 1.0 (droite)
            
        Returns:
            Canaux avec panoramique appliqué
        """
        if len(channels) < 2:
            return channels
        
        # Calcul des gains L/R
        pan_norm = (pan + 1.0) / 2.0  # 0.0 à 1.0
        gain_l = np.sqrt(1.0 - pan_norm)
        gain_r = np.sqrt(pan_norm)
        
        return [
            channels[0] * gain_l,
            channels[1] * gain_r
        ]
    
    @staticmethod
    def limit(channels: List[np.ndarray], threshold: float = 0.99) -> List[np.ndarray]:
        """Limiter l'amplitude pour éviter le clipping"""
        return [np.clip(ch, -threshold, threshold) for ch in channels]


class LatencyCompensator:
    """
    Compensation de latence pour synchroniser plusieurs plugins
    """
    
    def __init__(self):
        self.latencies: Dict[str, int] = {}  # plugin_key -> latency in samples
        self._lock = threading.Lock()
    
    def set_latency(self, plugin_key: str, latency_samples: int):
        """Définir la latence d'un plugin en samples"""
        with self._lock:
            self.latencies[plugin_key] = latency_samples
    
    def get_max_latency(self) -> int:
        """Récupérer la latence maximale"""
        with self._lock:
            if not self.latencies:
                return 0
            return max(self.latencies.values())
    
    def get_compensation(self, plugin_key: str) -> int:
        """Calculer la compensation nécessaire pour un plugin"""
        with self._lock:
            max_lat = self.get_max_latency()
            plugin_lat = self.latencies.get(plugin_key, 0)
            return max_lat - plugin_lat
    
    def compensate(self, plugin_key: str, channels: List[np.ndarray]) -> List[np.ndarray]:
        """
        Appliquer la compensation de latence
        
        Ajoute des samples de délai pour aligner avec les autres plugins
        """
        compensation = self.get_compensation(plugin_key)
        
        if compensation <= 0:
            return channels
        
        # Ajouter des zéros au début
        return [
            np.concatenate([np.zeros(compensation, dtype=np.float32), ch])
            for ch in channels
        ]
