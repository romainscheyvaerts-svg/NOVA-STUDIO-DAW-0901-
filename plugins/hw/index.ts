/**
 * Kit « matériel » des fenêtres d'effets NOVA : boutons rotatifs, VU-mètre à
 * aiguille, interrupteurs, boutons-poussoirs à LED, façades, ligne d'info.
 * Mode d'emploi et règles de style : plugins/hw/README.md.
 */
import './hw.css';

export { Knob, type KnobProps, type KnobSize, type KnobCap } from './Knob';
export { VuMeter, vuPos, type VuMeterProps } from './VuMeter';
export { Led, PushButton, ToggleSwitch } from './Switches';
export { Faceplate, HwSection, HwPresets, HwWindow, NovaLogo, type HwFinish } from './Faceplate';
export { InfoBar, HwHelpProvider, createHwHelpStore, useHwHelp, useHwHelpStore, type HwHelpEntry, type HwHelpStore } from './help';
export { toNorm, fromNorm, quantize, nudge, angleOf, detentIndex, type KnobRange } from './knobMath';
