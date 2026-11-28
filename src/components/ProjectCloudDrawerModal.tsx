import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  deleteProjectAttachment,
  getAttachmentSignedUrl,
  listProjectAttachments,
  listProjectVersions,
  MAX_ATTACHMENT_SIZE_BYTES,
  restoreProjectVersion,
  uploadProjectAttachment,
} from '../services/cloudProjectStorage';
import {
  ProjectAttachmentRecord,
  ProjectConflictInfo,
  ProjectData,
  ProjectVersionRecord,
} from '../types/design';

interface ProjectCloudModalProps {
  isOpen: boolean;
  project: ProjectData;
  userId: string | null;
  initialTab?: 'attachments' | 'versions';
  onClose: () => void;
  onVersionRestored: (restoredProject: ProjectData) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export const ProjectCloudDrawerModal: React.FC<ProjectCloudModalProps> = ({
  isOpen,
  project,
  userId,
  initialTab = 'attachments',
  onClose,
  onVersionRestored,
}) => {
  const [tab, setTab] = useState<'attachments' | 'versions'>(initialTab);
  const [attachments, setAttachments] = useState<ProjectAttachmentRecord[]>([]);
  const [versions, setVersions] = useState<ProjectVersionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab, isOpen]);

  const loadData = useCallback(async () => {
    if (!isOpen || !project.cloudId) return;
    setLoading(true);
    setError(null);
    try {
      const [attRes, verRes] = await Promise.all([
        listProjectAttachments(project.cloudId),
        listProjectVersions(project.cloudId),
      ]);
      if (attRes.ok) {
        setAttachments(attRes.attachments);
      }
      if (verRes.ok) {
        setVersions(verRes.versions);
      }
      if (!attRes.ok && !verRes.ok) {
        setError(attRes.error || verRes.error || 'Could not load cloud project files or versions.');
      }
    } finally {
      setLoading(false);
    }
  }, [isOpen, project.cloudId]);

  useEffect(() => {
    if (isOpen) {
      setNotice(null);
      void loadData();
    }
  }, [isOpen, loadData]);

  if (!isOpen) return null;

  const handleUploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !userId || !project.cloudId) return;
    if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
      setError('Selected file exceeds the 50 MB cloud attachment limit.');
      return;
    }
    setUploading(true);
    setError(null);
    setNotice(null);
    const res = await uploadProjectAttachment(userId, project.cloudId, file);
    setUploading(false);
    if (!res.ok || !res.attachment) {
      setError(res.error || 'Failed to upload attachment.');
      return;
    }
    setAttachments((prev) => [res.attachment!, ...prev]);
    setNotice(`Uploaded "${res.attachment.fileName}" to Supabase Storage.`);
  };

  const handleDownloadAttachment = async (att: ProjectAttachmentRecord) => {
    setError(null);
    const res = await getAttachmentSignedUrl(att.storagePath, 300);
    if (!res.ok || !res.signedUrl) {
      setError(res.error || 'Could not create temporary download link.');
      return;
    }
    const anchor = document.createElement('a');
    anchor.href = res.signedUrl;
    anchor.download = att.fileName;
    anchor.rel = 'noopener noreferrer';
    anchor.target = '_blank';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
  };

  const handleDeleteAttachment = async (att: ProjectAttachmentRecord) => {
    setError(null);
    const res = await deleteProjectAttachment(att);
    if (!res.ok) {
      setError(res.error || 'Failed to remove attachment.');
      return;
    }
    setAttachments((prev) => prev.filter((item) => item.id !== att.id));
    setNotice(`Removed "${att.fileName}".`);
  };

  const handleRestoreVersion = async (ver: ProjectVersionRecord) => {
    if (!userId) return;
    setRestoringId(ver.id);
    setError(null);
    setNotice(null);
    const res = await restoreProjectVersion(userId, project, ver.id);
    setRestoringId(null);
    if (!res.ok || !res.project) {
      setError(res.error || 'Failed to restore project version.');
      return;
    }
    onVersionRestored(res.project);
    setNotice(`Restored "${project.name}" to version v${ver.versionNumber}.`);
    void loadData();
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-gutter-md"
      role="dialog"
      aria-modal="true"
      aria-label="Project Cloud Files and Version History"
    >
      <div className="bg-surface-container border border-outline rounded-lg shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
        <header className="px-gutter-lg py-gutter-md border-b border-outline-variant flex items-center justify-between gap-gutter-sm bg-surface-container-low">
          <div className="min-w-0">
            <h2 className="font-headline text-title-md text-on-surface truncate">
              Cloud Storage — {project.name}
            </h2>
            <p className="font-mono text-mono-sm text-on-surface-variant">
              {project.cloudId
                ? `Cloud Revision v${project.cloudVersion ?? 1}`
                : 'Local offline cache (will sync once Supabase cloud is connected)'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close cloud modal"
            className="w-8 h-8 inline-flex items-center justify-center rounded-sm border border-outline-variant text-on-surface-variant hover:text-on-surface hover:border-outline cursor-pointer"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
              close
            </span>
          </button>
        </header>

        <div className="px-gutter-lg pt-gutter-sm border-b border-outline-variant flex items-center gap-gutter-sm bg-surface-container-low">
          <button
            type="button"
            onClick={() => setTab('attachments')}
            className={`px-gutter-md py-2 font-label text-label-md border-b-2 transition-colors cursor-pointer ${
              tab === 'attachments'
                ? 'border-primary text-primary'
                : 'border-transparent text-on-surface-variant hover:text-on-surface'
            }`}
          >
            Files & Attachments ({attachments.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('versions')}
            className={`px-gutter-md py-2 font-label text-label-md border-b-2 transition-colors cursor-pointer ${
              tab === 'versions'
                ? 'border-primary text-primary'
                : 'border-transparent text-on-surface-variant hover:text-on-surface'
            }`}
          >
            Version History ({versions.length})
          </button>
        </div>

        <div className="p-gutter-lg overflow-y-auto flex-1 flex flex-col gap-gutter-md">
          {error && (
            <div className="p-gutter-sm rounded-sm bg-error/10 border border-error text-error font-body text-body-sm">
              {error}
            </div>
          )}
          {notice && (
            <div className="p-gutter-sm rounded-sm bg-primary-container/30 border border-primary/50 text-primary font-body text-body-sm">
              {notice}
            </div>
          )}

          {!project.cloudId ? (
            <div className="p-gutter-lg rounded-md bg-surface-container-low border border-outline-variant text-center flex flex-col items-center gap-gutter-sm">
              <span className="material-symbols-outlined text-3xl text-on-surface-variant" aria-hidden="true">
                cloud_off
              </span>
              <p className="font-body text-body-md text-on-surface">
                This project is currently stored in your local offline cache.
              </p>
              <p className="font-body text-body-sm text-on-surface-variant max-w-md">
                Once connected to your Supabase project and signed in, cloud attachments and automatic version snapshots will be available here.
              </p>
            </div>
          ) : tab === 'attachments' ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-gutter-sm">
                <p className="font-body text-body-sm text-on-surface-variant">
                  Upload CAD drawings (DXF), architectural PDFs, site images, BOQ sheets, or .bluespace backups (max 50 MB).
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.dxf,.json,.xlsx,.csv,.bluespace"
                  onChange={handleUploadFile}
                  className="hidden"
                />
                <button
                  type="button"
                  disabled={uploading || !userId}
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-gutter-xs px-gutter-md py-2 rounded-sm bg-primary text-on-primary font-label text-label-md hover:opacity-90 disabled:opacity-50 cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                    upload_file
                  </span>
                  <span>{uploading ? 'Uploading...' : 'Upload Attachment'}</span>
                </button>
              </div>

              {loading ? (
                <p className="font-body text-body-sm text-on-surface-variant py-6 text-center">
                  Loading cloud attachments...
                </p>
              ) : attachments.length === 0 ? (
                <div className="p-gutter-lg rounded-md bg-surface-container-low border border-outline-variant text-center font-body text-body-sm text-on-surface-variant">
                  No cloud attachments uploaded for this project yet.
                </div>
              ) : (
                <ul className="flex flex-col gap-gutter-xs">
                  {attachments.map((att) => (
                    <li
                      key={att.id}
                      className="p-gutter-sm rounded-sm bg-surface-container-low border border-outline-variant flex items-center justify-between gap-gutter-sm"
                    >
                      <div className="min-w-0">
                        <div className="font-title text-title-sm text-on-surface truncate">
                          {att.fileName}
                        </div>
                        <div className="font-mono text-mono-sm text-on-surface-variant">
                          {att.kind.toUpperCase()} • {formatBytes(att.sizeBytes)} •{' '}
                          {formatDateTime(att.createdAt)}
                        </div>
                      </div>
                      <div className="flex items-center gap-gutter-xs shrink-0">
                        <button
                          type="button"
                          onClick={() => void handleDownloadAttachment(att)}
                          title="Download Attachment"
                          className="px-gutter-sm py-1 rounded-sm bg-surface-container border border-outline-variant text-primary hover:border-primary font-label text-label-sm cursor-pointer"
                        >
                          Download
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteAttachment(att)}
                          title="Delete Attachment"
                          className="p-1.5 rounded-sm bg-surface-container border border-outline-variant text-error hover:border-error cursor-pointer"
                        >
                          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                            delete
                          </span>
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : loading ? (
            <p className="font-body text-body-sm text-on-surface-variant py-6 text-center">
              Loading version history...
            </p>
          ) : versions.length === 0 ? (
            <div className="p-gutter-lg rounded-md bg-surface-container-low border border-outline-variant text-center font-body text-body-sm text-on-surface-variant">
              No saved cloud snapshots recorded yet.
            </div>
          ) : (
            <ul className="flex flex-col gap-gutter-xs">
              {versions.map((ver) => (
                <li
                  key={ver.id}
                  className="p-gutter-sm rounded-sm bg-surface-container-low border border-outline-variant flex items-center justify-between gap-gutter-sm"
                >
                  <div className="min-w-0">
                    <div className="font-title text-title-sm text-on-surface">
                      Version v{ver.versionNumber}{' '}
                      <span className="font-body text-body-sm text-on-surface-variant">
                        — {ver.changeSummary}
                      </span>
                    </div>
                    <div className="font-mono text-mono-sm text-on-surface-variant">
                      {formatDateTime(ver.createdAt)}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={restoringId === ver.id}
                    onClick={() => void handleRestoreVersion(ver)}
                    className="px-gutter-sm py-1 rounded-sm bg-primary-container border border-primary text-primary hover:bg-primary hover:text-on-primary font-label text-label-sm disabled:opacity-50 cursor-pointer shrink-0"
                  >
                    {restoringId === ver.id ? 'Restoring...' : 'Restore Version'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};

interface ProjectConflictModalProps {
  conflict: ProjectConflictInfo | null;
  resolving: boolean;
  onResolve: (strategy: 'use-cloud' | 'keep-local' | 'keep-both') => void;
  onDismiss: () => void;
}

export const ProjectConflictModal: React.FC<ProjectConflictModalProps> = ({
  conflict,
  resolving,
  onResolve,
  onDismiss,
}) => {
  if (!conflict) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-gutter-md"
      role="dialog"
      aria-modal="true"
      aria-label="Resolve Cloud Sync Conflict"
    >
      <div className="bg-surface-container border border-warning rounded-lg shadow-2xl w-full max-w-lg p-gutter-lg flex flex-col gap-gutter-md">
        <div className="flex items-start justify-between gap-gutter-sm">
          <div>
            <h2 className="font-headline text-title-md text-on-surface">
              Sync Conflict Detected
            </h2>
            <p className="font-body text-body-sm text-on-surface-variant mt-1">
              &ldquo;{conflict.projectName}&rdquo; was updated on another device (Cloud v
              {conflict.remoteVersion} vs your local base v{conflict.localVersion}). Choose how to
              preserve your work:
            </p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Close conflict dialog"
            className="text-on-surface-variant hover:text-on-surface cursor-pointer"
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
              close
            </span>
          </button>
        </div>

        <div className="grid grid-cols-2 gap-gutter-sm font-mono text-mono-sm">
          <div className="p-gutter-sm rounded-sm bg-surface-container-low border border-outline-variant">
            <div className="text-on-surface font-semibold">This Device</div>
            <div className="text-on-surface-variant">Base v{conflict.localVersion}</div>
            <div className="text-on-surface-variant">{formatDateTime(conflict.localUpdatedAt)}</div>
          </div>
          <div className="p-gutter-sm rounded-sm bg-surface-container-low border border-outline-variant">
            <div className="text-primary font-semibold">Cloud Version</div>
            <div className="text-on-surface-variant">Latest v{conflict.remoteVersion}</div>
            <div className="text-on-surface-variant">{formatDateTime(conflict.remoteUpdatedAt)}</div>
          </div>
        </div>

        <div className="flex flex-col gap-gutter-xs">
          <button
            type="button"
            disabled={resolving}
            onClick={() => onResolve('keep-both')}
            className="w-full px-gutter-md py-2 rounded-sm bg-primary text-on-primary font-label text-label-md hover:opacity-90 disabled:opacity-50 cursor-pointer"
          >
            Keep Both (Save My Edits as a Copy & Keep Cloud Version)
          </button>
          <button
            type="button"
            disabled={resolving}
            onClick={() => onResolve('use-cloud')}
            className="w-full px-gutter-md py-2 rounded-sm bg-surface-container-high border border-outline text-on-surface hover:border-primary font-label text-label-md disabled:opacity-50 cursor-pointer"
          >
            Use Latest Cloud Version (v{conflict.remoteVersion})
          </button>
          <button
            type="button"
            disabled={resolving}
            onClick={() => onResolve('keep-local')}
            className="w-full px-gutter-md py-2 rounded-sm bg-surface-container border border-warning text-warning hover:bg-warning/10 font-label text-label-md disabled:opacity-50 cursor-pointer"
          >
            Overwrite Cloud with This Device&apos;s Version
          </button>
        </div>
      </div>
    </div>
  );
};
