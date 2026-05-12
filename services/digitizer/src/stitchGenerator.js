'use strict';

// Coordinates are in 0.1mm units throughout (1 unit = 0.1mm)

// ── Boundary tracing helpers ─────────────────────────────────────────────────

function buildEdgeMask(mask, imgW, imgH) {
  const edge = new Uint8Array(imgW * imgH);
  for (let py = 0; py < imgH; py++) {
    for (let px = 0; px < imgW; px++) {
      const idx = py * imgW + px;
      if (!mask[idx]) continue;
      const isEdge =
        px === 0 || px === imgW - 1 || py === 0 || py === imgH - 1 ||
        !mask[py * imgW + px - 1] || !mask[py * imgW + px + 1] ||
        !mask[(py - 1) * imgW + px] || !mask[(py + 1) * imgW + px];
      if (isEdge) edge[idx] = 1;
    }
  }
  return edge;
}

function findBoundaryComponents(mask, imgW, imgH) {
  const edge = buildEdgeMask(mask, imgW, imgH);
  const visited = new Uint8Array(imgW * imgH);
  const components = [];

  for (let py = 0; py < imgH; py++) {
    for (let px = 0; px < imgW; px++) {
      const idx = py * imgW + px;
      if (!edge[idx] || visited[idx]) continue;

      const comp = [];
      const stack = [idx];
      visited[idx] = 1;

      while (stack.length) {
        const i = stack.pop();
        const qx = i % imgW, qy = (i / imgW) | 0;
        comp.push([qx, qy]);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = qx + dx, ny = qy + dy;
            if (nx < 0 || ny < 0 || nx >= imgW || ny >= imgH) continue;
            const ni = ny * imgW + nx;
            if (edge[ni] && !visited[ni]) { visited[ni] = 1; stack.push(ni); }
          }
        }
      }

      if (comp.length >= 4) components.push(comp);
    }
  }
  return components;
}

// Order boundary component pixels into a traversal path using greedy 8-connected walk
function orderComponent(comp, imgW) {
  if (comp.length <= 2) return comp;
  const pixSet = new Set(comp.map(([x, y]) => y * imgW + x));
  const visited = new Set();
  const [sx, sy] = comp[0]; // topmost-leftmost (scan order)
  const ordered = [[sx, sy]];
  visited.add(sy * imgW + sx);
  let cx = sx, cy = sy;

  // 8-connected directions in CW order from right
  const dirs8 = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];

  while (true) {
    let moved = false;
    for (const [dx, dy] of dirs8) {
      const nx = cx + dx, ny = cy + dy;
      const key = ny * imgW + nx;
      if (pixSet.has(key) && !visited.has(key)) {
        visited.add(key);
        ordered.push([nx, ny]);
        cx = nx; cy = ny;
        moved = true;
        break;
      }
    }
    if (!moved) break;
  }
  return ordered;
}

// Generate satin stitches perpendicular to a contour path
function satinFromContour(contour, scale, satinWidthUnits, satinStepPx) {
  const stitches = [];
  if (contour.length < 2) return stitches;

  let accumulated = 0;
  let nextEmit = 0;
  let flip = false;

  for (let i = 0; i < contour.length; i++) {
    const [px, py] = contour[i];

    if (i > 0) {
      const [ppx, ppy] = contour[i - 1];
      accumulated += Math.sqrt((px - ppx) ** 2 + (py - ppy) ** 2);
    }

    if (i > 0 && accumulated < nextEmit) continue;
    nextEmit = accumulated + satinStepPx;

    // Tangent from prev→next neighbors
    const [ax, ay] = contour[Math.max(0, i - 1)];
    const [bx, by] = contour[Math.min(contour.length - 1, i + 1)];
    const tx = bx - ax, ty = by - ay;
    const tlen = Math.sqrt(tx * tx + ty * ty);
    if (tlen < 0.001) continue;

    // Perpendicular (CW rotation of tangent)
    const perpX = ty / tlen, perpY = -tx / tlen;

    const cx = px * scale, cy2 = py * scale;
    const hw = satinWidthUnits / 2;
    const x1 = Math.round(cx + perpX * hw), y1 = Math.round(cy2 + perpY * hw);
    const x2 = Math.round(cx - perpX * hw), y2 = Math.round(cy2 - perpY * hw);

    if (flip) {
      stitches.push({ x: x2, y: y2, type: 'stitch', role: 'satin' });
      stitches.push({ x: x1, y: y1, type: 'stitch', role: 'satin' });
    } else {
      stitches.push({ x: x1, y: y1, type: 'stitch', role: 'satin' });
      stitches.push({ x: x2, y: y2, type: 'stitch', role: 'satin' });
    }
    flip = !flip;
  }
  return stitches;
}

// ── Main stitch generator ────────────────────────────────────────────────────

function generateStitches(regions, options = {}) {
  const {
    pixelsPerMm = 4,
    stitchLengthMm = 2.5,
    fillSpacingMm = 0.2,
    underlaySpacingMm = 1.0,
    satinWidthMm = 0.8,
    satinStepMm = 0.4,
  } = options;

  const scale = 10 / pixelsPerMm; // pixels → 0.1mm units
  const fillSpacingPx    = Math.max(1, Math.round(fillSpacingMm    * pixelsPerMm));
  const underlaySpacingPx = Math.max(1, Math.round(underlaySpacingMm * pixelsPerMm));
  const stitchLenUnits   = Math.round(stitchLengthMm * 10);
  const satinWidthUnits  = satinWidthMm * 10;
  const satinStepPx      = Math.max(1, satinStepMm * pixelsPerMm);

  const stitches = [];

  function getRunsOnRow(mask, imgW, py) {
    const runs = [];
    let inRun = false, runStart = 0;
    for (let px = 0; px < imgW; px++) {
      const filled = mask[py * imgW + px] === 1;
      if (filled && !inRun) { inRun = true; runStart = px; }
      else if (!filled && inRun) { inRun = false; runs.push([runStart, px - 1]); }
    }
    if (inRun) runs.push([runStart, imgW - 1]);
    return runs;
  }

  for (let ri = 0; ri < regions.length; ri++) {
    const { mask, imgW, imgH } = regions[ri];

    // One jump per region start; subsequent run-starts are trims (invisible, uncounted)
    let regionJumped = false;

    function emitRunStart(x, y) {
      if (!regionJumped) {
        stitches.push({ x, y, type: 'jump' });
        regionJumped = true;
      } else {
        stitches.push({ x, y, type: 'trim' });
      }
    }

    function scanRows(spacingPx) {
      let rowIdx = 0;
      for (let py = 0; py < imgH; py += spacingPx) {
        const runs = getRunsOnRow(mask, imgW, py);
        if (runs.length === 0) { rowIdx++; continue; }

        const dir = rowIdx % 2 === 1 ? -1 : 1;
        const orderedRuns = dir < 0 ? [...runs].reverse() : runs;

        for (const [startPx, endPx] of orderedRuns) {
          const x0 = Math.round(startPx * scale);
          const x1 = Math.round(endPx * scale);
          const yu = Math.round(py * scale);
          const startX = dir >= 0 ? x0 : x1;

          emitRunStart(startX, yu);

          if (dir >= 0) {
            let x = x0;
            do {
              x = Math.min(x + stitchLenUnits, x1);
              stitches.push({ x, y: yu, type: 'stitch' });
            } while (x < x1);
          } else {
            let x = x1;
            do {
              x = Math.max(x - stitchLenUnits, x0);
              stitches.push({ x, y: yu, type: 'stitch' });
            } while (x > x0);
          }
        }
        rowIdx++;
      }
    }

    // Underlay pass (wide spacing, stabilises fabric)
    scanRows(underlaySpacingPx);
    if (stitches.length > 0) {
      const last = stitches[stitches.length - 1];
      stitches.push({ x: last.x, y: last.y, type: 'trim' });
    }

    // Fill pass (tight spacing)
    scanRows(fillSpacingPx);

    // Satin border — one pass per connected boundary component
    const comps = findBoundaryComponents(mask, imgW, imgH);
    for (const comp of comps) {
      const ordered = orderComponent(comp, imgW);
      const satinSt = satinFromContour(ordered, scale, satinWidthUnits, satinStepPx);
      if (satinSt.length > 0 && stitches.length > 0) {
        const last = stitches[stitches.length - 1];
        stitches.push({ x: last.x, y: last.y, type: 'trim' });
        stitches.push({ x: satinSt[0].x, y: satinSt[0].y, type: 'trim' });
        stitches.push(...satinSt);
      }
    }

    // Between regions: trim + color change
    if (ri < regions.length - 1 && stitches.length > 0) {
      const last = stitches[stitches.length - 1];
      stitches.push({ x: last.x, y: last.y, type: 'trim' });
      stitches.push({ x: last.x, y: last.y, type: 'color_change' });
    }
  }

  if (stitches.length > 0) {
    const last = stitches[stitches.length - 1];
    stitches.push({ x: last.x, y: last.y, type: 'end' });
  }

  return stitches;
}

module.exports = { generateStitches };
