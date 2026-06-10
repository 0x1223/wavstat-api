# Kingz Listen TCP Backpressure & Buffer Optimization Guide

## Overview
This guide documents the real-time latency optimization strategy for Kingz Listen. The problem: TCP backpressure causes accumulated latency (212ms observed) instead of maintaining target ~5ms. The solution: explicit packet dropping and aggressive queue flushing when latency exceeds thresholds.

---

## COMPLETED: Flutter Client Side (pcm_playback_bridge_web.dart)

### 1. Aggressive Queue Flushing (Latency Ceiling)
**File:** `services/listener_app/lib/services/pcm_playback_bridge_web.dart`

When the scheduled audio lead time exceeds 100ms:
```dart
final scheduledLeadMs = ((_scheduledAt - now) * 1000).round().clamp(0, 1 << 31);
if (scheduledLeadMs > 100) {
  // Latency spike detected — flush queued data and reset
  _generation += 1;
  _stopSources();
  _queuedPcmMessages.clear();
  _queuedPcmBytes.clear();
  _scheduledAt = now + _targetLeadSeconds;
  // Logs to console for debugging
}
```

**Why 100ms threshold?**
- Target latency: ~5ms
- Safe margin: 20-30ms
- Aggressive action threshold: 100ms (20x target)
- At this point, audio quality is already degraded; better to click than accumulate

### 2. Detailed Error Logging
**Files:**
- `services/listener_app/lib/services/pcm_playback_bridge_web.dart` — PCM decode errors
- `services/listener_app/lib/services/lan_audio_client.dart` — WebSocket message handling

All `catch (_)` blocks now log exact exception details to browser console:
```dart
catch (e, st) {
  web.console.log(_structuredLog(
    'pcm.decode-failed: base64 decode error: $e',
    event: 'pcm-decode-base64-error',
  ).toJS);
  debugPrint('[KINGZ] Error: $e\n$st');
}
```

**Console Events Logged:**
- `pcm-decode-base64-error` — payload is not valid base64
- `pcm-decode-invalid-params` — bitDepth or sampleRate invalid
- `pcm-decode-invalid-frames` — decoded frame count is zero
- `pcm-worklet-error` — audio worklet post failed
- `pcm-backpressure-flush` — latency spike triggered queue flush
- `json-decode-error` — WebSocket message not valid JSON
- `pcm-chunk-error` — PCM chunk processing failed

**How to view:**
1. Open browser DevTools (F12)
2. Console tab → Filter: "KINGZ"
3. Look for events with `event: 'pcm-...'`

---

## TODO: JUCE Plugin Side (C++)

The JUCE Logic Pro plugin must implement symmetric optimizations. This code is NOT in the wavstat repo yet.

### 1. Transmission Queue Ceiling (Real-Time Drop Logic)

**Problem:** The plugin holds onto audio data when the TCP socket isn't ready, filling internal buffers.

**Solution:** Implement a strict ceiling on the transmission queue. If the queue size exceeds your target latency worth of PCM frames (e.g., > 10ms), explicitly drop the oldest packets before sending.

**Pseudocode:**
```cpp
// In your audio processing callback or transmission loop
const int TARGET_LATENCY_MS = 5;
const int MAX_QUEUE_FRAMES = (sampleRate / 1000) * TARGET_LATENCY_MS;
// e.g., 48000 Hz => max 240 frames = 5ms

while (transmissionQueue.size() > MAX_QUEUE_FRAMES) {
  // Latency ceiling hit — drop oldest packet to reset
  LOG_WARNING("TCP backpressure: dropping oldest packet. queueSize=" + 
             std::to_string(transmissionQueue.size()) + 
             " targetFrames=" + std::to_string(MAX_QUEUE_FRAMES));
  transmissionQueue.pop_front();  // Drop oldest
  droppedPacketCount++;
}

// Now send current batch
for (auto& packet : transmissionQueue) {
  socket.send(packet);
}
transmissionQueue.clear();
```

**Key thresholds:**
- **5ms target latency** = 240 frames @ 48kHz
- **10ms ceiling** = 480 frames @ 48kHz (when you start dropping)
- **Measurement:** Time from audio capture → network transmission. If this drifts > 10ms, drop.

### 2. Monitor Buffer Health

Log buffer pressure metrics to match Flutter's telemetry:

```cpp
// In status callback or UI update
int bufferUtilization = (queuedFrames * 100) / MAX_QUEUE_FRAMES;
LOG_INFO("Buffer: " + std::to_string(bufferUtilization) + 
         "% queuedFrames=" + std::to_string(queuedFrames) + 
         " sentCount=" + std::to_string(sentPacketCount) + 
         " droppedCount=" + std::to_string(droppedPacketCount));
```

**Health states:**
- **< 30%:** Nominal
- **30-70%:** Building pressure
- **70-90%:** High pressure, monitor jitter
- **> 90%:** Critical, start dropping

### 3. Network Detection & Fallback

When TCP socket write fails or blocks:

```cpp
if (socket.write(packet) == WOULDBLOCK || socket.write(packet) == ERROR) {
  // Socket is blocked — TCP backpressure detected
  LOG_WARNING("TCP write blocked. Activating drop logic.");
  
  // Clear transmission queue immediately
  transmissionQueue.clear();
  droppedPacketCount += queuedPackets;
  
  // Reset scheduler to live edge
  lastSentTimestamp = now;
  
  // Continue with current frame instead of waiting
  // This is the "prefer clicks over latency" strategy
}
```

### 4. Structured Logging Format

Match Flutter's logging format for debugging:

```cpp
// Example structured log
[2026-06-10 14:23:45.123] [KINGZ_AUDIO] event=tcp-backpressure-drop 
  queueSize=480 targetSize=240 droppedPackets=45 bufferHealth=92%
  socketState=WOULDBLOCK timestamp=1234567890
```

---

## Integration Checklist

### Flutter Side (COMPLETED)
- [x] Aggressive queue flushing when lead time > 100ms
- [x] Queue ceiling at 24 packets (PacketQueueManager)
- [x] Detailed PCM decode error logging
- [x] WebSocket message error logging
- [x] Latency metrics in console output

### JUCE Plugin Side (TODO)
- [ ] Implement transmission queue with 10ms ceiling
- [ ] Add explicit packet drop when queue > max size
- [ ] Log buffer health metrics (< 30%, 30-70%, etc.)
- [ ] TCP write error handling and fallback
- [ ] Structured logging matching Flutter format
- [ ] Integration test: verify no accumulated latency under network jitter

---

## Testing & Verification

### Simulating Network Jitter
1. **macOS/Linux:** `tc qdisc add dev en0 root netem delay 50ms jitter 20ms loss 5%`
2. **Windows:** Use NetLimiter or TMeter to add latency

### Observing Buffer Behavior
1. Start Kingz Listen and begin monitoring
2. In browser console, filter for "KINGZ"
3. Look for `pcm-backpressure-flush` events
4. Count occurrences and check `leadMs` value
5. If leadMs > 100ms frequently, JUCE side is accumulating

### Expected Results
- **Without jitter:** leadMs stays < 30ms
- **With 50ms jitter:** leadMs may spike to 80-120ms, then flush
- **With continuous block:** Multiple flush events, but no sustained > 200ms latency

---

## Fallback Strategy: If TCP Still Accumulates

If the JUCE side can't drop packets fast enough, the Flutter client now has a second line of defense:

1. **PCM chunk arrives with leadMs > 100ms**
2. Flutter detects backpressure spike
3. **Aggressive flush triggered:**
   - All queued PCM messages cleared
   - All scheduled audio sources stopped
   - Reset to live edge of stream
4. **Result:** Brief audio dropout (~10-50ms click), but sync is restored immediately

This is **intentional:** A 50ms click is acceptable for a real-time monitoring tool. Accumulated 200ms latency is not.

---

## References
- Flutter PCM bridge: `/services/listener_app/lib/services/pcm_playback_bridge_web.dart` (lines 267-285)
- WebSocket handler: `/services/listener_app/lib/services/lan_audio_client.dart` (lines 318-390)
- Queue manager: `/services/listener_app/lib/services/packet_queue_manager.dart`
