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

  const response = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(session.id)}`), {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ session })
  });

  if (!response.ok) {
    throw new Error("Session could not be saved.");
  }

  const payload = await response.json();
  return payload.session || null;
}

export async function uploadSessionAudio(sessionId, versionId, file) {
  const formData = new FormData();
  formData.append("audio", file);
  formData.append("versionId", versionId);

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
