const STORAGE_KEY = "mixreview.latestSession";
const SHARE_STORAGE_KEY = "mixreview.sharedSessions";
export const EXPORT_SCHEMA_VERSION = 1;
const VERSION_LABELS = ["V1", "V2", "Master", "Radio Edit"];
const APPROVAL_STATES = [
  "Pending Review",
  "Needs Review",
  "Approved"
];
const REVIEWERS = ["Artist", "Engineer", "Manager", "Label"];
const CLIENT_REVIEWERS = ["Artist", "Manager", "Label"];

export function loadLatestSession() {
  try {
    const rawSession = window.localStorage.getItem(STORAGE_KEY);
    return rawSession ? JSON.parse(rawSession) : null;
  } catch {
    return null;
  }
}

export function saveLatestSession(session) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Local persistence is best-effort for the frontend-only MVP.
  }
}

export function clearLatestSession() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Local persistence is best-effort for the frontend-only MVP.
  }
}

export function loadSharedSession(shareId) {
  try {
    const registry = getShareRegistry();
    return registry[shareId]?.session || null;
  } catch {
    return null;
  }
}

export function saveSharedSession(shareId, session) {
  try {
    const registry = getShareRegistry();
    registry[shareId] = {
      id: shareId,
      session,
      updatedAt: new Date().toISOString()
    };
    window.localStorage.setItem(SHARE_STORAGE_KEY, JSON.stringify(registry));
  } catch {
    // Local sharing is best-effort until backend sync exists.
  }
}

export function createShareId() {
  return `shr_${crypto.randomUUID?.() || `${Date.now()}_${Math.random()}`}`;
}

export function getShareRoute() {
  const params = new URLSearchParams(window.location.search);
  const shareId = params.get("share");
  const role = normalizeRole(params.get("role"));

  return shareId ? { role, shareId } : null;
}

export function createShareLink(shareId, role) {
  const url = new URL(window.location.href);
  url.searchParams.set("share", shareId);
  url.searchParams.set("session", shareId);
  url.searchParams.set("role", normalizeRole(role));
  return url.toString();
}

export function toStoredAudioMetadata(audioSource) {
  if (!audioSource) {
    return null;
  }

  const rawUrl = audioSource.playbackUrl || audioSource.audioUrl || audioSource.url || audioSource.objectUrl || null;
  const url = rawUrl?.startsWith("blob:") ? null : rawUrl;

  return {
    fileName: audioSource.fileName,
    title: audioSource.title,
    size: audioSource.size,
    type: audioSource.type,
    url,
    playbackUrl: url,
    audioUrl: url,
    objectUrl: audioSource.objectUrl || null,
    key: audioSource.key || null,
    storage: audioSource.storage || null,
    uploadedAt: audioSource.uploadedAt || null
  };
}

export function createExportSession(session) {
  return {
    schema: "mixreview.session",
    version: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    session
  };
}

function getShareRegistry() {
  const rawRegistry = window.localStorage.getItem(SHARE_STORAGE_KEY);
  return rawRegistry ? JSON.parse(rawRegistry) : {};
}

function normalizeRole(role) {
  return ["editable", "reviewer", "read-only"].includes(role) ? role : "read-only";
}

function normalizeLegacyVersion(candidate) {
  const comments = Array.isArray(candidate.comments)
    ? candidate.comments.map(normalizeComment).filter(Boolean)
    : null;

  if (!comments) {
    return null;
  }

  const approvalHistory = normalizeApprovalHistory(candidate.approvalHistory);
  const approvalStatus = resolveApprovalStatus(
    normalizeApprovalStatus(
      candidate.approvalStatus || candidate.mixStatus,
    ),
    comments,
    approvalHistory,
  );
  if (!approvalStatus) {
    return null;
  }

  const selectedCommentId =
    typeof candidate.selectedCommentId === "string" &&
    comments.some((comment) => comment.id === candidate.selectedCommentId)
      ? candidate.selectedCommentId
      : comments[0]?.id || null;
  const selectedComment = comments.find((comment) => comment.id === selectedCommentId);
  const selectedTime = normalizeNumber(
    candidate.selectedTime,
    selectedComment?.time || 0,
  );
  const duration = normalizeNumber(candidate.duration, 0);

  return ensureVersionSet([
    {
      id: "version-v1",
      label: "V1",
      approvalStatus,
      approvalHistory,
      activity: normalizeActivity(candidate.activity),
      audioMetadata: normalizeAudioMetadata(candidate.audioMetadata),
      comments: comments.sort((a, b) => a.time - b.time),
      selectedCommentId,
      selectedTime,
      duration
    }
  ]);
}

function normalizeVersions(versions) {
  const normalizedVersions = versions.map(normalizeVersion).filter(Boolean);
  return normalizedVersions.length > 0 ? ensureVersionSet(normalizedVersions) : null;
}

function normalizeVersion(version) {
  if (!isPlainObject(version)) {
    return null;
  }

  const label = VERSION_LABELS.includes(version.label) ? version.label : null;
  if (!label) {
    return null;
  }

  const comments = Array.isArray(version.comments)
    ? version.comments.map(normalizeComment).filter(Boolean)
    : [];
  const approvalHistory = normalizeApprovalHistory(version.approvalHistory);
  const approvalStatus = resolveApprovalStatus(
    normalizeApprovalStatus(
      version.approvalStatus || version.mixStatus,
    ),
    comments,
    approvalHistory,
  );
  if (!approvalStatus) {
    return null;
  }

  const selectedCommentId =
    typeof version.selectedCommentId === "string" &&
    comments.some((comment) => comment.id === version.selectedCommentId)
      ? version.selectedCommentId
      : comments[0]?.id || null;
  const selectedComment = comments.find((comment) => comment.id === selectedCommentId);

  return {
    id: normalizeString(version.id, versionIdFromLabel(label)),
    label,
    audioMetadata: normalizeAudioMetadata(version.audioMetadata),
    comments: comments.sort((a, b) => a.time - b.time),
    approvalStatus,
    approvalHistory,
    activity: normalizeActivity(version.activity),
    selectedCommentId,
    selectedTime: normalizeNumber(version.selectedTime, selectedComment?.time || 0),
    duration: normalizeNumber(version.duration, 0)
  };
}

function ensureVersionSet(versions) {
  return VERSION_LABELS.map((label) => {
    const version = versions.find((candidate) => candidate.label === label);
    return version || {
      id: versionIdFromLabel(label),
      label,
      audioMetadata: null,
      comments: [],
      approvalStatus: "Pending Review",
      approvalHistory: [],
      activity: [],
      selectedCommentId: null,
      selectedTime: 0,
      duration: 0
    };
  });
}

function normalizeComment(comment) {
  if (!isPlainObject(comment)) {
    return null;
  }

  const time = normalizeNumber(comment.time, null);
  if (time === null) {
    return null;
  }

  return {
    id: normalizeString(comment.id, `comment-${Date.now()}-${Math.random()}`),
    time,
    author: normalizeString(comment.author, "Reviewer"),
    text: normalizeString(comment.text, "Imported timestamp note."),
    resolved: Boolean(comment.resolved),
    submitted: comment.submitted === false ? false : true
  };
}

function normalizeAudioMetadata(audioMetadata) {
  if (!isPlainObject(audioMetadata)) {
    return null;
  }

  return {
    fileName: normalizeString(audioMetadata.fileName, "Restored audio file"),
    title: normalizeString(audioMetadata.title, "Imported MixReview Session"),
    size: normalizeNumber(audioMetadata.size, 0),
    type: normalizeString(audioMetadata.type, "audio file"),
    url: typeof audioMetadata.url === "string" && audioMetadata.url ? audioMetadata.url : null,
    key: typeof audioMetadata.key === "string" && audioMetadata.key ? audioMetadata.key : null,
    storage: typeof audioMetadata.storage === "string" && audioMetadata.storage ? audioMetadata.storage : null,
    uploadedAt: typeof audioMetadata.uploadedAt === "string" && audioMetadata.uploadedAt ? audioMetadata.uploadedAt : null
  };
}

function normalizeApprovalStatus(status) {
  if (status === "Pending") {
    return "Pending Review";
  }

  if (status === "Needs Revision" || status === "Needs Changes") {
    return "Needs Review";
  }

  return APPROVAL_STATES.includes(status) ? status : null;
}

function resolveApprovalStatus(status, comments, approvalHistory) {
  if (status === "Approved") {
    return status;
  }

  if (approvalHistory.some((event) => event.status === "Approved")) {
    return "Approved";
  }

  const submittedReviewComments = comments.filter(
    (comment) => CLIENT_REVIEWERS.includes(comment.author) && comment.submitted !== false,
  );

  if (submittedReviewComments.length === 0) {
    return status || "Pending Review";
  }

  if (submittedReviewComments.every((comment) => comment.resolved)) {
    return "Approved";
  }

  return "Needs Review";
}

function normalizeApprovalHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history.map(normalizeApprovalEvent).filter(Boolean);
}

function normalizeApprovalEvent(event) {
  if (!isPlainObject(event)) {
    return null;
  }

  const status = normalizeApprovalStatus(event.status);
  if (!status) {
    return null;
  }

  return {
    id: normalizeString(event.id, `approval-${Date.now()}-${Math.random()}`),
    status,
    reviewer: normalizeReviewer(event.reviewer),
    createdAt: normalizeString(event.createdAt, new Date().toISOString())
  };
}

function normalizeActivity(activity) {
  if (!Array.isArray(activity)) {
    return [];
  }

  return activity.map(normalizeActivityItem).filter(Boolean);
}

function normalizeActivityItem(item) {
  if (!isPlainObject(item)) {
    return null;
  }

  return {
    id: normalizeString(item.id, `activity-${Date.now()}-${Math.random()}`),
    label: normalizeString(item.label, "Activity"),
    detail: normalizeString(item.detail, "Session updated"),
    createdAt: normalizeString(item.createdAt, new Date().toISOString())
  };
}

function normalizeReviewer(reviewer) {
  return REVIEWERS.includes(reviewer) ? reviewer : "Engineer";
}

function normalizeString(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function versionIdFromLabel(label) {
  return `version-${label.toLowerCase().replace(/\s+/g, "-")}`;
}
