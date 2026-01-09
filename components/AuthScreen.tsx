
import React, { useState, useEffect } from 'react';
import { AuthStage, User } from '../types';
import { authService } from '../services/AuthService';
import { isSupabaseConfigured } from '../services/supabase';

interface AuthScreenProps {
  onAuthenticated: (user: User) => void;
}

const AuthScreen: React.FC<AuthScreenProps> = ({ onAuthenticated }) => {
  const [stage, setStage] = useState<AuthStage>('LOGIN');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  
  // Form States
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [username, setUsername] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [rememberMe, setRememberMe] = useState(false); // Nouvelle option

  // Check si Supabase est configuré
  const useRealAuth = isSupabaseConfigured();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccessMsg(null);
    
    // On passe le flag rememberMe
    const result = await authService.login(email, password, rememberMe);
    setLoading(false);
    
    if (result.success && result.user) {
      onAuthenticated(result.user);
    } else {
      setError(result.message || "Erreur de connexion");
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError("Les mots de passe ne correspondent pas.");
      return;
    }
    
    setLoading(true);
    setError(null);
    setSuccessMsg(null);

    const result = await authService.register(email, password, username);
    setLoading(false);

    if (result.success) {
      setStage('VERIFY_EMAIL');
    } else {
      setError(result.message || "Erreur d'inscription");
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Si Supabase, on ne vérifie pas le code ici, c'est le lien email qui fait le travail
    if (useRealAuth) {
        window.open('https://mail.google.com', '_blank'); // Helper pour ouvrir les mails
        return;
    }

    setLoading(true);
    setError(null);

    const result = await authService.verifyEmail(verifyCode);
    setLoading(false);

    if (result.success && result.user) {
      onAuthenticated(result.user);
    } else {
      setError(result.message || "Code invalide");
    }
  };

  const handleGuestAccess = async () => {
      setLoading(true);
      setError(null);
      try {
          const user = await authService.loginAsGuest();
          onAuthenticated(user);
      } catch(e) {
          setError("Erreur accès invité");
          setLoading(false);
      }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
      e.preventDefault();
      if (!email) {
          setError("Veuillez entrer votre email.");
          return;
      }
      setLoading(true);
      setError(null);
      setSuccessMsg(null);

      const result = await authService.sendPasswordReset(email);
      setLoading(false);

      if (result.success) {
          setSuccessMsg(result.message || "Email envoyé.");
      } else {
          setError(result.message || "Erreur d'envoi.");
      }
  };

  return (
    <div className="fixed inset-0 z-[9999] bg-[#0c0d10] flex items-center justify-center p-4">
      {/* Background Ambience */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-cyan-900/20 via-[#0c0d10] to-[#0c0d10]"></div>
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
         <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-cyan-500/10 rounded-full blur-[100px]"></div>
         <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-500/10 rounded-full blur-[100px]"></div>
      </div>

      <div className="relative w-full max-w-md bg-[#14161a] border border-white/10 rounded-[32px] p-8 shadow-2xl backdrop-blur-xl animate-in fade-in zoom-in duration-500">
        
        {/* LOGO AREA */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center text-white shadow-[0_0_30px_rgba(6,182,212,0.4)] mb-4">
            <i className="fas fa-wave-square text-3xl"></i>
          </div>
          <h1 className="text-2xl font-black uppercase tracking-[0.3em] text-white">Nova <span className="text-cyan-400">DAW</span></h1>
          <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mt-2">Next Gen Audio Production</p>
          {!useRealAuth && <span className="text-[8px] text-amber-500 font-mono mt-1">MODE SIMULATION (NO BACKEND)</span>}
        </div>

        {/* --- LOGIN FORM --- */}
        {stage === 'LOGIN' && (
          <form onSubmit={handleLogin} className="space-y-5">
            <div>
              <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1 mb-1 block">Email</label>
              <input 
                type="email" 
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full h-12 bg-black/40 border border-white/10 rounded-xl px-4 text-white focus:border-cyan-500 focus:outline-none transition-colors placeholder:text-slate-700"
                placeholder="producer@studio.com"
              />
            </div>
            <div>
              <div className="flex justify-between items-center mb-1">
                  <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1">Mot de passe</label>
                  <button type="button" onClick={() => { setError(null); setSuccessMsg(null); setStage('FORGOT_PASSWORD'); }} className="text-[9px] text-cyan-500 hover:text-cyan-400 transition-colors">Oublié ?</button>
              </div>
              <input 
                type="password" 
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full h-12 bg-black/40 border border-white/10 rounded-xl px-4 text-white focus:border-cyan-500 focus:outline-none transition-colors placeholder:text-slate-700"
                placeholder="••••••••"
              />
            </div>

            {/* REMEMBER ME OPTION */}
            <div className="flex items-center space-x-2 px-1">
                <input 
                    type="checkbox" 
                    id="remember" 
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="w-4 h-4 rounded border-white/20 bg-black/40 text-cyan-500 focus:ring-cyan-500/50 cursor-pointer accent-cyan-500"
                />
                <label htmlFor="remember" className="text-[10px] font-bold text-slate-400 cursor-pointer select-none hover:text-white transition-colors uppercase tracking-wide">
                    Se souvenir de moi
                </label>
            </div>

            <button 
              type="submit" 
              disabled={loading}
              className="w-full h-14 bg-cyan-500 hover:bg-cyan-400 text-black rounded-xl text-[11px] font-black uppercase tracking-[0.2em] shadow-lg shadow-cyan-500/20 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
            >
              {loading ? <i className="fas fa-spinner fa-spin"></i> : "Se Connecter"}
            </button>

            <div className="text-center pt-2">
              <span className="text-[10px] text-slate-500">Pas encore de compte ? </span>
              <button 
                type="button" 
                onClick={() => { setError(null); setSuccessMsg(null); setStage('REGISTER'); }}
                className="text-[10px] font-bold text-cyan-400 hover:text-white transition-colors uppercase tracking-wide"
              >
                Créer un compte
              </button>
            </div>
          </form>
        )}

        {/* --- REGISTER FORM --- */}
        {stage === 'REGISTER' && (
          <form onSubmit={handleRegister} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
                <div>
                    <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest ml-1 mb-1 block">Pseudo</label>
                    <input type="text" required value={username} onChange={(e) => setUsername(e.target.value)} className="w-full h-10 bg-black/40 border border-white/10 rounded-xl px-3 text-white text-sm focus:border-cyan-500 focus:outline-none transition-colors" />
                </div>
                <div>
                    <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest ml-1 mb-1 block">Email</label>
                    <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-full h-10 bg-black/40 border border-white/10 rounded-xl px-3 text-white text-sm focus:border-cyan-500 focus:outline-none transition-colors" />
                </div>
            </div>
            <div>
              <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest ml-1 mb-1 block">Mot de passe</label>
              <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className="w-full h-10 bg-black/40 border border-white/10 rounded-xl px-3 text-white text-sm focus:border-cyan-500 focus:outline-none transition-colors" />
            </div>
            <div>
              <label className="text-[9px] font-black text-slate-500 uppercase tracking-widest ml-1 mb-1 block">Confirmer</label>
              <input type="password" required value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className="w-full h-10 bg-black/40 border border-white/10 rounded-xl px-3 text-white text-sm focus:border-cyan-500 focus:outline-none transition-colors" />
            </div>

            <button 
              type="submit" 
              disabled={loading}
              className="w-full h-12 bg-white hover:bg-slate-200 text-black rounded-xl text-[10px] font-black uppercase tracking-[0.2em] transition-all active:scale-95 disabled:opacity-50 mt-2 flex items-center justify-center"
            >
              {loading ? <i className="fas fa-spinner fa-spin"></i> : "S'inscrire"}
            </button>

            <div className="text-center pt-1">
              <button 
                type="button" 
                onClick={() => { setError(null); setSuccessMsg(null); setStage('LOGIN'); }}
                className="text-[9px] font-bold text-slate-500 hover:text-white transition-colors uppercase tracking-wide"
              >
                Retour Connexion
              </button>
            </div>
          </form>
        )}

        {/* --- FORGOT PASSWORD FORM --- */}
        {stage === 'FORGOT_PASSWORD' && (
            <form onSubmit={handleForgotPassword} className="space-y-6">
                <div>
                    <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest ml-1 mb-1 block">Email du compte</label>
                    <input 
                        type="email" 
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="w-full h-12 bg-black/40 border border-white/10 rounded-xl px-4 text-white focus:border-cyan-500 focus:outline-none transition-colors placeholder:text-slate-700"
                        placeholder="producer@studio.com"
                    />
                </div>
                <button 
                    type="submit" 
                    disabled={loading}
                    className="w-full h-14 bg-purple-600 hover:bg-purple-500 text-white rounded-xl text-[11px] font-black uppercase tracking-[0.2em] shadow-lg shadow-purple-500/20 transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center"
                >
                    {loading ? <i className="fas fa-spinner fa-spin"></i> : "Envoyer le lien"}
                </button>
                <div className="text-center pt-1">
                    <button 
                        type="button" 
                        onClick={() => { setError(null); setSuccessMsg(null); setStage('LOGIN'); }}
                        className="text-[9px] font-bold text-slate-500 hover:text-white transition-colors uppercase tracking-wide"
                    >
                        Annuler
                    </button>
                </div>
            </form>
        )}

        {/* --- VERIFY EMAIL STAGE --- */}
        {stage === 'VERIFY_EMAIL' && (
          <form onSubmit={handleVerify} className="space-y-6 text-center">
            <div className="bg-cyan-500/10 border border-cyan-500/20 rounded-2xl p-6 mb-4">
               <i className="fas fa-envelope-open-text text-4xl text-cyan-400 mb-3"></i>
               <h3 className="text-white font-bold text-sm">Vérifiez vos emails</h3>
               <p className="text-slate-400 text-xs mt-2 leading-relaxed">
                 {useRealAuth 
                    ? "Un lien de confirmation sécurisé a été envoyé." 
                    : "Un code de simulation a été généré."}
                 <br/><span className="text-white font-mono">{email}</span>
               </p>
               {!useRealAuth && (
                   <div className="mt-4 p-2 bg-black/30 rounded border border-white/5">
                      <p className="text-[9px] text-slate-500 font-mono">Code simulation: 123456</p>
                   </div>
               )}
            </div>

            {useRealAuth ? (
                <div className="space-y-4">
                    <p className="text-[10px] text-slate-400">Cliquez sur le lien dans l'email, puis :</p>
                    <button 
                      type="button"
                      onClick={() => setStage('LOGIN')} // Retour au login après validation externe
                      className="w-full h-14 bg-green-500 hover:bg-green-400 text-black rounded-xl text-[11px] font-black uppercase tracking-[0.2em] shadow-lg shadow-green-500/20 transition-all"
                    >
                      J'ai confirmé mon email
                    </button>
                </div>
            ) : (
                <>
                    <div>
                      <label className="text-[10px] font-black text-slate-500 uppercase tracking-widest block mb-2">Entrez le code</label>
                      <input 
                        type="text" 
                        value={verifyCode}
                        onChange={(e) => setVerifyCode(e.target.value)}
                        className="w-full h-12 bg-black/40 border border-white/10 rounded-xl px-4 text-center text-lg font-mono text-cyan-400 tracking-[0.5em] focus:border-cyan-500 focus:outline-none transition-colors"
                        placeholder="000000"
                        maxLength={6}
                      />
                    </div>
                    <button 
                      type="submit" 
                      disabled={loading}
                      className="w-full h-14 bg-green-500 hover:bg-green-400 text-black rounded-xl text-[11px] font-black uppercase tracking-[0.2em] shadow-lg shadow-green-500/20 transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center"
                    >
                      {loading ? <i className="fas fa-spinner fa-spin"></i> : "Valider le compte"}
                    </button>
                </>
            )}
          </form>
        )}

        {/* Notifications */}
        {error && (
          <div className="mt-6 p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center justify-center space-x-2 animate-in slide-in-from-top-2">
            <i className="fas fa-exclamation-circle text-red-500 text-xs"></i>
            <span className="text-[10px] font-bold text-red-400 uppercase tracking-wide">{error}</span>
          </div>
        )}
        {successMsg && (
          <div className="mt-6 p-3 bg-green-500/10 border border-green-500/20 rounded-xl flex items-center justify-center space-x-2 animate-in slide-in-from-top-2">
            <i className="fas fa-check-circle text-green-500 text-xs"></i>
            <span className="text-[10px] font-bold text-green-400 uppercase tracking-wide">{successMsg}</span>
          </div>
        )}

        {/* --- GUEST MODE SEPARATOR --- */}
        {stage === 'LOGIN' && (
            <div className="mt-8 pt-6 border-t border-white/5 flex flex-col items-center">
                <button 
                    type="button"
                    onClick={handleGuestAccess}
                    disabled={loading}
                    className="flex items-center space-x-2 text-slate-500 hover:text-white transition-colors group"
                >
                    <i className="fas fa-user-secret text-xs group-hover:text-cyan-400 transition-colors"></i>
                    <span className="text-[10px] font-black uppercase tracking-widest">Accéder sans compte (Invité)</span>
                </button>
            </div>
        )}

      </div>
    </div>
  );
};

export default AuthScreen;
