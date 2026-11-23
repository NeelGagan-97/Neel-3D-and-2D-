import React, { useEffect, useState } from 'react';

interface DrawingInstructionsModalProps {
  onClose: () => void;
  onStartDesigning?: () => void;
}

type GuideTab = 'workflow' | 'tools' | 'multifloor' | 'shortcuts';

export const DrawingInstructionsModal: React.FC<DrawingInstructionsModalProps> = ({
  onClose,
  onStartDesigning,
}) => {
  const [activeTab, setActiveTab] = useState<GuideTab>('workflow');

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 bg-deep-navy/85 flex items-center justify-center p-gutter-md overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="drawing-guide-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl bg-surface-container border border-outline rounded-xl overflow-hidden my-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-gutter-xl py-gutter-lg border-b border-outline-variant bg-surface-container-high flex items-center justify-between gap-gutter-md">
          <div className="flex items-center gap-gutter-sm">
            <div className="w-9 h-9 rounded-md bg-primary-container border border-primary flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-primary text-[20px]" aria-hidden="true">
                menu_book
              </span>
            </div>
            <div>
              <h2 id="drawing-guide-title" className="font-headline text-headline-sm text-on-surface">
                How to Work on Drawings &amp; Multi-Floor Models
              </h2>
              <p className="font-mono text-mono-sm text-on-surface-variant">
                2D CAD DRAFTING · 3D ELEVATED FLOORS · FIND, UNDO/REDO &amp; COMPONENT SHORTCUTS
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close drawing instructions"
            className="p-1.5 rounded-sm text-on-surface-variant hover:text-on-surface hover:bg-surface-container cursor-pointer"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {/* Tab Bar */}
        <div className="px-gutter-xl pt-gutter-md border-b border-outline-variant bg-surface-container-low flex flex-wrap gap-gutter-xs">
          {(
            [
              { id: 'workflow', label: '1. Quick Start', icon: 'rocket_launch' },
              { id: 'tools', label: '2. Drawing Tools', icon: 'design_services' },
              { id: 'multifloor', label: '3. Multi-Floor & 3D', icon: 'layers' },
              { id: 'shortcuts', label: '4. Editing & Shortcuts', icon: 'keyboard' },
            ] as const
          ).map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-1.5 px-gutter-md py-gutter-sm rounded-t-md border-b-2 font-label text-label-md transition-colors cursor-pointer ${
                  isActive
                    ? 'border-primary text-primary bg-surface-container'
                    : 'border-transparent text-on-surface-variant hover:text-on-surface'
                }`}
              >
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                  {tab.icon}
                </span>
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="p-gutter-xl max-h-[64vh] overflow-y-auto flex flex-col gap-gutter-md">
          {activeTab === 'workflow' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-gutter-md">
              <div className="p-gutter-md rounded-md bg-surface-container-low border border-outline-variant flex flex-col gap-1.5">
                <span className="font-mono text-mono-sm text-primary">STEP 01 · CREATE SITE &amp; PROJECT</span>
                <h3 className="font-headline text-title-sm text-on-surface">Set Name, Units &amp; Plot</h3>
                <p className="font-body text-body-sm text-on-surface-variant">
                  Click <strong>CREATE YOUR OWN SPACE</strong>, select Feet or Metres, then configure Site Length, Site Width, Wall Thickness, Ceiling Height, and Number of Floors (1–5).
                </p>
              </div>
              <div className="p-gutter-md rounded-md bg-surface-container-low border border-outline-variant flex flex-col gap-1.5">
                <span className="font-mono text-mono-sm text-primary">STEP 02 · DRAFT ROOMS &amp; WALLS</span>
                <h3 className="font-headline text-title-sm text-on-surface">Build Your 2D Floor Plan</h3>
                <p className="font-body text-body-sm text-on-surface-variant">
                  Click inside the site boundary — or open <strong>B. Room Library</strong> beside <strong>A. Drawing Tools</strong> — to place typed rooms with exact dimensions, partition walls, doors, and windows.
                </p>
              </div>
              <div className="p-gutter-md rounded-md bg-surface-container-low border border-outline-variant flex flex-col gap-1.5">
                <span className="font-mono text-mono-sm text-secondary">STEP 03 · ELECTRICAL, FURNITURE &amp; FIND</span>
                <h3 className="font-headline text-title-sm text-on-surface">Place, Search &amp; Edit Precision Layouts</h3>
                <p className="font-body text-body-sm text-on-surface-variant">
                  Open <strong>D. Electrical Library</strong> to place fans, lights, switches, sockets, ACs, and geysers. Press <strong>Ctrl + F</strong> anytime to search, highlight, and jump to placed items or library components, and use <strong>Ctrl + Z / Ctrl + Y</strong> for multi-step Undo &amp; Redo.
                </p>
              </div>
              <div className="p-gutter-md rounded-md bg-surface-container-low border border-outline-variant flex flex-col gap-1.5">
                <span className="font-mono text-mono-sm text-secondary">STEP 04 · 3D PREVIEW, SAVE &amp; BOQ</span>
                <h3 className="font-headline text-title-sm text-on-surface">Inspect in 3D &amp; Export Deliverables</h3>
                <p className="font-body text-body-sm text-on-surface-variant">
                  Switch to <strong>3D Preview</strong> to inspect elevated floors in Orbit or Walk mode — selection, drag-moving, copy/paste, and Undo/Redo work identically in 2D and 3D. Save with <strong>Ctrl + S</strong>, export <strong>JSON / PDF / PNG</strong>, or open <strong>Project Summary</strong> from the top navigation bar for BOQ &amp; load totals.
                </p>
              </div>
            </div>
          )}

          {activeTab === 'tools' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-gutter-sm">
              {[
                {
                  icon: 'arrow_selector_tool',
                  name: 'Select & Multi-Select',
                  desc: 'Click any room, wall, door, window, furniture item, or electrical fixture to inspect and edit its exact properties. Hold Shift + Click to multi-select or press Ctrl + A to select the entire active floor.',
                },
                {
                  icon: 'search',
                  name: 'Find Component (Ctrl + F)',
                  desc: 'Search placed canvas components and library catalogs by name, category, type, code, or ID. Filter by category, cycle matches with Enter / arrows, highlight on canvas, and jump straight to the component.',
                },
                {
                  icon: 'horizontal_rule',
                  name: 'Draw Wall',
                  desc: 'Click and drag on the 2D canvas to draw custom internal or external walls. Auto-snaps horizontally and vertically; hold Shift for angled walls.',
                },
                {
                  icon: 'add_box',
                  name: 'Add Room',
                  desc: 'Click any open area inside the site boundary to launch the room dimension dialog and place a typed room zone with finish styling.',
                },
                {
                  icon: 'door_front',
                  name: 'Add Door / Window',
                  desc: 'Hover near any perimeter or partition wall until the snap preview appears, then click to embed a parametric door or window.',
                },
                {
                  icon: 'straighten',
                  name: 'Dimension',
                  desc: 'Click and drag between any two points to place a live architectural measurement annotation.',
                },
                {
                  icon: 'open_with',
                  name: 'Move, Rotate & Duplicate',
                  desc: 'Drag rooms, furniture, openings, or electrical points smoothly in 2D or 3D. Use the Rotate button to turn 90°, Ctrl + C / Ctrl + V to copy & paste, or Ctrl + D to duplicate with unique IDs.',
                },
                {
                  icon: 'pan_tool',
                  name: 'Pan & Zoom',
                  desc: 'Drag with the Pan tool or middle mouse button to move the floor plan, scroll the mouse wheel to zoom, or click Fit in the toolbar to re-center.',
                },
                {
                  icon: 'ink_eraser',
                  name: 'Erase & Delete',
                  desc: 'Click any item with the Erase tool — or select one or more components and press Delete / Backspace (or the toolbar trash icon). Press Ctrl + Z anytime to restore.',
                },
              ].map((item) => (
                <div
                  key={item.name}
                  className="p-gutter-sm rounded-md bg-surface-container-low border border-outline-variant flex items-start gap-gutter-sm"
                >
                  <span className="material-symbols-outlined text-primary text-[18px] mt-0.5 shrink-0" aria-hidden="true">
                    {item.icon}
                  </span>
                  <div>
                    <div className="font-label text-label-md text-on-surface">{item.name}</div>
                    <p className="font-body text-body-sm text-on-surface-variant">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeTab === 'multifloor' && (
            <div className="flex flex-col gap-gutter-md">
              <div className="p-gutter-md rounded-md bg-primary-container/20 border border-primary flex flex-col gap-1.5">
                <div className="flex items-center gap-gutter-xs text-primary font-label text-label-md">
                  <span className="material-symbols-outlined text-[18px]" aria-hidden="true">layers</span>
                  <span>Setting Number of Floors (1 to 5 Stories)</span>
                </div>
                <p className="font-body text-body-sm text-on-surface-variant">
                  Choose the number of floors during Site Configuration, adjust <strong>Floors</strong> anytime inside <strong>C. Site Parameters</strong>, or click <strong>+ Floor</strong> on the Floor Switcher bar.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-gutter-sm">
                <div className="p-gutter-md rounded-md bg-surface-container-low border border-outline-variant flex flex-col gap-1">
                  <span className="font-mono text-mono-sm text-primary">SWITCHING FLOORS</span>
                  <p className="font-body text-body-sm text-on-surface-variant">
                    Use the <strong>1st Floor / 2nd Floor / 3rd Floor</strong> level tabs above the canvas to switch your active floor. Selecting a search result in <strong>Find (Ctrl + F)</strong> also switches floors automatically.
                  </p>
                </div>
                <div className="p-gutter-md rounded-md bg-surface-container-low border border-outline-variant flex flex-col gap-1">
                  <span className="font-mono text-mono-sm text-primary">ALIGN &amp; COPY BELOW</span>
                  <p className="font-body text-body-sm text-on-surface-variant">
                    Upper floors show a faint dashed underlay of the floor below so walls align cleanly. Click <strong>Copy Floor Below</strong> to duplicate the layout as a starting point.
                  </p>
                </div>
                <div className="p-gutter-md rounded-md bg-surface-container-low border border-outline-variant flex flex-col gap-1">
                  <span className="font-mono text-mono-sm text-secondary">ELEVATED 3D MODEL</span>
                  <p className="font-body text-body-sm text-on-surface-variant">
                    In <strong>3D Preview</strong>, floors stack vertically with slabs and columns. Switch between <strong>Orbit</strong> and <strong>Walk</strong> cameras, toggle Daylight/Evening lighting, and click or drag components directly in 3D.
                  </p>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'shortcuts' && (
            <div className="flex flex-col gap-gutter-md">
              <div className="p-gutter-md rounded-md bg-surface-container-low border border-outline-variant flex flex-col gap-1.5">
                <h3 className="font-headline text-title-sm text-on-surface">
                  Dismantling, Multi-Select &amp; 2D/3D Editing Controls
                </h3>
                <p className="font-body text-body-sm text-on-surface-variant">
                  Drag any room section directly out of the floor plan to reposition it freely — its attached furniture and electrical points move with it and all 4 walls stay intact. All shortcuts below work across both <strong>2D View</strong> and <strong>3D Preview</strong> and pause safely while typing inside input fields.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-gutter-xs font-mono text-mono-sm">
                {[
                  { key: 'Ctrl + F', action: 'Open Find Component search & highlight matches' },
                  { key: 'Ctrl + Z', action: 'Undo last edit (up to 100 steps)' },
                  { key: 'Ctrl + Y / Ctrl + Shift + Z', action: 'Redo previously undone edit' },
                  { key: 'Ctrl + C', action: 'Copy selected component(s) with properties' },
                  { key: 'Ctrl + V', action: 'Paste copied component(s) with unique IDs' },
                  { key: 'Ctrl + D', action: 'Duplicate selected component(s) immediately' },
                  { key: 'Delete / Backspace', action: 'Delete selected component(s)' },
                  { key: 'Ctrl + A', action: 'Select all elements on the active floor' },
                  { key: 'Shift + Click', action: 'Add or remove components in multi-selection' },
                  { key: 'Ctrl + S', action: 'Save project to workspace' },
                  { key: 'Escape', action: 'Close Find / drawers, cancel tool, or deselect' },
                  { key: 'Ctrl + Left Click', action: 'Quick-duplicate an item directly on canvas' },
                  { key: 'Mouse Wheel', action: 'Zoom in / out smoothly in 2D & 3D' },
                  { key: 'Middle Mouse / Pan Tool', action: 'Pan the floor plan freely in the viewport' },
                  { key: 'Right-Click Canvas', action: 'Open quick canvas options menu (2D & 3D)' },
                  { key: 'E / e (3D Preview)', action: 'Enter or exit enlarged 1:3 3D Walk mode' },
                  { key: 'W A S D / Arrows (3D Walk)', action: 'Navigate inside 3D Walk mode (upper or lowercase)' },
                  { key: 'Shift + Draw Wall', action: 'Draw custom angled walls freely' },
                ].map((sc) => (
                  <div
                    key={sc.key}
                    className="px-gutter-sm py-gutter-xs rounded-sm bg-surface border border-outline-variant flex items-center justify-between gap-gutter-sm"
                  >
                    <span className="text-primary shrink-0">{sc.key}</span>
                    <span className="text-on-surface-variant text-right font-body text-body-sm">{sc.action}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-gutter-xl py-gutter-md border-t border-outline-variant bg-surface-container-low flex items-center justify-between gap-gutter-sm">
          <span className="font-mono text-mono-sm text-on-surface-variant">
            Tip: Open this guide anytime from Home or the Guide button in Design Studio.
          </span>
          <div className="flex items-center gap-gutter-sm">
            {onStartDesigning && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onStartDesigning();
                }}
                className="inline-flex items-center gap-1.5 px-gutter-lg py-gutter-xs rounded-sm bg-primary text-on-primary font-label text-label-md hover:bg-on-primary-container cursor-pointer"
              >
                <span className="material-symbols-outlined text-[17px]" aria-hidden="true">
                  architecture
                </span>
                <span>Start Drawing</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="px-gutter-lg py-gutter-xs rounded-sm border border-outline text-on-surface hover:border-primary font-label text-label-md cursor-pointer"
            >
              Got It
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
