import AVFoundation
import Flutter
import UIKit

// MARK: - KingzPcmPlayer
// Receives raw Int16 stereo-interleaved PCM into a 48 kHz pull-rendered ring buffer.
private final class KingzPcmPlayer {
  private static let channelCount = 2

  private var engine: AVAudioEngine?
  private var sourceNode: AVAudioSourceNode?
  private var sampleRate: Double = 48_000  // live STREAM (source/DAW) rate
  private var outputSampleRate: Double = 48_000  // engine OUTPUT (hardware) rate; ring is resampled to this
  private let bufferLock = NSLock()
  private var ringBuffer: [Int16] = []
  private var ringCapacityFrames = 0
  private var readFrame = 0
  private var readFraction: Double = 0  // fractional resampler read cursor (streamRate -> outputRate)
  private var writeFrame = 0
  private var enqueueLogCount = 0
  private var lastAutoStartAttempt = Date.distantPast
  private var queuedFrames: Int = 0
  private var playbackStarted = false
  private var underrunCount = 0
  private var liveEdgeResetCount = 0
  private var monitoringMode = "balanced"
  private var lastDiagnosticsLog = Date()
  private var receivedFramesSinceLog = 0
  private var renderedFramesSinceLog = 0
  private var consumedFramesSinceLog = 0  // stream frames consumed by the resampler
  private var packetsSinceLog = 0
  private var lastPacketBytes = 0

  // Retained from the Dart config for the config log only; queue DEPTH is now adaptive.
  private var targetBufferMs = 80
  private var safeBufferMs = 140
  private var adaptiveQueue = true

  // MARK: req 1 — adaptive target depth
  // EMA of packet inter-arrival time + its variance form a network-jitter estimate;
  // targetQueueMs = base + k*jitterStdev (clamped) so the buffer grows on bursty
  // links and shrinks on clean ones.
  private static let jitterBaseMs: Double = 60
  private static let jitterK: Double = 2.5
  private static let jitterMinMs: Double = 40
  private static let jitterMaxMs: Double = 300
  private static let iatAlpha: Double = 0.02
  private var iatEmaMs: Double = 0
  private var iatVarEmaMs2: Double = 0
  private var jitterStdevMs: Double = 0
  private var lastPacketArrival: Date?
  private var adaptiveTargetMs: Double = 60
  private var targetQueueFrames: Int = 0  // adaptive target in stream frames (bufferLock)

  // MARK: req 2 — drift correction via resample ratio
  // A slow control loop nudges the effective resample ratio by at most ±0.5% to pull
  // the queue toward target, absorbing clock drift + steady-state offset by
  // imperceptibly time-stretching instead of dropping/inserting samples. No trimming.
  private static let maxRatioOffset: Double = 0.005   // ±0.5%
  private static let driftFullScaleMs: Double = 40    // error at which the nudge saturates
  private static let driftDeadbandMs: Double = 4      // ignore tiny errors
  private static let driftTauSeconds: Double = 3.0    // LPF time constant (slow)
  private var ratioOffset: Double = 0

  // MARK: req 3 — crossfade / concealment
  // Equal-power ramps hide the only two events allowed to change sample count:
  // overflow drops and underruns. Never a hard cut or raw-silence step.
  private static let rampSeconds: Double = 0.003      // 3ms
  private var rampFrames: Int = 1
  private var fadeInTable: [Float] = [1]              // equal-power, length rampFrames
  private var fadeOutTable: [Float] = [0]
  private var seamFadePos: Int = -1                   // -1 idle; else index into fade tables
  private var seamAnchorL: Float = 0
  private var seamAnchorR: Float = 0
  private var lastOutL: Float = 0
  private var lastOutR: Float = 0
  private var concealing = false
  private var concealPos = 0
  private var concealAnchorL: Float = 0
  private var concealAnchorR: Float = 0
  private var crossfadedUnderruns = 0
  private var crossfadedOverflows = 0
  private var diagFileLines: [String] = []  // recent diag lines mirrored to /tmp fallback

  private var format: AVAudioFormat {
    AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: outputSampleRate,
      channels: 2,
      interleaved: false
    )!
  }

  // MARK: req 4 — ring sized to comfortably hold 2× the max target plus headroom,
  // so normal bursts never reach the ceiling.
  private var ringCapacityTargetFrames: Int {
    max(framesForMs(Self.jitterMaxMs * 2 + 500), Int(sampleRate * 1.5))
  }

  // Hard latency ceiling — a rare safety valve sitting above the max adaptive target.
  private var overflowCeilingFrames: Int {
    framesForMs(Self.jitterMaxMs + 150)
  }

  func configure(sampleRate newSampleRate: Double) {
    let normalizedSampleRate = supportedSampleRate(newSampleRate)
    guard abs(normalizedSampleRate - sampleRate) >= 1 else { return }
    let ratio = outputSampleRate > 0 ? normalizedSampleRate / outputSampleRate : 1.0
    print("[KINGZ IOS PCM] stream rate \(sampleRate) -> \(normalizedSampleRate) (outputSampleRate=\(outputSampleRate) resampleRatio=\(String(format: "%.4f", ratio)))")
    // Rate-agnostic: do NOT restart the engine or repin the hardware. The engine keeps
    // running at outputSampleRate; render() resamples the stream-rate ring to it. We only
    // resize/flush the ring so the queue math (sized in stream frames) stays consistent.
    bufferLock.lock()
    sampleRate = normalizedSampleRate
    ringCapacityFrames = ringCapacityTargetFrames
    ringBuffer = Array(repeating: 0, count: ringCapacityFrames * Self.channelCount)
    resetRingLocked()
    targetQueueFrames = framesForMs(adaptiveTargetMs)  // ms→frames mapping changed with the rate
    bufferLock.unlock()
  }

  func configureQueue(
    targetBufferMs newTargetBufferMs: Int?,
    safeBufferMs newSafeBufferMs: Int?,
    adaptive newAdaptive: Bool?,
    mode newMode: String?
  ) {
    if let newTargetBufferMs {
      targetBufferMs = clamp(newTargetBufferMs, min: 35, max: 300)
    }
    if let newSafeBufferMs {
      safeBufferMs = clamp(newSafeBufferMs, min: targetBufferMs + 20, max: 600)
    }
    if let newAdaptive {
      adaptiveQueue = newAdaptive
    }
    if let newMode, !newMode.isEmpty {
      monitoringMode = newMode
    }
    safeBufferMs = clamp(safeBufferMs, min: targetBufferMs + 20, max: 600)
    // Depth is adaptive now (req 1); these values are accepted for compatibility but no
    // longer set the queue depth. base/k/min/max drive the target instead.
    print("[KINGZ IOS PCM] queue config mode=\(monitoringMode) adaptive=ALWAYS base=\(Int(Self.jitterBaseMs)) k=\(Self.jitterK) min=\(Int(Self.jitterMinMs)) max=\(Int(Self.jitterMaxMs)) overflowCeiling=\(overflowCeilingFrames) ring=\(ringCapacityTargetFrames) (dartTargetMs=\(targetBufferMs) safeMs=\(safeBufferMs) ignored)")
  }

  func start() throws {
    guard engine?.isRunning != true else { return }
    let eng = AVAudioEngine()
    let session = AVAudioSession.sharedInstance()
    try configureSession(session)
    try session.setActive(true)
    // Output runs at the granted hardware rate; the stream is resampled to it.
    outputSampleRate = session.sampleRate > 0 ? session.sampleRate : 48_000
    buildRampTables()  // equal-power crossfade ramps live in OUTPUT-frame space

    prepareRingBuffer()
    let source = AVAudioSourceNode { [weak self] _, _, frameCount, audioBufferList -> OSStatus in
      self?.render(frameCount: Int(frameCount), audioBufferList: audioBufferList)
      return noErr
    }
    eng.attach(source)
    eng.connect(source, to: eng.mainMixerNode, format: format)
    eng.connect(eng.mainMixerNode, to: eng.outputNode, format: nil)
    try eng.start()
    engine = eng
    sourceNode = source
    enqueueLogCount = 0
    bufferLock.lock()  // engine is live now; reset under the lock to avoid racing render()
    resetRingLocked()
    bufferLock.unlock()
    let outputs = session.currentRoute.outputs.map { "\($0.portType.rawValue):\($0.portName)" }.joined(separator: ",")
    print("[KINGZ IOS PCM] start ok streamSampleRate=\(sampleRate) hardwareSampleRate=\(session.sampleRate) asbd=[\(debugASBD(format))] engineRunning=\(eng.isRunning) route=[\(outputs)]")
  }

  private func configureSession(_ session: AVAudioSession) throws {
    do {
      try session.setCategory(.playback, mode: .default, options: [])
    } catch {
      print("[KINGZ IOS PCM] session playback category failed: \(error.localizedDescription)")
      try session.setCategory(.ambient, mode: .default, options: [])
      print("[KINGZ IOS PCM] session fallback category=ambient")
    }
    try? session.setPreferredSampleRate(sampleRate)
    try? session.setPreferredIOBufferDuration(0.005)
  }

  func stop() {
    if engine != nil || sourceNode != nil {
      print("[KINGZ IOS PCM] stop")
    }
    engine?.stop()
    if let source = sourceNode {
      engine?.detach(source)
    }
    engine = nil
    sourceNode = nil
    bufferLock.lock()
    resetRingLocked()
    bufferLock.unlock()
    try? AVAudioSession.sharedInstance().setActive(
      false, options: .notifyOthersOnDeactivation
    )
  }

  func flushToLiveEdge(reason: String) {
    liveEdgeResetCount += 1
    bufferLock.lock()
    resetRingLocked()
    bufferLock.unlock()
    print("[KINGZ IOS PCM] live-edge flush #\(liveEdgeResetCount) reason=\(reason)")
  }

  func enqueue(_ data: Data) {
    if engine?.isRunning != true {
      let now = Date()
      if now.timeIntervalSince(lastAutoStartAttempt) < 0.5 {
        return
      }
      lastAutoStartAttempt = now
      do {
        print("[KINGZ IOS PCM] enqueue auto-start bytes=\(data.count)")
        try start()
      } catch {
        if enqueueLogCount < 5 {
          enqueueLogCount += 1
          print("[KINGZ IOS PCM] enqueue ignored: auto-start failed bytes=\(data.count) error=\(error.localizedDescription)")
        }
        return
      }
    }

    let incomingFrameCount = data.count / 4  // 2 channels × 2 bytes/sample
    guard incomingFrameCount > 0 else { return }

    // req 1: update the network-jitter estimate from packet inter-arrival times and
    // recompute the adaptive target depth. Gaps (stream (re)start) are excluded so a
    // single long pause doesn't blow up the variance.
    let arrival = Date()
    if let last = lastPacketArrival {
      let dtMs = arrival.timeIntervalSince(last) * 1000.0
      if dtMs > 0, dtMs < 500 {
        if iatEmaMs == 0 { iatEmaMs = dtMs }
        let prevMean = iatEmaMs
        iatEmaMs = (1 - Self.iatAlpha) * iatEmaMs + Self.iatAlpha * dtMs
        let dev = dtMs - prevMean
        iatVarEmaMs2 = (1 - Self.iatAlpha) * iatVarEmaMs2 + Self.iatAlpha * (dev * dev)
        jitterStdevMs = iatVarEmaMs2.squareRoot()
      }
    }
    lastPacketArrival = arrival
    let tMs = min(max(Self.jitterBaseMs + Self.jitterK * jitterStdevMs, Self.jitterMinMs), Self.jitterMaxMs)
    adaptiveTargetMs = tMs

    let frameCount = min(incomingFrameCount, ringCapacityFrames > 0 ? ringCapacityFrames - 1 : incomingFrameCount)
    let sourceStartFrame = max(0, incomingFrameCount - frameCount)

    bufferLock.lock()
    targetQueueFrames = framesForMs(tMs)

    // req 4: overflow is now a RARE safety valve. With the ring sized to ~2× the max
    // target, normal bursts never reach the ceiling; only a pathological backlog above
    // the latency ceiling forces a drop, and that seam is crossfaded (req 3) — no
    // recovery-trim, ever. Steady-state offset is corrected by the drift loop (req 2).
    if queuedFrames + frameCount > overflowCeilingFrames {
      let queuedBeforeDrop = queuedFrames
      let dropCount = max(0, queuedFrames - targetQueueFrames)
      if dropCount > 0 {
        trimOldestFramesLocked(dropCount)
        startSeamFadeLocked()      // crossfade pre-drop tail → post-drop samples
        crossfadedOverflows += 1
        print("[KINGZ IOS PCM] overflow xfade #\(crossfadedOverflows) queued=\(queuedBeforeDrop) -> \(queuedFrames) ceiling=\(overflowCeilingFrames) target=\(targetQueueFrames)")
      }
    }

    data.withUnsafeBytes { raw in
      let p = raw.bindMemory(to: Int16.self)
      for i in 0..<frameCount {
        let sourceIndex = (sourceStartFrame + i) * 2
        let ringIndex = writeFrame * Self.channelCount
        ringBuffer[ringIndex] = p[sourceIndex]
        ringBuffer[ringIndex + 1] = p[sourceIndex + 1]
        writeFrame = (writeFrame + 1) % ringCapacityFrames
      }
    }
    queuedFrames += frameCount
    receivedFramesSinceLog += frameCount
    packetsSinceLog += 1
    lastPacketBytes = data.count
    let queuedSnapshot = queuedFrames
    let isPlaybackStarted = playbackStarted
    bufferLock.unlock()
    logDiagnosticsIfDue()

    if enqueueLogCount < 10 {
      enqueueLogCount += 1
      print("[KINGZ IOS PCM] enqueue #\(enqueueLogCount) bytes=\(data.count) frames=\(frameCount) queued=\(queuedSnapshot) target=\(targetQueueFrames) ceiling=\(overflowCeilingFrames) engineRunning=\(engine?.isRunning == true) renderStarted=\(isPlaybackStarted)")
    }
  }

  private func prepareRingBuffer() {
    bufferLock.lock()
    ringCapacityFrames = ringCapacityTargetFrames
    ringBuffer = Array(repeating: 0, count: ringCapacityFrames * Self.channelCount)
    resetRingLocked()
    targetQueueFrames = framesForMs(adaptiveTargetMs)
    bufferLock.unlock()
  }

  private func resetRingLocked() {
    readFrame = 0
    readFraction = 0
    writeFrame = 0
    queuedFrames = 0
    playbackStarted = false
    // Reset playback/concealment/drift state; keep the jitter estimate (it describes
    // the link, not this buffer instance).
    ratioOffset = 0
    seamFadePos = -1
    concealing = false
    concealPos = 0
    lastOutL = 0
    lastOutR = 0
  }

  // Precompute equal-power crossfade ramps in OUTPUT-frame space (req 3).
  private func buildRampTables() {
    let n = max(1, Int((outputSampleRate * Self.rampSeconds).rounded()))
    var fin = [Float](repeating: 0, count: n)
    var fout = [Float](repeating: 0, count: n)
    for i in 0..<n {
      let t = Double(i + 1) / Double(n)  // (0, 1]
      fin[i] = Float(sin(t * .pi / 2.0))   // fade-in,  sin
      fout[i] = Float(cos(t * .pi / 2.0))  // fade-out, cos  (fin² + fout² = 1)
    }
    bufferLock.lock()
    rampFrames = n
    fadeInTable = fin
    fadeOutTable = fout
    bufferLock.unlock()
  }

  // Begin an equal-power fade-IN from the current output level into the upcoming
  // samples — used on resume-from-underrun and on an overflow drop seam (req 3).
  private func startSeamFadeLocked() {
    seamAnchorL = lastOutL
    seamAnchorR = lastOutR
    seamFadePos = 0
  }

  // Underrun/pre-roll concealment: decay the last good sample to zero over one ramp,
  // then hold silence — never a raw-silence step (req 3). Returns the concealed frame.
  private func concealmentSampleLocked() -> (Float, Float) {
    if concealPos < rampFrames {
      let g = fadeOutTable[concealPos]
      concealPos += 1
      let oL = concealAnchorL * g
      let oR = concealAnchorR * g
      lastOutL = oL
      lastOutR = oR
      return (oL, oR)
    }
    lastOutL = 0
    lastOutR = 0
    return (0, 0)
  }

  private func trimOldestFramesLocked(_ frameCount: Int) {
    guard frameCount > 0, ringCapacityFrames > 0, queuedFrames > 0 else {
      return
    }
    let framesToDrop = zeroCrossingAlignedDropCount(
      requestedDropFrames: min(frameCount, queuedFrames)
    )
    readFrame = (readFrame + framesToDrop) % ringCapacityFrames
    queuedFrames -= framesToDrop
    if queuedFrames == 0 {
      readFrame = writeFrame
      playbackStarted = false
    }
  }

  private func zeroCrossingAlignedDropCount(requestedDropFrames: Int) -> Int {
    guard requestedDropFrames > 0,
      queuedFrames > requestedDropFrames,
      ringCapacityFrames > 0
    else {
      return requestedDropFrames
    }

    let maxLookAhead = min(512, queuedFrames - requestedDropFrames - 1)
    guard maxLookAhead > 0 else {
      return requestedDropFrames
    }

    var bestOffset = 0
    var bestScore = Int.max
    for offset in 0...maxLookAhead {
      let candidateFrame = (readFrame + requestedDropFrames + offset) % ringCapacityFrames
      let ringIndex = candidateFrame * Self.channelCount
      let score = Int(abs(Int(ringBuffer[ringIndex])))
        + Int(abs(Int(ringBuffer[ringIndex + 1])))
      if score < bestScore {
        bestScore = score
        bestOffset = offset
        if score == 0 {
          break
        }
      }
    }
    return requestedDropFrames + bestOffset
  }

  private func render(
    frameCount: Int,
    audioBufferList: UnsafeMutablePointer<AudioBufferList>
  ) {
    let buffers = UnsafeMutableAudioBufferListPointer(audioBufferList)
    guard buffers.count > 0,
      let left = buffers[0].mData?.bindMemory(to: Float.self, capacity: frameCount)
    else { return }
    let right = buffers.count > 1
      ? buffers[1].mData?.bindMemory(to: Float.self, capacity: frameCount)
      : left
    guard let right = right else { return }

    bufferLock.lock()
    // Base ratio converts stream-rate → output-rate; sampleRate/outputSampleRate only
    // change at configure time. The drift loop (req 2) adds a tiny ±0.5% nudge on top.
    let baseRatio = outputSampleRate > 0 ? sampleRate / outputSampleRate : 1.0

    // req 2: slow control loop, once per render block. Pull the queue toward the adaptive
    // target by gently speeding up (queue too deep) or slowing down (queue too shallow)
    // the effective resample ratio — capped at ±maxRatioOffset, low-passed over ~tau s so
    // the ratio nudges over seconds and never jumps per block.
    if playbackStarted, targetQueueFrames > 0 {
      let errMs = Double(queuedFrames - targetQueueFrames) * 1000.0 / sampleRate
      var desired = 0.0
      if abs(errMs) > Self.driftDeadbandMs {
        desired = (errMs / Self.driftFullScaleMs) * Self.maxRatioOffset
        desired = min(max(desired, -Self.maxRatioOffset), Self.maxRatioOffset)
      }
      let blockDt = Double(frameCount) / outputSampleRate
      let aLP = min(1.0, blockDt / Self.driftTauSeconds)
      ratioOffset += (desired - ratioOffset) * aLP
    } else {
      ratioOffset += (0 - ratioOffset) * 0.1  // ease back to neutral while not playing
    }
    let effectiveRatio = baseRatio * (1.0 + ratioOffset)

    for frame in 0..<frameCount {
      // Pre-roll / resume gate. Start (or resume) once the queue reaches the adaptive
      // target; until then, conceal rather than emit raw silence.
      if !playbackStarted {
        if queuedFrames >= max(1, targetQueueFrames), ringCapacityFrames > 0 {
          playbackStarted = true
          concealing = false
          startSeamFadeLocked()  // equal-power fade-in from the (decayed) concealment level
        } else {
          if !concealing {
            concealing = true
            concealPos = 0
            concealAnchorL = lastOutL
            concealAnchorR = lastOutR
          }
          let s = concealmentSampleLocked()
          left[frame] = s.0
          right[frame] = s.1
          continue
        }
      }

      // Underrun: the only other event allowed to change sample count. Conceal (decay →
      // hold), count it, and drop back to pre-roll so we resume at target with a fade-in.
      guard queuedFrames > 0, ringCapacityFrames > 0 else {
        playbackStarted = false
        underrunCount += 1
        crossfadedUnderruns += 1
        concealing = true
        concealPos = 0
        concealAnchorL = lastOutL
        concealAnchorR = lastOutR
        let s = concealmentSampleLocked()
        left[frame] = s.0
        right[frame] = s.1
        continue
      }

      // Linear interpolation: readFrame is the base stream frame; readFraction is the
      // fractional offset into the next stream frame (0.0 = exactly readFrame).
      let ri0 = readFrame * Self.channelCount
      let ri1 = ((readFrame + 1) % ringCapacityFrames) * Self.channelCount
      let frac = Float(readFraction)
      let l0 = Float(ringBuffer[ri0]) / 32_768.0
      let r0 = Float(ringBuffer[ri0 + 1]) / 32_768.0
      let l1 = queuedFrames > 1 ? Float(ringBuffer[ri1]) / 32_768.0 : l0
      let r1 = queuedFrames > 1 ? Float(ringBuffer[ri1 + 1]) / 32_768.0 : r0
      var outL = l0 * (1 - frac) + l1 * frac
      var outR = r0 * (1 - frac) + r1 * frac

      // Equal-power crossfade over a seam (resume or overflow drop): blend the held
      // pre-seam level into the incoming samples. fin² + fout² = 1, so no power dip.
      if seamFadePos >= 0, seamFadePos < rampFrames {
        let fi = fadeInTable[seamFadePos]
        let fo = fadeOutTable[seamFadePos]
        outL = seamAnchorL * fo + outL * fi
        outR = seamAnchorR * fo + outR * fi
        seamFadePos += 1
        if seamFadePos >= rampFrames { seamFadePos = -1 }
      }

      left[frame] = outL
      right[frame] = outR
      lastOutL = outL
      lastOutR = outR

      // Advance the fractional cursor by the drift-corrected ratio per output frame.
      readFraction += effectiveRatio
      let consumed = Int(readFraction)
      readFraction -= Double(consumed)
      readFrame = (readFrame + consumed) % ringCapacityFrames
      queuedFrames -= min(consumed, queuedFrames)
      consumedFramesSinceLog += consumed
    }
    renderedFramesSinceLog += frameCount
    bufferLock.unlock()
  }

  private func logDiagnosticsIfDue() {
    let now = Date()
    let elapsed = now.timeIntervalSince(lastDiagnosticsLog)
    guard elapsed >= 1.0 else { return }

    bufferLock.lock()
    let queuedSnapshot = queuedFrames
    let receivedSnapshot = receivedFramesSinceLog
    let renderedSnapshot = renderedFramesSinceLog
    let consumedSnapshot = consumedFramesSinceLog
    let packetsSnapshot = packetsSinceLog
    let packetBytesSnapshot = lastPacketBytes
    let targetSnapshot = targetQueueFrames
    let adaptiveTargetMsSnapshot = adaptiveTargetMs
    let jitterSnapshot = jitterStdevMs
    let ratioOffsetSnapshot = ratioOffset
    let crossUnderSnapshot = crossfadedUnderruns
    let crossOverSnapshot = crossfadedOverflows
    receivedFramesSinceLog = 0
    renderedFramesSinceLog = 0
    consumedFramesSinceLog = 0
    packetsSinceLog = 0
    lastDiagnosticsLog = now
    bufferLock.unlock()

    let queuedMs = Double(queuedSnapshot) * 1000.0 / sampleRate
    let targetMsActual = Double(targetSnapshot) * 1000.0 / sampleRate
    let receiveFps = Double(receivedSnapshot) / elapsed
    let renderFps = Double(renderedSnapshot) / elapsed
    let consumeFps = Double(consumedSnapshot) / elapsed
    let resampleRatio = outputSampleRate > 0 ? sampleRate / outputSampleRate : 1.0
    let ratioOffsetPpm = Int((ratioOffsetSnapshot * 1_000_000).rounded())
    let packetFrames = packetBytesSnapshot / (Self.channelCount * MemoryLayout<Int16>.size)
    let line = "[KINGZ IOS PCM] diag mode=\(monitoringMode) streamSampleRate=\(sampleRate) outputSampleRate=\(outputSampleRate) resampleRatio=\(String(format: "%.4f", resampleRatio)) adaptiveTargetMs=\(Int(adaptiveTargetMsSnapshot.rounded())) targetQueueMs=\(Int(targetMsActual.rounded())) jitterStdevMs=\(String(format: "%.1f", jitterSnapshot)) currentRatioOffsetPpm=\(ratioOffsetPpm) queuedFrames=\(queuedSnapshot) queuedMs=\(Int(queuedMs.rounded())) receivedFps=\(Int(receiveFps.rounded())) consumedFps=\(Int(consumeFps.rounded())) renderedFps=\(Int(renderFps.rounded())) packets=\(packetsSnapshot) lastPacketBytes=\(packetBytesSnapshot) lastPacketFrames=\(packetFrames) underruns=\(underrunCount) crossfadedUnderruns=\(crossUnderSnapshot) crossfadedOverflows=\(crossOverSnapshot) recoveryTrims=0"
    print(line)
    writeDiagLine(line)
  }

  // Mirror recent diag lines to /tmp/kingz_diag.log as a fallback for when the mDNS
  // port-5353 error blocks the live VM stdout read. Keeps the last N lines in memory and
  // rewrites atomically (a throwing Swift API — no iOS 13.4-only FileHandle calls, no
  // uncatchable NSException). Best-effort: silently no-ops where the sandbox forbids /tmp
  // (real device), where print() over the VM remains primary.
  private func writeDiagLine(_ line: String) {
    diagFileLines.append(line)
    let cap = 300
    if diagFileLines.count > cap {
      diagFileLines.removeFirst(diagFileLines.count - cap)
    }
    let blob = diagFileLines.joined(separator: "\n") + "\n"
    try? blob.write(toFile: "/tmp/kingz_diag.log", atomically: true, encoding: .utf8)
  }

  private func debugASBD(_ format: AVAudioFormat) -> String {
    let asbd = format.streamDescription.pointee
    return "sampleRate=\(asbd.mSampleRate) channels=\(asbd.mChannelsPerFrame) bits=\(asbd.mBitsPerChannel) bytesPerFrame=\(asbd.mBytesPerFrame) formatFlags=\(asbd.mFormatFlags)"
  }

  private func supportedSampleRate(_ requested: Double) -> Double {
    guard requested.isFinite, requested >= 8_000, requested <= 192_000 else {
      return 48_000
    }
    return requested.rounded()
  }

  private func framesForMs(_ ms: Double) -> Int {
    max(1, Int((sampleRate * ms / 1000.0).rounded()))
  }

  private func clamp(_ value: Int, min minValue: Int, max maxValue: Int) -> Int {
    Swift.max(minValue, Swift.min(maxValue, value))
  }
}

// MARK: - AppDelegate

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  private static let linkChannelName = "com.kingzbreadent.kingzlisten/link"
  private static let pcmControlName = "com.kingzbreadent.kingzlisten/pcm"
  private static let pcmAudioName = "com.kingzbreadent.kingzlisten/pcm_audio"
  private static var linkChannel: FlutterMethodChannel?
  private static var pendingURL: String?
  private let pcmPlayer = KingzPcmPlayer()

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    if let url = launchOptions?[.url] as? URL {
      Self.pendingURL = url.absoluteString
    }
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(
    _ engineBridge: FlutterImplicitEngineBridge
  ) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    let messenger = engineBridge.applicationRegistrar.messenger()

    // Deep-link channel (existing)
    let linkCh = FlutterMethodChannel(
      name: Self.linkChannelName, binaryMessenger: messenger
    )
    Self.linkChannel = linkCh
    linkCh.setMethodCallHandler { call, result in
      if call.method == "initialUrl" {
        result(Self.pendingURL)
        Self.pendingURL = nil
      } else {
        result(FlutterMethodNotImplemented)
      }
    }

    // PCM control channel — start / stop AVAudioEngine
    let pcmCtrl = FlutterMethodChannel(
      name: Self.pcmControlName, binaryMessenger: messenger
    )
    pcmCtrl.setMethodCallHandler { [weak self] call, result in
      guard let self = self else { result(nil); return }
      switch call.method {
      case "start":
        do {
          print("[KINGZ IOS PCM] control start")
          try self.pcmPlayer.start()
          result(nil)
        } catch {
          result(
            FlutterError(
              code: "PCM_START_FAILED",
              message: error.localizedDescription,
              details: nil
            )
          )
        }
      case "stop":
        print("[KINGZ IOS PCM] control stop")
        self.pcmPlayer.stop()
        result(nil)
      case "flush":
        print("[KINGZ IOS PCM] control flush")
        self.pcmPlayer.flushToLiveEdge(reason: "dart-control")
        result(nil)
      case "configure":
        let args = call.arguments as? [String: Any]
        let sampleRate = args?["sampleRate"] as? Double
          ?? (args?["sampleRate"] as? NSNumber)?.doubleValue
          ?? 48_000
        let targetBufferMs = args?["targetBufferMs"] as? Int
          ?? (args?["targetBufferMs"] as? NSNumber)?.intValue
        let safeBufferMs = args?["safeBufferMs"] as? Int
          ?? (args?["safeBufferMs"] as? NSNumber)?.intValue
        let adaptive = args?["adaptive"] as? Bool
          ?? (args?["adaptive"] as? NSNumber)?.boolValue
        let mode = args?["mode"] as? String
        print("[KINGZ IOS PCM] control configure sampleRate=\(sampleRate) targetMs=\(targetBufferMs ?? -1) safeMs=\(safeBufferMs ?? -1) adaptive=\(adaptive.map(String.init) ?? "nil") mode=\(mode ?? "nil")")
        self.pcmPlayer.configureQueue(
          targetBufferMs: targetBufferMs,
          safeBufferMs: safeBufferMs,
          adaptive: adaptive,
          mode: mode
        )
        self.pcmPlayer.configure(sampleRate: sampleRate)
        result(nil)
      default:
        result(FlutterMethodNotImplemented)
      }
    }

    // PCM audio binary channel — high-frequency raw PCM bytes
    // BinaryCodec passes Data directly without JSON/standard-codec overhead.
    let pcmAudio = FlutterBasicMessageChannel(
      name: Self.pcmAudioName,
      binaryMessenger: messenger,
      codec: FlutterBinaryCodec()
    )
    pcmAudio.setMessageHandler { [weak self] message, reply in
      // Acknowledge immediately so the channel never blocks Dart.
      reply(nil)
      if let data = Self.binaryData(from: message) {
        self?.pcmPlayer.enqueue(data)
      }
    }
  }

  private static func binaryData(from message: Any?) -> Data? {
    if let data = message as? Data {
      return data
    }

    if let typedData = message as? FlutterStandardTypedData {
      return typedData.data
    }

    if let data = message as? NSData {
      return data as Data
    }

    return nil
  }

  override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    Self.deliver(url)
    return true
  }

  static func deliver(_ url: URL) {
    let value = url.absoluteString
    if let channel = linkChannel {
      channel.invokeMethod("openUrl", arguments: value)
    } else {
      pendingURL = value
    }
  }
}
