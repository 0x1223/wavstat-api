import { formatTimecode } from "../lib/time.js";

export function AudioUpload({ audioSource, duration, error, onFileSelect, disabled }) {
  return (
    <section className="upload-panel" aria-label="Audio upload">
      <div>
        <p className="eyebrow">Audio Source</p>
        <h2>{audioSource ? audioSource.fileName : "Upload a local mix"}</h2>
        <p>
          {audioSource?.needsRelink
            ? "Session restored. Choose the local audio file again to reload the waveform."
            : audioSource
              ? `${audioSource.type} · ${formatFileSize(audioSource.size)}`
              : "Choose an audio file to load the waveform."}
        </p>
        {error && <p className="upload-error">{error}</p>}
      </div>

      <label className="upload-button">
        <input
          type="file"
          accept="audio/*"
          disabled={disabled}
          onChange={(event) => {
            onFileSelect(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <span>{disabled ? "Audio Locked" : audioSource ? "Replace Audio" : "Choose Audio"}</span>
      </label>

      <div className="upload-duration">
        <span>Duration</span>
        <strong>{formatTimecode(duration)}</strong>
      </div>
    </section>
  );
}

function formatFileSize(size = 0) {
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }

  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
