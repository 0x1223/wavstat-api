'use strict';

const MADEIRA_CLASSIC = [
  { code: '1001', name: 'White',         r: 255, g: 255, b: 255 },
  { code: '1000', name: 'Black',         r:  20, g:  20, b:  20 },
  { code: '1070', name: 'Bright Gold',   r: 255, g: 210, b:   0 },
  { code: '1072', name: 'Gold',          r: 218, g: 165, b:  32 },
  { code: '1073', name: 'Dark Gold',     r: 171, g: 119, b:   0 },
  { code: '1074', name: 'Antique Gold',  r: 196, g: 146, b:  12 },
  { code: '1075', name: 'Old Gold',      r: 179, g: 144, b:  40 },
  { code: '1080', name: 'Yellow',        r: 255, g: 242, b:   0 },
  { code: '1082', name: 'Orange',        r: 246, g: 152, b:   0 },
  { code: '1090', name: 'Dark Orange',   r: 196, g:  98, b:  16 },
  { code: '0304', name: 'Red',           r: 204, g:  36, b:  52 },
  { code: '0302', name: 'Crimson',       r: 172, g:  18, b:  24 },
  { code: '0408', name: 'Brown',         r: 148, g:  78, b:  40 },
  { code: '0410', name: 'Dark Brown',    r:  96, g:  56, b:  28 },
  { code: '0211', name: 'Royal Blue',    r:  56, g:  96, b: 200 },
  { code: '0220', name: 'Navy',          r:  16, g:  24, b: 100 },
  { code: '1112', name: 'Sky Blue',      r: 130, g: 196, b: 232 },
  { code: '0901', name: 'Teal',          r:   0, g: 116, b: 116 },
  { code: '0111', name: 'Forest Green',  r:  40, g: 120, b:  48 },
  { code: '1060', name: 'Lime',          r:  88, g: 196, b:  56 },
  { code: '0600', name: 'Purple',        r: 116, g:  20, b: 116 },
  { code: '1400', name: 'Light Pink',    r: 248, g: 168, b: 176 },
  { code: '1210', name: 'Copper',        r: 176, g: 100, b:  44 },
  { code: '1830', name: 'Silver',        r: 188, g: 188, b: 188 },
  { code: '1833', name: 'Light Grey',    r: 212, g: 212, b: 212 },
  { code: '1836', name: 'Dark Grey',     r: 100, g: 100, b: 100 },
  { code: '1430', name: 'Cream',         r: 252, g: 248, b: 200 },
];

function nearestMadeira(r, g, b) {
  let best = MADEIRA_CLASSIC[0], bestD = Infinity;
  for (const t of MADEIRA_CLASSIC) {
    const d = (r - t.r) ** 2 + (g - t.g) ** 2 + (b - t.b) ** 2;
    if (d < bestD) { bestD = d; best = t; }
  }
  return {
    code: best.code,
    name: best.name,
    r: best.r,
    g: best.g,
    b: best.b,
    hex: `#${[best.r, best.g, best.b].map(v => v.toString(16).padStart(2, '0')).join('')}`,
  };
}

module.exports = { MADEIRA_CLASSIC, nearestMadeira };
