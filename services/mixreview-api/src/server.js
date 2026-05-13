import express from "express";
import cors from "cors";
import "dotenv/config";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const app = express();
const port = process.env.PORT || 4301;
const isProduction = process.env.NODE_ENV === "production";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(__dirname, "..");
const uploadRoot = path.join(serviceRoot, "storage", "uploads");
const frontendProductionOrigin = "https://mixreview.kingzbreadent.com";
const defaultDevOrigins = ["http://localhost:4300", "http://localhost:4301", "http://localhost:4302"];
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
  publicBaseUrl: getEnvValue("R2_PUBLIC_BASE_URL")
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
      endpoint: `https://${r2Config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: r2Config.accessKeyId,
        secretAccessKey: r2Config.secretAccessKey
      }
    })
  : null;

if (isProduction && !hasR2Config) {
  throw new Error("R2 credentials are required in production.");
}

app.set("trust proxy", 1);
app.use(cors(buildCorsOptions()));
app.use(express.json());
app.use("/uploads", express.static(uploadRoot));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "mixreview-api",
    environment: isProduction ? "production" : "development",
    audioStorage: hasR2Config ? "r2" : "local",
    cloudflareEnvConfigured: hasRequestedCloudflareEnv,
    r2UploadConfigured: hasR2Config,
    allowedOrigins
  });
});

const sessionRouter = express.Router();
sessionRouter.get("/", listSessions);
sessionRouter.post("/", createSession);
sessionRouter.get("/:sessionId", getSession);
sessionRouter.post("/:sessionId/audio", upload.single("audio"), handleAudioUpload);

app.use("/api/sessions", sessionRouter);
app.post("/api/audio/upload", upload.single("audio"), handleAudioUpload);

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: error.message });
  }

  console.error(error);
  return res.status(500).json({ error: "Audio upload failed." });
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

    const validation = validateStereoReviewAudio(audioFile);
    if (!validation.ok) {
      return res.status(415).json({ error: validation.error });
    }

    const objectKey = buildAudioObjectKey(audioFile.originalname, validation.extension);
    const storageResult = hasR2Config
      ? await uploadAudioToR2(objectKey, audioFile, validation.contentType)
      : await saveAudioLocally(objectKey, audioFile, req);
    const audioPayload = {
      key: objectKey,
      playbackUrl: storageResult.playbackUrl,
      fileName: audioFile.originalname,
      contentType: validation.contentType,
      size: audioFile.size,
      storage: storageResult.storage,
      uploadedAt: new Date().toISOString()
    };

    if (req.params.sessionId) {
      await attachAudioToSession(req.params.sessionId, audioPayload);
    }

    return res.status(201).json({
      ok: true,
      storage: storageResult.storage,
      key: objectKey,
      playbackUrl: storageResult.playbackUrl,
      fileName: audioFile.originalname,
      sessionId: req.params.sessionId || null,
      contentType: validation.contentType,
      size: audioFile.size
    });
  } catch (error) {
    next(error);
  }
}

async function uploadAudioToR2(objectKey, audioFile, contentType) {
  await r2Client.send(
    new PutObjectCommand({
      Bucket: r2Config.bucketName,
      Key: objectKey,
      Body: audioFile.buffer,
      ContentLength: audioFile.size,
      ContentType: contentType,
      Metadata: {
        originalName: encodeURIComponent(audioFile.originalname)
      }
    }),
  );

  return {
    storage: "r2",
    playbackUrl: await buildR2PlaybackUrl(objectKey)
  };
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

function buildAudioObjectKey(originalName, extension) {
  const safeBaseName = path
    .basename(originalName, path.extname(originalName))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "mixreview-audio";

  return `${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${safeBaseName}${extension}`;
}

async function listSessions(_req, res) {
  const database = await readDatabase();
  res.json({ sessions: database.sessions });
}

async function createSession(req, res) {
  const database = await readDatabase();
  const now = new Date().toISOString();
  const session = {
    id: req.body?.id || `session-${randomUUID()}`,
    projectName: req.body?.projectName || "Untitled MixReview Session",
    audio: null,
    createdAt: now,
    updatedAt: now
  };

  database.sessions.unshift(session);
  await writeDatabase(database);
  res.status(201).json({ session });
}

async function getSession(req, res) {
  const database = await readDatabase();
  const session = database.sessions.find((candidate) => candidate.id === req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: "Session not found." });
  }

  return res.json({ session });
}

async function attachAudioToSession(sessionId, audio) {
  const database = await readDatabase();
  const now = new Date().toISOString();
  const session = database.sessions.find((candidate) => candidate.id === sessionId);

  if (session) {
    session.audio = audio;
    session.updatedAt = now;
  } else {
    database.sessions.unshift({
      id: sessionId,
      projectName: path.basename(audio.fileName, path.extname(audio.fileName)) || "Untitled MixReview Session",
      audio,
      createdAt: now,
      updatedAt: now
    });
  }

  await writeDatabase(database);
}

async function readDatabase() {
  const databasePath = path.join(serviceRoot, "data", "db.json");
  try {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(databasePath, "utf8"));
  } catch {
    return { sessions: [] };
  }
}

async function writeDatabase(database) {
  const databasePath = path.join(serviceRoot, "data", "db.json");
  const { writeFile: writeDatabaseFile } = await import("node:fs/promises");
  await mkdir(path.dirname(databasePath), { recursive: true });
  await writeDatabaseFile(databasePath, `${JSON.stringify(database, null, 2)}\n`);
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
    ? value.split(",").map((origin) => origin.trim()).filter(Boolean)
    : [];

  return Array.from(new Set([
    ...configuredOrigins,
    frontendProductionOrigin,
    ...(isProduction ? [] : defaultDevOrigins)
  ]));
}

function buildCorsOptions() {
  return {
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${origin} is not allowed by MixReview CORS.`));
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
    maxAge: 86400
  };
}
