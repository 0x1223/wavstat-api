'use strict';

// DST (Tajima) format encoder
// Coordinates in 0.1mm units. Max single-record delta: ±121 units (±12.1mm)

// Flag bytes use only bits 6-7 so they don't collide with ±81 movement bits 0-3
const STITCH = 0x00;
const JUMP = 0x80;
const COLOR_CHANGE = 0xC0;
const END = 0xF3;

function encodeDSTRecord(dx, dy, flag) {
  let b0 = 0, b1 = 0, b2 = flag & 0xF0;

  let x = Math.round(dx);
  if (x >= 0) {
    if (x >= 81) { b2 |= 0x02; x -= 81; }
    if (x >= 27) { b1 |= 0x02; x -= 27; }
    if (x >= 9)  { b0 |= 0x02; x -= 9; }
    if (x >= 3)  { b1 |= 0x20; x -= 3; }
    if (x >= 1)  { b0 |= 0x20; x -= 1; }
  } else {
    x = -x;
    if (x >= 81) { b2 |= 0x01; x -= 81; }
    if (x >= 27) { b1 |= 0x01; x -= 27; }
    if (x >= 9)  { b0 |= 0x01; x -= 9; }
    if (x >= 3)  { b1 |= 0x10; x -= 3; }
    if (x >= 1)  { b0 |= 0x10; x -= 1; }
  }

  let y = Math.round(dy);
  if (y >= 0) {
    if (y >= 81) { b2 |= 0x08; y -= 81; }
    if (y >= 27) { b1 |= 0x08; y -= 27; }
    if (y >= 9)  { b0 |= 0x08; y -= 9; }
    if (y >= 3)  { b1 |= 0x80; y -= 3; }
    if (y >= 1)  { b0 |= 0x80; y -= 1; }
  } else {
    y = -y;
    if (y >= 81) { b2 |= 0x04; y -= 81; }
    if (y >= 27) { b1 |= 0x04; y -= 27; }
    if (y >= 9)  { b0 |= 0x04; y -= 9; }
    if (y >= 3)  { b1 |= 0x40; y -= 3; }
    if (y >= 1)  { b0 |= 0x40; y -= 1; }
  }

  b2 |= flag & 0x0F;
  return [b0, b1, b2];
}

function splitDelta(dx, dy, flag) {
  // Split movement > 121 units into multiple records (jump stitches)
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
  buf[511] = 0x1A; // EOF marker
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
      const recs = splitDelta(dx, dy, JUMP);
      records.push(...recs);
    } else if (s.type === 'color_change') {
      records.push(encodeDSTRecord(0, 0, COLOR_CHANGE));
      colorChanges++;
    } else {
      // stitch
      const recs = splitDelta(dx, dy, STITCH);
      records.push(...recs);
      stitchCount++;
    }

    cx = s.x;
    cy = s.y;
    minX = Math.min(minX, cx);
    maxX = Math.max(maxX, cx);
    minY = Math.min(minY, cy);
    maxY = Math.max(maxY, cy);
  }

  // Ensure end marker
  if (!records.length || records[records.length - 1][2] !== END) {
    records.push([0x00, 0x00, END]);
  }

  const header = buildHeader(stitchCount, colorChanges, { minX, maxX, minY, maxY }, name);
  const stitchBuf = Buffer.from(records.flat());
  return Buffer.concat([header, stitchBuf]);
}

module.exports = { encode };
