'use strict';

const PDFDocument = require('pdfkit');
const sharp = require('sharp');

// Build a tight SVG of the stitch paths (white background, colored lines)
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
  let cur = [];
  let colorIdx = 0;

  for (const s of stitches) {
    if (s.type === 'end') {
      if (cur.length > 1) flush();
      break;
    }
    if (s.type === 'color_change') {
      if (cur.length > 1) flush();
      cur = [];
      colorIdx = (colorIdx + 1) % Math.max(1, colors.length);
    } else if (s.type === 'jump' || s.type === 'trim') {
      if (cur.length > 1) flush();
      cur = [s];
    } else {
      cur.push(s);
    }
  }
  if (cur.length > 1) flush();

  function flush() {
    const color = colors[colorIdx] || '#6d28d9';
    const d = cur.map((p, i) => {
      const x = ((p.x - minX) * scale + pad).toFixed(1);
      const y = ((p.y - minY) * scale + pad).toFixed(1);
      return i === 0 ? `M${x},${y}` : `L${x},${y}`;
    }).join(' ');
    paths.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="0.7" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>`);
  }

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vw.toFixed(1)} ${vh.toFixed(1)}" width="${vw.toFixed(1)}" height="${vh.toFixed(1)}">`,
    `<rect width="100%" height="100%" fill="#f8f8fc" rx="4"/>`,
    ...paths,
    `</svg>`,
  ].join('');

  return { svgStr: svg, svgW: vw, svgH: vh };
}

// Parse hex color to [r, g, b] 0-255
function hexToRgb(hex) {
  const c = hex.replace('#', '');
  if (c.length === 3) {
    return [parseInt(c[0] + c[0], 16), parseInt(c[1] + c[1], 16), parseInt(c[2] + c[2], 16)];
  }
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}

// Luminance of a hex color (0-1)
function hexLum(hex) {
  const [r, g, b] = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

async function encode(stitches, options = {}) {
  const {
    name = 'design',
    colors = ['#6d28d9'],
    widthMm,
    heightMm,
  } = options;

  const stitchCount = stitches.filter(s => s.type === 'stitch').length;
  const jumpCount   = stitches.filter(s => s.type === 'jump').length;
  const colorChanges = stitches.filter(s => s.type === 'color_change').length;
  const threadCount = colorChanges + 1;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of stitches) {
    if (s.type === 'end') continue;
    if (s.x < minX) minX = s.x; if (s.y < minY) minY = s.y;
    if (s.x > maxX) maxX = s.x; if (s.y > maxY) maxY = s.y;
  }
  const dimW = isFinite(minX) ? ((maxX - minX) / 10).toFixed(1) : (widthMm || 0).toFixed(1);
  const dimH = isFinite(minY) ? ((maxY - minY) / 10).toFixed(1) : (heightMm || 0).toFixed(1);

  // Rasterize SVG preview to PNG via sharp
  const { svgStr, svgW, svgH } = buildSvgBuffer(stitches, colors);
  const previewSize = 340;
  const pngBuf = await sharp(Buffer.from(svgStr))
    .resize(previewSize, Math.round(previewSize * (svgH / Math.max(1, svgW))), { fit: 'contain', background: { r: 248, g: 248, b: 252, alpha: 1 } })
    .png()
    .toBuffer();

  // Build PDF
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: name, Creator: 'Wavstat Digitizer' } });

    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const PAGE_W = doc.page.width;   // 595.28
    const PAGE_H = doc.page.height;  // 841.89
    const M = 48;

    // ── Header bar ─────────────────────────────────────────────────────────────
    doc.rect(0, 0, PAGE_W, 72).fill('#0b0b1c');

    // Logo mark
    const logoGrad = doc.linearGradient(M, 16, M + 40, 56);
    logoGrad.stop(0, '#7c3aed').stop(1, '#06b6d4');
    doc.roundedRect(M, 16, 40, 40, 7).fill(logoGrad);
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#ffffff')
       .text('W', M, 28, { width: 40, align: 'center' });

    // Title
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
      doc.font('Helvetica').fontSize(8).fillColor('#6b6b90')
         .text(label, x + 10, statsY + 10, { width: cellW - 20 });
      doc.font('Helvetica-Bold').fontSize(18).fillColor('#22d3ee')
         .text(value, x + 10, statsY + 23, { width: cellW - 20 });
    });

    // ── Stitch preview ─────────────────────────────────────────────────────────
    const previewY = statsY + 72;
    const previewH = Math.round(previewSize * (svgH / Math.max(1, svgW)));
    const previewX = M;

    doc.roundedRect(previewX, previewY, PAGE_W - M * 2, previewH + 24, 8).fill('#0f0f24');
    doc.font('Helvetica').fontSize(9).fillColor('#6b6b90')
       .text('STITCH PREVIEW', previewX + 14, previewY + 10);
    doc.image(pngBuf, previewX + 12, previewY + 24, { width: PAGE_W - M * 2 - 24 });

    // ── Thread colors ──────────────────────────────────────────────────────────
    const threadsY = previewY + previewH + 40;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#9ca3af')
       .text('THREADS', M, threadsY);

    const swatchSize = 14;
    const swatchGap = 8;
    const colsPerRow = Math.floor((PAGE_W - M * 2) / (swatchSize + swatchGap + 80));
    const uniqueColors = [...new Set(colors)];

    uniqueColors.forEach((hex, i) => {
      const col = i % colsPerRow;
      const row = Math.floor(i / colsPerRow);
      const x = M + col * ((PAGE_W - M * 2) / colsPerRow);
      const y = threadsY + 18 + row * (swatchSize + 10);
      const [r, g, b] = hexToRgb(hex);
      doc.roundedRect(x, y, swatchSize, swatchSize, 3).fill([r, g, b]);
      doc.font('Helvetica').fontSize(9)
         .fillColor(hexLum(hex) < 0.35 ? '#22d3ee' : '#374151')
         .text(`Thread ${i + 1}`, x + swatchSize + 7, y + 2);
      doc.font('Helvetica').fontSize(8).fillColor('#6b6b90')
         .text(hex.toUpperCase(), x + swatchSize + 7 + 54, y + 2);
    });

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
