const THREAD_PALETTE = [
  '#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7',
  '#ec4899', '#14b8a6', '#f97316', '#84cc16', '#0ea5e9',
  '#e879f9', '#fb923c', '#34d399', '#60a5fa', '#fbbf24',
];

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
  let cx = 0, cy = 0;
  let colorIdx = 0;
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

    const isColorChange = (b2 & 0xC0) === 0xC0 && b2 !== 0xF3;
    const isJump = (b2 & 0x83) === 0x83 && !isColorChange;

    if (isColorChange) {
      colorIdx = (colorIdx + 1) % THREAD_PALETTE.length;
      stitches.push({ x: cx, y: cy, type: 'color_change', color: THREAD_PALETTE[colorIdx] });
    } else {
      stitches.push({ x: cx, y: cy, type: isJump ? 'jump' : 'stitch', color: THREAD_PALETTE[colorIdx] });
    }
  }

  return stitches;
}

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
