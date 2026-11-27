import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    let readable = error.message || 'Unexpected application error';
    try {
      const parsed = JSON.parse(error.message) as {
        error?: string;
        operationType?: string;
        path?: string | null;
      };
      if (parsed.error) {
        readable = `Firestore ${parsed.operationType || 'operation'} failed${parsed.path ? ` (${parsed.path})` : ''}: ${parsed.error}`;
      }
    } catch {
      // Plain error message
    }
    return { hasError: true, message: readable };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Application ErrorBoundary caught error:', error, info);
  }

  handleReset = () => {
    this.setState({ hasError: false, message: '' });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#040709] text-slate-100 flex items-center justify-center p-6">
          <div className="max-w-md w-full glass-panel rounded-3xl border border-orange-500/30 p-6 space-y-4">
            <div className="flex items-center gap-3 text-orange-400">
              <AlertTriangle className="w-6 h-6 shrink-0" aria-hidden="true" />
              <h2 className="text-sm font-mono font-bold uppercase tracking-wider">
                Telemetry Sync Exception
              </h2>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed break-words">
              {this.state.message}
            </p>
            <button
              type="button"
              onClick={this.handleReset}
              className="w-full py-2.5 px-4 rounded-xl bg-emeraldGlow text-obsidian-950 font-semibold text-xs inline-flex items-center justify-center gap-2 hover:brightness-105 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Recover Session</span>
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
