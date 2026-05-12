'use strict';
const sharp = require('sharp');

async function processImage(buffer, options = {}) {
  const {
    targetWidthMm    = 100,
    targetHeightMm   = 100,
    stitchesPerMm    = 4,
    // threshold / whiteThreshold both map to the per-channel cutoff
    // pixel is skipped when R > t AND G > t AND B > t  (i.e. near-white)
    whiteThreshold,
    threshold,
  } = options;

  const t = whiteThreshold ?? threshold ?? 210;

  let pipeline = sharp(buffer);
  const meta   = await pipeline.metadata();
  if (meta.format === 'pdf') pipeline = sharp(buffer, { density: 150, page: 0 });

  const { data, info } = await pipeline
    .resize(
      Math.round(targetWidthMm  * stitchesPerMm),
      Math.round(targetHeightMm * stitchesPerMm),
      { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } }
    )
    .flatten({ background: { r: 255, g: 255, b: 255 } })   // collapse alpha → white
    .removeAlpha()
    .toColorspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const bitmap = new Uint8Array(width * height);
  let filled = 0;

  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    // Skip pixel if all three channels are above threshold (near-white background)
    if (r > t && g > t && b > t) continue;
    bitmap[i] = 1;
    filled++;
  }

  const maskStats = buildStats(bitmap, width, height, filled);
  return { bitmap, width, height, pixelsPerMm: stitchesPerMm, maskStats };
}

async function previewMask(buffer, options = {}) {
  const {
    targetWidthMm  = 100,
    targetHeightMm = 100,
    stitchesPerMm  = 4,
    whiteThreshold,
    threshold,
  } = options;

  const t = whiteThreshold ?? threshold ?? 210;

  let pipeline = sharp(buffer);
  const meta   = await pipeline.metadata();
  if (meta.format === 'pdf') pipeline = sharp(buffer, { density: 150, page: 0 });

  const { data, info } = await pipeline
    .resize(
      Math.round(targetWidthMm  * stitchesPerMm),
      Math.round(targetHeightMm * stitchesPerMm),
      { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } }
    )
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .removeAlpha()
    .toColorspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const bitmap = new Uint8Array(width * height);
  let filled = 0;

  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    if (r > t && g > t && b > t) continue;
    bitmap[i] = 1;
    filled++;
  }

  const stats = buildStats(bitmap, width, height, filled);

  // Cyan overlay on foreground, dimmed original on background
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o  = i * channels;
    const oo = i * 4;
    if (bitmap[i]) {
      out[oo] = 6; out[oo + 1] = 182; out[oo + 2] = 212; out[oo + 3] = 220;
    } else {
      out[oo]     = Math.round(data[o]     * 0.25);
      out[oo + 1] = Math.round(data[o + 1] * 0.25);
      out[oo + 2] = Math.round(data[o + 2] * 0.25);
      out[oo + 3] = 160;
    }
  }

  const png = await sharp(out, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return { png, width, height, stats };
}

function buildStats(bitmap, width, height, filled) {
  if (filled === 0) {
    return {
      filledPixels: 0, totalPixels: width * height, coverage: 0,
      bounds: null, boundsCoverage: 0, touchesEdges: false,
      likelyRectangle: false, contourCount: 0, componentCount: 0,
      rejectionReason: 'No foreground pixels — all pixels were near-white (R>t AND G>t AND B>t).',
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

  const boundsArea   = (maxX - minX + 1) * (maxY - minY + 1);
  const coverage     = filled / (width * height);
  const boundsCoverage = filled / boundsArea;
  const touchesEdges = minX <= 1 || minY <= 1 || maxX >= width - 2 || maxY >= height - 2;

  // Rectangle guard: only block if the mask is essentially a solid filled canvas
  const likelyRectangle = boundsCoverage > 0.95 && coverage > 0.90 && touchesEdges;

  return {
    filledPixels: filled, totalPixels: width * height, coverage,
    bounds: { minX, minY, maxX, maxY }, boundsCoverage, touchesEdges,
    likelyRectangle, contourCount: 1, componentCount: 1,
    rejectionReason: null, fallbackUsed: false,
  };
}

module.exports = { processImage, previewMask };
