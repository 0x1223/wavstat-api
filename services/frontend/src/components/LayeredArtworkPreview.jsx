function stitchSegments(stitches = []) {
  const segments = [];
  let px = null;
  let py = null;

  for (const st of stitches) {
    if (st.type === 'end') break;
    if (st.type === 'color_change') { px = st.x; py = st.y; continue; }
    const jump = st.type === 'jump' || st.type === 'trim';
    if (px !== null && !jump) {
      segments.push({
        x1: px, y1: py, x2: st.x, y2: st.y,
        role: st.role || 'stitch',
        color: st.color || '#a78bfa',
      });
    }
    px = st.x; py = st.y;
  }

  return segments;
}

function boundsFor(imageInfo, segments) {
  if (imageInfo?.width && imageInfo?.pixelsPerMm) {
    return {
      minX: 0,
      minY: 0,
      maxX: imageInfo.width * (10 / imageInfo.pixelsPerMm),
      maxY: imageInfo.height * (10 / imageInfo.pixelsPerMm),
    };
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of segments) {
    minX = Math.min(minX, s.x1, s.x2); minY = Math.min(minY, s.y1, s.y2);
    maxX = Math.max(maxX, s.x1, s.x2); maxY = Math.max(maxY, s.y1, s.y2);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
}

export default function LayeredArtworkPreview({
  originalSrc,
  maskSrc,
  stitches = [],
  imageInfo,
  layers,
  onLayerChange,
}) {
  const segments = stitchSegments(stitches);
  const b = boundsFor(imageInfo, segments);
  const width = Math.max(1, b.maxX - b.minX);
  const height = Math.max(1, b.maxY - b.minY);
  const contourSegments = segments.filter(s => s.role === 'satin' || s.role === 'contour');
  const finalSegments = segments.filter(s => s.role !== 'satin' && s.role !== 'contour');

  const layerItems = [
    ['original', 'Original uploaded image'],
    ['mask', 'Detected artwork mask'],
    ['contours', 'Generated contour paths'],
    ['stitches', 'Final stitches'],
  ];

  return (
    <div className="layer-preview">
      <div className="layer-preview__toolbar">
        <div>
          <h1 style={{ marginBottom: 3 }}>Visualization Layers</h1>
          <p style={{ fontSize: 12 }}>Toggle each stage independently before export.</p>
        </div>
        <div className="layer-toggles">
          {layerItems.map(([key, label]) => (
            <label key={key} className={`layer-toggle ${layers[key] ? 'layer-toggle--on' : ''}`}>
              <input
                type="checkbox"
                checked={!!layers[key]}
                onChange={e => onLayerChange(key, e.target.checked)}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="layer-preview__stage">
        <svg viewBox={`${b.minX} ${b.minY} ${width} ${height}`} preserveAspectRatio="xMidYMid meet" className="layer-preview__svg">
          <rect x={b.minX} y={b.minY} width={width} height={height} fill="#070716" />
          {layers.original && originalSrc && (
            <image
              href={originalSrc}
              x={0}
              y={0}
              width={imageInfo?.width ? imageInfo.width * (10 / imageInfo.pixelsPerMm) : width}
              height={imageInfo?.height ? imageInfo.height * (10 / imageInfo.pixelsPerMm) : height}
              opacity="0.52"
              preserveAspectRatio="xMidYMid meet"
            />
          )}
          {layers.mask && maskSrc && (
            <image
              href={maskSrc}
              x={0}
              y={0}
              width={imageInfo?.width ? imageInfo.width * (10 / imageInfo.pixelsPerMm) : width}
              height={imageInfo?.height ? imageInfo.height * (10 / imageInfo.pixelsPerMm) : height}
              opacity="0.48"
              preserveAspectRatio="xMidYMid meet"
            />
          )}
          {layers.stitches && finalSegments.map((s, i) => (
            <line
              key={`st-${i}`}
              x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
              stroke={s.role === 'fill' ? '#a78bfa' : s.color}
              strokeWidth={s.role === 'fill' ? 1.1 : 1.35}
              strokeLinecap="round"
              opacity={s.role === 'fill' ? 0.5 : 0.75}
            />
          ))}
          {layers.contours && contourSegments.map((s, i) => (
            <line
              key={`ct-${i}`}
              x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
              stroke={s.role === 'satin' ? '#f0abfc' : '#22d3ee'}
              strokeWidth={s.role === 'satin' ? 2.4 : 1.55}
              strokeLinecap="round"
              opacity="0.92"
            />
          ))}
        </svg>
      </div>

      <div className="layer-preview__stats">
        <span className="hud-chip">contours {contourSegments.length.toLocaleString()}</span>
        <span className="hud-chip">final segments {finalSegments.length.toLocaleString()}</span>
      </div>
    </div>
  );
}
