import React from 'react';
import type { ShortcutAction } from '../hooks/useKeyboardShortcuts';

/**
 * Shortcut definition for display in the modal
 * Extends ShortcutAction with a unique identifier
 */
export interface ShortcutDefinition extends Omit<ShortcutAction, 'action' | 'preventBrowserDefault'> {
  id: string;
}

interface KeyboardShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const formatKey = (key: string, ctrl?: boolean, shift?: boolean, alt?: boolean): string => {
  const parts: string[] = [];
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  
  if (ctrl) parts.push(isMac ? '⌘' : 'Ctrl');
  if (shift) parts.push(isMac ? '⇧' : 'Shift');
  if (alt) parts.push(isMac ? '⌥' : 'Alt');
  
  // Format the key itself
  let displayKey = key;
  if (key === ' ') displayKey = 'Space';
  else if (key === 'ArrowUp') displayKey = '↑';
  else if (key === 'ArrowDown') displayKey = '↓';
  else if (key === 'ArrowLeft') displayKey = '←';
  else if (key === 'ArrowRight') displayKey = '→';
  else if (key === ',') displayKey = ',';
  else if (key === '.') displayKey = '.';
  else if (key === '+' || key === '=') displayKey = '+';
  else if (key === '-') displayKey = '-';
  
  parts.push(displayKey);
  return parts.join(' + ');
};

export const KeyboardShortcutsModal: React.FC<KeyboardShortcutsModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  const shortcuts: ShortcutDefinition[] = [
    // Transport
    { id: 'play', key: ' ', description: 'Play/Pause', category: 'Transport' },
    { id: 'stop', key: 'Enter', description: 'Stop & Return to Start', category: 'Transport' },
    { id: 'record', key: 'r', description: 'Toggle Record', category: 'Transport' },
    { id: 'loop', key: 'l', description: 'Toggle Loop', category: 'Transport' },
    { id: 'home', key: 'Home', description: 'Go to Start', category: 'Transport' },
    { id: 'end', key: 'End', description: 'Go to End', category: 'Transport' },
    
    // Zoom & Navigation
    { id: 'zoom-in-h', key: '+', description: 'Zoom In Horizontal', category: 'Zoom & Navigation' },
    { id: 'zoom-out-h', key: '-', description: 'Zoom Out Horizontal', category: 'Zoom & Navigation' },
    { id: 'zoom-in-v', key: '+', ctrl: true, description: 'Zoom In Vertical', category: 'Zoom & Navigation' },
    { id: 'zoom-out-v', key: '-', ctrl: true, description: 'Zoom Out Vertical', category: 'Zoom & Navigation' },
    { id: 'zoom-fit', key: 'z', description: 'Zoom to Fit', category: 'Zoom & Navigation' },
    
    // Tracks
    { id: 'track-audio', key: 'n', ctrl: true, shift: true, description: 'New Audio Track', category: 'Tracks' },
    { id: 'track-midi', key: 'm', ctrl: true, shift: true, description: 'New MIDI Track', category: 'Tracks' },
    { id: 'track-dup', key: 'd', ctrl: true, description: 'Duplicate Track', category: 'Tracks' },
    { id: 'track-del', key: 'Delete', description: 'Delete Track', category: 'Tracks' },
    { id: 'track-mute', key: 'm', description: 'Mute Track', category: 'Tracks' },
    { id: 'track-solo', key: 's', description: 'Solo Track', category: 'Tracks' },
    { id: 'track-arm', key: 'r', shift: true, description: 'Arm Track', category: 'Tracks' },
    { id: 'track-prev', key: 'ArrowUp', description: 'Previous Track', category: 'Tracks' },
    { id: 'track-next', key: 'ArrowDown', description: 'Next Track', category: 'Tracks' },
    { id: 'track-rename', key: 'F2', description: 'Rename Track', category: 'Tracks' },
    
    // Editing
    { id: 'undo', key: 'z', ctrl: true, description: 'Undo', category: 'Editing' },
    { id: 'redo', key: 'z', ctrl: true, shift: true, description: 'Redo', category: 'Editing' },
    { id: 'cut', key: 'x', ctrl: true, description: 'Cut', category: 'Editing' },
    { id: 'copy', key: 'c', ctrl: true, description: 'Copy', category: 'Editing' },
    { id: 'paste', key: 'v', ctrl: true, description: 'Paste', category: 'Editing' },
    { id: 'select-all', key: 'a', ctrl: true, description: 'Select All', category: 'Editing' },
    { id: 'deselect', key: 'Escape', description: 'Deselect', category: 'Editing' },
    { id: 'split', key: 'e', ctrl: true, description: 'Split Clip', category: 'Editing' },
    { id: 'delete', key: 'Delete', description: 'Delete', category: 'Editing' },
    
    // Tools
    { id: 'tool-select', key: 'v', description: 'Selection Tool', category: 'Tools' },
    { id: 'tool-pencil', key: 'p', description: 'Pencil Tool', category: 'Tools' },
    { id: 'tool-scissors', key: 'c', description: 'Scissors Tool', category: 'Tools' },
    { id: 'tool-mute', key: 'u', description: 'Mute Tool', category: 'Tools' },
    { id: 'snap', key: 'n', description: 'Toggle Snap', category: 'Tools' },
    
    // Views
    { id: 'view-arrangement', key: '1', description: 'Arrangement View', category: 'Views' },
    { id: 'view-mixer', key: '2', description: 'Mixer View', category: 'Views' },
    { id: 'view-automation', key: '3', description: 'Automation View', category: 'Views' },
    { id: 'view-ai', key: '4', description: 'AI Assistant View', category: 'Views' },
    { id: 'view-fullscreen', key: 'f', description: 'Toggle Fullscreen', category: 'Views' },
    { id: 'mixer-toggle', key: 'x', description: 'Toggle Mixer', category: 'Views' },
    
    // Files & Project
    { id: 'save', key: 's', ctrl: true, description: 'Save Project', category: 'Files & Project' },
    { id: 'save-as', key: 's', ctrl: true, shift: true, description: 'Save As', category: 'Files & Project' },
    { id: 'export', key: 'e', ctrl: true, shift: true, description: 'Export Audio', category: 'Files & Project' },
    { id: 'import', key: 'i', ctrl: true, description: 'Import Audio', category: 'Files & Project' },
    
    // Metronome & BPM
    { id: 'metronome', key: 'k', description: 'Toggle Metronome', category: 'Metronome & BPM' },
    { id: 'bpm-up', key: 'ArrowUp', ctrl: true, description: 'BPM +1', category: 'Metronome & BPM' },
    { id: 'bpm-down', key: 'ArrowDown', ctrl: true, description: 'BPM -1', category: 'Metronome & BPM' },
    
    // Help
    { id: 'help', key: 'h', description: 'Show This Help', category: 'Help' },
  ];

  const categories = [
    'Transport',
    'Zoom & Navigation',
    'Tracks',
    'Editing',
    'Tools',
    'Views',
    'Files & Project',
    'Metronome & BPM',
    'Help'
  ];

  return (
    <div 
      className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-[300] animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div 
        className="bg-[#1a1d24] rounded-2xl p-6 max-w-4xl w-full max-h-[85vh] overflow-auto m-4 shadow-2xl border border-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6 sticky top-0 bg-[#1a1d24] pb-4 border-b border-white/10">
          <div>
            <h2 className="text-2xl font-black text-white uppercase tracking-wider">Keyboard Shortcuts</h2>
            <p className="text-sm text-white/50 mt-1">Quick reference for NOVA STUDIO DAW</p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center text-white/70 hover:text-white transition-colors"
          >
            <i className="fas fa-times"></i>
          </button>
        </div>

        <div className="space-y-6">
          {categories.map(category => {
            const categoryShortcuts = shortcuts.filter(s => s.category === category);
            if (categoryShortcuts.length === 0) return null;

            return (
              <div key={category} className="space-y-3">
                <h3 className="text-lg font-bold text-cyan-400 uppercase tracking-wide flex items-center gap-2">
                  <span className="w-1 h-4 bg-cyan-400 rounded-full"></span>
                  {category}
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {categoryShortcuts.map(shortcut => (
                    <div
                      key={shortcut.id}
                      className="flex items-center justify-between p-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors"
                    >
                      <span className="text-sm text-white/80">{shortcut.description}</span>
                      <kbd className="px-3 py-1 text-xs font-mono font-bold bg-gradient-to-br from-white/20 to-white/10 border border-white/20 rounded-md text-white shadow-sm">
                        {formatKey(shortcut.key, shortcut.ctrl, shortcut.shift, shortcut.alt)}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-6 pt-4 border-t border-white/10 text-center">
          <p className="text-xs text-white/40">
            Press <kbd className="px-2 py-0.5 text-xs bg-white/10 rounded">H</kbd> to toggle this window
          </p>
        </div>
      </div>
    </div>
  );
};

export default KeyboardShortcutsModal;
