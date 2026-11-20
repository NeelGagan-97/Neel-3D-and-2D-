import React from 'react';
import { ScreenId } from '../types/design';

interface NavbarProps {
  activeScreen: ScreenId;
  onNavigate: (screen: ScreenId) => void;
  compact?: boolean;
  rightSlot?: React.ReactNode;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeScreen,
  onNavigate,
  compact = false,
  rightSlot,
}) => {
  const navItems: { id: ScreenId; label: string }[] = [
    { id: 'home', label: 'Home' },
    { id: 'studio', label: 'Design Studio' },
    { id: 'summary', label: 'Project Summary' },
  ];

  return (
    <header className="sticky top-0 z-30 bg-surface-container border-b border-outline-variant no-print">
      <div
        className={`${
          compact ? 'px-gutter-lg py-gutter-sm min-h-14' : 'max-w-7xl mx-auto px-gutter-lg lg:px-gutter-xl py-gutter-sm min-h-16'
        } flex flex-wrap items-center justify-between gap-gutter-sm`}
      >
        <button
          type="button"
          onClick={() => onNavigate('home')}
          className="flex items-center gap-gutter-sm min-w-0 text-left cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary rounded-sm"
        >
          <div
            className={`${
              compact ? 'w-8 h-8' : 'w-9 h-9'
            } rounded-md bg-primary-container border border-primary flex items-center justify-center shrink-0`}
          >
            <span
              className={`material-symbols-outlined text-primary ${compact ? 'text-[18px]' : 'text-[20px]'}`}
              aria-hidden="true"
            >
              deployed_code
            </span>
          </div>
          <div className={compact ? 'flex items-baseline gap-gutter-md min-w-0' : 'flex flex-col min-w-0'}>
            <span className="font-headline text-title-sm text-on-surface tracking-wide uppercase whitespace-nowrap">
              ANANYA SPACE DESIGNER
            </span>
            <span
              className={`font-mono text-mono-sm text-on-surface-variant tracking-wider uppercase whitespace-nowrap ${
                compact ? 'hidden xl:inline' : 'hidden sm:block'
              }`}
            >
              DESIGN YOUR SPACE. POWER YOUR WORLD.
            </span>
          </div>
        </button>

        <nav aria-label="Primary Navigation" className="flex items-center gap-gutter-xs min-w-0">
          {navItems.map((item) => {
            const isActive = activeScreen === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={isActive ? 'page' : undefined}
                onClick={() => onNavigate(item.id)}
                className={`px-gutter-sm sm:px-gutter-md py-gutter-xs rounded-sm font-label text-label-md transition-colors duration-state-change whitespace-nowrap shrink-0 cursor-pointer ${
                  isActive
                    ? 'bg-primary-container text-primary border border-primary'
                    : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high border border-transparent'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className={compact ? 'hidden lg:flex items-center gap-gutter-sm shrink-0' : 'hidden md:flex items-center gap-gutter-sm shrink-0'}>
          {rightSlot}
        </div>
      </div>
    </header>
  );
};
