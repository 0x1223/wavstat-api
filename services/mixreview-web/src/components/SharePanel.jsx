export function SharePanel({ links, onClose }) {
  return (
    <section className="share-panel" aria-label="Share session links">
      <div>
        <p className="eyebrow">Share Session</p>
        <h2>Local review links</h2>
        <p>Links use this browser's local share registry until backend sync is added.</p>
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
