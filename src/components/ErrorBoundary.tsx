import React, { Component, ErrorInfo, ReactNode } from 'react';

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

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  // FIX: Converted to a standard class method for lifecycle hooks.
  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);

    // FIX: Class properties and methods must be accessed with `this`.
    this.setState({
      errorInfo: errorInfo,
    });

    // FIX: Class properties and methods must be accessed with `this`.
    if (this.props.onError) {
      // FIX: Class properties and methods must be accessed with `this`.
      this.props.onError(error, errorInfo);
    }
  }

  // FIX: Kept as an arrow function to automatically bind `this` for event handlers.
  handleReset = () => {
    // FIX: Class properties and methods must be accessed with `this`.
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  // FIX: Converted to a standard class method for lifecycle hooks.
  render() {
    // FIX: Class properties and methods must be accessed with `this`.
    if (this.state.hasError) {
      // FIX: Class properties and methods must be accessed with `this`.
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="min-h-screen bg-black flex items-center justify-center p-6">
          <div className="max-w-2xl w-full bg-gray-900 rounded-lg border border-red-500/30 p-8">
            <h1 className="text-2xl font-black text-red-500 text-center mb-4 uppercase">
              Something Went Wrong
            </h1>
            <p className="text-gray-400 text-center mb-8">
              An unexpected error occurred.
            </p>
            <button
                onClick={this.handleReset}
                className="w-full px-6 py-3 bg-cyan-500 hover:bg-cyan-600 text-black font-black rounded uppercase transition-colors"
              >
                Try Again
            </button>
          </div>
        </div>
      );
    }

    // FIX: Class properties and methods must be accessed with `this`.
    return this.props.children;
  }
}

export default ErrorBoundary;
