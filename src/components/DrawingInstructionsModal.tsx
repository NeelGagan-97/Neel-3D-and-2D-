import React, { useState } from 'react';

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
                STEP-BY-STEP CAD WORKFLOW · 2D FLOOR PLANS · ELEVATED 3D FLOORS
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
              { id: 'shortcuts', label: '4. Dismantle & Keys', icon: 'keyboard' },
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
                <span className="font-mono text-mono-sm text-primary">STEP 01 · CREATE PROJECT</span>
                <h3 className="font-headline text-title-sm text-on-surface">Set Name, Units &amp; Plot</h3>
                <p className="font-body text-body-sm text-on-surface-variant">
                  Click <strong>CREATE YOUR OWN SPACE</strong>, choose Feet or Metres, then enter Site Length, Site Width, Wall Thickness, Ceiling Height, and Number of Floors (1–5).
                </p>
              </div>
              <div className="p-gutter-md rounded-md bg-surface-container-low border border-outline-variant flex flex-col gap-1.5">
                <span className="font-mono text-mono-sm text-primary">STEP 02 · ADD ROOMS &amp; WALLS</span>
                <h3 className="font-headline text-title-sm text-on-surface">Draft Your 2D Floor Plan</h3>
                <p className="font-body text-body-sm text-on-surface-variant">
                  Click anywhere inside the blank site boundary — or open <strong>B. Room Library</strong> beside Drawing Tools — to place rooms with exact Length × Width dimensions.
                </p>
              </div>
              <div className="p-gutter-md rounded-md bg-surface-container-low border border-outline-variant flex flex-col gap-1.5">
                <span className="font-mono text-mono-sm text-secondary">STEP 03 · DOORS, WINDOWS &amp; ELECTRICAL</span>
                <h3 className="font-headline text-title-sm text-on-surface">Detail Openings &amp; Circuits</h3>
                <p className="font-body text-body-sm text-on-surface-variant">
                  Use <strong>Add Door</strong> and <strong>Add Window</strong> to snap openings onto any wall. Open <strong>D. Electrical Library</strong> to place fans, lights, sockets, ACs, and geysers.
                </p>
              </div>
              <div className="p-gutter-md rounded-md bg-surface-container-low border border-outline-variant flex flex-col gap-1.5">
                <span className="font-mono text-mono-sm text-secondary">STEP 04 · INSPECT 3D &amp; EXPORT</span>
                <h3 className="font-headline text-title-sm text-on-surface">3D Preview &amp; Project Summary</h3>
                <p className="font-body text-body-sm text-on-surface-variant">
                  Toggle <strong>3D Preview</strong> to inspect elevated floors in Orbit or First-Person Walk mode. Export your drawing as <strong>JSON, PDF, or PNG</strong>, or open <strong>Project Summary</strong> for BOQ &amp; load calculations.
                </p>
              </div>
            </div>
          )}

          {activeTab === 'tools' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-gutter-sm">
              {[
                { icon: 'arrow_selector_tool', name: 'Select', desc: 'Click any room, wall, opening, or point to edit its exact dimensions in the right Properties Inspector. Drag rooms to reposition or resize via corner handles.' },
                { icon: 'horizontal_rule', name: 'Draw Wall', desc: 'Click and drag on the 2D canvas to draw custom internal or external walls. Auto-snaps horizontally/vertically; hold Shift for angled walls.' },
                { icon: 'add_box', name: 'Add Room', desc: 'Click any open spot inside the site boundary to launch the room dimension dialog and place a typed room zone.' },
                { icon: 'door_front', name: 'Add Door / Window', desc: 'Hover near any perimeter or partition wall until the snap preview appears, then click to embed a parametric door or window.' },
                { icon: 'straighten', name: 'Dimension', desc: 'Click and drag between any two points to place a live architectural measurement line.' },
                { icon: 'open_with', name: 'Move & Rotate', desc: 'Drag sections freely anywhere on the canvas with Move, or click rooms/doors/windows with Rotate to turn 90°.' },
                { icon: 'pan_tool', name: 'Pan', desc: 'Drag anywhere on the 2D canvas (even over rooms or walls) to pan the model freely inside the viewport.' },
                { icon: 'ink_eraser', name: 'Erase', desc: 'Click any room, custom wall, door, window, dimension line, or electrical fixture to remove it (Undo restores anytime).' },
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
                  Choose the number of floors during Site Configuration, or adjust <strong>Floors</strong> anytime inside <strong>C. Site Parameters</strong> (or click <strong>+</strong> on the Floor Switcher bar).
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-gutter-sm">
                <div className="p-gutter-md rounded-md bg-surface-container-low border border-outline-variant flex flex-col gap-1">
                  <span className="font-mono text-mono-sm text-primary">SWITCHING FLOORS</span>
                  <p className="font-body text-body-sm text-on-surface-variant">
                    Use the <strong>1st Floor / 2nd Floor / 3rd Floor</strong> level tabs above the canvas to switch your active drawing floor while working.
                  </p>
                </div>
                <div className="p-gutter-md rounded-md bg-surface-container-low border border-outline-variant flex flex-col gap-1">
                  <span className="font-mono text-mono-sm text-primary">ALIGN &amp; COPY BELOW</span>
                  <p className="font-body text-body-sm text-on-surface-variant">
                    Upper floors display a faint dashed ghost underlay of the floor below so walls align cleanly. Click <strong>Copy Floor Below</strong> to duplicate the layout as a starting point.
                  </p>
                </div>
                <div className="p-gutter-md rounded-md bg-surface-container-low border border-outline-variant flex flex-col gap-1">
                  <span className="font-mono text-mono-sm text-secondary">ELEVATED 3D MODEL</span>
                  <p className="font-body text-body-sm text-on-surface-variant">
                    In <strong>3D Preview</strong>, floors stack vertically with structural slabs and corner columns. Switch between <strong>All Floors</strong>, <strong>Up to Active</strong>, or <strong>Active Only</strong> cutaway views.
                  </p>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'shortcuts' && (
            <div className="flex flex-col gap-gutter-md">
              <div className="p-gutter-md rounded-md bg-surface-container-low border border-outline-variant flex flex-col gap-1.5">
                <h3 className="font-headline text-title-sm text-on-surface">
                  Dismantling &amp; Free Section Placement
                </h3>
                <p className="font-body text-body-sm text-on-surface-variant">
                  Grab and drag any room section directly out of the floor plan to place it freely anywhere on the 2D canvas — its attached furniture and electrical points move with it and all 4 walls stay intact. You can also click <strong>Dismantle Section to Canvas</strong> in the right Properties Inspector.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-gutter-xs font-mono text-mono-sm">
                {[
                  { key: 'Ctrl + A / Cmd + A', action: 'Select all elements on the current floor SVG' },
                  { key: 'Esc', action: 'Clear selection / close open dropdowns' },
                  { key: 'Delete / Backspace', action: 'Clear selected elements when Ctrl+A is active' },
                  { key: 'Mouse Wheel', action: 'Zoom in / out smoothly on the 2D canvas' },
                  { key: 'Middle Mouse / Pan Tool', action: 'Move the entire floor plan freely in the viewport' },
                  { key: 'Shift + Draw Wall', action: 'Draw custom angled walls freely' },
                  { key: 'W A S D / Arrows (3D Walk)', action: 'Walk through the currently selected elevated floor' },
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
            Tip: Open this guide anytime from Home or the Design Studio toolbar.
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
