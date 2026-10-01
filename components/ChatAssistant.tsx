import React, { useState, useRef, useEffect } from 'react';
import { AIChatMessage, AIAction, DAWState, TrackType } from '../types';
import { VOCAL_MIX_STYLES } from '../utils/vocalPresets';
import { getVocalRole } from '../utils/vocalRoles';
import type { NovaFeedMessage } from '../App';

/** Bouton de réponse rapide affiché sous un message de Nova. */
interface ChatChoice { label: string; action?: AIAction; actions?: AIAction[]; message?: string }
type ChatMessage = AIChatMessage & { choices?: ChatChoice[] };

/** Les styles de mix, proposés en boutons : fonctionne même sans IA. */
const MIX_STYLE_CHOICES: ChatChoice[] = VOCAL_MIX_STYLES.map(s => ({
  label: `${s.emoji} ${s.name}`,
  action: { action: 'APPLY_MIX_STYLE', payload: { style: s.id }, description: `Style « ${s.name} »` },
}));

const MIX_GUIDE_TEXT = "Quel son tu veux pour ta voix ? Choisis un style ci-dessous : je règle les effets, la réverb et le volume du beat. Lance la lecture et change de style pour comparer. Si tu hésites, dis-moi le genre de ton morceau (rap, trap, drill, chant…) et je te conseille.";

interface ChatAssistantProps {
  onSendMessage: (msg: string) => Promise<any>;
  onExecuteAction: (action: AIAction) => void;
  externalNotification?: string | null;
  isMobile?: boolean;
  forceOpen?: boolean;
  onClose?: () => void; // New prop for explicit close action
  /** Etat du projet : sert a calculer l'etape suivante du guide. */
  projectState?: DAWState;
  /** Incrémenté pour ouvrir le chat sur le choix du style de mix. */
  mixGuideRequest?: number;
  /** Messages poussés par le studio (bilan de prise, consignes, écoute du mix). */
  novaFeed?: NovaFeedMessage[];
}

const ChatAssistant: React.FC<ChatAssistantProps> = ({ onSendMessage, onExecuteAction, externalNotification, isMobile, forceOpen, onClose, projectState, mixGuideRequest, novaFeed }) => {
  const [isOpen, setIsOpen] = useState(forceOpen || false);
  const [inputValue, setInputValue] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: '1', role: 'assistant', content: "Salut ! Je suis Nova, ton ingé son. On fait ta session ensemble : ta voix principale d'abord, puis les backs et les harmonies, et je te dis quoi régler dans ton mix. Suis l'étape au-dessus, ou parle-moi quand tu veux.", timestamp: Date.now() }
  ]);

  const pushMixGuide = () => {
    setMessages(prev => [...prev, { id: `mix-${Date.now()}`, role: 'assistant', content: MIX_GUIDE_TEXT, timestamp: Date.now(), choices: MIX_STYLE_CHOICES }]);
  };

  // Demande explicite (bouton « demander à Nova » du panneau Mix auto).
  useEffect(() => {
    if (!mixGuideRequest) return;
    setIsOpen(true);
    pushMixGuide();
  }, [mixGuideRequest]);

  const runChoice = async (c: ChatChoice) => {
    const list = c.actions || (c.action ? [c.action] : []);
    if (list.length) {
      setMessages(prev => [...prev, { id: Date.now().toString(), role: 'user', content: c.label, timestamp: Date.now() }]);
      // Une respiration entre deux actions : la seconde voit l'état de la première.
      for (const a of list) { onExecuteAction(a); await new Promise(r => setTimeout(r, 60)); }
    } else if (c.message) {
      void handleSend(c.message);
    }
  };

  // Messages du studio : ajoutés une seule fois, et le chat s'ouvre (ordinateur).
  const feedSeen = useRef(new Set<string>());
  useEffect(() => {
    if (!novaFeed?.length) return;
    const fresh = novaFeed.filter(m => !feedSeen.current.has(m.id));
    if (!fresh.length) return;
    fresh.forEach(m => feedSeen.current.add(m.id));
    setMessages(prev => [...prev, ...fresh.map(m => ({ id: m.id, role: 'assistant' as const, content: m.content, timestamp: Date.now(), choices: m.choices }))]);
    if (!isMobile) setIsOpen(true);
  }, [novaFeed, isMobile]);

  // Étapes de session que l'artiste a choisi de passer / déjà faites.
  const [sautBacks, setSautBacks] = useState(false);
  const [mixEcoute, setMixEcoute] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (forceOpen) setIsOpen(true);
  }, [forceOpen]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isTyping, isOpen]);

  // FIX: An infinite reopening loop occurred because `isOpen` was in the dependency array. It has been removed to ensure the notification effect only runs when the notification content changes, not when the chat window's visibility state changes.
  useEffect(() => {
    if (externalNotification) {
      const assistantMsg: ChatMessage = {
        id: `notify-${Date.now()}`,
        role: 'assistant',
        content: externalNotification,
        timestamp: Date.now(),
      };
      setMessages(prev => [...prev, assistantMsg]);
    }
  }, [externalNotification]); 

  const handleSend = async (customMsg?: string) => {
    const msgToSend = customMsg || inputValue;
    if (!msgToSend.trim()) return;

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: msgToSend,
      timestamp: Date.now()
    };

    setMessages(prev => [...prev, userMsg]);
    setInputValue('');
    setIsTyping(true);

    try {
      const response = await onSendMessage(msgToSend);
      setIsTyping(false);
      
      const responseText = typeof response === 'string' ? response : (response.text || "");
      const responseActions = response.actions || [];

      if (responseActions && responseActions.length > 0) {
        setIsSyncing(true);
        // Les actions sont appliquees une par une avec une respiration : une
        // action qui cible une piste ou un clip cree par la precedente ne les
        // trouvait pas, l'etat React n'ayant pas encore ete commite.
        for (const action of responseActions) {
          onExecuteAction(action);
          await new Promise(resolve => setTimeout(resolve, 40));
        }
        setIsSyncing(false);
      }

      const assistantMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: responseText || "Réglages de mixage effectués.",
        timestamp: Date.now(),
        executedAction: responseActions?.map((a: any) => a.description || a.action).join(', ')
      };
      
      setMessages(prev => [...prev, assistantMsg]);
    } catch (error: any) {
      setIsTyping(false);
      setMessages(prev => [...prev, { id: Date.now().toString(), role: 'assistant', content: "Désolé, je n'arrive pas à contacter le serveur sécurisé.", timestamp: Date.now() }]);
    }
  };

  /**
   * Etape suivante, deduite de l'etat reel du projet.
   *
   * Le guide est volontairement calcule ici et non demande au modele : il doit
   * fonctionner meme sans cle API, et rester juste a la seconde pres. L'IA
   * repond aux questions libres, elle ne porte pas le fil conducteur.
   */
  // « A-t-il deja ecoute ? » est un fait acquis, pas un etat instantane.
  // S'appuyer sur currentTime rendait l'etape dependante du rafraichissement
  // d'affichage : mettre en pause, ou jouer dans un onglet en arriere-plan,
  // faisait reculer le guide.
  const aDejaEcoute = React.useRef(false);
  React.useEffect(() => {
    if (projectState?.isPlaying || (projectState?.currentTime || 0) > 0.5) {
      aDejaEcoute.current = true;
    }
  }, [projectState?.isPlaying, projectState?.currentTime]);

  const etape = React.useMemo((): { numero: number; icone: string; titre: string; detail: string; mix?: boolean; boutons?: ChatChoice[] } => {
    const pistes = projectState?.tracks || [];
    const beat = pistes.find(t => t.id === 'instrumental');
    const aUnePrise = pistes.some(t => t.type === TrackType.AUDIO && t.id !== 'instrumental' && !t.instrumentId && t.clips.length > 0);
    const aDesSecondaires = pistes.some(t => ['back', 'harmony', 'adlib'].includes(getVocalRole(t)) && t.clips.length > 0);

    if (!beat || beat.clips.length === 0) return {
      numero: 1, icone: 'fa-compact-disc',
      titre: 'Choisis un instrumental',
      detail: isMobile
        ? "Ouvre l'onglet « Sons » en bas, écoute les beats, puis appuie sur « Essayer » : le studio se règle tout seul sur son tempo et sa tonalité."
        : "Dans le catalogue à gauche, écoute les beats puis clique « Essayer » : le studio se règle tout seul sur son tempo et sa tonalité."
    };
    if (!aDejaEcoute.current && !projectState?.isPlaying) return {
      numero: 2, icone: 'fa-play',
      titre: 'Écoute ton instru',
      detail: isMobile
        ? "Appuie sur le bouton lecture ▶ en haut pour écouter le beat. Rappuie pour mettre en pause."
        : "Appuie sur la barre d'espace (ou le bouton lecture ▶) pour écouter le beat. Rappuie pour mettre en pause."
    };
    if (!aUnePrise) return {
      numero: 3, icone: 'fa-microphone',
      titre: 'Enregistre ta voix principale',
      detail: "Appuie sur le bouton rouge REC : le micro s'active tout seul (accepte l'autorisation), un décompte 4-3-2-1 se lance, puis chante. Réappuie sur REC pour arrêter."
    };
    if (!projectState?.vocalMixStyle) return {
      numero: 4, icone: 'fa-sliders',
      titre: 'Choisis un style de mix',
      detail: "Appuie sur « Mix auto » et choisis un style : Rap clair, Trap autotune, Drill, Chant / R&B… Ou demande-moi conseil.",
      mix: true,
    };
    if (!aDesSecondaires && !sautBacks) return {
      numero: 5, icone: 'fa-layer-group',
      titre: 'Ajoute des backs',
      detail: "Comme en studio : rechante tes fins de phrase et tes punchlines sur une piste à part, pour les appuyer. Ensuite harmonies et ad-libs si tu veux.",
      boutons: [
        { label: '🎤 Préparer les backs', action: { action: 'PREPARE_PART', payload: { part: 'back' } } },
        { label: 'Pas de backs', message: '' },
      ],
    };
    if (!mixEcoute) return {
      numero: 6, icone: 'fa-headphones',
      titre: "Fais écouter ton mix à Nova",
      detail: "Je mesure tes niveaux (voix, beat, backs) et je te dis quoi réajuster, en te montrant où.",
      boutons: [{ label: '🎧 Écoute mon mix', action: { action: 'ANALYZE_MIX', payload: {} } }],
    };
    return {
      numero: 6, icone: 'fa-star',
      titre: 'Ton morceau prend forme',
      detail: "Refais une prise si besoin (l'ancienne est coupée, pas effacée), essaie un autre style, redemande-moi une écoute. Ctrl+Z annule. Pour exporter, il faut acheter l'instrumental."
    };
  }, [projectState, isMobile, sautBacks, mixEcoute]);

  // Dès la première prise, Nova propose les styles de mix (une seule fois).
  const mixGuideShown = useRef(false);
  useEffect(() => {
    if (etape.numero === 4 && !mixGuideShown.current) {
      mixGuideShown.current = true;
      pushMixGuide();
    }
  }, [etape.numero]);

  // Raccourcis : les trois premiers agissent directement (même sans IA).
  const QUICK_ACTIONS: { label: string; icon: string; run: () => void }[] = [
    { label: 'Écoute mon mix', icon: 'fa-headphones', run: () => { setMixEcoute(true); void runChoice({ label: '🎧 Écoute mon mix', action: { action: 'ANALYZE_MIX', payload: {} } }); } },
    { label: 'Mix auto', icon: 'fa-sliders', run: pushMixGuide },
    { label: 'Faire les backs', icon: 'fa-layer-group', run: () => void runChoice({ label: '🎤 Faire les backs', action: { action: 'PREPARE_PART', payload: { part: 'back' } } }) },
    { label: 'Retirer les blancs', icon: 'fa-broom', run: () => void runChoice({ label: '🧹 Retirer les blancs', action: { action: 'CLEAN_SILENCE', payload: {}, description: 'Retirer les blancs' } }) },
    { label: 'Conseille-moi', icon: 'fa-lightbulb', run: () => void handleSend("Écoute l'état de mon projet et conseille-moi le style de mix qui irait le mieux à ma voix sur ce beat.") },
  ];

  const containerClass = isMobile 
    ? "fixed inset-0 z-[50] bg-[#0c0d10] flex flex-col pb-20"
    : "fixed bottom-6 right-6 z-[500] flex flex-col items-end";

  const windowClass = isMobile
    ? "w-full h-full flex flex-col"
    : "w-[440px] h-[600px] bg-[#0c0d10]/90 border border-cyan-500/20 rounded-[40px] shadow-[0_0_100px_rgba(0,0,0,0.9)] flex flex-col overflow-hidden mb-4 animate-in slide-in-from-bottom-4 duration-500 backdrop-blur-3xl";

  if (isMobile && !isOpen) return null;

  return (
    <div className={containerClass}>
      {isOpen && (
        <div className={windowClass}>
          <div className="p-6 border-b border-white/5 flex justify-between items-center bg-gradient-to-br from-cyan-500/10 to-transparent">
            <div className="flex items-center space-x-5">
              <div className={`w-12 h-12 rounded-[18px] flex items-center justify-center transition-all duration-700 ${isSyncing ? 'bg-cyan-500 text-black shadow-[0_0_30px_#00f2ff]' : 'bg-white/5 text-cyan-400'}`}>
                <i className={`fas ${isSyncing ? 'fa-sync fa-spin' : 'fa-wave-square'} text-xl`}></i>
              </div>
              <div>
                <h3 className="text-[13px] font-black uppercase tracking-[0.3em] text-white">Nova</h3>
                <div className="flex items-center space-x-2 mt-1">
                  <div className={`w-1.5 h-1.5 rounded-full ${isSyncing ? 'bg-cyan-400 animate-ping' : 'bg-green-500'}`}></div>
                  <span className="text-[10px] font-bold text-slate-400">{isSyncing ? 'Je règle ton projet…' : 'Ton ingé son'}</span>
                </div>
              </div>
            </div>
            
            <button 
              onClick={(e) => { 
                  e.stopPropagation(); 
                  setIsOpen(false);
                  if (onClose) onClose(); 
              }} 
              className="w-10 h-10 rounded-full bg-white/5 text-slate-500 hover:text-white transition-all flex items-center justify-center border border-white/10 active:bg-red-500/20 active:text-red-500"
            >
              <i className="fas fa-times text-sm"></i>
            </button>
          </div>

          {/* Fil conducteur : l'etape suivante, toujours visible.
              Elle ne depend pas du modele et reste donc juste meme sans cle API. */}
          <div className="px-5 py-4 border-b border-white/5 bg-gradient-to-b from-cyan-500/[0.07] to-transparent">
            <div className="flex items-start gap-3">
              <div className="nova-halo flex-shrink-0 w-9 h-9 rounded-xl bg-cyan-500/15 border border-cyan-500/40
                              flex items-center justify-center text-cyan-300">
                <i className={`fas ${etape.icone} text-[13px]`}></i>
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold text-cyan-400/80 tracking-wide">ÉTAPE {etape.numero} / 6</span>
                </div>
                <h4 className="text-[14px] font-bold text-white mt-0.5">{etape.titre}</h4>
                <p className="text-[12px] leading-relaxed text-slate-300/90 mt-1">{etape.detail}</p>
                {etape.mix && (
                  <button type="button" onClick={pushMixGuide} className="mt-2 h-9 px-3 rounded-lg bg-cyan-500 text-black text-[11px] font-black">
                    Voir les styles
                  </button>
                )}
                {etape.boutons && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {etape.boutons.map((b, i) => (
                      <button
                        key={b.label}
                        type="button"
                        onClick={() => {
                          if (b.label === 'Pas de backs') { setSautBacks(true); return; }
                          if (b.action?.action === 'ANALYZE_MIX') setMixEcoute(true);
                          void runChoice(b);
                        }}
                        className={`h-9 px-3 rounded-lg text-[11px] font-black ${i === 0 ? 'bg-cyan-500 text-black' : 'bg-white/10 text-white'}`}
                      >
                        {b.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="px-6 py-4 bg-black/40 flex space-x-3 border-b border-white/5 overflow-x-auto no-scrollbar">
            {QUICK_ACTIONS.map((action, i) => (
              <button 
                key={i}
                onClick={action.run}
                className="flex-shrink-0 px-4 py-2.5 bg-white/5 border border-white/10 rounded-2xl hover:bg-cyan-500 hover:text-black hover:border-cyan-400 transition-all flex items-center space-x-2 group"
              >
                <i className={`fas ${action.icon} text-[10px]`}></i>
                <span className="text-[11px] font-semibold tracking-tight">{action.label}</span>
              </button>
            ))}
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-6 custom-scroll bg-[radial-gradient(circle_at_top,rgba(6,182,212,0.03),transparent)]">
            {messages.map(msg => (
              <div key={msg.id} className="animate-in fade-in slide-in-from-bottom-2">
                <div className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] p-5 rounded-[24px] text-[12px] font-medium leading-relaxed shadow-xl ${
                    msg.role === 'user' 
                      ? 'bg-cyan-500 text-black rounded-tr-none' 
                      : 'bg-white/[0.04] border border-white/10 text-slate-300 rounded-tl-none'
                  }`}>
                    {msg.content}
                  </div>
                </div>
                {msg.choices && msg.choices.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-3 pl-1">
                    {msg.choices.map(c => (
                      <button
                        key={c.label}
                        type="button"
                        onClick={() => void runChoice(c)}
                        className={`h-10 px-3.5 rounded-xl border text-[12px] font-bold transition-all active:scale-95 ${
                          c.action?.payload?.style && c.action.payload.style === projectState?.vocalMixStyle
                            ? 'bg-cyan-500 text-black border-cyan-400'
                            : 'bg-white/5 border-white/15 text-white hover:border-cyan-500/60'
                        }`}
                      >
                        {c.label}
                      </button>
                    ))}
                  </div>
                )}
                {msg.executedAction && (
                  <div className="flex justify-start pl-2 mt-3">
                    <div className="flex items-center space-x-3 bg-cyan-500/5 border border-cyan-500/10 px-4 py-2 rounded-full shadow-inner">
                      <div className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-pulse"></div>
                      <span className="text-[10px] font-black text-cyan-500/80 uppercase tracking-tighter italic">{msg.executedAction}</span>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {isTyping && (
              <div className="flex justify-start">
                <div className="bg-white/[0.02] p-5 rounded-2xl flex items-center space-x-3">
                  <div className="flex space-x-1">
                    <div className="w-1 h-1 bg-cyan-500/60 rounded-full animate-bounce"></div>
                    <div className="w-1 h-1 bg-cyan-500/60 rounded-full animate-bounce [animation-delay:0.2s]"></div>
                    <div className="w-1 h-1 bg-cyan-500/60 rounded-full animate-bounce [animation-delay:0.4s]"></div>
                  </div>
                  <span className="text-[10px] font-black uppercase text-slate-500 italic tracking-widest">L'ingénieur analyse...</span>
                </div>
              </div>
            )}
          </div>

          <div className="p-6 bg-[#08090b] border-t border-white/5">
            <div className="relative flex items-center">
              <input 
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                placeholder="Ex : « rends ma voix plus pro » ou « style trap »"
                className="w-full bg-white/[0.03] border border-white/10 rounded-2xl py-4 pl-6 pr-16 text-[12px] text-white focus:outline-none focus:border-cyan-500/40 transition-all placeholder:text-slate-700"
              />
              <button 
                onClick={() => handleSend()}
                className="absolute right-2.5 w-10 h-10 bg-cyan-500 text-black rounded-xl flex items-center justify-center hover:bg-cyan-400 shadow-xl transition-all active:scale-90"
              >
                <i className="fas fa-arrow-up text-xs"></i>
              </button>
            </div>
          </div>
        </div>
      )}

      {!isMobile && (
        <button 
          onClick={() => setIsOpen(!isOpen)}
          className={`w-20 h-20 rounded-[32px] flex items-center justify-center shadow-[0_0_50px_rgba(0,242,255,0.2)] transition-all duration-500 hover:scale-110 active:scale-90 group relative ${
            isOpen ? 'bg-white text-black rotate-90' : 'bg-[#0f1115] border border-cyan-500/30 text-cyan-400'
          }`}
        >
          {isOpen ? <i className="fas fa-chevron-down text-xl"></i> : (
            <>
              <i className="fas fa-wand-magic-sparkles text-2xl group-hover:animate-pulse"></i>
              {isSyncing && <div className="absolute inset-0 rounded-[32px] border-4 border-cyan-500 animate-ping"></div>}
            </>
          )}
        </button>
      )}
    </div>
  );
};

export default ChatAssistant;
