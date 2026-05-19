import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioUpload } from "./components/AudioUpload.jsx";
import { CommentSidebar } from "./components/CommentSidebar.jsx";
import { Header } from "./components/Header.jsx";
import { ReviewDashboard } from "./components/ReviewDashboard.jsx";
import { SharePanel } from "./components/SharePanel.jsx";
import { SpectrumAnalyzer } from "./components/SpectrumAnalyzer.jsx";
import { StartScreen } from "./components/StartScreen.jsx";
import { TrackList } from "./components/TrackList.jsx";
import { TransportBar } from "./components/TransportBar.jsx";
import { WaveformReview } from "./components/WaveformReview.jsx";
import {
  deleteSessionFromApi,
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
const emptySessionDetails = {
  sessionName: "",
  artistName: "",
  reviewerName: "",
  reviewerClientId: "",
  reviewerToken: "",
  notes: "",
  isPriority: false,
  status: "Draft"
};

const routeParams = new URLSearchParams(window.location.search);
const shareRoute = getShareRoute();
const routeMode = routeParams.get("mode");
const routeVersionId = routeParams.get("version");
const routeTrackId = routeParams.get("track");
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
const legacyInitialVersions = buildInitialVersions(restoredSession);
const initialTracks = buildInitialTracks(restoredSession, legacyInitialVersions);
const initialActiveTrackId = restoredSession?.activeTrackId || initialTracks[0]?.id || null;
const initialActiveTrack = initialTracks.find((track) => track.id === initialActiveTrackId) || initialTracks[0] || null;
const initialVersions = initialActiveTrack?.versions || legacyInitialVersions;
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
  const [sessionDetails, setSessionDetails] = useState(buildSessionDetails(restoredSession));
  const [versions, setVersions] = useState(initialVersions);
  const [tracks, setTracks] = useState(initialTracks);
  const [activeTrackId, setActiveTrackId] = useState(initialActiveTrackId);
  const [currentReviewer, setCurrentReviewer] = useState(
    initialReviewer,
  );
  const [activeVersionId, setActiveVersionId] = useState(
    routeVersionId || restoredSession?.activeVersionId || initialVersions[0].id,
  );
  const [uploadError, setUploadError] = useState("");
  const [sessionMessage, setSessionMessage] = useState("");
  const [setupError, setSetupError] = useState("");
  const [isSessionSynced, setIsSessionSynced] = useState(Boolean(restoredSession));
  const [isSessionSaving, setIsSessionSaving] = useState(false);
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
  const [isPlayerReady, setIsPlayerReady] = useState(false);
  const [mediaElement, setMediaElement] = useState(null);
  const [mobileNoteDraft, setMobileNoteDraft] = useState(null);
  const [mobileCommentDrawerId, setMobileCommentDrawerId] = useState(null);
  const [mobileCommentDraft, setMobileCommentDraft] = useState("");
  const [deleteConfirmPending, setDeleteConfirmPending] = useState(false);
  const [isEngineerUnlocked, setIsEngineerUnlocked] = useState(
    () =>
      window.sessionStorage.getItem(ADMIN_UNLOCK_SESSION_KEY) === "true" ||
      savedAccessState?.mode === "admin",
  );
  const activeMarkerRef = useRef(null);
  const playerRef = useRef(null);
  const versionsRef = useRef(versions);
  const lastSavedSessionRef = useRef("");

  const activeTrack = useMemo(
    () => tracks.find((track) => track.id === activeTrackId) || tracks[0] || null,
    [activeTrackId, tracks],
  );
  const activeVersion = useMemo(
    () => versions.find((version) => version.id === activeVersionId) || versions[0],
    [activeVersionId, versions],
  );
  const activeAudioUrl = normalizeAudioUrl(activeVersion?.audioSource);

  const comments = activeVersion?.comments || [];
  const mobileDrawerComment = useMemo(
    () => comments.find((comment) => comment.id === mobileCommentDrawerId) || null,
    [comments, mobileCommentDrawerId],
  );
  const audioSource = useMemo(
    () =>
      activeVersion?.audioSource
        ? normalizeAudioSource(activeVersion.audioSource)
        : null,
    [activeVersion?.audioSource],
  );
  const duration = activeVersion?.duration || 0;
  const approvalStatus = activeVersion?.approvalStatus || "Pending Review";
  const selectedCommentId = activeVersion?.selectedCommentId || null;
  const selectedTime = activeVersion?.selectedTime || 0;
  const projectName = projectTitle;
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
  const approvalSummary = useMemo(
    () => getTrackApprovalSummary(syncActiveTrack(tracks, activeTrackId, versions, activeVersionId)),
    [activeTrackId, activeVersionId, tracks, versions],
  );
  const canUploadAudio = permissions.canEdit && isSessionSynced && !isSessionSaving;
  const isReviewerMode = !permissions.canEdit && permissions.canReview;
  const hasPlayableAudio = Boolean(audioSource?.playbackUrl || audioSource?.url || activeAudioUrl);

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }

    console.debug("MixReview selected track audio", {
      selectedTrackExists: Boolean(activeTrack),
      selectedTrackId: activeTrack?.id || null,
      selectedTrackTitle: activeTrack?.title || null,
      selectedVersionExists: Boolean(activeVersion),
      selectedVersionId: activeVersion?.id || null,
      playbackUrl: activeVersion?.audioSource?.playbackUrl || null,
      audioUrl: activeVersion?.audioSource?.audioUrl || null,
      url: activeVersion?.audioSource?.url || null,
      normalizedUrl: activeAudioUrl || null
    });
  }, [activeAudioUrl, activeTrack, activeVersion]);

  const applyStoredSession = useCallback((session, reviewerOverride = null) => {
    if (!session) {
      return;
    }

    const nextTracks = buildInitialTracks(session, buildInitialVersions(session));
    const nextActiveTrackId =
      routeTrackId && nextTracks.some((track) => track.id === routeTrackId)
        ? routeTrackId
        : session.activeTrackId || nextTracks[0]?.id || null;
    const nextActiveTrack = nextTracks.find((track) => track.id === nextActiveTrackId) || nextTracks[0] || null;
    const nextVersions = nextActiveTrack?.versions || createEmptyVersions();
    revokeVersionUrls(versionsRef.current);
    setSessionId(session.id || createSessionId());
    setProjectTitle(session.projectName || emptyProjectName);
    setSessionDetails(buildSessionDetails(session));
    setTracks(nextTracks);
    setActiveTrackId(nextActiveTrackId);
    setVersions(nextVersions);
    setActiveVersionId(
      routeVersionId && nextVersions.some((version) => version.id === routeVersionId)
        ? routeVersionId
        : nextActiveTrack?.activeVersionId || session.activeVersionId || nextVersions[0].id,
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
    setIsPlayerReady(false);
    setMobileNoteDraft(null);
    setHasStarted(true);
    setIsSessionSynced(true);
    playerRef.current = null;
  }, [isEngineerUnlocked]);

  const sessionSnapshot = useMemo(
    () => {
      const nextTracks = syncActiveTrack(tracks, activeTrackId, versions, activeVersionId);
      const activeStoredTrack = nextTracks.find((track) => track.id === activeTrackId) || nextTracks[0] || null;
      return {
        id: sessionId,
        projectName,
        ...sessionDetails,
        status: deriveSessionStatus(sessionDetails, nextTracks),
        shareId,
        activeTrackId,
        activeVersionId,
        hasStarted,
        currentReviewer,
        tracks: nextTracks.map(toStoredTrack),
        versions: activeStoredTrack?.versions.map(toStoredVersion) || [],
        updatedAt: new Date().toISOString()
      };
    },
    [activeTrackId, activeVersionId, currentReviewer, hasStarted, projectName, sessionDetails, sessionId, shareId, tracks, versions],
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
      saveSessionToApi(sessionSnapshot)
        .then(() => {
          lastSavedSessionRef.current = serializedSession;
          setIsSessionSynced(true);
        })
        .catch((error) => {
          setIsSessionSynced(false);
          setSessionMessage(
            error.message || "Session changes are cached locally but could not sync to storage.",
          );
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
      {
        const nextVersions = currentVersions.map((version) =>
        version.id === activeVersionId ? updater(version) : version,
        );
        setTracks((currentTracks) =>
          currentTracks.map((track) =>
            track.id === activeTrackId
              ? { ...track, activeVersionId, versions: nextVersions, updatedAt: new Date().toISOString() }
              : track,
          ),
        );
        return nextVersions;
      }
    );
  }, [activeTrackId, activeVersionId]);

  const ensureSessionPersisted = useCallback(async (session = sessionSnapshot) => {
    if (!session?.id) {
      throw new Error("Create and save a review session before uploading audio.");
    }

    setIsSessionSaving(true);
    try {
      await saveSessionToApi(session);
      setIsSessionSynced(true);
      return session.id;
    } catch (error) {
      setIsSessionSynced(false);
      throw new Error(error.message || "Session could not sync before upload.");
    } finally {
      setIsSessionSaving(false);
    }
  }, [sessionSnapshot]);

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
    const targetTrackId = activeTrackId || createTrackId(title);
    const targetVersionId = activeVersionId || "version-v1";
    setUploadError("Uploading audio to session storage...");
    setSessionMessage("");

    try {
      await ensureSessionPersisted();
      const uploadResult = await uploadSessionAudio(sessionId, targetVersionId, file, targetTrackId);
      const nextAudioSource = normalizeAudioSource({
        playbackUrl: uploadResult.playbackUrl,
        audioUrl: uploadResult.audioUrl,
        url: uploadResult.url,
        key: uploadResult.key,
        storage: uploadResult.storage,
        fileName: uploadResult.fileName || file.name,
        title,
        size: uploadResult.size || file.size,
        type: uploadResult.contentType || file.type || "audio file",
        mimeType: uploadResult.contentType || file.type || null
      });

      setUploadError("");
      setCurrentTime(0);
      setIsPlaying(false);
      setIsPlayerReady(false);
      setMobileNoteDraft(null);
      playerRef.current = null;

      if (!activeTrackId) {
        const nextVersions = createEmptyVersions().map((version) =>
          version.id === targetVersionId
            ? withUploadedAudio(version, nextAudioSource, currentReviewer, file.name)
            : version,
        );
        const nextTrack = createTrack(title, nextVersions, targetTrackId);
        setTracks([nextTrack]);
        setActiveTrackId(targetTrackId);
        setVersions(nextVersions);
        setActiveVersionId(targetVersionId);
        return;
      }

      setTracks((currentTracks) =>
        currentTracks.map((track) => {
          if (track.id !== activeTrackId) {
            return track;
          }
          const nextVersions = versions.map((version) =>
            version.id === targetVersionId
              ? withUploadedAudio(version, nextAudioSource, currentReviewer, file.name)
              : version,
          );
          setVersions(nextVersions);
          return {
            ...track,
            title,
            activeVersionId: targetVersionId,
            versions: nextVersions,
            updatedAt: new Date().toISOString()
          };
        }),
      );
    } catch (error) {
      setUploadError(error.message || "Audio upload failed.");
    }
  }, [activeTrackId, activeVersionId, currentReviewer, ensureSessionPersisted, permissions.canEdit, sessionId, versions]);

  const handleTrackUpload = useCallback(async (file) => {
    if (!permissions.canEdit) {
      return;
    }

    if (!file) {
      return;
    }

    if (!isAudioFile(file)) {
      setUploadError("Choose an audio file to add a track.");
      return;
    }

    const title = deriveProjectTitle(file.name);
    const nextTrackId = createTrackId(title);
    const nextVersionId = "version-v1";
    setUploadError("Uploading track to session storage...");
    setSessionMessage("");

    try {
      await ensureSessionPersisted();
      const uploadResult = await uploadSessionAudio(sessionId, nextVersionId, file, nextTrackId);
      const nextAudioSource = normalizeAudioSource({
        playbackUrl: uploadResult.playbackUrl,
        audioUrl: uploadResult.audioUrl,
        url: uploadResult.url,
        key: uploadResult.key,
        storage: uploadResult.storage,
        fileName: uploadResult.fileName || file.name,
        title,
        size: uploadResult.size || file.size,
        type: uploadResult.contentType || file.type || "audio file",
        mimeType: uploadResult.contentType || file.type || null
      });
      const nextVersions = createEmptyVersions().map((version) =>
        version.id === nextVersionId
          ? withUploadedAudio(version, nextAudioSource, currentReviewer, file.name)
          : version,
      );
      const nextTrack = createTrack(title, nextVersions, nextTrackId);

      setUploadError("");
      setTracks((currentTracks) => [...currentTracks, nextTrack]);
      setActiveTrackId(nextTrackId);
      setVersions(nextVersions);
      setActiveVersionId(nextVersionId);
      setCurrentTime(0);
      setIsPlaying(false);
      setIsPlayerReady(false);
      setMobileNoteDraft(null);
      playerRef.current = null;
    } catch (error) {
      setUploadError(error.message || "Track upload failed.");
    }
  }, [currentReviewer, ensureSessionPersisted, permissions.canEdit, sessionId]);

  const beginNewSession = useCallback(() => {
    revokeVersionUrls(versionsRef.current);
    const nextSessionId = createSessionId();
    setSessionId(nextSessionId);
    setProjectTitle(emptyProjectName);
    setSessionDetails(emptySessionDetails);
    setTracks([]);
    setActiveTrackId(null);
    setVersions(createEmptyVersions());
    setCurrentReviewer("Engineer");
    setActiveVersionId("version-v1");
    setUploadError("");
    setSessionMessage("");
    setShareId(null);
    setHasStarted(false);
    setIsSessionSynced(false);
    setIsSessionSaving(false);
    setAppView("setup");
    saveAccessState({ mode: "admin", sessionId: nextSessionId });
    clearWorkspaceRoute();
    clearStartRouteFlag();
    setCurrentTime(0);
    setIsPlaying(false);
    setIsPlayerReady(false);
    setMobileNoteDraft(null);
    playerRef.current = null;
  }, []);

  const submitSessionSetup = useCallback(async (event) => {
    event.preventDefault();
    const sessionName = sessionDetails.sessionName.trim();
    const artistName = sessionDetails.artistName.trim();
    if (!sessionName || !artistName) {
      setSetupError("Session / Project Name and Artist Name are required.");
      return;
    }

    const nextTitle = `${artistName} - ${sessionName}`;
    const nextDetails = {
      ...sessionDetails,
      sessionName,
      artistName,
      reviewerName: sessionDetails.reviewerName.trim(),
      reviewerClientId: sessionDetails.reviewerClientId.trim(),
      reviewerToken: sessionDetails.reviewerToken.trim(),
      notes: sessionDetails.notes.trim(),
      status: "Draft"
    };
    const draftSession = {
      id: sessionId,
      projectName: nextTitle,
      ...nextDetails,
      shareId,
      activeTrackId: null,
      activeVersionId: "version-v1",
      hasStarted: true,
      currentReviewer: "Engineer",
      tracks: [],
      versions: [],
      updatedAt: new Date().toISOString()
    };

    setSetupError("");
    setSessionMessage("Saving review session...");
    try {
      await ensureSessionPersisted(draftSession);
      setProjectTitle(nextTitle);
      setSessionDetails(nextDetails);
      setHasStarted(true);
      setAppView("workspace");
      setSessionMessage("Session saved. Choose audio to start the review.");
      setReviewRoute("admin", "version-v1", sessionId, null);
      saveAccessState({ mode: "admin", sessionId });
    } catch (error) {
      setSetupError(error.message || "Session could not be saved. Try again before uploading audio.");
      setSessionMessage("");
    }
  }, [ensureSessionPersisted, sessionDetails, sessionId, shareId]);

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
    setIsPlayerReady(false);
    setHasStarted(false);
    setIsSessionSynced(true);
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
    setIsSessionSynced(true);
    saveLatestSession(storedSession);
    saveAccessState({
      mode: reviewer === "Engineer" ? "admin" : "reviewer",
      sessionId: storedSession.id,
      role: reviewer
    });
    setReviewRoute(reviewer === "Engineer" ? "admin" : "reviewer", storedSession.activeVersionId || "version-v1", storedSession.id, storedSession.activeTrackId);
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
      const storedSession = await findReviewerSession(name);
      if (!storedSession) {
        setLoginError("No review session matches that client ID.");
        return;
      }

      const validToken =
        password === storedSession.reviewerToken ||
        password === storedSession.shareId ||
        password === storedSession.id;
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
      setReviewRoute("reviewer", storedSession.activeVersionId || "version-v1", storedSession.id, storedSession.activeTrackId);
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
    setTracks((currentTracks) =>
      currentTracks.map((track) =>
        track.id === activeTrackId ? { ...track, activeVersionId: versionId } : track,
      ),
    );
    setReviewRoute(isEngineerMode ? "admin" : "reviewer", versionId, sessionId, activeTrackId);
    saveAccessState({
      mode: isEngineerMode ? "admin" : "reviewer",
      sessionId,
      role: isEngineerMode ? "Engineer" : currentReviewer
    });
    setCurrentTime(0);
    setIsPlaying(false);
    setIsPlayerReady(false);
    activeMarkerRef.current = null;
    setMobileNoteDraft(null);
    playerRef.current = null;
  }, [activeTrackId, currentReviewer, isEngineerMode, sessionId]);

  const selectTrack = useCallback((trackId) => {
    const nextTracks = syncActiveTrack(tracks, activeTrackId, versions, activeVersionId);
    const nextTrack = nextTracks.find((track) => track.id === trackId);
    if (!nextTrack) {
      return;
    }

    setTracks(nextTracks);
    setActiveTrackId(trackId);
    setVersions(nextTrack.versions);
    setActiveVersionId(nextTrack.activeVersionId || nextTrack.versions[0]?.id || "version-v1");
    setCurrentTime(0);
    setIsPlaying(false);
    setIsPlayerReady(false);
    setMediaElement(null);
    activeMarkerRef.current = null;
    setMobileNoteDraft(null);
    playerRef.current = null;
    setReviewRoute(
      isEngineerMode ? "admin" : "reviewer",
      nextTrack.activeVersionId || nextTrack.versions[0]?.id || "version-v1",
      sessionId,
      trackId,
    );
  }, [activeTrackId, activeVersionId, isEngineerMode, sessionId, tracks, versions]);

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

  const toggleSessionPriority = useCallback(async (session) => {
    if (!session?.id) {
      return;
    }

    setAdminSessions((current) =>
      sortSessionSummaries(
        current.map((candidate) =>
          candidate.id === session.id
            ? { ...candidate, isPriority: !candidate.isPriority }
            : candidate,
        ),
      ),
    );

    try {
      const storedSession = await loadSessionFromApi(session.id);
      if (!storedSession) {
        throw new Error("Session was not found.");
      }

      await saveSessionToApi({
        ...storedSession,
        isPriority: !storedSession.isPriority,
        updatedAt: new Date().toISOString()
      });
      refreshAdminSessions();
    } catch (error) {
      setSessionMessage(error.message || "Priority status could not be saved.");
      refreshAdminSessions();
    }
  }, [refreshAdminSessions]);

  const openAdminSession = useCallback((targetSessionId) => {
    openStoredSession(targetSessionId, "Engineer").catch((error) => {
      setSessionMessage(error.message || "Session could not be opened.");
    });
  }, [openStoredSession]);

  const deleteAdminSession = useCallback(async (session) => {
    if (!session?.id) {
      return;
    }

    setAdminSessions((current) => current.filter((candidate) => candidate.id !== session.id));
    try {
      await deleteSessionFromApi(session.id);
    } catch (error) {
      setSessionMessage(error.message || "Session could not be deleted.");
      refreshAdminSessions();
    }
  }, [refreshAdminSessions]);

  const returnToStart = useCallback(() => {
    playerRef.current?.pause();
    setIsPlaying(false);
    setIsPlayerReady(false);
    setCurrentTime(0);
    setHasStarted(false);
    setMobileNoteDraft(null);
    setAppView("start");
    clearLatestSession();
    clearAccessState();
    window.sessionStorage.removeItem(ADMIN_UNLOCK_SESSION_KEY);
    setIsEngineerUnlocked(false);
    setCurrentReviewer("Artist");
    setIsSessionSynced(false);
    setIsSessionSaving(false);
    setSessionId(createSessionId());
    setProjectTitle(emptyProjectName);
    setTracks([]);
    setActiveTrackId(null);
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

  const handleWaveformTimestamp = useCallback((time, text = "New timestamp marker ready for a mix note.") => {
    if (!permissions.canReview) {
      return;
    }

    const commentId = `comment-${Date.now()}`;
    const author = currentReviewer;
    const newComment = {
      id: commentId,
      time,
      author,
      text: text.trim() || "New timestamp marker ready for a mix note.",
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

  const openMobileNote = useCallback((time) => {
    if (!isReviewerMode) {
      return;
    }

    const safeTime = Math.min(Math.max(time || 0, 0), duration || time || 0);
    setCurrentTime(safeTime);
    updateActiveVersion((version) => ({
      ...version,
      selectedTime: safeTime,
      selectedCommentId: null
    }));
    setMobileNoteDraft({ time: safeTime, text: "" });
  }, [duration, isReviewerMode, updateActiveVersion]);

  const pauseMobileNotePlayback = useCallback(() => {
    playerRef.current?.pause();
    setIsPlaying(false);
  }, []);

  const saveMobileNote = useCallback(() => {
    if (!mobileNoteDraft) {
      return;
    }

    handleWaveformTimestamp(mobileNoteDraft.time, mobileNoteDraft.text);
    setMobileNoteDraft(null);
  }, [handleWaveformTimestamp, mobileNoteDraft]);

  const openMobileCommentDrawer = useCallback((comment) => {
    if (!comment || !isReviewerMode || !isMobileViewport()) {
      return;
    }

    setMobileCommentDrawerId(comment.id);
    setMobileCommentDraft(comment.text || "");
  }, [isReviewerMode]);

  const closeMobileCommentDrawer = useCallback(() => {
    setMobileCommentDrawerId(null);
    setMobileCommentDraft("");
    setDeleteConfirmPending(false);
  }, []);

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

  const saveMobileCommentDrawer = useCallback(() => {
    if (!mobileDrawerComment) {
      return;
    }

    editComment(mobileDrawerComment.id, mobileCommentDraft);
    closeMobileCommentDrawer();
  }, [closeMobileCommentDrawer, editComment, mobileCommentDraft, mobileDrawerComment]);

  const deleteMobileCommentDrawer = useCallback(() => {
    if (!mobileDrawerComment) {
      return;
    }

    deleteComment(mobileDrawerComment.id);
    closeMobileCommentDrawer();
  }, [closeMobileCommentDrawer, deleteComment, mobileDrawerComment]);

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
    if (!isMobileViewport()) {
      playerRef.current?.seekToTime(comment.time);
    }
    if (autoplay) {
      playerRef.current?.play();
    }
    openMobileCommentDrawer(comment);
  }, [openMobileCommentDrawer, updateActiveVersion]);

  const handlePlayerReady = useCallback((controls) => {
    playerRef.current = controls;
    setIsPlayerReady(Boolean(controls));
    setMediaElement(controls?.mediaElement || null);
    if (controls) {
      console.log("MixReview transport player ready", {
        hasWaveSurfer: Boolean(controls.wavesurfer),
        muted: controls.mediaElement?.muted,
        readyState: controls.mediaElement?.readyState
      });
    }
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
    setReviewRoute(reviewer === "Engineer" ? "admin" : "reviewer", activeVersionId, sessionId, activeTrackId);
  }, [activeTrackId, activeVersionId, sessionId]);

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
        onTogglePriority={toggleSessionPriority}
        onDeleteSession={deleteAdminSession}
        onRefresh={refreshAdminSessions}
        onLogout={returnToStart}
      />
    );
  }

  if (appView === "setup" && isEngineerUnlocked) {
    return (
      <SessionSetup
        details={sessionDetails}
        error={setupError}
        onBack={openAdminDashboard}
        onChange={setSessionDetails}
        onSubmit={submitSessionSetup}
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
    <main className={`app-shell${isReviewerMode ? " reviewer-mode" : ""}`}>
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
          <TrackList
            tracks={syncActiveTrack(tracks, activeTrackId, versions, activeVersionId)}
            activeTrackId={activeTrackId}
            canEdit={canUploadAudio}
            onTrackSelect={selectTrack}
            onTrackUpload={handleTrackUpload}
          />

          {(permissions.canEdit || !hasPlayableAudio) && (
            <AudioUpload
              audioSource={audioSource}
              duration={duration}
              error={uploadError}
              disabled={!canUploadAudio}
              onFileSelect={handleAudioUpload}
            />
          )}

          <WaveformReview
            key={`${activeTrackId || "no-track"}-${activeVersionId}`}
            audioSource={audioSource}
            comments={comments}
            selectedCommentId={selectedCommentId}
            selectedTime={selectedTime}
            previewMarkerTime={isReviewerMode ? mobileNoteDraft?.time : null}
            trackTitle={activeTrack?.title}
            onTimestampCreate={handleWaveformTimestamp}
            onMarkerSelect={activateComment}
            onReady={handlePlayerReady}
            onTimeUpdate={handlePlaybackTimeUpdate}
            onDurationChange={updateDuration}
            onPlaybackChange={setIsPlaying}
            isReviewerMode={isReviewerMode}
            onMobileNoteRequest={openMobileNote}
          />
          <SpectrumAnalyzer mediaElement={mediaElement} isPlaying={isPlaying} />
        </div>

        <div className="review-side">
          <ReviewDashboard
            activeVersion={activeVersion}
            versions={versions}
            approvalSummary={approvalSummary}
            activeTrack={activeTrack}
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
            onCommentDrawerOpen={openMobileCommentDrawer}
            currentReviewer={currentReviewer}
            canModifyComment={(comment) => canEditComment(comment, currentReviewer, permissions)}
            canResolve={permissions.canReview}
          />
        </div>
      </section>
      
{mobileCommentDrawerId && (
  <>
    <div
      className="mobile-comment-drawer-backdrop"
      onClick={closeMobileCommentDrawer}
    />
    <aside className="mobile-comment-drawer open" role="dialog" aria-label="Edit timestamp comment">
      {(() => {
        const activeComment = comments.find(
          (comment) => comment.id === mobileCommentDrawerId
        );
        if (!activeComment) return null;
        return (
          <>
            <div className="mobile-comment-drawer-header">
              <div>
                <p className="eyebrow">Timestamp Comment</p>
                <h3>{formatTime(activeComment.time)}</h3>
              </div>
              <button type="button" onClick={closeMobileCommentDrawer}>✕</button>
            </div>
            <textarea
              value={mobileCommentDraft}
              placeholder="Edit your note…"
              onChange={(event) => setMobileCommentDraft(event.target.value)}
            />
            <div className="mobile-comment-drawer-actions">
              <button type="button" onClick={closeMobileCommentDrawer}>
                Cancel
              </button>
              <button
                type="button"
                className="primary-action"
                onClick={() => {
                  editComment(mobileCommentDrawerId, mobileCommentDraft);
                  closeMobileCommentDrawer();
                }}
              >
                Save Review
              </button>
            </div>
            {deleteConfirmPending ? (
              <div className="mobile-comment-delete-confirm">
                <span>Delete this marker?</span>
                <div className="mobile-comment-delete-confirm-actions">
                  <button
                    type="button"
                    className="mobile-comment-delete-confirm-cancel"
                    onClick={() => setDeleteConfirmPending(false)}
                  >
                    Keep
                  </button>
                  <button
                    type="button"
                    className="mobile-comment-delete-confirm-yes"
                    onClick={deleteMobileCommentDrawer}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="mobile-comment-delete"
                onClick={() => setDeleteConfirmPending(true)}
              >
                Delete marker
              </button>
            )}
          </>
        );
      })()}
    </aside>
  </>
)}

      <TransportBar
        currentTime={currentTime}
        duration={duration}
        isPlaying={isPlaying}
        isDisabled={!isPlayerReady}
        onPlayPause={() => playerRef.current?.playPause()}
        onSkipBackward={() => playerRef.current?.skip(-5)}
        onSkipForward={() => playerRef.current?.skip(5)}
      />

      {isReviewerMode && mobileNoteDraft && (
        <>
          <div
            className="mobile-comment-drawer-backdrop"
            onClick={() => setMobileNoteDraft(null)}
          />
          <aside className="mobile-comment-drawer open" role="dialog" aria-label="Add timestamp note">
            <div className="mobile-comment-drawer-header">
              <div>
                <p className="eyebrow">New Timestamp Note</p>
                <h3>{formatTime(mobileNoteDraft.time)}</h3>
              </div>
              <button type="button" onClick={() => setMobileNoteDraft(null)}>✕</button>
            </div>
            <textarea
              value={mobileNoteDraft.text}
              placeholder="Type your feedback for this moment…"
              onChange={(event) =>
                setMobileNoteDraft((draft) =>
                  draft ? { ...draft, text: event.target.value } : draft,
                )
              }
            />
            <div className="mobile-comment-drawer-actions">
              <button type="button" onClick={() => setMobileNoteDraft(null)}>
                Cancel
              </button>
              <button type="button" className="primary-action" onClick={saveMobileNote}>
                Save Review
              </button>
            </div>
          </aside>
        </>
      )}
    </main>
  );
}

function createEmptyVersions() {
  return versionLabels.map((label) => createVersion(label, []));
}

function createTrack(title, versions = createEmptyVersions(), id = createTrackId(title)) {
  return {
    id,
    title: title || "Untitled Track",
    activeVersionId: versions[0]?.id || "version-v1",
    versions,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function AdminDashboard({
  sessions,
  isLoading,
  message,
  onCreateSession,
  onOpenSession,
  onCopyClientLink,
  onTogglePriority,
  onDeleteSession,
  onRefresh,
  onLogout
}) {
  const dashboardStates = ["Draft", ...approvalStates];
  const sortedSessions = sortSessionSummaries(sessions);
  const buckets = dashboardStates.reduce((groups, status) => {
    groups[status] = sortedSessions.filter((session) => (session.status || "Draft") === status);
    return groups;
  }, {});
  const draftSessions = buckets.Draft || [];
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
          <SummaryTile label="Draft" value={draftSessions.length} />
          <SummaryTile label="Pending Reviews" value={pendingSessions.length} />
          <SummaryTile label="Needs Review" value={needsReviewSessions.length} />
          <SummaryTile label="Approved" value={approvedSessions.length} />
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
            {dashboardStates.map((status) => (
              <section className="admin-session-group" key={status}>
                <h2>{status}</h2>
                {(buckets[status] || []).length === 0 ? (
                  <p className="muted-line">No {status.toLowerCase()} sessions.</p>
                ) : (
                  (buckets[status] || []).map((session) => (
                    <article className={`admin-session-row${session.isPriority ? " priority" : ""}`} key={session.id}>
                      <div>
                        <p className="eyebrow">{session.isPriority ? "Priority" : status}</p>
                        <h2>{session.projectName || "Untitled MixReview Session"}</h2>
                        <p>
                          {session.artistName || "No artist"} · {session.reviewerName || session.reviewerClientId || "No reviewer"}
                        </p>
                        <p>
                          {session.trackCount || 0} tracks · {session.approvedTrackCount || 0}/{session.trackCount || 0} approved · Updated {formatDashboardDate(session.updatedAt)}
                        </p>
                      </div>
                      <div className="session-actions">
                        <button type="button" onClick={() => onOpenSession(session.id)}>
                          {status === "Draft" ? "Continue" : "Open"}
                        </button>
                        <button type="button" onClick={() => onTogglePriority(session)}>
                          {session.isPriority ? "Unmark Priority" : "Mark Priority"}
                        </button>
                        <button type="button" onClick={() => onCopyClientLink(session)}>
                          Copy Client Review Link
                        </button>
                        <button
                          type="button"
                          className="session-delete-btn"
                          onClick={() => {
                            if (window.confirm(`Permanently delete "${session.projectName || session.id}"? This cannot be undone.`)) {
                              onDeleteSession(session);
                            }
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </article>
                  ))
                )}
              </section>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function SessionSetup({ details, error, onBack, onChange, onSubmit }) {
  const updateField = (field, value) => {
    onChange((current) => ({ ...current, [field]: value }));
  };

  return (
    <main className="app-shell setup-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">MixReview</p>
          <h1>Create Review Session</h1>
        </div>
        <div className="session-actions">
          <button type="button" onClick={onBack}>
            Admin Dashboard
          </button>
        </div>
      </header>

      <form className="session-setup-form" onSubmit={onSubmit}>
        <label>
          <span>Session / Project Name</span>
          <input value={details.sessionName} onChange={(event) => updateField("sessionName", event.target.value)} />
        </label>
        <label>
          <span>Artist Name</span>
          <input value={details.artistName} onChange={(event) => updateField("artistName", event.target.value)} />
        </label>
        <label>
          <span>Reviewer / Client Name</span>
          <input value={details.reviewerName} onChange={(event) => updateField("reviewerName", event.target.value)} />
        </label>
        <label>
          <span>Reviewer / Client ID</span>
          <input value={details.reviewerClientId} onChange={(event) => updateField("reviewerClientId", event.target.value)} />
        </label>
        <label>
          <span>Optional Reviewer Password / Token</span>
          <input value={details.reviewerToken} onChange={(event) => updateField("reviewerToken", event.target.value)} />
        </label>
        <label className="span-2">
          <span>Notes / Project Description</span>
          <textarea value={details.notes} onChange={(event) => updateField("notes", event.target.value)} />
        </label>
        <label className="checkbox-row span-2">
          <input type="checkbox" checked={details.isPriority} onChange={(event) => updateField("isPriority", event.target.checked)} />
          <span>Mark as Priority</span>
        </label>
        {error && <p className="upload-error span-2">{error}</p>}
        <div className="session-actions span-2">
          <button type="submit">Create Draft Session</button>
        </div>
      </form>
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

function buildSessionDetails(session) {
  return {
    ...emptySessionDetails,
    sessionName: session?.sessionName || "",
    artistName: session?.artistName || "",
    reviewerName: session?.reviewerName || "",
    reviewerClientId: session?.reviewerClientId || "",
    reviewerToken: session?.reviewerToken || "",
    notes: session?.notes || "",
    isPriority: Boolean(session?.isPriority),
    status: session?.status || "Draft"
  };
}

function normalizeAudioUrl(audioSource) {
  if (!audioSource) {
    return null;
  }

  return audioSource.playbackUrl || audioSource.audioUrl || audioSource.url || audioSource.objectUrl || null;
}

function normalizeAudioSource(audioSource) {
  if (!audioSource) {
    return null;
  }

  const url = normalizeAudioUrl(audioSource);
  return {
    ...audioSource,
    playbackUrl: audioSource.playbackUrl || url,
    audioUrl: audioSource.audioUrl || url,
    url,
    objectUrl: audioSource.objectUrl || null,
    needsRelink: Boolean(audioSource.needsRelink && !url)
  };
}

async function findReviewerSession(clientIdOrName) {
  const lookup = clientIdOrName.trim().toLowerCase();
  const sessions = await listSessionsFromApi();
  const match = sessions.find((session) =>
    [session.reviewerClientId, session.reviewerName, session.shareId, session.id]
      .filter(Boolean)
      .some((value) => String(value).trim().toLowerCase() === lookup),
  );

  return match ? loadSessionFromApi(match.id) : null;
}

function sortSessionSummaries(sessions) {
  return [...sessions].sort((a, b) => {
    if (Boolean(a.isPriority) !== Boolean(b.isPriority)) {
      return a.isPriority ? -1 : 1;
    }

    return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
  });
}

function formatDashboardDate(value) {
  if (!value) {
    return "Never";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function deriveSessionStatus(details, tracks) {
  const importedTracks = tracks.filter((track) =>
    track.versions.some((version) => version.audioSource),
  );
  if (importedTracks.length === 0) {
    return "Draft";
  }

  const statuses = importedTracks.map((track) => {
    const activeVersion = track.versions.find((version) => version.id === track.activeVersionId) || track.versions[0];
    return activeVersion?.approvalStatus || "Pending Review";
  });

  if (statuses.length > 0 && statuses.every((status) => status === "Approved")) {
    return "Approved";
  }
  if (statuses.some((status) => status === "Needs Review")) {
    return "Needs Review";
  }
  return "Pending Review";
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
        ? normalizeAudioSource({
            ...session.audioMetadata,
            needsRelink: !normalizeAudioUrl(session.audioMetadata)
          })
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

function buildInitialTracks(session, fallbackVersions = createEmptyVersions()) {
  if (Array.isArray(session?.tracks)) {
    return session.tracks.map(hydrateStoredTrack).filter(Boolean);
  }

  const hasLegacyAudio = fallbackVersions.some((version) => version.audioSource);
  const hasLegacyComments = fallbackVersions.some((version) => version.comments.length > 0);
  if (!hasLegacyAudio && !hasLegacyComments) {
    return [];
  }

  const trackTitle =
    fallbackVersions.find((version) => version.audioSource)?.audioSource?.title ||
    session?.projectName ||
    "Track 1";
  return [createTrack(trackTitle, fallbackVersions, createTrackId(trackTitle))];
}

function hydrateStoredTrack(track) {
  if (!track) {
    return null;
  }

  const versions = ensureBaseVersions((track.versions || []).map(hydrateStoredVersion));
  return {
    id: track.id || createTrackId(track.title || versions[0]?.audioSource?.title || "track"),
    title: track.title || versions[0]?.audioSource?.title || "Untitled Track",
    activeVersionId: track.activeVersionId || versions[0]?.id || "version-v1",
    versions,
    createdAt: track.createdAt || new Date().toISOString(),
    updatedAt: track.updatedAt || new Date().toISOString()
  };
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
      ? normalizeAudioSource({
          ...version.audioMetadata,
          needsRelink: !normalizeAudioUrl(version.audioMetadata)
        })
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

function toStoredTrack(track) {
  return {
    id: track.id,
    title: track.title,
    activeVersionId: track.activeVersionId,
    versions: track.versions.map(toStoredVersion),
    createdAt: track.createdAt,
    updatedAt: track.updatedAt
  };
}

function syncActiveTrack(tracks, activeTrackId, versions, activeVersionId) {
  if (!activeTrackId) {
    return tracks;
  }

  return tracks.map((track) =>
    track.id === activeTrackId
      ? {
          ...track,
          activeVersionId,
          title:
            versions.find((version) => version.audioSource)?.audioSource?.title ||
            track.title,
          versions,
          updatedAt: new Date().toISOString()
        }
      : track,
  );
}

function getTrackApprovalSummary(tracks) {
  const importedTracks = tracks.filter((track) =>
    track.versions.some((version) => version.audioSource),
  );
  return {
    approved: importedTracks.filter((track) => {
      const activeVersion = track.versions.find((version) => version.id === track.activeVersionId) || track.versions[0];
      return activeVersion?.approvalStatus === "Approved";
    }).length,
    total: importedTracks.length
  };
}

function withUploadedAudio(version, audioSource, reviewer, fileName) {
  return {
    ...version,
    audioSource,
    comments: [],
    activity: [
      makeActivity("Version audio replaced", `${reviewer} uploaded ${fileName}`),
      ...version.activity
    ],
    selectedCommentId: null,
    selectedTime: 0,
    duration: 0
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
  if (!version) {
    return {};
  }

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

function isMobileViewport() {
  return window.matchMedia?.("(max-width: 768px)")?.matches || window.innerWidth <= 768;
}

function createSessionId() {
  return `session-${Date.now()}`;
}

function createTrackId(title = "track") {
  return `track-${slugify(title)}-${Date.now()}`;
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
  url.searchParams.delete("track");
  url.searchParams.delete("session");
  url.searchParams.delete("share");
  url.searchParams.delete("role");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function replaceWithLandingRoute() {
  window.history.replaceState(null, "", "/");
}

function setReviewRoute(mode, versionId, sessionId, trackId = null) {
  const url = new URL(window.location.href);
  url.searchParams.delete("start");
  url.searchParams.set("mode", mode);
  url.searchParams.set("version", versionId);
  url.searchParams.set("session", sessionId);
  if (trackId) {
    url.searchParams.set("track", trackId);
  } else {
    url.searchParams.delete("track");
  }
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function hasPersistedRealAudio(session) {
  return Boolean(
    session?.tracks?.some((track) =>
      track.versions?.some((version) => version.audioMetadata?.url),
    ) ||
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
