# Critical: Full SDP Console Dump for M-Line Diagnosis

**Commit:** a21a52a  
**Purpose:** Diagnose WebRTC m-line mismatch: "The order of m-lines in answer doesn't match order in offer"

---

## What You'll See in Console

When the app runs, open DevTools console (F12 → Console) and look for these patterns:

### 1. Flutter's Offer SDP

```
======== FLUTTER OFFER SDP (1234 bytes) ========
v=0
o=kingzlisten 1234567890 2 IN IP4 192.168.1.100
s=-
t=0 0
a=group:BUNDLE 0
a=msid-semantic: WMS stream
m=audio 0 RTP/SAVPF 111 63 103 104 9 0 8 106 105 13 110 112 113 114
a=rtpmap:111 opus/48000/2
a=rtpmap:63 red/48000
... [more audio codec lines] ...
a=setup:actpass
a=mid:0
a=msid:stream audio
======== END OFFER SDP ========
```

**Key to look for:**
- How many `m=` lines? (should be 1, just audio)
- Is there a `m=video`? (should NOT be there)
- Is there a `m=application`? (should NOT be there)

### 2. JUCE's Answer SDP (BEFORE Fix)

```
======== JUCE ANSWER SDP (BEFORE FIX) (1200 bytes) ========
v=0
o=kingzlisten 9876543210 2 IN IP4 192.168.1.50
s=-
t=0 0
a=group:BUNDLE 0
m=audio 0 RTP/SAVPF 111 63 103 104 9 0 8 106 105 13 110 112 113 114
a=rtpmap:111 opus/48000/2
... [answer audio codecs] ...
a=setup:actpass
a=mid:0
======== END JUCE ANSWER SDP ========
```

### 3. JUCE's Answer SDP (AFTER DTLS Fix)

```
======== JUCE ANSWER SDP (AFTER FIX) (1200 bytes) ========
v=0
o=kingzlisten 9876543210 2 IN IP4 192.168.1.50
s=-
t=0 0
a=group:BUNDLE 0
m=audio 0 RTP/SAVPF 111 63 103 104 9 0 8 106 105 13 110 112 113 114
a=rtpmap:111 opus/48000/2
... [answer audio codecs] ...
a=setup:passive       ← CHANGED from "actpass" to "passive"
a=mid:0
======== END FIXED ANSWER SDP ========
```

---

## How to Diagnose M-Line Mismatch

### Step 1: Count the `m=` lines

**Offer:**
```
m=audio 0 RTP/SAVPF ...
```
Count: **1 m-line**

**Answer:**
```
m=audio 0 RTP/SAVPF ...
```
Count: **1 m-line**

✓ **Match = Good**

### Step 2: Check the ORDER

**Offer order:** audio (first)  
**Answer order:** audio (first)

✓ **Same order = Good**

### Example of MISMATCH ❌

**Offer:**
```
m=audio 0 RTP/SAVPF ...
```
Count: **1**

**Answer:**
```
m=video 0 RTP/SAVPF ...
m=audio 0 RTP/SAVPF ...
```
Count: **2**, order: **video first, then audio**

❌ **ERROR: Different m-lines and different order!**
- Offer has 1 line (audio only)
- Answer has 2 lines (video + audio)
- Order doesn't match (offer: audio; answer: video first)

---

## What to Do When M-Line Mismatch Occurs

### If JUCE answer has unexpected m-lines:

**Observation:** Answer shows `m=video` but Offer doesn't have it

**Action:** JUCE plugin needs to be checked
- Why is JUCE generating video m-line in answer when Flutter didn't offer it?
- WebRTC requires answer to have SAME m-lines as offer

### If order is different:

**Observation:** Answer has `m=video 0` first, then `m=audio 0`, but Offer has audio first

**Action:** JUCE needs to reorder m-lines in answer to match offer

---

## Constraints: Audio-Only Configuration

Flutter is configured to create AUDIO-ONLY offers:

```dart
final constraints = <String, dynamic>{
  'offerToReceiveAudio': true,      // YES to audio
  'offerToReceiveVideo': false,      // NO to video
  'iceRestart': false,
};
```

This ensures Flutter's offer has **ONLY** one `m=audio` line.

**If Flutter offer shows video m-line despite these constraints:**
- `flutter_webrtc` library might be ignoring the constraints
- Update `flutter_webrtc` or report bug to package maintainers

---

## Summary

1. **Deploy app** with this fix
2. **Open DevTools console** (F12)
3. **Look for the three SDP dumps:**
   - `FLUTTER OFFER SDP`
   - `JUCE ANSWER SDP (BEFORE FIX)`
   - `JUCE ANSWER SDP (AFTER FIX)`
4. **Compare the `m=` lines manually**
5. **If they don't match, console clearly shows WHY**

The full SDP dumps make the mismatch immediately visible without any guessing.

---

## Reference

- **Commit:** a21a52a
- **File:** `services/listener_app/lib/services/webrtc_playback_bridge_stub.dart`
- **Related:** [[WEBRTC_SDP_MLINE_FIX.md]]
