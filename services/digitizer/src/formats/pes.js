'use strict';

// PES v1 / PEC format encoder (Brother Industries)
// PEC uses signed 7-bit coords per axis (-64..63), or 12-bit extended

function encodePECCoord(val) {
  val = Math.round(val);
  if (val >= -64 && val <= 63) {
    return [val < 0 ? val + 128 : val];
  }
  // 12-bit extended encoding
  val = Math.max(-2048, Math.min(2047, val));
  const v = val < 0 ? val + 4096 : val;
  return [0x80 | (v >> 8), v & 0xFF];
}

function buildPEC(stitches, name) {
  const pecBytes = [];
  const label = ('LA:' + (name || 'design').substring(0, 14)).padEnd(19, ' ');
  // Label line
  for (let i = 0; i < 19; i++) pecBytes.push(label.charCodeAt(i));
  pecBytes.push(0x0D); // CR
  // PEC preamble
  pecBytes.push(0xFF, 0x00, 0x06, 0x26);
  for (let i = 0; i < 12; i++) pecBytes.push(0x20); // spaces
  pecBytes.push(0xFF, 0x00);

  let cx = 0, cy = 0;

  for (const s of stitches) {
    if (s.type === 'end') {
      pecBytes.push(0xFF, 0x00);
      break;
    }
    const dx = s.x - cx;
    const dy = s.y - cy;

    if (s.type === 'jump' || s.type === 'trim') {
      // Jump: split into steps and emit with jump flag
      let rx = Math.round(dx), ry = Math.round(dy);
      while (rx !== 0 || ry !== 0) {
        const sx = Math.sign(rx) * Math.min(Math.abs(rx), 63);
        const sy = Math.sign(ry) * Math.min(Math.abs(ry), 63);
        const xb = sx < 0 ? sx + 128 : sx;
        const yb = sy < 0 ? sy + 128 : sy;
        pecBytes.push(0x80 | xb, 0x80 | yb);
        rx -= sx;
        ry -= sy;
      }
    } else if (s.type === 'color_change') {
      pecBytes.push(0xFE, 0xB0, 0x02, 0x00);
    } else {
      const xEnc = encodePECCoord(dx);
      const yEnc = encodePECCoord(dy);
      pecBytes.push(...xEnc, ...yEnc);
    }

    cx = s.x;
    cy = s.y;
  }

  if (pecBytes[pecBytes.length - 2] !== 0xFF || pecBytes[pecBytes.length - 1] !== 0x00) {
    pecBytes.push(0xFF, 0x00);
  }

  return Buffer.from(pecBytes);
}

function encode(stitches, options = {}) {
  const { name = 'design', widthMm = 100, heightMm = 100 } = options;
  const pecBuf = buildPEC(stitches, name);

  // PES v1 header
  const header = Buffer.alloc(20);
  header.write('#PES', 0, 'ascii');
  header.write('0001', 4, 'ascii');
  header.writeUInt32LE(20, 8); // PEC offset immediately after header
  header.writeUInt16LE(Math.round(widthMm * 10), 12);  // hoop width in 0.1mm
  header.writeUInt16LE(Math.round(heightMm * 10), 14); // hoop height in 0.1mm
  header.writeUInt16LE(0x01, 16); // 1 design part
  header.writeUInt16LE(0xFFFF, 18);

  return Buffer.concat([header, pecBuf]);
}

module.exports = { encode };
