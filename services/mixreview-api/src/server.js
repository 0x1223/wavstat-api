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

app.use("/api/sessions", sessionRouter);
app.post("/api/audio/upload", upload.single("audio"), handleAudioUpload);
app.post("/api/get-presigned-url", requireAdminAuth, getPresignedUploadUrl);

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

    const validation = validateStereoReviewAudio(audioFile);
    if (!validation.ok) {
      return res.status(415).json({ error: validation.error });
    }

    const sessionId = sanitizeSessionId(req.params.sessionId);
    const trackId = sanitizePathSegment(req.body?.trackId || "track-1");
    const versionId = sanitizePathSegment(req.body?.versionId || "version-v1");
    const objectKey = buildAudioObjectKey(audioFile.originalname, validation.extension, {
      sessionId,
      trackId,
      versionId
    });
    const storageResult = hasR2Config
      ? await uploadAudioToR2(objectKey, audioFile, validation.contentType, req)
      : await saveAudioLocally(objectKey, audioFile, req);
    const audioPayload = {
      key: objectKey,
      playbackUrl: storageResult.playbackUrl,
      peaksUrl: storageResult.peaksUrl || null,
      fileName: audioFile.originalname,
      contentType: validation.contentType,
      size: audioFile.size,
      storage: storageResult.storage,
      uploadedAt: new Date().toISOString()
    };

    if (sessionId) {
      await attachAudioToSession(sessionId, audioPayload, versionId, trackId);
    }

    console.log("[MixReview] Upload stored", {
      fileName: audioFile.originalname,
      contentType: validation.contentType,
      storage: storageResult.storage,
      key: objectKey,
      playbackUrl: storageResult.playbackUrl.slice(0, 120),
    });

    return res.status(201).json({
      ok: true,
      storage: storageResult.storage,
      key: objectKey,
      playbackUrl: storageResult.playbackUrl,
      peaksUrl: storageResult.peaksUrl || null,
      fileName: audioFile.originalname,
      sessionId: sessionId || null,
      trackId,
      versionId,
      contentType: validation.contentType,
      size: audioFile.size
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

  const peaksKey = `${objectKey}.peaks.json`;
  const peaksUrl = buildApiPlaybackUrl(req, peaksKey);

  // Non-blocking: generate and upload peaks after the audio is already in R2.
  // Errors are logged but never surface to the caller.
  generateAndUploadPeaks(audioFile.buffer, peaksKey).catch((err) => {
    console.error("[MixReview] Peaks generation failed", { objectKey, error: err.message });
  });

  return {
    storage: "r2",
    playbackUrl: buildApiPlaybackUrl(req, objectKey),
    peaksUrl
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

    const { fileName, fileType } = req.body || {};

    if (!fileName || typeof fileName !== "string" || !fileName.trim()) {
      return res.status(400).json({ error: "fileName is required." });
    }
    if (!fileType || typeof fileType !== "string" || !fileType.trim()) {
      return res.status(400).json({ error: "fileType is required." });
    }

    // Build a sanitised object key that cannot escape the uploads/ prefix.
    const extension   = path.extname(fileName).toLowerCase();
    const safeBase    = path
      .basename(fileName, path.extname(fileName))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "upload";
    const objectKey   = `uploads/${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${safeBase}${extension}`;

    // ContentType is embedded in the presigned URL signature — the browser MUST
    // send the exact same value as the Content-Type request header when it PUTs
    // the file, otherwise R2 returns 403 SignatureDoesNotMatch.
    const command = new PutObjectCommand({
      Bucket:      r2Config.bucketName,
      Key:         objectKey,
      ContentType: fileType.trim(),
    });

    // 15-minute window — long enough for a large file on a slow connection
    // without leaving a stale URL live for hours.
    const url = await getSignedUrl(r2Client, command, { expiresIn: 900 });

    console.log("[MixReview] Pre-signed upload URL issued", {
      objectKey,
      fileType: fileType.trim(),
      expiresIn: 900,
    });

    // Return the key alongside the URL so the client can pass it back to the
    // session save route once the direct upload completes.
    return res.json({ url, key: objectKey });
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

// Map file extensions to MIME types for content-type fallback when R2 omits the header.
const AUDIO_MIME_BY_EXT = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  flac: "audio/flac",
};

async function streamAudioPlayback(req, res, next) {
  try {
    const objectKey = decodeURIComponent(req.params.encodedKey || "");
    if (!objectKey || objectKey.includes("..")) {
      return res.status(400).json({ error: "Valid audio key is required." });
    }

    // Derive a content-type from the file extension as a guaranteed fallback.
    const extMatch = objectKey.match(/\.([a-z0-9]+)(?:\?|$)/i);
    const extContentType = extMatch ? (AUDIO_MIME_BY_EXT[extMatch[1].toLowerCase()] ?? null) : null;

    console.log("[MixReview] Playback request", {
      objectKey,
      extension: extMatch?.[1] ?? "(none)",
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

    // Prefer R2's stored ContentType; fall back to extension-derived type;
    // last resort application/octet-stream.
    const contentType = response.ContentType || extContentType || "application/octet-stream";
    res.setHeader("Content-Type", contentType);

    console.log("[MixReview] Playback serving", { objectKey, contentType, statusCode });

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

function validateStereoReviewAudio(audioFile) {
  const extension = path.extname(audioFile.originalname).toLowerCase();
  const isWav = extension === ".wav" || audioFile.mimetype === "audio/wav" || audioFile.mimetype === "audio/x-wav";
  const isMp3 = extension === ".mp3" || audioFile.mimetype === "audio/mpeg" || audioFile.mimetype === "audio/mp3";

  if (!isWav && !isMp3) {
    return {
      ok: false,
      error: "Only stereo WAV or MP3 files are supported."
    };
  }

  if (isWav && !isStereoWav(audioFile.buffer)) {
    return {
      ok: false,
      error: "WAV uploads must be stereo."
    };
  }

  if (isMp3 && !isStereoMp3(audioFile.buffer)) {
    return {
      ok: false,
      error: "MP3 uploads must be stereo."
    };
  }

  return {
    ok: true,
    extension: isWav ? ".wav" : ".mp3",
    contentType: isWav ? "audio/wav" : "audio/mpeg"
  };
}

function isStereoWav(buffer) {
  if (buffer.length < 36 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return false;
  }

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === "fmt " && offset + 12 <= buffer.length) {
      return buffer.readUInt16LE(offset + 10) === 2;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }

  return false;
}

function isStereoMp3(buffer) {
  let offset = skipId3v2Header(buffer);
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] === 0xff && (buffer[offset + 1] & 0xe0) === 0xe0) {
      const layerBits = (buffer[offset + 1] >> 1) & 0x03;
      const bitrateBits = (buffer[offset + 2] >> 4) & 0x0f;
      const sampleRateBits = (buffer[offset + 2] >> 2) & 0x03;
      if (layerBits !== 0 && bitrateBits !== 0 && bitrateBits !== 0x0f && sampleRateBits !== 0x03) {
        const channelMode = (buffer[offset + 3] >> 6) & 0x03;
        return channelMode !== 0x03;
      }
    }
    offset += 1;
  }

  return false;
}

function skipId3v2Header(buffer) {
  if (buffer.length < 10 || buffer.toString("ascii", 0, 3) !== "ID3") {
    return 0;
  }

  return 10 + readSynchsafeInt(buffer, 6);
}

function readSynchsafeInt(buffer, offset) {
  return (
    ((buffer[offset] & 0x7f) << 21) |
    ((buffer[offset + 1] & 0x7f) << 14) |
    ((buffer[offset + 2] & 0x7f) << 7) |
    (buffer[offset + 3] & 0x7f)
  );
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

async function listSessions(_req, res) {
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

  res.json({ sessions: database.sessions });
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

async function getSession(req, res) {
  const sessionId = sanitizeSessionId(req.params.sessionId);
  const session = sessionId ? await readSessionDocument(sessionId) : null;
  if (!session) {
    return res.status(404).json({ error: "Session not found." });
  }

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

          if (storedHasKey && (incomingLostKey || incomingLostUrl)) {
            console.log("[MixReview] preserveAudioMetadata: restored stored key for", {
              trackId: incomingTrack.id,
              versionId: incomingVersion.id,
              storedKey: storedMeta.key,
            });
            return { ...incomingVersion, audioMetadata: storedMeta };
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

async function deleteSession(req, res) {
  const sessionId = sanitizeSessionId(req.params.sessionId);
  if (!sessionId) {
    return res.status(400).json({ error: "Valid session id is required." });
  }

  // Step 1 — remove from the index first.
  // This is the authoritative step: the session will not reappear in the admin
  // dashboard or be accessible through the API regardless of what follows.
  await removeSessionFromIndex(sessionId);

  // Step 2 — delete the local session file (dev / cache; best-effort).
  const localPath = buildLocalSessionPath(sessionId);
  try {
    await unlink(localPath);
  } catch {
    // Local file may not exist; index removal is the authoritative step.
  }

  // Step 3 — purge ALL R2 objects under sessions/{sessionId}/.
  // This removes session.json, every audio file, and any other nested assets
  // so nothing is orphaned in object storage after deletion.
  // Failures are caught and logged separately; the session remains deleted
  // because the index was already updated in step 1.
  if (hasR2Config) {
    try {
      const purgedCount = await purgeSessionFromR2(sessionId);
      console.log(`[MixReview] R2 purge complete for session ${sessionId}: ${purgedCount} object(s) deleted`);
    } catch (e) {
      // Storage cleanup failed — log it, but do not surface it to the caller.
      // The session is gone from the index; it will never reappear in the app.
      // Orphaned objects can be cleaned up manually or by a future lifecycle rule.
      console.error(`[MixReview] R2 purge failed for session ${sessionId} — objects may remain in storage:`, e.message);
    }
  }

  return res.json({ ok: true, deleted: sessionId });
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

  return {
    ...session,
    id,
    projectName:
      typeof session.projectName === "string" && session.projectName.trim()
        ? session.projectName.trim()
        : "Untitled MixReview Session",
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
    tracks: Array.isArray(session.tracks) ? session.tracks : [],
    createdAt: session.createdAt || new Date().toISOString(),
    updatedAt: session.updatedAt || new Date().toISOString()
  };
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
    // frontend reads first (normalizeAudioUrl priority: playbackUrl →
    // audioUrl → url) it always gets a fresh, non-expired value.
    const freshUrl = buildApiPlaybackUrl(req, key);

    // Re-derive the peaks URL from the well-known naming convention.
    // peaksKey is never stored separately — it is always ${key}.peaks.json.
    const freshPeaksUrl = buildApiPlaybackUrl(req, `${key}.peaks.json`);

    return {
      ...version,
      audioMetadata: {
        ...version.audioMetadata,
        url: freshUrl,
        playbackUrl: freshUrl,
        audioUrl: freshUrl,
        peaksUrl: freshPeaksUrl,
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
