// Needs Review = default/waiting state; Pending Review = reviewer submitted, engineer must act
const approvalStates = [
  "Needs Review",
  "Pending Review",
  "Approved"
];

const reviewers = ["Artist", "Engineer", "Manager", "Label"];

export function ReviewDashboard({
  activeVersion,
  versions,
  approvalSummary,
  activeTrack,
  sessionCreatedAt,
  currentReviewer,
  onReviewerChange,
  onApprovalChange,
  onSubmitFeedback,
  statusState,
  canApprove,
  canSubmit,
  canChooseReviewer
}) {
  const isMobile = typeof window !== "undefined" && window.innerWidth <= 768;
  const version = activeVersion || { comments: [], activity: [], approvalStatus: "Needs Review" };
  const unresolvedCount = version.comments.filter(
    (comment) => !comment.resolved,
  ).length;
  const selectedTrackReviewCount = unresolvedCount;
  const selectedTrackTotal = activeTrack ? 1 : 0;
  const selectedTrackActivity = buildSelectedTrackActivity({
    activeVersion: version,
    activeTrack,
    sessionCreatedAt
  });
  if (isMobile) {
    return null;
  }
  return (
    <section className="review-dashboard" aria-label="Review dashboard">
      <div className="dashboard-header">
        <div>
          <p className="eyebrow">Review Dashboard</p>
          <h2>{activeTrack?.title || version.label} approval workflow</h2>
        </div>

        <label className="reviewer-select">
          <span>Reviewer</span>
          <select
            disabled={!canChooseReviewer}
            value={currentReviewer}
            onChange={(event) => onReviewerChange(event.target.value)}
          >
            {reviewers.map((reviewer) => (
              <option key={reviewer} value={reviewer}>
                {reviewer}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="summary-grid">
        <SummaryMetric label="Total Comments" value={version.comments.length} />
        <SummaryMetric label="Unresolved" value={unresolvedCount} />
      </div>

      {(canApprove || canSubmit) && (
        <div className="approval-state-grid" aria-label="Approval states">
          {approvalStates.map((state) => (
            <button
              type="button"
              disabled={
                !canApprove ||
                !statusState?.[state]?.enabled ||
                (state === "Pending Review" && !selectedTrackReviewCount)
              }
              className={[
                statusState?.[state]?.active || state === version.approvalStatus ? "active" : "",
                statusState?.[state]?.tone || "",
                state === "Pending Review" ? "pending-review-summary" : "",
                state === "Pending Review" && !selectedTrackReviewCount ? "muted" : "",
                state === "Needs Review" ? "needs-review-btn" : "",
              ].filter(Boolean).join(" ")}
              key={state}
              onClick={() => onApprovalChange(state)}
            >
              {state === "Pending Review" ? (
                <>
                  <span>Pending Reviews</span>
                  <small>{selectedTrackReviewCount}/{selectedTrackTotal}</small>
                </>
              ) : state}
            </button>
          ))}
          <button type="button" disabled={!canSubmit} onClick={onSubmitFeedback}>
            Submit Feedback
          </button>
        </div>
      )}

      {selectedTrackActivity.length === 0 && (
        <div className="empty-state compact">
          <strong>Fresh track, clean slate.</strong>
          <p>Selected-track creation and review history will collect here.</p>
        </div>
      )}

      <div className="dashboard-lists">
        <ActivityList activity={selectedTrackActivity} />
      </div>
    </section>
  );
}

function SummaryMetric({ label, value }) {
  return (
    <div className="summary-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ActivityList({ activity }) {
  return (
    <div className="mini-list">
      <h3>Selected track activity</h3>
      {activity.length === 0 ? (
        <p>No activity yet.</p>
      ) : (
        activity.slice(0, 8).map((item) => (
          <article key={item.id}>
            <strong>{item.label}</strong>
            <span>{item.detail} · {formatDate(item.createdAt)}</span>
          </article>
        ))
      )}
    </div>
  );
}

function buildSelectedTrackActivity({ activeVersion, activeTrack, sessionCreatedAt }) {
  const events = [];

  if (sessionCreatedAt) {
    events.push({
      id: "session-created",
      label: "Session created",
      detail: "Review session opened",
      createdAt: sessionCreatedAt
    });
  }

  if (activeTrack?.createdAt) {
    events.push({
      id: `track-created-${activeTrack.id}`,
      label: "Project/stem created",
      detail: activeTrack.title || "Selected track",
      createdAt: activeTrack.createdAt
    });
  }

  for (const comment of activeVersion.comments || []) {
    const author = comment.author || "Reviewer";
    const timeLabel = formatTime(comment.time || 0);
    events.push({
      id: `comment-created-${comment.id}`,
      label: comment.submitted === false ? "Comment drafted" : "Review made",
      detail: `${author} at ${timeLabel}`,
      createdAt: comment.createdAt || comment.updatedAt || ""
    });

    if (comment.updatedAt && comment.updatedAt !== comment.createdAt) {
      events.push({
        id: `comment-edited-${comment.id}`,
        label: "Comment edited",
        detail: `${author} at ${timeLabel}`,
        createdAt: comment.updatedAt
      });
    }
  }

  const allowedActivityLabels = new Set([
    "Comment added",
    "Comment edited",
    "Comment deleted"
  ]);

  for (const item of activeVersion.activity || []) {
    if (!allowedActivityLabels.has(item.label)) continue;
    const label =
      item.label === "Comment added"
        ? "Review made"
        : item.label;
    events.push({
      id: item.id,
      label,
      detail: item.detail,
      createdAt: item.createdAt
    });
  }

  const uniqueEvents = new Map();
  for (const event of events) {
    if (!uniqueEvents.has(event.id)) {
      uniqueEvents.set(event.id, event);
    }
  }

  return [...uniqueEvents.values()].sort((a, b) => {
    const aTime = new Date(a.createdAt || 0).getTime();
    const bTime = new Date(b.createdAt || 0).getTime();
    return bTime - aTime;
  });
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function formatDate(value) {
  if (!value) {
    return "just now";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric"
  }).format(new Date(value));
}
