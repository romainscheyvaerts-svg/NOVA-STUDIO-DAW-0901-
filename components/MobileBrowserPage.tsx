import React, { useState } from 'react';
import MobileContainer from './MobileContainer';

interface MobileBrowserPageProps {
  onClose?: () => void;
}

/**
 * Page mobile pour naviguer dans les sons, samples et instruments
 */
const MobileBrowserPage: React.FC<MobileBrowserPageProps> = ({ onClose }) => {
  const [activeCategory, setActiveCategory] = useState<'samples' | 'loops' | 'instruments'>('samples');

  const categories = [
    { id: 'samples', name: 'Samples', icon: 'fa-music' },
    { id: 'loops', name: 'Loops', icon: 'fa-redo' },
    { id: 'instruments', name: 'Instruments', icon: 'fa-guitar' }
  ];

  const samplePacks = [
    { id: 1, name: 'Trap Drums', count: 128, category: 'drums' },
    { id: 2, name: 'Lo-Fi Textures', count: 64, category: 'textures' },
    { id: 3, name: 'Vocal Chops', count: 48, category: 'vocals' },
    { id: 4, name: '808 Bass', count: 32, category: 'bass' },
    { id: 5, name: 'Synth Leads', count: 96, category: 'synths' },
    { id: 6, name: 'Piano Melodies', count: 72, category: 'keys' }
  ];

  return (
    <MobileContainer title="Navigateur">
      <div className="space-y-4 pb-20">
        {/* Catégories */}
        <div className="flex gap-2 overflow-x-auto pb-2">
          {categories.map(cat => (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id as any)}
              className={`shrink-0 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                activeCategory === cat.id
                  ? 'bg-cyan-500 text-white'
                  : 'bg-[#14161a] text-slate-400'
              }`}
            >
              <i className={`fas ${cat.icon} mr-2`}></i>
              {cat.name}
            </button>
          ))}
        </div>

        {/* Barre de recherche */}
        <div className="relative">
          <input
            type="text"
            placeholder="Rechercher des sons..."
            className="w-full bg-[#14161a] border border-white/10 rounded-xl px-4 py-3 pl-10 text-white placeholder-slate-500 focus:border-cyan-500/50 focus:outline-none"
          />
          <i className="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm"></i>
        </div>

        {/* Liste des packs */}
        <div className="space-y-2">
          {samplePacks.map(pack => (
            <div
              key={pack.id}
              className="bg-[#14161a] rounded-xl p-4 border border-white/10 hover:border-cyan-500/30 transition-all active:scale-95"
            >
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <h3 className="text-white font-medium">{pack.name}</h3>
                  <p className="text-xs text-slate-500 mt-1">
                    {pack.count} samples • {pack.category}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button className="w-10 h-10 rounded-lg bg-cyan-500/20 text-cyan-400 flex items-center justify-center hover:bg-cyan-500/30 transition-all">
                    <i className="fas fa-play text-xs"></i>
                  </button>
                  <button className="w-10 h-10 rounded-lg bg-white/5 text-slate-400 flex items-center justify-center hover:bg-white/10 transition-all">
                    <i className="fas fa-plus text-xs"></i>
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Message vide */}
        {samplePacks.length === 0 && (
          <div className="text-center py-12 text-slate-500">
            <i className="fas fa-folder-open text-4xl mb-4 opacity-30"></i>
            <p>Aucun son trouvé</p>
            <p className="text-xs mt-2">Essayez une autre catégorie</p>
          </div>
        )}
      </div>
    </MobileContainer>
  );
};

export default MobileBrowserPage;
