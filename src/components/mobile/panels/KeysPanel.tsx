import React from 'react';

interface KeysPanelProps {
  onNoteOn?: (note: number) => void;
  onNoteOff?: (note: number) => void;
}

const KeysPanel: React.FC<KeysPanelProps> = ({ 
  onNoteOn = () => {}, 
  onNoteOff = () => {} 
}) => {
  const whiteKeys = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23]; // C, D, E, F, G, A, B...
  const blackKeys = [1, 3, 6, 8, 10, 13, 15, 18, 20, 22]; // C#, D#, F#, G#, A#...
  const baseNote = 48; // C3
  
  return (
    <div className="h-full flex flex-col p-4 pb-safe">
      <div className="flex-1 relative min-h-[300px] bg-gradient-to-b from-gray-900 to-black rounded-2xl overflow-hidden shadow-2xl">
        {/* White keys */}
        <div className="flex h-full">
          {whiteKeys.map((offset, i) => (
            <button
              key={offset}
              onTouchStart={(e) => {
                e.preventDefault();
                onNoteOn(baseNote + offset);
              }}
              onTouchEnd={(e) => {
                e.preventDefault();
                onNoteOff(baseNote + offset);
              }}
              className="flex-1 bg-gradient-to-b from-white to-gray-200 border-r border-gray-300 active:from-gray-300 active:to-gray-400 rounded-b-lg transition-colors"
              style={{
                boxShadow: 'inset 0 -10px 20px rgba(0,0,0,0.1)',
              }}
            />
          ))}
        </div>
        
        {/* Black keys */}
        <div className="absolute top-0 left-0 right-0 h-[60%] flex pointer-events-none">
          {whiteKeys.map((offset, i) => {
            const hasBlackKey = [0, 2, 5, 7, 9, 12, 14, 17, 19, 21].includes(offset);
            if (!hasBlackKey) return <div key={i} className="flex-1" />;
            
            const blackKeyOffset = offset + 1;
            
            return (
              <div key={i} className="flex-1 flex justify-end">
                <button
                  onTouchStart={(e) => {
                    e.preventDefault();
                    onNoteOn(baseNote + blackKeyOffset);
                  }}
                  onTouchEnd={(e) => {
                    e.preventDefault();
                    onNoteOff(baseNote + blackKeyOffset);
                  }}
                  className="w-[70%] h-full bg-gradient-to-b from-gray-900 to-black rounded-b-lg pointer-events-auto active:from-gray-700 active:to-gray-800 -mr-[35%] z-10 transition-colors shadow-xl"
                  style={{
                    boxShadow: '0 10px 20px rgba(0,0,0,0.5)',
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>
      
      {/* Info text */}
      <div className="mt-4 text-center text-white/50 text-sm">
        <i className="fas fa-music mr-2"></i>
        Clavier virtuel MIDI - C3 à B4
      </div>
    </div>
  );
};

export default KeysPanel;
