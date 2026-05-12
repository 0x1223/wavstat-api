import { useState, useRef, useCallback } from 'react';
import { parseDST, parseSVGStitches } from '../utils/parseDST.js';
import StitchCanvas from '../components/StitchCanvas.jsx';

export default function ViewerPage() {
  const [dragging, setDragging] = useState(false);
  const [stitches, setStitches] = useState([]);
  const [filename, setFilename] = useState(null);
  const [error, setError] = useState(null);
  const [stats, setStats] = useState(null);
  const inputRef = useRef();

  const loadFile = useCallback(async (file) => {
    setError(null);
    setFilename(file.name);
    const ext = file.name.split('.').pop().toLowerCase();

    try {
      const buf = await file.arrayBuffer();

      let parsed = [];
      if (ext === 'dst') {
        parsed = parseDST(buf);
      } else if (ext === 'svg') {
        const text = new TextDecoder().decode(buf);
        parsed = parseSVGStitches(text);
      } else if (ext === 'json') {
        const data = JSON.parse(new TextDecoder().decode(buf));
        parsed = Array.isArray(data) ? data : data.stitches || [];
      } else {
        setError(`Format .${ext} preview is not yet supported. Try DST, SVG, or JSON.`);
        return;
      }

      if (!parsed.length) { setError('No stitch data found in file.'); return; }

      const stitchCount = parsed.filter(s => s.type === 'stitch').length;
      const jumpCount = parsed.filter(s => s.type === 'jump').length;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const s of parsed) {
        if (s.type === 'end') continue;
        minX = Math.min(minX, s.x); minY = Math.min(minY, s.y);
        maxX = Math.max(maxX, s.x); maxY = Math.max(maxY, s.y);
      }
      setStats({
        stitchCount, jumpCount,
        widthMm: ((maxX - minX) / 10).toFixed(1),
        heightMm: ((maxY - minY) / 10).toFixed(1),
      });
      setStitches(parsed);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  const onDrop = e => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) loadFile(f);
  };

  const panelStyle = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 20 };

  return (
    <div style={{ display: 'flex', gap: 20, padding: 24, height: '100%', boxSizing: 'border-box' }}>
      {/* Left panel */}
      <div style={{ width: 280, minWidth: 280, display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.3px' }}>Stitch Viewer</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>Animated playback of DST, SVG, or JSON stitch files</p>
        </div>

        {/* Drop zone */}
        <div
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current.click()}
          style={{
            border: `2px dashed ${dragging ? 'var(--accent)' : stitches.length ? 'var(--primary)' : 'var(--border)'}`,
            borderRadius: 12, padding: 32, textAlign: 'center', cursor: 'pointer',
            background: dragging ? 'rgba(6,182,212,0.06)' : 'var(--surface-2)',
            transition: 'all 0.2s ease',
          }}
        >
          <input ref={inputRef} type="file" hidden accept=".dst,.pes,.jef,.exp,.svg,.json" onChange={e => { if (e.target.files[0]) loadFile(e.target.files[0]); }} />
          <div style={{ fontSize: 32, marginBottom: 8 }}>▶️</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Drop embroidery file here</div>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>DST · SVG · JSON</div>
        </div>
        {filename && <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>{filename}</div>}

        {error && (
          <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', fontSize: 13, color: '#fca5a5' }}>
            {error}
          </div>
        )}

        {/* Stats */}
        {stats && (
          <div style={panelStyle}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>File Stats</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                ['Stitches', stats.stitchCount.toLocaleString(), 'var(--accent)'],
                ['Jumps', stats.jumpCount.toLocaleString(), 'var(--text-muted)'],
                ['Width', `${stats.widthMm} mm`, 'var(--primary-light)'],
                ['Height', `${stats.heightMm} mm`, 'var(--primary-light)'],
              ].map(([k, v, c]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'var(--surface-2)', borderRadius: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{k}</span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: c }}>{v}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Supported formats info */}
        <div style={{ ...panelStyle, background: 'var(--surface-2)' }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10, color: 'var(--text-muted)' }}>Supported Formats</div>
          {[
            ['DST', 'Tajima — full decode'],
            ['SVG', 'Vector paths → stitches'],
            ['JSON', 'Raw stitch array from /digitize'],
          ].map(([f, d]) => (
            <div key={f} style={{ display: 'flex', gap: 10, marginBottom: 8, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', background: 'rgba(6,182,212,0.1)', padding: '2px 7px', borderRadius: 4, whiteSpace: 'nowrap' }}>{f}</span>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{d}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Canvas */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 12 }}>
          {stitches.length ? `${filename} — Press Play to animate` : 'Load a file to begin playback'}
        </div>
        <div style={{ flex: 1 }}>
          <StitchCanvas stitches={stitches} autoPlay={false} />
        </div>
      </div>
    </div>
  );
}
