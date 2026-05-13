export function StartScreen({ onCreate, onDemo, message }) {
  return (
    <main className="start-screen">
      <section className="start-hero">
        <div className="start-copy">
          <p className="eyebrow">MixReview</p>
          <h1>Create Review Session</h1>
          <p className="start-role">For engineers and producers</p>
          <p className="start-purpose">
            Upload a mix, create versions, add timestamp notes, and send a review link
            when the pass is ready.
          </p>

          <div className="start-actions">
            <button type="button" className="primary-action" onClick={onCreate}>
              Create Review Session
            </button>
          </div>
          {message && <div className="session-message">{message}</div>}
        </div>

        <div className="start-preview">
          <div className="preview-topline">
            <span>Artist / Client / Label</span>
            <strong>Read + Review</strong>
          </div>
          <div className="review-entry-copy">
            <p className="eyebrow">Review Session</p>
            <h2>Review Session</h2>
            <p className="start-role">For artists, clients, and labels</p>
            <p className="start-purpose">
              Open a review link, listen in context, comment at exact timestamps,
              approve the version, or request changes.
            </p>
            <button type="button" onClick={onDemo}>
              Open Review Session
            </button>
          </div>
          <div className="preview-wave">
            {Array.from({ length: 48 }, (_, index) => (
              <i key={index} style={{ "--bar": `${28 + ((index * 17) % 58)}%` }} />
            ))}
          </div>
          <div className="preview-notes">
            <article>
              <b>00:42</b>
              <span>Vocal delay blooms perfectly after the bridge.</span>
            </article>
            <article>
              <b>01:18</b>
              <span>Low end is cleaner, ready for final print.</span>
            </article>
          </div>
        </div>
      </section>
    </main>
  );
}
