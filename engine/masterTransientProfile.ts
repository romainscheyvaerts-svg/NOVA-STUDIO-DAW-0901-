/**
 * Profil mesuré de l'effet « Mastering Transient » (fichier GÉNÉRÉ par
 * tools/labo/elevate/gen_profile.py à partir des calages du labo : ne pas éditer à la main).
 * Modélisation boîte noire : uniquement des mesures acoustiques.
 */
import type { MasterTransientProfile } from './masterTransientCore';

export const MASTER_TRANSIENT_PROFILE: MasterTransientProfile & { source: string } = {"source": "Mesures labo NOVA d'un limiteur de mastering multibande du commerce (boîte noire), 08/10/2026", "centers": [0.0, 101.55, 217.84, 351.0, 503.48, 678.07, 878.0, 1106.93, 1369.08, 1669.26, 2012.98, 2406.58, 2857.27, 3373.35, 3964.3, 4640.99, 5415.84, 6303.12, 7319.11, 8482.5, 9814.68, 11340.12, 13086.87, 15087.04, 17377.38, 20000.0], "emKnob": [0, 5, 10, 20, 27, 35, 40, 50, 60, 70, 80, 90, 100], "emPeakDb": [0.0, 0.41, 0.52, 0.8, 1.09, 1.53, 1.89, 2.83, 4.14, 5.88, 8.07, 10.71, 13.72], "laMs": 1.305215, "afMs": 0.30207716, "rfMs": 37.963797, "asMs": 0.40084371, "rsMs": 302.27673, "q": 0.38145684, "d0": 0.84413655, "p": 1.8880145, "wneg": 0.00024501258, "holdMs": 9.681373, "gsMs": 11.77164, "adK": 2.685572, "adP": 2.7262942, "adBg": 0.096292773, "adLtMs": 68.890992, "adSens": 0.16285486, "limThrDb": 0.833, "limRelK": 0.0362, "limAdaptExp": 0.8007, "limRelRefHz": 1000.0, "limFinRelMs": 4.6838};
