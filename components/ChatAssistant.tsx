
import React, { useState, useRef, useEffect } from 'react';
import { AIChatMessage, AIAction } from '../types';

interface ChatAssistantProps {
  onSendMessage: (msg: string) => Promise<{ text: string, actions: AIAction[] }>;
  onExecuteAction: (action: AIAction) => void;
  externalNotification?: string | null;
  isMobile?: boolean;
  forceOpen?: boolean;
  onClose?: () => void; // New prop for explicit close action
}

const ChatAssistant: React.FC<ChatAssistantProps> = ({ onSendMessage, onExecuteAction, externalNotification, isMobile, forceOpen, onClose }) => {
  const [isOpen, setIsOpen] = useState(forceOpen || false);
  const [inputValue, setInputValue] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [messages, setMessages] = useState<AIChatMessage[]>([
    { id: '1', role: 'assistant', content: 'Studio Master Online. Je pilote ton mix, calage du BPM et chaîne FX.', timestamp: Date.now() }
  ]);
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

  // FIX: Correction de la boucle de réouverture infinie
  useEffect(() => {
    if (externalNotification) {
      const assistantMsg: AIChatMessage = {
        id: `notify-${Date.now()}`,
        role: 'assistant',
        content: externalNotification,
        timestamp: Date.now(),
      };
      setMessages(prev => [...prev, assistantMsg]);
      
      // MODIFICATION : On ne force PLUS l'ouverture automatique (intrusive)
      // Si l'utilisateur veut voir le log, il ouvrira le chat.
      // if (!isOpen && !isMobile) setIsOpen(true); 
    }
    // IMPORTANT : On retire 'isOpen' et 'isMobile' des dépendances pour éviter 
    // que la fermeture de la fenêtre ne redéclenche ce code si la notification est toujours présente.
  }, [externalNotification]); 

  const handleSend = async (customMsg?: string) => {
    const msgToSend = customMsg || inputValue;
    if (!msgToSend.trim()) return;

    if (!process.env.API_KEY) {
        setMessages(prev => [...prev, {
            id: Date.now().toString(),
            role: 'assistant',
            content: "⚠️ Clé API manquante. L'assistant ne peut pas répondre. Configurez votre API_KEY.",
            timestamp: Date.now()
        }]);
        return;
    }

    const userMsg: AIChatMessage = {
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
      
      if (response.actions && response.actions.length > 0) {
        setIsSyncing(true);
        setTimeout(() => setIsSyncing(false), 1500);
        response.actions.forEach(action => {
            onExecuteAction(action);
        });
      }

      const assistantMsg: AIChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: response.text || "Réglages de mixage effectués.",
        timestamp: Date.now(),
        executedAction: response.actions?.map(a => a.description || a.action).join(', ')
      };
      
      setMessages(prev => [...prev, assistantMsg]);
    } catch (error: any) {
      setIsTyping(false);
      setMessages(prev => [...prev, { id: Date.now().toString(), role: 'assistant', content: "Erreur de liaison avec le DSP. Réessaie.", timestamp: Date.now() }]);
    }
  };

  const QUICK_ACTIONS = [
    { label: 'Caler Instru', icon: 'fa-sync-alt', msg: 'Analyse mon instru et cale le BPM' },
    { label: 'Effet Téléphone', icon: 'fa-phone', msg: 'Donne un effet téléphone à ma voix' },
    { label: 'Nettoyer Voix', icon: 'fa-broom', msg: 'Nettoie ma voix, enlève la boue' },
    { label: 'Reset Mix', icon: 'fa-undo', msg: 'Reset tous mes effets' },
  ];

  const containerClass = isMobile 
    ? "fixed inset-0 z-[50] bg-[#0c0d10] flex flex-col pb-20"
    : "fixed bottom-6 right-6 z-[500] flex flex-col items-end";

  const windowClass = isMobile
    ? "w-full h-full flex flex-col"
    : "w-[440px] h-[600px] bg-[#0c0d10]/90 border border-cyan-500/20 rounded-[40px] shadow-[0_0_100px_rgba(0,0,0,0.9)] flex flex-col overflow-hidden mb-4 animate-in slide-in-from-bottom-4 duration-500 backdrop-blur-3xl";

  // Note: On mobile, closing via button will set isOpen=false, making this return null, 
  // effectively hiding the content even if the tab is still technically 'NOVA' for a split second 
  // until the onClose callback updates the parent state.
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
                <h3 className="text-[13px] font-black uppercase tracking-[0.3em] text-white">Studio Master AI</h3>
                <div className="flex items-center space-x-2 mt-1">
                  <div className={`w-1.5 h-1.5 rounded-full ${isSyncing ? 'bg-cyan-400 animate-ping' : 'bg-green-500'}`}></div>
                  <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest">{isSyncing ? 'Engine Sync...' : 'Direct DSP Link Active'}</span>
                </div>
              </div>
            </div>
            
            {/* CLOSE BUTTON - NOW VISIBLE ON MOBILE TOO */}
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

          <div className="px-6 py-4 bg-black/40 flex space-x-3 border-b border-white/5 overflow-x-auto no-scrollbar">
            {QUICK_ACTIONS.map((action, i) => (
              <button 
                key={i}
                onClick={() => handleSend(action.msg)}
                className="flex-shrink-0 px-4 py-2.5 bg-white/5 border border-white/10 rounded-2xl hover:bg-cyan-500 hover:text-black hover:border-cyan-400 transition-all flex items-center space-x-2 group"
              >
                <i className={`fas ${action.icon} text-[10px]`}></i>
                <span className="text-[9px] font-black uppercase tracking-tighter">{action.label}</span>
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
                placeholder="Ex: 'Donne un effet téléphone à ma voix...'"
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
              <i className="fas fa-sparkles text-2xl group-hover:animate-pulse"></i>
              {isSyncing && <div className="absolute inset-0 rounded-[32px] border-4 border-cyan-500 animate-ping"></div>}
            </>
          )}
        </button>
      )}
    </div>
  );
};

export default ChatAssistant;
