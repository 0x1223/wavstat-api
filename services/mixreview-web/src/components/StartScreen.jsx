export function StartScreen({
  loginName,
  loginPassword,
  loginError,
  onLoginNameChange,
  onLoginPasswordChange,
  onLoginSubmit,
  message
}) {
  return (
    <main className="start-screen">
      <section className="start-hero">
        <div className="start-copy">
          <p className="eyebrow">MixReview</p>
          <h1>MixReview Access</h1>
          <p className="start-role">Engineer admin or client reviewer</p>
          <p className="start-purpose">
            Sign in with your engineer credentials, client ID, or review link token
            to open the right workspace.
          </p>

          <form className="access-form" onSubmit={onLoginSubmit}>
            <label>
              <span>Name / Client ID</span>
              <input
                autoComplete="username"
                value={loginName}
                onChange={(event) => onLoginNameChange(event.target.value)}
                placeholder="Engineer, Admin, or client session ID"
              />
            </label>
            <label>
              <span>Password</span>
              <input
                autoComplete="current-password"
                type="password"
                value={loginPassword}
                onChange={(event) => onLoginPasswordChange(event.target.value)}
                placeholder="Password or review token"
              />
            </label>
            {loginError && <p className="upload-error">{loginError}</p>}
            <button type="submit" className="primary-action">
              Enter MixReview
            </button>
          </form>
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
