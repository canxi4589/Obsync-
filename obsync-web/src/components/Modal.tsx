import { useEffect } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  badge?: React.ReactNode;
  maxWidthClass?: string;
  dismissible?: boolean;
  children: React.ReactNode;
}

/**
 * Responsive accessible modal styled with DaisyUI v5 tokens: floats centered
 * on desktop/tablet and slides up as a rounded bottom sheet on mobile.
 */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  badge,
  maxWidthClass = 'max-w-lg',
  dismissible = true,
  children,
}: ModalProps) {
  useEffect(() => {
    if (!open || !dismissible) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, dismissible, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
      className="animate-backdrop fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
    >
      <div
        className={`animate-modal custom-scrollbar pb-safe max-h-[92dvh] w-full ${maxWidthClass} overflow-y-auto rounded-t-xl border border-base-content/14 bg-base-200 p-5 text-base-content shadow-xl shadow-black/45 sm:rounded-lg sm:p-5`}
      >
        {/* Mobile grab handle */}
        <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-base-content/20 sm:hidden" />

        <div className="flex items-start justify-between gap-3 border-b border-base-content/10 pb-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[15px] font-semibold tracking-tight text-base-content">
                {title}
              </h3>
              {badge}
            </div>
            {subtitle && (
              <p className="mt-1 text-xs leading-relaxed text-base-content/60">
                {subtitle}
              </p>
            )}
          </div>
          {dismissible && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close modal"
              className="btn btn-ghost btn-xs btn-square h-7 min-h-0 w-7 shrink-0 rounded-md text-base-content/55 hover:text-base-content"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}
