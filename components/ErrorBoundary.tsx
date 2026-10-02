import { logClientError } from '../utils/errorLog';
import React, { ErrorInfo, ReactNode } from 'react';
import { ContextMenuItem } from '../types';

interface ErrorBoundaryProps {
  children?: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

// FIX: Correctly extend React's Component class to resolve issues with 'this.props' and 'this.setState'.
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    logClientError(error, 'affichage');

    this.setState({
      errorInfo: errorInfo,
    });

    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }
  }

  handleReset = () => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="min-h-screen bg-[#0c0d10] flex items-center justify-center p-6">
          <div className="max-w-md w-full rounded-2xl border border-white/10 bg-white/[0.03] p-7 text-center">
            <p className="text-lg font-black text-white mb-2">Nova a rencontré un problème</p>
            <p className="text-sm text-slate-400 mb-6">
              Ton travail sauvegardé n'est pas perdu. Recharge la page ; si le problème revient, « Réparer » efface l'ancienne version gardée par ton navigateur.
            </p>
            <div className="flex flex-col gap-2.5">
              <button onClick={() => window.location.reload()} className="h-12 rounded-xl bg-cyan-400 text-black font-black">Recharger</button>
              <button onClick={() => { const r = (window as any).novaRepair; if (typeof r === 'function') r(); else window.location.reload(); }} className="h-12 rounded-xl border border-white/15 text-white font-bold">Réparer</button>
              <button onClick={this.handleReset} className="h-10 text-sm text-slate-400 underline">Réessayer sans recharger</button>
            </div>
            {this.state.error && <p className="mt-5 text-[11px] text-slate-600 break-words">{String(this.state.error.message).slice(0, 200)}</p>}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
