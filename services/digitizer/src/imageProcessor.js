'use strict';
const sharp = require('sharp');

async function processImage(buffer, options = {}) {
  const {
    targetWidthMm = 100,
    targetHeightMm = 100,
    stitchesPerMm = 4,
    threshold = 128,
  } = options;

  const maxPx = Math.max(targetWidthMm, targetHeightMm) * stitchesPerMm;

  let pipeline = sharp(buffer);

  // Convert PDF page 1 to image via density option
  const meta = await pipeline.metadata();
  if (meta.format === 'pdf') {
    pipeline = sharp(buffer, { density: 150, page: 0 });
  }

  const { data, info } = await pipeline
    .resize(Math.round(targetWidthMm * stitchesPerMm), Math.round(targetHeightMm * stitchesPerMm), {
      fit: 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;

  // Binary bitmap: 1 = filled (dark), 0 = empty (light)
  const bitmap = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) {
    bitmap[i] = data[i] < threshold ? 1 : 0;
  }

  return { bitmap, width, height, pixelsPerMm: stitchesPerMm };
}

module.exports = { processImage };
