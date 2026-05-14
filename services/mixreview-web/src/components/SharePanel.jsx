export function SharePanel({ links, onClose }) {
  return (
    <section className="share-panel" aria-label="Share session links">
      <div>
        <p className="eyebrow">Share Session</p>
        <h2>Client review links</h2>
        <p>Links open the matching persistent review session.</p>
      </div>

      <ShareLink label="Reviewer link" value={links.reviewer} />
      <ShareLink label="Read-only link" value={links.readOnly} />

      <button type="button" onClick={onClose}>
        Close
      </button>
    </section>
  );
}

function ShareLink({ label, value }) {
  return (
    <label className="share-link">
      <span>{label}</span>
      <input readOnly value={value} onFocus={(event) => event.target.select()} />
    </label>
  );
}
