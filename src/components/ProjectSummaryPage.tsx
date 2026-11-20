import React, { useMemo, useState } from 'react';
import { computeProjectMetrics, formatINR } from '../data/presets';
import { ProjectData, ScreenId } from '../types/design';
import { downloadFloorPlanPdf } from '../utils/exporters';
import { FloorPlan2D } from './FloorPlan2D';
import { Navbar } from './Navbar';
import { Viewport3D } from './Viewport3D';

interface ProjectSummaryPageProps {
  project: ProjectData;
  onNavigate: (screen: ScreenId) => void;
  onSaveProject: () => void;
}

export const ProjectSummaryPage: React.FC<ProjectSummaryPageProps> = ({
  project,
  onNavigate,
  onSaveProject,
}) => {
  const metrics = useMemo(() => computeProjectMetrics(project), [project]);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [showQuoteModal, setShowQuoteModal] = useState(false);
  const [quoteSubmitted, setQuoteSubmitted] = useState(false);
  const [clientName, setClientName] = useState('');
  const [clientEmail, setClientEmail] = useState('');
  const [clientCity, setClientCity] = useState('Bengaluru');

  const notify = (msg: string) => {
    setFeedback(msg);
    window.setTimeout(() => setFeedback(null), 3500);
  };

  const handleSave = () => {
    onSaveProject();
    notify('Project & BOQ snapshot saved to local workspace.');
  };

  const handleDownloadPdf = () => {
    downloadFloorPlanPdf(project);
    notify(`Downloaded architectural floor plan PDF for "${project.name}".`);
  };

  const handleExportExcel = () => {
    const lines: string[] = [];
    lines.push(`"Ananya Space Designer — Engineering BOQ Report"`);
    lines.push(`"Project","${project.name}","Reference","${project.refCode}"`);
    lines.push(`"Site Dimensions","${metrics.dimensionsDisplay}","Area","${metrics.areaDisplay}"`);
    lines.push(`"Total Electrical Points","${metrics.totalPoints}","Connected Load (kW)","${metrics.totalKw.toFixed(2)}"`);
    lines.push('');
    lines.push('"ROOM-WISE ELECTRICAL BREAKDOWN"');
    lines.push('"Room","Fans","Lights","Switches","Sockets","Appliances","Room Load (W)"');
    metrics.roomBreakdown.forEach((r) => {
      lines.push(`"${r.roomName}",${r.fans},${r.lights},${r.switches},${r.sockets},${r.appliances},${r.loadWatts}`);
    });
    lines.push('');
    lines.push('"BILL OF QUANTITIES (BOQ)"');
    lines.push('"Product Name","Category","Quantity","Total Wattage (W)","Estimated Cost (INR)"');
    metrics.boqRows.forEach((b) => {
      lines.push(`"${b.productName}","${b.category}",${b.quantity},${b.totalWattage},${b.estimatedCost}`);
    });
    lines.push(`"TOTAL CONNECTED SYSTEM SUMMARY","",${metrics.totalPoints},${metrics.totalWatts},${metrics.totalCost}`);

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.refCode}_${project.name.replace(/\s+/g, '_')}_BOQ.csv`;
    a.click();
    URL.revokeObjectURL(url);
    notify('Exported Excel-compatible CSV Bill of Quantities.');
  };

  const handleQuoteSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setQuoteSubmitted(true);
  };

  const unitShort = project.site.units === 'ft' ? "'" : 'm';

  return (
    <div className="min-h-screen flex flex-col bg-surface text-on-surface">
      <Navbar
        activeScreen="summary"
        onNavigate={onNavigate}
        rightSlot={
          <button
            type="button"
            onClick={() => onNavigate('studio')}
            className="inline-flex items-center justify-center gap-gutter-sm bg-primary text-on-primary px-gutter-lg py-gutter-sm rounded-md font-label text-label-md transition-colors duration-state-change hover:bg-on-primary-container cursor-pointer whitespace-nowrap"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
              edit
            </span>
            <span>Edit Design</span>
          </button>
        }
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-gutter-lg lg:px-gutter-xl py-gutter-2xl flex flex-col gap-gutter-2xl">
        {/* Feedback Banner */}
        {feedback && (
          <div className="px-gutter-lg py-gutter-sm rounded-md bg-primary-container border border-primary text-on-primary-container font-mono text-mono-sm flex items-center justify-between no-print">
            <span>{feedback}</span>
            <button
              type="button"
              onClick={() => setFeedback(null)}
              className="text-primary hover:underline cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Report Header & Actions */}
        <section className="flex flex-col lg:flex-row lg:items-center justify-between gap-gutter-lg pb-gutter-xl border-b border-outline-variant">
          <div className="flex flex-col gap-gutter-xs">
            <div className="flex items-center gap-gutter-sm">
              <span className="px-gutter-sm py-0.5 rounded-full bg-primary-container text-primary font-mono text-mono-sm">
                PROJECT REPORT
              </span>
              <span className="font-mono text-mono-sm text-on-surface-variant">
                REF: {project.refCode}
              </span>
            </div>
            <h1 className="font-headline text-headline-lg-mobile lg:text-headline-lg text-on-surface">
              {project.name}
            </h1>
            <p className="font-body text-body-md text-on-surface-variant">
              Complete architectural dimensions, room-wise electrical schedule, and Bill of Quantities (BOQ).
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-gutter-sm no-print">
            <button
              type="button"
              onClick={() => onNavigate('studio')}
              className="inline-flex items-center gap-gutter-xs px-gutter-md py-gutter-sm rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-md transition-colors duration-state-change cursor-pointer whitespace-nowrap"
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                edit
              </span>
              <span>Edit Design</span>
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="inline-flex items-center gap-gutter-xs px-gutter-md py-gutter-sm rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-md transition-colors duration-state-change cursor-pointer whitespace-nowrap"
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                save
              </span>
              <span>Save Project</span>
            </button>
            <button
              type="button"
              onClick={handleDownloadPdf}
              className="inline-flex items-center justify-center gap-gutter-xs bg-surface-container-high text-on-surface border border-outline px-gutter-md py-gutter-sm rounded-sm font-label text-label-md hover:border-primary hover:text-primary transition-colors duration-state-change cursor-pointer whitespace-nowrap"
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                picture_as_pdf
              </span>
              <span>Download PDF</span>
            </button>
            <button
              type="button"
              onClick={handleExportExcel}
              className="inline-flex items-center gap-gutter-xs px-gutter-md py-gutter-sm rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-md transition-colors duration-state-change cursor-pointer whitespace-nowrap"
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                table_view
              </span>
              <span>Export Excel</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setQuoteSubmitted(false);
                setShowQuoteModal(true);
              }}
              className="inline-flex items-center gap-gutter-xs px-gutter-lg py-gutter-sm rounded-sm bg-secondary text-on-secondary font-label text-label-md hover:bg-on-secondary-container transition-colors duration-state-change cursor-pointer whitespace-nowrap"
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                request_quote
              </span>
              <span>Request Quotation</span>
            </button>
          </div>
        </section>

        {/* Visual Previews + Core Engineering KPIs */}
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-gutter-lg">
          <div className="lg:col-span-7 grid grid-cols-1 sm:grid-cols-2 gap-gutter-lg">
            <div className="bg-surface-container border border-outline-variant rounded-lg overflow-hidden flex flex-col">
              <div className="px-gutter-md py-gutter-sm border-b border-outline-variant bg-surface-container-high flex items-center justify-between">
                <span className="font-label text-label-sm text-on-surface-variant uppercase">
                  Project Thumbnail
                </span>
                <span className="font-mono text-mono-sm text-primary">2D BLUEPRINT</span>
              </div>
              <div className="aspect-video bg-surface">
                <FloorPlan2D project={project} previewOnly={true} />
              </div>
            </div>

            <div className="bg-surface-container border border-outline-variant rounded-lg overflow-hidden flex flex-col">
              <div className="px-gutter-md py-gutter-sm border-b border-outline-variant bg-surface-container-high flex items-center justify-between">
                <span className="font-label text-label-sm text-on-surface-variant uppercase">
                  3D Preview
                </span>
                <span className="font-mono text-mono-sm text-secondary">ELECTRICAL BIM</span>
              </div>
              <div className="aspect-video bg-surface">
                <Viewport3D
                  project={project}
                  previewOnly={true}
                  lightingMode="daylight"
                  showPins={false}
                />
              </div>
            </div>
          </div>

          <div className="lg:col-span-5 grid grid-cols-2 gap-gutter-md">
            <div className="bg-surface-container border border-outline-variant rounded-lg p-gutter-lg flex flex-col justify-between gap-gutter-sm">
              <span className="font-label text-label-sm text-on-surface-variant uppercase">
                Site Dimensions
              </span>
              <span className="font-mono text-headline-sm text-on-surface tabular-nums">
                {project.site.length}{unitShort} × {project.site.width}{unitShort}
              </span>
              <span className="font-mono text-mono-sm text-on-surface-variant tabular-nums">
                {metrics.areaDisplay} • {project.site.ceilingHeight}{unitShort} Ceiling
              </span>
            </div>

            <div className="bg-surface-container border border-outline-variant rounded-lg p-gutter-lg flex flex-col justify-between gap-gutter-sm">
              <span className="font-label text-label-sm text-on-surface-variant uppercase">
                Number of Rooms
              </span>
              <span className="font-mono text-headline-sm text-primary tabular-nums">
                {project.rooms.length} Rooms
              </span>
              <span className="font-mono text-mono-sm text-on-surface-variant">
                {project.site.floors === 1 ? 'Single Floor Plan' : `${project.site.floors} Floor Residence`}
              </span>
            </div>

            <div className="bg-surface-container border border-outline-variant rounded-lg p-gutter-lg flex flex-col justify-between gap-gutter-sm">
              <span className="font-label text-label-sm text-on-surface-variant uppercase">
                Total Electrical Points
              </span>
              <span className="font-mono text-headline-sm text-on-surface tabular-nums">
                {metrics.totalPoints} Points
              </span>
              <span className="font-mono text-mono-sm text-on-surface-variant">
                4 Sub-Circuits (230V)
              </span>
            </div>

            <div className="bg-surface-container border border-secondary rounded-lg p-gutter-lg flex flex-col justify-between gap-gutter-sm">
              <span className="font-label text-label-sm text-secondary uppercase">
                Total Connected Load
              </span>
              <span className="font-mono text-headline-sm text-secondary tabular-nums">
                {metrics.totalKw.toFixed(2)} kW
              </span>
              <span className="font-mono text-mono-sm text-on-surface-variant tabular-nums">
                Est. Demand: {metrics.estimatedAmps.toFixed(1)} A
              </span>
            </div>
          </div>
        </section>

        {/* Category Quantity Strip */}
        <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-gutter-md">
          <div className="bg-surface-container border border-outline-variant rounded-md p-gutter-lg flex items-center justify-between">
            <div className="flex flex-col gap-gutter-xs">
              <span className="font-label text-label-sm text-on-surface-variant">Fan Quantities</span>
              <span className="font-mono text-headline-md text-on-surface tabular-nums">
                {metrics.categoryCounts.Fans}
              </span>
            </div>
            <span className="material-symbols-outlined text-primary text-[24px]" aria-hidden="true">
              mode_fan
            </span>
          </div>

          <div className="bg-surface-container border border-outline-variant rounded-md p-gutter-lg flex items-center justify-between">
            <div className="flex flex-col gap-gutter-xs">
              <span className="font-label text-label-sm text-on-surface-variant">Lighting Quantities</span>
              <span className="font-mono text-headline-md text-on-surface tabular-nums">
                {metrics.categoryCounts.Lighting}
              </span>
            </div>
            <span className="material-symbols-outlined text-secondary text-[24px]" aria-hidden="true">
              lightbulb
            </span>
          </div>

          <div className="bg-surface-container border border-outline-variant rounded-md p-gutter-lg flex items-center justify-between">
            <div className="flex flex-col gap-gutter-xs">
              <span className="font-label text-label-sm text-on-surface-variant">Switch Quantities</span>
              <span className="font-mono text-headline-md text-on-surface tabular-nums">
                {metrics.categoryCounts.Switches}
              </span>
            </div>
            <span className="material-symbols-outlined text-primary text-[24px]" aria-hidden="true">
              toggle_on
            </span>
          </div>

          <div className="bg-surface-container border border-outline-variant rounded-md p-gutter-lg flex items-center justify-between">
            <div className="flex flex-col gap-gutter-xs">
              <span className="font-label text-label-sm text-on-surface-variant">Socket Quantities</span>
              <span className="font-mono text-headline-md text-on-surface tabular-nums">
                {metrics.categoryCounts.Sockets}
              </span>
            </div>
            <span className="material-symbols-outlined text-primary text-[24px]" aria-hidden="true">
              power
            </span>
          </div>

          <div className="bg-surface-container border border-outline-variant rounded-md p-gutter-lg flex items-center justify-between col-span-2 sm:col-span-1">
            <div className="flex flex-col gap-gutter-xs">
              <span className="font-label text-label-sm text-on-surface-variant">Appliance Quantities</span>
              <span className="font-mono text-headline-md text-secondary tabular-nums">
                {metrics.categoryCounts.Appliances}
              </span>
            </div>
            <span className="material-symbols-outlined text-secondary text-[24px]" aria-hidden="true">
              ac_unit
            </span>
          </div>
        </section>

        {/* Room-Wise Electrical Breakdown */}
        <section className="flex flex-col gap-gutter-md">
          <div className="flex items-center justify-between">
            <h2 className="font-headline text-headline-md text-on-surface">
              Room-Wise Electrical Breakdown
            </h2>
            <span className="font-mono text-mono-sm text-on-surface-variant tabular-nums">
              {project.rooms.length} ZONES
            </span>
          </div>

          <div className="w-full overflow-x-auto bg-surface-container border border-outline-variant rounded-lg">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-outline bg-surface-container-high">
                  <th scope="col" className="px-gutter-lg py-gutter-md font-label text-label-md text-on-surface-variant">Room</th>
                  <th scope="col" className="px-gutter-lg py-gutter-md font-label text-label-md text-on-surface-variant text-right">Fans</th>
                  <th scope="col" className="px-gutter-lg py-gutter-md font-label text-label-md text-on-surface-variant text-right">Lights</th>
                  <th scope="col" className="px-gutter-lg py-gutter-md font-label text-label-md text-on-surface-variant text-right">Switches</th>
                  <th scope="col" className="px-gutter-lg py-gutter-md font-label text-label-md text-on-surface-variant text-right">Sockets</th>
                  <th scope="col" className="px-gutter-lg py-gutter-md font-label text-label-md text-on-surface-variant text-right">Appliances</th>
                  <th scope="col" className="px-gutter-lg py-gutter-md font-label text-label-md text-on-surface-variant text-right">Room Load</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant">
                {metrics.roomBreakdown.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-gutter-lg py-gutter-xl text-center font-body text-body-md text-on-surface-variant">
                      No rooms created in this project yet. Open Design Studio to add rooms to your site.
                    </td>
                  </tr>
                ) : (
                  metrics.roomBreakdown.map((row) => (
                    <tr key={row.roomId} className="hover:bg-surface-container-high transition-colors duration-state-change">
                      <td className="px-gutter-lg py-gutter-md font-body text-body-md text-on-surface">{row.roomName}</td>
                      <td className="px-gutter-lg py-gutter-md font-mono text-mono-md text-on-surface text-right tabular-nums">{row.fans}</td>
                      <td className="px-gutter-lg py-gutter-md font-mono text-mono-md text-on-surface text-right tabular-nums">{row.lights}</td>
                      <td className="px-gutter-lg py-gutter-md font-mono text-mono-md text-on-surface text-right tabular-nums">{row.switches}</td>
                      <td className="px-gutter-lg py-gutter-md font-mono text-mono-md text-on-surface text-right tabular-nums">{row.sockets}</td>
                      <td className="px-gutter-lg py-gutter-md font-mono text-mono-md text-on-surface text-right tabular-nums">{row.appliances}</td>
                      <td className="px-gutter-lg py-gutter-md font-mono text-mono-md text-secondary text-right tabular-nums">
                        {row.loadWatts.toLocaleString('en-IN')} W
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Bill of Quantities (BOQ) Table */}
        <section className="flex flex-col gap-gutter-md">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-gutter-sm">
            <h2 className="font-headline text-headline-md text-on-surface">
              Bill of Quantities (BOQ)
            </h2>
            <span className="font-mono text-mono-md text-primary tabular-nums">
              Total Estimated Cost: {formatINR(metrics.totalCost)}
            </span>
          </div>

          <div className="w-full overflow-x-auto bg-surface-container border border-outline-variant rounded-lg">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-outline bg-surface-container-high">
                  <th scope="col" className="px-gutter-lg py-gutter-md font-label text-label-md text-on-surface-variant">Product Name</th>
                  <th scope="col" className="px-gutter-lg py-gutter-md font-label text-label-md text-on-surface-variant">Category</th>
                  <th scope="col" className="px-gutter-lg py-gutter-md font-label text-label-md text-on-surface-variant text-right">Quantity</th>
                  <th scope="col" className="px-gutter-lg py-gutter-md font-label text-label-md text-on-surface-variant text-right">Wattage</th>
                  <th scope="col" className="px-gutter-lg py-gutter-md font-label text-label-md text-on-surface-variant text-right">Estimated Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant">
                {metrics.boqRows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-gutter-lg py-gutter-xl text-center font-body text-body-md text-on-surface-variant">
                      No electrical points placed yet. Place electrical fixtures from Section D in Design Studio to populate the BOQ.
                    </td>
                  </tr>
                ) : (
                  metrics.boqRows.map((row) => (
                    <tr key={row.itemType} className="hover:bg-surface-container-high transition-colors duration-state-change">
                      <td className="px-gutter-lg py-gutter-md font-body text-body-md text-on-surface">{row.productName}</td>
                      <td className="px-gutter-lg py-gutter-md font-body text-body-sm text-on-surface-variant">{row.category}</td>
                      <td className="px-gutter-lg py-gutter-md font-mono text-mono-md text-on-surface text-right tabular-nums">{row.quantity}</td>
                      <td
                        className={`px-gutter-lg py-gutter-md font-mono text-mono-md text-right tabular-nums ${
                          row.totalWattage > 0 ? 'text-secondary' : 'text-on-surface-variant'
                        }`}
                      >
                        {row.totalWattage.toLocaleString('en-IN')} W
                      </td>
                      <td className="px-gutter-lg py-gutter-md font-mono text-mono-md text-on-surface text-right tabular-nums">
                        {formatINR(row.estimatedCost)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr className="border-t border-outline bg-surface-container-high">
                  <td colSpan={2} className="px-gutter-lg py-gutter-md font-label text-label-md text-on-surface">
                    Total Connected System Summary
                  </td>
                  <td className="px-gutter-lg py-gutter-md font-mono text-mono-md text-primary text-right tabular-nums">
                    {metrics.totalPoints}
                  </td>
                  <td className="px-gutter-lg py-gutter-md font-mono text-mono-md text-secondary text-right tabular-nums">
                    {metrics.totalKw.toFixed(2)} kW
                  </td>
                  <td className="px-gutter-lg py-gutter-md font-mono text-mono-md text-on-surface text-right tabular-nums">
                    {formatINR(metrics.totalCost)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="bg-surface-container border-t border-outline-variant">
        <div className="max-w-7xl mx-auto px-gutter-lg lg:px-gutter-xl py-gutter-lg flex flex-col sm:flex-row items-start sm:items-center justify-between gap-gutter-md">
          <span className="font-mono text-mono-sm text-on-surface-variant uppercase">
            ANANYA SPACE DESIGNER • DESIGN YOUR SPACE. POWER YOUR WORLD.
          </span>
          <span className="font-mono text-mono-sm text-on-surface-variant">
            BOQ Estimates Exclusive of Civil Conduit Labor
          </span>
        </div>
      </footer>

      {/* Request Quotation Modal */}
      {showQuoteModal && (
        <div
          className="fixed inset-0 z-50 bg-deep-navy/80 flex items-center justify-center p-gutter-lg no-print"
          role="dialog"
          aria-modal="true"
          aria-labelledby="quote-modal-title"
        >
          <div className="w-full max-w-md bg-surface-container border border-outline rounded-lg overflow-hidden">
            <div className="px-gutter-xl py-gutter-lg border-b border-outline-variant flex items-center justify-between">
              <h3 id="quote-modal-title" className="font-headline text-headline-sm text-on-surface">
                Request Contractor Quotation
              </h3>
              <button
                type="button"
                onClick={() => setShowQuoteModal(false)}
                aria-label="Close modal"
                className="text-on-surface-variant hover:text-on-surface cursor-pointer"
              >
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>

            {quoteSubmitted ? (
              <div className="p-gutter-xl flex flex-col gap-gutter-md">
                <div className="flex items-center gap-gutter-sm text-success">
                  <span className="material-symbols-outlined text-[24px]">check_circle</span>
                  <span className="font-headline text-headline-sm text-on-surface">
                    Quotation Request Logged
                  </span>
                </div>
                <p className="font-body text-body-md text-on-surface-variant">
                  Engineering BOQ package <span className="font-mono text-primary">{project.refCode}</span> ({metrics.totalPoints} points · {metrics.totalKw.toFixed(2)} kW · {formatINR(metrics.totalCost)}) has been queued for {clientName || 'your project'} in {clientCity}.
                </p>
                <div className="flex justify-end pt-gutter-sm">
                  <button
                    type="button"
                    onClick={() => setShowQuoteModal(false)}
                    className="px-gutter-lg py-gutter-sm rounded-sm bg-primary text-on-primary font-label text-label-md cursor-pointer"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleQuoteSubmit}>
                <div className="p-gutter-xl flex flex-col gap-gutter-md">
                  <div className="px-gutter-md py-gutter-sm rounded-sm bg-surface-container-low border border-outline-variant flex items-center justify-between">
                    <span className="font-body text-body-sm text-on-surface-variant">
                      {project.name} ({metrics.totalPoints} pts)
                    </span>
                    <span className="font-mono text-mono-md text-secondary tabular-nums">
                      {formatINR(metrics.totalCost)}
                    </span>
                  </div>
                  <label className="flex flex-col gap-gutter-xs">
                    <span className="font-label text-label-sm text-on-surface-variant">Full Name</span>
                    <input
                      type="text"
                      required
                      placeholder="Ananya Sharma"
                      value={clientName}
                      onChange={(e) => setClientName(e.target.value)}
                      className="w-full bg-surface border border-outline rounded-sm px-gutter-md py-gutter-sm font-body text-body-md text-on-surface focus:border-primary focus:outline-none"
                    />
                  </label>
                  <label className="flex flex-col gap-gutter-xs">
                    <span className="font-label text-label-sm text-on-surface-variant">Email Address</span>
                    <input
                      type="email"
                      required
                      placeholder="architect@studio.in"
                      value={clientEmail}
                      onChange={(e) => setClientEmail(e.target.value)}
                      className="w-full bg-surface border border-outline rounded-sm px-gutter-md py-gutter-sm font-body text-body-md text-on-surface focus:border-primary focus:outline-none"
                    />
                  </label>
                  <label className="flex flex-col gap-gutter-xs">
                    <span className="font-label text-label-sm text-on-surface-variant">Project City</span>
                    <input
                      type="text"
                      required
                      value={clientCity}
                      onChange={(e) => setClientCity(e.target.value)}
                      className="w-full bg-surface border border-outline rounded-sm px-gutter-md py-gutter-sm font-body text-body-md text-on-surface focus:border-primary focus:outline-none"
                    />
                  </label>
                </div>
                <div className="px-gutter-xl py-gutter-md border-t border-outline-variant bg-surface-container-low flex items-center justify-end gap-gutter-sm">
                  <button
                    type="button"
                    onClick={() => setShowQuoteModal(false)}
                    className="px-gutter-lg py-gutter-sm rounded-sm border border-outline text-on-surface-variant hover:text-on-surface font-label text-label-md cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-gutter-lg py-gutter-sm rounded-sm bg-secondary text-on-secondary font-label text-label-md hover:bg-on-secondary-container cursor-pointer"
                  >
                    Submit BOQ Request
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
