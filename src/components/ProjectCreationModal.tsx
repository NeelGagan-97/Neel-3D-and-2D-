import React, { useState } from 'react';
import { BuildingType, ProjectType, UnitSystem } from '../types/design';

export interface ProjectCreationInput {
  name: string;
  units: UnitSystem;
  projectType: ProjectType;
  buildingType: BuildingType;
  customStoreys?: number;
  includeBasement?: boolean;
  includeTerrace?: boolean;
  description: string;
}

interface ProjectCreationModalProps {
  onCancel: () => void;
  onCreate: (input: ProjectCreationInput) => void;
}

const INVALID_NAME_PATTERN = /[<>:"/\\|?*]/;

const BUILDING_TYPE_OPTIONS: {
  value: BuildingType;
  label: string;
  subtitle: string;
  icon: string;
}[] = [
  { value: 'single', label: 'Single Floor', subtitle: 'Ground Floor', icon: 'home' },
  { value: 'duplex', label: 'Duplex', subtitle: 'Ground + First', icon: 'villa' },
  { value: 'triplex', label: 'Triplex', subtitle: 'Ground + 1st + 2nd', icon: 'apartment' },
  { value: 'custom', label: 'Custom Multi-Storey', subtitle: 'Basement / Terrace', icon: 'domain' },
];

export const ProjectCreationModal: React.FC<ProjectCreationModalProps> = ({
  onCancel,
  onCreate,
}) => {
  const [name, setName] = useState('');
  const [units, setUnits] = useState<UnitSystem>('ft');
  const [projectType, setProjectType] = useState<ProjectType>('Residential');
  const [buildingType, setBuildingType] = useState<BuildingType>('duplex');
  const [customStoreys, setCustomStoreys] = useState<number>(3);
  const [includeBasement, setIncludeBasement] = useState<boolean>(false);
  const [includeTerrace, setIncludeTerrace] = useState<boolean>(true);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const validateName = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) {
      return 'Project name is required.';
    }
    if (trimmed.length < 2) {
      return 'Project name must be at least 2 characters.';
    }
    if (trimmed.length > 80) {
      return 'Project name cannot exceed 80 characters.';
    }
    if (INVALID_NAME_PATTERN.test(trimmed)) {
      return 'Project name contains invalid characters (< > : " / \\ | ? *).';
    }
    return null;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const validationErr = validateName(name);
    if (validationErr) {
      setError(validationErr);
      return;
    }
    onCreate({
      name: name.trim(),
      units,
      projectType,
      buildingType,
      customStoreys: buildingType === 'custom' ? Math.max(1, Math.min(6, customStoreys)) : undefined,
      includeBasement: buildingType === 'custom' ? includeBasement : false,
      includeTerrace: buildingType === 'custom' ? includeTerrace : false,
      description: description.trim(),
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-deep-navy/85 flex items-center justify-center p-gutter-lg overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-project-modal-title"
    >
      <form
        onSubmit={handleSubmit}
        noValidate
        className="w-full max-w-xl bg-surface-container border border-outline rounded-lg overflow-hidden my-auto"
      >
        {/* Header */}
        <div className="px-gutter-xl py-gutter-lg border-b border-outline-variant bg-surface-container-high flex items-center justify-between">
          <div className="flex items-center gap-gutter-sm">
            <div className="w-8 h-8 rounded-md bg-primary-container border border-primary flex items-center justify-center">
              <span className="material-symbols-outlined text-primary text-[18px]" aria-hidden="true">
                architecture
              </span>
            </div>
            <div>
              <h2 id="create-project-modal-title" className="font-headline text-headline-sm text-on-surface">
                Create Your Own Space
              </h2>
              <p className="font-mono text-mono-sm text-on-surface-variant">
                STEP 1 OF 2 · PROJECT &amp; BUILDING SPECIFICATION
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close modal"
            className="text-on-surface-variant hover:text-on-surface cursor-pointer p-1"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {/* Form Body */}
        <div className="p-gutter-xl flex flex-col gap-gutter-md">
          <label className="flex flex-col gap-gutter-xs">
            <span className="font-label text-label-md text-on-surface">
              Project Name <span className="text-secondary">*</span>
            </span>
            <input
              type="text"
              autoFocus
              required
              placeholder="My Dream Duplex - 3BHK"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError(validateName(e.target.value));
              }}
              className={`w-full bg-surface border rounded-sm px-gutter-md py-gutter-sm font-body text-body-md text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none ${
                error ? 'border-error focus:border-error' : 'border-outline focus:border-primary'
              }`}
            />
            {error && (
              <span className="font-mono text-mono-sm text-error" role="alert">
                {error}
              </span>
            )}
          </label>

          {/* Building Type Selection */}
          <div className="flex flex-col gap-gutter-xs">
            <span className="font-label text-label-md text-on-surface">
              Building Type
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-gutter-xs">
              {BUILDING_TYPE_OPTIONS.map((opt) => {
                const active = buildingType === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setBuildingType(opt.value)}
                    className={`flex flex-col items-start gap-1 p-2.5 rounded-sm border text-left transition-colors cursor-pointer ${
                      active
                        ? 'bg-primary-container border-primary text-primary'
                        : 'bg-surface border-outline text-on-surface-variant hover:border-primary/60 hover:text-on-surface'
                    }`}
                  >
                    <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                      {opt.icon}
                    </span>
                    <span className="font-label text-label-sm leading-tight">{opt.label}</span>
                    <span className="font-mono text-[10px] opacity-80 leading-tight">{opt.subtitle}</span>
                  </button>
                );
              })}
            </div>

            {buildingType === 'custom' && (
              <div className="mt-1 p-gutter-sm rounded-sm bg-surface border border-outline flex flex-wrap items-center justify-between gap-gutter-sm">
                <label className="flex items-center gap-2">
                  <span className="font-label text-label-sm text-on-surface-variant">Main Storeys:</span>
                  <input
                    type="number"
                    min={1}
                    max={6}
                    value={customStoreys}
                    onChange={(e) => setCustomStoreys(Math.max(1, Math.min(6, Number(e.target.value) || 1)))}
                    className="w-16 bg-surface-container border border-outline rounded-sm px-2 py-1 font-mono text-mono-sm text-on-surface tabular-nums focus:border-primary focus:outline-none"
                  />
                </label>
                <div className="flex items-center gap-gutter-md">
                  <label className="inline-flex items-center gap-1.5 cursor-pointer font-label text-label-sm text-on-surface">
                    <input
                      type="checkbox"
                      checked={includeBasement}
                      onChange={(e) => setIncludeBasement(e.target.checked)}
                      className="accent-primary"
                    />
                    <span>Basement</span>
                  </label>
                  <label className="inline-flex items-center gap-1.5 cursor-pointer font-label text-label-sm text-on-surface">
                    <input
                      type="checkbox"
                      checked={includeTerrace}
                      onChange={(e) => setIncludeTerrace(e.target.checked)}
                      className="accent-primary"
                    />
                    <span>Terrace</span>
                  </label>
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-gutter-md">
            <div className="flex flex-col gap-gutter-xs">
              <span className="font-label text-label-md text-on-surface">Measurement Unit</span>
              <div className="grid grid-cols-2 gap-gutter-xs bg-surface p-1 rounded-sm border border-outline">
                {(
                  [
                    { value: 'ft', label: 'Feet' },
                    { value: 'm', label: 'Metres' },
                  ] as { value: UnitSystem; label: string }[]
                ).map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setUnits(opt.value)}
                    className={`py-gutter-xs rounded-sm font-label text-label-md transition-colors duration-state-change cursor-pointer ${
                      units === opt.value
                        ? 'bg-primary text-on-primary'
                        : 'text-on-surface-variant hover:text-on-surface'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-gutter-xs">
              <span className="font-label text-label-md text-on-surface">Project Type</span>
              <select
                value={projectType}
                onChange={(e) => setProjectType(e.target.value as ProjectType)}
                className="w-full bg-surface border border-outline rounded-sm px-gutter-md py-gutter-sm font-body text-body-md text-on-surface focus:border-primary focus:outline-none"
              >
                <option value="Residential">Residential</option>
                <option value="Commercial">Commercial</option>
                <option value="Custom">Custom</option>
              </select>
            </div>
          </div>

          <label className="flex flex-col gap-gutter-xs">
            <span className="font-label text-label-md text-on-surface">
              Project Description <span className="text-on-surface-variant font-normal">(Optional)</span>
            </span>
            <textarea
              rows={2}
              placeholder="e.g., East-facing corner plot with duplex layout, staircase core, and floor-wise electrical circuits."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full bg-surface border border-outline rounded-sm px-gutter-md py-gutter-sm font-body text-body-md text-on-surface placeholder:text-on-surface-variant/50 focus:border-primary focus:outline-none resize-none"
            />
          </label>
        </div>

        {/* Footer */}
        <div className="px-gutter-xl py-gutter-md border-t border-outline-variant bg-surface-container-low flex items-center justify-end gap-gutter-sm">
          <button
            type="button"
            onClick={onCancel}
            className="px-gutter-lg py-gutter-sm rounded-sm border border-outline text-on-surface-variant hover:text-on-surface font-label text-label-md cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="inline-flex items-center gap-gutter-xs px-gutter-xl py-gutter-sm rounded-sm bg-primary text-on-primary font-label text-label-md hover:bg-on-primary-container transition-colors duration-state-change cursor-pointer"
          >
            <span>Create Project</span>
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
              arrow_forward
            </span>
          </button>
        </div>
      </form>
    </div>
  );
};
