'use strict';
const sharp = require('sharp');

// ITU-R BT.709 luminance
function lum(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

async function rasterizeRGBA(buffer, targetWidthMm, targetHeightMm, stitchesPerMm) {
  let pipeline = sharp(buffer);
  const meta = await pipeline.metadata();
  if (meta.format === 'pdf') pipeline = sharp(buffer, { density: 150, page: 0 });

  return pipeline
    .resize(Math.round(targetWidthMm * stitchesPerMm), Math.round(targetHeightMm * stitchesPerMm), {
      fit: 'contain',
      // Transparent padding — means letterbox areas have alpha=0 and are skipped automatically
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .ensureAlpha()
    .toColorspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
}

// Build binary bitmap: 1 = stitch this pixel, 0 = skip
// Skip if alpha < alphaThreshold (transparent) or lum >= whiteThreshold (near-white background)
function buildBitmap(data, width, height, whiteThreshold, alphaThreshold) {
  const bitmap = new Uint8Array(width * height);
  let filled = 0;
  for (let i = 0; i < width * height; i++) {
    const o = i * 4; // always RGBA after ensureAlpha
    const a = data[o + 3];
    if (a < alphaThreshold) continue;
    const l = lum(data[o], data[o + 1], data[o + 2]);
    if (l >= whiteThreshold) continue;
    bitmap[i] = 1;
    filled++;
  }
  return { bitmap, filled };
}

function computeMaskStats(bitmap, width, height, filled) {
  if (filled === 0) {
    return {
      filledPixels: 0, totalPixels: width * height, coverage: 0,
      bounds: null, boundsCoverage: 0, touchesEdges: false,
      likelyRectangle: false, contourCount: 0, componentCount: 0,
      rejectionReason: 'No foreground pixels found — all pixels were transparent or near-white.',
      fallbackUsed: false,
    };
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!bitmap[y * width + x]) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }

  const boundsW = maxX - minX + 1;
  const boundsH = maxY - minY + 1;
  const boundsArea = boundsW * boundsH;
  const coverage = filled / (width * height);
  const boundsCoverage = filled / boundsArea;
  const touchesEdges = minX <= 1 || minY <= 1 || maxX >= width - 2 || maxY >= height - 2;

  // Only flag as a likely solid rectangle if it fills almost all of its own bounding box
  // AND covers >92% of the entire canvas — avoids false positives on logos with thick shapes
  const likelyRectangle = boundsCoverage > 0.95 && coverage > 0.92 && touchesEdges;

  return {
    filledPixels: filled,
    totalPixels: width * height,
    coverage,
    bounds: { minX, minY, maxX, maxY },
    boundsCoverage,
    touchesEdges,
    likelyRectangle,
    contourCount: 1,
    componentCount: 1,
    rejectionReason: null,
    fallbackUsed: false,
  };
}

async function processImage(buffer, options = {}) {
  const {
    targetWidthMm = 100,
    targetHeightMm = 100,
    stitchesPerMm = 4,
    // Accept both 'threshold' (legacy frontend param) and 'whiteThreshold' (server.js mapped name)
    whiteThreshold,
    threshold,
    alphaThreshold = 128,
  } = options;

  const whiteLuma = whiteThreshold ?? threshold ?? 220;

  const { data, info } = await rasterizeRGBA(buffer, targetWidthMm, targetHeightMm, stitchesPerMm);
  const { width, height } = info;

  const { bitmap, filled } = buildBitmap(data, width, height, whiteLuma, alphaThreshold);
  const maskStats = computeMaskStats(bitmap, width, height, filled);

  return { bitmap, width, height, pixelsPerMm: stitchesPerMm, maskStats };
}

async function previewMask(buffer, options = {}) {
  const {
    targetWidthMm = 100,
    targetHeightMm = 100,
    stitchesPerMm = 4,
    whiteThreshold,
    threshold,
    alphaThreshold = 128,
  } = options;

  const whiteLuma = whiteThreshold ?? threshold ?? 220;

  const { data, info } = await rasterizeRGBA(buffer, targetWidthMm, targetHeightMm, stitchesPerMm);
  const { width, height } = info;

  const { bitmap, filled } = buildBitmap(data, width, height, whiteLuma, alphaThreshold);
  const stats = computeMaskStats(bitmap, width, height, filled);

  // Render preview: foreground = cyan overlay, background = dimmed original
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const oo = i * 4;
    if (bitmap[i]) {
      out[oo] = 6; out[oo + 1] = 182; out[oo + 2] = 212; out[oo + 3] = 220; // cyan
    } else {
      out[oo]     = Math.round(data[o]     * 0.22);
      out[oo + 1] = Math.round(data[o + 1] * 0.22);
      out[oo + 2] = Math.round(data[o + 2] * 0.22);
      out[oo + 3] = Math.min(160, data[o + 3]);
    }
  }

  const png = await sharp(out, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return { png, width, height, stats };
}

module.exports = { processImage, previewMask };
