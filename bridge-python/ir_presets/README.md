# Empreintes de reverb (Nova, reverb à convolution)

`public/ir/make-music-vocal.wav` = reverb des voix du studio (piste d'envoi VERB PRO) :
Slate Digital **VerbSuite Classics**, modèle **FG-480 · Wild Spaces · Silica Beads**,
preset « NKF/nkf 2 » (EQ grave -2,2 dB, aigu -5,5 dB, decay 95 %, attaque 2,74 ms,
pré-délai 9,49 ms, chorus 53,8 %, 100 % wet), capturée le 2026-10-02 depuis le
projet Ableton du studio.

Refaire la capture (état VST3 dans `verbsuite_fg480_silica_beads_nkf2.b64`) :

    cd bridge-python
    venv\Scripts\python capture_ir.py --plugin "C:/Program Files/Common Files/VST3/Slate Digital/VerbSuite Classics.vst3" ^
      --state-file ir_presets/verbsuite_fg480_silica_beads_nkf2.b64 --out ../public/ir/make-music-vocal.wav

puis recalibrer le niveau (le convolveur ne normalise pas une empreinte capturée) :
le fichier livré est la capture abaissée de 35 dB, ce qui donne le même niveau
moyen que l'ancienne reverb calculée (-29 dB RMS sur le signal de test).

Depuis un projet Ableton (.als) : l'état d'un plugin VST2/VST3 est dans
`<PluginDevice>…<Buffer>` (hex) ; pour VerbSuite, l'état VST3 JUCE = « VC2! » +
XML dont `IComponent` = 4 octets + ce même buffer (voir `juce_state.py`).
