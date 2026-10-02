import React, { useEffect, useState } from 'react';

/**
 * « Installer l'app » : Nova Studio sur l'écran d'accueil du téléphone.
 * Android / Chrome : vraie invite d'installation (beforeinstallprompt).
 * iPhone : Safari n'a pas d'invite, on explique le geste (Partager → Sur
 * l'écran d'accueil). Masqué si déjà installé ou dans le cadre du site.
 */
const InstallAppButton: React.FC<{ className?: string }> = ({ className }) => {
  const [prompt, setPrompt] = useState<any>(null);
  const [iosHelp, setIosHelp] = useState(false);
  const standalone = typeof window !== 'undefined' &&
    (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true);
  const inFrame = typeof window !== 'undefined' && window.top !== window.self;
  const isIOS = typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent);

  useEffect(() => {
    const onPrompt = (e: Event) => { e.preventDefault(); setPrompt(e); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  if (standalone || inFrame || (!prompt && !isIOS)) return null;

  return (
    <>
      <button
        type="button"
        onClick={async () => {
          if (prompt) { prompt.prompt(); await prompt.userChoice.catch(() => null); setPrompt(null); }
          else setIosHelp(true);
        }}
        className={className || 'h-9 px-3 rounded-lg bg-white/10 text-white text-[12px] font-bold hover:bg-white/20 flex items-center gap-2'}
      >
        <i className="fas fa-mobile-screen-button" /> Installer l'app
      </button>
      {iosHelp && (
        <div className="fixed inset-0 z-[900] bg-black/70 flex items-end sm:items-center justify-center p-4" onClick={() => setIosHelp(false)} role="dialog" aria-modal="true">
          <div className="w-full max-w-sm rounded-3xl bg-[#14161a] border border-white/10 p-6 text-center" onClick={e => e.stopPropagation()}>
            <div className="text-4xl mb-2">📲</div>
            <h2 className="text-lg font-black text-white mb-2">Installer Nova Studio</h2>
            <p className="text-sm text-slate-300">
              Dans Safari, touche <b>Partager</b> <i className="fas fa-arrow-up-from-bracket mx-1" /> puis
              <b> « Sur l'écran d'accueil »</b>. Nova Studio s'ouvrira en plein écran, comme une app.
            </p>
            <button type="button" onClick={() => setIosHelp(false)} className="mt-5 h-11 w-full rounded-xl bg-cyan-500 text-black font-black">OK</button>
          </div>
        </div>
      )}
    </>
  );
};

export default InstallAppButton;
