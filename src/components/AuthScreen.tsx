import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { User, AuthStage } from '../types';
import { supabaseManager } from '../services/SupabaseManager';

interface AuthScreenProps {
  onAuthenticated: (user: User) => void;
}

const AuthScreen: React.FC<AuthScreenProps> = ({ onAuthenticated }) => {
  const [stage, setStage] = useState<AuthStage>('LOGIN');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const handleLogin = async () => {
    if (!email || !password) {
      setError('Veuillez remplir tous les champs');
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const { user } = await supabaseManager.signIn(email, password);
      if (user) {
        onAuthenticated({
          id: user.id,
          email: user.email || '',
          username: user.user_metadata?.username || email.split('@')[0],
          isVerified: user.email_confirmed_at !== null,
          plan: 'FREE',
          owned_instruments: []
        });
      }
    } catch (e: any) {
      setError(e.message || 'Erreur de connexion');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegister = async () => {
    if (!email || !password) {
      setError('Veuillez remplir tous les champs');
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      await supabaseManager.signUp(email, password);
      setMessage('Un email de vérification a été envoyé !');
      setStage('VERIFY_EMAIL');
    } catch (e: any) {
      setError(e.message || 'Erreur d\'inscription');
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetPassword = async () => {
    if (!email) {
      setError('Veuillez entrer votre email');
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      await supabaseManager.resetPasswordForEmail(email);
      setMessage('Un email de réinitialisation a été envoyé !');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setIsLoading(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] bg-[#0c0d10] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-20 h-20 bg-gradient-to-br from-cyan-500 to-blue-600 rounded-3xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-cyan-500/20">
            <i className="fas fa-wave-square text-3xl text-white"></i>
          </div>
          <h1 className="text-2xl font-black text-white">NOVA STUDIO</h1>
          <p className="text-[10px] text-slate-500 uppercase tracking-widest mt-1">
            {stage === 'LOGIN' ? 'Connexion' : stage === 'REGISTER' ? 'Inscription' : stage === 'FORGOT_PASSWORD' ? 'Mot de passe oublié' : 'Vérification'}
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-[10px] text-center">
            {error}
          </div>
        )}

        {message && (
          <div className="mb-4 p-3 bg-green-500/10 border border-green-500/20 rounded-lg text-green-400 text-[10px] text-center">
            {message}
          </div>
        )}

        {stage === 'VERIFY_EMAIL' ? (
          <div className="text-center">
            <i className="fas fa-envelope text-4xl text-cyan-500 mb-4"></i>
            <p className="text-slate-400 text-sm mb-4">Vérifiez votre boîte mail et cliquez sur le lien de confirmation.</p>
            <button
              onClick={() => setStage('LOGIN')}
              className="text-cyan-500 hover:text-cyan-400 text-sm font-bold"
            >
              Retour à la connexion
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-cyan-500/50"
              placeholder="Email"
            />

            {stage !== 'FORGOT_PASSWORD' && (
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-cyan-500/50"
                placeholder="Mot de passe"
              />
            )}

            {stage === 'REGISTER' && (
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-cyan-500/50"
                placeholder="Nom d'artiste"
              />
            )}

            <button
              onClick={stage === 'LOGIN' ? handleLogin : stage === 'REGISTER' ? handleRegister : handleResetPassword}
              disabled={isLoading}
              className="w-full py-3 bg-cyan-500 hover:bg-cyan-400 text-black font-black uppercase tracking-wider rounded-xl transition-all disabled:opacity-50"
            >
              {isLoading ? (
                <i className="fas fa-spinner fa-spin"></i>
              ) : stage === 'LOGIN' ? (
                'Se connecter'
              ) : stage === 'REGISTER' ? (
                'Créer mon compte'
              ) : (
                'Envoyer le lien'
              )}
            </button>

            <div className="flex justify-between text-[10px]">
              {stage === 'LOGIN' ? (
                <>
                  <button onClick={() => setStage('REGISTER')} className="text-slate-400 hover:text-white">
                    Créer un compte
                  </button>
                  <button onClick={() => setStage('FORGOT_PASSWORD')} className="text-slate-400 hover:text-white">
                    Mot de passe oublié ?
                  </button>
                </>
              ) : (
                <button onClick={() => setStage('LOGIN')} className="text-slate-400 hover:text-white">
                  Retour à la connexion
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};

export default AuthScreen;
