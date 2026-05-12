export function parseDST(buffer) {
  const view = new DataView(buffer);
  const stitches = [];
  let cx = 0, cy = 0;
  let offset = 512; // skip header

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

    stitches.push({
      x: cx, y: cy,
      type: isColorChange ? 'color_change' : isJump ? 'jump' : 'stitch',
    });
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
    let first = true;
    for (const cmd of cmds) {
      const type = cmd[0];
      const nums = cmd.slice(1).trim().split(/[\s,]+/).map(Number);
      const x = nums[0] * 10, y = nums[1] * 10; // approximate to 0.1mm
      stitches.push({ x, y, type: first || type === 'M' ? 'jump' : 'stitch' });
      first = false;
    }
  }
  return stitches;
}
