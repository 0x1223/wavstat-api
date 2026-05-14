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
  listSessionsFromApi,
  loadSessionFromApi,
  saveSessionToApi,
  uploadSessionAudio
} from "./api/sessions.js";
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
const ACCESS_STORAGE_KEY = "mixreview.accessState";

const emptyProjectName = "Untitled MixReview Session";

const routeParams = new URLSearchParams(window.location.search);
const shareRoute = getShareRoute();
const routeMode = routeParams.get("mode");
const routeVersionId = routeParams.get("version");
const forceStartScreen = routeParams.has("start");
const savedAccessState = forceStartScreen ? null : loadAccessState();
const routeSessionId =
  routeParams.get("session") ||
  shareRoute?.shareId ||
  (savedAccessState?.mode === "reviewer" ? savedAccessState.sessionId : null);
const latestSession = loadLatestSession();
const routeCachedSession =
  routeSessionId && latestSession?.id === routeSessionId ? latestSession : null;
const restoredSession = shareRoute
  ? loadSharedSession(shareRoute.shareId) || routeCachedSession
  : forceStartScreen
    ? null
    : routeMode
      ? routeCachedSession || latestSession
      : savedAccessState?.mode === "reviewer"
        ? routeCachedSession || latestSession
        : hasPersistedRealAudio(latestSession)
          ? latestSession
          : null;
const initialVersions = buildInitialVersions(restoredSession);
const initialReviewer =
  savedAccessState?.mode === "admin"
    ? "Engineer"
    : routeMode === "reviewer"
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
  const [loginName, setLoginName] = useState(
    savedAccessState?.mode === "reviewer" ? savedAccessState.sessionId || "" : "",
  );
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [appView, setAppView] = useState(
    !forceStartScreen && (routeSessionId || routeMode || shareRoute || restoredSession)
      ? "workspace"
      : !forceStartScreen && savedAccessState?.mode === "admin"
      ? "admin"
      : Boolean(!forceStartScreen && savedAccessState?.mode === "reviewer")
        ? "workspace"
        : "start",
  );
  const [adminSessions, setAdminSessions] = useState([]);
  const [isAdminSessionsLoading, setIsAdminSessionsLoading] = useState(false);
  const [shareId, setShareId] = useState(shareRoute?.shareId || restoredSession?.shareId || null);
  const [isSharePanelOpen, setIsSharePanelOpen] = useState(false);
  const [hasStarted, setHasStarted] = useState(
    Boolean(!forceStartScreen && (shareRoute || restoredSession || routeMode || savedAccessState?.mode === "reviewer")),
  );
  const [isSessionHydrating, setIsSessionHydrating] = useState(
    Boolean(!forceStartScreen && routeSessionId && !restoredSession),
  );
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [mediaElement, setMediaElement] = useState(null);
  const [isEngineerUnlocked, setIsEngineerUnlocked] = useState(
    () =>
      window.sessionStorage.getItem(ADMIN_UNLOCK_SESSION_KEY) === "true" ||
      savedAccessState?.mode === "admin",
  );
  const activeMarkerRef = useRef(null);
  const playerRef = useRef(null);
  const versionsRef = useRef(versions);
  const lastSavedSessionRef = useRef("");

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
        canChooseReviewer: false,
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

  const applyStoredSession = useCallback((session, reviewerOverride = null) => {
    if (!session) {
      return;
    }

    const nextVersions = buildInitialVersions(session);
    revokeVersionUrls(versionsRef.current);
    setSessionId(session.id || createSessionId());
    setProjectTitle(session.projectName || emptyProjectName);
    setVersions(nextVersions);
    setActiveVersionId(
      routeVersionId && nextVersions.some((version) => version.id === routeVersionId)
        ? routeVersionId
        : session.activeVersionId || nextVersions[0].id,
    );
    setCurrentReviewer(
      reviewerOverride ||
      (session.currentReviewer === "Engineer" && !isEngineerUnlocked
        ? "Artist"
        : session.currentReviewer || "Artist"),
    );
    setShareId(session.shareId || session.id || null);
    setCurrentTime(0);
    setIsPlaying(false);
    setHasStarted(true);
    playerRef.current = null;
  }, [isEngineerUnlocked]);

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
        if (version.audioSource?.url?.startsWith("blob:")) {
          URL.revokeObjectURL(version.audioSource.url);
        }
      });
    };
  }, []);

  useEffect(() => {
    if (!routeSessionId || forceStartScreen) {
      setIsSessionHydrating(false);
      return undefined;
    }

    let isCancelled = false;
    setIsSessionHydrating(true);
    loadSessionFromApi(routeSessionId)
      .then((storedSession) => {
        if (isCancelled) {
          return;
        }

        if (storedSession) {
          applyStoredSession(
            storedSession,
            routeMode === "admin" && isEngineerUnlocked ? "Engineer" : routeMode === "reviewer" ? "Artist" : null,
          );
          saveLatestSession(storedSession);
        } else {
          setSessionMessage("Session was not found in persistent storage.");
        }
      })
      .catch(() => {
        if (!isCancelled) {
          setSessionMessage("Session could not be loaded from persistent storage.");
        }
      })
      .finally(() => {
        if (!isCancelled) {
          setIsSessionHydrating(false);
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [applyStoredSession, forceStartScreen, isEngineerUnlocked, routeMode, routeSessionId]);

  useEffect(() => {
    if (!hasStarted || isSessionHydrating) {
      return;
    }

    saveLatestSession(sessionSnapshot);
    if (shareId) {
      saveSharedSession(shareId, sessionSnapshot);
    }

    const serializedSession = JSON.stringify(sessionSnapshot);
    if (serializedSession === lastSavedSessionRef.current) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      lastSavedSessionRef.current = serializedSession;
      saveSessionToApi(sessionSnapshot).catch(() => {
        setSessionMessage("Session changes are cached locally but could not sync to storage.");
      });
    }, 450);

    return () => window.clearTimeout(timeoutId);
  }, [hasStarted, isSessionHydrating, sessionSnapshot, shareId]);

  const refreshAdminSessions = useCallback(() => {
    setIsAdminSessionsLoading(true);
    listSessionsFromApi()
      .then(setAdminSessions)
      .catch(() => {
        setSessionMessage("Admin sessions could not be loaded.");
      })
      .finally(() => setIsAdminSessionsLoading(false));
  }, []);

  useEffect(() => {
    if (appView === "admin" && isEngineerUnlocked) {
      refreshAdminSessions();
    }
  }, [appView, isEngineerUnlocked, refreshAdminSessions]);

  const updateActiveVersion = useCallback((updater) => {
    setVersions((currentVersions) =>
      currentVersions.map((version) =>
        version.id === activeVersionId ? updater(version) : version,
      ),
    );
  }, [activeVersionId]);

  const handleAudioUpload = useCallback(async (file) => {
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
    setUploadError("Uploading audio to session storage...");
    setSessionMessage("");

    try {
      const uploadResult = await uploadSessionAudio(sessionId, activeVersionId, file);
      const nextAudioSource = {
        url: uploadResult.playbackUrl,
        key: uploadResult.key,
        storage: uploadResult.storage,
        fileName: uploadResult.fileName || file.name,
        title,
        size: uploadResult.size || file.size,
        type: uploadResult.contentType || file.type || "audio file"
      };

      setUploadError("");
      setProjectTitle(title);
      setCurrentTime(0);
      setIsPlaying(false);
      playerRef.current = null;

      updateActiveVersion((version) => ({
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
      }));
    } catch (error) {
      setUploadError(error.message || "Audio upload failed.");
    }
  }, [activeVersionId, currentReviewer, permissions.canEdit, sessionId, updateActiveVersion]);

  const beginNewSession = useCallback(() => {
    revokeVersionUrls(versionsRef.current);
    const nextVersions = createEmptyVersions();
    const nextSessionId = createSessionId();
    setSessionId(nextSessionId);
    setProjectTitle(emptyProjectName);
    setVersions(nextVersions);
    setCurrentReviewer("Engineer");
    setActiveVersionId(nextVersions[0].id);
    setUploadError("");
    setSessionMessage("");
    setShareId(null);
    setHasStarted(true);
    setAppView("workspace");
    saveAccessState({ mode: "admin", sessionId: nextSessionId });
    setReviewRoute("admin", nextVersions[0].id, nextSessionId);
    clearStartRouteFlag();
    setCurrentTime(0);
    setIsPlaying(false);
    playerRef.current = null;
  }, []);

  const startNewSession = useCallback(() => {
    if (!isEngineerUnlocked) {
      setLoginError("Engineer password is required before creating sessions.");
      setAppView("start");
      return;
    }

    beginNewSession();
  }, [beginNewSession, isEngineerUnlocked]);

  const clearSession = useCallback(() => {
    clearLatestSession();
    startNewSession();
  }, [startNewSession]);

  const openAdminDashboard = useCallback(() => {
    playerRef.current?.pause();
    setIsPlaying(false);
    setHasStarted(false);
    setAppView("admin");
    setIsSharePanelOpen(false);
    saveAccessState({ mode: "admin", sessionId });
    clearWorkspaceRoute();
    refreshAdminSessions();
  }, [refreshAdminSessions, sessionId]);

  const openStoredSession = useCallback(async (targetSessionId, reviewer = "Engineer") => {
    const storedSession = await loadSessionFromApi(targetSessionId);
    if (!storedSession) {
      throw new Error("Session was not found.");
    }

    applyStoredSession(storedSession, reviewer);
    setAppView("workspace");
    setHasStarted(true);
    saveLatestSession(storedSession);
    saveAccessState({
      mode: reviewer === "Engineer" ? "admin" : "reviewer",
      sessionId: storedSession.id,
      role: reviewer
    });
    setReviewRoute(reviewer === "Engineer" ? "admin" : "reviewer", storedSession.activeVersionId || "version-v1", storedSession.id);
  }, [applyStoredSession]);

  const handleAccessLogin = useCallback(async (event) => {
    event.preventDefault();
    const name = loginName.trim();
    const password = loginPassword.trim();
    setLoginError("");
    setSessionMessage("");

    if (!name || !password) {
      setLoginError("Enter a name/client ID and password.");
      return;
    }

    if (isAdminLoginName(name)) {
      if (password !== MIXREVIEW_ADMIN_DEV_PASSWORD) {
        setLoginError("Incorrect engineer password.");
        return;
      }

      window.sessionStorage.setItem(ADMIN_UNLOCK_SESSION_KEY, "true");
      setIsEngineerUnlocked(true);
      setCurrentReviewer("Engineer");
      setLoginPassword("");
      setHasStarted(false);
      setAppView("admin");
      saveAccessState({ mode: "admin", sessionId });
      clearWorkspaceRoute();
      refreshAdminSessions();
      return;
    }

    try {
      const storedSession = await loadSessionFromApi(name);
      if (!storedSession) {
        setLoginError("No review session matches that client ID.");
        return;
      }

      const validToken = password === storedSession.shareId || password === storedSession.id;
      if (!validToken) {
        setLoginError("Invalid review password or link token.");
        return;
      }

      setIsEngineerUnlocked(false);
      setLoginPassword("");
      applyStoredSession(storedSession, "Artist");
      setAppView("workspace");
      saveLatestSession(storedSession);
      saveAccessState({ mode: "reviewer", sessionId: storedSession.id, role: "Artist" });
      setReviewRoute("reviewer", storedSession.activeVersionId || "version-v1", storedSession.id);
    } catch (error) {
      setLoginError(error.message || "Unable to open that review session.");
    }
  }, [applyStoredSession, loginName, loginPassword, refreshAdminSessions, sessionId]);

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

  const switchVersion = useCallback((versionId) => {
    setActiveVersionId(versionId);
    setReviewRoute(isEngineerMode ? "admin" : "reviewer", versionId, sessionId);
    saveAccessState({
      mode: isEngineerMode ? "admin" : "reviewer",
      sessionId,
      role: isEngineerMode ? "Engineer" : currentReviewer
    });
    setCurrentTime(0);
    setIsPlaying(false);
    activeMarkerRef.current = null;
    playerRef.current = null;
  }, [currentReviewer, isEngineerMode, sessionId]);

  const shareSession = useCallback(() => {
    if (!permissions.canShare) {
      return;
    }

    const nextShareId = shareId || sessionId || createShareId();
    const nextSessionSnapshot = { ...sessionSnapshot, id: sessionId, shareId: nextShareId };
    setShareId(nextShareId);
    saveSharedSession(nextShareId, nextSessionSnapshot);
    saveSessionToApi(nextSessionSnapshot).catch(() => {
      setSessionMessage("Share link created, but the session could not sync to storage.");
    });
    setIsSharePanelOpen(true);
    setSessionMessage("Share links generated for this persistent session.");
  }, [permissions.canShare, sessionId, sessionSnapshot, shareId]);

  const copyClientReviewLink = useCallback((session) => {
    const token = session.shareId || session.id;
    const link = createShareLink(token, "reviewer");
    navigator.clipboard?.writeText(link).catch(() => {});
    setSessionMessage(`Client review link copied for ${session.projectName || session.id}.`);
  }, []);

  const openAdminSession = useCallback((targetSessionId) => {
    openStoredSession(targetSessionId, "Engineer").catch((error) => {
      setSessionMessage(error.message || "Session could not be opened.");
    });
  }, [openStoredSession]);

  const returnToStart = useCallback(() => {
    playerRef.current?.pause();
    setIsPlaying(false);
    setCurrentTime(0);
    setHasStarted(false);
    setAppView("start");
    clearLatestSession();
    clearAccessState();
    window.sessionStorage.removeItem(ADMIN_UNLOCK_SESSION_KEY);
    setIsEngineerUnlocked(false);
    setCurrentReviewer("Artist");
    setSessionId(createSessionId());
    setProjectTitle(emptyProjectName);
    setVersions(createEmptyVersions());
    setActiveVersionId("version-v1");
    setShareId(null);
    setUploadError("");
    setSessionMessage("");
    setIsSharePanelOpen(false);
    activeMarkerRef.current = null;
    playerRef.current = null;
    replaceWithLandingRoute();
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

    setCurrentReviewer(reviewer);
    setReviewRoute(reviewer === "Engineer" ? "admin" : "reviewer", activeVersionId, sessionId);
  }, [activeVersionId, sessionId]);

  if (appView === "start") {
    return (
      <StartScreen
        loginName={loginName}
        loginPassword={loginPassword}
        loginError={loginError}
        onLoginNameChange={setLoginName}
        onLoginPasswordChange={setLoginPassword}
        onLoginSubmit={handleAccessLogin}
        message={sessionMessage}
      />
    );
  }

  if (appView === "admin" && isEngineerUnlocked) {
    return (
      <AdminDashboard
        sessions={adminSessions}
        isLoading={isAdminSessionsLoading}
        message={sessionMessage}
        onCreateSession={startNewSession}
        onOpenSession={openAdminSession}
        onCopyClientLink={copyClientReviewLink}
        onRefresh={refreshAdminSessions}
        onLogout={returnToStart}
      />
    );
  }

  if (appView === "admin") {
    return (
      <StartScreen
        loginName={loginName}
        loginPassword={loginPassword}
        loginError={loginError || "Engineer password is required."}
        onLoginNameChange={setLoginName}
        onLoginPasswordChange={setLoginPassword}
        onLoginSubmit={handleAccessLogin}
        message={sessionMessage}
      />
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
          backLabel={isEngineerMode ? "Admin Dashboard" : "Back to Start"}
          onStatusChange={updateApprovalStatus}
          statusState={statusState}
          onVersionChange={switchVersion}
          onShareSession={shareSession}
          onBackToStart={isEngineerMode ? openAdminDashboard : returnToStart}
          onNewSession={startNewSession}
          onClearSession={clearSession}
          onExportSession={exportSession}
          permissions={permissions}
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
    </main>
  );
}

function createEmptyVersions() {
  return versionLabels.map((label) => createVersion(label, []));
}

function AdminDashboard({
  sessions,
  isLoading,
  message,
  onCreateSession,
  onOpenSession,
  onCopyClientLink,
  onRefresh,
  onLogout
}) {
  const buckets = approvalStates.reduce((groups, status) => {
    groups[status] = sessions.filter((session) => session.status === status);
    return groups;
  }, {});
  const pendingSessions = buckets["Pending Review"] || [];
  const needsReviewSessions = buckets["Needs Review"] || [];
  const approvedSessions = buckets.Approved || [];

  return (
    <main className="app-shell admin-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">MixReview</p>
          <h1>Admin Dashboard</h1>
        </div>
        <div className="session-actions">
          <button type="button" onClick={onCreateSession}>
            Create Review Session
          </button>
          <button type="button" onClick={onRefresh}>
            Refresh
          </button>
          <button
            type="button"
            onClick={() => {
              window.localStorage.removeItem("mixreview.latestSession");
              window.localStorage.removeItem("mixreview.accessState");
              window.sessionStorage.removeItem("mixreview.engineerUnlocked");
              window.history.replaceState(null, "", "/");
              onLogout();
            }}
          >
            Back to Start
          </button>
        </div>
      </header>

      {message && <div className="session-message">{message}</div>}

      <section className="admin-dashboard" aria-label="Admin dashboard">
        <div className="summary-grid">
          <SummaryTile label="Pending Reviews" value={pendingSessions.length} />
          <SummaryTile label="Needs Review" value={needsReviewSessions.length} />
          <SummaryTile label="Approved" value={approvedSessions.length} />
          <SummaryTile label="All Sessions" value={sessions.length} />
        </div>

        {isLoading ? (
          <div className="empty-state">
            <strong>Loading sessions...</strong>
            <p>Pulling the latest review workspace list.</p>
          </div>
        ) : sessions.length === 0 ? (
          <div className="empty-state">
            <strong>No review sessions yet.</strong>
            <p>Create a review session to upload audio and send a client review link.</p>
          </div>
        ) : (
          <div className="admin-session-list">
            {sessions.map((session) => (
              <article className="admin-session-row" key={session.id}>
                <div>
                  <p className="eyebrow">{session.status || "Pending Review"}</p>
                  <h2>{session.projectName || "Untitled MixReview Session"}</h2>
                  <p>{session.id}</p>
                </div>
                <div className="session-actions">
                  <button type="button" onClick={() => onOpenSession(session.id)}>
                    Open Session
                  </button>
                  <button type="button" onClick={() => onCopyClientLink(session)}>
                    Copy Client Review Link
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function SummaryTile({ label, value }) {
  return (
    <div className="summary-metric">
      <span>{label}</span>
      <strong>{value}</strong>
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
    if (version.audioSource?.url?.startsWith("blob:")) {
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

function clearWorkspaceRoute() {
  const url = new URL(window.location.href);
  url.searchParams.delete("start");
  url.searchParams.delete("mode");
  url.searchParams.delete("version");
  url.searchParams.delete("session");
  url.searchParams.delete("share");
  url.searchParams.delete("role");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function replaceWithLandingRoute() {
  window.history.replaceState(null, "", "/");
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

function isAdminLoginName(name) {
  return ["admin", "engineer"].includes(name.trim().toLowerCase());
}

function loadAccessState() {
  try {
    const rawState = window.localStorage.getItem(ACCESS_STORAGE_KEY);
    return rawState ? JSON.parse(rawState) : null;
  } catch {
    return null;
  }
}

function saveAccessState(state) {
  try {
    window.localStorage.setItem(ACCESS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Access persistence is best-effort; the session remains stored server-side.
  }
}

function clearAccessState() {
  try {
    window.localStorage.removeItem(ACCESS_STORAGE_KEY);
  } catch {
    // Access persistence is best-effort; the session remains stored server-side.
  }
}
