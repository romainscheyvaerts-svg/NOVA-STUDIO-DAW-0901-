import React, { useState, useRef, useEffect } from 'react';
import { Track, DrumPad } from '../types';
import { audioEngine } from '../engine/AudioEngine';
import { Faceplate, HwSection, HwWindow, Knob, PushButton } from '../plugins/hw';

/**
 * Drum Rack (30 pads), dessiné comme un contrôleur à pads de studio (kit plugins/hw) :
 * façade gris sable, 30 pads en caoutchouc qui s'allument quand ils jouent, réglages
 * du pad choisi en boutons rotatifs (volume, pan) et poussoirs Muet / Solo.
 * Mêmes envois qu'avant (note du pad au moteur, réglages du pad dans la piste) :
 * preuve dans tests/pluginsFin.test.ts.
 */
interface DrumRackProps {
    track: Track;
    onUpdateTrack: (track: Track) => void;
    /** Fermer la fenêtre (bouton de la barre d'outils, bureau). */
    onClose?: () => void;
}

const DRUM_RACK_SIZE = 30;
const COLUMNS = 6;
const RACK_ACCENT = '#0891b2';

const DrumRack: React.FC<DrumRackProps> = ({ track, onUpdateTrack, onClose }) => {
    const [selectedPadId, setSelectedPadId] = useState<number | null>(null);
    const [activePadId, setActivePadId] = useState<number | null>(null); // éclair du pad joué
    const activeTimerRef = useRef<number | null>(null);

    // Piste sans pads : on crée les 30 pads vides.
    useEffect(() => {
        if (!track.drumPads || track.drumPads.length === 0) {
            const pads: DrumPad[] = Array.from({ length: DRUM_RACK_SIZE }, (_, i) => ({
                id: i + 1,
                name: `Pad ${i + 1}`,
                sampleName: 'Empty',
                volume: 0.8,
                pan: 0,
                isMuted: false,
                isSolo: false,
                midiNote: 60 + i
            }));
            onUpdateTrack({ ...track, drumPads: pads });
        }
    }, []);

    const handlePadTrigger = (padId: number) => {
        audioEngine.triggerTrackAttack(track.id, padId + 59, 1.0); // pad 1 = note 60
        setActivePadId(padId);
        if (activeTimerRef.current) clearTimeout(activeTimerRef.current);
        activeTimerRef.current = window.setTimeout(() => setActivePadId(null), 100);
    };

    const handleFileDrop = async (e: React.DragEvent, padId: number) => {
        e.preventDefault();
        e.stopPropagation();

        let audioBuffer: AudioBuffer | null = null;
        let sampleName = "Unknown";
        let audioRef = "";

        // 1. Son du catalogue (URL)
        const url = e.dataTransfer.getData('audio-url');
        if (url) {
            sampleName = e.dataTransfer.getData('audio-name') || "Instrument";
            audioRef = url;
            try {
                await audioEngine.init();
                const response = await fetch(url);
                const arrayBuffer = await response.arrayBuffer();
                audioBuffer = await audioEngine.ctx!.decodeAudioData(arrayBuffer);
            } catch (err) {
                console.error("Failed to load dropped URL:", err);
                return;
            }
        }
        // 2. Fichier de l'ordinateur
        else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            const file = e.dataTransfer.files[0];
            if (file.type.startsWith('audio/')) {
                sampleName = file.name;
                audioRef = URL.createObjectURL(file); // URL temporaire

                if (window.DAW_CONTROL?.loadDrumSample) {
                    window.DAW_CONTROL.loadDrumSample(track.id, padId, file);
                    return; // App.tsx met la piste à jour
                }

                try {
                    const arrayBuffer = await file.arrayBuffer();
                    await audioEngine.init();
                    audioBuffer = await audioEngine.ctx!.decodeAudioData(arrayBuffer);
                } catch (err) {
                     console.error("Failed to load dropped file:", err);
                     return;
                }
            }
        }

        if (audioBuffer) {
            audioEngine.loadDrumRackSample(track.id, padId, audioBuffer);
            const newPads = track.drumPads!.map(p =>
                p.id === padId ? { ...p, sampleName, buffer: audioBuffer, audioRef } : p
            );
            onUpdateTrack({ ...track, drumPads: newPads });
        }
    };

    const updatePadState = (padId: number, changes: Partial<DrumPad>) => {
        const newPads = track.drumPads!.map(p => p.id === padId ? { ...p, ...changes } : p);
        onUpdateTrack({ ...track, drumPads: newPads });
    };

    const pads = track.drumPads || [];
    const selectedPad = pads.find(p => p.id === selectedPadId);
    const hit = (padId: number) => { handlePadTrigger(padId); setSelectedPadId(padId); };

    // 5 rangées (haut → bas), 6 colonnes : le pad 1 est en bas à gauche.
    const renderGrid = () => {
        const rows = [];
        for (let r = 4; r >= 0; r--) {
            for (let c = 0; c < COLUMNS; c++) {
                const padId = r * COLUMNS + c + 1; // 1..30
                const pad = pads.find(p => p.id === padId);
                if (!pad) continue;
                const empty = !pad.sampleName || pad.sampleName === 'Empty';
                rows.push(
                    <button type="button" key={padId} className="hw-pad hw-rack-pad" data-nova-pad={padId}
                        aria-pressed={activePadId === padId} data-selected={selectedPadId === padId ? 'true' : undefined}
                        data-muted={pad.isMuted ? 'true' : undefined} data-solo={pad.isSolo ? 'true' : undefined}
                        aria-label={`Pad ${padId} : ${empty ? 'vide' : pad.sampleName}`}
                        title={`Pad ${padId} (note ${padId + 59}) : touche pour jouer et régler ; glisse un son dessus pour le charger.`}
                        style={{ ['--hw-pad-lit' as any]: '#22d3ee' }}
                        onPointerDown={() => hit(padId)}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hit(padId); } }}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => handleFileDrop(e, padId)}>
                        <span className="hw-rack-num">{padId}</span>
                        <span className="hw-rack-name">{empty ? 'vide' : pad.sampleName}</span>
                        {(pad.isMuted || pad.isSolo) && <span className="hw-rack-flags">{pad.isMuted ? 'M' : ''}{pad.isSolo ? 'S' : ''}</span>}
                    </button>
                );
            }
        }
        return rows;
    };

    return (
        <HwWindow type="DRUM_RACK_UI" width={780} accent={RACK_ACCENT} accentInk="#ffffff"
            toolbar={onClose ? (
                <div className="hw-toolbar-row">
                    <span className="hw-cta-msg">Glisse un son du navigateur ou de l’ordinateur sur un pad pour le charger.</span>
                    <button type="button" className="hw-chip hidden sm:inline-block ml-auto" aria-label="Fermer" title="Fermer" onClick={onClose}><i className="fas fa-times" aria-hidden="true" /></button>
                </div>
            ) : undefined}
            idleHelp={<>30 pads, du Do3 (note 60) au Fa5 (note 89). <span style={{ color: '#7d8696' }}>Touche un pad pour l’entendre et le régler.</span></>}>
            <Faceplate finish="sand" model="Drum Rack" kicker="30 pads · un son par pad" modelStyle="wide" className="hw-touch" style={{ ['--hw-accent' as any]: RACK_ACCENT }}>
                <div className="flex flex-wrap lg:flex-nowrap items-start gap-4">
                    <div className="hw-rack-grid w-full lg:flex-1 min-w-0" role="group" aria-label="Pads">
                        {renderGrid()}
                    </div>
                    <HwSection title="Pad choisi" className="w-full lg:w-52 flex-none">
                        <div className="flex justify-center mb-2">
                            <span className="hw-lcd" data-nova-rack-selected role="status">{selectedPad ? `Pad ${selectedPad.id} · ${selectedPad.sampleName === 'Empty' ? 'vide' : selectedPad.sampleName}` : 'Touche un pad'}</span>
                        </div>
                        <div className="flex flex-wrap items-start justify-around gap-2">
                            <Knob paramId="volume" label="Volume" size="M" cap="black" arc={RACK_ACCENT} min={0} max={1} step={0.01} defaultValue={0.8}
                                value={selectedPad ? selectedPad.volume : 0.8} disabled={!selectedPad} format={v => `${Math.round(v * 100)} %`}
                                hint="Volume du pad choisi." scale={[{ v: 0, label: '0' }, { v: 1, label: '100' }]}
                                onChange={v => selectedPad && updatePadState(selectedPad.id, { volume: v })} />
                            <Knob paramId="pan" label="Pan" size="M" cap="black" arc={RACK_ACCENT} min={-1} max={1} step={0.01} defaultValue={0} bipolar
                                value={selectedPad ? selectedPad.pan : 0} disabled={!selectedPad}
                                format={v => (Math.abs(v) < 0.005 ? 'centre' : `${v < 0 ? 'G' : 'D'} ${Math.round(Math.abs(v) * 100)}`)}
                                hint="Place le pad choisi à gauche ou à droite." scale={[{ v: -1, label: 'G' }, { v: 0, label: '0' }, { v: 1, label: 'D' }]}
                                onChange={v => selectedPad && updatePadState(selectedPad.id, { pan: v })} />
                        </div>
                        <div className="flex justify-center gap-2 mt-2">
                            <span data-nova-param="isMuted"><PushButton role="checkbox" active={!!selectedPad?.isMuted} disabled={!selectedPad} text="Muet" led="#ef4444" dark
                                ariaLabel="Couper le pad choisi" hint="Muet : le pad choisi ne joue plus." onClick={() => selectedPad && updatePadState(selectedPad.id, { isMuted: !selectedPad.isMuted })} /></span>
                            <span data-nova-param="isSolo"><PushButton role="checkbox" active={!!selectedPad?.isSolo} disabled={!selectedPad} text="Solo" led="#facc15" dark
                                ariaLabel="Écouter le pad choisi seul" hint="Solo : on n’entend que les pads en solo." onClick={() => selectedPad && updatePadState(selectedPad.id, { isSolo: !selectedPad.isSolo })} /></span>
                        </div>
                    </HwSection>
                </div>
            </Faceplate>
        </HwWindow>
    );
};

export default DrumRack;
