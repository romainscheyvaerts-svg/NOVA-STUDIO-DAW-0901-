import React, { useState } from 'react';
import { TrackType, PluginType } from '../../types';

interface MobileFloatingActionsProps {
  onCreateTrack: (type: TrackType, name?: string, initialPluginType?: PluginType) => void;
  onToggleRecord?: () => void;
  isRecording?: boolean;
}

/**
 * Floating Action Button (FAB) with radial menu
 * Provides quick actions for adding tracks and recording
 */
const MobileFloatingActions: React.FC<MobileFloatingActionsProps> = ({
  onCreateTrack,
  onToggleRecord,
  isRecording,
}) => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const actions = [
    {
      icon: 'fa-waveform',
      label: 'Audio Track',
      color: 'bg-blue-500',
      action: () => {
        onCreateTrack(TrackType.AUDIO);
        setIsMenuOpen(false);
      },
    },
    {
      icon: 'fa-music',
      label: 'MIDI Track',
      color: 'bg-purple-500',
      action: () => {
        onCreateTrack(TrackType.MIDI);
        setIsMenuOpen(false);
      },
    },
    {
      icon: 'fa-drum',
      label: 'Drum Rack',
      color: 'bg-orange-500',
      action: () => {
        onCreateTrack(TrackType.DRUM_RACK);
        setIsMenuOpen(false);
      },
    },
    {
      icon: 'fa-folder-plus',
      label: 'Group Bus',
      color: 'bg-green-500',
      action: () => {
        onCreateTrack(TrackType.BUS);
        setIsMenuOpen(false);
      },
    },
  ];

  return (
    <>
      {/* Backdrop */}
      {isMenuOpen && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[80]"
          onClick={() => setIsMenuOpen(false)}
        />
      )}

      {/* Radial Menu Actions */}
      {isMenuOpen && (
        <div className="fixed bottom-32 right-6 z-[90] flex flex-col-reverse gap-3">
          {actions.map((action, index) => (
            <div
              key={index}
              className="flex items-center gap-3 animate-in slide-in-from-bottom-4 fade-in"
              style={{
                animationDelay: `${index * 50}ms`,
                animationDuration: '200ms',
                animationFillMode: 'backwards',
              }}
            >
              {/* Label */}
              <div className="bg-black/90 text-white px-3 py-2 rounded-lg text-sm font-bold whitespace-nowrap shadow-lg">
                {action.label}
              </div>

              {/* Action Button */}
              <button
                onClick={action.action}
                className={`w-14 h-14 rounded-full ${action.color} shadow-lg flex items-center justify-center text-white hover:scale-110 active:scale-95 transition-transform`}
              >
                <i className={`fas ${action.icon} text-xl`}></i>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Main FAB Button */}
      <button
        onClick={() => setIsMenuOpen(!isMenuOpen)}
        className={`fixed bottom-24 right-6 z-[90] w-16 h-16 rounded-full shadow-2xl flex items-center justify-center text-white transition-all ${
          isMenuOpen
            ? 'bg-red-500 rotate-45 scale-110'
            : 'bg-gradient-to-tr from-cyan-500 to-blue-600 hover:scale-110 active:scale-95'
        }`}
        style={{
          boxShadow: isMenuOpen
            ? '0 10px 40px rgba(239, 68, 68, 0.4)'
            : '0 10px 40px rgba(6, 182, 212, 0.3)',
        }}
      >
        <i className={`fas ${isMenuOpen ? 'fa-times' : 'fa-plus'} text-2xl`}></i>
      </button>

      {/* Quick Record FAB (Optional - shown when not recording) */}
      {onToggleRecord && !isRecording && !isMenuOpen && (
        <button
          onClick={onToggleRecord}
          className="fixed bottom-24 left-6 z-[90] w-14 h-14 rounded-full bg-gradient-to-tr from-red-600 to-red-700 shadow-2xl flex items-center justify-center text-white hover:scale-110 active:scale-95 transition-all"
          style={{
            boxShadow: '0 10px 40px rgba(220, 38, 38, 0.4)',
          }}
        >
          <i className="fas fa-circle text-xl"></i>
        </button>
      )}
    </>
  );
};

export default MobileFloatingActions;
