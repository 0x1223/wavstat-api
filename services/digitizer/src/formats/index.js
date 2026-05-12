'use strict';

const dst = require('./dst');
const pes = require('./pes');
const jef = require('./jef');
const exp = require('./exp');
const svg = require('./svg');
const png = require('./png');

const FORMATS = {
  dst: { encoder: dst, mime: 'application/octet-stream', ext: 'dst', binary: true },
  pes: { encoder: pes, mime: 'application/octet-stream', ext: 'pes', binary: true },
  jef: { encoder: jef, mime: 'application/octet-stream', ext: 'jef', binary: true },
  exp: { encoder: exp, mime: 'application/octet-stream', ext: 'exp', binary: true },
  svg: { encoder: svg, mime: 'image/svg+xml', ext: 'svg', binary: false },
  png: { encoder: png, mime: 'image/png', ext: 'png', binary: true },
};

async function exportFormat(format, stitches, options = {}) {
  const fmt = FORMATS[format.toLowerCase()];
  if (!fmt) throw new Error(`Unknown format: ${format}`);
  const result = await fmt.encoder.encode(stitches, options);
  return { buffer: Buffer.isBuffer(result) ? result : Buffer.from(result), mime: fmt.mime, ext: fmt.ext };
}

module.exports = { FORMATS, exportFormat, supportedFormats: Object.keys(FORMATS) };
