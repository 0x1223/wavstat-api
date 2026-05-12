'use strict';
const sharp = require('sharp');

async function processImage(buffer, options = {}) {
  const {
    targetWidthMm = 100,
    targetHeightMm = 100,
    stitchesPerMm = 4,
    threshold = 230, // skip pixels with luminance >= this (white / near-white background removal)
  } = options;

  let pipeline = sharp(buffer);

  const meta = await pipeline.metadata();
  if (meta.format === 'pdf') {
    pipeline = sharp(buffer, { density: 150, page: 0 });
  }

  // Keep RGB — we need per-channel values to compute proper luminance
  const { data, info } = await pipeline
    .resize(Math.round(targetWidthMm * stitchesPerMm), Math.round(targetHeightMm * stitchesPerMm), {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .removeAlpha()
    .toColorspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;

  // Binary bitmap: 1 = stitch this pixel, 0 = skip (background)
  // Uses ITU-R BT.709 luminance so coloured logo elements are captured
  // regardless of hue — only near-white pixels (lum >= threshold) are skipped.
  const bitmap = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    const r = data[o], g = data[o + 1] ?? r, b = data[o + 2] ?? r;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    bitmap[i] = lum < threshold ? 1 : 0;
  }

  return { bitmap, width, height, pixelsPerMm: stitchesPerMm };
}

module.exports = { processImage };
