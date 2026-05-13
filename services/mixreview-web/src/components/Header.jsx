export function Header({
  projectName,
  approvalStatus,
  unresolvedCount,
  versions,
  activeVersionId,
  onStatusChange,
  onVersionChange,
  onShareSession,
  onBackToStart,
  onNewSession,
  onClearSession,
  onExportSession,
  onLockEngineerMode,
  permissions,
  isEngineerUnlocked
}) {
  const approvalStates = [
    "Pending Review",
    "Needs Changes",
    "Approved"
  ];

  return (
    <header className="topbar">
      <div>
        <p className="eyebrow">MixReview</p>
        <h1>{projectName}</h1>
      </div>

      <div className="project-controls">
        <div className="review-count">
          <span>{unresolvedCount}</span>
          open notes
        </div>
        <div className="permission-badge">{permissions.label}</div>

        {permissions.canEdit && (
          <div className="version-switcher" aria-label="Mix versions">
            {versions.map((version) => (
              <button
                type="button"
                className={version.id === activeVersionId ? "active" : ""}
                key={version.id}
                onClick={() => onVersionChange(version.id)}
              >
                <span>{version.label}</span>
                <small>{version.comments.length}</small>
              </button>
            ))}
          </div>
        )}

        <div className="session-actions">
          <button type="button" onClick={onBackToStart}>
            Back to Start
          </button>
          {permissions.canEdit && (
            <>
              <button type="button" onClick={onShareSession} disabled={!permissions.canShare}>
                Share Session
              </button>
              <button type="button" onClick={onNewSession}>
                New Session
              </button>
              <button type="button" onClick={onClearSession}>
                Clear Session
              </button>
              <button type="button" onClick={onExportSession}>
                Export
              </button>
            </>
          )}
          {isEngineerUnlocked && (
            <button type="button" onClick={onLockEngineerMode}>
              Lock Engineer Mode
            </button>
          )}
        </div>

        {permissions.canReview && (
          <div className="status-switch approval-switch" aria-label="Approval status">
            {approvalStates.map((state) => (
              <button
                type="button"
                className={`${state === approvalStatus ? "active" : ""}${
                  state.includes("Approved") ? " approved" : ""
                }`}
                key={state}
                onClick={() => onStatusChange(state)}
              >
                {state}
              </button>
            ))}
          </div>
        )}
      </div>
    </header>
  );
}
