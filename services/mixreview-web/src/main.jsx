import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles/index.css";

const MOBILE_RESUME_RELOAD_KEY = "mixreview.mobileResumeRecovered";
const MOBILE_REVIEW_MEDIA_QUERY = "(max-width: 768px), (orientation: landscape) and (max-height: 500px)";
const MOBILE_RESUME_WINDOW_NAME_FLAG = "__mixreview_mobile_resume_recovered__";

// Defined at module scope so the reference is stable across renders —
// App's useEffect dependency array sees the same function every time.
function removeLoadingGuard() {
  document.documentElement.classList.remove("app-loading");
}

function isMobileReviewViewport() {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.(MOBILE_REVIEW_MEDIA_QUERY).matches ?? window.innerWidth <= 768;
}

function isTransparentColor(value) {
  return !value || value === "transparent" || value === "rgba(0, 0, 0, 0)";
}

function isStyledMixReviewShell() {
  const root = document.getElementById("root");
  const shell = root?.querySelector(".app-shell");
  const params = new URLSearchParams(window.location.search);
  const expectsWorkspaceShell = params.has("session") || params.has("share") || params.get("mode") === "reviewer";
  if (!root) return true;
  if (!shell) return !expectsWorkspaceShell;
  if (document.documentElement.classList.contains("app-loading")) return false;

  const htmlStyle = window.getComputedStyle(document.documentElement);
  const bodyStyle = window.getComputedStyle(document.body);
  const shellStyle = window.getComputedStyle(shell);
  const fontFamily = `${htmlStyle.fontFamily} ${bodyStyle.fontFamily}`.toLowerCase();
  const hasAppFont = fontFamily.includes("inter") || fontFamily.includes("system-ui") || fontFamily.includes("sans-serif");
  const shellDisplayOk = shellStyle.display === "grid" || shellStyle.display === "flex";
  const shellSpacingOk = parseFloat(shellStyle.paddingTop) > 0 || parseFloat(shellStyle.gap) > 0;

  if (!hasAppFont || !shellDisplayOk || !shellSpacingOk) {
    return false;
  }

  const mobileNav = root.querySelector(".mobile-track-nav");
  if (mobileNav) {
    const navStyle = window.getComputedStyle(mobileNav);
    if (navStyle.display !== "flex" || parseFloat(navStyle.gap) <= 0) {
      return false;
    }
  }

  const styledPanel = root.querySelector(".waveform-panel, .topbar, .review-layout");
  if (styledPanel) {
    const panelStyle = window.getComputedStyle(styledPanel);
    const hasBorder = parseFloat(panelStyle.borderTopWidth) > 0;
    const hasBackground = panelStyle.backgroundImage !== "none" || !isTransparentColor(panelStyle.backgroundColor);
    if (!hasBorder && !hasBackground) {
      return false;
    }
  }

  return true;
}

function clearMobileResumeGuardWhenHealthy() {
  window.setTimeout(() => {
    if (isStyledMixReviewShell()) {
      try {
        window.sessionStorage.removeItem(MOBILE_RESUME_RELOAD_KEY);
      } catch {
        // Best effort; storage can be unavailable in private browsing modes.
      }
      if (window.name.includes(MOBILE_RESUME_WINDOW_NAME_FLAG)) {
        window.name = window.name.replace(MOBILE_RESUME_WINDOW_NAME_FLAG, "");
      }
    }
  }, 600);
}

function hasMobileResumeRecoveryRun() {
  try {
    return window.sessionStorage.getItem(MOBILE_RESUME_RELOAD_KEY) === "1";
  } catch {
    return window.name.includes(MOBILE_RESUME_WINDOW_NAME_FLAG);
  }
}

function markMobileResumeRecoveryRun() {
  try {
    window.sessionStorage.setItem(MOBILE_RESUME_RELOAD_KEY, "1");
  } catch {
    window.name = `${window.name || ""}${MOBILE_RESUME_WINDOW_NAME_FLAG}`;
  }
}

function recoverMobileResumeIfBroken(reason) {
  if (!isMobileReviewViewport()) return;

  window.setTimeout(() => {
    if (!isMobileReviewViewport()) return;

    if (isStyledMixReviewShell()) {
      clearMobileResumeGuardWhenHealthy();
      return;
    }

    if (hasMobileResumeRecoveryRun()) {
      console.warn("[MixReview] Mobile resume still appears unstyled after one recovery reload.", { reason });
      return;
    }

    markMobileResumeRecoveryRun();
    window.location.reload();
  }, 450);
}

function installMobileResumeRecovery() {
  clearMobileResumeGuardWhenHealthy();

  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      recoverMobileResumeIfBroken("pageshow-bfcache");
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      recoverMobileResumeIfBroken("visibility");
    }
  });
}

installMobileResumeRecovery();

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App onFirstRender={removeLoadingGuard} />
  </React.StrictMode>,
);
