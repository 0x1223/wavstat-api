'use strict';
const sharp = require('sharp');

async function processImage(buffer, options = {}) {
  const {
    targetWidthMm = 100,
    targetHeightMm = 100,
    stitchesPerMm = 4,
    threshold = 128,
    numColors = 4,
  } = options;

  const imgW = Math.round(targetWidthMm * stitchesPerMm);
  const imgH = Math.round(targetHeightMm * stitchesPerMm);

  const meta = await sharp(buffer).metadata();
  let pipeline = meta.format === 'pdf'
    ? sharp(buffer, { density: 150, page: 0 })
    : sharp(buffer);

  const { data, info } = await pipeline
    .resize(imgW, imgH, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const pixels = data; // RGBA, 4 bytes per pixel

  // Detect background by sampling the four corners (5x5 patch each)
  function cornerLuminance() {
    const lums = [];
    const corners = [
      [0, 0], [width - 5, 0], [0, height - 5], [width - 5, height - 5],
    ];
    for (const [cx, cy] of corners) {
      for (let dy = 0; dy < 5; dy++) {
        for (let dx = 0; dx < 5; dx++) {
          const px = cx + dx;
          const py = cy + dy;
          if (px >= width || py >= height) continue;
          const i = (py * width + px) * 4;
          const a = pixels[i + 3];
          if (a < 128) { lums.push(255); continue; } // transparent = white bg
          const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
          lums.push(0.299 * r + 0.587 * g + 0.114 * b);
        }
      }
    }
    return lums.reduce((s, v) => s + v, 0) / lums.length;
  }

  const bgLum = cornerLuminance();
  const darkBackground = bgLum < 128;

  // Collect foreground pixels
  const fgPixels = []; // { idx, r, g, b, lum }
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const a = pixels[o + 3];
    if (a < 64) continue; // transparent
    const r = pixels[o], g = pixels[o + 1], b = pixels[o + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const isFg = darkBackground ? lum < 200 : lum < (255 - threshold + 128);
    if (isFg) fgPixels.push({ idx: i, r, g, b, lum });
  }

  if (fgPixels.length === 0) {
    return { width, height, pixelsPerMm: stitchesPerMm, imgW: width, imgH: height, regions: [] };
  }

  // K-means clustering
  const k = Math.min(numColors, fgPixels.length);

  // Subsample for centroid init speed
  const stride = Math.max(1, Math.floor(fgPixels.length / 2000));
  const sample = fgPixels.filter((_, i) => i % stride === 0);

  // Evenly-spaced deterministic init
  const centroids = [];
  for (let c = 0; c < k; c++) {
    const s = sample[Math.floor((c / k) * sample.length)];
    centroids.push({ r: s.r, g: s.g, b: s.b });
  }

  const assignments = new Int32Array(fgPixels.length);

  for (let iter = 0; iter < 15; iter++) {
    // Assign
    for (let i = 0; i < fgPixels.length; i++) {
      const { r, g, b } = fgPixels[i];
      let best = 0, bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const dr = r - centroids[c].r, dg = g - centroids[c].g, db = b - centroids[c].b;
        const d = dr * dr + dg * dg + db * db;
        if (d < bestDist) { bestDist = d; best = c; }
      }
      assignments[i] = best;
    }
    // Recompute
    const sums = Array.from({ length: k }, () => ({ r: 0, g: 0, b: 0, n: 0 }));
    for (let i = 0; i < fgPixels.length; i++) {
      const c = assignments[i];
      sums[c].r += fgPixels[i].r;
      sums[c].g += fgPixels[i].g;
      sums[c].b += fgPixels[i].b;
      sums[c].n++;
    }
    for (let c = 0; c < k; c++) {
      if (sums[c].n > 0) {
        centroids[c].r = sums[c].r / sums[c].n;
        centroids[c].g = sums[c].g / sums[c].n;
        centroids[c].b = sums[c].b / sums[c].n;
      }
    }
  }

  // Build region masks
  const masks = Array.from({ length: k }, () => new Uint8Array(width * height));
  for (let i = 0; i < fgPixels.length; i++) {
    masks[assignments[i]][fgPixels[i].idx] = 1;
  }

  // Build regions sorted darkest-first
  const regions = centroids.map((c, ci) => {
    const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    const hex = '#' + [c.r, c.g, c.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
    const pixelCount = masks[ci].reduce((s, v) => s + v, 0);
    return { colorHex: hex, label: `color_${ci + 1}`, mask: masks[ci], imgW: width, imgH: height, pixelCount, lum };
  }).filter(r => r.pixelCount > 0);

  regions.sort((a, b) => a.lum - b.lum);
  regions.forEach((r, i) => { r.label = `color_${i + 1}`; delete r.lum; });

  return { width, height, pixelsPerMm: stitchesPerMm, imgW: width, imgH: height, regions };
}

module.exports = { processImage };
