'use strict';

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { processImage, previewMask } = require('./src/imageProcessor');
const { generateStitches } = require('./src/stitchGenerator');
const { FORMATS, exportFormat, supportedFormats } = require('./src/formats/index');

const app = express();
const PORT = process.env.PORT || 3001;

const ACCEPTED_MIMES = [
  'image/png', 'image/jpeg', 'image/gif', 'image/bmp',
  'image/webp', 'image/tiff', 'image/svg+xml',
  'application/pdf', 'image/x-bmp',
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter(req, file, cb) {
    const ok = ACCEPTED_MIMES.includes(file.mimetype) ||
      /\.(png|jpg|jpeg|gif|bmp|webp|tiff?|svg|pdf)$/i.test(file.originalname);
    cb(ok ? null : new Error(`Unsupported file type: ${file.mimetype}`), ok);
  },
});

app.use(cors());
app.use(express.json({ limit: '20mb' }));

// ── GET /health ────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'digitizer', version: '1.0.0', timestamp: new Date().toISOString() });
});

// ── GET /formats ───────────────────────────────────────────────────────────────
app.get('/formats', (req, res) => {
  const formats = supportedFormats.map(key => ({
    id: key,
    name: key.toUpperCase(),
    mime: FORMATS[key].mime,
    ext: FORMATS[key].ext,
    binary: FORMATS[key].binary,
  }));
  const inputFormats = ['PNG', 'JPG', 'SVG', 'GIF', 'BMP', 'WEBP', 'TIFF', 'PDF'];
  res.json({ inputFormats, outputFormats: formats });
});

function imageOptions(body) {
  return {
    targetWidthMm: parseFloat(body.widthMm) || 100,
    targetHeightMm: parseFloat(body.heightMm) || 100,
    stitchesPerMm: parseFloat(body.stitchesPerMm) || 4,
    whiteThreshold: parseInt(body.whiteThreshold || body.threshold, 10) || 128,
  };
}

// ── POST /mask ────────────────────────────────────────────────────────────────
app.post('/mask', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided. Use field name "image".' });

    const { png, width, height, stats } = await previewMask(req.file.buffer, imageOptions(req.body));
    res.json({
      success: true,
      width,
      height,
      stats,
      foregroundPixels: stats.filledPixels,
      contourCount: stats.contourCount,
      rejectionReason: stats.rejectionReason,
      maskPng: `data:image/png;base64,${png.toString('base64')}`,
      warning: stats.likelyRectangle
        ? 'Detected artwork mask still looks rectangular and touches image edges. The background may not be separable from the artwork.'
        : stats.contourCount === 0
          ? stats.rejectionReason || 'No contours were detected from the foreground mask.'
        : null,
    });
  } catch (err) {
    console.error('Mask preview error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /digitize ─────────────────────────────────────────────────────────────
app.post('/digitize', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided. Use field name "image".' });

    const opts = imageOptions(req.body);

    const stitchOpts = {
      stitchLengthMm: parseFloat(req.body.stitchLengthMm) || 3.0,
      fillSpacingMm: parseFloat(req.body.fillSpacingMm) || 0.5,
      underlaySpacingMm: parseFloat(req.body.underlaySpacingMm) || 2.0,
      satinWidthMm: parseFloat(req.body.satinWidthMm) || 1.8,
      stitchAngleDeg: parseFloat(req.body.stitchAngleDeg) || 35,
    };

    const { bitmap, width, height, pixelsPerMm, maskStats } = await processImage(req.file.buffer, opts);
    if (maskStats.likelyRectangle) {
      return res.status(422).json({
        error: 'Detected artwork mask still looks like a rectangle. The image background/canvas is being selected as foreground, so stitch generation was stopped.',
        maskStats,
      });
    }
    if (maskStats.filledPixels === 0) {
      return res.status(422).json({
        error: maskStats.rejectionReason || 'No foreground artwork detected after removing transparent, black, white, and near-background pixels.',
        maskStats,
      });
    }

    const digitized = generateStitches(bitmap, width, height, pixelsPerMm, stitchOpts);
    const stitches = Array.isArray(digitized) ? digitized : digitized.stitches;
    const debugStitches = Array.isArray(digitized) ? [] : digitized.debugStitches;
    const regions = Array.isArray(digitized) ? [] : digitized.regions;
    if (regions.length === 0) {
      return res.status(422).json({
        error: maskStats.rejectionReason || `Foreground pixels were detected (${maskStats.filledPixels}) but no contours/regions could be extracted.`,
        maskStats,
      });
    }

    const stitchCount = stitches.filter(s => s.type === 'stitch').length;
    const jumpCount = stitches.filter(s => s.type === 'jump').length;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of stitches) {
      if (s.type === 'end') continue;
      minX = Math.min(minX, s.x); minY = Math.min(minY, s.y);
      maxX = Math.max(maxX, s.x); maxY = Math.max(maxY, s.y);
    }

    res.json({
      success: true,
      id: uuidv4(),
      stitches,
      debugStitches,
      regions,
      stitchCount,
      jumpCount,
      bounds: { minX, minY, maxX, maxY },
      dimensions: {
        widthMm: (maxX - minX) / 10,
        heightMm: (maxY - minY) / 10,
        widthUnits: maxX - minX,
        heightUnits: maxY - minY,
      },
      colors: req.body.colors ? JSON.parse(req.body.colors) : ['#000000'],
      imageInfo: { width, height, pixelsPerMm, maskStats },
    });
  } catch (err) {
    console.error('Digitize error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /export/:format ────────────────────────────────────────────────────────
app.post('/export/:format', async (req, res) => {
  try {
    const format = req.params.format.toLowerCase();
    if (!supportedFormats.includes(format)) {
      return res.status(400).json({ error: `Unsupported format "${format}". Supported: ${supportedFormats.join(', ')}` });
    }

    const { stitches, colors = ['#000000'], name = 'design', widthMm, heightMm } = req.body;
    if (!Array.isArray(stitches) || stitches.length === 0) {
      return res.status(400).json({ error: 'Request body must include a non-empty "stitches" array.' });
    }

    const { buffer, mime, ext } = await exportFormat(format, stitches, { name, colors, widthMm, heightMm });

    const filename = `${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.${ext}`;
    res.set('Content-Type', mime);
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.set('Content-Length', buffer.length);
    res.send(buffer);
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Error handler ───────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 50MB)' });
  res.status(400).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`Digitizer service running on port ${PORT}`);
});

module.exports = app;
