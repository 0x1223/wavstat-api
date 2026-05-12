'use strict';

// DST (Tajima) format encoder
// Coordinates in 0.1mm units. Max single-record delta: ±121 units (±12.1mm)
//
// Each 3-byte record encodes a signed X and Y delta using balanced ternary:
//   available values per axis: ±1, ±3, ±9, ±27, ±81  (max sum = 121)
//   each "slot" contributes its value positively, negatively, or not at all
//
// Bit layout (matching parseDST.js decoder):
//   b0: Y±1 (bits 7,6), X±1 (bits 5,4), Y±9 (bits 3,2), X±9 (bits 1,0)
//   b1: Y±3 (bits 7,6), X±3 (bits 5,4), Y±27 (bits 3,2), X±27 (bits 1,0)
//   b2: type flags (bits 7,6), Y±81 (bits 3,2), X±81 (bits 1,0)
//
// Type flags (bits 7-4 of b2, lower nibble reserved for ±81 movement):
const STITCH       = 0x00; // b2 bits 7,6 = 00
const JUMP         = 0x80; // b2 bit  7   = 10
const COLOR_CHANGE = 0xC0; // b2 bits 7,6 = 11
const END          = 0xF3; // special end-of-file marker

// [power, byteIndex, posMask, negMask]
//   byteIndex: 0=b0, 1=b1, 2=b2
const X_CONFIG = [
  [81, 2, 0x02, 0x01],
  [27, 1, 0x02, 0x01],
  [9,  0, 0x02, 0x01],
  [3,  1, 0x20, 0x10],
  [1,  0, 0x20, 0x10],
];

const Y_CONFIG = [
  [81, 2, 0x08, 0x04],
  [27, 1, 0x08, 0x04],
  [9,  0, 0x08, 0x04],
  [3,  1, 0x80, 0x40],
  [1,  0, 0x80, 0x40],
];

// Balanced ternary encoder for one axis.
// At each slot (from largest power to smallest), we use +p if remaining > tail,
// −p if remaining < −tail, otherwise skip it. This guarantees remaining → 0
// for any integer in [−121, +121].
function encodeAxis(config, val, bytes) {
  let remaining = Math.round(val);
  for (let i = 0; i < 5; i++) {
    const [p, bi, pm, nm] = config[i];
    const tail = i < 4 ? config.slice(i + 1).reduce((s, [v]) => s + v, 0) : 0;
    if (remaining > tail) {
      bytes[bi] |= pm;
      remaining -= p;
    } else if (remaining < -tail) {
      bytes[bi] |= nm;
      remaining += p;
    }
  }
}

function encodeDSTRecord(dx, dy, flag) {
  const bytes = [0, 0, flag & 0xF0];
  encodeAxis(X_CONFIG, dx, bytes);
  encodeAxis(Y_CONFIG, dy, bytes);
  bytes[2] |= flag & 0x0F; // preserve lower nibble (e.g. END = 0xF3)
  return bytes;
}

function splitDelta(dx, dy, flag) {
  // Split movement > 121 units into multiple JUMP records
  const MAX = 121;
  const records = [];
  let rx = dx, ry = dy;
  while (Math.abs(rx) > MAX || Math.abs(ry) > MAX) {
    const sx = Math.sign(rx) * Math.min(Math.abs(rx), MAX);
    const sy = Math.sign(ry) * Math.min(Math.abs(ry), MAX);
    records.push(encodeDSTRecord(sx, sy, JUMP));
    rx -= sx;
    ry -= sy;
  }
  records.push(encodeDSTRecord(rx, ry, flag));
  return records;
}

function buildHeader(stitchCount, colorChanges, bounds, name) {
  const label = (name || 'design').substring(0, 14).padEnd(14, ' ');
  const { minX = 0, minY = 0, maxX = 0, maxY = 0 } = bounds;
  const posX = Math.max(0, maxX);
  const negX = Math.max(0, -minX);
  const posY = Math.max(0, maxY);
  const negY = Math.max(0, -minY);

  let header = '';
  header += `LA:${label}\r`;
  header += `ST:${String(stitchCount).padStart(7, '0')}\r`;
  header += `CO:${String(colorChanges).padStart(2, '0')}\r`;
  header += `+X:${String(posX).padStart(4, '0')}\r`;
  header += `-X:${String(negX).padStart(4, '0')}\r`;
  header += `+Y:${String(posY).padStart(4, '0')}\r`;
  header += `-Y:${String(negY).padStart(4, '0')}\r`;
  header += `AX:+00000\r`;
  header += `AY:+00000\r`;
  header += `MX:+00000\r`;
  header += `MY:+00000\r`;
  header += `PD:******\r`;

  const buf = Buffer.alloc(512, 0x20); // fill with spaces
  buf.write(header, 0, 'ascii');
  buf[511] = 0x1A; // SUB — Tajima header EOF marker
  return buf;
}

function encode(stitches, options = {}) {
  const { name = 'design' } = options;
  const records = [];
  let cx = 0, cy = 0;
  let stitchCount = 0;
  let colorChanges = 0;
  let minX = 0, maxX = 0, minY = 0, maxY = 0;

  for (const s of stitches) {
    const dx = s.x - cx;
    const dy = s.y - cy;

    if (s.type === 'end') {
      records.push([0x00, 0x00, END]);
      break;
    } else if (s.type === 'jump' || s.type === 'trim') {
      records.push(...splitDelta(dx, dy, JUMP));
    } else if (s.type === 'color_change') {
      records.push(encodeDSTRecord(0, 0, COLOR_CHANGE));
      colorChanges++;
    } else {
      // stitch (including role:'satin')
      records.push(...splitDelta(dx, dy, STITCH));
      stitchCount++;
    }

    cx = s.x; cy = s.y;
    minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
    minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
  }

  // Ensure end marker
  if (!records.length || records[records.length - 1][2] !== END) {
    records.push([0x00, 0x00, END]);
  }

  const header = buildHeader(stitchCount, colorChanges, { minX, maxX, minY, maxY }, name);
  const stitchBuf = Buffer.from(records.flat());

  // Debug: log first 6 records (18 bytes after header) and file stats
  const sample = [...stitchBuf.slice(0, 18)].map(b => b.toString(16).padStart(2, '0')).join(' ');
  console.log(`[DST] stitches=${stitchCount} jumps=${records.filter(r => (r[2] & 0xC0) === 0x80).length} colorChanges=${colorChanges} fileSize=${header.length + stitchBuf.length}B`);
  console.log(`[DST] first 6 records: ${sample}`);

  return Buffer.concat([header, stitchBuf]);
}

module.exports = { encode };
