import { useState, useRef, useCallback } from 'react';
import { digitizeImage, exportStitches, downloadBlob } from '../api/client.js';
import StitchCanvas from '../components/StitchCanvas.jsx';

const FORMATS = [
  { id: 'dst', name: 'DST', desc: 'Tajima' },
  { id: 'pes', name: 'PES', desc: 'Brother' },
  { id: 'jef', name: 'JEF', desc: 'Janome' },
  { id: 'exp', name: 'EXP', desc: 'Melco' },
  { id: 'svg', name: 'SVG', desc: 'Vector' },
  { id: 'png', name: 'PNG', desc: 'Raster' },
];

function Field({ label, children }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

function NumInput({ value, onChange, min, max, step }) {
  return (
    <input type="number" value={value} min={min} max={max} step={step}
      onChange={e => onChange(Number(e.target.value))} />
  );
}

function RangeRow({ label, value, onChange, min, max, step, unit }) {
  return (
    <div className="field">
      <label style={{ display: 'flex', justifyContent: 'space-between' }}>
        {label}
        <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>{value}{unit}</span>
      </label>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))} />
    </div>
  );
}

export default function DigitizerPage() {
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [exporting, setExporting] = useState(null);
  const inputRef = useRef();

  const [opts, setOpts] = useState({ widthMm: 100, heightMm: 100, stitchesPerMm: 4, fillSpacingMm: 0.5, stitchLengthMm: 3, threshold: 230 });
  const set = (k) => (v) => setOpts(o => ({ ...o, [k]: v }));

  const handleFile = useCallback((f) => {
    if (!f) return;
    setFile(f); setResult(null); setError(null);
    setPreview(URL.createObjectURL(f));
  }, []);

  const onDrop = (e) => { e.preventDefault(); setDragging(false); handleFile(e.dataTransfer.files[0]); };

  const onDigitize = async () => {
    if (!file) return;
    setLoading(true); setError(null); setResult(null);
    try { setResult(await digitizeImage(file, opts)); }
    catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const onExport = async (fmt) => {
    if (!result) return;
    setExporting(fmt);
    try {
      const { blob, filename } = await exportStitches(fmt, result.stitches, {
        name: file.name.replace(/\.[^.]+$/, ''),
        colors: result.colors, widthMm: opts.widthMm, heightMm: opts.heightMm,
      });
      downloadBlob(blob, filename);
    } catch (e) { setError(e.message); }
    finally { setExporting(null); }
  };

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Left panel */}
      <div style={{ width: 284, minWidth: 284, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--surface)' }}>
        <div style={{ padding: '20px 18px 16px', borderBottom: '1px solid var(--border)' }}>
          <h1 style={{ marginBottom: 3 }}>Logo Digitizer</h1>
          <p style={{ fontSize: 12 }}>Upload a logo image to generate embroidery stitch data</p>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Upload */}
          <div
            className={`dropzone ${dragging ? 'dropzone--active' : ''} ${file ? 'dropzone--loaded' : ''}`}
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current.click()}
          >
            <input ref={inputRef} type="file" hidden
              accept="image/png,image/jpeg,image/gif,image/bmp,image/webp,image/tiff,image/svg+xml,application/pdf"
              onChange={e => handleFile(e.target.files[0])} />
            {preview ? (
              <>
                <img src={preview} alt="" style={{ maxHeight: 100, maxWidth: '100%', borderRadius: 7, objectFit: 'contain' }} />
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>{file.name} · click to change</span>
              </>
            ) : (
              <>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--dim)" strokeWidth="1.5">
                  <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
                  <polyline points="21 15 16 10 5 21"/>
                </svg>
                <div>
                  <div style={{ fontSize: 13, color: 'var(--muted)' }}>Drop logo or click to browse</div>
                  <div style={{ fontSize: 11, color: 'var(--dim)', marginTop: 3 }}>PNG · JPG · SVG · GIF · BMP · WEBP · TIFF · PDF</div>
                </div>
              </>
            )}
          </div>

          {/* Options */}
          <div className="card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="section-header" style={{ marginBottom: 2 }}>Design Options</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Field label="Width (mm)"><NumInput value={opts.widthMm} onChange={set('widthMm')} min={5} max={500} step={5} /></Field>
              <Field label="Height (mm)"><NumInput value={opts.heightMm} onChange={set('heightMm')} min={5} max={500} step={5} /></Field>
              <Field label="Density (st/mm)"><NumInput value={opts.stitchesPerMm} onChange={set('stitchesPerMm')} min={1} max={10} step={0.5} /></Field>
              <Field label="Stitch len (mm)"><NumInput value={opts.stitchLengthMm} onChange={set('stitchLengthMm')} min={1} max={12} step={0.5} /></Field>
            </div>
            <RangeRow label="Fill spacing" value={opts.fillSpacingMm} onChange={set('fillSpacingMm')} min={0.2} max={3} step={0.1} unit="mm" />
            <RangeRow label="Threshold" value={opts.threshold} onChange={set('threshold')} min={50} max={254} step={1} unit="" />
            <div style={{ fontSize: 11, color: 'var(--dim)', marginTop: -4 }}>Pixels with luminance ≥ threshold are treated as background (default 230)</div>
          </div>

          {/* Action */}
          <button
            className="btn btn--primary"
            onClick={onDigitize}
            disabled={!file || loading}
            style={{ width: '100%', fontSize: 14, height: 40, borderRadius: 9 }}
          >
            {loading ? (
              <><span className="spin">◌</span> Digitizing…</>
            ) : (
              <>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
                Generate Stitches
              </>
            )}
          </button>

          {error && <div className="error-box">{error}</div>}

          {/* Results */}
          {result && (
            <div className="fade-up" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <div className="section-header">Result</div>
                <div className="stat-grid">
                  {[
                    ['Stitches', result.stitchCount?.toLocaleString()],
                    ['Jumps', result.jumpCount?.toLocaleString()],
                    ['Width', `${result.dimensions?.widthMm?.toFixed(1)}mm`],
                    ['Height', `${result.dimensions?.heightMm?.toFixed(1)}mm`],
                  ].map(([k, v]) => (
                    <div key={k} className="stat-cell">
                      <div className="stat-cell__label">{k}</div>
                      <div className="stat-cell__value" style={{ fontSize: 15 }}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div className="section-header">Export</div>
                <div className="export-grid">
                  {FORMATS.map(f => (
                    <button
                      key={f.id}
                      className={`export-btn ${exporting === f.id ? 'export-btn--loading' : ''}`}
                      onClick={() => onExport(f.id)}
                      disabled={!!exporting}
                    >
                      <span className="export-btn__name">{f.name}</span>
                      <span className="export-btn__desc">{f.desc}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Canvas */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 20, minWidth: 0, overflow: 'hidden' }}>
        {!result && !loading && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: 'var(--muted)', pointerEvents: 'none' }}>
            <svg width="68" height="68" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="0.7" style={{ opacity: 0.15 }}>
              <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
            </svg>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', marginBottom: 5 }}>Stitch Preview</div>
              <div style={{ fontSize: 13 }}>Upload a logo and click Generate Stitches</div>
            </div>
          </div>
        )}
        {(result || loading) && (
          <StitchCanvas stitches={result?.stitches || []} autoPlay={!!result} />
        )}
      </div>
    </div>
  );
}
