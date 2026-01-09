
import { AutomationPoint } from '../types';

/**
 * AUTOMATION MANAGER (Observer Pattern)
 * -------------------------------------
 * Orchestre l'enregistrement et la lecture des automations pour:
 * 1. WebAudio (Natif) -> Haute fréquence (Sample accurate-ish)
 * 2. VST (Bridge Python) -> Basse fréquence (Throttled ~30ms)
 */

type ParamCallback = (value: number) => void;

interface RegisteredParam {
  id: string;
  targetId: string; // Track ID ou Plugin ID
  defaultValue: number;
  callback: ParamCallback;
  isBridged: boolean; // True si c'est un VST (nécessite throttling)
  lastUpdate: number; // Pour le throttling
}

export type AutomationMode = 'OFF' | 'READ' | 'WRITE' | 'LATCH';

class AutomationManager {
  private static instance: AutomationManager;
  
  // Registre des paramètres pilotables
  private registry: Map<string, RegisteredParam> = new Map();
  
  // Données d'automation (Courbes)
  // Map<ParamID, Points[]>
  private automationData: Map<string, AutomationPoint[]> = new Map();
  
  // État global
  private mode: AutomationMode = 'READ';
  private recordingParams: Set<string> = new Set(); // Paramètres en cours de modification (Touch)
  
  // Throttling configuration
  private readonly VST_THROTTLE_MS = 30;

  private constructor() {
    this.loop = this.loop.bind(this);
    // Démarrer la boucle de lecture (RAF)
    if (typeof window !== 'undefined') {
      requestAnimationFrame(this.loop);
    }
  }

  public static getInstance(): AutomationManager {
    if (!AutomationManager.instance) {
      AutomationManager.instance = new AutomationManager();
    }
    return AutomationManager.instance;
  }

  /**
   * PILIER 1 : LE REGISTRE
   * Chaque bouton s'enregistre ici au montage.
   */
  public register(
    paramId: string, 
    targetId: string, 
    callback: ParamCallback, 
    defaultValue: number = 0,
    isBridged: boolean = false
  ) {
    this.registry.set(paramId, {
      id: paramId,
      targetId,
      callback,
      defaultValue,
      isBridged,
      lastUpdate: 0
    });
  }

  public unregister(paramId: string) {
    this.registry.delete(paramId);
  }

  /**
   * PILIER 2 : ENREGISTREMENT (WRITE)
   * Appelé par l'UI quand un bouton bouge.
   */
  public setValue(paramId: string, value: number, time: number) {
    const param = this.registry.get(paramId);
    if (!param) return;

    // 1. Application immédiate (Feedback visuel + Audio)
    this.applyValue(param, value);

    // 2. Logique d'enregistrement
    if (this.mode === 'WRITE' && this.recordingParams.has(paramId)) {
      this.addPoint(paramId, time, value);
    }
  }

  // Appelé quand l'utilisateur clique/touche le bouton
  public touch(paramId: string) {
    this.recordingParams.add(paramId);
    // En mode LATCH, on pourrait effacer la courbe future ici
  }

  // Appelé quand l'utilisateur relâche
  public release(paramId: string) {
    this.recordingParams.delete(paramId);
  }

  private addPoint(paramId: string, time: number, value: number) {
    let lane = this.automationData.get(paramId);
    if (!lane) {
      lane = [];
      this.automationData.set(paramId, lane);
    }

    // Optimisation simple: remplacer le dernier point si très proche dans le temps
    const lastPoint = lane[lane.length - 1];
    if (lastPoint && Math.abs(lastPoint.time - time) < 0.05) {
      lastPoint.value = value;
      lastPoint.time = time;
    } else {
      lane.push({ id: `pt-${Date.now()}`, time, value });
    }
    
    // Trier par temps pour lecture rapide (même si l'ajout est séquentiel, sécurité)
    // lane.sort((a, b) => a.time - b.time); 
  }

  /**
   * PILIER 3 : LECTURE (READ)
   * Boucle principale
   */
  private loop() {
    // Si on a accès au temps global du DAW (via window.DAW_CONTROL ou autre)
    const currentTime = window.DAW_CONTROL ? window.DAW_CONTROL.getState().currentTime : 0;
    const isPlaying = window.DAW_CONTROL ? window.DAW_CONTROL.getState().isPlaying : false;

    if (this.mode === 'READ' && isPlaying) {
      this.registry.forEach((param, id) => {
        // Ne pas lire l'automation si l'utilisateur est en train de toucher le bouton (Override)
        if (this.recordingParams.has(id)) return;

        const points = this.automationData.get(id);
        if (points && points.length > 0) {
          const value = this.interpolate(points, currentTime);
          if (value !== null) {
            this.applyValue(param, value);
            // TODO: Mettre à jour l'UI visuelle du bouton (via un EventSystem ou React State externe)
            // Pour l'instant, le callback gère l'audio, mais l'UI React ne sera pas mise à jour 
            // à 60fps sans un système de subscription dédié pour éviter les re-renders massifs.
            this.notifyUI(id, value);
          }
        }
      });
    }

    requestAnimationFrame(this.loop);
  }

  /**
   * OPTIMISATION VST (THROTTLING)
   * N'envoie la valeur que si nécessaire.
   */
  private applyValue(param: RegisteredParam, value: number) {
    const now = Date.now();

    if (param.isBridged) {
      // VST : Limite à 1 envoi toutes les 30ms
      if (now - param.lastUpdate >= this.VST_THROTTLE_MS) {
        param.callback(value);
        param.lastUpdate = now;
      }
    } else {
      // WebAudio : Pas de limite (Sample accurate idéalement, ici Frame accurate)
      param.callback(value);
    }
  }

  private interpolate(points: AutomationPoint[], time: number): number | null {
    // Recherche dichotomique ou linéaire simple pour trouver les points entourants
    // Optimisation: On pourrait stocker le dernier index lu pour aller plus vite
    
    if (time < points[0].time) return points[0].value;
    if (time > points[points.length - 1].time) return points[points.length - 1].value;

    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];

      if (time >= p1.time && time < p2.time) {
        const ratio = (time - p1.time) / (p2.time - p1.time);
        // Interpolation Linéaire
        return p1.value + (p2.value - p1.value) * ratio;
      }
    }
    return null;
  }

  // Système simple pour notifier l'UI sans re-render React complet
  private uiListeners: Map<string, (val: number) => void> = new Map();
  
  public subscribeUI(paramId: string, cb: (val: number) => void) {
    this.uiListeners.set(paramId, cb);
  }
  
  public unsubscribeUI(paramId: string) {
    this.uiListeners.delete(paramId);
  }

  private notifyUI(paramId: string, value: number) {
    const cb = this.uiListeners.get(paramId);
    if (cb) cb(value);
  }

  // API Publique
  public setMode(m: AutomationMode) { this.mode = m; }
  public getMode() { return this.mode; }
  public getAutomationData(paramId: string) { return this.automationData.get(paramId) || []; }
  
  // Import/Export
  public loadAutomation(data: Record<string, AutomationPoint[]>) {
      Object.entries(data).forEach(([key, points]) => {
          this.automationData.set(key, points);
      });
  }
}

export const automationManager = AutomationManager.getInstance();
