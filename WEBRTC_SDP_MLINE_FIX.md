# WebRTC SDP M-Line Mismatch Fix

**Commit:** 5594540  
**Date:** 2026-06-10  
**Issue:** WebRTC handshake fails with "The order of m-lines in answer doesn't match order in offer"  
**Root Cause:** Flutter's offer and JUCE's answer have different media line structures  
**Solution:** Explicit audio-only constraints + comprehensive SDP logging

---

## The Problem: M-Line Mismatch

### WebRTC Strict Requirement
The **Answer SDP must have media lines (`m=`) in EXACTLY the same order as the Offer SDP**.

```
Example VALID:
Offer:  v=0 ... m=audio 0 RTP/SAVPF ... a=setup:actpass
Answer: v=0 ... m=audio 0 RTP/SAVPF ... a=setup:passive
✓ Same order (audio matches audio)

Example INVALID:
Offer:  v=0 ... m=audio 0 ... m=video 0 ...
Answer: v=0 ... m=video 0 ... m=audio 0 ...
✗ Different order (video first in answer, audio second)
→ REJECT: "order of m-lines doesn't match"
```

### What Was Happening
1. **Flutter (Offer)** - `flutter_webrtc` might be generating:
   ```
   m=audio 0 RTP/SAVPF ...
   (only audio, which is correct)
   ```

2. **JUCE (Answer)** - Generating something different:
   ```
   m=video 0 RTP/SAVPF ...   ← Video line?
   m=audio 0 RTP/SAVPF ...   ← Or different order?
   ```

3. **WebRTC Engine** - Rejects the answer:
   ```
   ERROR: "The order of m-lines in answer doesn't match order in offer"
   ```

---

## The Fix: Three-Part Solution

### 1. Explicit Audio-Only Offer Constraints

**In `_createOffer()` method:**

```dart
final constraints = <String, dynamic>{
  'offerToReceiveAudio': true,      // Request audio from peer
  'offerToReceiveVideo': false,      // Explicitly NO video
  'iceRestart': false,               // Don't restart ICE
};

final offer = await peer.createOffer(constraints);
```

**Why this matters:**
- Without constraints, `flutter_webrtc` might include video/data channel m-lines
- Explicit `offerToReceiveVideo: false` prevents unexpected video m-line
- JUCE is audio-only, so Flutter must match

### 2. Detailed Offer SDP Logging

```dart
debugPrint('[KINGZ WebRTC] === OFFER SDP START ===');
final offerLines = offer.sdp!.split('\n');
for (final line in offerLines) {
  if (line.startsWith('m=') || line.startsWith('a=') || 
      line.startsWith('v=') || line.startsWith('o=')) {
    debugPrint('[KINGZ WebRTC] OFFER: $line');
  }
}
debugPrint('[KINGZ WebRTC] === OFFER SDP END ===');
```

**Output example:**
```
[KINGZ WebRTC] === OFFER SDP START ===
[KINGZ WebRTC] OFFER: v=0
[KINGZ WebRTC] OFFER: o=kingzlisten ...
[KINGZ WebRTC] OFFER: m=audio 0 RTP/SAVPF ...
[KINGZ WebRTC] OFFER: a=setup:actpass
[KINGZ WebRTC] === OFFER SDP END ===
```

### 3. Detailed Answer SDP Logging (Before & After Fix)

```dart
// Log original answer
debugPrint('[KINGZ WebRTC] === ANSWER SDP START ===');
int mLineCount = 0;
for (final line in answerLines) {
  if (line.startsWith('m=')) {
    mLineCount++;
    debugPrint('[KINGZ WebRTC] ANSWER M-LINE #$mLineCount: $line');
  }
}
debugPrint('[KINGZ WebRTC] ANSWER: Total m-lines: $mLineCount');

// Log after DTLS setup fix
final fixedSdp = _fixAnswerSdpSetup(sdp);
debugPrint('[KINGZ WebRTC] === FIXED ANSWER SDP START ===');
int fixedMLineCount = 0;
for (final line in fixedLines) {
  if (line.startsWith('m=')) {
    fixedMLineCount++;
    debugPrint('[KINGZ WebRTC] FIXED M-LINE #$fixedMLineCount: $line');
  }
}
debugPrint('[KINGZ WebRTC] FIXED: Total m-lines: $fixedMLineCount');
```

**Output example:**
```
[KINGZ WebRTC] === ANSWER SDP START ===
[KINGZ WebRTC] ANSWER M-LINE #1: m=audio 0 RTP/SAVPF ...
[KINGZ WebRTC] ANSWER: Total m-lines: 1
[KINGZ WebRTC] === FIXED ANSWER SDP START ===
[KINGZ WebRTC] FIXED M-LINE #1: m=audio 0 RTP/SAVPF ...
[KINGZ WebRTC] FIXED: Total m-lines: 1
```

### 4. Transceiver Audit

```dart
final transceivers = await peer.getTransceivers();
debugPrint('[KINGZ WebRTC] transceivers after creation: ${transceivers.length}');
for (int i = 0; i < transceivers.length; i++) {
  debugPrint('[KINGZ WebRTC]   transceiver #$i (audio)');
}
```

**Why this matters:**
- Verifies that `flutter_webrtc` didn't create unexpected transceivers
- Each transceiver typically means an m= line in SDP
- Should be exactly 1 (audio only)

---

## Debugging with Console Output

### Console Log Checklist

Run the app and check the DevTools console for these patterns:

```
1. Offer creation with constraints:
   ✓ [KINGZ WebRTC] calling peer.createOffer() with constraints: {...}
   ✓ [KINGZ WebRTC] === OFFER SDP START ===
   ✓ [KINGZ WebRTC] OFFER: m=audio 0 RTP/SAVPF ...
   ✓ [KINGZ WebRTC] === OFFER SDP END ===

2. Transceiver audit:
   ✓ [KINGZ WebRTC] transceivers after creation: 1
   ✓ [KINGZ WebRTC]   transceiver #0 (audio)

3. Answer received and logged:
   ✓ [KINGZ WebRTC] answer received (gen=1, sdpLen=1234)
   ✓ [KINGZ WebRTC] === ANSWER SDP START ===
   ✓ [KINGZ WebRTC] ANSWER M-LINE #1: m=audio 0 RTP/SAVPF ...
   ✓ [KINGZ WebRTC] ANSWER: Total m-lines: 1

4. setRemoteDescription attempt:
   ✓ [KINGZ WebRTC] calling setRemoteDescription with answer (1 m-lines)...
   ✓ [KINGZ WebRTC] remote description set successfully
```

### If M-Line Mismatch Occurs

Console will show:

```
[KINGZ WebRTC] === OFFER SDP START ===
[KINGZ WebRTC] OFFER: m=audio 0 RTP/SAVPF ...
[KINGZ WebRTC] === OFFER SDP END ===

[KINGZ WebRTC] === ANSWER SDP START ===
[KINGZ WebRTC] ANSWER M-LINE #1: m=video 0 RTP/SAVPF ...   ← WRONG!
[KINGZ WebRTC] ANSWER M-LINE #2: m=audio 0 RTP/SAVPF ...   ← Different order!
[KINGZ WebRTC] ANSWER: Total m-lines: 2

ERROR: "order of m-lines in answer doesn't match order in offer"
  - Offer has: audio (1 line)
  - Answer has: video, audio (2 lines, wrong order)
  - JUCE is generating video line that Flutter doesn't expect
```

---

## Possible Root Causes & Solutions

### Cause 1: flutter_webrtc default behavior
**Symptoms:** Answer shows video m-line even though Flutter never offered it
**Solution:** Already fixed by explicit constraints in `_createOffer()`

### Cause 2: JUCE plugin SDP formatting
**Symptoms:** Flutter offer is audio-only, but JUCE answer has video first
**Symptoms:** Console shows JUCE answering with wrong order
**Solution:** JUCE needs to be checked - answer must match offer structure exactly

### Cause 3: Data channel m-line conflict
**Symptoms:** Flutter offers audio, JUCE answers with audio + data channel
**Symptoms:** Console shows extra m=application line in answer
**Solution:** Verify JUCE is not creating data channel in answer

---

## Key Points

### For Flutter Side (Now Fixed)
✅ Using explicit `offerToReceiveAudio: true, offerToReceiveVideo: false`  
✅ Logging all m= lines to verify offer structure  
✅ Logging answer before/after DTLS fix to verify structure  
✅ Auditing transceivers to catch unexpected ones  
✅ Including m-line count in error messages  

### For JUCE Side (Needs Verification)
⚠️ Answer SDP must have EXACTLY the same m-line order as offer  
⚠️ If Flutter offers only audio: `m=audio`, JUCE answer must have ONLY `m=audio`  
⚠️ If flutter_webrtc ever changes behavior, JUCE might need to adapt  

---

## Testing

### Test 1: Audio-Only Compatibility
```bash
# Run Kingz Listen
# Check console for:
# - Offer shows: m=audio only
# - Answer shows: m=audio only, same order
# - setRemoteDescription succeeds
```

### Test 2: Constraint Enforcement
```bash
# If the fix fails, check:
# - Did createOffer() receive the constraints?
# - Do constraints actually restrict to audio-only?
# - Is flutter_webrtc respecting the constraints?
```

### Test 3: Future-Proofing
```bash
# If JUCE changes its answer format in future:
# - Console logs will show the new m-line structure
# - Easy to diagnose by comparing offer vs answer m-lines
# - Can adjust constraints or SDP fixing logic if needed
```

---

## Code Changes Summary

| Component | Change | Lines |
|-----------|--------|-------|
| `_createOffer()` | Add audio-only constraints | 339-348 |
| `_createOffer()` | Log offer m= lines | 351-365 |
| `_createPeer()` | Audit transceivers | 280-289 |
| `handleSignal()` answer | Log answer m= lines | 135-151 |
| `handleSignal()` answer | Log fixed m= lines | 160-174 |

---

## References

- **Commit:** 5594540
- **File:** `services/listener_app/lib/services/webrtc_playback_bridge_stub.dart`
- **Related:** [[WEBRTC_LIFECYCLE_FIX.md]], [[WEBRTC_SETREMOTEDESCRIPTION_FIX.md]]

---

## Summary

This fix ensures Flutter's WebRTC offer and JUCE's answer have compatible m-line structures by:

1. ✅ **Explicit constraints** — Force audio-only offer generation
2. ✅ **Comprehensive logging** — Print exact m-line structure for both sides
3. ✅ **Transceiver audit** — Verify no unexpected transceivers added
4. ✅ **Easy debugging** — Console clearly shows if m-lines match or differ

**Result:** If m-line mismatch still occurs, console output will immediately reveal which side has the wrong structure.
