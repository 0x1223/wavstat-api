export function Header({
  projectName,
  approvalStatus,
  unresolvedCount,
  versions,
  activeVersionId,
  backLabel = "Back to Start",
  onStatusChange,
  statusState,
  reviewSummary,
  onVersionChange,
  onShareSession,
  onBackToStart,
  onNewSession,
  onClearSession,
  onExportSession,
  permissions,
}) {
  const approvalStates = [
    "Needs Review",
    "Pending Review",
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
      <div className="topbar-title">
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
        <div className="header-action-cluster">
          <div className="review-count">
            <span>{unresolvedCount}</span>
            open notes
          </div>
          {showAdminActions && (
            <button type="button" className="header-export-button" onClick={onExportSession}>
              Export
            </button>
          )}

          <div className="permission-badge">{permissions.label}</div>

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
            </div>
          )}
        </div>

        {permissions.canReview && (
          <div className="header-status-zone">
            <div className="status-switch approval-switch" aria-label="Approval status">
              {approvalStates.map((state) => (
                <button
                  type="button"
                  disabled={
                    !statusState?.[state]?.enabled ||
                    (state === "Pending Review" && !reviewSummary?.needsReview)
                  }
                  className={`${statusState?.[state]?.active || state === approvalStatus ? "active" : ""} ${statusState?.[state]?.tone || ""}${state === "Pending Review" ? " pending-review-summary" : ""}${state === "Pending Review" && !reviewSummary?.needsReview ? " muted" : ""}`}
                  key={state}
                  onClick={() => onStatusChange(state)}
                >
                  {state === "Pending Review" ? (
                    <>
                      <span>Pending Reviews</span>
                      <small>{reviewSummary?.needsReview || 0}/{reviewSummary?.total || 0}</small>
                    </>
                  ) : state}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
