const THREAD_PALETTE = [
  '#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7',
  '#ec4899', '#14b8a6', '#f97316', '#84cc16', '#0ea5e9',
  '#e879f9', '#fb923c', '#34d399', '#60a5fa', '#fbbf24',
];

// ── DST ───────────────────────────────────────────────────────────────────────

export function parseDSTHeader(buffer) {
  const text = new TextDecoder('ascii').decode(new Uint8Array(buffer, 0, 512));
  const get = (key) => { const m = text.match(new RegExp(key + ':([^\r\n]*)')); return m ? m[1].trim() : null; };
  return {
    name: get('LA') || 'Untitled',
    stitchCount: parseInt(get('ST')) || 0,
    colorChanges: parseInt(get('CO')) || 0,
    extentX: (parseInt(get('\\+X')) || 0) + (parseInt(get('-X')) || 0),
    extentY: (parseInt(get('\\+Y')) || 0) + (parseInt(get('-Y')) || 0),
  };
}

export function parseDST(buffer) {
  const view = new DataView(buffer);
  const stitches = [];
  let cx = 0, cy = 0, colorIdx = 0;
  let offset = 512;

  while (offset + 2 < buffer.byteLength) {
    const b0 = view.getUint8(offset);
    const b1 = view.getUint8(offset + 1);
    const b2 = view.getUint8(offset + 2);
    offset += 3;

    if (b2 === 0xF3) break;

    let dx = 0;
    if (b0 & 0x20) dx += 1;  if (b0 & 0x10) dx -= 1;
    if (b1 & 0x20) dx += 3;  if (b1 & 0x10) dx -= 3;
    if (b0 & 0x02) dx += 9;  if (b0 & 0x01) dx -= 9;
    if (b1 & 0x02) dx += 27; if (b1 & 0x01) dx -= 27;
    if (b2 & 0x02) dx += 81; if (b2 & 0x01) dx -= 81;

    let dy = 0;
    if (b0 & 0x80) dy += 1;  if (b0 & 0x40) dy -= 1;
    if (b1 & 0x80) dy += 3;  if (b1 & 0x40) dy -= 3;
    if (b0 & 0x08) dy += 9;  if (b0 & 0x04) dy -= 9;
    if (b1 & 0x08) dy += 27; if (b1 & 0x04) dy -= 27;
    if (b2 & 0x08) dy += 81; if (b2 & 0x04) dy -= 81;

    cx += dx;
    cy += dy;

    // flag bits are in b2[7:6]: 00=stitch, 10=jump, 11=color_change
    const isColorChange = (b2 & 0xC0) === 0xC0;
    const isJump        = !isColorChange && (b2 & 0x80) !== 0;

    if (isColorChange) {
      colorIdx = (colorIdx + 1) % THREAD_PALETTE.length;
      stitches.push({ x: cx, y: cy, type: 'color_change', color: THREAD_PALETTE[colorIdx] });
    } else {
      stitches.push({ x: cx, y: cy, type: isJump ? 'jump' : 'stitch', color: THREAD_PALETTE[colorIdx] });
    }
  }

  return stitches;
}

// ── PES / PEC (Brother) ───────────────────────────────────────────────────────
// Header: "#PES" + version (4) + pecOffset (uint32LE) + ...
// PEC preamble is 38 bytes (label 19 + CR + FF 00 06 26 + 12 spaces + FF 00)
// Stitch stream after preamble:
//   Normal stitch : two bytes < 0x80 (7-bit signed: neg = val+128)
//   Jump          : two bytes ≥ 0x80 (7-bit signed with 0x80 flag)
//   Color change  : FE B0 02 00
//   End           : FF 00

export function parsePES(buffer) {
  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3),
  );
  if (magic !== '#PES') throw new Error('Not a PES file');

  const pecOffset = view.getUint32(8, true);
  const stitches = [];
  let cx = 0, cy = 0, colorIdx = 0;
  let i = pecOffset + 38; // skip PEC header preamble

  while (i < buffer.byteLength - 1) {
    const b0 = view.getUint8(i);

    if (b0 === 0xFF) break; // end

    if (b0 === 0xFE && view.getUint8(i + 1) === 0xB0) {
      colorIdx = (colorIdx + 1) % THREAD_PALETTE.length;
      stitches.push({ x: cx, y: cy, type: 'color_change', color: THREAD_PALETTE[colorIdx] });
      i += 4;
      continue;
    }

    const b1 = view.getUint8(i + 1);

    if (b0 >= 0x80 && b1 >= 0x80) {
      // Jump: both bytes have the 0x80 flag
      const xb = b0 & 0x7F, yb = b1 & 0x7F;
      cx += xb >= 64 ? xb - 128 : xb;
      cy += yb >= 64 ? yb - 128 : yb;
      stitches.push({ x: cx, y: cy, type: 'jump', color: THREAD_PALETTE[colorIdx] });
      i += 2;
    } else if (b0 >= 0x80) {
      // Extended 12-bit stitch (two-byte x, then y)
      const vx = ((b0 & 0x7F) << 8) | b1;
      cx += vx >= 0x800 ? vx - 0x1000 : vx;
      i += 2;
      const b2 = view.getUint8(i);
      if (b2 >= 0x80) {
        const b3 = view.getUint8(i + 1);
        const vy = ((b2 & 0x7F) << 8) | b3;
        cy += vy >= 0x800 ? vy - 0x1000 : vy;
        i += 2;
      } else {
        cy += b2 >= 64 ? b2 - 128 : b2;
        i += 1;
      }
      stitches.push({ x: cx, y: cy, type: 'stitch', color: THREAD_PALETTE[colorIdx] });
    } else {
      // Normal 7-bit stitch: both bytes < 0x80
      cx += b0 >= 64 ? b0 - 128 : b0;
      cy += b1 >= 64 ? b1 - 128 : b1;
      stitches.push({ x: cx, y: cy, type: 'stitch', color: THREAD_PALETTE[colorIdx] });
      i += 2;
    }
  }

  return stitches;
}

// ── JEF (Janome) ──────────────────────────────────────────────────────────────
// Header: dataOffset(int32LE@0), stitchCount(@4), ..., numColors(@24)
// Color table: numColors×4 bytes after header (116 bytes)
// Stitch stream:
//   Normal stitch : 2 bytes (int8 dx, int8 dy)
//   Jump          : 80 02 dx dy (4 bytes)
//   Color change  : 80 01 (2 bytes)
//   End           : 80 00 (2 bytes)

export function parseJEF(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 116) throw new Error('File too short to be JEF');

  const dataOffset = view.getInt32(0, true);
  const stitches = [];
  let cx = 0, cy = 0, colorIdx = 0;
  let i = dataOffset;

  while (i < buffer.byteLength - 1) {
    const b0 = view.getUint8(i);
    const b1 = view.getUint8(i + 1);

    if (b0 === 0x80) {
      if (b1 === 0x00) break; // end
      if (b1 === 0x01) {
        colorIdx = (colorIdx + 1) % THREAD_PALETTE.length;
        stitches.push({ x: cx, y: cy, type: 'color_change', color: THREAD_PALETTE[colorIdx] });
        i += 2;
        continue;
      }
      if (b1 === 0x02 && i + 3 < buffer.byteLength) {
        cx += view.getInt8(i + 2);
        cy += view.getInt8(i + 3);
        stitches.push({ x: cx, y: cy, type: 'jump', color: THREAD_PALETTE[colorIdx] });
        i += 4;
        continue;
      }
      // Unknown 0x80 command — skip 2 bytes
      i += 2;
      continue;
    }

    cx += view.getInt8(i);
    cy += view.getInt8(i + 1);
    stitches.push({ x: cx, y: cy, type: 'stitch', color: THREAD_PALETTE[colorIdx] });
    i += 2;
  }

  return stitches;
}

// ── EXP (Melco) ───────────────────────────────────────────────────────────────
// Stitch stream:
//   Normal stitch  : 2 bytes (signed dx, signed dy) — first byte ≠ 0x80
//   Jump           : 80 04 dx dy (4 bytes)
//   Color change   : 80 01 (2 bytes)
//   End            : 80 10 (2 bytes)
//   Large-delta    : 80 04 dx dy repeated (jump format for intermediates)

export function parseEXP(buffer) {
  const view = new DataView(buffer);
  const stitches = [];
  let cx = 0, cy = 0, colorIdx = 0;
  let i = 0;

  while (i < buffer.byteLength - 1) {
    const b0 = view.getUint8(i);

    if (b0 === 0x80) {
      const b1 = view.getUint8(i + 1);
      if (b1 === 0x10) break; // end
      if (b1 === 0x01) {
        colorIdx = (colorIdx + 1) % THREAD_PALETTE.length;
        stitches.push({ x: cx, y: cy, type: 'color_change', color: THREAD_PALETTE[colorIdx] });
        i += 2;
        continue;
      }
      if (b1 === 0x04 && i + 3 < buffer.byteLength) {
        cx += view.getInt8(i + 2);
        cy += view.getInt8(i + 3);
        stitches.push({ x: cx, y: cy, type: 'jump', color: THREAD_PALETTE[colorIdx] });
        i += 4;
        continue;
      }
      // Unknown 0x80 command — skip 2
      i += 2;
      continue;
    }

    cx += view.getInt8(i);
    cy += view.getInt8(i + 1);
    stitches.push({ x: cx, y: cy, type: 'stitch', color: THREAD_PALETTE[colorIdx] });
    i += 2;
  }

  return stitches;
}

// ── SVG stitch path reader ────────────────────────────────────────────────────

export function parseSVGStitches(svgText) {
  const stitches = [];
  const pathRe = /d="([^"]+)"/g;
  let match;
  while ((match = pathRe.exec(svgText)) !== null) {
    const d = match[1];
    const cmds = d.match(/[ML][^ML]*/g) || [];
    let isFirst = true;
    for (const cmd of cmds) {
      const nums = cmd.slice(1).trim().split(/[\s,]+/).map(Number);
      const x = nums[0] * 10, y = nums[1] * 10;
      stitches.push({ x, y, type: isFirst || cmd[0] === 'M' ? 'jump' : 'stitch', color: THREAD_PALETTE[0] });
      isFirst = false;
    }
  }
  return stitches;
}

export { THREAD_PALETTE };
