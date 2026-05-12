'use strict';
const sharp = require('sharp');

function luminance(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function saturation(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

function colorDistance(a, b) {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function isGoldPixel(r, g, b) {
  const lum = luminance(r, g, b);
  const sat = saturation(r, g, b);
  return r >= 120 && g >= 75 && b <= 95 && r > b * 1.35 && g > b * 1.15 && lum >= 70 && sat >= 0.24;
}

function isWarmRedPixel(r, g, b) {
  const sat = saturation(r, g, b);
  return r >= 120 && g <= 105 && b <= 105 && r > g * 1.15 && r > b * 1.2 && sat >= 0.22;
}

async function rasterize(buffer, options = {}) {
  const {
    targetWidthMm = 100,
    targetHeightMm = 100,
    stitchesPerMm = 4,
  } = options;

  let pipeline = sharp(buffer);
  const meta = await pipeline.metadata();
  if (meta.format === 'pdf') pipeline = sharp(buffer, { density: 150, page: 0 });

  return pipeline
    .resize(Math.round(targetWidthMm * stitchesPerMm), Math.round(targetHeightMm * stitchesPerMm), {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .ensureAlpha()
    .toColorspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
}

function sampleBackgroundColors(data, width, height, channels) {
  const samples = [];
  const seen = new Set();
  const step = Math.max(1, Math.floor(Math.min(width, height) / 32));

  function add(x, y) {
    const i = (y * width + x) * channels;
    const a = data[i + 3] ?? 255;
    if (a < 24) return;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const key = `${Math.round(r / 12)},${Math.round(g / 12)},${Math.round(b / 12)}`;
    if (!seen.has(key)) {
      seen.add(key);
      samples.push({ r, g, b });
    }
  }

  for (let x = 0; x < width; x += step) {
    add(x, 0); add(x, height - 1);
  }
  for (let y = 0; y < height; y += step) {
    add(0, y); add(width - 1, y);
  }

  const corners = [
    [0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1],
    [Math.floor(width / 2), 0], [Math.floor(width / 2), height - 1],
    [0, Math.floor(height / 2)], [width - 1, Math.floor(height / 2)],
  ];
  for (const [x, y] of corners) add(x, y);

  return samples;
}

function closeMask(mask, width, height) {
  const dilated = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let hit = false;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1) && !hit; yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
          if (mask[yy * width + xx]) { hit = true; break; }
        }
      }
      dilated[y * width + x] = hit ? 1 : 0;
    }
  }

  const eroded = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let keep = true;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1) && keep; yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
          if (!dilated[yy * width + xx]) { keep = false; break; }
        }
      }
      eroded[y * width + x] = keep ? 1 : 0;
    }
  }
  return eroded;
}

function removeBorderConnected(mask, width, height) {
  const out = new Uint8Array(mask);
  const seen = new Uint8Array(mask.length);
  const q = [];

  function push(x, y) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = y * width + x;
    if (seen[i] || out[i] !== 1) return;
    seen[i] = 1;
    q.push([x, y]);
  }

  for (let x = 0; x < width; x++) { push(x, 0); push(x, height - 1); }
  for (let y = 0; y < height; y++) { push(0, y); push(width - 1, y); }

  for (let head = 0; head < q.length; head++) {
    const [x, y] = q[head];
    out[y * width + x] = 0;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }

  return out;
}

function largestComponents(mask, width, height, minAreaPx) {
  const seen = new Uint8Array(mask.length);
  const comps = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x;
      if (seen[start] || mask[start] !== 1) continue;
      const q = [[x, y]];
      const indices = [];
      seen[start] = 1;
      let minX = x, maxX = x, minY = y, maxY = y;

      for (let head = 0; head < q.length; head++) {
        const [px, py] = q[head];
        const idx = py * width + px;
        indices.push(idx);
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
        for (const [nx, ny] of [[px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]]) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = ny * width + nx;
          if (!seen[ni] && mask[ni] === 1) {
            seen[ni] = 1;
            q.push([nx, ny]);
          }
        }
      }

      if (indices.length >= minAreaPx) comps.push({ indices, bounds: { minX, minY, maxX, maxY }, area: indices.length });
    }
  }

  comps.sort((a, b) => b.area - a.area);
  const keep = new Uint8Array(mask.length);
  for (const comp of comps.slice(0, 12)) {
    for (const idx of comp.indices) keep[idx] = 1;
  }
  return { mask: keep, components: comps.slice(0, 12) };
}

function buildRawForegroundMask(data, width, height, channels, backgrounds, options) {
  const {
    alphaThreshold = 24,
    whiteThreshold = 246,
    blackThreshold = 18,
    backgroundDistance = 42,
    minSaturation = 0.06,
  } = options;

  const mask = new Uint8Array(width * height);
  const goldFallback = new Uint8Array(width * height);
  let rejectedTransparent = 0;
  let rejectedWhite = 0;
  let rejectedBlack = 0;
  let rejectedNearBackground = 0;
  let acceptedGoldFallback = 0;

  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    const r = data[o], g = data[o + 1], b = data[o + 2], a = data[o + 3] ?? 255;
    const lum = luminance(r, g, b);
    const sat = saturation(r, g, b);
    const nearBackground = backgrounds.some(bg => colorDistance({ r, g, b }, bg) <= backgroundDistance);
    const nearWhite = lum >= whiteThreshold;
    const nearBlack = lum <= blackThreshold;
    const lowInfoNeutral = sat < minSaturation && (nearWhite || nearBlack || nearBackground);
    const transparent = a < alphaThreshold;
    const gold = isGoldPixel(r, g, b) || isWarmRedPixel(r, g, b);

    if (transparent) rejectedTransparent++;
    else if (nearWhite) rejectedWhite++;
    else if (nearBlack) rejectedBlack++;
    else if (nearBackground && !gold) rejectedNearBackground++;

    if (!transparent && gold && !nearWhite && !nearBlack) {
      goldFallback[i] = 1;
      acceptedGoldFallback++;
    }

    mask[i] = !transparent && !nearWhite && !nearBlack && !nearBackground && !lowInfoNeutral ? 1 : 0;
  }

  return {
    mask,
    goldFallback,
    diagnostics: {
      rawForegroundPixels: countMask(mask),
      goldFallbackPixels: acceptedGoldFallback,
      rejectedTransparent,
      rejectedWhite,
      rejectedBlack,
      rejectedNearBackground,
    },
  };
}

function countMask(mask) {
  let count = 0;
  for (const v of mask) if (v) count++;
  return count;
}

function mergeMasks(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] || b[i] ? 1 : 0;
  return out;
}

function buildForegroundMask(data, width, height, channels, options = {}) {
  const {
    minComponentAreaPx = Math.max(16, Math.round(width * height * 0.00018)),
  } = options;

  const backgrounds = sampleBackgroundColors(data, width, height, channels);
  const raw = buildRawForegroundMask(data, width, height, channels, backgrounds, options);
  let mask = closeMask(raw.mask, width, height);

  let result = largestComponents(mask, width, height, minComponentAreaPx);
  let fallbackUsed = false;
  let rejectionReason = null;

  if (result.components.length === 0 && raw.diagnostics.goldFallbackPixels > 0) {
    fallbackUsed = true;
    mask = closeMask(raw.goldFallback, width, height);
    result = largestComponents(mask, width, height, minComponentAreaPx);
  }

  if (result.components.length === 0) {
    if (raw.diagnostics.rawForegroundPixels === 0 && raw.diagnostics.goldFallbackPixels === 0) {
      rejectionReason = 'All pixels were classified as transparent, white, black, or sampled near-background. No foreground artwork survived segmentation.';
    } else if (raw.diagnostics.rawForegroundPixels > 0) {
      rejectionReason = `Foreground pixels were detected (${raw.diagnostics.rawForegroundPixels}) but all connected components were below the minimum area threshold (${minComponentAreaPx}px).`;
    } else {
      rejectionReason = 'Gold-on-black fallback found candidate pixels, but no connected component survived cleanup.';
    }
  }

  mask = result.mask;

  const stats = maskStats(mask, width, height, result.components, backgrounds, {
    ...raw.diagnostics,
    contourCount: result.components.length,
    fallbackUsed,
    rejectionReason,
    minComponentAreaPx,
  });
  return { bitmap: mask, stats };
}

function maskStats(mask, width, height, components = [], backgrounds = [], diagnostics = {}) {
  let filled = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      filled++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }

  const hasMask = filled > 0;
  const bounds = hasMask ? { minX, minY, maxX, maxY } : null;
  const boundsArea = hasMask ? (maxX - minX + 1) * (maxY - minY + 1) : 0;
  const coverage = filled / (width * height);
  const boundsCoverage = boundsArea ? filled / boundsArea : 0;
  const touchesEdges = hasMask && (minX <= 1 || minY <= 1 || maxX >= width - 2 || maxY >= height - 2);
  const likelyRectangle = hasMask && boundsCoverage > 0.92 && coverage > 0.42 && touchesEdges;

  return {
    filledPixels: filled,
    totalPixels: width * height,
    coverage,
    bounds,
    boundsCoverage,
    touchesEdges,
    likelyRectangle,
    componentCount: components.length,
    contourCount: components.length,
    rejectionReason: diagnostics.rejectionReason || null,
    rawForegroundPixels: diagnostics.rawForegroundPixels || 0,
    goldFallbackPixels: diagnostics.goldFallbackPixels || 0,
    fallbackUsed: !!diagnostics.fallbackUsed,
    rejected: {
      transparent: diagnostics.rejectedTransparent || 0,
      white: diagnostics.rejectedWhite || 0,
      black: diagnostics.rejectedBlack || 0,
      nearBackground: diagnostics.rejectedNearBackground || 0,
    },
    minComponentAreaPx: diagnostics.minComponentAreaPx || 0,
    components: components.map(c => ({ area: c.area, bounds: c.bounds })).slice(0, 8),
    sampledBackgrounds: backgrounds.slice(0, 8),
  };
}

async function renderMaskPreview(data, width, height, channels, bitmap) {
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    const oo = i * 4;
    const r = data[o], g = data[o + 1], b = data[o + 2], a = data[o + 3] ?? 255;
    if (bitmap[i]) {
      out[oo] = 6; out[oo + 1] = 182; out[oo + 2] = 212; out[oo + 3] = 220;
    } else {
      out[oo] = Math.round(r * 0.22);
      out[oo + 1] = Math.round(g * 0.22);
      out[oo + 2] = Math.round(b * 0.22);
      out[oo + 3] = Math.min(180, a);
    }
  }

  return sharp(out, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

async function processImage(buffer, options = {}) {
  const { targetWidthMm = 100, targetHeightMm = 100, stitchesPerMm = 4 } = options;
  const { data, info } = await rasterize(buffer, { targetWidthMm, targetHeightMm, stitchesPerMm });
  const { width, height, channels } = info;
  const { bitmap, stats } = buildForegroundMask(data, width, height, channels, options);
  return { bitmap, width, height, pixelsPerMm: stitchesPerMm, maskStats: stats };
}

async function previewMask(buffer, options = {}) {
  const { targetWidthMm = 100, targetHeightMm = 100, stitchesPerMm = 4 } = options;
  const { data, info } = await rasterize(buffer, { targetWidthMm, targetHeightMm, stitchesPerMm });
  const { width, height, channels } = info;
  const { bitmap, stats } = buildForegroundMask(data, width, height, channels, options);
  const png = await renderMaskPreview(data, width, height, channels, bitmap);
  return { png, width, height, stats };
}

module.exports = { processImage, previewMask, buildForegroundMask, maskStats };
