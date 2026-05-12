'use strict';

const sharp = require('sharp');
const svgFormat = require('./svg');

async function encode(stitches, options = {}) {
  const { name = 'design', colors = ['#000000'], pngScale = 4 } = options;

  // Render via SVG → sharp (avoids native canvas requirement in CI)
  const svgStr = svgFormat.encode(stitches, { name, colors, scale: 0.1 * pngScale });
  const pngBuf = await sharp(Buffer.from(svgStr))
    .png({ compressionLevel: 6 })
    .toBuffer();
  return pngBuf;
}

module.exports = { encode };
