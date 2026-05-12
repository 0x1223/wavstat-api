'use strict';

// Coordinates are in 0.1mm units throughout (1 unit = 0.1mm).

function generateStitches(bitmap, width, height, pixelsPerMm, options = {}) {
  const {
    stitchLengthMm = 3.0,
    fillSpacingMm = 0.5,
    satinWidthMm = 1.8,
    maxJumpMm = 20,
    stitchAngleDeg = 35,
    minRegionAreaPx = Math.max(18, Math.round(width * height * 0.00018)),
  } = options;

  const scale = 10 / pixelsPerMm;
  const stitchLenUnits = Math.max(8, Math.round(stitchLengthMm * 10));
  const fillSpacingUnits = Math.max(8, Math.round(fillSpacingMm * 10));
  const satinWidthUnits = Math.max(8, Math.round(satinWidthMm * 10));
  const maxJumpUnits = maxJumpMm * 10;

  const regions = extractRegions(bitmap, width, height, minRegionAreaPx);
  const stitches = [];

  for (const [idx, region] of regions.entries()) {
    if (idx > 0 && stitches.length > 0) {
      const last = stitches[stitches.length - 1];
      stitches.push({ x: last.x, y: last.y, type: 'trim', role: 'trim' });
      stitches.push({ x: last.x, y: last.y, type: 'color_change', role: 'color_change' });
    }

    const angle = normalizeAngle(stitchAngleDeg + (idx % 2 ? -18 : 0));
    addRegionFill(stitches, region, scale, angle, fillSpacingUnits, stitchLenUnits, maxJumpUnits);
    addSatinBorder(stitches, region, scale, satinWidthUnits, stitchLenUnits, maxJumpUnits);
  }

  if (stitches.length > 0) {
    const last = stitches[stitches.length - 1];
    stitches.push({ x: last.x, y: last.y, type: 'end', role: 'end' });
  }

  return {
    stitches,
    debugStitches: generateScanlineDebug(bitmap, width, height, pixelsPerMm, {
      stitchLengthMm,
      fillSpacingMm: Math.max(0.35, options.fillSpacingMm || 0.5),
      maxJumpMm,
    }),
    regions: regions.map(r => ({
      areaPx: r.area,
      bounds: r.bounds,
      contourPoints: r.contour.length,
    })),
  };
}

function extractRegions(bitmap, width, height, minAreaPx) {
  const seen = new Uint8Array(width * height);
  const regions = [];
  const qx = [];
  const qy = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x;
      if (seen[start] || bitmap[start] !== 1) continue;

      let head = 0;
      qx.length = 0; qy.length = 0;
      qx.push(x); qy.push(y);
      seen[start] = 1;

      const pixels = [];
      let minX = x, minY = y, maxX = x, maxY = y;

      while (head < qx.length) {
        const px = qx[head];
        const py = qy[head++];
        pixels.push([px, py]);
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;

        for (const [nx, ny] of [[px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]]) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = ny * width + nx;
          if (!seen[ni] && bitmap[ni] === 1) {
            seen[ni] = 1;
            qx.push(nx); qy.push(ny);
          }
        }
      }

      if (pixels.length < minAreaPx) continue;

      const mask = new Set(pixels.map(([px, py]) => `${px},${py}`));
      const boundary = pixels.filter(([px, py]) =>
        !mask.has(`${px + 1},${py}`) || !mask.has(`${px - 1},${py}`) ||
        !mask.has(`${px},${py + 1}`) || !mask.has(`${px},${py - 1}`)
      );

      regions.push({
        pixels,
        mask,
        boundary,
        contour: orderContour(boundary),
        area: pixels.length,
        bounds: { minX, minY, maxX, maxY },
      });
    }
  }

  return regions.sort((a, b) => b.area - a.area);
}

function orderContour(points) {
  if (points.length <= 2) return points;
  const remaining = points.map(([x, y]) => ({ x, y }));
  remaining.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const ordered = [remaining.shift()];

  while (remaining.length) {
    const last = ordered[ordered.length - 1];
    let bestIdx = 0;
    let bestD = Infinity;
    const limit = Math.min(remaining.length, 2200);
    for (let i = 0; i < limit; i++) {
      const p = remaining[i];
      const d = Math.hypot(p.x - last.x, p.y - last.y);
      if (d < bestD) { bestD = d; bestIdx = i; }
    }
    ordered.push(remaining.splice(bestIdx, 1)[0]);
  }

  return ordered.map(p => [p.x, p.y]);
}

function addRegionFill(stitches, region, scale, angleDeg, spacingUnits, stitchLenUnits, maxJumpUnits) {
  const theta = angleDeg * Math.PI / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const spacingPx = Math.max(1, spacingUnits / scale);
  const binMap = new Map();

  for (const [px, py] of region.pixels) {
    const u = px * cos + py * sin;
    const v = -px * sin + py * cos;
    const bin = Math.round(v / spacingPx);
    const row = binMap.get(bin);
    if (row) {
      if (u < row.minU) row.minU = u;
      if (u > row.maxU) row.maxU = u;
      row.count++;
    } else {
      binMap.set(bin, { minU: u, maxU: u, v: bin * spacingPx, count: 1 });
    }
  }

  const rows = [...binMap.values()]
    .filter(row => (row.maxU - row.minU) * scale >= stitchLenUnits * 0.65)
    .sort((a, b) => a.v - b.v);

  rows.forEach((row, rowIdx) => {
    const insetPx = Math.min(1.25, Math.max(0, (row.maxU - row.minU) * 0.08));
    const a = rowIdx % 2 === 0 ? row.minU + insetPx : row.maxU - insetPx;
    const b = rowIdx % 2 === 0 ? row.maxU - insetPx : row.minU + insetPx;
    addAngledSegment(stitches, a, b, row.v, cos, sin, scale, stitchLenUnits, maxJumpUnits, 'fill');
  });
}

function addSatinBorder(stitches, region, scale, satinWidthUnits, stitchLenUnits, maxJumpUnits) {
  const contour = simplifyPolyline(region.contour, Math.max(2, Math.round(stitchLenUnits / scale)));
  if (contour.length < 3) return;

  const cx = region.pixels.reduce((sum, [x]) => sum + x, 0) / region.pixels.length;
  const cy = region.pixels.reduce((sum, [, y]) => sum + y, 0) / region.pixels.length;
  const half = satinWidthUnits / 2;

  for (let i = 0; i < contour.length; i++) {
    const [x0, y0] = contour[i];
    const [x1, y1] = contour[(i + 1) % contour.length];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1.25) continue;

    const nx = -dy / len;
    const ny = dx / len;
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    const towardCenter = ((cx - mx) * nx + (cy - my) * ny) > 0 ? 1 : -1;
    const ox = nx * towardCenter * half;
    const oy = ny * towardCenter * half;

    const ax = Math.round(x0 * scale - ox);
    const ay = Math.round(y0 * scale - oy);
    const bx = Math.round(x0 * scale + ox);
    const by = Math.round(y0 * scale + oy);

    addJumpIfNeeded(stitches, ax, ay, maxJumpUnits, 'satin');
    stitches.push({ x: bx, y: by, type: 'stitch', role: 'satin' });

    if (i % 2 === 0) {
      const cxu = Math.round(x1 * scale + ox);
      const cyu = Math.round(y1 * scale + oy);
      stitches.push({ x: cxu, y: cyu, type: 'stitch', role: 'contour' });
    }
  }
}

function addAngledSegment(stitches, u0, u1, v, cos, sin, scale, stitchLenUnits, maxJumpUnits, role) {
  const distUnits = Math.abs(u1 - u0) * scale;
  const steps = Math.max(1, Math.ceil(distUnits / stitchLenUnits));

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = u0 + (u1 - u0) * t;
    const x = Math.round((u * cos - v * sin) * scale);
    const y = Math.round((u * sin + v * cos) * scale);
    if (i === 0) addJumpIfNeeded(stitches, x, y, maxJumpUnits, role);
    else stitches.push({ x, y, type: 'stitch', role, angle: Math.round(Math.atan2(sin, cos) * 180 / Math.PI) });
  }
}

function addJumpIfNeeded(stitches, x, y, maxJumpUnits, role) {
  if (stitches.length === 0) {
    stitches.push({ x, y, type: 'jump', role });
    return;
  }
  const last = stitches[stitches.length - 1];
  const dist = Math.hypot(x - last.x, y - last.y);
  if (dist > maxJumpUnits) stitches.push({ x, y, type: 'jump', role });
}

function simplifyPolyline(points, tolerancePx) {
  if (points.length <= 3) return points;
  const out = [points[0]];
  let last = points[0];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= tolerancePx) {
      out.push(p);
      last = p;
    }
  }
  return out.length >= 3 ? out : points;
}

function normalizeAngle(angle) {
  while (angle < -90) angle += 180;
  while (angle > 90) angle -= 180;
  return angle;
}

function generateScanlineDebug(bitmap, width, height, pixelsPerMm, options = {}) {
  const scale = 10 / pixelsPerMm;
  const fillSpacingPx = Math.max(1, Math.round((options.fillSpacingMm || 0.5) * pixelsPerMm));
  const stitchLenUnits = Math.max(8, Math.round((options.stitchLengthMm || 3) * 10));
  const maxJumpUnits = (options.maxJumpMm || 20) * 10;
  const stitches = [];
  let rowIdx = 0;

  for (let py = 0; py < height; py += fillSpacingPx) {
    const runs = getRunsOnRow(bitmap, width, py);
    if (!runs.length) { rowIdx++; continue; }

    const dir = rowIdx % 2 === 1 ? -1 : 1;
    const orderedRuns = dir < 0 ? [...runs].reverse() : runs;

    for (const [startPx, endPx] of orderedRuns) {
      const x0 = Math.round(startPx * scale);
      const x1 = Math.round(endPx * scale);
      const y = Math.round(py * scale);
      addJumpIfNeeded(stitches, dir >= 0 ? x0 : x1, y, maxJumpUnits, 'debug-scanline');

      if (dir >= 0) {
        for (let x = x0; x < x1; x += stitchLenUnits) {
          stitches.push({ x: Math.min(x + stitchLenUnits, x1), y, type: 'stitch', role: 'debug-scanline' });
        }
      } else {
        for (let x = x1; x > x0; x -= stitchLenUnits) {
          stitches.push({ x: Math.max(x - stitchLenUnits, x0), y, type: 'stitch', role: 'debug-scanline' });
        }
      }
    }
    rowIdx++;
  }

  if (stitches.length) {
    const last = stitches[stitches.length - 1];
    stitches.push({ x: last.x, y: last.y, type: 'end', role: 'debug-scanline' });
  }

  return stitches;
}

function getRunsOnRow(bitmap, width, py) {
  const runs = [];
  let inRun = false;
  let runStart = 0;
  for (let px = 0; px < width; px++) {
    const filled = bitmap[py * width + px] === 1;
    if (filled && !inRun) { inRun = true; runStart = px; }
    else if (!filled && inRun) { inRun = false; runs.push([runStart, px - 1]); }
  }
  if (inRun) runs.push([runStart, width - 1]);
  return runs;
}

module.exports = { generateStitches, extractRegions, generateScanlineDebug };
