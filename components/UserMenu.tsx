
import React from 'react';
import { User } from '../types';

interface UserMenuProps {
  user: User;
  onLogout: () => void;
  onClose: () => void;
}

const UserMenu: React.FC<UserMenuProps> = ({ user, onLogout, onClose }) => {
  return (
    <div className="fixed inset-0 z-[300] flex items-start justify-end p-4 pt-20" onClick={onClose}>
      <div 
        className="w-72 bg-[#14161a] border border-white/10 rounded-2xl shadow-2xl p-6 backdrop-blur-xl animate-in slide-in-from-top-4 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col items-center space-y-4">
          {/* Avatar Area */}
          <div className="w-20 h-20 rounded-full bg-gradient-to-tr from-cyan-500 to-blue-600 p-0.5 shadow-lg shadow-cyan-500/20">
            <div className="w-full h-full rounded-full bg-[#14161a] flex items-center justify-center overflow-hidden">
                {user.avatar ? (
                    <img src={user.avatar} alt={user.username} className="w-full h-full object-cover" />
                ) : (
                    <span className="text-2xl font-black text-white uppercase">{user.username.charAt(0)}</span>
                )}
            </div>
          </div>

          <div className="text-center">
            <h3 className="text-white font-bold text-sm uppercase tracking-wider">{user.username}</h3>
            <p className="text-slate-500 text-xs font-mono mt-1">{user.email}</p>
          </div>

          {/* Plan Badge */}
          <div className={`px-4 py-1.5 rounded-full border text-[10px] font-black uppercase tracking-widest ${
              user.plan === 'STUDIO' ? 'bg-purple-500/10 border-purple-500/30 text-purple-400' :
              user.plan === 'PRO' ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400' :
              'bg-white/5 border-white/10 text-slate-400'
          }`}>
              Plan {user.plan}
          </div>

          <div className="w-full h-px bg-white/5 my-2"></div>

          <div className="w-full space-y-2">
            <button className="w-full h-10 rounded-xl bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white text-[10px] font-bold uppercase tracking-wide flex items-center justify-center transition-all">
                <i className="fas fa-cog mr-2"></i> Paramètres
            </button>
            <button 
                onClick={onLogout}
                className="w-full h-10 rounded-xl bg-red-500/10 hover:bg-red-500 text-red-500 hover:text-black text-[10px] font-black uppercase tracking-wide flex items-center justify-center transition-all border border-red-500/20 hover:border-red-500"
            >
                <i className="fas fa-sign-out-alt mr-2"></i> Déconnexion
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default UserMenu;
