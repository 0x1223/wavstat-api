'use strict';

// Coordinates are in 0.1mm units throughout (1 unit = 0.1mm)

function generateStitches(bitmap, width, height, pixelsPerMm, options = {}) {
  const {
    stitchLengthMm = 3.0,
    fillSpacingMm = 0.5,
    underlaySpacingMm = 2.0,
    maxJumpMm = 20,
  } = options;

  const scale = 10 / pixelsPerMm; // pixels → 0.1mm units
  const fillSpacingPx = Math.max(1, Math.round(fillSpacingMm * pixelsPerMm));
  const underlaySpacingPx = Math.max(1, Math.round(underlaySpacingMm * pixelsPerMm));
  const stitchLenUnits = Math.round(stitchLengthMm * 10);
  const maxJumpUnits = maxJumpMm * 10;

  const stitches = [];

  function addJumpIfNeeded(x, y) {
    if (stitches.length === 0) {
      stitches.push({ x, y, type: 'jump' });
      return;
    }
    const last = stitches[stitches.length - 1];
    const dist = Math.hypot(x - last.x, y - last.y);
    if (dist > maxJumpUnits) {
      stitches.push({ x, y, type: 'jump' });
    }
  }

  function stitchLine(x0, x1, y, direction) {
    const yu = Math.round(y * scale);
    if (direction >= 0) {
      for (let x = x0; x <= x1; x += stitchLenUnits) {
        const xu = Math.min(Math.round(x), Math.round(x1 * scale));
        stitches.push({ x: Math.round(x0 * scale + (x - x0)), y: yu, type: 'stitch' });
      }
      stitches.push({ x: Math.round(x1 * scale), y: yu, type: 'stitch' });
    } else {
      for (let x = x1; x >= x0; x -= stitchLenUnits) {
        stitches.push({ x: Math.round(x1 * scale - (x1 - x)), y: yu, type: 'stitch' });
      }
      stitches.push({ x: Math.round(x0 * scale), y: yu, type: 'stitch' });
    }
  }

  // Scan rows for filled runs
  function scanRows(spacingPx, alternate) {
    let rowIdx = 0;
    for (let py = 0; py < height; py += spacingPx) {
      const runs = getRunsOnRow(bitmap, width, py);
      if (runs.length === 0) { rowIdx++; continue; }

      const dir = (alternate && rowIdx % 2 === 1) ? -1 : 1;
      const orderedRuns = dir < 0 ? [...runs].reverse() : runs;

      for (const [startPx, endPx] of orderedRuns) {
        const x0units = Math.round(startPx * scale);
        const x1units = Math.round(endPx * scale);
        const yunits = Math.round(py * scale);

        addJumpIfNeeded(dir >= 0 ? x0units : x1units, yunits);

        // Walk from x0 to x1 (or reverse) placing stitches at stitchLenUnits intervals
        if (dir >= 0) {
          let x = x0units;
          while (x < x1units) {
            const next = Math.min(x + stitchLenUnits, x1units);
            stitches.push({ x: next, y: yunits, type: 'stitch' });
            x = next;
          }
        } else {
          let x = x1units;
          while (x > x0units) {
            const next = Math.max(x - stitchLenUnits, x0units);
            stitches.push({ x: next, y: yunits, type: 'stitch' });
            x = next;
          }
        }
      }
      rowIdx++;
    }
  }

  // Underlay pass (vertical direction - rotate 90°)
  const transposedBitmap = transpose(bitmap, width, height);
  const origScan = { bitmap, width, height };

  // Underlay (horizontal, wider spacing)
  scanRows(underlaySpacingPx, true);

  // Main fill (horizontal, tight spacing)
  if (stitches.length > 0) {
    stitches.push({ x: stitches[stitches.length - 1].x, y: stitches[stitches.length - 1].y, type: 'trim' });
  }
  scanRows(fillSpacingPx, true);

  // End marker
  if (stitches.length > 0) {
    const last = stitches[stitches.length - 1];
    stitches.push({ x: last.x, y: last.y, type: 'end' });
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

function transpose(bitmap, width, height) {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[x * height + y] = bitmap[y * width + x];
    }
  }
  return out;
}

module.exports = { generateStitches };
