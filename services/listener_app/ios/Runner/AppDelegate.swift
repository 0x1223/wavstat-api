import AVFoundation
import Flutter
import UIKit

// MARK: - KingzPcmPlayer
// Receives raw Int16 stereo-interleaved PCM into a 48 kHz pull-rendered ring buffer.
private final class KingzPcmPlayer {
  private static let channelCount = 2

  private var engine: AVAudioEngine?
  private var sourceNode: AVAudioSourceNode?
  private var sampleRate: Double = 48_000
  private let bufferLock = NSLock()
  private var ringBuffer: [Int16] = []
  private var ringCapacityFrames = 0
  private var readFrame = 0
  private var writeFrame = 0
  private var enqueueLogCount = 0
  private var lastAutoStartAttempt = Date.distantPast
  private var queuedFrames: Int = 0
  private var playbackStarted = false
  private var underrunCount = 0
  private var fadeRemainingFrames = 0
  private var liveEdgeResetCount = 0
  private var recoveryTrimCount = 0
  private var lastRecoveryTrim = Date.distantPast
  private var targetBufferMs = 80
  private var safeBufferMs = 140
  private var adaptiveQueue = true
  private var monitoringMode = "balanced"
  private var lastDiagnosticsLog = Date()
  private var receivedFramesSinceLog = 0
  private var renderedFramesSinceLog = 0
  private var packetsSinceLog = 0
  private var lastPacketBytes = 0

  private var prebufferFrames: Int {
    msToFrames(max(35, min(targetBufferMs, safeBufferMs)))
  }

  private var targetLiveQueueFrames: Int {
    msToFrames(max(45, targetBufferMs))
  }

  private var recoveryTrimThresholdFrames: Int {
    let multiplier = adaptiveQueue ? 2 : 3
    return max(targetLiveQueueFrames + 1, msToFrames(max(targetBufferMs + 80, targetBufferMs * multiplier)))
  }

  private var overflowRetainFrames: Int {
    max(targetLiveQueueFrames, msToFrames(max(targetBufferMs + 40, safeBufferMs)))
  }

  private var maxQueuedFrames: Int {
    max(overflowRetainFrames + 1, msToFrames(max(safeBufferMs * 3, targetBufferMs + 300)))
  }

  private var ringCapacityTargetFrames: Int {
    max(maxQueuedFrames + Int(sampleRate * 0.500), Int(sampleRate * 2.500))
  }

  private var fadeFrames: Int {
    max(1, Int(sampleRate * 0.003))
  }

  private var format: AVAudioFormat {
    AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: sampleRate,
      channels: 2,
      interleaved: false
    )!
  }

  func configure(sampleRate newSampleRate: Double) throws {
    let normalizedSampleRate = supportedSampleRate(newSampleRate)
    guard abs(normalizedSampleRate - sampleRate) >= 1 else { return }
    let wasRunning = engine?.isRunning == true
    print("[KINGZ IOS PCM] configure requestedSampleRate=\(newSampleRate) streamSampleRate=\(normalizedSampleRate) wasRunning=\(wasRunning)")
    stop()
    sampleRate = normalizedSampleRate
    if wasRunning {
      try start()
    }
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
    print("[KINGZ IOS PCM] queue config mode=\(monitoringMode) targetMs=\(targetBufferMs) safeMs=\(safeBufferMs) adaptive=\(adaptiveQueue) prebuffer=\(prebufferFrames) recovery=\(recoveryTrimThresholdFrames) max=\(maxQueuedFrames)")
  }

  func start() throws {
    guard engine?.isRunning != true else { return }
    let eng = AVAudioEngine()
    let session = AVAudioSession.sharedInstance()
    try configureSession(session)
    try session.setActive(true)

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
    resetRingLocked()
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

    let frameCount = min(incomingFrameCount, maxQueuedFrames)
    let sourceStartFrame = max(0, incomingFrameCount - frameCount)

    bufferLock.lock()
    if queuedFrames + frameCount > maxQueuedFrames {
      let queuedBeforeFlush = queuedFrames
      trimOldestFramesLocked(
        max(0, queuedFrames - overflowRetainFrames)
      )
      liveEdgeResetCount += 1
      fadeRemainingFrames = fadeFrames
      print("[KINGZ IOS PCM] overflow trim #\(liveEdgeResetCount) queued=\(queuedBeforeFlush) incoming=\(frameCount) retain=\(overflowRetainFrames) max=\(maxQueuedFrames)")
    } else if adaptiveQueue,
      queuedFrames + frameCount > recoveryTrimThresholdFrames,
      Date().timeIntervalSince(lastRecoveryTrim) >= 0.35
    {
      let queuedBeforeTrim = queuedFrames
      trimOldestFramesLocked(
        max(0, queuedFrames - targetLiveQueueFrames)
      )
      recoveryTrimCount += 1
      lastRecoveryTrim = Date()
      fadeRemainingFrames = fadeFrames
      print("[KINGZ IOS PCM] recovery trim #\(recoveryTrimCount) queued=\(queuedBeforeTrim) incoming=\(frameCount) target=\(targetLiveQueueFrames) threshold=\(recoveryTrimThresholdFrames)")
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
      print("[KINGZ IOS PCM] enqueue #\(enqueueLogCount) bytes=\(data.count) frames=\(frameCount) queued=\(queuedSnapshot) target=\(prebufferFrames) max=\(maxQueuedFrames) engineRunning=\(engine?.isRunning == true) renderStarted=\(isPlaybackStarted)")
    }
  }

  private func prepareRingBuffer() {
    bufferLock.lock()
    ringCapacityFrames = ringCapacityTargetFrames
    ringBuffer = Array(repeating: 0, count: ringCapacityFrames * Self.channelCount)
    resetRingLocked()
    bufferLock.unlock()
  }

  private func resetRingLocked() {
    readFrame = 0
    writeFrame = 0
    queuedFrames = 0
    playbackStarted = false
    fadeRemainingFrames = fadeFrames
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
    for frame in 0..<frameCount {
      if !playbackStarted {
        if queuedFrames >= prebufferFrames {
          playbackStarted = true
          fadeRemainingFrames = fadeFrames
        } else {
          left[frame] = 0
          right[frame] = 0
          continue
        }
      }

      guard queuedFrames > 0, ringCapacityFrames > 0 else {
        left[frame] = 0
        right[frame] = 0
        if playbackStarted {
          playbackStarted = false
          underrunCount += 1
          fadeRemainingFrames = fadeFrames
        }
        continue
      }

      let ringIndex = readFrame * Self.channelCount
      var gain: Float = 1.0
      if fadeRemainingFrames > 0 {
        gain = Float(fadeFrames - fadeRemainingFrames + 1) / Float(fadeFrames)
        fadeRemainingFrames -= 1
      }
      left[frame] = (Float(ringBuffer[ringIndex]) / 32_768.0) * gain
      right[frame] = (Float(ringBuffer[ringIndex + 1]) / 32_768.0) * gain
      readFrame = (readFrame + 1) % ringCapacityFrames
      queuedFrames -= 1
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
    let packetsSnapshot = packetsSinceLog
    let packetBytesSnapshot = lastPacketBytes
    receivedFramesSinceLog = 0
    renderedFramesSinceLog = 0
    packetsSinceLog = 0
    lastDiagnosticsLog = now
    bufferLock.unlock()

    let queuedMs = Double(queuedSnapshot) * 1000.0 / sampleRate
    let receiveFps = Double(receivedSnapshot) / elapsed
    let renderFps = Double(renderedSnapshot) / elapsed
    let packetFrames = packetBytesSnapshot / (Self.channelCount * MemoryLayout<Int16>.size)
    print("[KINGZ IOS PCM] diag mode=\(monitoringMode) targetMs=\(targetBufferMs) streamSampleRate=\(sampleRate) queuedFrames=\(queuedSnapshot) queuedMs=\(Int(queuedMs.rounded())) receivedFps=\(Int(receiveFps.rounded())) renderedFps=\(Int(renderFps.rounded())) packets=\(packetsSnapshot) lastPacketBytes=\(packetBytesSnapshot) lastPacketFrames=\(packetFrames) underruns=\(underrunCount) overflowTrims=\(liveEdgeResetCount) recoveryTrims=\(recoveryTrimCount)")
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

  private func msToFrames(_ milliseconds: Int) -> Int {
    max(1, Int((sampleRate * Double(milliseconds) / 1000.0).rounded()))
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
        do {
          print("[KINGZ IOS PCM] control configure sampleRate=\(sampleRate) targetMs=\(targetBufferMs ?? -1) safeMs=\(safeBufferMs ?? -1) adaptive=\(adaptive.map(String.init) ?? "nil") mode=\(mode ?? "nil")")
          self.pcmPlayer.configureQueue(
            targetBufferMs: targetBufferMs,
            safeBufferMs: safeBufferMs,
            adaptive: adaptive,
            mode: mode
          )
          try self.pcmPlayer.configure(sampleRate: sampleRate)
          result(nil)
        } catch {
          result(
            FlutterError(
              code: "PCM_CONFIGURE_FAILED",
              message: error.localizedDescription,
              details: nil
            )
          )
        }
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
