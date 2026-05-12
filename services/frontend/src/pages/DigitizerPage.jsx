import { useState, useRef, useCallback } from 'react';
import { digitizeImage, exportStitches, downloadBlob } from '../api/client.js';
import StitchCanvas from '../components/StitchCanvas.jsx';

const FORMATS = [
  { id: 'dst', label: 'DST', desc: 'Tajima' },
  { id: 'pes', label: 'PES', desc: 'Brother' },
  { id: 'jef', label: 'JEF', desc: 'Janome' },
  { id: 'exp', label: 'EXP', desc: 'Melco' },
  { id: 'svg', label: 'SVG', desc: 'Vector' },
  { id: 'png', label: 'PNG', desc: 'Raster' },
];

function Label({ children }) {
  return <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>{children}</label>;
}

function NumberInput({ label, value, onChange, min, max, step, unit }) {
  return (
    <div>
      <Label>{label}</Label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="number" value={value} min={min} max={max} step={step}
          onChange={e => onChange(Number(e.target.value))}
          style={{
            width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)',
            background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13, outline: 'none',
          }}
        />
        {unit && <span style={{ fontSize: 12, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{unit}</span>}
      </div>
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

  const [opts, setOpts] = useState({
    widthMm: 100, heightMm: 100, stitchesPerMm: 4,
    fillSpacingMm: 0.5, stitchLengthMm: 3, threshold: 128,
  });

  const setOpt = (k, v) => setOpts(o => ({ ...o, [k]: v }));

  const handleFile = useCallback(f => {
    if (!f) return;
    setFile(f);
    setResult(null);
    setError(null);
    const url = URL.createObjectURL(f);
    setPreview(url);
  }, []);

  const onDrop = e => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };

  const onDigitize = async () => {
    if (!file) return;
    setLoading(true); setError(null); setResult(null);
    try {
      const data = await digitizeImage(file, opts);
      setResult(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const onExport = async (format) => {
    if (!result) return;
    setExporting(format);
    try {
      const { blob, filename } = await exportStitches(format, result.stitches, {
        name: file.name.replace(/\.[^.]+$/, ''),
        colors: result.colors,
        widthMm: opts.widthMm,
        heightMm: opts.heightMm,
      });
      downloadBlob(blob, filename);
    } catch (e) {
      setError(e.message);
    } finally {
      setExporting(null);
    }
  };

  const panelStyle = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 };

  return (
    <div style={{ display: 'flex', gap: 20, padding: 24, height: '100%', boxSizing: 'border-box' }}>
      {/* Left panel */}
      <div style={{ width: 280, minWidth: 280, display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}>
        {/* Header */}
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.3px' }}>Logo Digitizer</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>Upload an image to generate embroidery stitch data</p>
        </div>

        {/* Drop zone */}
        <div
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current.click()}
          style={{
            border: `2px dashed ${dragging ? 'var(--primary)' : file ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 12,
            padding: 24,
            textAlign: 'center',
            cursor: 'pointer',
            background: dragging ? 'rgba(124,58,237,0.06)' : 'var(--surface-2)',
            transition: 'all 0.2s ease',
            boxShadow: dragging ? '0 0 20px rgba(124,58,237,0.2)' : 'none',
          }}
        >
          <input ref={inputRef} type="file" hidden accept="image/png,image/jpeg,image/gif,image/bmp,image/webp,image/tiff,image/svg+xml,application/pdf" onChange={e => handleFile(e.target.files[0])} />
          {preview ? (
            <img src={preview} alt="preview" style={{ maxHeight: 120, maxWidth: '100%', borderRadius: 8, objectFit: 'contain' }} />
          ) : (
            <>
              <div style={{ fontSize: 32, marginBottom: 8 }}>🪡</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Drop image here or click to browse</div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>PNG, JPG, SVG, GIF, BMP, WEBP, TIFF, PDF</div>
            </>
          )}
        </div>
        {file && <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>{file.name}</div>}

        {/* Options */}
        <div style={panelStyle}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 16, color: 'var(--text)' }}>Design Options</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <NumberInput label="Width" value={opts.widthMm} onChange={v => setOpt('widthMm', v)} min={5} max={500} step={5} unit="mm" />
            <NumberInput label="Height" value={opts.heightMm} onChange={v => setOpt('heightMm', v)} min={5} max={500} step={5} unit="mm" />
            <NumberInput label="Density" value={opts.stitchesPerMm} onChange={v => setOpt('stitchesPerMm', v)} min={1} max={10} step={0.5} unit="st/mm" />
            <NumberInput label="Fill Spacing" value={opts.fillSpacingMm} onChange={v => setOpt('fillSpacingMm', v)} min={0.3} max={3} step={0.1} unit="mm" />
            <NumberInput label="Stitch Length" value={opts.stitchLengthMm} onChange={v => setOpt('stitchLengthMm', v)} min={1} max={12} step={0.5} unit="mm" />
            <div>
              <Label>Threshold — {opts.threshold}</Label>
              <input type="range" min="1" max="254" value={opts.threshold} onChange={e => setOpt('threshold', Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--primary)' }} />
            </div>
          </div>
        </div>

        {/* Digitize button */}
        <button
          onClick={onDigitize}
          disabled={!file || loading}
          style={{
            padding: '12px 20px', borderRadius: 10, border: 'none', cursor: file && !loading ? 'pointer' : 'not-allowed',
            background: file && !loading ? 'linear-gradient(135deg, var(--primary), var(--accent))' : 'var(--surface-3)',
            color: '#fff', fontWeight: 600, fontSize: 14,
            boxShadow: file && !loading ? '0 0 20px rgba(124,58,237,0.4)' : 'none',
            transition: 'all 0.2s ease',
          }}
        >
          {loading ? (
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="spin-slow"><circle cx="12" cy="12" r="10" strokeOpacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" /></svg>
              Digitizing…
            </span>
          ) : 'Digitize Image'}
        </button>

        {/* Error */}
        {error && (
          <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', fontSize: 13, color: '#fca5a5' }}>
            {error}
          </div>
        )}

        {/* Stats */}
        {result && (
          <div style={panelStyle}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Result</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {[
                ['Stitches', result.stitchCount?.toLocaleString()],
                ['Jumps', result.jumpCount?.toLocaleString()],
                ['Width', `${result.dimensions?.widthMm?.toFixed(1)}mm`],
                ['Height', `${result.dimensions?.heightMm?.toFixed(1)}mm`],
              ].map(([k, v]) => (
                <div key={k} style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '10px 12px' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>{k}</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--accent)' }}>{v}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Export */}
        {result && (
          <div style={panelStyle}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Export Format</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              {FORMATS.map(f => (
                <button
                  key={f.id}
                  onClick={() => onExport(f.id)}
                  disabled={exporting === f.id}
                  style={{
                    padding: '10px 6px', borderRadius: 8, border: '1px solid var(--border)',
                    background: exporting === f.id ? 'var(--primary)' : 'var(--surface-2)',
                    color: 'var(--text)', cursor: 'pointer', transition: 'all 0.15s',
                    textAlign: 'center',
                  }}
                  onMouseEnter={e => { if (exporting !== f.id) e.currentTarget.style.borderColor = 'var(--primary)'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                >
                  <div style={{ fontWeight: 700, fontSize: 13 }}>{f.label}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{f.desc}</div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Canvas */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 0, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 12 }}>
          {result ? 'Stitch Preview — click Play to animate' : 'Stitch preview will appear here after digitizing'}
        </div>
        <div style={{ flex: 1 }}>
          <StitchCanvas stitches={result?.stitches || []} autoPlay={!!result} />
        </div>
      </div>
    </div>
  );
}
