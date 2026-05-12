import { useRef, useEffect, useCallback, useState } from 'react';

export default function StitchCanvas({ stitches = [], autoPlay = false }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const stateRef = useRef({ idx: 0, playing: false, speed: 30, prevX: null, prevY: null });
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState(30);
  const [stitchCount, setStitchCount] = useState(0);

  // Compute bounds & transform
  const getTransform = useCallback((canvas) => {
    if (!stitches.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of stitches) {
      if (s.type === 'end') continue;
      minX = Math.min(minX, s.x); minY = Math.min(minY, s.y);
      maxX = Math.max(maxX, s.x); maxY = Math.max(maxY, s.y);
    }
    const pad = 32;
    const dw = maxX - minX || 1, dh = maxY - minY || 1;
    const scale = Math.min((canvas.width - pad * 2) / dw, (canvas.height - pad * 2) / dh);
    const offX = pad + ((canvas.width - pad * 2) - dw * scale) / 2;
    const offY = pad + ((canvas.height - pad * 2) - dh * scale) / 2;
    return { scale, offX, offY, minX, minY };
  }, [stitches]);

  const tx = (s, t) => (s.x - t.minX) * t.scale + t.offX;
  const ty = (s, t) => (s.y - t.minY) * t.scale + t.offY;

  const drawBackground = useCallback((ctx, w, h) => {
    ctx.fillStyle = '#07070f';
    ctx.fillRect(0, 0, w, h);
    // Subtle grid
    ctx.strokeStyle = 'rgba(42,42,69,0.5)';
    ctx.lineWidth = 0.5;
    const grid = 40;
    for (let x = 0; x < w; x += grid) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y < h; y += grid) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  }, []);

  const reset = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    stateRef.current = { idx: 0, playing: false, speed, prevX: null, prevY: null };
    setPlaying(false);
    setProgress(0);
    setStitchCount(0);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    drawBackground(ctx, canvas.width, canvas.height);
  }, [speed, drawBackground]);

  // Reset when stitches change
  useEffect(() => { reset(); }, [stitches]); // eslint-disable-line

  const animate = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !stitches.length) return;
    const ctx = canvas.getContext('2d');
    const t = getTransform(canvas);
    if (!t) return;

    const st = stateRef.current;
    if (!st.playing) return;

    const steps = Math.max(1, Math.round(st.speed));
    for (let i = 0; i < steps && st.idx < stitches.length; i++, st.idx++) {
      const s = stitches[st.idx];
      if (s.type === 'end') { st.playing = false; setPlaying(false); break; }

      const sx = tx(s, t), sy = ty(s, t);

      if (s.type === 'stitch' && st.prevX !== null) {
        const grad = ctx.createLinearGradient(st.prevX, st.prevY, sx, sy);
        grad.addColorStop(0, '#7c3aed');
        grad.addColorStop(1, '#06b6d4');
        ctx.beginPath();
        ctx.moveTo(st.prevX, st.prevY);
        ctx.lineTo(sx, sy);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.2;
        ctx.globalAlpha = 0.95;
        ctx.setLineDash([]);
        ctx.stroke();
        // Needle point glow
        ctx.beginPath();
        ctx.arc(sx, sy, 1.5, 0, Math.PI * 2);
        ctx.fillStyle = '#22d3ee';
        ctx.globalAlpha = 0.7;
        ctx.fill();
        ctx.globalAlpha = 1;
        st.prevX = sx; st.prevY = sy;
      } else if (s.type === 'jump' || s.type === 'trim') {
        if (st.prevX !== null) {
          ctx.beginPath();
          ctx.moveTo(st.prevX, st.prevY);
          ctx.lineTo(sx, sy);
          ctx.strokeStyle = 'rgba(255,255,255,0.07)';
          ctx.lineWidth = 0.8;
          ctx.setLineDash([3, 5]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        st.prevX = sx; st.prevY = sy;
      } else {
        st.prevX = sx; st.prevY = sy;
      }
    }

    const sc = stitches.filter(s => s.type === 'stitch').length;
    const drawn = stitches.slice(0, st.idx).filter(s => s.type === 'stitch').length;
    setStitchCount(drawn);
    setProgress(st.idx / stitches.length);

    if (st.idx < stitches.length && st.playing) {
      rafRef.current = requestAnimationFrame(animate);
    } else {
      setPlaying(false);
    }
  }, [stitches, getTransform]);

  const play = useCallback(() => {
    if (stateRef.current.idx >= stitches.length) reset();
    stateRef.current.playing = true;
    stateRef.current.speed = speed;
    setPlaying(true);
    rafRef.current = requestAnimationFrame(animate);
  }, [stitches, speed, reset, animate]);

  const pause = useCallback(() => {
    stateRef.current.playing = false;
    setPlaying(false);
    cancelAnimationFrame(rafRef.current);
  }, []);

  useEffect(() => { stateRef.current.speed = speed; }, [speed]);
  useEffect(() => { if (autoPlay && stitches.length > 0) play(); }, [autoPlay, stitches.length]); // eslint-disable-line

  const totalStitches = stitches.filter(s => s.type === 'stitch').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12 }}>
      {/* Canvas */}
      <div style={{ flex: 1, position: 'relative', borderRadius: 12, overflow: 'hidden', border: '1px solid var(--border)', background: '#07070f' }}>
        <canvas
          ref={canvasRef}
          width={900}
          height={600}
          style={{ width: '100%', height: '100%', display: 'block' }}
        />
        {!stitches.length && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: 14 }}>
            No stitch data loaded
          </div>
        )}
        {/* Stats overlay */}
        {stitches.length > 0 && (
          <div style={{ position: 'absolute', top: 12, right: 12, background: 'rgba(7,7,15,0.8)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 14px', fontSize: 12, color: 'var(--text-muted)', backdropFilter: 'blur(8px)' }}>
            <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{stitchCount.toLocaleString()}</span>
            <span> / {totalStitches.toLocaleString()} stitches</span>
          </div>
        )}
      </div>

      {/* Controls */}
      {stitches.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10 }}>
          {/* Play/Pause */}
          <button
            onClick={playing ? pause : play}
            style={{
              width: 36, height: 36, borderRadius: 8,
              background: playing ? 'var(--surface-2)' : 'var(--primary)',
              border: '1px solid var(--border)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', flexShrink: 0,
              boxShadow: playing ? 'none' : '0 0 12px rgba(124,58,237,0.4)',
            }}
          >
            {playing ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
            )}
          </button>

          {/* Reset */}
          <button
            onClick={reset}
            style={{ width: 36, height: 36, borderRadius: 8, background: 'transparent', border: '1px solid var(--border)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', flexShrink: 0 }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.5"/></svg>
          </button>

          {/* Progress bar */}
          <div style={{ flex: 1, height: 4, background: 'var(--surface-3)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${progress * 100}%`, background: 'linear-gradient(90deg, var(--primary), var(--accent))', borderRadius: 2, transition: 'width 0.1s linear' }} />
          </div>

          {/* Speed */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>Speed</span>
            <input
              type="range" min="1" max="200" value={speed}
              onChange={e => setSpeed(Number(e.target.value))}
              style={{ width: 80, accentColor: 'var(--primary)', cursor: 'pointer' }}
            />
            <span style={{ fontSize: 11, color: 'var(--text-muted)', width: 28 }}>{speed}×</span>
          </div>
        </div>
      )}
    </div>
  );
}
