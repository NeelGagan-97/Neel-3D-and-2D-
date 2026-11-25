import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallbackTitle?: string;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

/**
 * Top-level React ErrorBoundary preventing unrecoverable blank screens when an
 * unexpected rendering error occurs in any Blue Space screen or workspace view.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      errorMessage: '',
    };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const message =
      error instanceof Error && error.message
        ? error.message
        : 'An unexpected application error occurred.';
    return {
      hasError: true,
      errorMessage: message,
    };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary] Uncaught render error:', error, info.componentStack);
  }

  private handleRecover = () => {
    this.setState({ hasError: false, errorMessage: '' });
    this.props.onReset?.();
  };

  private handleReload = () => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          className="min-h-screen w-full bg-surface text-on-surface flex items-center justify-center p-gutter-xl"
        >
          <div className="w-full max-w-lg rounded-lg bg-surface-container border border-outline p-gutter-xl flex flex-col gap-gutter-lg shadow-xl">
            <div className="flex items-start gap-gutter-md">
              <span
                className="material-symbols-outlined text-error text-[28px] shrink-0"
                aria-hidden="true"
              >
                error_outline
              </span>
              <div className="flex flex-col gap-gutter-xs min-w-0">
                <h1 className="font-headline text-headline-sm text-on-surface">
                  {this.props.fallbackTitle ?? 'Something went wrong in Blue Space'}
                </h1>
                <p className="font-body text-body-md text-on-surface-variant">
                  A display error interrupted this view. Your saved projects and catalogue records
                  remain intact.
                </p>
              </div>
            </div>

            {this.state.errorMessage && (
              <div className="px-gutter-md py-gutter-sm rounded-sm bg-surface-container-low border border-outline-variant font-mono text-mono-sm text-on-surface-variant break-words">
                {this.state.errorMessage}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-gutter-sm">
              <button
                type="button"
                onClick={this.handleRecover}
                className="px-gutter-lg py-gutter-sm rounded-sm bg-primary text-on-primary hover:bg-on-primary-container font-label text-label-md cursor-pointer"
              >
                Try Again
              </button>
              <button
                type="button"
                onClick={this.handleReload}
                className="px-gutter-lg py-gutter-sm rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-md cursor-pointer"
              >
                Reload Workspace
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
