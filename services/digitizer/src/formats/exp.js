'use strict';

// EXP (Melco Expanded) format encoder
// Simple 2-byte records: [dx, dy] as signed bytes (-128..127)
// Jump: 0x80 flag in both bytes

function encode(stitches, options = {}) {
  const bytes = [];
  let cx = 0, cy = 0;

  function emitRecord(dx, dy, isJump) {
    // Split into steps that fit in signed byte range
    const MAX = 127;
    let rx = Math.round(dx), ry = Math.round(dy);

    while (Math.abs(rx) > MAX || Math.abs(ry) > MAX) {
      const sx = Math.sign(rx) * Math.min(Math.abs(rx), MAX);
      const sy = Math.sign(ry) * Math.min(Math.abs(ry), MAX);
      // EXP jump: 0x80 0x04 then dx dy
      bytes.push(0x80, 0x04, sx & 0xFF, sy & 0xFF);
      rx -= sx;
      ry -= sy;
    }

    if (isJump) {
      bytes.push(0x80, 0x04, rx & 0xFF, ry & 0xFF);
    } else {
      bytes.push(rx & 0xFF, ry & 0xFF);
    }
  }

  for (const s of stitches) {
    if (s.type === 'end') {
      bytes.push(0x80, 0x10); // end command
      break;
    }
    const dx = s.x - cx;
    const dy = s.y - cy;

    if (s.type === 'jump' || s.type === 'trim') {
      emitRecord(dx, dy, true);
    } else if (s.type === 'color_change') {
      bytes.push(0x80, 0x01); // color change
    } else {
      emitRecord(dx, dy, false);
    }
    cx = s.x;
    cy = s.y;
  }

  if (bytes[bytes.length - 2] !== 0x80 || bytes[bytes.length - 1] !== 0x10) {
    bytes.push(0x80, 0x10);
  }

  return Buffer.from(bytes);
}

module.exports = { encode };
