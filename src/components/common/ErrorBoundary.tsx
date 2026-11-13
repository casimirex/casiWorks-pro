// CasiWorks Pro - Error boundary: contain a render crash to one region of the UI
import React from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { useCADStore } from '../../store/cadStore.ts';
import { downloadProject } from '../../utils/projectFile.ts';

interface ErrorBoundaryProps {
  children?: ReactNode;
  /** Human-readable region name shown in the message ("Viewport"). */
  name?: string;
  /** Run before re-rendering the children (e.g. close a panel). */
  onReset?: () => void;
  /** Render the fallback as a full-page screen (used at the app root). */
  fullScreen?: boolean;
  /** Render the fallback at side-panel width so it does not squeeze its neighbours. */
  panel?: boolean;
}

interface ErrorBoundaryState {
  error: unknown;
}

const messageOf = (error: unknown): string =>
  String((error as { message?: unknown } | null)?.message || error);

/**
 * Wrap a region of the UI so a crash inside it shows a recoverable message
 * instead of unmounting the whole application.
 */
export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[CasiWorks] ${this.props.name || 'UI'} crashed:`, error, info?.componentStack);
    try {
      useCADStore.getState().setStatus(`${this.props.name || 'A panel'} hit an error: ${messageOf(error)}`);
    } catch { /* the store itself may be the cause; the fallback UI still renders */ }
  }

  handleRetry = () => {
    try { this.props.onReset?.(); } catch { /* best effort */ }
    this.setState({ error: null });
  };

  handleSave = () => {
    try {
      downloadProject(useCADStore);
    } catch (err) {
      console.error('[CasiWorks] Recovery save failed:', err);
    }
  };

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children ?? null;

    const { name = 'This panel', fullScreen = false, panel = false } = this.props;
    const variant = fullScreen ? ' error-boundary-full' : (panel ? ' error-boundary-panel' : '');
    return (
      <div className={`error-boundary${variant}`} role="alert">
        <div className="error-boundary-card">
          <div className="error-boundary-title">{name} ran into a problem</div>
          <div className="error-boundary-message">{messageOf(error)}</div>
          <div className="error-boundary-hint">
            Your model is still in memory. Save a recovery copy before retrying if you have unsaved work.
          </div>
          <div className="error-boundary-actions">
            <button type="button" className="error-boundary-btn primary" onClick={this.handleRetry}>Retry</button>
            <button type="button" className="error-boundary-btn" onClick={this.handleSave}>Save recovery copy</button>
            {fullScreen && (
              <button type="button" className="error-boundary-btn" onClick={() => window.location.reload()}>Reload app</button>
            )}
          </div>
        </div>
      </div>
    );
  }
}
