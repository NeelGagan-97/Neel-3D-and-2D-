import React, { useState } from 'react';
import { ProjectData, SiteConfig, UnitSystem } from '../types/design';

interface SiteConfigStepProps {
  project: ProjectData;
  onCreateSite: (site: SiteConfig) => void;
  onBackHome: () => void;
}

export const SiteConfigStep: React.FC<SiteConfigStepProps> = ({
  project,
  onCreateSite,
  onBackHome,
}) => {
  const [units, setUnits] = useState<UnitSystem>(project.site.units);
  const [length, setLength] = useState<number>(project.site.units === 'ft' ? 40 : 12);
  const [width, setWidth] = useState<number>(project.site.units === 'ft' ? 30 : 10);
  // Wall thickness input in inches when feet, or meters when metres
  const [wallThickInput, setWallThickInput] = useState<number>(
    project.site.units === 'ft' ? 6 : 0.15
  );
  const [ceilingHeight, setCeilingHeight] = useState<number>(
    project.site.units === 'ft' ? 10 : 3
  );
  const [floors, setFloors] = useState<number>(project.site.floors || 1);
  const [error, setError] = useState<string | null>(null);

  const handleUnitSwitch = (nextUnit: UnitSystem) => {
    if (nextUnit === units) return;
    if (nextUnit === 'm') {
      setLength(Number((length * 0.3048).toFixed(1)));
      setWidth(Number((width * 0.3048).toFixed(1)));
      setCeilingHeight(Number((ceilingHeight * 0.3048).toFixed(1)));
      setWallThickInput(Number((wallThickInput * 0.0254).toFixed(2)));
    } else {
      setLength(Number((length / 0.3048).toFixed(1)));
      setWidth(Number((width / 0.3048).toFixed(1)));
      setCeilingHeight(Number((ceilingHeight / 0.3048).toFixed(1)));
      setWallThickInput(Math.round(wallThickInput / 0.0254));
    }
    setUnits(nextUnit);
  };

  const singleFloorArea = Number.isFinite(length) && Number.isFinite(width) && length > 0 && width > 0
    ? length * width
    : 0;
  const totalArea = singleFloorArea * Math.max(1, floors);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!Number.isFinite(length) || length <= 0 || !Number.isFinite(width) || width <= 0) {
      setError('Site Length and Site Width must be greater than zero.');
      return;
    }
    if (units === 'ft' && (length < 8 || width < 8 || length > 300 || width > 300)) {
      setError('Enter realistic site dimensions between 8 ft and 300 ft.');
      return;
    }
    if (units === 'm' && (length < 2.5 || width < 2.5 || length > 100 || width > 100)) {
      setError('Enter realistic site dimensions between 2.5 m and 100 m.');
      return;
    }
    if (!Number.isFinite(ceilingHeight) || ceilingHeight <= 0) {
      setError('Ceiling height must be greater than zero.');
      return;
    }
    if (!Number.isFinite(wallThickInput) || wallThickInput <= 0) {
      setError('Wall thickness must be greater than zero.');
      return;
    }

    // Store wallThickness in site.units (feet when ft: inches / 12; meters when m)
    const normalizedWallThickness =
      units === 'ft' ? Number((wallThickInput / 12).toFixed(3)) : Number(wallThickInput.toFixed(3));

    setError(null);
    onCreateSite({
      length: Number(length.toFixed(2)),
      width: Number(width.toFixed(2)),
      ceilingHeight: Number(ceilingHeight.toFixed(2)),
      wallThickness: normalizedWallThickness,
      units,
      floors: Math.max(1, Math.min(5, Math.round(floors))),
    });
  };

  return (
    <div className="flex-1 cad-grid bg-surface flex items-center justify-center p-gutter-lg lg:p-gutter-2xl">
      <div className="w-full max-w-3xl bg-surface-container border border-outline rounded-xl overflow-hidden">
        <div className="px-gutter-xl py-gutter-lg bg-surface-container-high border-b border-outline-variant flex flex-wrap items-center justify-between gap-gutter-md">
          <div>
            <div className="flex items-center gap-gutter-sm mb-1">
              <span className="font-mono text-mono-sm text-primary uppercase">
                STEP 2 OF 2 · SITE DIMENSION CONFIGURATION
              </span>
              <span className="font-mono text-mono-sm text-on-surface-variant">
                · {project.projectType ?? 'Residential'}
              </span>
            </div>
            <h1 className="font-headline text-headline-md text-on-surface">
              {project.name}
            </h1>
          </div>
          <span className="px-gutter-md py-gutter-xs rounded-sm bg-surface border border-outline font-mono text-mono-sm text-on-surface-variant">
            ID: {project.refCode}
          </span>
        </div>

        <form onSubmit={handleSubmit} className="p-gutter-xl flex flex-col gap-gutter-xl">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-gutter-lg">
            <label className="flex flex-col gap-gutter-xs">
              <span className="font-label text-label-md text-on-surface">
                Site Length ({units === 'ft' ? 'ft' : 'm'})
              </span>
              <input
                type="number"
                step="0.5"
                min={1}
                required
                value={length}
                onChange={(e) => setLength(Number(e.target.value))}
                className="w-full bg-surface border border-outline rounded-sm px-gutter-md py-gutter-sm font-mono text-mono-md text-on-surface tabular-nums focus:border-primary focus:outline-none"
              />
            </label>

            <label className="flex flex-col gap-gutter-xs">
              <span className="font-label text-label-md text-on-surface">
                Site Width ({units === 'ft' ? 'ft' : 'm'})
              </span>
              <input
                type="number"
                step="0.5"
                min={1}
                required
                value={width}
                onChange={(e) => setWidth(Number(e.target.value))}
                className="w-full bg-surface border border-outline rounded-sm px-gutter-md py-gutter-sm font-mono text-mono-md text-on-surface tabular-nums focus:border-primary focus:outline-none"
              />
            </label>

            <label className="flex flex-col gap-gutter-xs">
              <span className="font-label text-label-md text-on-surface">
                Wall Thickness ({units === 'ft' ? 'inches' : 'metres'})
              </span>
              <input
                type="number"
                step={units === 'ft' ? '0.5' : '0.01'}
                min={units === 'ft' ? 2 : 0.05}
                max={units === 'ft' ? 24 : 0.6}
                required
                value={wallThickInput}
                onChange={(e) => setWallThickInput(Number(e.target.value))}
                className="w-full bg-surface border border-outline rounded-sm px-gutter-md py-gutter-sm font-mono text-mono-md text-on-surface tabular-nums focus:border-primary focus:outline-none"
              />
            </label>

            <label className="flex flex-col gap-gutter-xs">
              <span className="font-label text-label-md text-on-surface">
                Ceiling Height ({units === 'ft' ? 'ft' : 'm'})
              </span>
              <input
                type="number"
                step="0.5"
                min={units === 'ft' ? 7 : 2.1}
                max={units === 'ft' ? 24 : 7.5}
                required
                value={ceilingHeight}
                onChange={(e) => setCeilingHeight(Number(e.target.value))}
                className="w-full bg-surface border border-outline rounded-sm px-gutter-md py-gutter-sm font-mono text-mono-md text-on-surface tabular-nums focus:border-primary focus:outline-none"
              />
            </label>

            <div className="flex flex-col gap-gutter-xs">
              <span className="font-label text-label-md text-on-surface">Measurement Unit</span>
              <div className="grid grid-cols-2 gap-gutter-xs bg-surface p-1 rounded-sm border border-outline">
                <button
                  type="button"
                  onClick={() => handleUnitSwitch('ft')}
                  className={`py-gutter-xs rounded-sm font-label text-label-md transition-colors cursor-pointer ${
                    units === 'ft'
                      ? 'bg-primary text-on-primary'
                      : 'text-on-surface-variant hover:text-on-surface'
                  }`}
                >
                  Feet (ft)
                </button>
                <button
                  type="button"
                  onClick={() => handleUnitSwitch('m')}
                  className={`py-gutter-xs rounded-sm font-label text-label-md transition-colors cursor-pointer ${
                    units === 'm'
                      ? 'bg-primary text-on-primary'
                      : 'text-on-surface-variant hover:text-on-surface'
                  }`}
                >
                  Metres (m)
                </button>
              </div>
            </div>

            <label className="flex flex-col gap-gutter-xs">
              <span className="font-label text-label-md text-on-surface">Number of Floors</span>
              <input
                type="number"
                min={1}
                max={5}
                required
                value={floors}
                onChange={(e) => setFloors(Math.max(1, Math.min(5, Number(e.target.value) || 1)))}
                className="w-full bg-surface border border-outline rounded-sm px-gutter-md py-gutter-sm font-mono text-mono-md text-on-surface tabular-nums focus:border-primary focus:outline-none"
              />
            </label>
          </div>

          {/* Live Calculated Site Area Readout */}
          <div className="bg-surface-container-low border border-outline rounded-lg p-gutter-lg grid grid-cols-1 sm:grid-cols-3 gap-gutter-md">
            <div className="flex flex-col gap-1">
              <span className="font-label text-label-sm text-on-surface-variant uppercase">
                Plot Footprint
              </span>
              <span className="font-mono text-headline-sm text-on-surface tabular-nums">
                {length || 0} {units} × {width || 0} {units}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="font-label text-label-sm text-on-surface-variant uppercase">
                Calculated Site Area
              </span>
              <span className="font-mono text-headline-sm text-primary tabular-nums">
                {singleFloorArea.toLocaleString('en-IN', { maximumFractionDigits: 1 })}{' '}
                {units === 'ft' ? 'sq. ft.' : 'sq. m.'}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="font-label text-label-sm text-on-surface-variant uppercase">
                Total Floor Potential
              </span>
              <span className="font-mono text-headline-sm text-secondary tabular-nums">
                {totalArea.toLocaleString('en-IN', { maximumFractionDigits: 1 })}{' '}
                {units === 'ft' ? 'sq. ft.' : 'sq. m.'}
              </span>
            </div>
          </div>

          {error && (
            <div
              role="alert"
              className="px-gutter-md py-gutter-sm rounded-sm bg-error/15 border border-error text-error font-mono text-mono-sm"
            >
              {error}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-gutter-md pt-gutter-md border-t border-outline-variant">
            <button
              type="button"
              onClick={onBackHome}
              className="px-gutter-lg py-gutter-sm rounded-sm border border-outline text-on-surface-variant hover:text-on-surface font-label text-label-md cursor-pointer"
            >
              Back to Home
            </button>

            <button
              type="submit"
              className="inline-flex items-center gap-gutter-sm px-gutter-2xl py-gutter-md rounded-md bg-primary text-on-primary font-label text-label-lg hover:bg-on-primary-container transition-colors duration-state-change cursor-pointer"
            >
              <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
                grid_on
              </span>
              <span>CREATE SITE</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
