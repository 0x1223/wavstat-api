import { useState, useRef, useCallback } from 'react';
import { parseDST, parseDSTHeader, parsePES, parseJEF, parseEXP, parseSVGStitches, THREAD_PALETTE } from '../utils/parseDST.js';
import StitchCanvas from '../components/StitchCanvas.jsx';

function formatMm(units) { return (units / 10).toFixed(1) + ' mm'; }

export default function ViewerPage() {
  const [dragging, setDragging] = useState(false);
  const [stitches, setStitches] = useState([]);
  const [meta, setMeta] = useState(null);
  const [threads, setThreads] = useState([]);
  const [error, setError] = useState(null);
  const inputRef = useRef();

  const loadFile = useCallback(async (file) => {
    setError(null);
    const ext = file.name.split('.').pop().toLowerCase();

    try {
      const buf = await file.arrayBuffer();
      let parsed = [];
      let header = null;

      if (ext === 'dst') {
        header = parseDSTHeader(buf);
        parsed = parseDST(buf);
      } else if (ext === 'pes') {
        parsed = parsePES(buf);
      } else if (ext === 'jef') {
        parsed = parseJEF(buf);
      } else if (ext === 'exp') {
        parsed = parseEXP(buf);
      } else if (ext === 'svg') {
        parsed = parseSVGStitches(new TextDecoder().decode(buf));
      } else if (ext === 'json') {
        const d = JSON.parse(new TextDecoder().decode(buf));
        parsed = Array.isArray(d) ? d : (d.stitches || []);
      } else {
        throw new Error(`.${ext} is not supported. Use DST, PES, JEF, EXP, SVG, or JSON.`);
      }

      if (!parsed.length) throw new Error('No stitch data found in file.');

      // Compute stats
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const s of parsed) {
        if (s.type === 'end') continue;
        minX = Math.min(minX, s.x); minY = Math.min(minY, s.y);
        maxX = Math.max(maxX, s.x); maxY = Math.max(maxY, s.y);
      }

      // Build thread list from color changes
      const threadList = [];
      let tIdx = 0;
      threadList.push({ idx: 0, color: THREAD_PALETTE[0], count: 0 });
      for (const s of parsed) {
        if (s.type === 'color_change') {
          tIdx++;
          threadList.push({ idx: tIdx, color: THREAD_PALETTE[tIdx % THREAD_PALETTE.length], count: 0 });
        } else if (s.type === 'stitch') {
          if (threadList.length) threadList[threadList.length - 1].count++;
        }
      }

      setMeta({
        name: header?.name || file.name.replace(/\.[^.]+$/, ''),
        filename: file.name,
        ext: ext.toUpperCase(),
        stitchCount: parsed.filter(s => s.type === 'stitch').length,
        jumpCount: parsed.filter(s => s.type === 'jump').length,
        colorChanges: parsed.filter(s => s.type === 'color_change').length,
        widthUnits: maxX - minX,
        heightUnits: maxY - minY,
        totalPoints: parsed.length,
      });
      setThreads(threadList);
      setStitches(parsed);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) loadFile(f);
  }, [loadFile]);

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      {/* Left panel */}
      <div style={{ width: 260, minWidth: 260, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--surface)' }}>
        <div style={{ padding: '20px 18px 16px', borderBottom: '1px solid var(--border)' }}>
          <h1 style={{ marginBottom: 3 }}>Stitch Viewer</h1>
          <p style={{ fontSize: 12 }}>Load an embroidery file to animate playback</p>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Drop zone */}
          <div
            className={`dropzone ${dragging ? 'dropzone--active' : ''} ${stitches.length ? 'dropzone--loaded' : ''}`}
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current.click()}
            style={{ padding: '22px 14px' }}
          >
            <input ref={inputRef} type="file" hidden accept=".dst,.pes,.jef,.exp,.svg,.json" onChange={e => { if (e.target.files[0]) loadFile(e.target.files[0]); }} />
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: stitches.length ? 'var(--accent)' : 'var(--dim)' }}>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            {stitches.length ? (
              <div style={{ fontSize: 12, color: 'var(--accent-light)', textAlign: 'center' }}>
                <div style={{ fontWeight: 600 }}>{meta?.filename}</div>
                <div style={{ color: 'var(--muted)', marginTop: 2 }}>Click to load another</div>
              </div>
            ) : (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 13, color: 'var(--muted)' }}>Drop file or click to browse</div>
                <div style={{ fontSize: 11, color: 'var(--dim)', marginTop: 4 }}>DST · PES · JEF · EXP · SVG · JSON</div>
              </div>
            )}
          </div>

          {error && <div className="error-box">{error}</div>}

          {/* File metadata */}
          {meta && (
            <div className="fade-up">
              <div className="section-header">File Info</div>
              <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '12px 13px', marginBottom: 12 }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4, color: 'var(--text)' }}>{meta.name}</div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 10, fontWeight: 700, background: 'rgba(6,182,212,0.15)', color: 'var(--accent)', padding: '2px 7px', borderRadius: 4, fontFamily: 'var(--mono)' }}>{meta.ext}</span>
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>{meta.filename}</span>
                </div>
              </div>

              <div className="stat-grid">
                {[
                  ['Stitches', meta.stitchCount.toLocaleString()],
                  ['Jumps', meta.jumpCount.toLocaleString()],
                  ['Width', formatMm(meta.widthUnits)],
                  ['Height', formatMm(meta.heightUnits)],
                ].map(([k, v]) => (
                  <div key={k} className="stat-cell">
                    <div className="stat-cell__label">{k}</div>
                    <div className="stat-cell__value" style={{ fontSize: 16 }}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Thread colors */}
          {threads.length > 0 && (
            <div className="fade-up">
              <div className="section-header">Threads — {threads.length}</div>
              <div className="thread-list">
                {threads.slice(0, 12).map((t) => (
                  <div key={t.idx} className="thread-item">
                    <div className="thread-swatch" style={{ background: t.color, boxShadow: `0 0 6px ${t.color}60` }} />
                    <span style={{ flex: 1 }}>Thread {t.idx + 1}</span>
                    <span style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--dim)' }}>{t.count.toLocaleString()} st</span>
                  </div>
                ))}
                {threads.length > 12 && (
                  <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--dim)', padding: '4px 0' }}>
                    +{threads.length - 12} more threads
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Canvas area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 20, gap: 0, minWidth: 0, overflow: 'hidden' }}>
        {!stitches.length ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, color: 'var(--muted)' }}>
            <svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="0.8" style={{ opacity: 0.2 }}>
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>No file loaded</div>
              <div style={{ fontSize: 13 }}>Drop a DST, PES, JEF, EXP, SVG, or JSON file in the left panel</div>
            </div>
          </div>
        ) : (
          <StitchCanvas stitches={stitches} autoPlay={false} />
        )}
      </div>
    </div>
  );
}
