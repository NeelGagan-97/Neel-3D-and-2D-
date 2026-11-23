import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface CanvasContextMenuItem {
  id: string;
  label: string;
  icon: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  dividerBefore?: boolean;
  onSelect: () => void;
}

interface CanvasContextMenuProps {
  x: number;
  y: number;
  headerLabel: string;
  items: CanvasContextMenuItem[];
  onClose: () => void;
}

export const CanvasContextMenu: React.FC<CanvasContextMenuProps> = ({
  x,
  y,
  headerLabel,
  items,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Clamp context menu within the viewport so it never clips off-screen
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 10;
    const maxLeft = Math.max(pad, window.innerWidth - rect.width - pad);
    const maxTop = Math.max(pad, window.innerHeight - rect.height - pad);
    setPos({
      left: Math.min(Math.max(pad, x), maxLeft),
      top: Math.min(Math.max(pad, y), maxTop),
    });
  }, [x, y, items.length]);

  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleResize = () => onClose();
    window.addEventListener('mousedown', handlePointerDown, true);
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown, true);
      window.removeEventListener('resize', handleResize);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Canvas options"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-50 w-56 rounded-md bg-surface-container border border-outline shadow-2xl py-1 select-none"
    >
      <div className="px-gutter-sm py-1 border-b border-outline-variant flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant truncate">
          {headerLabel}
        </span>
      </div>

      <div className="py-1 flex flex-col">
        {items.map((item) => (
          <React.Fragment key={item.id}>
            {item.dividerBefore && <div className="my-1 border-t border-outline-variant" />}
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                if (item.disabled) return;
                onClose();
                item.onSelect();
              }}
              className={`w-full px-gutter-sm py-1.5 flex items-center justify-between gap-gutter-sm text-left font-label text-label-sm transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                item.danger
                  ? 'text-error hover:bg-error/15'
                  : 'text-on-surface hover:bg-surface-container-high hover:text-primary'
              }`}
            >
              <span className="inline-flex items-center gap-gutter-xs min-w-0">
                <span
                  className={`material-symbols-outlined text-[15px] shrink-0 ${
                    item.danger ? 'text-error' : 'text-primary'
                  }`}
                  aria-hidden="true"
                >
                  {item.icon}
                </span>
                <span className="truncate">{item.label}</span>
              </span>
              {item.shortcut && (
                <span className="font-mono text-[10px] text-on-surface-variant shrink-0">
                  {item.shortcut}
                </span>
              )}
            </button>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
};
