import React, { useState, useEffect } from 'react';

interface LandingPageProps {
  onEnterStudio: () => void;
}

const LandingPage: React.FC<LandingPageProps> = ({ onEnterStudio }) => {
  const [isLoading, setIsLoading] = useState(true);
  const [showContent, setShowContent] = useState(false);

  useEffect(() => {
    // Simulate initial load
    const timer1 = setTimeout(() => setIsLoading(false), 800);
    const timer2 = setTimeout(() => setShowContent(true), 1000);
    return () => {
      clearTimeout(timer1);
      clearTimeout(timer2);
    };
  }, []);

  const features = [
    { icon: 'fa-microphone-alt', title: 'Record', desc: 'Pro-quality recording' },
    { icon: 'fa-sliders-h', title: 'Mix', desc: 'Professional mixing tools' },
    { icon: 'fa-magic', title: 'FX', desc: '15+ built-in effects' },
    { icon: 'fa-cloud', title: 'Cloud', desc: 'Save & sync projects' },
  ];

  return (
    <div className="fixed inset-0 bg-[#0a0b0d] flex flex-col items-center justify-center overflow-hidden">
      {/* Animated Background */}
      <div className="absolute inset-0 overflow-hidden">
        {/* Gradient orbs */}
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-cyan-500/10 rounded-full blur-[120px] animate-pulse" />
        <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-purple-500/10 rounded-full blur-[100px] animate-pulse" style={{ animationDelay: '1s' }} />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-cyan-500/5 rounded-full blur-[150px]" />
        
        {/* Grid pattern */}
        <div className="absolute inset-0 opacity-20">
          <div className="absolute inset-0" style={{
            backgroundImage: `
              linear-gradient(rgba(0,242,255,0.03) 1px, transparent 1px),
              linear-gradient(90deg, rgba(0,242,255,0.03) 1px, transparent 1px)
            `,
            backgroundSize: '50px 50px'
          }} />
        </div>
        
        {/* Scanlines effect */}
        <div className="absolute inset-0 pointer-events-none opacity-[0.02]" style={{
          backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.03) 2px, rgba(255,255,255,0.03) 4px)'
        }} />
      </div>

      {/* Main Content */}
      <div className={`relative z-10 flex flex-col items-center transition-all duration-1000 ${showContent ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}>
        {/* Logo */}
        <div className="mb-8 flex flex-col items-center">
          <div className="relative">
            {/* Glow effect */}
            <div className="absolute inset-0 blur-2xl bg-cyan-500/30 scale-150 animate-pulse" />
            
            {/* Logo icon */}
            <div className="relative w-24 h-24 rounded-3xl bg-gradient-to-br from-cyan-500 via-cyan-400 to-blue-500 flex items-center justify-center shadow-2xl shadow-cyan-500/30 border border-cyan-400/30">
              <i className="fas fa-waveform-lines text-4xl text-white drop-shadow-lg" style={{ textShadow: '0 0 20px rgba(255,255,255,0.5)' }}></i>
            </div>
          </div>
          
          {/* Brand name */}
          <h1 className="mt-6 text-5xl md:text-7xl font-black tracking-tighter">
            <span className="text-white">NOVA</span>
            <span className="text-cyan-400 ml-2">STUDIO</span>
          </h1>
          
          {/* Tagline */}
          <p className="mt-4 text-slate-400 text-lg md:text-xl font-medium tracking-wide uppercase">
            Professional DAW • In Your Browser
          </p>
          
          {/* Version badge */}
          <div className="mt-3 px-3 py-1 bg-white/5 border border-white/10 rounded-full">
            <span className="text-xs font-mono text-slate-500">v1.0.0 • FREE BETA</span>
          </div>
        </div>

        {/* Features */}
        <div className="mt-8 grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6 px-4 max-w-2xl">
          {features.map((feature, index) => (
            <div 
              key={feature.title}
              className="group flex flex-col items-center p-4 md:p-6 rounded-2xl bg-white/[0.02] border border-white/5 hover:border-cyan-500/30 hover:bg-white/[0.04] transition-all duration-300"
              style={{ 
                transitionDelay: `${index * 100}ms`,
                opacity: showContent ? 1 : 0,
                transform: showContent ? 'translateY(0)' : 'translateY(20px)'
              }}
            >
              <div className="w-12 h-12 rounded-xl bg-cyan-500/10 flex items-center justify-center text-cyan-400 group-hover:scale-110 group-hover:bg-cyan-500/20 transition-all duration-300">
                <i className={`fas ${feature.icon} text-lg`}></i>
              </div>
              <span className="mt-3 text-sm font-bold text-white uppercase tracking-wider">{feature.title}</span>
              <span className="mt-1 text-xs text-slate-500 text-center">{feature.desc}</span>
            </div>
          ))}
        </div>

        {/* CTA Button */}
        <button
          onClick={onEnterStudio}
          disabled={isLoading}
          className="mt-12 group relative px-12 py-5 bg-gradient-to-r from-cyan-500 to-blue-500 rounded-2xl font-black text-lg uppercase tracking-widest text-white shadow-2xl shadow-cyan-500/30 hover:shadow-cyan-500/50 hover:scale-105 active:scale-100 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed overflow-hidden"
        >
          {/* Button glow */}
          <div className="absolute inset-0 bg-gradient-to-r from-cyan-400 to-blue-400 opacity-0 group-hover:opacity-100 transition-opacity duration-300 blur-xl" />
          
          {/* Button content */}
          <span className="relative flex items-center gap-3">
            {isLoading ? (
              <>
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <span>Loading...</span>
              </>
            ) : (
              <>
                <i className="fas fa-play text-sm"></i>
                <span>Enter Studio</span>
                <i className="fas fa-arrow-right text-sm group-hover:translate-x-1 transition-transform"></i>
              </>
            )}
          </span>
        </button>

        {/* Sub info */}
        <div className="mt-6 flex items-center gap-6 text-xs text-slate-600">
          <span className="flex items-center gap-2">
            <i className="fas fa-lock text-green-500"></i>
            No login required
          </span>
          <span className="flex items-center gap-2">
            <i className="fas fa-bolt text-yellow-500"></i>
            Instant start
          </span>
          <span className="flex items-center gap-2">
            <i className="fas fa-infinity text-purple-500"></i>
            Unlimited projects
          </span>
        </div>
      </div>

      {/* Footer */}
      <footer className="absolute bottom-6 left-0 right-0 flex flex-col items-center gap-4">
        {/* Social links */}
        <div className="flex items-center gap-4">
          <a href="https://github.com/romainscheyvaerts-svg/NOVA-STUDIO-DAW-0901-" target="_blank" rel="noopener noreferrer" className="w-10 h-10 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-slate-400 hover:text-white hover:border-white/20 transition-all">
            <i className="fab fa-github"></i>
          </a>
          <a href="#" className="w-10 h-10 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-slate-400 hover:text-white hover:border-white/20 transition-all">
            <i className="fab fa-discord"></i>
          </a>
          <a href="#" className="w-10 h-10 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-slate-400 hover:text-white hover:border-white/20 transition-all">
            <i className="fab fa-youtube"></i>
          </a>
        </div>
        
        <p className="text-xs text-slate-700">
          © 2026 Nova Studio • Made with <i className="fas fa-heart text-red-500"></i> for music creators
        </p>
      </footer>

      {/* Keyboard hint */}
      <div className="absolute bottom-6 right-6 hidden md:flex items-center gap-2 text-xs text-slate-700">
        <span>Press</span>
        <kbd className="px-2 py-1 bg-white/5 border border-white/10 rounded text-slate-500 font-mono">Enter</kbd>
        <span>to start</span>
      </div>
    </div>
  );
};

export default LandingPage;
