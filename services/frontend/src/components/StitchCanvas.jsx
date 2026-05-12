import { useRef, useEffect, useCallback, useState } from 'react';

const CANVAS_W = 1800;
const CANVAS_H = 1100;

function getBounds(stitches) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of stitches) {
    if (s.type === 'end') continue;
    if (s.x < minX) minX = s.x; if (s.y < minY) minY = s.y;
    if (s.x > maxX) maxX = s.x; if (s.y > maxY) maxY = s.y;
  }
  return isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
}

function calcTransform(b, zoom, panX, panY) {
  const dw = b.maxX - b.minX || 1, dh = b.maxY - b.minY || 1;
  const pad = 48;
  const baseScale = Math.min((CANVAS_W - pad * 2) / dw, (CANVAS_H - pad * 2) / dh);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const s = baseScale * zoom;
  const tx = CANVAS_W / 2 - cx * s + panX;
  const ty = CANVAS_H / 2 - cy * s + panY;
  return { s, tx, ty };
}

function drawBackground(ctx) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#060610';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.strokeStyle = 'rgba(255,255,255,0.022)';
  ctx.lineWidth = 1;
  for (let x = 0; x < CANVAS_W; x += 80) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CANVAS_H); ctx.stroke();
  }
  for (let y = 0; y < CANVAS_H; y += 80) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CANVAS_W, y); ctx.stroke();
  }
}

function renderSeg(ctx, seg) {
  if (seg.jump) {
    ctx.beginPath();
    ctx.moveTo(seg.x1, seg.y1);
    ctx.lineTo(seg.x2, seg.y2);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 0.6;
    ctx.setLineDash([5, 8]);
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    ctx.beginPath();
    ctx.moveTo(seg.x1, seg.y1);
    ctx.lineTo(seg.x2, seg.y2);
    ctx.strokeStyle = seg.color;
    ctx.lineWidth = 1.1;
    ctx.globalAlpha = 0.88;
    ctx.stroke();
    ctx.globalAlpha = 1;
    // Needle head
    ctx.beginPath();
    ctx.arc(seg.x2, seg.y2, 1.4, 0, Math.PI * 2);
    ctx.fillStyle = seg.color;
    ctx.globalAlpha = 0.4;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

export default function StitchCanvas({ stitches = [], autoPlay = false, defaultColor = '#7c3aed' }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const animRef = useRef({ idx: 0, playing: false, speed: 40, prevX: null, prevY: null, drawn: [] });
  const viewRef = useRef({ zoom: 1, panX: 0, panY: 0 });
  const dragRef = useRef(null);

  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState(40);
  const [zoomPct, setZoomPct] = useState(100);
  const [stitchCount, setStitchCount] = useState(0);

  const boundsRef = useRef({ minX: 0, minY: 0, maxX: 1000, maxY: 1000 });

  useEffect(() => {
    if (stitches.length > 0) boundsRef.current = getBounds(stitches);
  }, [stitches]);

  const getCtxTransform = useCallback(() => {
    const { zoom, panX, panY } = viewRef.current;
    return calcTransform(boundsRef.current, zoom, panX, panY);
  }, []);

  const redrawAll = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    drawBackground(ctx);
    const { s, tx, ty } = getCtxTransform();
    ctx.setTransform(s, 0, 0, s, tx, ty);
    for (const seg of animRef.current.drawn) renderSeg(ctx, seg);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }, [getCtxTransform]);

  const reset = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    animRef.current = { idx: 0, playing: false, speed, prevX: null, prevY: null, drawn: [] };
    setPlaying(false); setProgress(0); setStitchCount(0);
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawBackground(canvas.getContext('2d'));
  }, [speed]);

  useEffect(() => { reset(); }, [stitches]); // eslint-disable-line

  const animate = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !stitches.length) return;
    const ctx = canvas.getContext('2d');
    const anim = animRef.current;
    if (!anim.playing) return;

    const { s, tx, ty } = getCtxTransform();
    ctx.setTransform(s, 0, 0, s, tx, ty);

    const steps = Math.max(1, Math.round(anim.speed));
    for (let i = 0; i < steps && anim.idx < stitches.length; i++, anim.idx++) {
      const st = stitches[anim.idx];
      if (st.type === 'end') { anim.playing = false; setPlaying(false); break; }
      if (st.type === 'color_change') { anim.prevX = st.x; anim.prevY = st.y; continue; }

      const color = st.color || defaultColor;
      const isJump = st.type === 'jump' || st.type === 'trim';

      if (anim.prevX !== null) {
        const seg = { x1: anim.prevX, y1: anim.prevY, x2: st.x, y2: st.y, color, jump: isJump };
        anim.drawn.push(seg);
        renderSeg(ctx, seg);
      }
      anim.prevX = st.x; anim.prevY = st.y;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const total = stitches.filter(s => s.type === 'stitch').length;
    setStitchCount(anim.drawn.filter(s => !s.jump).length);
    setProgress(anim.idx / (stitches.length || 1));

    if (anim.idx < stitches.length && anim.playing) rafRef.current = requestAnimationFrame(animate);
    else setPlaying(false);
  }, [stitches, getCtxTransform, defaultColor]);

  const play = useCallback(() => {
    if (animRef.current.idx >= stitches.length) reset();
    animRef.current.playing = true;
    animRef.current.speed = speed;
    setPlaying(true);
    rafRef.current = requestAnimationFrame(animate);
  }, [stitches, speed, reset, animate]);

  const pause = useCallback(() => {
    animRef.current.playing = false;
    setPlaying(false);
    cancelAnimationFrame(rafRef.current);
  }, []);

  const skipToEnd = useCallback(() => {
    pause();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    drawBackground(ctx);
    const { s, tx, ty } = getCtxTransform();
    ctx.setTransform(s, 0, 0, s, tx, ty);
    animRef.current.drawn = [];
    animRef.current.idx = 0;
    animRef.current.prevX = null; animRef.current.prevY = null;
    for (const st of stitches) {
      if (st.type === 'end') break;
      if (st.type === 'color_change') { animRef.current.prevX = st.x; animRef.current.prevY = st.y; continue; }
      const color = st.color || defaultColor;
      const isJump = st.type === 'jump' || st.type === 'trim';
      if (animRef.current.prevX !== null) {
        const seg = { x1: animRef.current.prevX, y1: animRef.current.prevY, x2: st.x, y2: st.y, color, jump: isJump };
        animRef.current.drawn.push(seg);
        renderSeg(ctx, seg);
      }
      animRef.current.prevX = st.x; animRef.current.prevY = st.y;
      animRef.current.idx++;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    setStitchCount(animRef.current.drawn.filter(s => !s.jump).length);
    setProgress(1);
  }, [stitches, pause, getCtxTransform, defaultColor]);

  // Zoom helpers
  const applyZoom = useCallback((factor, clientX, clientY) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = (clientX - rect.left) * (CANVAS_W / rect.width);
    const mouseY = (clientY - rect.top) * (CANVAS_H / rect.height);
    const v = viewRef.current;
    const newZoom = Math.max(0.3, Math.min(25, v.zoom * factor));
    // Keep point under cursor fixed
    v.panX = mouseX - (mouseX - v.panX) * (newZoom / v.zoom);
    v.panY = mouseY - (mouseY - v.panY) * (newZoom / v.zoom);
    v.zoom = newZoom;
    setZoomPct(Math.round(newZoom * 100));
    redrawAll();
  }, [redrawAll]);

  const onWheel = useCallback((e) => {
    e.preventDefault();
    applyZoom(e.deltaY < 0 ? 1.13 : 1 / 1.13, e.clientX, e.clientY);
  }, [applyZoom]);

  const onMouseDown = useCallback((e) => {
    dragRef.current = { x: e.clientX, y: e.clientY, px: viewRef.current.panX, py: viewRef.current.panY };
    e.currentTarget.style.cursor = 'grabbing';
  }, []);

  const onMouseMove = useCallback((e) => {
    if (!dragRef.current) return;
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = CANVAS_W / rect.width;
    viewRef.current.panX = dragRef.current.px + (e.clientX - dragRef.current.x) * scaleX;
    viewRef.current.panY = dragRef.current.py + (e.clientY - dragRef.current.y) * scaleX;
    redrawAll();
  }, [redrawAll]);

  const onMouseUp = useCallback((e) => {
    dragRef.current = null;
    if (e.currentTarget) e.currentTarget.style.cursor = 'grab';
  }, []);

  const zoomTo = useCallback((newZoom) => {
    viewRef.current.zoom = newZoom;
    setZoomPct(Math.round(newZoom * 100));
    redrawAll();
  }, [redrawAll]);

  useEffect(() => { animRef.current.speed = speed; }, [speed]);
  useEffect(() => { if (autoPlay && stitches.length > 0) play(); }, [autoPlay, stitches.length]); // eslint-disable-line

  const totalStitches = stitches.filter(s => s.type === 'stitch').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 8 }}>
      {/* Canvas */}
      <div
        style={{ flex: 1, position: 'relative', borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)', cursor: 'grab', minHeight: 0 }}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
      >
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          style={{ width: '100%', height: '100%', display: 'block' }}
        />

        {!stitches.length && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, pointerEvents: 'none' }}>
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="1">
              <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
            </svg>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>Stitch preview</span>
          </div>
        )}

        {/* HUD: stitch counter + zoom */}
        {stitches.length > 0 && (
          <div style={{ position: 'absolute', top: 12, left: 12, right: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', pointerEvents: 'none' }}>
            <div className="hud-chip">
              <span style={{ color: '#22d3ee', fontVariantNumeric: 'tabular-nums' }}>{stitchCount.toLocaleString()}</span>
              <span style={{ color: 'var(--muted)' }}> / {totalStitches.toLocaleString()} st</span>
            </div>
            {/* Zoom controls (pointer-events re-enabled) */}
            <div style={{ display: 'flex', gap: 4, pointerEvents: 'all' }}>
              {[
                { label: '+', fn: () => zoomTo(Math.min(25, viewRef.current.zoom * 1.5)) },
                { label: `${zoomPct}%`, fn: () => { viewRef.current = { zoom: 1, panX: 0, panY: 0 }; setZoomPct(100); redrawAll(); }, title: 'Reset view' },
                { label: '−', fn: () => zoomTo(Math.max(0.3, viewRef.current.zoom / 1.5)) },
              ].map(({ label, fn, title }) => (
                <button key={label} onClick={fn} title={title} className="zoom-btn">{label}</button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Playback bar */}
      {stitches.length > 0 && (
        <div className="playbar">
          <button className={`icon-btn ${playing ? '' : 'icon-btn--primary'}`} onClick={playing ? pause : play} title={playing ? 'Pause' : 'Play'}>
            {playing
              ? <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
              : <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>}
          </button>
          <button className="icon-btn" onClick={reset} title="Reset">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.5"/></svg>
          </button>
          <button className="icon-btn" onClick={skipToEnd} title="Skip to end">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 15,12 5,21"/><line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" strokeWidth="2"/></svg>
          </button>
          <div className="progress-track" title={`${(progress * 100).toFixed(1)}%`}>
            <div className="progress-fill" style={{ width: `${progress * 100}%` }} />
          </div>
          <label className="speed-label">
            Speed
            <input type="range" min="1" max="400" value={speed} onChange={e => setSpeed(Number(e.target.value))} className="speed-slider" />
            <span className="speed-value">{speed}×</span>
          </label>
        </div>
      )}
    </div>
  );
}
