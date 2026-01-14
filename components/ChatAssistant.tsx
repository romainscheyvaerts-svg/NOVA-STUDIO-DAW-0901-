import React, { useState, useRef, useEffect } from 'react';
import { AIChatMessage, AIAction } from '../types';

interface ChatAssistantProps {
  // CORRECTION: On accepte 'any' pour éviter le blocage Vercel si App.tsx renvoie juste un string
  onSendMessage: (msg: string) => Promise<any>;
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

    // Suppression définitive de la vérification API_KEY locale

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
      // Appel au serveur
      const rawResponse = await onSendMessage(msgToSend);
      setIsTyping(false);
      
      // --- CORRECTION INTELLIGENTE ---
      // On vérifie si c'est juste du texte (ancienne version) ou un objet (nouvelle version)
      let responseText = "";
      let responseActions: AIAction[] = [];

      if (typeof rawResponse === 'string') {
          responseText = rawResponse;
      } else if (rawResponse && typeof rawResponse === 'object') {
          responseText = rawResponse.text || "";
          responseActions = rawResponse.actions || [];
      }
      // -------------------------------

      if (responseActions.length > 0) {
        setIsSyncing(true);
        setTimeout(() => setIsSyncing(false), 1500);
        responseActions.forEach(action => {
            onExecuteAction(action);
        });
      }

      const assistantMsg: AIChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: responseText || "Réglages effectués.",
        timestamp: Date.now(),
        executedAction: responseActions.map(a => a.description || a.action).join(', ')
      };
      
      setMessages(prev => [...prev, assistantMsg]);
    } catch (error: any) {
      setIsTyping(false);
      setMessages(prev => [...prev, { id: Date.now().toString(), role: 'assistant', content: "Erreur serveur. Vérifiez que le déploiement Vercel est actif.", timestamp: Date.now() }]);
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
              <div
