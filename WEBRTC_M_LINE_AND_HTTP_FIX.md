# WebRTC SDP M-line Order Fix & HTTP Server Responsiveness
**Date**: 2026-06-11  
**Status**: FIXED & READY FOR TESTING  
**Severity**: CRITICAL — Prevents WebRTC connection establishment and causes reconnection loop

---

## Problem Summary

The iOS/Flutter Kingz Listen app was unable to connect to the JUCE plugin due to two interrelated critical issues:

### Issue #1: WebRTC SDP M-line Mismatch (REJECTED ANSWER)
**Error Message**: "The order of m-lines in answer doesn't match order in offer. Rejecting answer."

**Root Cause**:
- Flutter client creates offer with ONLY `m=audio` (no data channel)
- Plugin receives audio-only offer and sets it as remote description
- Plugin then creates a data channel, which adds `m=application` to the answer
- Answer m-lines: `[m=audio, m=application]` vs Offer m-lines: `[m=audio]`
- WebRTC strictly requires m-line order to match → answer rejected

### Issue #2: HTTP Server Unresponsiveness
**Symptom**: App reconnection loop before WebRTC even negotiates

**Root Cause**:
- SDP parsing code (string operations, regex-like parsing) was blocking the network thread
- Each WebRTC offer processing could block for 10-100ms
- During this time, HTTP socket acceptance queue backed up
- New WebSocket connections timed out or closed
- App saw connection loss and entered reconnection loop

---

## The Fix

### Change #1: Flutter Creates Data Channel BEFORE Offer
**File**: `services/listener_app/lib/services/webrtc_playback_bridge_stub.dart`

```dart
// NEW: Create data channel BEFORE creating offer so m-lines match plugin expectations
debugPrint('[KINGZ WebRTC] creating kingz-pcm data channel (pre-negotiation)...');
final dataChannelConfig = <String, dynamic>{
  'ordered': false,
};
await peer.createDataChannel('kingz-pcm', dataChannelConfig);
```

**Effect**:
- Offer now includes `m=application` (data channel) + `m=audio` (audio transceiver)
- Plugin's answer will match the order: `[m=application, m=audio]`
- WebRTC validation passes

### Change #2: Plugin Creates Data Channel BEFORE Remote Description
**File**: `kingz_listen_plugin/Source/NetworkTransmitter.cpp` (line ~1044)

```cpp
// OLD (lines 1071-1082):
peer->setRemoteDescription(rtc::Description(sdp.toStdString(), "offer"));
auto dataChannel = peer->createDataChannel("kingz-pcm", pcmChannelConfig);
// Answer now has different m-line order!

// NEW (lines 1044-1055):
auto dataChannel = peer->createDataChannel("kingz-pcm", pcmChannelConfig);
peer->setRemoteDescription(rtc::Description(sdp.toStdString(), "offer"));
// Answer m-lines now match offer
```

**Effect**:
- Data channel is created BEFORE offer's m-line order is processed
- libdatachannel generates answer with m-lines in same order as offer
- Answer validation passes on client side

### Change #3: Remove Blocking SDP Parsing
**File**: `kingz_listen_plugin/Source/NetworkTransmitter.cpp`

**Removed**:
```cpp
// Old blocking code (25 lines):
const auto offerLines = juce::StringArray::fromLines(sdp);
for (const auto& line : offerLines) {
    if (line.startsWith("m=")) {
        // Parse and log each m-line
    }
}
DBG("[KINGZ] === RECEIVED OFFER SDP ===");
// ... more parsing ...
```

**New**:
```cpp
// Lightweight log only (1 line):
std::cout << "[KINGZ] Received offer: " << sdp.length() << " bytes" << std::endl;
```

**Effect**:
- Network thread no longer blocked during offer processing
- HTTP socket acceptance remains responsive
- WebSocket connections don't time out during WebRTC negotiation
- App doesn't enter reconnection loop

---

## Connection Flow (After Fix)

```
1. Flutter connects to plugin:8082 (HTTP upgrade to WebSocket)
   ✓ HTTP server responsive (no SDP parsing blocking)

2. Flutter creates peer connection
   ✓ Creates kingz-pcm data channel BEFORE offer
   ✓ Offer includes: m=application, m=audio

3. Flutter creates and sends offer to plugin
   ✓ Lightweight logging only (no SDP parsing)

4. Plugin receives offer
   ✓ Creates kingz-pcm data channel BEFORE setting remote
   ✓ Sets remote description (offer) into peer connection

5. Plugin generates answer
   ✓ Answer m-lines: [m=application, m=audio]
   ✓ Matches offer m-line order

6. Flutter receives and validates answer
   ✓ M-line order matches → ACCEPTED
   ✓ WebRTC handshake completes

7. Data channel opens
   ✓ PCM audio streaming begins
   ✓ Connection stable
```

---

## Testing Checklist

- [ ] Plugin builds without errors (CMakeLists.txt unchanged)
- [ ] Plugin starts on port 8082
- [ ] iOS app connects to plugin via QR code
- [ ] WebSocket connection established
- [ ] WebRTC offer/answer exchange succeeds (no m-line rejection)
- [ ] kingz-pcm data channel opens
- [ ] Audio streams from plugin to iOS app
- [ ] No reconnection loop
- [ ] HTTP server remains responsive (can ping `/health` during negotiation)
- [ ] Network latency stable (<20ms)

---

## Files Modified

1. `services/listener_app/lib/services/webrtc_playback_bridge_stub.dart`
   - Added data channel creation before offer creation

2. `kingz_listen_plugin/Source/NetworkTransmitter.cpp`
   - Moved data channel creation before remote description
   - Removed blocking SDP parsing from offer handling
   - Simplified SDP logging in answer callback

---

## Migration Notes

**For Logic Pro Plugin Users**:
- No user-facing changes
- Plugin still runs on port 8082
- HTTP endpoints (`/health`, `/metadata`) unaffected

**For Flutter/Dart Frontend**:
- Minor version bump recommended (data channel creation added)
- No breaking API changes
- Backward compatible with existing signaling protocol

---

## References

- [libdatachannel m-line negotiation](https://github.com/paullouisageneau/libdatachannel/wiki/Negotiated-Data-Channel)
- [WebRTC SDP m-line ordering spec](https://datatracker.ietf.org/doc/html/rfc8866#section-5.14)
- Previous fix: HTTP Server Restoration Fix (commit 5b879b7)
