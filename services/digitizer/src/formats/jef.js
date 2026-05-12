'use strict';

// JEF (Janome Embroidery Format) encoder
// 2-byte stitch records: dx (int8), dy (int8)
// Special: (0x80, 0x00)=end, (0x80, 0x01)=color_change

const MAX_COLORS = 99;

function encode(stitches, options = {}) {
  const { name = 'design', colors = ['#000000'] } = options;
  const numColors = Math.min(colors.length, MAX_COLORS);

  // Count stitches for header
  let stitchCount = stitches.length;

  // Build stitch data
  const stitchBytes = [];
  let cx = 0, cy = 0;

  for (const s of stitches) {
    if (s.type === 'end') {
      stitchBytes.push(0x80, 0x00);
      break;
    }
    const dx = Math.round(s.x - cx);
    const dy = Math.round(s.y - cy);
    cx = s.x;
    cy = s.y;

    if (s.type === 'color_change') {
      stitchBytes.push(0x80, 0x01);
      continue;
    }

    // Split large deltas (max ±127)
    let rx = dx, ry = dy;
    while (Math.abs(rx) > 127 || Math.abs(ry) > 127) {
      const sx = Math.sign(rx) * Math.min(Math.abs(rx), 127);
      const sy = Math.sign(ry) * Math.min(Math.abs(ry), 127);
      const flag = (s.type === 'jump' || s.type === 'trim') ? 0x80 : 0x80;
      stitchBytes.push(sx & 0xFF, sy & 0xFF);
      rx -= sx;
      ry -= sy;
    }

    if (s.type === 'jump' || s.type === 'trim') {
      stitchBytes.push(0x80, 0x02, rx & 0xFF, ry & 0xFF);
    } else {
      stitchBytes.push(rx & 0xFF, ry & 0xFF);
    }
  }

  if (stitchBytes.length < 2 || stitchBytes[stitchBytes.length - 2] !== 0x80 || stitchBytes[stitchBytes.length - 1] !== 0x00) {
    stitchBytes.push(0x80, 0x00);
  }

  const dataOffset = 116 + numColors * 4;
  const now = Math.floor(Date.now() / 1000);

  const header = Buffer.alloc(116, 0);
  header.writeInt32LE(dataOffset, 0);           // offset to stitch data
  header.writeInt32LE(stitchCount, 4);           // stitch count
  header.writeInt32LE(now, 8);                   // creation date (unix timestamp)
  header.writeInt32LE(now, 12);                  // modification date
  header.writeInt32LE(1000, 16);                 // hoop x size (0.1mm: 100mm)
  header.writeInt32LE(1000, 20);                 // hoop y size
  header.writeInt32LE(numColors, 24);            // number of colors

  // Color table (dummy entries, 4 bytes each at offset 28)
  const colorTable = Buffer.alloc(numColors * 4, 0);
  for (let i = 0; i < numColors; i++) {
    colorTable.writeUInt32LE(i, i * 4); // color index
  }

  return Buffer.concat([header, colorTable, Buffer.from(stitchBytes)]);
}

module.exports = { encode };
