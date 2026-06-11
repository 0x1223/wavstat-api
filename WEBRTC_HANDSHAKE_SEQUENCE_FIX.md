# CRITICAL FIX: WebRTC Handshake Sequence Correction

**Commit**: (pending)  
**Date**: 2026-06-10  
**Status**: ✓ DEPLOYED (June 10, 2026, 9:00 PM)  
**Severity**: CRITICAL — Fixes m-line order mismatch preventing WebRTC handshake

---

## The Problem: M-Line Order Mismatch

### WebRTC Fundamental Rule
**Answer SDP must have m-lines in EXACTLY the same order and count as the Offer SDP.**

```
Example INVALID (what was happening):
Offer:   m=audio 0 RTP/SAVPF ...
Answer:  m=application 0 RTP/SAVP ...
         m=audio 0 RTP/SAVPF ...
         ↑ WRONG! Answer has m=application first, offer doesn't have it
         → ERROR: "The order of m-lines in answer doesn't match order in offer"
```

### Root Cause in JUCE Plugin

In `NetworkTransmitter.cpp`, the old sequence was:

```cpp
// OLD (BROKEN):
1. auto peer = std::make_shared<rtc::PeerConnection>(config);
2. auto dataChannel = peer->createDataChannel("kingz-pcm");  ← Create FIRST
3. peer->setRemoteDescription(offer);                        ← Parse AFTER
4. peer->setLocalDescription();                              ← Generate answer
```

When data channel is created BEFORE parsing the offer:
- libdatachannel doesn't know what m-lines the offer has
- It adds m=application to the answer
- But Flutter's offer (audio-only) has NO m=application
- Result: Answer has EXTRA m-line that doesn't match offer → **REJECTION**

---

## The Fix: Reverse the Sequence

### New Correct Order

**File**: `kingz_listen_plugin/Source/NetworkTransmitter.cpp`  
**Function**: `NetworkTransmitter::createPeerConnection()` (lines 1000-1073)

```cpp
// NEW (FIXED):
1. auto peer = std::make_shared<rtc::PeerConnection>(config);
2. peer->setRemoteDescription(offer);                        ← Parse FIRST
3. auto dataChannel = peer->createDataChannel("kingz-pcm");  ← Create AFTER
4. peer->setLocalDescription();                              ← Generate answer
```

**Why this works:**
- Step 2: libdatachannel learns the offer's m-line structure (e.g., "audio-only")
- Step 3: Creating data channel AFTER the offer is known
  - If offer has m=application: negotiate on that line
  - If offer is audio-only: data channel is added without conflicting m-lines
- Step 4: Answer generated with m-lines matching offer's structure

### Code Changes

#### Lines 1002-1073: Reordered Operations

**Before:**
```cpp
// Create data channel first
auto dataChannel = peer->createDataChannel("kingz-pcm", ...);
...
client->pcmChannel = dataChannel;
client->peerConnection = peer;

try {
    peer->setRemoteDescription(...);  ← Wrong order
    peer->setLocalDescription();
}
```

**After:**
```cpp
client->peerConnection = peer;

try {
    // CRITICAL DEBUGGING: Log incoming offer SDP
    const auto offerLines = juce::StringArray::fromLines(sdp);
    int offerMLineCount = 0;
    juce::String offerMLineTypes;
    // ... parse m-lines and log ...
    DBG("[KINGZ] === RECEIVED OFFER SDP ===");
    DBG("[KINGZ] M-line count: " + juce::String(offerMLineCount) + ", types: " + offerMLineTypes);
    // ... log each m= line ...
    
    peer->setRemoteDescription(rtc::Description(sdp.toStdString(), "offer"));  ← NOW FIRST
    
    // CRITICAL: Create data channel AFTER setRemoteDescription
    // This ensures answer m-lines match offer structure
    rtc::DataChannelInit pcmChannelConfig;
    ...
    auto dataChannel = peer->createDataChannel("kingz-pcm", pcmChannelConfig);  ← THEN THIS
    ...
    client->pcmChannel = dataChannel;
    
    peer->setLocalDescription();  ← LAST
}
```

---

## Comprehensive SDP Logging

Added detailed logging at both offer reception and answer generation to diagnose any remaining m-line issues.

### What Gets Logged

**Offer Reception** (lines 1004-1025):
```
[KINGZ] === RECEIVED OFFER SDP ===
[KINGZ] M-line count: 1, types: audio
[KINGZ] OFFER: m=audio 0 RTP/SAVPF 111 63 103 104 ...
[KINGZ] OFFER: a=setup:actpass
[KINGZ] === END OFFER SDP ===
```

**Answer Generation** (lines 934-957):
```
[KINGZ] === JUCE ANSWER SDP ===
[KINGZ] M-line count: 1, types: audio
[KINGZ] ANSWER: m=audio 0 RTP/SAVPF 111 63 103 104 ...
[KINGZ] ANSWER: a=setup:passive
[KINGZ] === END ANSWER SDP ===
```

### How to Read the Logs

1. **Count Check**: Compare m-line count
   - Offer count should equal Answer count
   - ✓ Both "1" = GOOD
   - ✗ Offer "1", Answer "2" = MISMATCH

2. **Type Check**: Compare m-line types
   - Offer: `audio` → Answer should be `audio` (in same order)
   - Offer: `audio` → Answer must NOT be `application,audio`

3. **Setup Attribute Check**: 
   - Offer typically has `a=setup:actpass`
   - Answer should have `a=setup:passive` (answerer role)

---

## Deployment Status

### ✓ Built & Installed

| Component | Status | Location | Size |
|-----------|--------|----------|------|
| **AU Plugin** | ✓ Installed | `~/Library/Audio/Plug-Ins/Components/Kingz Listen.component` | 29 MB |
| **VST3 Plugin** | ✓ Installed | `~/Library/Audio/Plug-Ins/VST3/Kingz Listen.vst3` | 30 MB |
| **Flutter App** | ✓ Built & Running | On iOS device (Kingzbread, iOS 26.5) | 46.2 MB |

### Compilation

- JUCE plugin: **Compiled successfully** (Debug config)
- Flutter app: **Built successfully** (Debug mode for physical device)
- No errors in either build

---

## How to Test

### Manual Testing Guide

**Prerequisites:**
- Logic Pro with Kingz Listen plugin loaded
- Flutter app running on iPhone (Kingzbread device)
- Both connected on same local network (WiFi)

### Step 1: Start Logic Pro with Plugin

```bash
# Open Logic Pro
open /Applications/Logic\ Pro.app

# Verify plugin loads:
# 1. Audio/MIDI Settings → Plug-in Manager
# 2. Search for "Kingz Listen"
# 3. Confirm it's listed (not grayed out)
```

### Step 2: Monitor Plugin Logs

**Option A: Xcode Console** (Real-time)
```bash
# Open Xcode with the plugin project
open /Users/kingzbreadentertainment/wavstat/kingz_listen_plugin/kingz_listen_plugin.xcodeproj

# Build & attach debugger to Logic Pro
# Product > Scheme > Edit Scheme → Run (Executable: Logic Pro)
# Product > Run (cmd+R)

# Logs appear in Xcode console with [KINGZ] prefix
```

**Option B: Console App** (Historical)
```bash
# Open Console.app
open /Applications/Utilities/Console.app

# Filter by process: "Logic Pro" or "AU PlugIn"
# Look for messages starting with "[KINGZ]"
```

### Step 3: Connect on Mobile App

1. **iPhone Screen:**
   - Tap QR Code icon
   - Scan QR from Logic Pro plugin UI
   - OR manually enter plugin address (e.g., `192.168.1.50:8082`)

2. **Expected Sequence in Logs:**

   **First - Offer Reception:**
   ```
   [KINGZ] === RECEIVED OFFER SDP ===
   [KINGZ] M-line count: 1, types: audio
   [KINGZ] OFFER: m=audio 0 RTP/SAVPF ...
   [KINGZ] OFFER: a=setup:actpass
   [KINGZ] === END OFFER SDP ===
   ```

   **Then - Answer Generation:**
   ```
   [KINGZ] === JUCE ANSWER SDP ===
   [KINGZ] M-line count: 1, types: audio
   [KINGZ] ANSWER: m=audio 0 RTP/SAVPF ...
   [KINGZ] ANSWER: a=setup:passive
   [KINGZ] === END ANSWER SDP ===
   ```

   **Then - WebRTC Negotiation:**
   ```
   [KINGZ] onStateChange: state=...
   [KINGZ] onDataChannelOpen: kingz-pcm
   ```

### Step 4: Verify Connection Success

**In Logic Pro Console (If no errors):**
- No "order of m-lines in answer doesn't match order in offer" error
- No "peer_connection_offer_failed" error
- Data channel should open: "webrtc.data-channel-open"

**In iPhone App:**
- Status changes from "Connecting..." to "Connected"
- Waveform visualization appears and updates in real-time
- Audio meters show PCM streaming

**In Xcode Debugger (If attached):**
- `[KINGZ] === JUCE ANSWER SDP ===` appears in console
- M-line count and types match the offer

---

## What to Look For: Success Indicators

### ✓ PASS: M-Line Mismatch FIXED

```
Offer:  M-line count: 1, types: audio
Answer: M-line count: 1, types: audio
        ↓
        MATCH ✓
        ↓
        WebRTC handshake succeeds
        Data channel opens
        Audio streams
```

### ✗ FAIL: M-Line Mismatch Still Exists (indicates further issue)

```
Offer:  M-line count: 1, types: audio
Answer: M-line count: 2, types: application,audio
        ↓
        MISMATCH ✗
        ↓
        Possible causes:
        1. libdatachannel version incompatibility
        2. RTCConfiguration constraints issue
        3. Offer parsing failure (malformed SDP)
```

---

## Troubleshooting

### Symptom: Still getting "order of m-lines" error

**Action 1: Verify offer parsing**
- Check OFFER SDP logs
- Is m-line count correct?
- Is the offer audio-only or does it have application?

**Action 2: Check Flutter constraints**
- Verify Flutter is using `{'offerToReceiveAudio': true}` only
- NOT `{'offerToReceiveAudio': true, 'offerToReceiveVideo': false}`
- NOT with empty constraints `{}`

**Action 3: Verify data channel negotiation**
- If offer has m=application, JUCE answer must also have it
- If offer is audio-only, JUCE answer must be audio-only
- The `createDataChannel()` call after `setRemoteDescription()` handles this

### Symptom: No "[KINGZ]" logs appearing

**Possible Causes:**
1. Plugin not loading in Logic Pro
2. Logs directed to system log instead of console
3. Debug build not deployed

**Solutions:**
- Verify plugin appears in Logic Pro → Audio/MIDI Settings
- Check Console.app for system-level messages
- Confirm latest build installed: `ls -la ~/Library/Audio/Plug-Ins/Components/"Kingz Listen.component/Contents/MacOS/"` shows today's date

---

## Code Summary

| File | Change | Lines | Purpose |
|------|--------|-------|---------|
| NetworkTransmitter.cpp | Reorder peer setup | 1000-1073 | setRemoteDescription BEFORE createDataChannel |
| NetworkTransmitter.cpp | Add offer logging | 1004-1025 | Log incoming offer m-lines for diagnostics |
| NetworkTransmitter.cpp | Add answer logging | 934-957 | Log generated answer m-lines for verification |

---

## Key Learning: Critical WebRTC Rule

**RULE: Answer SDP must have m-lines in the EXACT SAME order as Offer SDP.**

This is enforced by the WebRTC engine itself. It's not a guideline—it's a hard requirement.

**Good Answer:**
```
Offer:  m=audio 0 RTP/SAVPF ... a=setup:actpass
Answer: m=audio 0 RTP/SAVPF ... a=setup:passive
        (Same m-line, different role)
```

**Bad Answer:**
```
Offer:  m=audio 0 RTP/SAVPF ...
Answer: m=video 0 RTP/SAVPF ...   ← Different m-line
        m=audio 0 RTP/SAVPF ...   ← And in wrong order
```

The fix ensures that JUCE respects the offer's m-line structure by parsing it FIRST, before creating any additional negotiation elements (like the data channel).

---

## References

- **Commit**: (pending git commit)
- **Related Fixes**: 
  - [[WEBRTC_LIFECYCLE_FIX.md]] — Peer initialization guard
  - [[WEBRTC_SETREMOTEDESCRIPTION_FIX.md]] — Concurrency serialization
  - [[WEBRTC_SDP_MLINE_FIX.md]] — Flutter offer constraints
- **WebRTC Spec**: [RFC 8829 - SDP Offer/Answer Model](https://tools.ietf.org/html/rfc8829)

---

## Deployment Checklist

- [x] Fix identified: data channel created before offer parsing
- [x] Solution implemented: reorder to setRemoteDescription FIRST
- [x] Logging added: comprehensive SDP diagnostics
- [x] Plugin built: JUCE plugin compiled successfully
- [x] Plugin installed: AU + VST3 in system plugin directories
- [x] App built: Flutter release/debug build created
- [x] App deployed: Running on physical iPhone device
- [ ] Manual testing: Connect and verify logs (PENDING)
- [ ] Verification: Confirm m-line logs match (PENDING)
- [ ] Signoff: WebRTC handshake successful (PENDING)

---

## Next Steps

1. **Immediately**: Open Xcode or Console.app and look for `[KINGZ]` logs when connecting
2. **Verify**: Check that answer m-lines match offer m-lines
3. **Confirm**: Audio should stream successfully if m-lines match
4. **Report**: Share the SDP logs if any mismatch remains

The fix is deployed and ready. The next step is manual verification on the device.

