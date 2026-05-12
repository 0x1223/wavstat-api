'use strict';

const PDFDocument = require('pdfkit');
const sharp = require('sharp');

// Resolve a color entry to { hex, name, code, stitchCount }
function resolveColor(c, idx) {
  if (typeof c === 'string') return { hex: c, name: `Thread ${idx + 1}`, code: '—', stitchCount: null };
  return {
    hex: c.hex || '#6d28d9',
    name: c.name || `Thread ${idx + 1}`,
    code: c.code || '—',
    stitchCount: c.stitchCount ?? null,
  };
}

function hexToRgb(hex) {
  const c = (hex || '#000000').replace('#', '');
  if (c.length === 3) return [parseInt(c[0] + c[0], 16), parseInt(c[1] + c[1], 16), parseInt(c[2] + c[2], 16)];
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}

function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function buildSvgBuffer(stitches, colors) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of stitches) {
    if (s.type === 'end') continue;
    if (s.x < minX) minX = s.x; if (s.y < minY) minY = s.y;
    if (s.x > maxX) maxX = s.x; if (s.y > maxY) maxY = s.y;
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 1000; maxY = 1000; }

  const scale = 0.15;
  const pad = 24;
  const vw = (maxX - minX) * scale + pad * 2;
  const vh = (maxY - minY) * scale + pad * 2;

  const paths = [];
  let cur = [], colorIdx = 0;

  for (const s of stitches) {
    if (s.type === 'end') { if (cur.length > 1) flush(); break; }
    if (s.type === 'color_change') {
      if (cur.length > 1) flush();
      cur = [];
      colorIdx = Math.min(colorIdx + 1, Math.max(0, colors.length - 1));
    } else if (s.type === 'jump' || s.type === 'trim') {
      if (cur.length > 1) flush();
      cur = [s];
    } else {
      cur.push(s);
    }
  }
  if (cur.length > 1) flush();

  function flush() {
    const resolved = resolveColor(colors[colorIdx], colorIdx);
    const d = cur.map((p, i) => {
      const x = ((p.x - minX) * scale + pad).toFixed(1);
      const y = ((p.y - minY) * scale + pad).toFixed(1);
      return i === 0 ? `M${x},${y}` : `L${x},${y}`;
    }).join(' ');
    paths.push(`<path d="${d}" fill="none" stroke="${resolved.hex}" stroke-width="0.7" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`);
  }

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vw.toFixed(1)} ${vh.toFixed(1)}" width="${vw.toFixed(1)}" height="${vh.toFixed(1)}">`,
    `<rect width="100%" height="100%" fill="#0b0b1c" rx="4"/>`,
    ...paths,
    `</svg>`,
  ].join('');

  return { svgStr: svg, svgW: vw, svgH: vh };
}

async function encode(stitches, options = {}) {
  const { name = 'design', colors = ['#6d28d9'], widthMm, heightMm } = options;

  const stitchCount  = stitches.filter(s => s.type === 'stitch').length;
  const jumpCount    = stitches.filter(s => s.type === 'jump').length;
  const threadCount  = stitches.filter(s => s.type === 'color_change').length + 1;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of stitches) {
    if (s.type === 'end') continue;
    if (s.x < minX) minX = s.x; if (s.y < minY) minY = s.y;
    if (s.x > maxX) maxX = s.x; if (s.y > maxY) maxY = s.y;
  }
  const dimW = isFinite(minX) ? ((maxX - minX) / 10).toFixed(1) : (widthMm || 0).toFixed(1);
  const dimH = isFinite(minY) ? ((maxY - minY) / 10).toFixed(1) : (heightMm || 0).toFixed(1);

  const resolvedColors = colors.map((c, i) => resolveColor(c, i));

  // Rasterize stitch preview (dark background with thread colors)
  const { svgStr, svgW, svgH } = buildSvgBuffer(stitches, colors);
  const previewW = 340;
  const previewH = Math.max(80, Math.round(previewW * (svgH / Math.max(1, svgW))));
  const pngBuf = await sharp(Buffer.from(svgStr))
    .resize(previewW, previewH, { fit: 'contain', background: { r: 11, g: 11, b: 28, alpha: 1 } })
    .png()
    .toBuffer();

  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: name, Creator: 'Wavstat Digitizer' } });
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const PAGE_W = doc.page.width;   // 595.28
    const PAGE_H = doc.page.height;  // 841.89
    const M = 48;

    // ── Header ─────────────────────────────────────────────────────────────────
    doc.rect(0, 0, PAGE_W, 72).fill('#0b0b1c');
    const logoGrad = doc.linearGradient(M, 16, M + 40, 56);
    logoGrad.stop(0, '#7c3aed').stop(1, '#06b6d4');
    doc.roundedRect(M, 16, 40, 40, 7).fill(logoGrad);
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#ffffff').text('W', M, 28, { width: 40, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(17).fillColor('#e4e4f2')
       .text(name.replace(/_/g, ' '), M + 52, 22, { width: PAGE_W - M * 2 - 52 });
    doc.font('Helvetica').fontSize(10).fillColor('#6b6b90')
       .text('Embroidery Design Spec Sheet · Wavstat Digitizer', M + 52, 42, { width: PAGE_W - M * 2 - 52 });

    // ── Stats row ──────────────────────────────────────────────────────────────
    const statsY = 88;
    const statItems = [
      ['STITCHES', stitchCount.toLocaleString()],
      ['JUMPS',    jumpCount.toLocaleString()],
      ['THREADS',  threadCount.toString()],
      ['WIDTH',    `${dimW} mm`],
      ['HEIGHT',   `${dimH} mm`],
    ];
    const cellW = (PAGE_W - M * 2) / statItems.length;

    statItems.forEach(([label, value], i) => {
      const x = M + i * cellW;
      doc.roundedRect(x, statsY, cellW - 6, 58, 6).fill('#0f0f24');
      doc.font('Helvetica').fontSize(8).fillColor('#6b6b90').text(label, x + 10, statsY + 10, { width: cellW - 20 });
      doc.font('Helvetica-Bold').fontSize(18).fillColor('#22d3ee').text(value, x + 10, statsY + 23, { width: cellW - 20 });
    });

    // ── Stitch preview ─────────────────────────────────────────────────────────
    const previewY = statsY + 72;
    doc.roundedRect(M, previewY, PAGE_W - M * 2, previewH + 24, 8).fill('#0f0f24');
    doc.font('Helvetica').fontSize(9).fillColor('#6b6b90').text('STITCH PREVIEW', M + 14, previewY + 10);
    doc.image(pngBuf, M + 12, previewY + 24, { width: PAGE_W - M * 2 - 24 });

    // ── Thread color table ──────────────────────────────────────────────────────
    const tableY = previewY + previewH + 40;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#9ca3af').text('THREAD COLORS', M, tableY);

    const tableTop  = tableY + 18;
    const ROW_H     = 28;
    const SWATCH    = 16;
    const COL_NUM   = M;
    const COL_SWATCH = M + 28;
    const COL_NAME  = M + 56;
    const COL_CODE  = M + 200;
    const COL_COUNT = M + 310;
    const tableW    = PAGE_W - M * 2;

    // Table header
    doc.rect(M, tableTop, tableW, 20).fill('#0f0f24');
    const hdrColor = '#6b6b90';
    [
      [COL_NUM,   '#'],
      [COL_NAME,  'Color Name'],
      [COL_CODE,  'Madeira Classic'],
      [COL_COUNT, 'Stitches'],
    ].forEach(([x, lbl]) => {
      doc.font('Helvetica').fontSize(8).fillColor(hdrColor).text(lbl, x, tableTop + 6, { lineBreak: false });
    });

    resolvedColors.forEach((color, i) => {
      const rowY = tableTop + 20 + i * ROW_H;
      doc.rect(M, rowY, tableW, ROW_H).fill(i % 2 === 0 ? '#0a0a1e' : '#0d0d22');

      // Color number
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#e4e4f2')
         .text(`${i + 1}`, COL_NUM, rowY + 9, { width: 20, align: 'center' });

      // Swatch
      const [sr, sg, sb] = hexToRgb(color.hex);
      doc.roundedRect(COL_SWATCH, rowY + 6, SWATCH, SWATCH, 3).fill([sr, sg, sb]);
      // White border on dark swatches for visibility
      if (relativeLuminance(color.hex) < 0.15) {
        doc.roundedRect(COL_SWATCH, rowY + 6, SWATCH, SWATCH, 3).stroke('#3d3d5c');
      }

      // Thread name
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#e4e4f2')
         .text(color.name, COL_NAME, rowY + 9, { width: 135, lineBreak: false });

      // Madeira code
      doc.font('Helvetica').fontSize(9).fillColor('#22d3ee')
         .text(`Madeira ${color.code}`, COL_CODE, rowY + 10, { width: 100, lineBreak: false });

      // Stitch count
      const countStr = color.stitchCount != null ? color.stitchCount.toLocaleString() : '—';
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#a78bfa')
         .text(countStr, COL_COUNT, rowY + 9, { width: PAGE_W - M - COL_COUNT, align: 'right', lineBreak: false });
    });

    // Table bottom border
    const tableBottom = tableTop + 20 + resolvedColors.length * ROW_H;
    doc.rect(M, tableBottom, tableW, 1).fill('#1e1e3c');

    // ── Footer ─────────────────────────────────────────────────────────────────
    doc.rect(0, PAGE_H - 36, PAGE_W, 36).fill('#0b0b1c');
    doc.font('Helvetica').fontSize(8).fillColor('#3d3d5c')
       .text(`Generated by Wavstat  ·  ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, M, PAGE_H - 22);
    doc.font('Helvetica').fontSize(8).fillColor('#3d3d5c')
       .text('wavstat.app', 0, PAGE_H - 22, { width: PAGE_W - M, align: 'right' });

    doc.end();
  });
}

module.exports = { encode };
