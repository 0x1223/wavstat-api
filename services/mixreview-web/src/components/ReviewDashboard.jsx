const approvalStates = [
  "Pending Review",
  "Needs Changes",
  "Approved"
];

const reviewers = ["Artist", "Engineer", "Manager", "Label"];

export function ReviewDashboard({
  activeVersion,
  versions,
  currentReviewer,
  onReviewerChange,
  onApprovalChange,
  onSubmitFeedback,
  canApprove,
  canSubmit,
  canChooseReviewer
}) {
  const unresolvedCount = activeVersion.comments.filter(
    (comment) => !comment.resolved,
  ).length;
  const approvalCount = versions.filter((version) =>
    version.approvalStatus === "Approved",
  ).length;

  return (
    <section className="review-dashboard" aria-label="Review dashboard">
      <div className="dashboard-header">
        <div>
          <p className="eyebrow">Review Dashboard</p>
          <h2>{activeVersion.label} approval workflow</h2>
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
        <SummaryMetric label="Total Comments" value={activeVersion.comments.length} />
        <SummaryMetric label="Unresolved" value={unresolvedCount} />
        <SummaryMetric label="Approvals" value={`${approvalCount}/${versions.length}`} />
        <SummaryMetric label="Latest Revision" value={activeVersion.label} />
      </div>

      {(canApprove || canSubmit) && (
        <div className="approval-state-grid" aria-label="Approval states">
          {approvalStates.map((state) => (
            <button
              type="button"
              disabled={!canApprove}
              className={state === activeVersion.approvalStatus ? "active" : ""}
              key={state}
              onClick={() => onApprovalChange(state)}
            >
              {state}
            </button>
          ))}
          <button type="button" disabled={!canSubmit} onClick={onSubmitFeedback}>
            Submit Feedback
          </button>
        </div>
      )}

      {activeVersion.comments.length === 0 && activeVersion.activity.length === 0 && (
        <div className="empty-state compact">
          <strong>Fresh version, clean slate.</strong>
          <p>Comments, approvals, and activity will collect here as reviewers listen.</p>
        </div>
      )}

      <div className="dashboard-lists">
        <TimelineList history={activeVersion.approvalHistory} />
        <ActivityList activity={activeVersion.activity} />
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

function TimelineList({ history }) {
  return (
    <div className="mini-list">
      <h3>Approval timeline</h3>
      {history.length === 0 ? (
        <p>No approvals yet.</p>
      ) : (
        history.slice(0, 4).map((item) => (
          <article key={item.id}>
            <strong>{item.status}</strong>
            <span>{item.reviewer} · {formatDate(item.createdAt)}</span>
          </article>
        ))
      )}
    </div>
  );
}

function ActivityList({ activity }) {
  return (
    <div className="mini-list">
      <h3>Activity feed</h3>
      {activity.length === 0 ? (
        <p>No activity yet.</p>
      ) : (
        activity.slice(0, 5).map((item) => (
          <article key={item.id}>
            <strong>{item.label}</strong>
            <span>{item.detail} · {formatDate(item.createdAt)}</span>
          </article>
        ))
      )}
    </div>
  );
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
