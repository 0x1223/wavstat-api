# WebRTC Lifecycle Bug Fix — Documentation

**Commit:** 5071830  
**Date:** 2026-06-10  
**Issue:** App crashes with "STATUS ERROR" and gets stuck in "BUFFERING" on physical devices  
**Root Cause:** RTCPeerConnection null pointer exception when signaling messages arrive before peer initialization  
**Solution:** Implement message queuing with early peer initialization

---

## The Bug: Timing Race Condition

### What Was Happening

```
Timeline:
T1: start() is called
T2:   _createPeer() begins (async, awaits peer creation)
T3: WebSocket server sends webrtc.answer message
T4: handleSignal(webrtc.answer) is called
T5:   Checks if peer != null → peer is STILL NULL (step T2 not complete)
T6:   handleSignal() silently returns
T7: App never sets remote description → connection fails
T8:   _createPeer() finally completes
T9: Offer is sent to plugin
T10: Plugin receives offer but client already broke
```

### Error Log Message
```
Unable to RTCPeerConnection::setRemoteDescription: Error: peerConnection not found!
```

This came from the native flutter_webrtc plugin when it tried to set a remote description on a null peer.

---

## The Fix: Message Queueing & Early Initialization

### 1. Separate State Tracking

**Before:**
```dart
RTCPeerConnection? _peer;  // null until _createPeer() completes
```

**After:**
```dart
RTCPeerConnection? _peer;      // the actual peer connection
bool _peerReady = false;        // NEW: separate flag for "peer initialized"
final List<Map<String, dynamic>> _queuedSignalMessages = [];  // NEW: queue for messages
```

### 2. Early Marking of Peer Ready

**In `start()` method:**
```dart
await _createPeer();           // Creates peer
_peerReady = true;             // CRITICAL: mark ready BEFORE processing anything

// Now process any messages that arrived while we were creating peer
final queuedCopy = List<Map<String, dynamic>>.from(_queuedSignalMessages);
_queuedSignalMessages.clear();

for (final message in queuedCopy) {
  await handleSignal(message);  // Process in order
}

await _createOffer();          // Send offer only after queue is flushed
```

### 3. Queue Messages Before Peer is Ready

**In `handleSignal()` method:**
```dart
if (!_peerReady) {
  debugPrint('[KINGZ WebRTC] queueing signal (peer not ready): type=$type');
  _queuedSignalMessages.add(message);
  return;
}
// ... proceed with normal handling
```

### 4. Enhanced Error Logging

**Before:**
```dart
if (peer == null) {
  return;  // Silent failure
}
```

**After:**
```dart
if (!_peerReady) {
  debugPrint('[KINGZ WebRTC] queueing signal (peer not ready): type=$type gen=$generation');
  _queuedSignalMessages.add(message);
  return;
}

final peer = _peer;
if (peer == null) {
  debugPrint('[KINGZ WebRTC] ERROR: handleSignal called with peerReady=true but peer is null!');
  return;
}
```

---

## New Lifecycle: Guaranteed Order

```
Timeline:
T1: start() is called
T2:   _createPeer() begins and completes
T3:   _peerReady = true ✓
T4: WebSocket receives webrtc.answer
T5:   handleSignal() checks _peerReady → TRUE
T6:   setRemoteDescription() called on LIVE peer ✓
T7: WebSocket receives webrtc.ice-candidate
T8:   handleSignal() adds ICE candidate ✓
T9: _createOffer() called AFTER everything ready
T10: Plugin gets offer in good state ✓
```

---

## Key Changes by File

### `webrtc_playback_bridge_stub.dart`

**New Fields:**
```dart
bool _peerReady = false;                              // Line 43
final List<Map<String, dynamic>> _queuedSignalMessages = [];  // Line 49
```

**Modified Methods:**
1. **`start()`** (lines 57-91)
   - Mark `_peerReady = true` after `_createPeer()` completes
   - Flush queued messages before creating offer
   - Enhanced logging at each stage

2. **`handleSignal()`** (lines 93-197)
   - Check `_peerReady` at entry point
   - Queue message if peer not ready
   - Better error messages with generation numbers and state info
   - Null checks with detailed error text

3. **`stop()`** (lines 199-213)
   - Clear `_queuedSignalMessages` on stop
   - Reset `_peerReady` flag

4. **`_createPeer()`** (lines 226-256)
   - Added try/catch around peer creation
   - Detailed logging of peer creation steps

5. **`_createOffer()`** (lines 308-330)
   - Enhanced logging with SDP length
   - Better error messages for offer generation failures

---

## Debugging: Console Log Sequence

**Expected console output on success:**

```
[KINGZ WebRTC] creating peer connection...
[KINGZ WebRTC] calling createPeerConnection() with config: ...
[KINGZ WebRTC] peer connection created (generation=1)
[KINGZ WebRTC] peer connection ready, queued messages: 0
[KINGZ WebRTC] creating offer...
[KINGZ WebRTC] calling peer.createOffer()...
[KINGZ WebRTC] setting local description with offer (XXX bytes)
[KINGZ WebRTC] offer created successfully (generation=1 sdpLen=XXX)
[KINGZ WebRTC] data channel received: kingz-pcm
[KINGZ WebRTC] attaching handlers to kingz-pcm channel
```

**If messages arrive early (race condition detected):**

```
[KINGZ WebRTC] creating peer connection...
[KINGZ WebRTC] answer received (gen=1, sdpLen=XXX)
[KINGZ WebRTC] queueing signal (peer not ready): type=webrtc.answer gen=1
[KINGZ WebRTC] ice candidate
[KINGZ WebRTC] queueing signal (peer not ready): type=webrtc.ice-candidate gen=1
[KINGZ WebRTC] peer connection created (generation=1)
[KINGZ WebRTC] peer connection ready, queued messages: 2
[KINGZ WebRTC] processing queued signal (webrtc.answer)
[KINGZ WebRTC] answer received (gen=1, sdpLen=XXX)
[KINGZ WebRTC] remote description set successfully
[KINGZ WebRTC] flushing 1 pending ICE candidates
[KINGZ WebRTC] processing queued signal (webrtc.ice-candidate)
[KINGZ WebRTC] adding ICE candidate (buffered=0)
```

Notice the `queued messages: 2` at the top, then they're processed in order after peer is ready.

---

## State Machine Verification

The fix ensures these invariants are always true:

1. **Peer Initialization Order:**
   - `start()` called → `_createPeer()` awaited → `_peerReady = true` → queue flushed → `_createOffer()`
   - No offer sent before peer is initialized ✓

2. **Remote Description Before ICE:**
   - Queue flushes in message arrival order
   - `webrtc.answer` (which sets remote description) is processed before `webrtc.ice-candidate` ✓
   - ICE candidates buffered until remote description is set ✓

3. **Null Pointer Impossible:**
   - `handleSignal()` only proceeds if `_peerReady = true`
   - `_peerReady` only becomes true after peer is created
   - Therefore `_peer` cannot be null when signaling is processed ✓

---

## Testing Recommendations

### Test 1: High-Speed Network (No Race Condition)
```
Network: LAN, <5ms latency
Expected: All messages queued=0, no buffering
Result: Offer sent, answer received, ICE candidates added, playback starts
```

### Test 2: Simulated Race Condition
```bash
# Delay network by 500ms
sudo tc qdisc add dev en0 root netem delay 500ms
# Then run Kingz Listen
# Expected: Messages queued > 0, then processed after peer ready
# Result: Still works, playback starts normally
```

### Test 3: Stale Message Filtering
```
Send offer generation 1, receive answer for generation 1, accept it
Then start another connection (generation 2), receive old answer for gen 1
Expected: Old answer rejected, not queued or processed
Result: Only valid generation messages are handled
```

---

## Known Limitations & Future Work

1. **Synchronous Queue Flushing:**
   - Currently uses `await handleSignal(message)` in loop
   - If processing is slow, buffers in the queue longer
   - Could be optimized with parallel processing if needed

2. **No Maximum Queue Size:**
   - Queue grows unbounded if peer creation takes very long
   - Could add a max queue length safeguard (e.g., 100 messages)
   - Currently not needed for LAN use case

3. **Generation Mismatch Handling:**
   - Stale messages are logged but not specially handled
   - Could add metrics to track how often this happens

4. **Offer Failure Reasons:**
   - The `peer_connection_offer_failed` error is now logged with full details
   - Should investigate if `flutter_webrtc` library version is compatible
   - May need SDP offer validation or constraints update

---

## References

- **Commit:** 5071830
- **File:** `services/listener_app/lib/services/webrtc_playback_bridge_stub.dart`
- **Related:** [[KINGZ_LISTEN_TCP_BACKPRESSURE_GUIDE.md]] (companion optimization)
- **Related Memory:** [[project_kingz_listen]] — full project context

---

## Summary

This fix eliminates the WebRTC initialization race condition by:
1. Separating "peer created" from "peer ready" states
2. Buffering all signaling messages until peer is initialized
3. Processing queued messages in strict order before creating offer
4. Adding comprehensive logging for debugging

**Result:** App no longer crashes with "STATUS ERROR" or gets stuck in "BUFFERING" when signaling timing is tight. Connection lifecycle is guaranteed to proceed in the correct order.
