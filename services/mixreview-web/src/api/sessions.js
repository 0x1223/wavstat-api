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

export async function uploadSessionAudio(sessionId, versionId, file, trackId = null) {
  const formData = new FormData();
  formData.append("audio", file);
  formData.append("versionId", versionId);
  if (trackId) {
    formData.append("trackId", trackId);
  }

  const response = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/audio`), {
    method: "POST",
    body: formData
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Audio upload failed.");
  }

  return payload;
}
