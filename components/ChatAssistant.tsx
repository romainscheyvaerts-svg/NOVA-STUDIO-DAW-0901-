import React, { useState, useRef, useEffect } from 'react';
import { AIChatMessage, AIAction } from '../types';

interface ChatAssistantProps {
  onSendMessage: (msg: string) => Promise<{ text: string, actions: AIAction[] }>;
  onExecuteAction: (action: AIAction) => void;
  externalNotification?: string | null;
  isMobile?: boolean;
  forceOpen?: boolean;
  onClose?: () => void;
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

  useEffect(() => {
    if (externalNotification) {
      const assistantMsg: AIChatMessage = {
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

    // --- CORRECTION : On a supprimé la vérification locale de l'API KEY ---
    // On fait confiance au serveur Vercel pour gérer ça.

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
      // On envoie le message à App.tsx (qui l'enverra à Vercel)
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
      // Si Vercel renvoie une erreur, on l'affiche ici
      setMessages(prev => [...prev, { id: Date.now().toString(), role: 'assistant', content: "Erreur de connexion IA. Vérifiez que le déploiement Vercel est actif.", timestamp: Date.now() }]);
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
            
            <button 
              onClick={(e) => { 
                  e.stopPropagation(); 
                  setIsOpen(false);
                  if (onClose) onClose(); 
              }} 
              className="w-10 h-10 rounded-full bg-white/5 text-slate-500 hover
