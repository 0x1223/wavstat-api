export function Header({
  projectName,
  approvalStatus,
  unresolvedCount,
  versions,
  activeVersionId,
  backLabel = "Back to Start",
  onStatusChange,
  statusState,
  onVersionChange,
  onShareSession,
  onBackToStart,
  onNewSession,
  onClearSession,
  onExportSession,
  permissions,
}) {
  const approvalStates = [
    "Pending Review",
    "Needs Review",
    "Approved"
  ];
  const isBackToStart = backLabel === "Back to Start";
  const showAdminActions = permissions.canEdit;

  function handleBackClick() {
    if (isBackToStart) {
      window.localStorage.removeItem("mixreview.latestSession");
      window.localStorage.removeItem("mixreview.accessState");
      window.sessionStorage.removeItem("mixreview.engineerUnlocked");
      window.history.replaceState(null, "", "/");
    }

    onBackToStart();
  }

  return (
    <header className="topbar">
      <div>
        <p className="eyebrow">MixReview</p>
        <div className="mobile-session-title">
          <h1>{projectName}</h1>
          {!permissions.canEdit && permissions.canReview && (
            <span className={`mobile-status-badge ${statusState?.[approvalStatus]?.tone || ""}`}>
              {approvalStatus}
            </span>
          )}
        </div>
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

        {showAdminActions && (
          <div className="session-actions">
            <button type="button" onClick={handleBackClick}>
              {backLabel}
            </button>
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
          </div>
        )}

        {permissions.canReview && (
          <div className="status-switch approval-switch" aria-label="Approval status">
            {approvalStates.map((state) => (
              <button
                type="button"
                disabled={!statusState?.[state]?.enabled}
                className={`${statusState?.[state]?.active || state === approvalStatus ? "active" : ""} ${statusState?.[state]?.tone || ""}`}
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
