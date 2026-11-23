import React, { useEffect, useRef } from 'react';
import {
  FindCategoryFilter,
  StudioSearchResult,
} from '../utils/studioEditor';

interface FindComponentPanelProps {
  query: string;
  category: FindCategoryFilter;
  results: StudioSearchResult[];
  activeIndex: number;
  onQueryChange: (q: string) => void;
  onCategoryChange: (cat: FindCategoryFilter) => void;
  onSelectResult: (result: StudioSearchResult, index: number) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}

const CATEGORY_OPTIONS: { id: FindCategoryFilter; label: string; icon: string }[] = [
  { id: 'all', label: 'All', icon: 'apps' },
  { id: 'electrical', label: 'Electrical', icon: 'bolt' },
  { id: 'lighting', label: 'Lighting', icon: 'lightbulb' },
  { id: 'fans', label: 'Fans', icon: 'mode_fan' },
  { id: 'switches', label: 'Switches', icon: 'toggle_on' },
  { id: 'sockets', label: 'Sockets', icon: 'outlet' },
  { id: 'appliances', label: 'Appliances', icon: 'kitchen' },
  { id: 'furniture', label: 'Furniture', icon: 'weekend' },
  { id: 'rooms', label: 'Rooms', icon: 'meeting_room' },
];

export const FindComponentPanel: React.FC<FindComponentPanelProps> = ({
  query,
  category,
  results,
  activeIndex,
  onQueryChange,
  onCategoryChange,
  onSelectResult,
  onNext,
  onPrev,
  onClose,
}) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const placedResults = results
    .map((item, idx) => ({ item, idx }))
    .filter(({ item }) => item.source === 'placed');
  const libraryResults = results
    .map((item, idx) => ({ item, idx }))
    .filter(({ item }) => item.source === 'library');

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      e.stopPropagation();
      inputRef.current?.select();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      onNext();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      onPrev();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (results.length === 0) return;
      if (e.shiftKey) {
        onPrev();
      } else {
        const target = results[activeIndex] ?? results[0];
        if (target.source === 'library') {
          onSelectResult(target, activeIndex >= 0 ? activeIndex : 0);
        } else {
          onNext();
        }
      }
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Find Component"
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute top-3 left-1/2 -translate-x-1/2 z-40 w-[min(640px,calc(100%-1.5rem))] bg-surface-container border border-primary/70 rounded-md shadow-2xl overflow-hidden flex flex-col"
    >
      {/* Top Search Bar */}
      <div className="flex items-center gap-1.5 px-gutter-sm py-2 bg-surface-container-high border-b border-outline-variant">
        <span className="material-symbols-outlined text-primary text-[18px] shrink-0" aria-hidden="true">
          search
        </span>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder="Find component by name, code, category, type, or ID..."
          aria-label="Search components"
          className="flex-1 min-w-0 bg-surface border border-outline rounded-sm px-2.5 py-1 font-body text-body-sm text-on-surface placeholder:text-on-surface-variant/70 focus:border-primary focus:outline-none"
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              onQueryChange('');
              inputRef.current?.focus();
            }}
            title="Clear search"
            aria-label="Clear search"
            className="p-1 rounded-sm text-on-surface-variant hover:text-on-surface hover:bg-surface cursor-pointer"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">backspace</span>
          </button>
        )}

        <span className="font-mono text-[11px] text-on-surface-variant px-1.5 tabular-nums whitespace-nowrap">
          {results.length > 0 ? `${Math.min(activeIndex + 1, results.length)} / ${results.length}` : '0 / 0'}
        </span>

        <div className="inline-flex items-center rounded-sm border border-outline-variant bg-surface">
          <button
            type="button"
            disabled={results.length === 0}
            onClick={onPrev}
            title="Previous Result (Shift+Enter / Up)"
            aria-label="Previous search result"
            className="p-1 text-on-surface-variant hover:text-primary hover:bg-surface-container-high border-r border-outline-variant disabled:opacity-35 cursor-pointer disabled:cursor-not-allowed"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">keyboard_arrow_up</span>
          </button>
          <button
            type="button"
            disabled={results.length === 0}
            onClick={onNext}
            title="Next Result (Enter / Down)"
            aria-label="Next search result"
            className="p-1 text-on-surface-variant hover:text-primary hover:bg-surface-container-high disabled:opacity-35 cursor-pointer disabled:cursor-not-allowed"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">keyboard_arrow_down</span>
          </button>
        </div>

        <button
          type="button"
          onClick={onClose}
          title="Close Find Panel (Esc)"
          aria-label="Close Find Panel"
          className="p-1 rounded-sm text-on-surface-variant hover:text-on-surface hover:bg-surface cursor-pointer"
        >
          <span className="material-symbols-outlined text-[18px]" aria-hidden="true">close</span>
        </button>
      </div>

      {/* Category Filters */}
      <div className="flex items-center gap-1 px-gutter-sm py-1.5 bg-surface-container-low border-b border-outline-variant overflow-x-auto">
        {CATEGORY_OPTIONS.map((opt) => {
          const active = category === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => onCategoryChange(opt.id)}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-sm border font-label text-[11px] whitespace-nowrap transition-colors cursor-pointer ${
                active
                  ? 'bg-primary text-on-primary border-primary'
                  : 'bg-surface-container text-on-surface-variant border-outline-variant hover:border-primary hover:text-on-surface'
              }`}
            >
              <span className="material-symbols-outlined text-[13px]" aria-hidden="true">
                {opt.icon}
              </span>
              <span>{opt.label}</span>
            </button>
          );
        })}
      </div>

      {/* Results List */}
      <div className="max-h-72 overflow-y-auto p-1.5 flex flex-col gap-1.5 bg-surface-container">
        {results.length === 0 ? (
          <div className="py-6 px-4 text-center flex flex-col items-center gap-1">
            <span className="material-symbols-outlined text-on-surface-variant text-[24px]" aria-hidden="true">
              search_off
            </span>
            <p className="font-body text-body-sm text-on-surface-variant">
              No matching components found on canvas or in the library.
            </p>
          </div>
        ) : (
          <>
            {placedResults.length > 0 && (
              <div className="flex flex-col gap-1">
                <div className="px-2 py-0.5 flex items-center justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-primary">
                    On Canvas ({placedResults.length})
                  </span>
                  <span className="font-mono text-[10px] text-on-surface-variant">
                    Click to navigate &amp; select
                  </span>
                </div>
                {placedResults.map(({ item, idx }) => {
                  const isActive = idx === activeIndex;
                  return (
                    <button
                      key={item.key}
                      ref={isActive ? activeItemRef : undefined}
                      type="button"
                      onClick={() => onSelectResult(item, idx)}
                      className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-sm border text-left transition-colors cursor-pointer ${
                        isActive
                          ? 'bg-primary-container/50 border-primary text-on-surface'
                          : 'bg-surface-container-low border-outline-variant hover:border-primary/70 text-on-surface'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`material-symbols-outlined text-[17px] shrink-0 ${
                            isActive ? 'text-primary' : 'text-secondary'
                          }`}
                          aria-hidden="true"
                        >
                          {item.icon}
                        </span>
                        <div className="min-w-0 flex flex-col">
                          <span className="font-body text-body-sm font-medium text-on-surface truncate">
                            {item.title}
                          </span>
                          <span className="font-mono text-[10px] text-on-surface-variant truncate">
                            {item.subtitle}
                          </span>
                        </div>
                      </div>
                      <span className="px-1.5 py-0.5 rounded-sm bg-surface border border-outline-variant font-mono text-[10px] text-primary shrink-0">
                        {item.badge}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {libraryResults.length > 0 && (
              <div className="flex flex-col gap-1">
                <div className="px-2 py-0.5 flex items-center justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-secondary">
                    Component Library ({libraryResults.length})
                  </span>
                  <span className="font-mono text-[10px] text-on-surface-variant">
                    Click to add to active floor
                  </span>
                </div>
                {libraryResults.map(({ item, idx }) => {
                  const isActive = idx === activeIndex;
                  return (
                    <button
                      key={item.key}
                      ref={isActive ? activeItemRef : undefined}
                      type="button"
                      onClick={() => onSelectResult(item, idx)}
                      className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-sm border text-left transition-colors cursor-pointer ${
                        isActive
                          ? 'bg-secondary-container/45 border-secondary text-on-surface'
                          : 'bg-surface-container-low border-outline-variant hover:border-secondary/70 text-on-surface'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="material-symbols-outlined text-[17px] text-secondary shrink-0"
                          aria-hidden="true"
                        >
                          {item.icon}
                        </span>
                        <div className="min-w-0 flex flex-col">
                          <span className="font-body text-body-sm font-medium text-on-surface truncate">
                            {item.title}
                          </span>
                          <span className="font-mono text-[10px] text-on-surface-variant truncate">
                            {item.subtitle}
                          </span>
                        </div>
                      </div>
                      <span className="px-1.5 py-0.5 rounded-sm bg-surface border border-secondary/40 font-mono text-[10px] text-secondary shrink-0">
                        + {item.badge}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer Hint */}
      <div className="px-gutter-sm py-1 bg-surface-container-low border-t border-outline-variant flex items-center justify-between font-mono text-[10px] text-on-surface-variant">
        <span>Enter: Next · Shift+Enter: Prev · Esc: Close</span>
        <span>
          {placedResults.length} placed · {libraryResults.length} library
        </span>
      </div>
    </div>
  );
};
