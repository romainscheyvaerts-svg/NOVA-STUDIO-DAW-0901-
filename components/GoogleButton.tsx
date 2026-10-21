import React from 'react';

/** Logo Google officiel (même rendu que sur studiomakemusic.com). */
export const GoogleLogo: React.FC<{ className?: string }> = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
  </svg>
);

/** « Continuer avec Google » + séparateur « ou », au-dessus du formulaire e-mail (comme sur le site). */
export const GoogleButton: React.FC<{ onClick: () => void; disabled?: boolean }> = ({ onClick, disabled }) => (
  <>
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-12 w-full items-center justify-center rounded-xl border border-white/15 bg-white/[0.04] text-[14px] font-bold text-white transition hover:bg-white/[0.08] focus:outline-none focus:ring-2 focus:ring-cyan-400/30 disabled:opacity-40"
    >
      <GoogleLogo className="mr-2 h-5 w-5" />
      Continuer avec Google
    </button>
    <div className="relative" aria-hidden="true">
      <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-white/10" /></div>
      <div className="relative flex justify-center text-[11px] uppercase tracking-wider">
        <span className="bg-nv-surface px-2 text-slate-500">ou</span>
      </div>
    </div>
  </>
);
