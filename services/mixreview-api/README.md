# MixReview API

Local Node/Express backend for the Phase 1 MixReview MVP.

## Responsibilities

- Prepare review-session audio uploads for cloud storage.
- Accept stereo WAV/MP3 upload files.
- Store audio in Cloudflare R2 when configured.
- Serve local uploaded audio files as a development fallback only.
- Keep JSON persistence in `data/db.json` for local-only app state experiments.
- Expose session-scoped API routes under `/api/sessions`.
- Restrict browser access with production CORS origins.

## Planned Endpoints

- `GET /health`
- `POST /api/audio/upload`
- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/:sessionId`
- `POST /api/sessions/:sessionId/audio`
- `POST /api/sessions/:sessionId/comments`
- `PATCH /api/sessions/:sessionId/comments/:commentId`
- `PATCH /api/sessions/:sessionId/status`

## Storage

- R2 uploads: configured with S3-compatible Cloudflare R2 credentials.
- Local fallback uploads: `storage/uploads`
- JSON database: `data/db.json`

In production (`NODE_ENV=production`), R2 credentials are required and the API
will fail fast if they are missing.

## Deployment

Railway can deploy this service from `services/mixreview-api` using
`railway.toml`.

Set these production variables in Railway:

- `NODE_ENV=production`
- `PORT` supplied by Railway
- `CORS_ORIGINS=https://mixreview.kingzbreadent.com`
- `CLIENT_ORIGIN=https://mixreview.kingzbreadent.com`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_R2_BUCKET=mixreview-audio`
- `CLOUDFLARE_R2_ACCESS_KEY_ID`
- `CLOUDFLARE_R2_SECRET_ACCESS_KEY`
- `R2_PUBLIC_BASE_URL` optional

## R2 Configuration

Copy `.env.example` to `.env` locally, or provide these variables in your
deployment environment:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_R2_BUCKET`
- `R2_PUBLIC_BASE_URL` optional, used to return stable public object URLs
- `CLOUDFLARE_R2_ACCESS_KEY_ID`
- `CLOUDFLARE_R2_SECRET_ACCESS_KEY`

Cloudflare's R2 upload data plane is S3-compatible. MixReview uploads use only
the R2 Access Key ID and Secret Access Key against:
`https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com`.

If the required R2 values are absent, uploads fall back to local disk storage
and return `/uploads/...` playback URLs. If R2 is configured without
`R2_PUBLIC_BASE_URL`, the API returns a one-hour presigned playback URL.

## Audio Upload

Use multipart form data with field name `audio`.

```bash
curl -F "audio=@mix.wav" http://localhost:4301/api/audio/upload
curl -F "audio=@mix.mp3" http://localhost:4301/api/sessions/session-123/audio
```

The endpoint accepts stereo WAV or stereo MP3 only and returns:

- `storage`: `r2` or `local`
- `key`: object key/path
- `playbackUrl`: R2 public URL, presigned R2 URL, or local `/uploads/...`
- `fileName`, `contentType`, and `size`
