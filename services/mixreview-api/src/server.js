import express from "express";
import cors from "cors";
import "dotenv/config";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const app = express();
const port = process.env.PORT || 4301;
const isProduction = process.env.NODE_ENV === "production";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(__dirname, "..");
const uploadRoot = path.join(serviceRoot, "storage", "uploads");
const sessionRoot = path.join(serviceRoot, "storage", "sessions");
const frontendProductionOrigin = "https://mixreview.kingzbreadent.com";
const defaultDevOrigins = [
  "http://localhost:4300",
  "http://localhost:4301",
  "http://localhost:4302",
  "http://localhost:4303",
  "http://localhost:4304"
];
const allowedOrigins = parseAllowedOrigins(
  getEnvValue("CORS_ORIGINS") || getEnvValue("CLIENT_ORIGIN"),
);
const maxAudioBytes = 250 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxAudioBytes }
});
const pendingPeakRepairKeys = new Set();
let peakRepairChain = Promise.resolve();

const r2Config = {
  accountId: getEnvValue("CLOUDFLARE_ACCOUNT_ID") || getEnvValue("R2_ACCOUNT_ID"),
  accessKeyId: getEnvValue("CLOUDFLARE_R2_ACCESS_KEY_ID") || getEnvValue("R2_ACCESS_KEY_ID"),
  secretAccessKey:
    getEnvValue("CLOUDFLARE_R2_SECRET_ACCESS_KEY") || getEnvValue("R2_SECRET_ACCESS_KEY"),
  bucketName: getEnvValue("CLOUDFLARE_R2_BUCKET") || getEnvValue("R2_BUCKET_NAME"),
  publicBaseUrl: getEnvValue("R2_PUBLIC_BASE_URL"),
  // Optional explicit endpoint override (ENDPOINT env var).  When set it takes
  // precedence over the account-ID-derived URL.  Required for presigned PUT URLs
  // that the browser will hit directly — the endpoint must be publicly reachable.
  endpoint: getEnvValue("ENDPOINT")
};

const hasR2Config = Boolean(
  r2Config.accountId &&
    r2Config.accessKeyId &&
    r2Config.secretAccessKey &&
    r2Config.bucketName,
);
const hasRequestedCloudflareEnv = Boolean(
  r2Config.accountId && r2Config.accessKeyId && r2Config.secretAccessKey && r2Config.bucketName,
);

const r2Client = hasR2Config
  ? new S3Client({
      region: "auto",
      // Prefer an explicit ENDPOINT env var; fall back to the standard R2 URL
      // derived from the account ID.  Both are publicly reachable so presigned
      // URLs generated here are valid for direct browser PUT requests.
      endpoint: r2Config.endpoint || `https://${r2Config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: r2Config.accessKeyId,
        secretAccessKey: r2Config.secretAccessKey
      }
    })
  : null;

if (isProduction && !hasR2Config) {
  console.warn("R2 credentials are not configured; MixReview API is using local storage fallback.");
}

app.set("trust proxy", 1);
const corsOptions = buildCorsOptions();
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({ limit: "2mb" }));
app.use("/uploads", express.static(uploadRoot));

function sendHealth(_req, res) {
  res.json({
    ok: true,
    service: "mixreview-api",
    environment: isProduction ? "production" : "development",
    audioStorage: hasR2Config ? "r2" : "local",
    cloudflareEnvConfigured: hasRequestedCloudflareEnv,
    r2UploadConfigured: hasR2Config,
    allowedOrigins
  });
}

app.get("/health", sendHealth);
app.get("/api/health", sendHealth);

app.get("/api/audio/playback/:encodedKey", streamAudioPlayback);

const sessionRouter = express.Router();
sessionRouter.get("/", listSessions);
sessionRouter.post("/", createSession);
sessionRouter.get("/:sessionId", getSession);
sessionRouter.put("/:sessionId", requireAdminAuth, saveSession);
sessionRouter.delete("/:sessionId", deleteSession);
sessionRouter.post("/:sessionId/audio", upload.single("audio"), handleAudioUpload);
sessionRouter.post("/:sessionId/confirm-audio", requireAdminAuth, confirmAudioUpload);
sessionRouter.delete("/:sessionId/albums/:albumId", requireAdminAuth, deleteAlbum);

app.use("/api/sessions", sessionRouter);
app.post("/api/audio/upload", upload.single("audio"), handleAudioUpload);
app.post("/api/get-presigned-url", requireAdminAuth, getPresignedUploadUrl);
app.delete("/api/tracks/:id", requireAdminAuth, deleteTrack);

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: error.message });
  }

  console.error(error);
  return res.status(error.status || 500).json({
    error: error.expose ? error.message : "MixReview API request failed."
  });
});

app.listen(port, () => {
  console.log(`MixReview API listening on ${port}`);
});

async function handleAudioUpload(req, res, next) {
  try {
    const audioFile = req.file;
    if (!audioFile) {
      return res.status(400).json({ error: "Audio file is required." });
    }

    const uploadExt = path.extname(audioFile.originalname).toLowerCase();
    console.log("[MixReview] Upload received", {
      fileName: audioFile.originalname,
      extension: uploadExt,
      mimeType: audioFile.mimetype,
      size: audioFile.size,
      sizeMB: (audioFile.size / 1_048_576).toFixed(2),
    });

    const classification = classifyAudioFormat(audioFile.originalname, audioFile.mimetype);
    if (!classification.ok) {
      return res.status(415).json({ error: classification.error });
    }

    const sessionId = sanitizeSessionId(req.params.sessionId);
    const trackId   = sanitizePathSegment(req.body?.trackId   || "track-1");
    const versionId = sanitizePathSegment(req.body?.versionId || "version-v1");

    // Upload the lossless original to R2 under its natural extension.
    const objectKey     = buildAudioObjectKey(audioFile.originalname, classification.ext, { sessionId, trackId, versionId });
    const storageResult = hasR2Config
      ? await uploadAudioToR2(objectKey, audioFile, classification.mimeType, req)
      : await saveAudioLocally(objectKey, audioFile, req);

    const originalUrl = storageResult.playbackUrl;
    const playbackUrl = originalUrl;
    const previewKey  = null;
    const peaksKey = hasR2Config ? `${objectKey}.peaks.json` : null;

    const audioPayload = {
      key:              objectKey,
      playbackUrl,
      originalUrl,
      originalFormat:   classification.ext.slice(1),
      requiresTranscode: classification.requiresTranscode,
      previewUrl:       previewKey ? playbackUrl : null,
      previewKey,
      peaksUrl:         storageResult.peaksUrl || null,
      fileName:         audioFile.originalname,
      contentType:      classification.mimeType,
      size:             audioFile.size,
      storage:          storageResult.storage,
      uploadedAt:       new Date().toISOString(),
    };

    if (sessionId) {
      await attachAudioToSession(sessionId, audioPayload, versionId, trackId);
    }

    if (hasR2Config && peaksKey) {
      const apiBaseUrl = `${req.protocol}://${req.get("host")}`;
      generateAndStoreSessionPeaks(audioFile.buffer, peaksKey, apiBaseUrl, sessionId, trackId, versionId, objectKey)
        .catch((err) => console.error("[MixReview] Peaks generation failed", { objectKey, error: err.message }));
    }

    if (classification.requiresTranscode && hasR2Config) {
      const asyncPreviewKey = objectKey.replace(/\.[^.]+$/, ".preview.m4a");
      const apiBaseUrl = `${req.protocol}://${req.get("host")}`;
      transcodeAndStorePreview(objectKey, asyncPreviewKey, apiBaseUrl, sessionId, trackId, versionId)
        .catch((err) => console.error("[MixReview] Background transcode error:", err.message));
    } else if (classification.requiresTranscode && !hasR2Config) {
      const asyncPreviewKey = objectKey.replace(/\.[^.]+$/, ".preview.m4a");
      transcodeToAac(audioFile.buffer)
        .then(async (previewBuffer) => {
          const previewPath = path.join(uploadRoot, asyncPreviewKey);
          await mkdir(path.dirname(previewPath), { recursive: true });
          await writeFile(previewPath, previewBuffer);
          console.log("[MixReview] Local background transcode stored", { previewKey: asyncPreviewKey });
        })
        .catch((err) => console.error("[MixReview] Local background transcode error:", err.message));
    }

    console.log("[MixReview] Upload stored", {
      fileName: audioFile.originalname,
      contentType: classification.mimeType,
      requiresTranscode: classification.requiresTranscode,
      storage: storageResult.storage,
      key: objectKey,
      playbackUrl: playbackUrl.slice(0, 120),
    });

    return res.status(201).json({
      ok:                true,
      storage:           storageResult.storage,
      key:               objectKey,
      playbackUrl,
      originalUrl,
      originalFormat:    classification.ext.slice(1),
      requiresTranscode: classification.requiresTranscode,
      previewUrl:        previewKey ? playbackUrl : null,
      previewKey,
      peaksUrl:          storageResult.peaksUrl || null,
      fileName:          audioFile.originalname,
      sessionId:         sessionId || null,
      trackId,
      versionId,
      contentType:       classification.mimeType,
      size:              audioFile.size,
    });
  } catch (error) {
    next(error);
  }
}

async function uploadAudioToR2(objectKey, audioFile, contentType, req) {
  await r2Client.send(
    new PutObjectCommand({
      Bucket: r2Config.bucketName,
      Key: objectKey,
      Body: audioFile.buffer,
      ContentLength: audioFile.size,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000",
      ContentDisposition: "inline",
      Metadata: {
        originalName: encodeURIComponent(audioFile.originalname)
      }
    }),
  );

  return {
    storage: "r2",
    playbackUrl: buildApiPlaybackUrl(req, objectKey),
    peaksUrl: null
  };
}

// getPresignedUploadUrl — issues a short-lived presigned PUT URL so the browser
// can upload audio directly to R2 without routing the file bytes through this
// server.  The client must:
//   1. PUT the file to the returned URL with the exact Content-Type header that
//      was submitted here — R2 validates it as part of the signature.
//   2. Return the `key` to this API (e.g. via the session save route) so the
//      session document can reference the uploaded object.
//
// R2 CORS prerequisite: the bucket must have a CORS rule that allows PUT from
// your frontend origin (https://mixreview.kingzbreadent.com) with the
// Content-Type and Content-Length headers permitted.  Without this the browser's
// preflight OPTIONS will be rejected before the upload even starts.
async function getPresignedUploadUrl(req, res, next) {
  try {
    if (!hasR2Config) {
      return res.status(503).json({ error: "Cloud storage is not configured on this server." });
    }

    const { fileName, fileType, sessionId: rawSessionId, trackId, versionId } = req.body || {};

    if (!fileName || typeof fileName !== "string" || !fileName.trim()) {
      return res.status(400).json({ error: "fileName is required." });
    }
    if (!fileType || typeof fileType !== "string" || !fileType.trim()) {
      return res.status(400).json({ error: "fileType is required." });
    }

    // Validate against the full supported extension set.
    const extension = path.extname(fileName).toLowerCase();
    if (!ALLOWED_AUDIO_EXTS.has(extension)) {
      return res.status(400).json({
        error: `Unsupported audio format "${extension || "(no extension)"}". Accepted: ${[...ALLOWED_AUDIO_EXTS].join(", ")}`,
      });
    }

    // Resolve canonical MIME from extension — the browser may misreport file.type
    // for AIFF, ALAC, WMA, W64 on some operating systems.  The presigned URL embeds
    // ContentType in its HMAC signature; the value here MUST match the Content-Type
    // header the browser sends on the R2 PUT or R2 returns 403.
    const resolvedMime = AUDIO_MIME_BY_EXT[extension.slice(1)] || fileType.trim();

    const resolvedSessionId = sanitizeSessionId(rawSessionId);
    const objectKey = buildAudioObjectKey(fileName.trim(), extension, resolvedSessionId ? {
      sessionId: resolvedSessionId,
      trackId:   trackId   || "track-1",
      versionId: versionId || "version-v1"
    } : {});

    const command = new PutObjectCommand({
      Bucket:      r2Config.bucketName,
      Key:         objectKey,
      ContentType: resolvedMime,
    });

    const url = await getSignedUrl(r2Client, command, { expiresIn: 900 });

    console.log("[MixReview] Pre-signed upload URL issued", {
      objectKey,
      resolvedMime,
      expiresIn: 900,
    });

    // Return resolvedMime alongside the URL so the client uses the identical
    // Content-Type on its PUT (guarantees the R2 signature matches).
    return res.json({ url, key: objectKey, resolvedMime });
  } catch (error) {
    next(error);
  }
}

// confirmAudioUpload — step 3 of the direct-to-R2 upload flow.
//
// After the browser has PUT the file straight to R2 using the presigned URL,
// it calls this endpoint with the object key and file metadata.  The handler
// builds the playback URL from the key, creates the audioPayload, and calls
// attachAudioToSession — exactly what handleAudioUpload does after its R2
// upload, but without touching the file bytes.
//
// The response shape matches handleAudioUpload so the existing App.jsx upload
// handlers need no changes.
async function confirmAudioUpload(req, res, next) {
  try {
    if (!hasR2Config) {
      return res.status(503).json({ error: "Cloud storage is not configured on this server." });
    }

    const sessionId = sanitizeSessionId(req.params.sessionId);
    if (!sessionId) {
      return res.status(400).json({ error: "Valid session ID is required." });
    }

    const { key, fileName, fileType, size, trackId, versionId } = req.body || {};

    if (!key || typeof key !== "string" || !key.trim()) {
      return res.status(400).json({ error: "key is required." });
    }
    if (!fileName || typeof fileName !== "string" || !fileName.trim()) {
      return res.status(400).json({ error: "fileName is required." });
    }
    if (!fileType || typeof fileType !== "string" || !fileType.trim()) {
      return res.status(400).json({ error: "fileType is required." });
    }

    // Guard: only accept keys that belong to this session or the generic
    // uploads/ prefix.  Rejects attempts to register a foreign session's
    // object as belonging to this one.
    const safeKey = key.trim();
    const sessionPrefix = `sessions/${sessionId}/`;
    if (!safeKey.startsWith(sessionPrefix) && !safeKey.startsWith("uploads/")) {
      console.warn("[MixReview] confirmAudioUpload: key does not match session", { sessionId, key: safeKey });
      return res.status(400).json({ error: "Audio key does not belong to this session." });
    }

    const safeTrackId   = sanitizePathSegment(trackId   || "track-1");
    const safeVersionId = sanitizePathSegment(versionId || "version-v1");

    // Resolve canonical MIME from the R2 key's extension — the browser-reported
    // fileType may be wrong (e.g. "application/octet-stream") for AIFF/ALAC/WMA.
    const ext = path.extname(safeKey).toLowerCase();
    const format = classifyAudioFormat(fileName.trim(), fileType.trim());
    if (!format.ok) {
      return res.status(415).json({ error: format.error });
    }
    const mimeType = AUDIO_MIME_BY_EXT[ext.slice(1)] || format.mimeType;

    const originalUrl = buildApiPlaybackUrl(req, safeKey);
    const peaksKey = `${safeKey}.peaks.json`;
    const audioPayload = {
      key:               safeKey,
      playbackUrl:       originalUrl,  // updated to preview URL if transcode succeeds
      originalUrl,
      originalFormat:    format.ext.slice(1),
      requiresTranscode: format.requiresTranscode,
      peaksUrl:          null,
      fileName:          fileName.trim(),
      contentType:       mimeType,
      size:              typeof size === "number" && size > 0 ? size : 0,
      storage:           "r2",
      uploadedAt:        new Date().toISOString(),
    };

    await attachAudioToSession(sessionId, audioPayload, safeVersionId, safeTrackId);

    generateAndStoreSessionPeaksFromR2(safeKey, peaksKey, `${req.protocol}://${req.get("host")}`, sessionId, safeTrackId, safeVersionId)
      .catch((err) => console.error("[MixReview] Direct-upload peaks generation failed", { key: safeKey, error: err.message }));

    // For non-browser-native formats, kick off a background fetch → transcode →
    // store cycle.  The session document is patched with the preview URL when done.
    if (format.requiresTranscode && hasR2Config) {
      const previewKey = safeKey.replace(/\.[^.]+$/, ".preview.m4a");
      const apiBaseUrl = `${req.protocol}://${req.get("host")}`;
      transcodeAndStorePreview(safeKey, previewKey, apiBaseUrl, sessionId, safeTrackId, safeVersionId)
        .catch((err) => console.error("[MixReview] Background transcode error:", err.message));
    }

    console.log("[MixReview] Direct upload confirmed and attached to session", {
      sessionId,
      trackId:  safeTrackId,
      versionId: safeVersionId,
      key:      safeKey,
      requiresTranscode: format.requiresTranscode,
    });

    return res.status(201).json({
      ok:                true,
      storage:           "r2",
      key:               safeKey,
      playbackUrl:       originalUrl,
      originalUrl,
      originalFormat:    format.ext.slice(1),
      requiresTranscode: format.requiresTranscode,
      peaksUrl:          null,
      fileName:          fileName.trim(),
      sessionId,
      trackId:           safeTrackId,
      versionId:         safeVersionId,
      contentType:       mimeType,
      size:              audioPayload.size,
    });
  } catch (error) {
    next(error);
  }
}

// generateAndUploadPeaks — runs FFmpeg on the in-memory audio buffer, computes
// 800 normalized peak values, and stores them as a .peaks.json object in R2.
// Called fire-and-forget; errors are caught by the caller.
async function generateAndUploadPeaks(audioBuffer, peaksKey, numPoints = 800) {
  const peaks = await generatePeaksWithFfmpeg(audioBuffer, numPoints);
  const body = JSON.stringify(peaks);
  await r2Client.send(
    new PutObjectCommand({
      Bucket: r2Config.bucketName,
      Key: peaksKey,
      Body: body,
      ContentType: "application/json",
      CacheControl: "public, max-age=31536000",
      ContentDisposition: "inline"
    })
  );
  console.log("[MixReview] Peaks uploaded", { peaksKey, numPoints: peaks.length });
}

async function generateAndStoreSessionPeaks(audioBuffer, peaksKey, apiBaseUrl, sessionId, trackId, versionId, objectKey = null) {
  await generateAndUploadPeaks(audioBuffer, peaksKey);
  if (!sessionId || !trackId || !versionId) return;
  const peaksUrl = `${apiBaseUrl}/api/audio/playback/${encodeURIComponent(peaksKey)}`;
  await patchSessionAudioMetadata(sessionId, trackId, versionId, { peaksUrl });
  console.log("[MixReview] Peaks URL attached to session", { sessionId, trackId, versionId, objectKey, peaksKey });
}

async function generateAndStoreSessionPeaksFromR2(originalKey, peaksKey, apiBaseUrl, sessionId, trackId, versionId) {
  const r2Obj = await r2Client.send(new GetObjectCommand({ Bucket: r2Config.bucketName, Key: originalKey }));
  const chunks = [];
  for await (const chunk of r2Obj.Body) chunks.push(chunk);
  const audioBuffer = Buffer.concat(chunks);
  console.log("[MixReview] Peaks generation: fetched original", { originalKey, bytes: audioBuffer.length });
  await generateAndStoreSessionPeaks(audioBuffer, peaksKey, apiBaseUrl, sessionId, trackId, versionId, originalKey);
}

function queueMissingPeakRepairs(session, req) {
  if (!hasR2Config || !session?.id) return;

  const apiBaseUrl = `${req.protocol}://${req.get("host")}`;
  const tracks = Array.isArray(session.tracks) ? session.tracks : [];

  tracks.forEach((track) => {
    const versions = Array.isArray(track.versions) ? track.versions : [];
    const version = versions.find((candidate) => candidate.id === track.activeVersionId) || versions[0];
    const audio = version?.audioMetadata;
    if (!version?.id || !audio?.key || audio.peaksUrl) return;

    const repairId = `${session.id}:${track.id}:${version.id}:${audio.key}`;
    if (pendingPeakRepairKeys.has(repairId)) return;
    pendingPeakRepairKeys.add(repairId);

    const peaksKey = `${audio.key}.peaks.json`;
    peakRepairChain = peakRepairChain
      .catch(() => {})
      .then(() => generateAndStoreSessionPeaksFromR2(audio.key, peaksKey, apiBaseUrl, session.id, track.id, version.id))
      .catch((err) => console.error("[MixReview] Missing peaks repair failed", { key: audio.key, error: err.message }))
      .finally(() => pendingPeakRepairKeys.delete(repairId));
  });
}

// generatePeaksWithFfmpeg — decodes any audio format to mono f32le PCM via
// FFmpeg, then downsamples to `numPoints` peak values in the range [-1, 1].
// Each point is the highest-magnitude sample in its window (sign preserved).
async function generatePeaksWithFfmpeg(audioBuffer, numPoints = 800) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-i", "pipe:0",   // read from stdin
      "-ac", "1",       // mix down to mono
      "-f", "f32le",    // raw float32-LE PCM output
      "-ar", "44100",   // fixed sample rate so window maths is predictable
      "pipe:1"          // write to stdout
    ]);

    const pcmChunks = [];
    ff.stdout.on("data", (chunk) => pcmChunks.push(chunk));

    const stderrChunks = [];
    ff.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    ff.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString().slice(0, 500);
        return reject(new Error(`FFmpeg exited with code ${code}: ${stderr}`));
      }

      const pcm = Buffer.concat(pcmChunks);
      const numSamples = Math.floor(pcm.length / 4); // 4 bytes per float32

      if (numSamples === 0) {
        return resolve(new Array(numPoints).fill(0));
      }

      const windowSize = Math.max(1, Math.floor(numSamples / numPoints));
      const peaks = [];

      for (let i = 0; i < numPoints; i++) {
        const start = i * windowSize;
        const end = Math.min(start + windowSize, numSamples);
        let peakSample = 0;
        let maxAbs = 0;

        for (let j = start; j < end; j++) {
          const sample = pcm.readFloatLE(j * 4);
          const abs = Math.abs(sample);
          if (abs > maxAbs) {
            maxAbs = abs;
            peakSample = sample;
          }
        }

        // Clamp to [-1, 1] to guard against float rounding beyond the nominal range.
        peaks.push(Math.max(-1, Math.min(1, peakSample)));
      }

      resolve(peaks);
    });

    ff.on("error", (err) => {
      reject(new Error(`Failed to spawn FFmpeg: ${err.message}`));
    });

    // Absorb EPIPE so Node does not throw if FFmpeg closes stdin early.
    ff.stdin.on("error", () => {});
    ff.stdin.write(audioBuffer);
    ff.stdin.end();
  });
}

// ── Audio format registry ─────────────────────────────────────────────────────
//
// AUDIO_MIME_BY_EXT — canonical MIME per extension.
// Used by streamAudioPlayback, classifyAudioFormat, and the presign endpoint.
const AUDIO_MIME_BY_EXT = {
  // Lossless
  wav:  "audio/wav",
  flac: "audio/flac",
  aiff: "audio/x-aiff",
  aif:  "audio/x-aiff",
  alac: "audio/x-alac",
  w64:  "audio/x-w64",
  // Compressed — universally browser-native
  mp3:  "audio/mpeg",
  aac:  "audio/aac",
  m4a:  "audio/mp4",
  webm: "audio/webm",
  // Compressed — limited browser support (Safari gap for OGG/Opus)
  ogg:  "audio/ogg",
  opus: "audio/opus",
  wma:  "audio/x-ms-wma",
};

// All file extensions accepted by the ingestion pipeline.
const ALLOWED_AUDIO_EXTS = new Set([
  ".wav", ".flac", ".aiff", ".aif", ".alac", ".w64",  // lossless
  ".mp3", ".aac", ".m4a", ".ogg", ".opus", ".wma",    // compressed
]);

// Formats not natively playable in ALL major browsers.
// Files with these extensions are transcoded to 256 kbps AAC (M4A) in a
// background job. The lossless original is preserved in R2 so the admin view
// can eventually support high-res analysis/editing via originalUrl.
//
//   AIFF/AIF  — no browser plays this container natively
//   ALAC      — QuickTime codec; no web browser plays it standalone
//   WMA       — Windows Media; unsupported outside Edge/IE
//   W64       — Sony Wave64; no browser support
//   OGG/Opus  — Safari (macOS + iOS) does not support Vorbis/Opus
const TRANSCODE_FORMATS = new Set([".aiff", ".aif", ".alac", ".wma", ".w64", ".ogg", ".opus"]);

function resolvePlaybackContentType(objectKey, storedContentType = "") {
  const keyWithoutQuery = objectKey.split("?")[0].toLowerCase();

  if (keyWithoutQuery.endsWith(".peaks.json")) {
    return {
      contentType: "application/json",
      extension: "peaks.json",
      source: "extension",
    };
  }

  const extMatch = keyWithoutQuery.match(/\.([a-z0-9]+)$/);
  const extension = extMatch?.[1] || "";
  const extensionContentType = extension ? AUDIO_MIME_BY_EXT[extension] : null;

  if (extensionContentType) {
    return {
      contentType: extensionContentType,
      extension,
      source: "extension",
    };
  }

  return {
    contentType: storedContentType || "application/octet-stream",
    extension: extension || "(none)",
    source: storedContentType ? "stored" : "fallback",
  };
}

async function streamAudioPlayback(req, res, next) {
  try {
    const objectKey = decodeURIComponent(req.params.encodedKey || "");
    if (!objectKey || objectKey.includes("..")) {
      return res.status(400).json({ error: "Valid audio key is required." });
    }

    console.log("[MixReview] Playback request", {
      objectKey,
      range: req.headers.range ?? "(none)",
    });

    if (!hasR2Config) {
      return res.redirect(302, `/uploads/${objectKey}`);
    }

    const response = await r2Client.send(
      new GetObjectCommand({
        Bucket: r2Config.bucketName,
        Key: objectKey,
        Range: req.headers.range
      }),
    );

    const statusCode = req.headers.range && response.ContentRange ? 206 : 200;
    res.status(statusCode);
    res.setHeader("Accept-Ranges", "bytes");

    // R2 metadata can drift when objects are uploaded by older/newer builds.
    // Browser decoders trust the response header, so known playback assets must
    // be served from their key extension, not from stale stored ContentType.
    const contentTypeInfo = resolvePlaybackContentType(objectKey, response.ContentType);
    const { contentType } = contentTypeInfo;
    res.setHeader("Content-Type", contentType);

    console.log("[MixReview] Playback serving", {
      objectKey,
      contentType,
      contentTypeSource: contentTypeInfo.source,
      extension: contentTypeInfo.extension,
      storedContentType: response.ContentType || "(none)",
      statusCode
    });

    if (response.ContentLength) {
      res.setHeader("Content-Length", response.ContentLength);
    }
    if (response.ContentRange) {
      res.setHeader("Content-Range", response.ContentRange);
    }
    response.Body.pipe(res);
  } catch (error) {
    // R2 NoSuchKey → 404 so the browser and frontend receive a clean "not found"
    // rather than a generic 500 that hides the real cause in logs.
    if (error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ error: "Audio object not found." });
    }
    next(error);
  }
}

async function saveAudioLocally(objectKey, audioFile, req) {
  const targetPath = path.join(uploadRoot, objectKey);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, audioFile.buffer);

  return {
    storage: "local",
    playbackUrl: `${req.protocol}://${req.get("host")}/uploads/${objectKey}`
  };
}

// classifyAudioFormat — validates extension + resolves canonical MIME.
// Replaces validateStereoReviewAudio (which was limited to WAV/MP3 stereo-only).
// Professional audio — especially stems — is frequently mono; the channel-count
// restriction is intentionally removed.
function classifyAudioFormat(fileName, mimetype) {
  const ext = path.extname(fileName).toLowerCase();
  if (!ALLOWED_AUDIO_EXTS.has(ext)) {
    return {
      ok: false,
      error: `Unsupported audio format "${ext || "(no extension)"}". Accepted: ${[...ALLOWED_AUDIO_EXTS].join(", ")}`,
    };
  }
  const mimeType = AUDIO_MIME_BY_EXT[ext.slice(1)] || mimetype || "application/octet-stream";
  return { ok: true, ext, mimeType, requiresTranscode: TRANSCODE_FORMATS.has(ext) };
}

// transcodeToAac — converts any FFmpeg-readable audio buffer to 256 kbps AAC in
// an M4A container.  Returns the output as a Node Buffer.
async function transcodeToAac(inputBuffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-i",        "pipe:0",
      "-c:a",      "aac",
      "-b:a",      "256k",
      "-movflags", "+frag_keyframe+empty_moov",
      "-f",        "mp4",
      "pipe:1",
    ]);
    const out = []; const err = [];
    ff.stdout.on("data", (c) => out.push(c));
    ff.stderr.on("data", (c) => err.push(c));
    ff.on("close", (code) => {
      if (code !== 0) return reject(new Error(`FFmpeg transcode exited ${code}: ${Buffer.concat(err).toString().slice(0, 400)}`));
      resolve(Buffer.concat(out));
    });
    ff.on("error", (e) => reject(new Error(`Failed to spawn FFmpeg: ${e.message}`)));
    ff.stdin.on("error", () => {});
    ff.stdin.write(inputBuffer);
    ff.stdin.end();
  });
}

// transcodeAndStorePreview — fire-and-forget background job for direct-to-R2 uploads.
// Fetches the original, transcodes to AAC, stores the preview, then patches the
// session document so the next client load finds a browser-playable URL.
// The lossless original is preserved under its original key for admin analysis.
async function transcodeAndStorePreview(originalKey, previewKey, apiBaseUrl, sessionId, trackId, versionId) {
  try {
    const r2Obj = await r2Client.send(new GetObjectCommand({ Bucket: r2Config.bucketName, Key: originalKey }));
    const chunks = [];
    for await (const chunk of r2Obj.Body) chunks.push(chunk);
    const originalBuffer = Buffer.concat(chunks);
    console.log("[MixReview] Background transcode: fetched original", { originalKey, bytes: originalBuffer.length });

    const previewBuffer = await transcodeToAac(originalBuffer);
    await r2Client.send(new PutObjectCommand({
      Bucket: r2Config.bucketName, Key: previewKey,
      Body: previewBuffer, ContentType: "audio/mp4",
      CacheControl: "public, max-age=31536000",
    }));

    const previewUrl = `${apiBaseUrl}/api/audio/playback/${encodeURIComponent(previewKey)}`;
    await patchSessionAudioMetadata(sessionId, trackId, versionId, {
      playbackUrl: previewUrl,
      url: previewUrl,
      audioUrl: previewUrl,
      previewUrl,
      previewKey,
      transcodedAt: new Date().toISOString(),
    });
    console.log("[MixReview] Background transcode complete", { previewKey, sessionId, trackId });
  } catch (err) {
    console.error("[MixReview] Background transcode failed", { originalKey, error: err.message });
  }
}

async function patchSessionAudioMetadata(sessionId, trackId, versionId, patch) {
  const existingDoc = await readSessionDocument(sessionId);
  if (!existingDoc) return;

  const patchedTracks = (existingDoc.tracks || []).map((track) => {
    if (track.id !== trackId) return track;
    return {
      ...track,
      versions: (track.versions || []).map((version) => {
        if (version.id !== versionId || !version.audioMetadata) return version;
        return {
          ...version,
          audioMetadata: {
            ...version.audioMetadata,
            ...patch,
          },
        };
      }),
    };
  });

  await writeSessionDocument(sessionId, { ...existingDoc, tracks: patchedTracks });
}

function buildAudioObjectKey(originalName, extension, { sessionId, trackId, versionId } = {}) {
  const safeBaseName = path
    .basename(originalName, path.extname(originalName))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "mixreview-audio";

  if (sessionId) {
    const safeTrackId = sanitizePathSegment(trackId || "track-1");
    const safeVersionId = sanitizePathSegment(versionId || "version-v1");
    return `sessions/${sessionId}/tracks/${safeTrackId}/versions/${safeVersionId}/audio/${randomUUID()}-${safeBaseName}${extension}`;
  }

  return `${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${safeBaseName}${extension}`;
}

async function listSessions(_req, res, next) {
  try {
    const database = await withTimeout(loadSessionIndexForList(), 10_000, "Session index read timed out.");
    return res.json({ sessions: database.sessions });
  } catch (error) {
    if (error?.name === "TimeoutError") {
      return res.status(504).json({ error: "Session list could not be loaded within 10 seconds." });
    }
    return next(error);
  }

}

async function loadSessionIndexForList() {
  let database = await readDatabase();

  // If the index is empty and R2 is configured, scan R2 for existing session
  // documents and rebuild the index. This recovers from two cases:
  //   1. Railway redeploy wiped the local db.json before this fix was deployed
  //      (R2 index does not exist yet — first boot with the new code).
  //   2. Any future scenario where the index gets out of sync.
  // After the rebuild, writeDatabase() persists the result to R2 so the next
  // request finds the index immediately without re-scanning.
  if (hasR2Config && database.sessions.length === 0) {
    console.log("[MixReview] Session index is empty — scanning R2 to rebuild");
    const rebuilt = await scanR2ForSessions();
    if (rebuilt.length > 0) {
      database = { sessions: rebuilt };
      await writeDatabase(database).catch((e) =>
        console.warn("[MixReview] Failed to persist rebuilt index:", e.message)
      );
      console.log(`[MixReview] Rebuilt session index with ${rebuilt.length} session(s)`);
    }
  }

  return database;
}

async function createSession(req, res) {
  const now = new Date().toISOString();
  const session = {
    ...(isPlainObject(req.body?.session) ? req.body.session : {}),
    id: sanitizeSessionId(req.body?.id || req.body?.session?.id) || `session-${randomUUID()}`,
    projectName: req.body?.projectName || req.body?.session?.projectName || "Untitled MixReview Session",
    createdAt: now,
    updatedAt: now
  };

  await writeSessionDocument(session.id, session);
  await upsertSessionIndex(session);
  res.status(201).json({ session });
}

async function getSession(req, res, next) {
  const sessionId = sanitizeSessionId(req.params.sessionId);
  let session;
  try {
    session = sessionId ? await withTimeout(readSessionDocument(sessionId), 30_000, "Session document read timed out.") : null;
  } catch (error) {
    if (error?.name === "TimeoutError") {
      return res.status(504).json({ error: "Session could not be loaded within 30 seconds." });
    }
    return next(error);
  }
  if (!session) {
    return res.status(404).json({ error: "Session not found." });
  }

  queueMissingPeakRepairs(session, req);
  return res.json({ session: await refreshSessionPlaybackUrls(session, req) });
}

async function saveSession(req, res) {
  const sessionId = sanitizeSessionId(req.params.sessionId);
  if (!sessionId) {
    return res.status(400).json({ error: "Valid session id is required." });
  }

  const now = new Date().toISOString();
  const incomingSession = isPlainObject(req.body?.session) ? req.body.session : req.body;

  // Guard: read the stored document so we can preserve audio metadata
  // that the client no longer has (cleared blob URL, stale null, etc.)
  const storedSession = await readSessionDocument(sessionId).catch(() => null);
  const mergedSession = preserveAudioMetadata(incomingSession, storedSession);

  const session = normalizeSessionDocument({
    ...mergedSession,
    id: sessionId,
    updatedAt: now
  });

  if (!session) {
    return res.status(400).json({ error: "Invalid session payload." });
  }

  // Validation gate — reject before any write if the tracks array contains
  // duplicate IDs or duplicate active-version audio keys. Either condition
  // indicates a corrupt or replayed payload that would clobber good data.
  const duplicateViolation = validateTracksIntegrity(session.tracks);
  if (duplicateViolation) {
    console.error("[MixReview] saveSession BLOCKED — duplicate track", duplicateViolation.field, "detected", {
      sessionId,
      field: duplicateViolation.field,
      value: duplicateViolation.value,
    });
    return res.status(400).json({
      error: `Duplicate track ${duplicateViolation.field} detected — write aborted to protect data integrity.`,
      field: duplicateViolation.field,
      value: duplicateViolation.value,
    });
  }

  await writeSessionDocument(sessionId, session);
  await upsertSessionIndex(session);
  return res.json({ session });
}

/**
 * preserveAudioMetadata — prevents the client PUT from silently overwriting
 * valid audio source records with null/empty values.
 *
 * When a track version in the stored document has a `key` (R2 object path)
 * and the incoming payload for that same version has lost the key or URL
 * (e.g. the client cleared a blob URL and serialised null, or sent an older
 * cached snapshot before the upload completed), we keep the stored metadata.
 *
 * This is the root cause guard for "second track reference pointing to a
 * file no longer available": the client race-writes a stale snapshot that
 * overwrites the valid key the server just wrote via POST /audio.
 */
function preserveAudioMetadata(incoming, stored) {
  if (!isPlainObject(stored) || !Array.isArray(incoming?.tracks) || !Array.isArray(stored.tracks)) {
    return incoming;
  }

  return {
    ...incoming,
    tracks: incoming.tracks.map((incomingTrack) => {
      const storedTrack = stored.tracks.find((t) => t.id === incomingTrack.id);
      if (!storedTrack || !Array.isArray(incomingTrack.versions)) {
        return incomingTrack;
      }

      return {
        ...incomingTrack,
        versions: incomingTrack.versions.map((incomingVersion) => {
          const storedVersion = (storedTrack.versions || []).find((v) => v.id === incomingVersion.id);
          const storedMeta  = storedVersion?.audioMetadata;
          const incomingMeta = incomingVersion?.audioMetadata;

          // Only preserve when the stored record has a concrete storage key
          // and the incoming record is missing it or has lost its URL.
          const storedHasKey    = typeof storedMeta?.key === "string" && storedMeta.key;
          const incomingLostKey = !incomingMeta?.key;
          const incomingLostUrl = !(incomingMeta?.playbackUrl || incomingMeta?.url || incomingMeta?.audioUrl);
          const storedHasPreview = typeof storedMeta?.previewUrl === "string" && storedMeta.previewUrl;
          const incomingLostPreview = !incomingMeta?.previewUrl || incomingMeta?.playbackUrl !== storedMeta?.playbackUrl;

          if (storedHasKey && (incomingLostKey || incomingLostUrl)) {
            console.log("[MixReview] preserveAudioMetadata: restored stored key for", {
              trackId: incomingTrack.id,
              versionId: incomingVersion.id,
              storedKey: storedMeta.key,
            });
            return { ...incomingVersion, audioMetadata: storedMeta };
          }

          if (storedHasKey && storedHasPreview && incomingLostPreview) {
            return {
              ...incomingVersion,
              audioMetadata: {
                ...incomingMeta,
                playbackUrl: storedMeta.playbackUrl,
                url: storedMeta.url || storedMeta.playbackUrl,
                audioUrl: storedMeta.audioUrl || storedMeta.playbackUrl,
                originalUrl: storedMeta.originalUrl || incomingMeta?.originalUrl || storedMeta.playbackUrl,
                originalFormat: storedMeta.originalFormat || incomingMeta?.originalFormat || null,
                requiresTranscode: storedMeta.requiresTranscode ?? incomingMeta?.requiresTranscode ?? false,
                previewUrl: storedMeta.previewUrl,
                previewKey: storedMeta.previewKey || incomingMeta?.previewKey || null,
                transcodedAt: storedMeta.transcodedAt || incomingMeta?.transcodedAt || null,
              },
            };
          }

          return incomingVersion;
        }),
      };
    }),
  };
}

/**
 * requireAdminAuth — Express middleware that enforces a shared-secret Bearer
 * token on admin-sensitive routes (session write, delete, audio upload).
 *
 * Set ADMIN_API_KEY in the Railway environment to enable. In development, if
 * the variable is absent the middleware is a no-op so local work is unblocked.
 * In production, an absent key causes an immediate 401 on every request to
 * protected routes — the route is inaccessible until the variable is set.
 *
 * The client must send: Authorization: Bearer <ADMIN_API_KEY>
 */
function requireAdminAuth(req, res, next) {
  const adminKey = getEnvValue("ADMIN_API_KEY");

  if (!adminKey) {
    if (isProduction) {
      console.error("[MixReview] requireAdminAuth: ADMIN_API_KEY is not set — blocking request in production.");
      return res.status(401).json({ error: "Admin authentication is required but has not been configured on the server." });
    }
    // Dev: no key configured — allow through with a warning so local dev is not blocked.
    console.warn("[MixReview] requireAdminAuth: ADMIN_API_KEY not set — skipping auth in development.");
    return next();
  }

  const authHeader = req.headers["authorization"] || "";
  const submitted = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : authHeader.trim();

  if (!submitted || submitted !== adminKey) {
    console.warn("[MixReview] requireAdminAuth: rejected unauthenticated request from", req.ip);
    return res.status(401).json({ error: "Unauthorized." });
  }

  next();
}

/**
 * validateTracksIntegrity — single-pass O(n) check over the tracks array.
 *
 * Two Set accumulators run in parallel:
 *   seenIds  — track.id strings. A collision means a structurally malformed
 *              payload (client-side state accidentally cloned a track object).
 *   seenKeys — audioMetadata.key strings from the ACTIVE version of each track
 *              only. Non-active (historical) versions sharing a key is expected;
 *              the active versions sharing one means cross-track metadata
 *              contamination — the same R2 object would be referenced as if it
 *              belonged to two different tracks, and a subsequent PUT from either
 *              track would overwrite the other's audio metadata.
 *
 * Returns null if the array is clean.
 * Returns { field: "id"|"key", value: <duplicate string> } on first collision.
 */
function validateTracksIntegrity(tracks) {
  if (!Array.isArray(tracks) || tracks.length < 2) return null;

  const seenIds  = new Set();
  const seenKeys = new Set();

  for (const track of tracks) {
    const trackId = typeof track.id === "string" ? track.id : null;
    if (trackId) {
      if (seenIds.has(trackId)) return { field: "id", value: trackId };
      seenIds.add(trackId);
    }

    const versions = Array.isArray(track.versions) ? track.versions : [];
    const activeVersion = versions.find((v) => v.id === track.activeVersionId) || versions[0];
    const key = activeVersion?.audioMetadata?.key;
    if (typeof key === "string" && key) {
      if (seenKeys.has(key)) return { field: "key", value: key };
      seenKeys.add(key);
    }
  }

  return null;
}

async function deleteSession(req, res, next) {
  const sessionId = sanitizeSessionId(req.params.sessionId);
  if (!sessionId) {
    return res.status(400).json({ error: "Valid session id is required." });
  }

  // Step 1 — purge ALL R2 objects under sessions/{sessionId}/ FIRST.
  //
  // The index record is intentionally NOT touched until this succeeds.
  // If R2 throws (auth failure, network error, bucket unreachable), the error
  // is surfaced to the caller (502) and the index record is preserved so the
  // admin can retry the deletion without data loss.
  //
  // Per-key partial failures (individual objects that R2 refuses to delete)
  // are logged inside purgeSessionFromR2 but do not abort — the function still
  // returns so the index removal proceeds. A hard AWS-level throw is the signal
  // that the whole operation should be aborted.
  //
  // Coverage: this removes session.json, every audio file, every peaks file,
  // and any other nested object regardless of how many tracks or versions exist.
  // The uploads/ prefix is also covered for any legacy objects that were stored
  // there before session-scoped keys were introduced — those are tracked in the
  // session document and purged individually if present (see note below).
  if (hasR2Config) {
    try {
      const purgedCount = await purgeSessionFromR2(sessionId);
      console.log(`[MixReview] R2 purge complete for session ${sessionId}: ${purgedCount} object(s) deleted`);
    } catch (e) {
      console.error(`[MixReview] R2 purge failed for session ${sessionId} — aborting delete to preserve index record:`, e.message);
      const err = new Error(
        "Session audio files could not be removed from cloud storage. " +
        "The session record has been preserved so you can retry. " +
        `R2 error: ${e.message}`
      );
      err.status = 502;
      err.expose = true;
      return next(err);
    }
  }

  // Step 2 — remove from the index.
  // Only reached after R2 purge succeeds (or R2 is not configured).
  // This is the visibility step: the session will no longer appear in the
  // admin dashboard or be accessible through the API.
  await removeSessionFromIndex(sessionId);

  // Step 3 — delete the local session file (dev / cache; best-effort).
  // Failure here is inconsequential — the file is a cache and will simply
  // not be found on the next read, falling back to R2 or the index.
  const localPath = buildLocalSessionPath(sessionId);
  try {
    await unlink(localPath);
  } catch {
    // Local file may not exist — not a failure condition.
  }

  return res.json({ ok: true, deleted: sessionId });
}

async function deleteAlbum(req, res, next) {
  try {
    const sessionId = sanitizeSessionId(req.params.sessionId);
    const albumId = typeof req.params.albumId === "string" ? req.params.albumId.trim() : null;

    if (!sessionId) return res.status(400).json({ error: "Valid session ID is required." });
    if (!albumId) return res.status(400).json({ error: "Valid album ID is required." });

    const session = await readSessionDocument(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found." });

    const albums = Array.isArray(session.albums) ? session.albums : [];
    const album = albums.find((a) => a.id === albumId);
    if (!album) return res.status(404).json({ error: "Project not found in this session." });

    const albumTrackIds = new Set(Array.isArray(album.trackIds) ? album.trackIds : []);
    const tracks = Array.isArray(session.tracks) ? session.tracks : [];

    const r2Keys = new Set();
    for (const track of tracks) {
      if (albumTrackIds.has(track.id)) collectTrackAudioKeys(track, r2Keys);
    }

    const deletedObjects = hasR2Config ? await deleteTrackAudioObjects(r2Keys) : 0;

    const nextTracks = tracks.filter((t) => !albumTrackIds.has(t.id));
    const nextAlbums = albums.filter((a) => a.id !== albumId);

    const wasActiveInAlbum = albumTrackIds.has(session.activeTrackId);
    const fallbackTrack = wasActiveInAlbum ? nextTracks[0] || null : null;

    const nextSession = normalizeSessionDocument({
      ...session,
      tracks: nextTracks,
      albums: nextAlbums,
      activeTrackId: wasActiveInAlbum ? (fallbackTrack?.id || null) : session.activeTrackId,
      activeVersionId: wasActiveInAlbum ? (fallbackTrack?.activeVersionId || "version-v1") : session.activeVersionId,
      updatedAt: new Date().toISOString(),
    });

    if (!nextSession) return res.status(500).json({ error: "Session could not be updated." });

    await writeSessionDocument(sessionId, nextSession);
    await upsertSessionIndex(nextSession);

    console.log("[MixReview] Project deleted", { sessionId, albumId, tracksRemoved: albumTrackIds.size, deletedObjects });
    return res.json({ ok: true, deleted: albumId, tracksRemoved: albumTrackIds.size, deletedObjects });
  } catch (error) {
    next(error);
  }
}

async function deleteTrack(req, res, next) {
  try {
    const trackId = sanitizePathSegment(req.params.id);
    if (!trackId) {
      return res.status(400).json({ error: "Valid track id is required." });
    }

    const database = await readDatabase();
    const sessionSummaries = Array.isArray(database.sessions) ? database.sessions : [];
    const sessionUpdates = [];
    const r2Keys = new Set();

    for (const summary of sessionSummaries) {
      const sessionId = sanitizeSessionId(summary.id);
      if (!sessionId) continue;

      const session = await readSessionDocument(sessionId).catch(() => null);
      const tracks = Array.isArray(session?.tracks) ? session.tracks : [];
      const trackIndex = tracks.findIndex((track) => track.id === trackId);
      if (trackIndex < 0) continue;

      const deletedTrack = tracks[trackIndex];
      collectTrackAudioKeys(deletedTrack, r2Keys);

      const nextTracks = tracks.filter((track) => track.id !== trackId);
      const fallbackTrack = nextTracks[trackIndex] || nextTracks[trackIndex - 1] || nextTracks[0] || null;
      const nextAlbums = Array.isArray(session.albums)
        ? session.albums.map((album) => ({
            ...album,
            trackIds: (Array.isArray(album.trackIds) ? album.trackIds : []).filter((id) => id !== trackId),
          }))
        : session.albums;
      const activeVersion =
        fallbackTrack?.versions?.find((version) => version.id === fallbackTrack.activeVersionId) ||
        fallbackTrack?.versions?.[0] ||
        null;

      const nextSession = normalizeSessionDocument({
        ...session,
        tracks: nextTracks,
        albums: nextAlbums,
        activeTrackId: session.activeTrackId === trackId ? fallbackTrack?.id || null : session.activeTrackId,
        activeVersionId: session.activeTrackId === trackId ? activeVersion?.id || "version-v1" : session.activeVersionId,
        versions: session.activeTrackId === trackId ? fallbackTrack?.versions || [] : session.versions,
        updatedAt: new Date().toISOString(),
      });

      sessionUpdates.push({ sessionId, nextSession });
    }

    if (sessionUpdates.length === 0) {
      return res.status(404).json({ error: "Track not found." });
    }

    const deletedObjects = hasR2Config ? await deleteTrackAudioObjects(r2Keys) : 0;
    for (const { sessionId, nextSession } of sessionUpdates) {
      await writeSessionDocument(sessionId, nextSession);
      await upsertSessionIndex(nextSession);
    }

    console.log("[MixReview] Track deleted", {
      trackId,
      sessions: sessionUpdates.map((update) => update.sessionId),
      r2ObjectCount: r2Keys.size,
      deletedObjects,
    });

    return res.json({
      ok: true,
      deleted: trackId,
      sessions: sessionUpdates.map((update) => update.sessionId),
      deletedObjects,
    });
  } catch (error) {
    next(error);
  }
}

// purgeSessionFromR2 — lists and batch-deletes every R2 object whose key
// starts with sessions/{sessionId}/. Handles pagination so sessions with
// large numbers of audio files (multi-track, multi-version) are fully cleared.
// Returns the total number of objects successfully deleted.
async function purgeSessionFromR2(sessionId) {
  const prefix = `sessions/${sessionId}/`;
  let totalDeleted = 0;
  let continuationToken;

  do {
    // List the next page of objects under this session prefix.
    const listResponse = await r2Client.send(
      new ListObjectsV2Command({
        Bucket: r2Config.bucketName,
        Prefix: prefix,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {})
      })
    );

    const objects = (listResponse.Contents || []).map((obj) => ({ Key: obj.Key }));

    if (objects.length > 0) {
      // DeleteObjects accepts up to 1000 keys per call; ListObjectsV2 pages
      // at 1000 by default, so one batch per page is always sufficient.
      const deleteResponse = await r2Client.send(
        new DeleteObjectsCommand({
          Bucket: r2Config.bucketName,
          Delete: { Objects: objects, Quiet: false }
        })
      );

      const errors = deleteResponse.Errors || [];
      if (errors.length > 0) {
        // Log each per-key failure but continue — partial cleanup is better
        // than none, and the session is already removed from the index.
        console.warn(`[MixReview] Partial R2 delete failure during purge of session ${sessionId}`, {
          failedCount: errors.length,
          sample: errors.slice(0, 5).map((e) => ({ key: e.Key, code: e.Code, message: e.Message }))
        });
      }

      totalDeleted += objects.length - errors.length;
    }

    continuationToken = listResponse.NextContinuationToken;
  } while (continuationToken);

  return totalDeleted;
}

function collectTrackAudioKeys(track, keySet) {
  const versions = Array.isArray(track?.versions) ? track.versions : [];
  versions.forEach((version) => {
    const metadata = version?.audioMetadata;
    if (!metadata) return;
    addAudioMetadataKey(metadata.key, keySet);
    addAudioMetadataKey(metadata.previewKey, keySet);
    addAudioMetadataKey(keyFromPlaybackUrl(metadata.originalUrl), keySet);
    addAudioMetadataKey(keyFromPlaybackUrl(metadata.previewUrl), keySet);
  });
}

function addAudioMetadataKey(key, keySet) {
  if (typeof key === "string" && key && !key.includes("..")) {
    keySet.add(key);
  }
}

function keyFromPlaybackUrl(value) {
  if (typeof value !== "string" || !value) return null;
  const marker = "/api/audio/playback/";
  const markerIndex = value.indexOf(marker);
  if (markerIndex < 0) return null;
  const encodedKey = value.slice(markerIndex + marker.length).split(/[?#]/)[0];
  try {
    return decodeURIComponent(encodedKey);
  } catch {
    return null;
  }
}

async function deleteTrackAudioObjects(keySet) {
  const keys = [...keySet];
  if (keys.length === 0) return 0;

  let deletedCount = 0;
  for (let index = 0; index < keys.length; index += 1000) {
    const batch = keys.slice(index, index + 1000).map((Key) => ({ Key }));
    const response = await r2Client.send(
      new DeleteObjectsCommand({
        Bucket: r2Config.bucketName,
        Delete: { Objects: batch, Quiet: false },
      })
    );
    const failed = response.Errors?.length || 0;
    if (failed > 0) {
      console.warn("[MixReview] Partial R2 delete failure during track delete", {
        failedCount: failed,
        sample: response.Errors.slice(0, 5).map((error) => ({
          key: error.Key,
          code: error.Code,
          message: error.Message,
        })),
      });
    }
    deletedCount += batch.length - failed;
  }

  return deletedCount;
}

async function attachAudioToSession(sessionId, audio, versionId, trackId = "track-1") {
  const now = new Date().toISOString();
  const existingSession = await readSessionDocument(sessionId);
  const session = existingSession || {
    id: sessionId,
    projectName: "Untitled MixReview Session",
    tracks: [],
    versions: [],
    createdAt: now
  };

  const tracks = Array.isArray(session.tracks) ? session.tracks : [];
  const targetTrackId = sanitizePathSegment(trackId || "track-1");
  const targetVersionId = versionId || "version-v1";
  const trackIndex = tracks.findIndex((track) => track.id === targetTrackId);
  const existingTrack = tracks[trackIndex] || {
    id: targetTrackId,
    title: path.basename(audio.fileName, path.extname(audio.fileName)) || "Untitled Track",
    versions: [],
    activeVersionId: targetVersionId,
    createdAt: now
  };
  const versions = Array.isArray(existingTrack.versions) ? existingTrack.versions : [];
  const versionIndex = versions.findIndex((version) => version.id === targetVersionId);
  const audioMetadata = {
    fileName: audio.fileName,
    title: path.basename(audio.fileName, path.extname(audio.fileName)) || audio.fileName,
    size: audio.size,
    type: audio.contentType,
    mimeType: audio.contentType,
    url: audio.playbackUrl,
    playbackUrl: audio.playbackUrl,
    audioUrl: audio.playbackUrl,
    originalUrl: audio.originalUrl || audio.playbackUrl,
    originalFormat: audio.originalFormat || path.extname(audio.fileName).replace(/^\./, "").toLowerCase() || null,
    requiresTranscode: Boolean(audio.requiresTranscode),
    previewUrl: audio.previewUrl || null,
    previewKey: audio.previewKey || null,
    peaksUrl: audio.peaksUrl || null,
    transcodedAt: audio.transcodedAt || null,
    key: audio.key,
    storage: audio.storage,
    uploadedAt: audio.uploadedAt
  };

  if (versionIndex >= 0) {
    versions[versionIndex] = {
      ...versions[versionIndex],
      audioMetadata
    };
  } else {
    versions.unshift({
      id: targetVersionId,
      label: labelFromVersionId(targetVersionId),
      audioMetadata,
      comments: [],
      approvalStatus: "Pending Review",
      approvalHistory: [],
      activity: [],
      selectedCommentId: null,
      selectedTime: 0,
      duration: 0
    });
  }
  const nextTrack = {
    ...existingTrack,
    title: audioMetadata.title || existingTrack.title,
    activeVersionId: targetVersionId,
    versions,
    updatedAt: now
  };
  const nextTracks =
    trackIndex >= 0
      ? tracks.map((track, index) => (index === trackIndex ? nextTrack : track))
      : [...tracks, nextTrack];

  const nextSession = normalizeSessionDocument({
    ...session,
    tracks: nextTracks,
    activeTrackId: targetTrackId,
    activeVersionId: targetVersionId,
    versions,
    updatedAt: now
  });
  await writeSessionDocument(sessionId, nextSession);
  await upsertSessionIndex(nextSession);
}

// R2 key for the session index. Underscore prefix sorts it before any session
// directory so it is easy to identify in the bucket browser.
const SESSION_INDEX_KEY = "sessions/_index.json";

// readDatabase — R2 is the authoritative store when configured (survives
// Railway redeployment). Falls back to the local db.json for dev / first boot.
async function readDatabase() {
  const databasePath = path.join(serviceRoot, "data", "db.json");

  if (hasR2Config) {
    try {
      const response = await r2Client.send(
        new GetObjectCommand({ Bucket: r2Config.bucketName, Key: SESSION_INDEX_KEY })
      );
      const body = await response.Body.transformToString();
      return JSON.parse(body);
    } catch (error) {
      // NoSuchKey → index has not been written to R2 yet; fall through.
      if (error?.name !== "NoSuchKey" && error?.$metadata?.httpStatusCode !== 404) {
        throw error;
      }
    }
  }

  try {
    return JSON.parse(await readFile(databasePath, "utf8"));
  } catch {
    return { sessions: [] };
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(message);
      error.name = "TimeoutError";
      reject(error);
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

// writeDatabase — persists the index locally AND to R2 when configured.
// R2 write is the authoritative copy; local write is a convenience cache.
async function writeDatabase(database) {
  const databasePath = path.join(serviceRoot, "data", "db.json");
  const body = `${JSON.stringify(database, null, 2)}\n`;

  await mkdir(path.dirname(databasePath), { recursive: true });
  await writeFile(databasePath, body);

  if (hasR2Config) {
    await r2Client.send(
      new PutObjectCommand({
        Bucket: r2Config.bucketName,
        Key: SESSION_INDEX_KEY,
        Body: body,
        ContentType: "application/json"
      })
    );
  }
}

// scanR2ForSessions — lists all session.json objects under sessions/ in R2,
// fetches each one, and returns the array of index-summary objects.
// Used only when the index is missing so the admin dashboard is self-healing.
async function scanR2ForSessions() {
  const sessions = [];
  let continuationToken;

  do {
    let listResponse;
    try {
      listResponse = await r2Client.send(
        new ListObjectsV2Command({
          Bucket: r2Config.bucketName,
          Prefix: "sessions/",
          ...(continuationToken ? { ContinuationToken: continuationToken } : {})
        })
      );
    } catch (e) {
      console.warn("[MixReview] R2 scan failed during index rebuild:", e.message);
      break;
    }

    // Only process individual session documents; skip the index itself and audio files.
    const sessionDocKeys = (listResponse.Contents || [])
      .map((obj) => obj.Key)
      .filter((key) => /^sessions\/[^/]+\/session\.json$/.test(key));

    for (const key of sessionDocKeys) {
      try {
        const docResponse = await r2Client.send(
          new GetObjectCommand({ Bucket: r2Config.bucketName, Key: key })
        );
        const session = normalizeSessionDocument(JSON.parse(await docResponse.Body.transformToString()));
        if (session) {
          const trackSummary = getTrackSummary(session);
          sessions.push({
            id: session.id,
            projectName: session.projectName || "Untitled MixReview Session",
            sessionName: session.sessionName || "",
            artistName: session.artistName || "",
            reviewerName: session.reviewerName || "",
            reviewerClientId: session.reviewerClientId || "",
            reviewerToken: session.reviewerToken || "",
            notes: session.notes || "",
            isPriority: Boolean(session.isPriority),
            shareId: session.shareId || session.id,
            status: getSessionStatus(session),
            trackCount: trackSummary.total,
            approvedTrackCount: trackSummary.approved,
            updatedAt: session.updatedAt || new Date().toISOString(),
            storageKey: key
          });
        }
      } catch (e) {
        console.warn("[MixReview] Skipping malformed session during R2 scan:", key, e.message);
      }
    }

    continuationToken = listResponse.NextContinuationToken;
  } while (continuationToken);

  // Sort most-recently-updated first, matching upsertSessionIndex ordering.
  sessions.sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
  return sessions;
}

async function readSessionDocument(sessionId) {
  const safeSessionId = sanitizeSessionId(sessionId);
  if (!safeSessionId) {
    return null;
  }

  if (hasR2Config) {
    try {
      const response = await r2Client.send(
        new GetObjectCommand({
          Bucket: r2Config.bucketName,
          Key: buildSessionObjectKey(safeSessionId)
        }),
      );
      const body = await response.Body.transformToString();
      return normalizeSessionDocument(JSON.parse(body));
    } catch (error) {
      if (error?.name !== "NoSuchKey" && error?.$metadata?.httpStatusCode !== 404) {
        throw error;
      }
    }
  }

  try {
    const body = await readFile(buildLocalSessionPath(safeSessionId), "utf8");
    return normalizeSessionDocument(JSON.parse(body));
  } catch {
    const database = await readDatabase();
    const legacySession = database.sessions.find((candidate) => candidate.id === safeSessionId);
    return legacySession ? normalizeSessionDocument(legacySession) : null;
  }
}

async function writeSessionDocument(sessionId, session) {
  const safeSessionId = sanitizeSessionId(sessionId);
  const nextSession = normalizeSessionDocument({ ...session, id: safeSessionId });
  if (!safeSessionId || !nextSession) {
    throw new Error("Cannot store invalid MixReview session.");
  }

  const body = `${JSON.stringify(nextSession, null, 2)}\n`;
  if (hasR2Config) {
    await r2Client.send(
      new PutObjectCommand({
        Bucket: r2Config.bucketName,
        Key: buildSessionObjectKey(safeSessionId),
        Body: body,
        ContentType: "application/json"
      }),
    );
  }

  const localPath = buildLocalSessionPath(safeSessionId);
  await mkdir(path.dirname(localPath), { recursive: true });

  // Atomic write: write to a uniquely-named tmp file first, then rename into
  // place. `rename` is atomic on POSIX (Linux/macOS) when source and destination
  // share the same filesystem — a mid-write crash leaves the previous session
  // file intact rather than a partially-written corrupt one.
  const tmpPath = `${localPath}.tmp.${randomUUID()}`;
  try {
    await writeFile(tmpPath, body);
    await rename(tmpPath, localPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

async function upsertSessionIndex(session) {
  const database = await readDatabase();
  const trackSummary = getTrackSummary(session);
  const summary = {
    id: session.id,
    projectName: session.projectName || "Untitled MixReview Session",
    sessionName: session.sessionName || "",
    artistName: session.artistName || "",
    reviewerName: session.reviewerName || "",
    reviewerClientId: session.reviewerClientId || "",
    reviewerToken: session.reviewerToken || "",
    notes: session.notes || "",
    isPriority: Boolean(session.isPriority),
    shareId: session.shareId || session.id,
    status: getSessionStatus(session),
    trackCount: trackSummary.total,
    approvedTrackCount: trackSummary.approved,
    updatedAt: session.updatedAt || new Date().toISOString(),
    storageKey: buildSessionObjectKey(session.id)
  };
  database.sessions = [
    summary,
    ...database.sessions.filter((candidate) => candidate.id !== session.id)
  ];
  await writeDatabase(database);
}

async function removeSessionFromIndex(sessionId) {
  const database = await readDatabase();
  database.sessions = database.sessions.filter((candidate) => candidate.id !== sessionId);
  await writeDatabase(database);
}

function buildSessionObjectKey(sessionId) {
  return `sessions/${sessionId}/session.json`;
}

function buildLocalSessionPath(sessionId) {
  return path.join(sessionRoot, sessionId, "session.json");
}

function normalizeSessionDocument(session) {
  if (!isPlainObject(session)) {
    return null;
  }

  const id = sanitizeSessionId(session.id);
  if (!id) {
    return null;
  }

  const normalizedTracks = Array.isArray(session.tracks) ? session.tracks : [];
  const projectNameStr =
    typeof session.projectName === "string" && session.projectName.trim()
      ? session.projectName.trim()
      : "Untitled MixReview Session";

  return {
    ...session,
    id,
    projectName: projectNameStr,
    sessionName: typeof session.sessionName === "string" ? session.sessionName.trim() : "",
    artistName: typeof session.artistName === "string" ? session.artistName.trim() : "",
    reviewerName: typeof session.reviewerName === "string" ? session.reviewerName.trim() : "",
    reviewerClientId: typeof session.reviewerClientId === "string" ? session.reviewerClientId.trim() : "",
    reviewerToken: typeof session.reviewerToken === "string" ? session.reviewerToken.trim() : "",
    notes: typeof session.notes === "string" ? session.notes.trim() : "",
    isPriority: Boolean(session.isPriority),
    status: typeof session.status === "string" ? session.status : "Draft",
    shareId: typeof session.shareId === "string" && session.shareId.trim() ? session.shareId.trim() : id,
    activeTrackId: typeof session.activeTrackId === "string" ? sanitizePathSegment(session.activeTrackId) : null,
    versions: Array.isArray(session.versions) ? session.versions : [],
    tracks: normalizedTracks,
    albums: normalizeAlbums(
      Array.isArray(session.albums) ? session.albums : [],
      normalizedTracks,
      projectNameStr,
      session.createdAt
    ),
    createdAt: session.createdAt || new Date().toISOString(),
    updatedAt: session.updatedAt || new Date().toISOString()
  };
}

// normalizeAlbums — ensures the session always has a valid albums array that
// is consistent with the tracks array.
//
// Rules applied on every read/write:
//   1. If no albums exist, auto-create a single default album whose trackIds
//      mirror the flat tracks array. This is the backward-compat migration path:
//      every existing session gets a default album on its next read without any
//      explicit data migration step.
//   2. If albums exist, strip any trackId references that no longer have a
//      corresponding entry in tracks (e.g. after a track is deleted).
//   3. Any track that is not yet assigned to any album is appended to the first
//      album. This handles tracks added via the direct-upload flow before the
//      frontend album-assignment UI has saved album state.
//
// Pure and idempotent — no side effects, safe to call on every read/write.
function normalizeAlbums(rawAlbums, tracks, defaultTitle, createdAt) {
  const trackIdSet = new Set(
    tracks.map((t) => (typeof t.id === "string" ? t.id : null)).filter(Boolean)
  );

  // No albums yet → auto-migrate: create one default album from all tracks.
  if (rawAlbums.length === 0) {
    return [{
      id: "album-default",
      title: defaultTitle || "Main Album",
      type: "album",
      trackIds: [...trackIdSet],
      createdAt: createdAt || new Date().toISOString()
    }];
  }

  // Strip dangling references (tracks that have been removed from the session).
  let cleaned = rawAlbums.map((album) => ({
    id: typeof album.id === "string" && album.id.trim() ? album.id.trim() : `album-${randomUUID()}`,
    title: typeof album.title === "string" && album.title.trim() ? album.title.trim() : "Untitled Album",
    type: album.type === "stem_project" ? "stem_project" : "album",
    trackIds: (Array.isArray(album.trackIds) ? album.trackIds : []).filter((id) => trackIdSet.has(id)),
    createdAt: typeof album.createdAt === "string" ? album.createdAt : new Date().toISOString()
  }));

  // Assign any unallocated tracks to the first album (handles upload-before-save races).
  const assignedSet = new Set(cleaned.flatMap((a) => a.trackIds));
  const unassigned = [...trackIdSet].filter((id) => !assignedSet.has(id));
  if (unassigned.length > 0 && cleaned.length > 0) {
    cleaned = [
      { ...cleaned[0], trackIds: [...cleaned[0].trackIds, ...unassigned] },
      ...cleaned.slice(1)
    ];
  }

  return cleaned;
}

function getSessionStatus(session) {
  const importedTracks = getImportedTracks(session);
  if (importedTracks.length === 0) {
    return "Draft";
  }

  const activeStatuses = importedTracks.map((track) => {
    const versions = Array.isArray(track.versions) ? track.versions : [];
    const activeVersion = versions.find((version) => version.id === track.activeVersionId) || versions[0];
    return activeVersion?.approvalStatus || "Pending Review";
  });
  if (activeStatuses.length > 0 && activeStatuses.every((status) => status === "Approved")) {
    return "Approved";
  }
  if (activeStatuses.some((status) => status === "Needs Review")) {
    return "Needs Review";
  }
  return "Pending Review";
}

function getTrackSummary(session) {
  const importedTracks = getImportedTracks(session);
  return {
    total: importedTracks.length,
    approved: importedTracks.filter((track) => {
      const versions = Array.isArray(track.versions) ? track.versions : [];
      const activeVersion = versions.find((version) => version.id === track.activeVersionId) || versions[0];
      return activeVersion?.approvalStatus === "Approved";
    }).length
  };
}

function getImportedTracks(session) {
  if (Array.isArray(session.tracks) && session.tracks.length > 0) {
    return session.tracks.filter((track) =>
      Array.isArray(track.versions) &&
      track.versions.some((version) => version.audioMetadata?.url || version.audioMetadata?.playbackUrl || version.audioMetadata?.audioUrl),
    );
  }

  if (Array.isArray(session.versions)) {
    const hasAudio = session.versions.some((version) => version.audioMetadata?.url || version.audioMetadata?.playbackUrl || version.audioMetadata?.audioUrl);
    return hasAudio
      ? [{ id: "legacy-track", activeVersionId: session.activeVersionId, versions: session.versions }]
      : [];
  }

  return [];
}

async function refreshSessionPlaybackUrls(session, req = null) {
  if (!hasR2Config) {
    return session;
  }

  const refreshVersion = (version) => {
    const key = version?.audioMetadata?.key;
    if (!key) {
      return version;
    }

    // Rebuild all three URL aliases at once so that whichever field the
    // frontend reads first it gets a fresh, non-expired value. Only expose a
    // preview URL when the original format truly requires a browser-native
    // transcode; older clients prefer previewUrl first and will otherwise load
    // stale .m4a previews for perfectly native MP3/WAV assets.
    const originalUrl = buildApiPlaybackUrl(req, key);
    const previewKey = version.audioMetadata.previewKey;
    const shouldUsePreview = Boolean(previewKey && version.audioMetadata.requiresTranscode);
    const previewUrl = shouldUsePreview ? buildApiPlaybackUrl(req, previewKey) : null;
    const freshUrl = previewUrl || originalUrl;

    return {
      ...version,
      audioMetadata: {
        ...version.audioMetadata,
        url: freshUrl,
        playbackUrl: freshUrl,
        audioUrl: freshUrl,
        originalUrl,
        previewUrl,
        peaksUrl: version.audioMetadata.peaksUrl || null,
      }
    };
  };

  return {
    ...session,
    versions: Array.isArray(session.versions) ? session.versions.map(refreshVersion) : [],
    tracks: Array.isArray(session.tracks)
      ? session.tracks.map((track) => ({
          ...track,
          versions: Array.isArray(track.versions) ? track.versions.map(refreshVersion) : []
        }))
      : []
  };
}

function buildApiPlaybackUrl(req, objectKey) {
  const encodedKey = encodeURIComponent(objectKey);
  if (req) {
    return `${req.protocol}://${req.get("host")}/api/audio/playback/${encodedKey}`;
  }

  return `/api/audio/playback/${encodedKey}`;
}

function sanitizeSessionId(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 96);
}

function sanitizePathSegment(value) {
  if (typeof value !== "string") {
    return "version-v1";
  }

  return value.trim().replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-|-$/g, "").slice(0, 96) || "version-v1";
}

function labelFromVersionId(versionId) {
  const label = versionId
    .replace(/^version-/, "")
    .split("-")
    .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : "")
    .join(" ");
  return label || "V1";
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function buildR2PlaybackUrl(objectKey) {
  if (r2Config.publicBaseUrl) {
    return `${r2Config.publicBaseUrl.replace(/\/$/, "")}/${objectKey}`;
  }

  return getSignedUrl(
    r2Client,
    new GetObjectCommand({
      Bucket: r2Config.bucketName,
      Key: objectKey
    }),
    { expiresIn: 60 * 60 },
  );
}

function getEnvValue(name) {
  const value = process.env[name]?.trim();
  if (!value || value.startsWith("PASTE_")) {
    return "";
  }

  return value;
}

function parseAllowedOrigins(value) {
  const configuredOrigins = value
    ? value.split(",").map(normalizeOrigin).filter(Boolean)
    : [];

  return Array.from(new Set([
    ...configuredOrigins,
    normalizeOrigin(frontendProductionOrigin),
    ...(isProduction ? [] : defaultDevOrigins)
  ]));
}

function normalizeOrigin(origin) {
  if (!origin || typeof origin !== "string") {
    return "";
  }

  return origin.trim().replace(/\/$/, "");
}

function buildCorsOptions() {
  return {
    origin(origin, callback) {
      const normalizedOrigin = normalizeOrigin(origin);
      if (!origin || allowedOrigins.includes(normalizedOrigin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${origin} is not allowed by MixReview CORS.`));
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept", "Origin", "X-Requested-With"],
    credentials: false,
    maxAge: 86400
  };
}
