import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioUpload } from "./components/AudioUpload.jsx";
import { CommentSidebar } from "./components/CommentSidebar.jsx";
import { Header } from "./components/Header.jsx";
import { MobileTrackNav } from "./components/MobileTrackNav.jsx";
import { ReviewDashboard } from "./components/ReviewDashboard.jsx";
import { SharePanel } from "./components/SharePanel.jsx";
import { StartScreen } from "./components/StartScreen.jsx";
import { TrackList } from "./components/TrackList.jsx";
import { TransportBar } from "./components/TransportBar.jsx";
import { WaveformReview } from "./components/WaveformReview.jsx";
import { StemPlayer } from "./components/StemPlayer.jsx";
import {
  deleteSessionFromApi,
  listSessionsFromApi,
  loadSessionFromApi,
  saveSessionToApi,
  uploadSessionAudio
} from "./api/sessions.js";
import { startKeepAlive, setMediaSessionMetadata, getSharedAudioContext } from "./lib/mobileAudioEngine.js";
import {
  addDeletedSessionId,
  clearSessionCache,
  clearSharedSession,
  createShareId,
  createShareLink,
  createExportSession,
  getShareRoute,
  isSessionDeleted,
  loadSessionCache,
  loadSharedSession,
  saveSessionCache,
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

// Safe wrapper for sessionStorage access.  Raw window.sessionStorage.getItem()
// calls throw SecurityError on some iOS versions during WebKit process
// re-initialization after deep-sleep eviction.  All module-scope and
// lazy-useState reads use this instead of calling the API directly.
function safeSessionGet(key) {
  try { return window.sessionStorage.getItem(key); } catch { return null; }
}

const routeParams = new URLSearchParams(window.location.search);
const shareRoute = getShareRoute();
const routeMode = routeParams.get("mode");
const routeVersionId = routeParams.get("version");
const routeTrackId = routeParams.get("track");
const forceStartScreen = routeParams.has("start");
const savedAccessState = forceStartScreen ? null : loadAccessState();
// Session identity comes only from URL — never from stale access state.
const routeSessionId = routeParams.get("session") || shareRoute?.shareId || null;
const restoredSession = (() => {
  if (forceStartScreen || !routeSessionId) return null;
  const cached = shareRoute
    ? loadSharedSession(shareRoute.shareId) || loadSessionCache(routeSessionId)
    : loadSessionCache(routeSessionId);
  return cached?.id && isSessionDeleted(cached.id) ? null : cached;
})();
const legacyInitialVersions = buildInitialVersions(restoredSession);
const initialTracks = buildInitialTracks(restoredSession, legacyInitialVersions);
const initialAlbums = buildInitialAlbums(restoredSession);
// If a specific ?track= param is present and valid, honour it; otherwise always
// default to the absolute first track (index 0) so a clean reviewer share link
// never silently lands on an arbitrary mid-session track.
const initialActiveTrackId =
  (routeTrackId && initialTracks.some((t) => t.id === routeTrackId))
    ? routeTrackId
    : initialTracks[0]?.id || null;
const initialActiveTrack = initialTracks.find((track) => track.id === initialActiveTrackId) || initialTracks[0] || null;
const initialVersions = initialActiveTrack?.versions || legacyInitialVersions;
const initialReviewer =
  savedAccessState?.mode === "admin"
    ? "Engineer"
    : routeMode === "reviewer"
    ? "Artist"
    : routeMode === "admin" && safeSessionGet(ADMIN_UNLOCK_SESSION_KEY) === "true"
      ? "Engineer"
      :
  restoredSession?.currentReviewer === "Engineer" &&
  safeSessionGet(ADMIN_UNLOCK_SESSION_KEY) !== "true"
    ? "Artist"
    : restoredSession?.currentReviewer ||
      (safeSessionGet(ADMIN_UNLOCK_SESSION_KEY) === "true" ? "Engineer" : "Artist");

// Unlock the iOS audio session and start the persistent keep-alive AudioContext.
// Called once from the first user Play tap.
//
// On iOS/Safari: startKeepAlive() creates the shared AudioContext (resumed inside
// this gesture), wires a silent looping node to keep iOS from reclaiming the
// session, and exports it for MobileSpectrumAnalyzer to reuse — so the analyser
// continues working after track switches and background/foreground cycles without
// needing another user gesture.
//
// On other browsers: startKeepAlive() is a no-op; we fall through to the
// one-shot temporary context which unlocks any pending Web Audio operations.
function unlockAudioSession() {
  // Start (or no-op if already started) the persistent iOS keep-alive.
  startKeepAlive();

  // Belt-and-suspenders for non-iOS browsers: create+close a temporary context
  // to satisfy any pending AudioContext.resume() calls on the page.
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    const ctx = new Ctx();
    const p = ctx.resume();
    if (p && typeof p.then === "function") {
      p.then(() => { try { ctx.close(); } catch (_) {} }).catch(() => {});
    } else {
      try { ctx.close(); } catch (_) {}
    }
  } catch (_) {}
}

export default function App({ onFirstRender } = {}) {
  // Remove the loading guard (html.app-loading → #root visibility:hidden) after
  // React's first render commits.  useEffect fires post-paint so CSS has been
  // applied before we reveal the UI — eliminates the unstyled-HTML flash.
  useEffect(() => {
    onFirstRender?.();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [sessionId, setSessionId] = useState(
    restoredSession?.id || createSessionId(),
  );
  const [projectTitle, setProjectTitle] = useState(
    restoredSession?.projectName || emptyProjectName,
  );
  const [sessionDetails, setSessionDetails] = useState(buildSessionDetails(restoredSession));
  const [versions, setVersions] = useState(initialVersions);
  const [tracks, setTracks] = useState(initialTracks);
  const [albums, setAlbums] = useState(initialAlbums);
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
      : "start",
  );
  const [adminSessions, setAdminSessions] = useState([]);
  const [isAdminSessionsLoading, setIsAdminSessionsLoading] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [shareId, setShareId] = useState(shareRoute?.shareId || restoredSession?.shareId || null);
  const [isSharePanelOpen, setIsSharePanelOpen] = useState(false);
  const [hasStarted, setHasStarted] = useState(
    Boolean(!forceStartScreen && (shareRoute || restoredSession || routeMode)),
  );
  const [isSessionHydrating, setIsSessionHydrating] = useState(
    // Start hydrating whenever a session ID is present in the URL, even if a
    // local cache was found. The old value (`&& !restoredSession`) allowed the
    // auto-save effect to fire before the API verification GET completed, which
    // could recreate a server-deleted session from a reviewer's localStorage
    // cache on slow networks. By starting as true unconditionally, the auto-save
    // is blocked until the API confirms the session still exists (or marks it gone).
    Boolean(!forceStartScreen && routeSessionId),
  );
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPlayerReady, setIsPlayerReady] = useState(false);
  const [mediaElement, setMediaElement] = useState(null);
  const [mobileNoteDraft, setMobileNoteDraft] = useState(null);
  const [mobileCommentDrawerId, setMobileCommentDrawerId] = useState(null);
  const [mobileCommentDraft, setMobileCommentDraft] = useState("");
  const [deleteConfirmPending, setDeleteConfirmPending] = useState(false);
  // Review-side panel toggle — admin only. Starts open; collapsing gives the
  // full workspace width to the track list and waveform.
  const [isSidePanelOpen, setIsSidePanelOpen] = useState(true);
  const [repeatMode, setRepeatMode] = useState("off");
  // True once the user has tapped the "Tap to Listen" overlay on mobile.
  // Passed to WaveformReview so the overlay is hidden after first play.
  const [mobileHasPlayed, setMobileHasPlayed] = useState(false);
  const [isEngineerUnlocked, setIsEngineerUnlocked] = useState(
    () =>
      safeSessionGet(ADMIN_UNLOCK_SESSION_KEY) === "true" ||
      savedAccessState?.mode === "admin",
  );
  const activeMarkerRef = useRef(null);
  const playerRef = useRef(null);
  const versionsRef = useRef(versions);
  const lastSavedSessionRef = useRef("");
  // Mobile auto-play-next refs (mobile reviewer only).
  // userHasPlayedRef:       true once the user has tapped Play at least once.
  // autoPlayNextRef:        true when a track ends naturally → play next when ready.
  // autoplayAttemptedRef:   prevents double-fire of the isPlayerReady effect per track.
  // tracksRef / activeTrackIdRef / selectTrackRef: always-current mirrors used by
  //   handleNativeEnded so it never reads stale closure values — the ended listener
  //   is attached once per media element and must always see the latest state.
  const userHasPlayedRef = useRef(false);
  const autoPlayNextRef = useRef(false);
  const autoplayAttemptedRef = useRef(false);
  const tracksRef = useRef(tracks);
  const activeTrackIdRef = useRef(activeTrackId);
  const selectTrackRef = useRef(null);
  const repeatModeRef = useRef("off");
  // Holds the seekAndPlay fn once its lazy chunk has been loaded.
  // Pre-warmed when the comment drawer opens so the click handler is
  // synchronous — required to preserve the iOS audio gesture token.
  const _seekAndPlayRef = useRef(null);

  const activeTrack = useMemo(
    () => tracks.find((track) => track.id === activeTrackId) || tracks[0] || null,
    [activeTrackId, tracks],
  );

  // Derive the album that currently owns the active track
  const activeAlbum = useMemo(
    () => albums.find((a) => (a.trackIds || []).includes(activeTrackId)) ?? albums[0] ?? null,
    [activeTrackId, albums],
  );
  const isActiveStemProject = activeAlbum?.type === "stem_project";

  // Build the ordered stems array for StemPlayer (admin stem-project view only).
  // Each entry mirrors the shape StemPlayer expects: { id, title, audioSource }.
  const stemTracks = useMemo(() => {
    if (!isActiveStemProject || !activeAlbum) return [];
    return (activeAlbum.trackIds || [])
      .map((id) => tracks.find((t) => t.id === id))
      .filter(Boolean)
      .map((track) => {
        const ver =
          track.versions.find((v) => v.id === track.activeVersionId) ||
          track.versions[0];
        return {
          id: track.id,
          title: track.title,
          audioSource: ver?.audioSource ? normalizeAudioSource(ver.audioSource) : null,
        };
      });
  }, [isActiveStemProject, activeAlbum, tracks]);

  const activeVersion = useMemo(
    () => versions.find((version) => version.id === activeVersionId) || versions[0],
    [activeVersionId, versions],
  );
  const activeAudioUrl = normalizeAudioUrl(activeVersion?.audioSource);
  const activeTrackIndex = tracks.findIndex((t) => t.id === activeTrackId);
  const hasPrev =
    activeTrackIndex > 0 ||
    (repeatMode === "all" && tracks.length > 1);
  const hasNext =
    (activeTrackIndex >= 0 && activeTrackIndex < tracks.length - 1) ||
    (repeatMode === "all" && tracks.length > 1);

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
    // Mirror the module-level policy: honour an explicit ?track= URL param if valid,
    // otherwise default to tracks[0].  Never fall back to session.activeTrackId so
    // that the post-hydration state exactly matches the pre-hydration initial state —
    // preventing a mid-mount WaveSurfer re-init caused by an activeTrackId change.
    const nextActiveTrackId =
      (routeTrackId && nextTracks.some((track) => track.id === routeTrackId))
        ? routeTrackId
        : nextTracks[0]?.id || null;
    const nextActiveTrack = nextTracks.find((track) => track.id === nextActiveTrackId) || nextTracks[0] || null;
    const nextVersions = nextActiveTrack?.versions || createEmptyVersions();
    revokeVersionUrls(versionsRef.current);
    setSessionId(session.id || createSessionId());
    setProjectTitle(session.projectName || emptyProjectName);
    setSessionDetails(buildSessionDetails(session));
    setTracks(nextTracks);
    setAlbums(buildInitialAlbums(session));
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
    setIsDirty(false);
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
        albums,
        versions: activeStoredTrack?.versions.map(toStoredVersion) || [],
        updatedAt: new Date().toISOString()
      };
    },
    [activeTrackId, activeVersionId, albums, currentReviewer, hasStarted, projectName, sessionDetails, sessionId, shareId, tracks, versions],
  );

  useEffect(() => {
    versionsRef.current = versions;
  }, [versions]);

  useEffect(() => {
    tracksRef.current = tracks;
  }, [tracks]);

  useEffect(() => {
    activeTrackIdRef.current = activeTrackId;
  }, [activeTrackId]);

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

        const isGone = !storedSession || isSessionDeleted(storedSession?.id ?? routeSessionId);
        if (isGone) {
          // Permanently invalidate — write tombstone, wipe all local caches,
          // and reset workspace so stale audio/waveform cannot persist.
          addDeletedSessionId(routeSessionId);
          clearSessionCache(routeSessionId);
          clearSharedSession(routeSessionId);
          setTracks([]);
          setActiveTrackId(null);
          setVersions(createEmptyVersions());
          setActiveVersionId("version-v1");
          setHasStarted(false);
          setIsSessionSynced(false);
          setAppView("start");
          setSessionMessage("This review session no longer exists.");
          replaceWithLandingRoute();
          return;
        }

        applyStoredSession(
          storedSession,
          routeMode === "admin" && isEngineerUnlocked ? "Engineer" : routeMode === "reviewer" ? "Artist" : null,
        );
        saveSessionCache(storedSession);

        // Background probe: verify every track's audio URL is actually
        // reachable.  Marks broken sources needsRelink=true in React state
        // and logs a clear diagnostic so the bad reference is visible in
        // the console without a WaveSurfer error burying the signal.
        if (!isCancelled) {
          probeSessionAudioSources(storedSession).then((brokenRefs) => {
            if (isCancelled || brokenRefs.length === 0) return;
            console.warn(
              "[MixReview] Missing audio source(s) detected — marking needsRelink",
              brokenRefs,
            );
            setTracks((prev) =>
              prev.map((track) => {
                const broken = brokenRefs.find((r) => r.trackId === track.id);
                if (!broken) return track;
                return {
                  ...track,
                  versions: track.versions.map((version) => {
                    if (version.id !== broken.versionId || !version.audioSource) return version;
                    return {
                      ...version,
                      audioSource: { ...version.audioSource, needsRelink: true },
                    };
                  }),
                };
              }),
            );
          });
        }
      })
      .catch(() => {
        if (!isCancelled) {
          // Network error: session status unknown — leave cached content visible
          // but warn the user. Do not destroy the workspace on a transient failure.
          setSessionMessage("Session could not be verified. Check your connection.");
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

    // Never re-persist a session that has been deleted — blocks stale-tab resurrection.
    if (isSessionDeleted(sessionSnapshot?.id)) {
      return;
    }

    // Don't auto-persist blank drafts — only save sessions created by explicit user action.
    // Prevents ghost "Untitled MixReview Session" drafts from being created on page load,
    // tab restore, or failed session lookup.
    const hasSessionContent = Boolean(
      sessionSnapshot?.sessionName?.trim() ||
      (sessionSnapshot?.tracks && sessionSnapshot.tracks.length > 0),
    );
    if (!hasSessionContent) {
      return;
    }

    saveSessionCache(sessionSnapshot);
    if (shareId) {
      saveSharedSession(shareId, sessionSnapshot);
    }

    const serializedSession = JSON.stringify(sessionSnapshot);
    if (serializedSession === lastSavedSessionRef.current) {
      return;
    }

    // Only mark dirty after the first successful save has established a
    // baseline — avoids a false "Unsaved changes" flash on initial load.
    if (lastSavedSessionRef.current !== "") {
      setIsDirty(true);
    }

    const timeoutId = window.setTimeout(() => {
      // Payload sanity guard: abort the PUT if two or more tracks share the
      // same audioMetadata.key.  This is the fingerprint of a state-corruption
      // event (e.g. Track 1 metadata overwriting Track 2 during an async
      // upload) — sending it would permanently corrupt the session document.
      const dupKey = findDuplicateAudioKey(sessionSnapshot.tracks);
      if (dupKey) {
        console.error(
          "[MixReview] AUTO-SAVE BLOCKED — duplicate audioMetadata.key detected across tracks. " +
          "This indicates a cross-track state contamination event. Payload was NOT sent to the server.",
          { duplicateKey: dupKey, tracks: sessionSnapshot.tracks.map((t) => ({ id: t.id, title: t.title })) },
        );
        return;
      }

      saveSessionToApi(sessionSnapshot)
        .then(() => {
          lastSavedSessionRef.current = serializedSession;
          setIsSessionSynced(true);
          setIsDirty(false);
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
      setIsDirty(false);
      return session.id;
    } catch (error) {
      setIsSessionSynced(false);
      throw new Error(error.message || "Session could not sync before upload.");
    } finally {
      setIsSessionSaving(false);
    }
  }, [sessionSnapshot]);

  const handleForceSave = useCallback(() => {
    ensureSessionPersisted().catch((error) => {
      setSessionMessage(error.message || "Session could not be saved.");
    });
  }, [ensureSessionPersisted]);

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

      if (!activeTrackId) {
        const nextVersions = createEmptyVersions().map((version) =>
          version.id === targetVersionId
            ? withUploadedAudio(version, nextAudioSource, currentReviewer, file.name)
            : version,
        );
        const nextTrack = createTrack(title, nextVersions, targetTrackId);
        setTracks([nextTrack]);
        setAlbums((prevAlbums) => prevAlbums.map((album, idx) =>
          idx === 0 ? { ...album, trackIds: [...album.trackIds, targetTrackId] } : album
        ));
        setActiveTrackId(targetTrackId);
        setVersions(nextVersions);
        setActiveVersionId(targetVersionId);
        return;
      }

      // Compute the updated versions OUTSIDE the setTracks functional updater.
      // `versions` is the closure value captured when this handler was last
      // created — it belongs to `targetTrackId`, not to whatever track may be
      // active now if the user switched tracks during the async upload.
      const uploadedVersions = versions.map((version) =>
        version.id === targetVersionId
          ? withUploadedAudio(version, nextAudioSource, currentReviewer, file.name)
          : version,
      );

      // Write the new versions into the correct track slot.
      // No side effects (setVersions) inside the functional updater — that
      // was the bug: calling setVersions here would clobber the versions state
      // of whichever track the user is now on, not the uploaded track.
      setTracks((currentTracks) =>
        currentTracks.map((track) => {
          if (track.id !== targetTrackId) return track;
          return {
            ...track,
            title,
            activeVersionId: targetVersionId,
            versions: uploadedVersions,
            updatedAt: new Date().toISOString()
          };
        }),
      );

      // Only sync the standalone `versions` state when the user has NOT
      // switched to a different track during the async upload.  If they did,
      // leaving `versions` alone is correct — the new active track's versions
      // are already loaded and must not be overwritten with the uploaded
      // track's data (which would cause Track 1 metadata to appear in Track 2).
      if (activeTrackIdRef.current === targetTrackId) {
        setVersions(uploadedVersions);
      } else {
        console.warn(
          "[MixReview] handleAudioUpload: active track changed during upload — " +
          "versions state NOT updated to prevent cross-track metadata contamination",
          { uploadedTrackId: targetTrackId, currentTrackId: activeTrackIdRef.current },
        );
      }
    } catch (error) {
      setUploadError(error.message || "Audio upload failed.");
    }
  }, [activeTrackId, activeVersionId, currentReviewer, ensureSessionPersisted, permissions.canEdit, sessionId, versions]);

  // handleTrackUpload accepts an array of File objects (from a multi-select picker)
  // or a single File for backwards compatibility. Files are uploaded sequentially
  // to preserve selection order; each becomes its own track. Per-file errors are
  // collected and reported at the end rather than aborting the whole batch, so a
  // bad file doesn't prevent valid files in the same selection from uploading.
  const handleTrackUpload = useCallback(async (fileOrFiles, targetAlbumId = null) => {
    if (!permissions.canEdit) return;

    // Normalise to array regardless of how the caller passes the files.
    const files = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
    const validFiles = files.filter(Boolean).filter((f) => {
      if (!isAudioFile(f)) {
        setUploadError("Only audio files can be added as tracks.");
        return false;
      }
      return true;
    });

    if (validFiles.length === 0) return;

    const isMulti = validFiles.length > 1;
    setUploadError(
      isMulti
        ? `Uploading ${validFiles.length} tracks to session storage...`
        : "Uploading track to session storage...",
    );
    setSessionMessage("");

    try {
      await ensureSessionPersisted();
    } catch (error) {
      setUploadError(error.message || "Track upload failed.");
      return;
    }

    const newTracks = [];
    let lastError = null;

    for (let i = 0; i < validFiles.length; i++) {
      const file = validFiles[i];

      if (isMulti) {
        setUploadError(`Uploading track ${i + 1} of ${validFiles.length}...`);
      }

      try {
        const title = deriveProjectTitle(file.name);
        const nextTrackId = createTrackId(title);
        const nextVersionId = "version-v1";

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
        newTracks.push(nextTrack);

        // Add to state immediately so the track list updates as each file lands.
        setTracks((currentTracks) => [...currentTracks, nextTrack]);
        setAlbums((prevAlbums) => {
          const albumIdx = targetAlbumId
            ? prevAlbums.findIndex((a) => a.id === targetAlbumId)
            : 0;
          const destIdx = albumIdx >= 0 ? albumIdx : 0;
          return prevAlbums.map((album, i) =>
            i === destIdx ? { ...album, trackIds: [...album.trackIds, nextTrack.id] } : album
          );
        });
      } catch (error) {
        lastError = error;
        // Continue to the next file — don't abort the whole batch.
      }
    }

    if (newTracks.length === 0) {
      setUploadError(lastError?.message || "Track upload failed.");
      return;
    }

    // Activate the last successfully uploaded track.
    const lastTrack = newTracks[newTracks.length - 1];
    setActiveTrackId(lastTrack.id);
    setVersions(lastTrack.versions);
    setActiveVersionId("version-v1");
    setCurrentTime(0);
    setIsPlaying(false);
    setIsPlayerReady(false);
    setMobileNoteDraft(null);

    setUploadError(
      lastError
        ? `${newTracks.length} of ${validFiles.length} track(s) uploaded — some files failed.`
        : "",
    );

    // Eagerly persist all new tracks at once. sessionSnapshot is captured at
    // call-entry (before any setTracks calls in this loop), so we append all
    // newTracks explicitly rather than relying on the debounced auto-save.
    // albums is also captured at call-entry; add new track IDs to the target album.
    const newTrackIds = newTracks.map((t) => t.id);
    const albumIdx = targetAlbumId ? albums.findIndex((a) => a.id === targetAlbumId) : 0;
    const destAlbumIdx = albumIdx >= 0 ? albumIdx : 0;
    const updatedAlbums = albums.map((album, idx) =>
      idx === destAlbumIdx ? { ...album, trackIds: [...album.trackIds, ...newTrackIds] } : album
    );
    const savedSnapshot = {
      ...sessionSnapshot,
      activeTrackId: lastTrack.id,
      activeVersionId: "version-v1",
      tracks: [...sessionSnapshot.tracks, ...newTracks.map(toStoredTrack)],
      albums: updatedAlbums,
    };
    await saveSessionToApi(savedSnapshot).catch(() => {});
  }, [albums, currentReviewer, ensureSessionPersisted, permissions.canEdit, sessionId, sessionSnapshot]);

  // ── Album management ─────────────────────────────────────────────────────
  // Albums are a parallel index over the flat tracks array. All three handlers
  // only mutate the albums state; tracks remain flat and unchanged so every
  // existing selectTrack / WaveSurfer / transport path is unaffected.

  const handleCreateAlbum = useCallback((title = "New Album", type = "album") => {
    const newAlbum = {
      id: `album-${Date.now()}`,
      title: typeof title === "string" && title.trim() ? title.trim() : "New Album",
      type: type === "stem_project" ? "stem_project" : "album",
      trackIds: [],
      createdAt: new Date().toISOString()
    };
    setAlbums((prev) => [...prev, newAlbum]);
    setIsDirty(true);
  }, []);

  const handleRenameAlbum = useCallback((albumId, newTitle) => {
    if (!albumId || !newTitle?.trim()) return;
    setAlbums((prev) =>
      prev.map((a) => (a.id === albumId ? { ...a, title: newTitle.trim() } : a))
    );
    setIsDirty(true);
  }, []);

  const handleUpdateAlbumType = useCallback((albumId, newType) => {
    if (!albumId) return;
    const validType = newType === "stem_project" ? "stem_project" : "album";
    setAlbums((prev) =>
      prev.map((a) => (a.id === albumId ? { ...a, type: validType } : a))
    );
    setIsDirty(true);
  }, []);

  // Move a track from whichever album currently owns it to targetAlbumId.
  // The track is removed from ALL albums first (guard against duplicates),
  // then appended to the target album. Works with functional updater so it
  // never captures a stale albums snapshot from the closure.
  const handleMoveTrack = useCallback((trackId, targetAlbumId) => {
    if (!trackId || !targetAlbumId) return;
    setAlbums((prev) =>
      prev.map((album) => {
        const without = album.trackIds.filter((id) => id !== trackId);
        if (album.id === targetAlbumId) {
          return { ...album, trackIds: [...without, trackId] };
        }
        return { ...album, trackIds: without };
      })
    );
    setIsDirty(true);
  }, []);
  // ─────────────────────────────────────────────────────────────────────────

  const beginNewSession = useCallback(() => {
    revokeVersionUrls(versionsRef.current);
    const nextSessionId = createSessionId();
    setSessionId(nextSessionId);
    setProjectTitle(emptyProjectName);
    setSessionDetails(emptySessionDetails);
    setTracks([]);
    setAlbums([{ id: "album-default", title: emptyProjectName, type: "album", trackIds: [], createdAt: new Date().toISOString() }]);
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
    clearSessionCache(sessionId);
    startNewSession();
  }, [sessionId, startNewSession]);

  const openAdminDashboard = useCallback(() => {
    playerRef.current?.pause();
    setIsPlaying(false);
    setIsPlayerReady(false);
    // Flush any unsaved workspace state before the auto-save is cancelled by
    // setHasStarted(false). Fire-and-forget: the UI transition is instant.
    if (hasStarted && sessionSnapshot?.id) {
      saveSessionToApi(sessionSnapshot).catch(() => {});
    }
    setHasStarted(false);
    setIsSessionSynced(true);
    setAppView("admin");
    setIsSharePanelOpen(false);
    saveAccessState({ mode: "admin", sessionId });
    clearWorkspaceRoute();
    refreshAdminSessions();
  }, [hasStarted, refreshAdminSessions, sessionId, sessionSnapshot]);

  const openStoredSession = useCallback(async (targetSessionId, reviewer = "Engineer") => {
    const storedSession = await loadSessionFromApi(targetSessionId);
    if (!storedSession) {
      throw new Error("Session was not found.");
    }

    applyStoredSession(storedSession, reviewer);
    setAppView("workspace");
    setHasStarted(true);
    setIsSessionSynced(true);
    saveSessionCache(storedSession);
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
      saveSessionCache(storedSession);
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
    playerRef.current?.pause();
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
  }, [activeTrackId, currentReviewer, isEngineerMode, sessionId]);

  const selectTrack = useCallback((trackId) => {
    const nextTracks = syncActiveTrack(tracks, activeTrackId, versions, activeVersionId);
    const nextTrack = nextTracks.find((track) => track.id === trackId);
    if (!nextTrack) {
      return;
    }

    // Pause immediately before state updates so the old audio stops cleanly.
    // Do NOT null playerRef — the WaveSurfer/<audio> instance is reused for the
    // next track (iOS retains audio permission when the element stays alive).
    playerRef.current?.pause();

    setTracks(nextTracks);
    setActiveTrackId(trackId);
    setVersions(nextTrack.versions);
    setActiveVersionId(nextTrack.activeVersionId || nextTrack.versions[0]?.id || "version-v1");
    setCurrentTime(0);
    setIsPlaying(false);
    setIsPlayerReady(false);
    activeMarkerRef.current = null;
    setMobileNoteDraft(null);
    setReviewRoute(
      isEngineerMode ? "admin" : "reviewer",
      nextTrack.activeVersionId || nextTrack.versions[0]?.id || "version-v1",
      sessionId,
      trackId,
    );
  }, [activeTrackId, activeVersionId, isEngineerMode, sessionId, tracks, versions]);

  // Keep selectTrackRef current so handleNativeEnded always invokes the latest
  // selectTrack without the ended listener needing to be re-attached every time
  // selectTrack is recreated (i.e. every time tracks/versions/activeTrackId changes).
  useEffect(() => {
    selectTrackRef.current = selectTrack;
  }, [selectTrack]);

  // Keep repeatModeRef current so ended-event handlers always see the latest mode.
  useEffect(() => {
    repeatModeRef.current = repeatMode;
  }, [repeatMode]);

  // ── Transport: Repeat / Prev / Next ──────────────────────────────────────
  const handleRepeatChange = useCallback(() => {
    setRepeatMode((current) => {
      if (current === "off") return "one";
      if (current === "one") return "all";
      return "off";
    });
  }, []);

  const handlePrevTrack = useCallback(() => {
    const idx = tracks.findIndex((t) => t.id === activeTrackId);
    if (idx < 0) return;
    let targetId = null;
    if (idx > 0) {
      targetId = tracks[idx - 1].id;
    } else {
      // First track — always wrap to last (standard DAW behaviour; Repeat All
      // also wraps so no special-case needed here).
      targetId = tracks.length > 1 ? tracks[tracks.length - 1].id : tracks[0]?.id ?? null;
    }
    if (!targetId) return;
    // Signal isPlayerReady to call play() once the new track is loaded.
    autoPlayNextRef.current = true;
    if (isMobileViewport() && isReviewerMode && userHasPlayedRef.current) {
      unlockAudioSession();
    }
    selectTrack(targetId);
  }, [activeTrackId, isReviewerMode, selectTrack, tracks]);

  const handleNextTrack = useCallback(() => {
    const idx = tracks.findIndex((t) => t.id === activeTrackId);
    if (idx < 0) return;
    let targetId = null;
    if (idx < tracks.length - 1) {
      targetId = tracks[idx + 1].id;
    } else if (repeatMode === "all" && tracks.length > 1) {
      // Repeat All — wrap around to the beginning.
      targetId = tracks[0].id;
    }
    if (!targetId) {
      // Last track, Repeat All off — stop and park; do not change the track.
      playerRef.current?.pause();
      setIsPlaying(false);
      return;
    }
    // Signal isPlayerReady to call play() once the new track is loaded.
    autoPlayNextRef.current = true;
    if (isMobileViewport() && isReviewerMode && userHasPlayedRef.current) {
      unlockAudioSession();
    }
    selectTrack(targetId);
  }, [activeTrackId, isReviewerMode, repeatMode, selectTrack, tracks]);
  // ─────────────────────────────────────────────────────────────────────────

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
      return;
    }

    // Write tombstone first — blocks all tabs from re-persisting this session.
    addDeletedSessionId(session.id);
    if (session.shareId && session.shareId !== session.id) {
      addDeletedSessionId(session.shareId);
    }

    // Purge all local persistence layers so the deleted session
    // cannot hydrate back on reload.
    clearSessionCache(session.id);
    if (session.shareId && session.shareId !== session.id) {
      clearSessionCache(session.shareId);
    }

    // Clear shared-session registry entries for both the session ID
    // and its shareId (they can differ).
    clearSharedSession(session.id);
    if (session.shareId && session.shareId !== session.id) {
      clearSharedSession(session.shareId);
    }

    // Clear access state if it was pointing at the deleted session.
    const storedAccess = loadAccessState();
    if (storedAccess?.sessionId === session.id) {
      clearAccessState();
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
    clearSessionCache(sessionId);
    clearAccessState();
    window.sessionStorage.removeItem(ADMIN_UNLOCK_SESSION_KEY);
    setIsEngineerUnlocked(false);
    setCurrentReviewer("Artist");
    setIsSessionSynced(false);
    setIsSessionSaving(false);
    setSessionId(createSessionId());
    setProjectTitle(emptyProjectName);
    setTracks([]);
    setAlbums([{ id: "album-default", title: emptyProjectName, type: "album", trackIds: [], createdAt: new Date().toISOString() }]);
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

  // Pre-warm the seekAndPlay lazy chunk the moment either drawer opens
  // (existing comment drawer OR new marker creation drawer) so the module
  // is resident before the user taps the button.
  useEffect(() => {
    if ((mobileCommentDrawerId || mobileNoteDraft) && !_seekAndPlayRef.current) {
      import("./lib/seekAndPlay.js").then((mod) => {
        _seekAndPlayRef.current = mod.seekAndPlay;
      });
    }
  }, [mobileCommentDrawerId, mobileNoteDraft]);

  // Seek to a comment's timestamp and begin playback.
  // Synchronous on first tap (module is pre-warmed above); falls back to
  // inline seek+play on the extremely unlikely cold path.
  const handlePlayFromTimestamp = useCallback((time) => {
    const fn = _seekAndPlayRef.current;
    if (fn) {
      fn(playerRef.current, time);
    } else {
      // Cold fallback — shouldn't happen after pre-warm, but stays safe.
      playerRef.current?.seekToTime(time);
      playerRef.current?.play();
    }
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
    if (!canEditComment(comment, currentReviewer, permissions)) {
      return;
    }
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
  }, [currentReviewer, openMobileCommentDrawer, permissions, updateActiveVersion]);

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

  // Called when the user taps the "Tap to Listen" overlay on mobile.
  // Unlocks the iOS AudioContext in the user-gesture callback, marks
  // userHasPlayedRef so auto-play-next logic is unblocked, hides the overlay,
  // and starts playback if the player is already ready.
  const handleMobileTapPlay = useCallback(() => {
    userHasPlayedRef.current = true;
    setMobileHasPlayed(true);
    unlockAudioSession();
    playerRef.current?.play();
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

  // ── Mobile auto-play-next ─────────────────────────────────────────────────
  // Rules:
  //  • No autoplay on initial load or manual track selection.
  //  • userHasPlayedRef is set only when the user explicitly taps Play.
  //  • autoPlayNextRef is set only when a track ends naturally (native ended
  //    event) and the user has already played at least once this session.
  //  • When the next track's player becomes ready, autoPlayNextRef gates the
  //    play attempt. If the browser blocks it, we stay in ready (paused) state
  //    and never fake a playing state.

  // Reset the per-track autoplay-attempt flag whenever the active track changes
  // so each track gets exactly one autoplay attempt when it becomes ready.
  useEffect(() => {
    autoplayAttemptedRef.current = false;
  }, [activeTrackId, activeVersionId]);

  // When the player is ready, attempt play if:
  //  • autoPlayNextRef is set — track ended naturally OR the user pressed
  //    Prev/Next (all platforms: desktop engineer, desktop reviewer, mobile).
  //  • OR: mobile reviewer who has already tapped Play once manually switches
  //    tracks (session-level intent → keep listening seamlessly).
  // autoplayAttemptedRef prevents firing twice for the same track load.
  useEffect(() => {
    if (!isPlayerReady) return;
    if (autoplayAttemptedRef.current) return;

    const isAutoNext = Boolean(autoPlayNextRef.current);
    if (isAutoNext) autoPlayNextRef.current = false;

    // Mobile-reviewer resume: user has previously tapped Play and then manually
    // selected a track — continue playback without requiring another tap.
    const isMobileReviewerResume =
      isMobileViewport() && isReviewerMode && userHasPlayedRef.current;

    if (!isAutoNext && !isMobileReviewerResume) return;

    autoplayAttemptedRef.current = true;
    const el = mediaElement; // capture — may change if another track is selected mid-await
    (async () => {
      // Track whether 'playing' fires so we can detect a stall.
      let playingFired = false;
      function onPlayingOnce() { playingFired = true; }
      el?.addEventListener("playing", onPlayingOnce, { once: true });

      try {
        await playerRef.current?.play();

        // Stall guard: play() resolved but if 'playing' still hasn't fired
        // and currentTime has not advanced after 800 ms, the audio is stuck
        // (AudioContext suspended, iOS blocked internally, etc.).
        // Reset to Play state rather than leaving a fake Pause showing.
        setTimeout(() => {
          el?.removeEventListener("playing", onPlayingOnce);
          if (!playingFired && el && !el.paused && el.currentTime < 0.05) {
            console.log("[MixReview] Stall detected — play() resolved but audio did not start; resetting to Play state");
            try { el.pause(); } catch (_) {}
          }
        }, 800);
      } catch (e) {
        // Browser policy blocked autoplay (NotAllowedError) or another error.
        // 'play' event may have fired before the rejection, which would have
        // optimistically set isPlaying=true. Call pause() to correct the UI.
        el?.removeEventListener("playing", onPlayingOnce);
        console.log("[MixReview] Autoplay blocked — waiting for Play tap", e?.name);
        try { el?.pause(); } catch (_) {}
      }
    })();
  }, [isPlayerReady, isReviewerMode, activeTrackId, activeVersionId]);

  // ── Track-end state machine (all modes, all platforms) ───────────────────
  // Single "ended" listener replaces the old split between handleNativeEnded
  // (mobile-reviewer only) and handleRepeatEnded.  All mutable values come from
  // refs so the listener is attached exactly once per mediaElement and always
  // reads the latest state without needing to be re-registered on every render.
  //
  // Repeat One  — seekToTime(0) + play() in a short timeout.  playerRef is read
  //               INSIDE the timeout (not captured before it) to avoid operating
  //               on a destroyed WaveSurfer instance if the user skips during the
  //               80 ms window.
  // Repeat All  — advance sequentially and wrap from the last track to index 0.
  //               Single-track playlists loop by seeking rather than re-selecting.
  // Repeat Off  — advance sequentially to the next track.  On mobile, guard with
  //               userHasPlayedRef so we never trigger before the iOS AudioContext
  //               has been unlocked by the user's first tap.  On desktop there is
  //               no such restriction.  When the last track ends, do nothing —
  //               WaveSurfer already stopped; the UI parks at the end position.
  useEffect(() => {
    if (!mediaElement) return;

    function handleTrackEnded() {
      const mode = repeatModeRef.current;

      // ── Repeat One ──────────────────────────────────────────────────────
      if (mode === "one") {
        playerRef.current?.seekToTime(0);
        playerRef.current?.play()?.catch?.(() => {});
        return;
      }

      // ── Repeat All ──────────────────────────────────────────────────────
      if (mode === "all") {
        const allTracks = tracksRef.current;
        const currId   = activeTrackIdRef.current;
        const idx      = allTracks.findIndex((t) => t.id === currId);
        if (idx < 0) return;

        if (allTracks.length === 1) {
          playerRef.current?.seekToTime(0);
          playerRef.current?.play()?.catch?.(() => {});
          return;
        }

        const nextIdx = idx < allTracks.length - 1 ? idx + 1 : 0;
        console.log("[MixReview] Repeat All — advancing to track index", nextIdx);
        autoPlayNextRef.current = true;
        selectTrackRef.current?.(allTracks[nextIdx].id);
        return;
      }

      // ── Repeat Off: sequential auto-advance ─────────────────────────────
      // Mobile guard: require at least one user-initiated Play so we never
      // trigger programmatic playback before the iOS AudioContext is unlocked.
      if (isMobileViewport() && !userHasPlayedRef.current) return;

      const allTracks = tracksRef.current;
      const currId   = activeTrackIdRef.current;
      const idx      = allTracks.findIndex((t) => t.id === currId);

      if (idx < 0 || idx >= allTracks.length - 1) {
        // Last track — stop and park. WaveSurfer has already stopped; nothing to do.
        return;
      }

      const nextTrack = allTracks[idx + 1];
      console.log("[MixReview] Track ended — auto-advancing to:", nextTrack.title);
      autoPlayNextRef.current = true;
      selectTrackRef.current?.(nextTrack.id);
    }

    mediaElement.addEventListener("ended", handleTrackEnded);
    return () => mediaElement.removeEventListener("ended", handleTrackEnded);
  }, [mediaElement]);
  // ─────────────────────────────────────────────────────────────────────────

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

  // ── Media Session skip handlers (iOS/Android lock screen & Control Center) ──
  // Registers previoustrack / nexttrack so the lock screen shows ⏮ ⏭ skip
  // buttons instead of the ⏪10 ⏩10 seek buttons produced by seekbackward /
  // seekforward.  Cleaned up on unmount so stale handlers don't persist.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler("previoustrack", handlePrevTrack);
      navigator.mediaSession.setActionHandler("nexttrack", handleNextTrack);
    } catch (_) {}
    return () => {
      try {
        navigator.mediaSession.setActionHandler("previoustrack", null);
        navigator.mediaSession.setActionHandler("nexttrack", null);
      } catch (_) {}
    };
  }, [handlePrevTrack, handleNextTrack]);

  // ── Media Session metadata — lock screen Now Playing card ────────────────
  // Updates title/artist/album on the iOS/Android lock screen player card
  // whenever the active track or session context changes.
  useEffect(() => {
    setMediaSessionMetadata({
      title:  activeTrack?.title  || "MixReview",
      artist: sessionDetails.artistName || "MixReview",
      album:  projectName         || "Kingz Bread Entertainment",
    });
  }, [activeTrack, sessionDetails.artistName, projectName]);

  // ── AudioContext visibility-restore belt-and-suspenders ──────────────────
  // The engine (mobileAudioEngine.js) already owns the full restore sequence:
  // suspend on hide → resume on show → play if _wasPlayingOnHide.
  // This effect is a lightweight React-layer complement for the narrow case
  // where the engine's WaveSurfer instance was not yet mounted when the page
  // came back into view (e.g. the user backgrounded before pressing Play).
  // It ONLY resumes the AudioContext — it never calls play() — so it cannot
  // race with the engine's own _onRestoreVisible() → mediaEl.play() chain.
  //
  // Critical fix vs the naive pattern:
  //   WRONG:  const ctx = window.AudioContext || window.webkitAudioContext
  //           → that is the CONSTRUCTOR.  ctx.state is always undefined.
  //           ctx.resume() throws "not a function".  The block silently
  //           never runs regardless of the if-guard.
  //   RIGHT:  getSharedAudioContext() returns the live _sharedCtx instance
  //           created by startKeepAlive() — the only object that has .state.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;

      const ctx = getSharedAudioContext();
      // Nothing to resume: keep-alive context hasn't been created yet
      // (user hasn't tapped Play) or is already running.
      if (!ctx || ctx.state === "running") return;

      ctx.resume().catch((err) => {
        console.warn("[MixReview] AudioContext resume on visibility restore failed:", err.message);
      });
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []); // no deps — getSharedAudioContext reads the module-level singleton

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
        {isEngineerMode && hasStarted && (
          <div style={{ display: "flex", alignItems: "center", gap: "10px", fontSize: "0.82rem" }}>
            <span style={{ opacity: 0.55 }}>
              {isSessionSaving ? "Saving…" : isDirty ? "Unsaved changes" : "Saved"}
            </span>
            <div className="session-actions">
              <button type="button" onClick={handleForceSave} disabled={isSessionSaving || !isDirty}>
                Save Changes
              </button>
              <button
                type="button"
                className="panel-toggle-btn"
                onClick={() => setIsSidePanelOpen((v) => !v)}
                title={isSidePanelOpen ? "Hide review panel" : "Show review panel"}
              >
                {isSidePanelOpen ? "◀ Hide Panel" : "▶ Show Panel"}
              </button>
            </div>
          </div>
        )}
      </div>

      <section
        className={`review-layout${isEngineerMode && !isSidePanelOpen ? " side-collapsed" : ""}`}
        aria-label="Mix review workspace"
      >
        <div className="review-main">
          {isReviewerMode && tracks.length > 1 && (
            <MobileTrackNav
              tracks={syncActiveTrack(tracks, activeTrackId, versions, activeVersionId)}
              albums={albums}
              activeTrackId={activeTrackId}
              onTrackSelect={(trackId) => {
                // This runs synchronously inside the user's tap gesture.
                // Clear any pending auto-next flag (manual selection takes over).
                autoPlayNextRef.current = false;
                // If the user has already pressed Play this session, refresh the
                // iOS audio session so the programmatic play() called later by
                // the isPlayerReady effect succeeds without needing its own gesture.
                if (isMobileViewport() && isReviewerMode && userHasPlayedRef.current) {
                  unlockAudioSession();
                }
                selectTrack(trackId);
              }}
            />
          )}

          <TrackList
            tracks={syncActiveTrack(tracks, activeTrackId, versions, activeVersionId)}
            albums={albums}
            activeTrackId={activeTrackId}
            canEdit={canUploadAudio}
            onTrackSelect={selectTrack}
            onTrackUpload={handleTrackUpload}
            onCreateAlbum={handleCreateAlbum}
            onRenameAlbum={handleRenameAlbum}
            onUpdateAlbumType={handleUpdateAlbumType}
            onMoveTrack={handleMoveTrack}
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

          {/* Admin + stem project → multi-lane StemPlayer.
              All other contexts → standard single-track WaveformReview.
              key={activeAlbum?.id} forces a clean remount when the engineer
              switches to a different stem project so stale WaveSurfer
              instances from the previous album are fully torn down. */}
          {isEngineerMode && isActiveStemProject ? (
            <StemPlayer
              key={activeAlbum?.id}
              stems={stemTracks}
              trackTitle={activeAlbum?.title}
              selectedTime={selectedTime}
              onReady={handlePlayerReady}
              onTimeUpdate={handlePlaybackTimeUpdate}
              onDurationChange={updateDuration}
              onPlaybackChange={setIsPlaying}
            />
          ) : (
            <WaveformReview
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
              onMobileTapPlay={handleMobileTapPlay}
              mobilePlayUnlocked={mobileHasPlayed}
              onPrevTrack={handlePrevTrack}
              onNextTrack={handleNextTrack}
            />
          )}
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
                <div className="drawer-timestamp-row">
                  <h3>{formatTime(activeComment.time)}</h3>
                  <button
                    type="button"
                    className="drawer-play-btn"
                    disabled={!isPlayerReady}
                    onClick={() => handlePlayFromTimestamp(activeComment.time)}
                    aria-label={`Play from ${formatTime(activeComment.time)}`}
                    title={`Play from ${formatTime(activeComment.time)}`}
                  >
                    ▶ Play from here
                  </button>
                </div>
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
        onPlayPause={() => {
          // Record the first real user Play tap (not a Pause press).
          // isPlaying reflects the current state, so !isPlaying means the
          // user is about to start playback.
          if (isMobileViewport() && isReviewerMode && !isPlaying) {
            userHasPlayedRef.current = true;
            setMobileHasPlayed(true);
            // Prime the iOS audio session so that AudioContext.resume() calls
            // in MobileSpectrumAnalyzer succeed without their own gesture token.
            unlockAudioSession();
          }
          playerRef.current?.playPause();
        }}
        onSkipBackward={() => playerRef.current?.skip(-5)}
        onSkipForward={() => playerRef.current?.skip(5)}
        repeatMode={repeatMode}
        hasPrev={hasPrev}
        hasNext={hasNext}
        onPrev={handlePrevTrack}
        onNext={handleNextTrack}
        onRepeatChange={handleRepeatChange}
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
                <div className="drawer-timestamp-row">
                  <h3>{formatTime(mobileNoteDraft.time)}</h3>
                  <button
                    type="button"
                    className="drawer-play-btn"
                    disabled={!isPlayerReady}
                    onClick={() => handlePlayFromTimestamp(mobileNoteDraft.time)}
                    aria-label={`Play from ${formatTime(mobileNoteDraft.time)}`}
                    title={`Play from ${formatTime(mobileNoteDraft.time)}`}
                  >
                    ▶ Play from here
                  </button>
                </div>
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
  const needsReviewSessions = buckets["Needs Review"] || [];
  const approvedSessions = buckets.Approved || [];
  // Count non-approved tracks across all sessions so the tile reflects
  // individual track workload, not just session count.
  const pendingTrackCount = sessions.reduce(
    (sum, s) => sum + Math.max(0, (s.trackCount || 0) - (s.approvedTrackCount || 0)),
    0
  );

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
              window.localStorage.removeItem("mixreview.accessState");
              window.sessionStorage.removeItem("mixreview.engineerUnlocked");
              window.history.replaceState(null, "", "/");
              onLogout();
            }}
          >
            Logout
          </button>
        </div>
      </header>

      {message && <div className="session-message">{message}</div>}

      <section className="admin-dashboard" aria-label="Admin dashboard">
        <div className="summary-grid">
          <SummaryTile label="Draft" value={draftSessions.length} />
          <SummaryTile label="Pending Reviews" value={pendingTrackCount} />
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
    // needsRelink: keep true if caller set it (e.g. probe detected a 404),
    // OR set true when there is no URL at all.  Do NOT clear it just because
    // a URL string is present — the URL may be stale/broken.
    needsRelink: Boolean(audioSource.needsRelink) || !url
  };
}

/**
 * probeSessionAudioSources — HEAD-check every stored audio URL in a session
 * document immediately after hydration, before WaveSurfer tries to load them.
 *
 * Returns an array of broken-reference descriptors:
 *   [{ trackId, trackTitle, versionId, versionLabel, url, status|error }, ...]
 *
 * Only checks:
 *   • versions that have a non-null URL
 *   • non-blob URLs (blobs are local — they can't be probed)
 *   • the first version per track that has audio (one probe per track is enough
 *     to surface the problem without hammering the storage backend)
 *
 * Runs all probes in parallel (Promise.allSettled) so it never blocks
 * the UI — results arrive ~200–600 ms after hydration on a normal connection.
 */
/**
 * findDuplicateAudioKey — scans the tracks array of a session snapshot and
 * returns the first audioMetadata.key value that appears on more than one
 * distinct track's active version.  Returns null when all keys are unique.
 *
 * Used as a payload sanity guard before auto-save: if two tracks share a key
 * it means Track 1's audioMetadata was stamped into Track 2's slot (or vice
 * versa) by a cross-track state contamination event and the PUT must be
 * blocked to prevent permanently corrupting the session document.
 */
function findDuplicateAudioKey(tracks) {
  if (!Array.isArray(tracks) || tracks.length < 2) return null;
  const seen = new Set();
  for (const track of tracks) {
    const versions = Array.isArray(track.versions) ? track.versions : [];
    const activeVersion =
      versions.find((v) => v.id === track.activeVersionId) || versions[0];
    const key = activeVersion?.audioMetadata?.key;
    if (!key) continue;
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return null;
}

async function probeSessionAudioSources(session) {
  const tracks = Array.isArray(session?.tracks) ? session.tracks : [];
  const candidates = [];

  for (const track of tracks) {
    const versions = Array.isArray(track.versions) ? track.versions : [];
    // Find the active version first; fall back to any version that has a URL.
    const activeVersion = versions.find((v) => v.id === track.activeVersionId) || versions[0];
    const versionsToCheck = activeVersion ? [activeVersion] : [];

    for (const version of versionsToCheck) {
      const meta = version.audioMetadata;
      const url = meta?.playbackUrl || meta?.url || meta?.audioUrl || null;
      if (!url || url.startsWith("blob:")) continue;
      candidates.push({ trackId: track.id, trackTitle: track.title, versionId: version.id, versionLabel: version.label, url });
    }
  }

  if (candidates.length === 0) return [];

  const results = await Promise.allSettled(
    candidates.map(async (candidate) => {
      try {
        const response = await fetch(candidate.url, { method: "HEAD", cache: "no-store" });
        if (!response.ok) {
          return { ...candidate, status: response.status, broken: true };
        }
        console.log("[MixReview] Audio source OK", {
          track: candidate.trackTitle,
          version: candidate.versionLabel,
          status: response.status,
        });
        return { ...candidate, status: response.status, broken: false };
      } catch (error) {
        return { ...candidate, error: error.message, broken: true };
      }
    }),
  );

  return results
    .filter((r) => r.status === "fulfilled" && r.value.broken)
    .map((r) => r.value);
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
            needsRelink: session.audioMetadata.needsRelink || !normalizeAudioUrl(session.audioMetadata)
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

// buildInitialAlbums — hydrates the albums array from a stored session document
// (or returns a sensible default when no session is available).
//
// Mirror the server-side normalizeAlbums logic: if the session has no albums,
// create a single default album whose trackIds match the flat tracks array.
// This keeps the client and server consistent without a separate migration step.
function buildInitialAlbums(session) {
  const rawAlbums = Array.isArray(session?.albums) ? session.albums : [];
  const rawTracks = Array.isArray(session?.tracks) ? session.tracks : [];

  if (rawAlbums.length > 0) {
    // Validate: strip any trackId that no longer exists in tracks.
    const trackIdSet = new Set(rawTracks.map((t) => t.id).filter(Boolean));
    return rawAlbums.map((album) => ({
      id: album.id || `album-${Date.now()}`,
      title: album.title || "Untitled Album",
      type: album.type === "stem_project" ? "stem_project" : "album",
      trackIds: (Array.isArray(album.trackIds) ? album.trackIds : []).filter((id) => trackIdSet.has(id)),
      createdAt: album.createdAt || new Date().toISOString()
    }));
  }

  // No albums in the document → create one default album from all tracks.
  return [{
    id: "album-default",
    title: session?.projectName || emptyProjectName,
    type: "album",
    trackIds: rawTracks.map((t) => t.id).filter(Boolean),
    createdAt: session?.createdAt || new Date().toISOString()
  }];
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
          // needsRelink starts true when there is no URL; the post-hydration
          // probe may also set it true for URLs that exist but return non-2xx.
          needsRelink: version.audioMetadata.needsRelink || !normalizeAudioUrl(version.audioMetadata)
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

  return comment.author === reviewer;
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
  // Matches the CSS breakpoint: portrait phones (width ≤ 768px) OR
  // landscape phones (height ≤ 500px in landscape — excludes iPads).
  return (
    window.matchMedia?.("(max-width: 768px)")?.matches ||
    window.innerWidth <= 768 ||
    (window.matchMedia?.("(orientation: landscape) and (max-height: 500px)")?.matches ?? false)
  );
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
