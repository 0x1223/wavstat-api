import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioUpload } from "./components/AudioUpload.jsx";
import { CommentSidebar } from "./components/CommentSidebar.jsx";
import { Header } from "./components/Header.jsx";
import { ReviewDashboard } from "./components/ReviewDashboard.jsx";
import { SharePanel } from "./components/SharePanel.jsx";
import { SpectrumAnalyzer } from "./components/SpectrumAnalyzer.jsx";
import { StartScreen } from "./components/StartScreen.jsx";
import { TransportBar } from "./components/TransportBar.jsx";
import { WaveformReview } from "./components/WaveformReview.jsx";
import {
  clearLatestSession,
  createShareId,
  createShareLink,
  createExportSession,
  getShareRoute,
  loadLatestSession,
  loadSharedSession,
  saveLatestSession,
  saveSharedSession,
  toStoredAudioMetadata
} from "./storage/projects.js";

const versionLabels = ["V1", "V2", "Master", "Radio Edit"];
const approvalStates = [
  "Pending Review",
  "Needs Review",
  "Approved"
];
const reviewerIdentities = ["Artist", "Engineer", "Manager", "Label"];
const clientReviewerIdentities = ["Artist", "Manager", "Label"];
// TODO: Real production admin auth, password handling, and 2FA must be backend-based later.
const MIXREVIEW_ADMIN_DEV_PASSWORD = "kingzreview";
const ADMIN_UNLOCK_SESSION_KEY = "mixreview.engineerUnlocked";

const emptyProjectName = "Untitled MixReview Session";

const routeParams = new URLSearchParams(window.location.search);
const shareRoute = getShareRoute();
const routeMode = routeParams.get("mode");
const routeVersionId = routeParams.get("version");
const forceStartScreen = routeParams.has("start");
const latestSession = loadLatestSession();
const restoredSession = shareRoute
  ? loadSharedSession(shareRoute.shareId) || loadLatestSession()
  : forceStartScreen
    ? null
    : routeMode
      ? latestSession
      : hasPersistedRealAudio(latestSession)
        ? latestSession
        : null;
const initialVersions = buildInitialVersions(restoredSession);
const initialReviewer =
  routeMode === "reviewer"
    ? "Artist"
    : routeMode === "admin" && window.sessionStorage.getItem(ADMIN_UNLOCK_SESSION_KEY) === "true"
      ? "Engineer"
      :
  restoredSession?.currentReviewer === "Engineer" &&
  window.sessionStorage.getItem(ADMIN_UNLOCK_SESSION_KEY) !== "true"
    ? "Artist"
    : restoredSession?.currentReviewer ||
      (window.sessionStorage.getItem(ADMIN_UNLOCK_SESSION_KEY) === "true" ? "Engineer" : "Artist");

export default function App() {
  const [sessionId, setSessionId] = useState(
    restoredSession?.id || createSessionId(),
  );
  const [projectTitle, setProjectTitle] = useState(
    restoredSession?.projectName || emptyProjectName,
  );
  const [versions, setVersions] = useState(initialVersions);
  const [currentReviewer, setCurrentReviewer] = useState(
    initialReviewer,
  );
  const [activeVersionId, setActiveVersionId] = useState(
    routeVersionId || restoredSession?.activeVersionId || initialVersions[0].id,
  );
  const [uploadError, setUploadError] = useState("");
  const [sessionMessage, setSessionMessage] = useState("");
  const [shareId, setShareId] = useState(shareRoute?.shareId || restoredSession?.shareId || null);
  const [isSharePanelOpen, setIsSharePanelOpen] = useState(false);
  const [hasStarted, setHasStarted] = useState(
    Boolean(!forceStartScreen && (shareRoute || restoredSession || routeMode)),
  );
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [mediaElement, setMediaElement] = useState(null);
  const [isEngineerUnlocked, setIsEngineerUnlocked] = useState(
    () => window.sessionStorage.getItem(ADMIN_UNLOCK_SESSION_KEY) === "true",
  );
  const [isAdminUnlockOpen, setIsAdminUnlockOpen] = useState(false);
  const [adminPassword, setAdminPassword] = useState("");
  const [adminUnlockError, setAdminUnlockError] = useState("");
  const [pendingAdminAction, setPendingAdminAction] = useState(null);
  const activeMarkerRef = useRef(null);
  const playerRef = useRef(null);
  const versionsRef = useRef(versions);

  const activeVersion = useMemo(
    () => versions.find((version) => version.id === activeVersionId) || versions[0],
    [activeVersionId, versions],
  );

  const comments = activeVersion.comments;
  const audioSource = activeVersion.audioSource;
  const duration = activeVersion.duration;
  const approvalStatus = activeVersion.approvalStatus;
  const selectedCommentId = activeVersion.selectedCommentId;
  const selectedTime = activeVersion.selectedTime;
  const projectName = audioSource?.title || projectTitle;
  const permissionRole = shareRoute?.role || "editable";
  const isEngineerSelected = currentReviewer === "Engineer";
  const isEngineerMode = isEngineerSelected && isEngineerUnlocked;
  const permissions = useMemo(
    () => {
      if (permissionRole === "read-only") {
        return {
          canEdit: false,
          canReview: false,
          canShare: false,
          canSubmit: false,
          canChooseReviewer: false,
          label: "Read-only"
        };
      }

      return {
        canEdit: isEngineerMode,
        canReview: !isEngineerSelected || isEngineerUnlocked,
        canShare: isEngineerMode,
        canSubmit: !isEngineerSelected,
        canChooseReviewer: true,
        label: isEngineerSelected
          ? isEngineerUnlocked
            ? "Admin / Owner"
            : "Engineer locked"
          : "Client / Reviewer"
      };
    },
    [isEngineerMode, isEngineerSelected, isEngineerUnlocked, permissionRole],
  );

  const unresolvedCount = useMemo(
    () => comments.filter((comment) => !comment.resolved).length,
    [comments],
  );
  const statusState = useMemo(
    () => getReviewStatusState(activeVersion),
    [activeVersion],
  );

  const sessionSnapshot = useMemo(
    () => ({
      id: sessionId,
      projectName,
      shareId,
      activeVersionId,
      hasStarted,
      currentReviewer,
      versions: versions.map(toStoredVersion),
      updatedAt: new Date().toISOString()
    }),
    [activeVersionId, currentReviewer, hasStarted, projectName, sessionId, shareId, versions],
  );

  useEffect(() => {
    versionsRef.current = versions;
  }, [versions]);

  useEffect(() => {
    return () => {
      versionsRef.current.forEach((version) => {
        if (version.audioSource?.url) {
          URL.revokeObjectURL(version.audioSource.url);
        }
      });
    };
  }, []);

  useEffect(() => {
    if (!hasStarted) {
      return;
    }

    saveLatestSession(sessionSnapshot);
    if (shareId) {
      saveSharedSession(shareId, sessionSnapshot);
    }
  }, [hasStarted, sessionSnapshot, shareId]);

  const updateActiveVersion = useCallback((updater) => {
    setVersions((currentVersions) =>
      currentVersions.map((version) =>
        version.id === activeVersionId ? updater(version) : version,
      ),
    );
  }, [activeVersionId]);

  const handleAudioUpload = useCallback((file) => {
    if (!permissions.canEdit) {
      return;
    }

    if (!file) {
      return;
    }

    if (!isAudioFile(file)) {
      setUploadError("Choose an audio file to start a review.");
      return;
    }

    const title = deriveProjectTitle(file.name);
    const nextAudioSource = {
      url: URL.createObjectURL(file),
      fileName: file.name,
      title,
      size: file.size,
      type: file.type || "audio file"
    };

    setUploadError("");
    setSessionMessage("");
    setProjectTitle(title);
    setCurrentTime(0);
    setIsPlaying(false);
    playerRef.current = null;

    updateActiveVersion((version) => {
      if (version.audioSource?.url) {
        URL.revokeObjectURL(version.audioSource.url);
      }

      return {
        ...version,
        audioSource: nextAudioSource,
        comments: [],
        activity: [
          makeActivity("Version audio replaced", `${currentReviewer} uploaded ${file.name}`),
          ...version.activity
        ],
        selectedCommentId: null,
        selectedTime: 0,
        duration: 0
      };
    });
  }, [currentReviewer, permissions.canEdit, updateActiveVersion]);

  const beginNewSession = useCallback(() => {
    revokeVersionUrls(versionsRef.current);
    const nextVersions = createEmptyVersions();
    const nextSessionId = createSessionId();
    setSessionId(nextSessionId);
    setProjectTitle(emptyProjectName);
    setVersions(nextVersions);
    setCurrentReviewer(isEngineerUnlocked ? "Engineer" : "Artist");
    setActiveVersionId(nextVersions[0].id);
    setUploadError("");
    setSessionMessage("");
    setShareId(null);
    setHasStarted(true);
    setReviewRoute("admin", nextVersions[0].id, nextSessionId);
    clearStartRouteFlag();
    setCurrentTime(0);
    setIsPlaying(false);
    playerRef.current = null;
  }, [isEngineerUnlocked]);

  const startNewSession = useCallback(() => {
    if (!permissions.canEdit && hasStarted) {
      return;
    }

    if (!isEngineerUnlocked) {
      setAdminPassword("");
      setAdminUnlockError("");
      setPendingAdminAction("create-session");
      setIsAdminUnlockOpen(true);
      return;
    }

    beginNewSession();
  }, [beginNewSession, hasStarted, isEngineerUnlocked, permissions.canEdit]);

  const clearSession = useCallback(() => {
    clearLatestSession();
    startNewSession();
  }, [startNewSession]);

  const exportSession = useCallback(() => {
    const exportPayload = createExportSession(sessionSnapshot);
    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], {
      type: "application/json"
    });
    const exportUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = exportUrl;
    link.download = `${slugify(projectName)}-mixreview.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(exportUrl), 0);
    setSessionMessage("Session exported as JSON.");
  }, [projectName, sessionSnapshot]);

  const openReviewSession = useCallback(() => {
    revokeVersionUrls(versionsRef.current);
    const nextVersions = createEmptyVersions();
    const nextSessionId = createSessionId();
    setSessionId(nextSessionId);
    setProjectTitle(emptyProjectName);
    setVersions(nextVersions);
    setCurrentReviewer("Artist");
    setActiveVersionId(nextVersions[0].id);
    setShareId(null);
    setUploadError("");
    setSessionMessage("");
    setCurrentTime(0);
    setIsPlaying(false);
    setHasStarted(true);
    setReviewRoute("reviewer", nextVersions[0].id, nextSessionId);
    clearStartRouteFlag();
    playerRef.current = null;
  }, []);

  const switchVersion = useCallback((versionId) => {
    setActiveVersionId(versionId);
    setReviewRoute(isEngineerMode ? "admin" : "reviewer", versionId, sessionId);
    setCurrentTime(0);
    setIsPlaying(false);
    activeMarkerRef.current = null;
    playerRef.current = null;
  }, [isEngineerMode, sessionId]);

  const shareSession = useCallback(() => {
    if (!permissions.canShare) {
      return;
    }

    const nextShareId = shareId || createShareId();
    setShareId(nextShareId);
    saveSharedSession(nextShareId, { ...sessionSnapshot, shareId: nextShareId });
    setIsSharePanelOpen(true);
    setSessionMessage("Share links generated locally.");
  }, [permissions.canShare, sessionSnapshot, shareId]);

  const returnToStart = useCallback(() => {
    playerRef.current?.pause();
    setIsPlaying(false);
    setHasStarted(false);
    setIsSharePanelOpen(false);
  }, []);

  const handleWaveformTimestamp = useCallback((time) => {
    if (!permissions.canReview) {
      return;
    }

    const commentId = `comment-${Date.now()}`;
    const author = currentReviewer;
    const newComment = {
      id: commentId,
      time,
      author,
      text: "New timestamp marker ready for a mix note.",
      resolved: false,
      submitted: isEngineerMode
    };

    updateActiveVersion((version) => ({
      ...version,
      selectedTime: time,
      selectedCommentId: commentId,
      comments: [...version.comments, newComment].sort((a, b) => a.time - b.time),
      activity: [
        makeActivity("Comment added", `${author} added a marker at ${formatTime(time)}`),
        ...version.activity
      ]
    }));
  }, [currentReviewer, isEngineerMode, permissions.canReview, updateActiveVersion]);

  const toggleResolved = useCallback((commentId) => {
    if (!permissions.canReview) {
      return;
    }

    updateActiveVersion((version) => {
      const nextComments = version.comments.map((comment) =>
        comment.id === commentId
          ? { ...comment, resolved: !comment.resolved }
          : comment,
      );

      return {
        ...version,
        comments: nextComments,
        approvalStatus: deriveReviewStatus({ ...version, comments: nextComments })
      };
    });
  }, [permissions.canReview, updateActiveVersion]);

  const editComment = useCallback((commentId, nextText) => {
    if (!permissions.canReview || !nextText.trim()) {
      return;
    }

    updateActiveVersion((version) => {
      const targetComment = version.comments.find((comment) => comment.id === commentId);
      if (!targetComment || !canEditComment(targetComment, currentReviewer, permissions)) {
        return version;
      }

      return {
        ...version,
        comments: version.comments.map((comment) =>
          comment.id === commentId ? { ...comment, text: nextText.trim() } : comment,
        ),
        activity: [
          makeActivity("Comment edited", `${currentReviewer} updated a timestamp note`),
          ...version.activity
        ]
      };
    });
  }, [currentReviewer, permissions, updateActiveVersion]);

  const deleteComment = useCallback((commentId) => {
    if (!permissions.canReview) {
      return;
    }

    updateActiveVersion((version) => {
      const targetComment = version.comments.find((comment) => comment.id === commentId);
      if (!targetComment || !canEditComment(targetComment, currentReviewer, permissions)) {
        return version;
      }

      const nextComments = version.comments.filter(
        (comment) => comment.id !== commentId,
      );
      const nextSelectedComment = nextComments[0] || null;

      return {
        ...version,
        comments: nextComments,
        selectedCommentId:
          version.selectedCommentId === commentId
            ? nextSelectedComment?.id || null
            : version.selectedCommentId,
        selectedTime:
          version.selectedCommentId === commentId
            ? nextSelectedComment?.time || 0
            : version.selectedTime,
        activity: [
          makeActivity("Comment deleted", `${currentReviewer} removed a timestamp note`),
          ...version.activity
        ]
      };
    });
  }, [currentReviewer, permissions, updateActiveVersion]);

  const selectComment = useCallback((comment) => {
    updateActiveVersion((version) => ({
      ...version,
      selectedCommentId: comment.id,
      selectedTime: comment.time
    }));
    setCurrentTime(comment.time);
    playerRef.current?.seekToTime(comment.time);
  }, [updateActiveVersion]);

  const activateComment = useCallback((comment, { autoplay = false } = {}) => {
    updateActiveVersion((version) => ({
      ...version,
      selectedCommentId: comment.id,
      selectedTime: comment.time
    }));
    setCurrentTime(comment.time);
    playerRef.current?.seekToTime(comment.time);
    if (autoplay) {
      playerRef.current?.play();
    }
  }, [updateActiveVersion]);

  const handlePlayerReady = useCallback((controls) => {
    playerRef.current = controls;
    setMediaElement(controls?.mediaElement || null);
  }, []);

  const updateDuration = useCallback((nextDuration) => {
    updateActiveVersion((version) => ({ ...version, duration: nextDuration }));
  }, [updateActiveVersion]);

  const handlePlaybackTimeUpdate = useCallback((time) => {
    setCurrentTime(time);

    const crossedMarker = [...comments]
      .filter((comment) => comment.time <= time + 0.05)
      .sort((a, b) => b.time - a.time)[0];

    if (crossedMarker && activeMarkerRef.current !== crossedMarker.id) {
      activeMarkerRef.current = crossedMarker.id;
      updateActiveVersion((version) => ({
        ...version,
        selectedCommentId: crossedMarker.id,
        selectedTime: crossedMarker.time
      }));
    }
  }, [comments, updateActiveVersion]);

  useEffect(() => {
    function handleKeyDown(event) {
      const target = event.target;
      const isTyping =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable;

      if (event.code === "Space" && !isTyping && playerRef.current) {
        event.preventDefault();
        playerRef.current.playPause();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const updateApprovalStatus = useCallback((nextStatus) => {
    if (!permissions.canReview || !approvalStates.includes(nextStatus)) {
      return;
    }

    const nextStatusState = getReviewStatusState(activeVersion);
    if (!nextStatusState[nextStatus].enabled) {
      return;
    }

    updateActiveVersion((version) => ({
      ...version,
      approvalStatus: nextStatus,
      approvalHistory: [
        {
          id: `approval-${Date.now()}`,
          status: nextStatus,
          reviewer: currentReviewer,
          createdAt: new Date().toISOString()
        },
        ...version.approvalHistory
      ],
      activity: [
        makeActivity(
          "Approval changed",
          `${currentReviewer} set ${version.label} to ${nextStatus}`,
        ),
        ...version.activity
      ]
    }));
  }, [activeVersion, currentReviewer, permissions.canReview, updateActiveVersion]);

  const submitFeedback = useCallback(() => {
    if (!permissions.canSubmit) {
      return;
    }

    updateActiveVersion((version) => {
      const pendingComments = version.comments.filter(
        (comment) => comment.author === currentReviewer && comment.submitted === false,
      );

      if (pendingComments.length === 0) {
        setSessionMessage("No unsubmitted feedback for this reviewer.");
        return version;
      }

      setSessionMessage(`${currentReviewer} feedback submitted.`);
      const nextComments = version.comments.map((comment) =>
        comment.author === currentReviewer && comment.submitted === false
          ? { ...comment, submitted: true }
          : comment,
      );

      return {
        ...version,
        approvalStatus: deriveReviewStatus({ ...version, comments: nextComments }),
        comments: nextComments,
        activity: [
          makeActivity(
            "Feedback submitted",
            `${currentReviewer} submitted ${pendingComments.length} note${pendingComments.length === 1 ? "" : "s"}`,
          ),
          ...version.activity
        ]
      };
    });
  }, [currentReviewer, permissions.canSubmit, updateActiveVersion]);

  const updateReviewer = useCallback((reviewer) => {
    if (!reviewerIdentities.includes(reviewer)) {
      return;
    }

    if (reviewer === "Engineer" && !isEngineerUnlocked) {
      setAdminPassword("");
      setAdminUnlockError("");
      setIsAdminUnlockOpen(true);
      return;
    }

    setCurrentReviewer(reviewer);
    setReviewRoute(reviewer === "Engineer" ? "admin" : "reviewer", activeVersionId, sessionId);
  }, [activeVersionId, isEngineerUnlocked, sessionId]);

  const unlockEngineerMode = useCallback((event) => {
    event.preventDefault();

    if (adminPassword !== MIXREVIEW_ADMIN_DEV_PASSWORD) {
      setAdminUnlockError("Incorrect engineer password.");
      return;
    }

    window.sessionStorage.setItem(ADMIN_UNLOCK_SESSION_KEY, "true");
    setIsEngineerUnlocked(true);
    setCurrentReviewer("Engineer");
    setIsAdminUnlockOpen(false);
    setAdminPassword("");
    setAdminUnlockError("");
    if (pendingAdminAction === "create-session") {
      beginNewSession();
    }
    setPendingAdminAction(null);
    setSessionMessage("Engineer mode unlocked for this browser session.");
  }, [adminPassword, beginNewSession, pendingAdminAction]);

  const lockEngineerMode = useCallback(() => {
    window.sessionStorage.removeItem(ADMIN_UNLOCK_SESSION_KEY);
    setIsEngineerUnlocked(false);
    setCurrentReviewer("Artist");
    setIsAdminUnlockOpen(false);
    setAdminPassword("");
    setAdminUnlockError("");
    setSessionMessage("Engineer mode locked.");
  }, []);

  if (!hasStarted) {
    return (
      <>
          <StartScreen
            onCreate={startNewSession}
          onDemo={openReviewSession}
          message={sessionMessage}
        />
        {isAdminUnlockOpen && (
          <EngineerUnlockModal
            password={adminPassword}
            error={adminUnlockError}
            onPasswordChange={setAdminPassword}
            onCancel={() => {
              setIsAdminUnlockOpen(false);
              setAdminPassword("");
              setAdminUnlockError("");
              setPendingAdminAction(null);
            }}
            onSubmit={unlockEngineerMode}
          />
        )}
      </>
    );
  }

  return (
    <main className="app-shell">
      <div className="top-stack">
        <Header
          projectName={projectName}
          approvalStatus={approvalStatus}
          unresolvedCount={unresolvedCount}
          versions={versions}
          activeVersionId={activeVersionId}
          onStatusChange={updateApprovalStatus}
          statusState={statusState}
          onVersionChange={switchVersion}
          onShareSession={shareSession}
          onBackToStart={returnToStart}
          onNewSession={startNewSession}
          onClearSession={clearSession}
          onExportSession={exportSession}
          onLockEngineerMode={lockEngineerMode}
          permissions={permissions}
          isEngineerUnlocked={isEngineerUnlocked}
        />
        {sessionMessage && <div className="session-message">{sessionMessage}</div>}
        {isSharePanelOpen && shareId && (
          <SharePanel
            links={{
              reviewer: createShareLink(shareId, "reviewer"),
              readOnly: createShareLink(shareId, "read-only")
            }}
            onClose={() => setIsSharePanelOpen(false)}
          />
        )}
      </div>

      <section className="review-layout" aria-label="Mix review workspace">
        <div className="review-main">
          {(permissions.canEdit || audioSource) && (
            <AudioUpload
              audioSource={audioSource}
              duration={duration}
              error={uploadError}
              disabled={!permissions.canEdit}
              onFileSelect={handleAudioUpload}
            />
          )}

          <WaveformReview
            key={activeVersionId}
            audioSource={audioSource}
            comments={comments}
            selectedCommentId={selectedCommentId}
            selectedTime={selectedTime}
            onTimestampCreate={handleWaveformTimestamp}
            onMarkerSelect={activateComment}
            onReady={handlePlayerReady}
            onTimeUpdate={handlePlaybackTimeUpdate}
            onDurationChange={updateDuration}
            onPlaybackChange={setIsPlaying}
          />
          <SpectrumAnalyzer mediaElement={mediaElement} isPlaying={isPlaying} />
        </div>

        <div className="review-side">
          <ReviewDashboard
            activeVersion={activeVersion}
            versions={versions}
            currentReviewer={currentReviewer}
            onReviewerChange={updateReviewer}
            onApprovalChange={updateApprovalStatus}
            onSubmitFeedback={submitFeedback}
            statusState={statusState}
            canApprove={permissions.canReview}
            canSubmit={permissions.canSubmit}
            canChooseReviewer={permissions.canChooseReviewer}
          />

          <CommentSidebar
            comments={comments}
            selectedCommentId={selectedCommentId}
            onCommentSelect={activateComment}
            onCommentEdit={editComment}
            onCommentDelete={deleteComment}
            onToggleResolved={toggleResolved}
            currentReviewer={currentReviewer}
            canModifyComment={(comment) => canEditComment(comment, currentReviewer, permissions)}
            canResolve={permissions.canReview}
          />
        </div>
      </section>

      <TransportBar
        currentTime={currentTime}
        duration={duration}
        isPlaying={isPlaying}
        isDisabled={!playerRef.current}
        onPlayPause={() => playerRef.current?.playPause()}
        onSkipBackward={() => playerRef.current?.skip(-5)}
        onSkipForward={() => playerRef.current?.skip(5)}
      />
      {isAdminUnlockOpen && (
        <EngineerUnlockModal
          password={adminPassword}
          error={adminUnlockError}
          onPasswordChange={setAdminPassword}
          onCancel={() => {
            setIsAdminUnlockOpen(false);
            setAdminPassword("");
            setAdminUnlockError("");
            setPendingAdminAction(null);
          }}
          onSubmit={unlockEngineerMode}
        />
      )}
    </main>
  );
}

function createEmptyVersions() {
  return versionLabels.map((label) => createVersion(label, []));
}

function EngineerUnlockModal({
  password,
  error,
  onPasswordChange,
  onCancel,
  onSubmit
}) {
  return (
    <div className="admin-modal-backdrop" role="presentation">
      <form className="admin-modal" aria-label="Unlock Engineer mode" onSubmit={onSubmit}>
        <div>
          <p className="eyebrow">Protected Access</p>
          <h2>Unlock Engineer Mode</h2>
          <p>Enter the engineer password to show admin controls for this session.</p>
        </div>
        <label>
          <span>Password</span>
          <input
            autoFocus
            type="password"
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
          />
        </label>
        {error && <p className="upload-error">{error}</p>}
        <div className="admin-modal-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit">
            Unlock Engineer
          </button>
        </div>
      </form>
    </div>
  );
}

function createVersion(label, comments = []) {
  return {
    id: versionIdFromLabel(label),
    label,
    audioSource: null,
    comments,
    approvalStatus: deriveReviewStatus({ comments }),
    approvalHistory: [],
    activity: [],
    selectedCommentId: comments[0]?.id || null,
    selectedTime: comments[0]?.time || 0,
    duration: 0
  };
}

function buildInitialVersions(session) {
  if (Array.isArray(session?.versions)) {
    const storedVersions = session.versions.map(hydrateStoredVersion);
    return ensureBaseVersions(storedVersions);
  }

  const legacyComments = session?.comments || [];
  return ensureBaseVersions([
    {
      ...createVersion("V1", legacyComments),
      audioSource: session?.audioMetadata
        ? {
            ...session.audioMetadata,
            url: session.audioMetadata.url || null,
            needsRelink: !session.audioMetadata.url
          }
        : null,
      approvalStatus: resolveApprovalStatus(
        normalizeApprovalStatus(session?.approvalStatus || session?.mixStatus),
        legacyComments,
        session?.approvalHistory || [],
      ),
      approvalHistory: session?.approvalHistory || [],
      activity: session?.activity || [],
      selectedCommentId: session?.selectedCommentId || legacyComments[0]?.id || null,
      selectedTime: session?.selectedTime ?? legacyComments[0]?.time ?? 0,
      duration: session?.duration || 0
    }
  ]);
}

function ensureBaseVersions(existingVersions) {
  return versionLabels.map((label) => {
    const existingVersion = existingVersions.find((version) => version.label === label);
    return existingVersion || createVersion(label, []);
  });
}

function hydrateStoredVersion(version) {
  const comments = version.comments || [];
  const approvalHistory = version.approvalHistory || [];
  return {
    ...createVersion(version.label || "V1", comments),
    id: version.id || versionIdFromLabel(version.label || "V1"),
    label: version.label || "V1",
    audioSource: version.audioMetadata
      ? {
          ...version.audioMetadata,
          url: version.audioMetadata.url || null,
          needsRelink: !version.audioMetadata.url
        }
      : null,
    comments,
    approvalStatus: resolveApprovalStatus(
      normalizeApprovalStatus(version.approvalStatus || version.mixStatus),
      comments,
      approvalHistory,
    ),
    approvalHistory,
    activity: version.activity || [],
    selectedCommentId: version.selectedCommentId || version.comments?.[0]?.id || null,
    selectedTime: version.selectedTime ?? version.comments?.[0]?.time ?? 0,
    duration: version.duration || 0
  };
}

function toStoredVersion(version) {
  return {
    id: version.id,
    label: version.label,
    audioMetadata: toStoredAudioMetadata(version.audioSource),
    comments: version.comments,
    approvalStatus: version.approvalStatus,
    approvalHistory: version.approvalHistory,
    activity: version.activity,
    selectedCommentId: version.selectedCommentId,
    selectedTime: version.selectedTime,
    duration: version.duration
  };
}

function revokeVersionUrls(versions) {
  versions.forEach((version) => {
    if (version.audioSource?.url) {
      URL.revokeObjectURL(version.audioSource.url);
    }
  });
}

function deriveProjectTitle(fileName) {
  return fileName
    .replace(/\.[^/.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isAudioFile(file) {
  if (file.type.startsWith("audio/")) {
    return true;
  }

  return /\.(aac|aif|aiff|flac|m4a|mp3|ogg|wav|webm)$/i.test(file.name);
}

function versionIdFromLabel(label) {
  return `version-${label.toLowerCase().replace(/\s+/g, "-")}`;
}

function normalizeApprovalStatus(status) {
  if (status === "Final Master Approved") {
    return "Approved";
  }

  if (status === "Pending") {
    return "Pending Review";
  }

  if (status === "Approved") {
    return "Approved";
  }

  if (status === "Needs Revision" || status === "Needs Changes") {
    return "Needs Review";
  }

  return approvalStates.includes(status) ? status : "Pending Review";
}

function resolveApprovalStatus(status, comments, approvalHistory) {
  if (status === "Approved") {
    return status;
  }

  if (approvalHistory.some((event) => event.status === "Final Master Approved")) {
    return "Approved";
  }

  if (approvalHistory.some((event) => event.status === "Approved")) {
    return "Approved";
  }

  return deriveReviewStatus({ comments, approvalStatus: status });
}

function getReviewStatusState(version) {
  const submittedReviewComments = getSubmittedReviewComments(version.comments);
  const hasSubmittedReview = submittedReviewComments.length > 0;
  const allReviewItemsResolved =
    hasSubmittedReview && submittedReviewComments.every((comment) => comment.resolved);
  const activeStatus = deriveReviewStatus(version);

  return approvalStates.reduce((states, state) => {
    states[state] = {
      active: state === activeStatus,
      enabled:
        state === "Pending Review"
          ? !hasSubmittedReview
          : state === "Needs Review"
            ? hasSubmittedReview && !allReviewItemsResolved
            : allReviewItemsResolved,
      tone:
        state === "Approved"
          ? "approved"
          : state === "Pending Review" || state === "Needs Review"
            ? "attention"
            : "neutral"
    };
    return states;
  }, {});
}

function deriveReviewStatus(version) {
  const submittedReviewComments = getSubmittedReviewComments(version.comments);

  if (submittedReviewComments.length === 0) {
    return "Pending Review";
  }

  if (submittedReviewComments.every((comment) => comment.resolved)) {
    return "Approved";
  }

  return "Needs Review";
}

function getSubmittedReviewComments(comments = []) {
  return comments.filter(
    (comment) =>
      clientReviewerIdentities.includes(comment.author) &&
      comment.submitted !== false,
  );
}

function canEditComment(comment, reviewer, permissions) {
  if (!permissions.canReview) {
    return false;
  }

  if (permissions.canEdit) {
    return true;
  }

  return comment.author === reviewer && comment.submitted === false;
}

function makeActivity(label, detail) {
  return {
    id: `activity-${Date.now()}-${Math.random()}`,
    label,
    detail,
    createdAt: new Date().toISOString()
  };
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function createSessionId() {
  return `session-${Date.now()}`;
}

function slugify(value) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "mixreview-session"
  );
}

function clearStartRouteFlag() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("start")) {
    return;
  }

  url.searchParams.delete("start");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function setReviewRoute(mode, versionId, sessionId) {
  const url = new URL(window.location.href);
  url.searchParams.delete("start");
  url.searchParams.set("mode", mode);
  url.searchParams.set("version", versionId);
  url.searchParams.set("session", sessionId);
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function hasPersistedRealAudio(session) {
  return Boolean(
    session?.versions?.some((version) => version.audioMetadata?.url),
  );
}
