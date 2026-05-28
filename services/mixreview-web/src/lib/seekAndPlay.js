/**
 * seekAndPlay — lazy-loaded on first comment drawer open.
 *
 * Kept in its own module so Vite code-splits it into a separate chunk
 * that is never fetched during the initial page load. It is imported
 * dynamically (import()) the moment a timestamp comment drawer opens,
 * so the module is resident in memory before the user taps the button.
 *
 * IMPORTANT — iOS gesture-token safety:
 *   seekToTime() is synchronous.  play() is async but we do NOT await it
 *   here — the call must stay inside the same synchronous call stack that
 *   originated from the user's tap event so Safari's audio-unlock gate
 *   is satisfied.  The returned Promise is intentionally ignored; the
 *   engine's own error-handling paths (mobileAudioEngine.js) cover it.
 */
export function seekAndPlay(player, time) {
  if (!player) return;
  // 1. Seek — synchronous, moves the <audio> currentTime immediately.
  player.seekToTime(time);
  // 2. Play — called synchronously after seek so the iOS gesture token
  //    is preserved.  Fire-and-forget; the engine handles rejection.
  player.play();
}
