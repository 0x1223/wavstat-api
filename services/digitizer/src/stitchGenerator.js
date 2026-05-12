'use strict';

// Coordinates are in 0.1mm units throughout (1 unit = 0.1mm)

function generateStitches(regions, options = {}) {
  const {
    pixelsPerMm = 4,
    stitchLengthMm = 2.5,
    fillSpacingMm = 0.2,
    underlaySpacingMm = 2.0,
  } = options;

  const scale = 10 / pixelsPerMm; // pixels → 0.1mm units
  const fillSpacingPx = Math.max(1, Math.round(fillSpacingMm * pixelsPerMm));
  const underlaySpacingPx = Math.max(1, Math.round(underlaySpacingMm * pixelsPerMm));
  const stitchLenUnits = Math.round(stitchLengthMm * 10);

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

    // One jump per region (at first run); all subsequent run-starts are trims (invisible move, not counted as jump)
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
            // do-while guarantees at least one stitch per run and always lands exactly on x1
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

    // Underlay pass (wide spacing)
    scanRows(underlaySpacingPx);

    // Trim between underlay and fill (same region, invisible move)
    if (stitches.length > 0) {
      const last = stitches[stitches.length - 1];
      stitches.push({ x: last.x, y: last.y, type: 'trim' });
    }

    // Fill pass (tight spacing)
    scanRows(fillSpacingPx);

    // Between regions: trim + color_change
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
