import { apiUrl } from "../config/api.js";

export async function loadSessionFromApi(sessionId) {
  if (!sessionId) {
    return null;
  }

  const response = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}`));
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error("Session could not be loaded.");
  }

  const payload = await response.json();
  return payload.session || null;
}

export async function listSessionsFromApi() {
  const response = await fetch(apiUrl("/api/sessions"));
  if (!response.ok) {
    throw new Error("Sessions could not be loaded.");
  }

  const payload = await response.json();
  return Array.isArray(payload.sessions) ? payload.sessions : [];
}

export async function saveSessionToApi(session) {
  if (!session?.id) {
    return null;
  }

  // VITE_ADMIN_API_KEY is set in Railway environment variables for the frontend.
  // This project uses Vite — env vars must use the VITE_ prefix and are accessed
  // via import.meta.env (not process.env.REACT_APP_*).
  // The header is only added when the key is present so local dev without the
  // variable configured does not send a broken "Bearer undefined" value.
  const adminKey = import.meta.env.VITE_ADMIN_API_KEY;
  const headers = {
    "Content-Type": "application/json",
    ...(adminKey ? { "Authorization": `Bearer ${adminKey}` } : {})
  };

  const response = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(session.id)}`), {
    method: "PUT",
    headers,
    body: JSON.stringify({ session })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Session could not be saved.");
  }

  const payload = await response.json();
  return payload.session || null;
}

export async function deleteSessionFromApi(sessionId) {
  if (!sessionId) {
    return;
  }

  const response = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}`), {
    method: "DELETE"
  });

  if (!response.ok) {
    throw new Error("Session could not be deleted.");
  }
}

// uploadSessionAudio — direct-to-R2 upload in three steps:
//
//   1. Request a presigned PUT URL from the API (admin-gated).
//      The server builds the R2 object key and embeds it in the URL signature.
//
//   2. PUT the file straight to R2 from the browser — the Node.js server never
//      sees the audio bytes, eliminating the double-pass memory bottleneck.
//
//   3. Confirm with the API so it can attach the audio metadata to the session
//      document and return a playback URL.  The response shape is identical to
//      the old multipart handler so App.jsx needs no changes.
//
// The function signature is unchanged: callers in App.jsx are unaffected.
export async function uploadSessionAudio(sessionId, versionId, file, trackId = null) {
  const adminKey = import.meta.env.VITE_ADMIN_API_KEY;
  const authHeader = adminKey ? { "Authorization": `Bearer ${adminKey}` } : {};

  // ── Step 1: obtain a presigned PUT URL ──────────────────────────────────────
  const presignResponse = await fetch(apiUrl("/api/get-presigned-url"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader },
    body: JSON.stringify({
      fileName:  file.name,
      fileType:  file.type || "audio/mpeg",
      sessionId,
      trackId:   trackId || "track-1",
      versionId
    })
  });

  const presignPayload = await presignResponse.json().catch(() => ({}));
  if (!presignResponse.ok) {
    throw new Error(presignPayload.error || "Could not obtain an upload URL.");
  }

  const { url: presignedUrl, key, resolvedMime } = presignPayload;
  if (!presignedUrl || !key) {
    throw new Error("Server returned an invalid upload URL.");
  }
  const uploadMime = resolvedMime || file.type || "audio/mpeg";

  // ── Step 2: PUT directly to R2 — bypasses the Node.js server entirely ───────
  // Content-Type MUST match the value used when requesting the URL; it is baked
  // into the presigned signature and R2 validates it on every PUT request.
  const r2Response = await fetch(presignedUrl, {
    method:  "PUT",
    headers: { "Content-Type": uploadMime },
    body:    file
  });

  if (!r2Response.ok) {
    throw new Error(`Direct upload to storage failed (HTTP ${r2Response.status}).`);
  }

  // ── Step 3: confirm with the API so it attaches the key to the session ───────
  const confirmResponse = await fetch(
    apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/confirm-audio`),
    {
      method:  "POST",
      headers: { "Content-Type": "application/json", ...authHeader },
      body: JSON.stringify({
        key,
        fileName: file.name,
        fileType: uploadMime,
        size:     file.size,
        trackId:  trackId || "track-1",
        versionId
      })
    }
  );

  const confirmPayload = await confirmResponse.json().catch(() => ({}));
  if (!confirmResponse.ok) {
    throw new Error(confirmPayload.error || "Audio upload could not be confirmed.");
  }

  return confirmPayload;
}
