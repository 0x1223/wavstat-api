import { useState, useRef, useCallback, useEffect } from 'react';
import { digitizeImage, exportStitches, downloadBlob, previewArtworkMask } from '../api/client.js';

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
  const [mask, setMask] = useState(null);
  const [maskLoading, setMaskLoading] = useState(false);
  const inputRef = useRef();

  const [opts, setOpts] = useState({
    widthMm: 100,
    heightMm: 100,
    stitchesPerMm: 4,
    fillSpacingMm: 1.2,
    stitchLengthMm: 3,
    satinWidthMm: 1.8,
    stitchAngleDeg: 35,
    threshold: 230,
    blackThreshold: 18,
    backgroundDistance: 42,
  });
  const set = (k) => (v) => setOpts(o => ({ ...o, [k]: v }));

  const handleFile = useCallback((f) => {
    if (!f) return;
    setFile(f); setResult(null); setError(null); setMask(null);
    setPreview(URL.createObjectURL(f));
  }, []);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    setMaskLoading(true);
    previewArtworkMask(file, opts)
      .then(data => { if (!cancelled) setMask(data); })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setMaskLoading(false); });
    return () => { cancelled = true; };
  }, [file, opts.widthMm, opts.heightMm, opts.stitchesPerMm, opts.threshold, opts.blackThreshold, opts.backgroundDistance]);

  const onDrop = (e) => { e.preventDefault(); setDragging(false); handleFile(e.dataTransfer.files[0]); };

  const onDigitize = async () => {
    if (!file) return;
    if (mask?.stats?.likelyRectangle) {
      setError(mask.warning || 'Detected artwork mask still looks rectangular. Fix the image background before generating stitches.');
      return;
    }
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
            <RangeRow label="Stitch angle" value={opts.stitchAngleDeg} onChange={set('stitchAngleDeg')} min={-75} max={75} step={5} unit="°" />
            <RangeRow label="Satin border" value={opts.satinWidthMm} onChange={set('satinWidthMm')} min={0.6} max={4} step={0.1} unit="mm" />
            <RangeRow label="Threshold" value={opts.threshold} onChange={set('threshold')} min={50} max={254} step={1} unit="" />
            <RangeRow label="Black removal" value={opts.blackThreshold} onChange={set('blackThreshold')} min={0} max={80} step={1} unit="" />
            <RangeRow label="BG tolerance" value={opts.backgroundDistance} onChange={set('backgroundDistance')} min={12} max={120} step={2} unit="" />
            <div style={{ fontSize: 11, color: 'var(--dim)', marginTop: -4 }}>Transparent, black, white, and sampled border-background pixels are removed before stitching.</div>
          </div>

          {file && (
            <div className="card" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="section-header" style={{ marginBottom: 0 }}>Detected Artwork Mask</div>
              <div style={{
                minHeight: 132,
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--surface-2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                position: 'relative',
              }}>
                {maskLoading && <span style={{ fontSize: 12, color: 'var(--muted)' }}>Detecting mask…</span>}
                {!maskLoading && mask?.maskPng && (
                  <img src={mask.maskPng} alt="Detected artwork mask" style={{ maxWidth: '100%', maxHeight: 168, objectFit: 'contain' }} />
                )}
              </div>
              {mask?.stats && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 11 }}>
                  <div style={{ color: 'var(--muted)' }}>Coverage <span style={{ color: 'var(--text)', fontFamily: 'var(--mono)' }}>{(mask.stats.coverage * 100).toFixed(1)}%</span></div>
                  <div style={{ color: 'var(--muted)' }}>Foreground <span style={{ color: 'var(--text)', fontFamily: 'var(--mono)' }}>{mask.stats.filledPixels?.toLocaleString()}</span></div>
                  <div style={{ color: 'var(--muted)' }}>Contours <span style={{ color: 'var(--text)', fontFamily: 'var(--mono)' }}>{mask.stats.contourCount ?? mask.stats.componentCount}</span></div>
                  <div style={{ color: 'var(--muted)' }}>Fallback <span style={{ color: 'var(--text)', fontFamily: 'var(--mono)' }}>{mask.stats.fallbackUsed ? 'gold' : 'none'}</span></div>
                </div>
              )}
              {mask?.warning && <div className="error-box">{mask.warning}</div>}
              {mask?.stats?.contourCount === 0 && (
                <div className="error-box">{mask.stats.rejectionReason || 'No contours were detected from the foreground mask.'}</div>
              )}
            </div>
          )}

          {/* Action */}
          <button
            className="btn btn--primary"
            onClick={onDigitize}
            disabled={!file || loading || maskLoading || mask?.stats?.likelyRectangle || !mask?.stats?.filledPixels}
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
        {!file && !result && !loading && (
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
        {file && !result && !loading && (
          <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateRows: 'auto 1fr', gap: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h1 style={{ marginBottom: 3 }}>Preview Layer</h1>
                <p style={{ fontSize: 12 }}>Inspect the uploaded image and detected artwork mask before stitch generation.</p>
              </div>
              <div className={`hud-chip ${maskConfirmed ? '' : ''}`} style={{ color: maskConfirmed ? 'var(--accent-light)' : 'var(--muted)' }}>
                {maskConfirmed ? 'mask confirmed' : 'waiting for mask confirmation'}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, minHeight: 0 }}>
              <div className="card" style={{ minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className="section-header" style={{ marginBottom: 0 }}>Uploaded Logo/Image</div>
                <div style={{ flex: 1, minHeight: 0, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', padding: 18 }}>
                  {preview && <img src={preview} alt="Uploaded logo preview" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />}
                </div>
              </div>
              <div className="card" style={{ minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className="section-header" style={{ marginBottom: 0 }}>Detected Artwork Mask</div>
                <div style={{ flex: 1, minHeight: 0, borderRadius: 10, background: 'var(--surface-2)', border: `1px solid ${mask?.stats?.likelyRectangle ? 'rgba(239,68,68,0.45)' : 'var(--border)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', padding: 18 }}>
                  {maskLoading && <span style={{ color: 'var(--muted)' }}>Detecting foreground artwork…</span>}
                  {!maskLoading && mask?.maskPng && <img src={mask.maskPng} alt="Detected artwork mask preview" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />}
                  {!maskLoading && !mask?.maskPng && <span style={{ color: 'var(--muted)' }}>No mask preview available</span>}
                </div>
                {mask?.stats && (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <span className="hud-chip">coverage {(mask.stats.coverage * 100).toFixed(1)}%</span>
                    <span className="hud-chip">pixels {mask.stats.filledPixels?.toLocaleString()}</span>
                    <span className="hud-chip">contours {mask.stats.contourCount ?? mask.stats.componentCount}</span>
                    <span className="hud-chip">fallback {mask.stats.fallbackUsed ? 'gold' : 'none'}</span>
                  </div>
                )}
                {mask?.stats?.likelyRectangle && (
                  <div className="error-box">
                    Mask is still rectangular, so stitch generation is blocked. The background/canvas is being detected as foreground.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        {(result || loading) && (
          <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', gap: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h1 style={{ marginBottom: 3 }}>Clean Preview</h1>
                <p style={{ fontSize: 12 }}>Generated stitch files are ready for export. Visual preview stays on the original artwork.</p>
              </div>
              {result && (
                <div className="hud-chip">
                  <span style={{ color: 'var(--accent-light)' }}>{result.stitchCount?.toLocaleString()}</span>
                  <span style={{ color: 'var(--muted)' }}> stitches</span>
                </div>
              )}
            </div>
            <div className="card" style={{ minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
              {loading && <span style={{ color: 'var(--muted)' }}>Preparing export stitch data…</span>}
              {!loading && preview && (
                <img src={preview} alt="Uploaded logo preview" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
