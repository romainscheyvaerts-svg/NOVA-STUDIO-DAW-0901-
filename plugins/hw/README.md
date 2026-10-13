# Kit « matériel » des fenêtres d'effets NOVA (`plugins/hw`)

Pour que les effets ressemblent à de vrais appareils (façon UAD, Waves, Soundtoys,
FabFilter) et plus à un formulaire. Tout est en SVG + CSS (`hw.css`), sans image
ni dépendance. Premier client : `plugins/AnalogCompPlugin.tsx` (Opto Vintage,
FET 76, Leveler 2A, Vox Strip) — à lire comme exemple.

```tsx
import { HwWindow, HwPresets, Faceplate, HwSection, Knob, VuMeter, ToggleSwitch, PushButton, Led } from './hw';
```

## Les briques

| Brique | Rôle |
|---|---|
| `HwWindow` | Fenêtre : barre d'outils (préréglages, actions NOVA) → façade → ligne d'info. Pose `data-nova-plugin`, borne la largeur à l'écran, défile au-delà de `100dvh − 8rem` (bureau). |
| `HwPresets` | Préréglages dans la barre d'outils (`data-nova-preset`, `aria-pressed`). |
| `Faceplate` | Façade : finition, vis aux coins, nom du modèle (`h2`), sous-titre sérigraphié, logo NOVA. |
| `HwSection` | Bloc sérigraphié « ── TITRE ── » (+ `aside`, ex. bouton « Actif »). |
| `Knob` | Bouton rotatif. Glisser vertical (souris, doigt, stylet), Maj = fin, double-clic / double tape = valeur d'origine, molette, flèches / Page / Début / Fin, Suppr = valeur d'origine. Lin ou log, crans (`detents`), tailles S/M/L/XL, capuchons. `role="slider"` + aria. Bulle de valeur pendant qu'on tourne. `nativeInput` ajoute un `input type=range` masqué et synchronisé pour les scripts QA qui en ont besoin. |
| `VuMeter` | VU à aiguille, cadran crème, zone rouge, repère « cible ». Balistique VU (2e ordre, 45 ms → 300 ms), maximum tenu 3 s. Animé hors React (rAF qui écrit dans le SVG). Mode `gr` (réduction de gain) ou `vu`. |
| `ToggleSwitch` | Interrupteur à levier 2 ou 3 positions (groupe radio, flèches). |
| `PushButton` | Bouton-poussoir à LED ; `role="radio"` dans un groupe exclusif (`role="radiogroup"` sur le parent). |
| `Led` | Voyant. |
| `SegmentMeter` | Échelle de LED (réduction, crête de sortie), horizontale ou verticale, repère fixe (plafond), afficheur LCD ; animée hors React. |
| `.hw-screen` > `.hw-screen-glass` | Écran (courbes, canvas) avec cadre et vitre ; onglets `.hw-screen-tab`. |
| `InfoBar` / `useHwHelp` | Aide hors façade : survol, toucher ou focus d'un réglage → nom, valeur, rôle dans la ligne du bas (comme Pro Tools). Seule la ligne se redessine. |

Les calculs purs (course, crans, pas, angle) sont dans `knobMath.ts`, testés par
`tests/hwKit.test.ts`.

## Règles de style

**Identité.** Une finition et une mise en page propres à chaque modèle. Jamais de
nom ni de logo de marque, jamais la copie exacte d'une façade existante : on s'en
inspire. La seule marque visible est le logo NOVA (`NovaLogo`, posé par `Faceplate`).

**Finitions (`finish`)** — encre (sérigraphie) et accent définis dans `hw.css` :

| finition | fond | encre | utilisée par |
|---|---|---|---|
| `cream` | peinture crème chaude `#e5d8b6` | brun `#2b2017` | Opto Vintage |
| `black` | noir brossé `#161616` | blanc cassé `#f1efe8` | FET 76 |
| `silver` | aluminium brossé `#b9bdc2` | quasi-noir `#17191c` | Leveler 2A |
| `burgundy` | émail bordeaux `#47161e` | crème `#f3e6c8`, accent or | Vox Strip |
| `graphite` | anodisé gris foncé `#25282d` | blanc `#eceef1`, accent orange | Mastering Transient |
| `steel` | bleu acier `#22303c` | blanc bleuté `#e8f0f7`, accent ambre | Nova Limiter |
| `slate` | peinture gris-bleu `#3d4350` | blanc `#f1f3f6`, accent rouge | De-esser |
| `bronze` | bronze foncé `#2e2116` | crème `#f6e7cf`, accent orange | Saturation |
| `seafoam` | émail vert d'eau `#a9d8cc` | vert très foncé `#0f241f`, accent sarcelle | Chorus |
| `plum` | prune pailletée `#3b1f4f` | lilas clair `#f4eaff`, accent magenta | Flanger |
| `forest` | vert forêt mat `#1f3b2d` | crème `#f2ead3`, accent ambre | Doubleur |
| `midnight` | bleu nuit anodisé `#111a2c` | blanc bleuté `#e6f0ff`, accent cyan | (réservé : Stéréo) |
| `hammer` | gris martelé `#3a474c` | blanc `#f3f6f6`, accent vert | Anti-bruit |
| `labgrey` | gris laboratoire `#d4d2cc` | quasi-noir `#1b1c1e`, accent pétrole | (réservé : Master) |
| `indigo` | indigo `#1e1b4b` | blanc lavande `#eef0ff`, accent rose | Harmoniseur |
| `vermilion` | émail vermillon `#8a2c1d` | crème `#fff3e3`, accent jaune | Voix grave / aiguë |
| `mustard` | émail jaune `#d6a72c` | brun noir `#1d1606`, accent rouge | Tape stop & half-time |
| `concrete` | plastique gris clair `#c8c5bd` | quasi-noir `#1c1b19`, accent orange | Gate rythmique |
| `jade` | vert anodisé `#133f33` | blanc menthe `#e8fff6`, accent vert | Gate |
| `cobalt` | aluminium bleu `#173a7a` | blanc bleuté `#eef4ff`, accent ciel | Filtre DJ |
| `avocado` | olive années 70 `#42501c` | crème `#fbf3d5`, accent anis | Lo-fi / téléphone |

L'encre atteint au moins 7:1 de contraste sur sa façade ; `--hw-ink-soft` au moins 4,5:1.
Les couleurs des façades sont codées dans `hw.css`, pas en classes Tailwind : elles ne
changent pas en thème clair (la fenêtre vit dans une zone `.nova-sombre`).

**Typographie.** Sérigraphie : Inter 800, petites capitales (`.hw-silk`, 9,5 px,
espacement 0,14 em). Nom du modèle : `sans`, `serif` (Georgia italique, modèles
vintage) ou `wide` (capitales espacées). Valeurs : JetBrains Mono (bulle, LCD).

**Tailles des boutons** (boîte cliquable ; le capuchon fait ~55 % avec chiffres, ~72 % sans) :

| taille | sans chiffres | avec `scale` | usage |
|---|---|---|---|
| S | 50 px | 64 px | réglages secondaires, sélecteurs |
| M | 68 px | 86 px | réglages courants |
| L | 88 px | 112 px (104 au téléphone) | réglage principal |
| XL | 124 px | 158 px (138 au téléphone) | « très gros boutons » |

Toutes les boîtes font au moins 44 px (doigt). Au téléphone (< 640 px) la fenêtre
fait la largeur de l'écran − 16 px : prévoir le passage sur deux rangées
(`flex-wrap`, `order-*` / `sm:order-*`), jamais de défilement horizontal.

**Capuchons (`cap`)** : `chicken` (bakélite noire à pointe), `silver` (alu moleté),
`black` (noir moleté, trait blanc), `cream` (crème, trait brun), `red`, `graphite`.
Accorder au fond : capuchons clairs sur fond sombre, sombres sur fond clair.

**Graduations.** `scale` = 3 à 6 chiffres (11 pour les très gros boutons) ;
`ticks` = graduations simples ; un sélecteur à crans dessine une graduation par
position. `arc` (couleur) ajoute un arc de valeur, réservé aux modèles modernes.

**Aide.** Pas de phrase d'aide sur la façade : le `hint` de chaque réglage part en
infobulle et dans la ligne d'info. Le texte « au repos » de la ligne d'info décrit
l'appareil. Les libellés sérigraphiés sont courts (« Seuil », « Sortie ») ;
`ariaLabel` garde le nom complet.

**Marche / arrêt.** Pas d'interrupteur général sur la façade : la barre de la fenêtre
(PluginEditor) porte le seul bypass (`[data-plugin-power]` est masqué dans les fenêtres
hébergées). Les boutons « Actif » d'un module (compresseur, égaliseur…) restent permis.

**Barre d'outils.** Ce qui relève du logiciel NOVA (préréglages, « Caler sur ma
voix », messages) va dans la barre d'outils sombre, pas sur la façade.

**Fluidité.** Les mesures (VU, LED de niveau) s'animent hors React (ref + rAF) ;
ne jamais mettre une mesure dans l'état du composant de la façade.

**Points d'accroche QA** à garder : `data-nova-plugin` (racine), `data-nova-param`
(chaque réglage), `data-nova-preset`, `h2` (nom du modèle), et ceux propres à
l'effet (`data-nova-calibrate`, `data-nova-gr-vu`…). Captures : `qa/plugins_hw_captures.py`,
gestes : `qa/plugins_hw_gestes.py`, banc : `qa/harness/hwPlugins.tsx`.

## Ajouts de la vague 2B (13/10/2026)

Uniquement des ajouts : le comportement par défaut des briques existantes ne change pas.

| Ajout | Rôle |
|---|---|
| 13 finitions | `seafoam`, `plum`, `forest`, `midnight`, `hammer`, `labgrey`, `indigo`, `vermilion`, `mustard`, `concrete`, `jade`, `cobalt`, `avocado` (tableau ci-dessus, contraste vérifié ≥ 7:1 pour l'encre). |
| `HwLcdSelect` (`LcdSelect.tsx`) | Liste native habillée en afficheur LCD vert (ou `amber`), avec sérigraphie et aide dans la ligne d'info. Pour les choix longs (tonique, gamme, intervalle). 44 px de haut au téléphone. |
| `PushButton role="checkbox"` | Case à cocher (`aria-checked`) : option marche / arrêt d'un module, lisible par `is_checked()` / `uncheck()` de Playwright. |
| `.hw-pad` | Gros pad caoutchouc qui s'allume (`aria-pressed`), couleur `--hw-pad-lit`. Déclencheurs (Tape stop…). |
| `.hw-step` (+ `.hw-step-fill`, `.hw-step-led`, `.hw-step-num`) | Touche de pas de séquenceur : remplissage = ouverture, `data-playing` = LED du pas joué (à écrire hors React), `data-outside` = hors du motif, couleur `--hw-step`. |
| Option `.hw-touch` | À poser sur la `Faceplate` (`className`) : au téléphone, poussoirs, leviers et pas passent à 44 px minimum. |

Côté V21 (`plugins/v21Ui.tsx`) : `V21Knob` (bouton rotatif depuis la fiche d'un réglage), `useV21Meter` (une mesure dans un petit afficheur, sans redessiner la façade), `V21Shell` = `HwWindow` + `Faceplate`.

Captures et contrôles de la vague 2B : `qa/plugins_hw_vague2b.py` (banc `qa/harness/hwPlugins2b.tsx`, ou `--reel` dans le vrai studio).
