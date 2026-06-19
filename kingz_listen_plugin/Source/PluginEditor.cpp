#include "PluginEditor.h"

#include <cstddef>
#include <cstring>
#include <memory>
#include <vector>

namespace
{
std::vector<std::byte> stringToBytes (const juce::String& text)
{
    const auto utf8 = text.toRawUTF8();
    const auto byteCount = static_cast<std::size_t> (std::strlen (utf8));
    std::vector<std::byte> data (byteCount);

    for (std::size_t i = 0; i < byteCount; ++i)
        data[i] = static_cast<std::byte> (utf8[i]);

    return data;
}

juce::String getMimeTypeForUrl (const juce::String& url)
{
    if (url.endsWithIgnoreCase (".js"))
        return "text/javascript";

    if (url.endsWithIgnoreCase (".css"))
        return "text/css";

    if (url.endsWithIgnoreCase (".svg"))
        return "image/svg+xml";

    return "text/html";
}

juce::String getPlaceholderHtml()
{
    return R"HTML(<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kingz Listen</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0c0e12; color: white; }
    main { width: min(320px, calc(100vw - 48px)); text-align: center; }
    h1 { margin: 0 0 12px; font-size: 28px; }
    p { margin: 0 0 24px; color: #aab2c0; line-height: 1.45; }
    dl { margin: 0 0 24px; display: grid; grid-template-columns: auto 1fr; gap: 8px 12px; text-align: left; }
    dt { color: #6f7a89; }
    dd { margin: 0; color: #fff; font-variant-numeric: tabular-nums; }
    input { width: 100%; box-sizing: border-box; border: 1px solid #2a303b; border-radius: 8px; padding: 8px 10px; background: #151922; color: #fff; font: inherit; font-variant-numeric: tabular-nums; }
    button { width: 100%; border: 0; border-radius: 8px; padding: 14px 16px; background: #fff; color: #0c0e12; font-weight: 700; margin-bottom: 8px; cursor: pointer; }
    .meter { margin: -8px 0 20px; text-align: left; }
    .meter-label { display: flex; justify-content: space-between; margin-bottom: 8px; color: #aab2c0; font-size: 12px; }
    .bar { height: 8px; overflow: hidden; border-radius: 8px; background: #202633; }
    .bar span { display: block; width: 100%; height: 100%; transform-origin: left; transform: scaleX(1); background: #52d273; transition: transform 120ms linear, background 120ms linear; }
    .latency-good { color: #52d273; }
    .latency-warn { color: #f1c84b; }
    .latency-bad { color: #ff6b6b; }
    pre { display: none; margin: 18px 0 0; padding: 12px; border-radius: 8px; background: #151922; color: #d7dce5; text-align: left; white-space: pre-wrap; word-break: break-word; font-size: 12px; }
    .seg-label { margin: 0 0 6px; color: #6f7a89; font-size: 12px; text-align: left; }
    .seg { display: flex; gap: 6px; margin: 0 0 16px; }
    .seg-btn { flex: 1; width: auto; margin: 0; padding: 10px 12px; background: #202633; color: #aab2c0; font-weight: 600; transition: background 120ms linear, color 120ms linear; }
    .seg-btn.active { background: #fff; color: #0c0e12; }
  </style>
</head>
<body>
  <main>
    <h1>Kingz Listen</h1>
    <p id="mount-status">LAN monitoring bridge ready.</p>
    <dl>
      <dt>Studio IP</dt><dd><input id="studio-ip" inputmode="decimal"></dd>
      <dt>Port</dt><dd><input id="studio-port" inputmode="numeric" value="8082"></dd>
      <dt>Status</dt><dd id="telemetry-status">Waiting</dd>
      <dt>Latency</dt><dd id="latency-value" class="latency-good">-- ms</dd>
    </dl>
    <div class="meter">
      <div class="meter-label"><span>Buffer Health</span><span id="buffer-health-label">100%</span></div>
      <div class="bar"><span id="buffer-health-bar"></span></div>
    </div>
    <div class="seg-label">Stream Name</div>
    <input id="stream-name" placeholder="Kingz Listen" style="margin-bottom:16px;">
    <div class="seg-label">Broadcast Quality</div>
    <div class="seg" id="transport-seg">
      <button type="button" id="transport-pcm" class="seg-btn active">Raw PCM</button>
      <button type="button" id="transport-opus" class="seg-btn">Opus</button>
    </div>
    <button id="connect">Connect</button>
    <button id="toggle">Toggle Monitoring</button>
    <pre id="telemetry-preview"></pre>
  </main>
  <script>
    // ── global state ──────────────────────────────────────────────────────────
    var studioIpInput   = document.getElementById("studio-ip");
    var studioPortInput = document.getElementById("studio-port");
    var streamNameInput = document.getElementById("stream-name");
    var connectionFieldsEdited = false;
    var nativePromiseId = 1;
    var nativePromises  = {};
    var telemetrySocket = null;
    var peerConnection  = null;
    var pcmDataChannel  = null;
    var pendingRemoteCandidates = [];
    var signalId = "kingz-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);

    studioIpInput.addEventListener("input",   function() { connectionFieldsEdited = true; });
    studioPortInput.addEventListener("input", function() { connectionFieldsEdited = true; });

    // When loaded over HTTP (mobile Safari), auto-populate host+port from URL
    if (window.location.protocol === "http:" && window.location.hostname) {
      studioIpInput.value   = window.location.hostname;
      studioPortInput.value = window.location.port || "8082";
    }

    // ── helpers ───────────────────────────────────────────────────────────────
    function tryParseJson(s, fallback) {
      try { return JSON.parse(s); } catch (_) { return fallback; }
    }

    function latencyClass(ms) {
      return ms <= 12 ? "latency-good" : ms <= 30 ? "latency-warn" : "latency-bad";
    }

    // ── JUCE connection-state handler (Logic Pro only) ────────────────────────
    function applyConnectionState(payload) {
      if (!payload) return;
      window.__KINGZ_LISTEN_CONNECTION__ = payload;
      if (!connectionFieldsEdited) {
        studioIpInput.value   = payload.localIp || studioIpInput.value || "127.0.0.1";
        studioPortInput.value = String(payload.port || studioPortInput.value || "8082");
      }
    }

    // ── telemetry display ─────────────────────────────────────────────────────
    function applyTelemetry(payload) {
      var parsed = (typeof payload === "string") ? tryParseJson(payload, { raw: payload }) : payload;
      window.__KINGZ_LISTEN_TELEMETRY__ = parsed;
      document.getElementById("mount-status").textContent = "Telemetry interface mounted.";
      document.getElementById("telemetry-status").textContent = "Live";
      var preview = document.getElementById("telemetry-preview");
      preview.style.display = "block";
      preview.textContent = JSON.stringify(parsed, null, 2);
    }

    function applyTelemetryReport(payload) {
      var report = (typeof payload === "string") ? tryParseJson(payload, null) : payload;
      if (!report) return;
      var health      = Math.max(0, Math.min(1, Number(report.bufferHealth != null ? report.bufferHealth : 1)));
      var latency     = Number(report.latencyMs || 0);
      var clientCount = Number(report.activeClientCount || 0);
      document.getElementById("telemetry-status").textContent = report.isConnected
        ? "Live (" + clientCount + " client" + (clientCount === 1 ? "" : "s") + ")"
        : "Waiting";
      var latencyNode = document.getElementById("latency-value");
      latencyNode.textContent = latency > 0 ? latency.toFixed(1) + " ms" : "-- ms";
      latencyNode.className   = latencyClass(latency);
      var bar = document.getElementById("buffer-health-bar");
      bar.style.transform  = "scaleX(" + health.toFixed(3) + ")";
      bar.style.background = health >= 0.75 ? "#52d273" : health >= 0.4 ? "#f1c84b" : "#ff6b6b";
      document.getElementById("buffer-health-label").textContent = Math.round(health * 100) + "%";
      window.__KINGZ_LISTEN_TELEMETRY_REPORT__ = report;
      if (report.transportMode) reflectTransport(report.transportMode);
      if (report.streamName) reflectStreamName(report.streamName);
    }

    // ── WebRTC signaling ──────────────────────────────────────────────────────
    function sendTelemetrySignal(payload) {
      if (!telemetrySocket || telemetrySocket.readyState !== WebSocket.OPEN) return;
      var msg = Object.assign({ source_id: "kingz-listen-web", signal_id: signalId }, payload);
      telemetrySocket.send(JSON.stringify(msg));
    }

    function bindPcmDataChannel(channel) {
      if (!channel || channel.label !== "kingz-pcm") return;
      pcmDataChannel = channel;
      pcmDataChannel.binaryType = "arraybuffer";
      pcmDataChannel.onopen  = function() { document.getElementById("telemetry-status").textContent = "PCM DataChannel live"; };
      pcmDataChannel.onclose = function() { document.getElementById("telemetry-status").textContent = "PCM DataChannel closed"; };
      pcmDataChannel.onmessage = function(e) {
        window.__KINGZ_LISTEN_LAST_PCM_PACKET__ = { byteLength: e.data.byteLength || 0, receivedAt: Date.now() };
      };
    }

    function flushPendingRemoteCandidates() {
      if (!peerConnection || !peerConnection.remoteDescription) return Promise.resolve();
      var candidates = pendingRemoteCandidates.slice();
      pendingRemoteCandidates = [];
      return Promise.all(candidates.map(function(c) {
        return peerConnection.addIceCandidate(c).catch(function(e) { console.warn("ICE", e); });
      }));
    }

    function handleTelemetrySignal(message) {
      if (!message) return Promise.resolve();
      if (message.signal_id && message.signal_id !== signalId) return Promise.resolve();

      if (message.type === "webrtc-answer") {
        if (!peerConnection) return Promise.resolve();
        return peerConnection
          .setRemoteDescription({ type: message.descriptionType || "answer", sdp: message.sdp })
          .then(flushPendingRemoteCandidates);
      }

      if (message.type === "webrtc-candidate") {
        var cp = (message.candidate && message.candidate.candidate)
          ? message.candidate
          : { candidate: message.candidate, sdpMid: message.sdpMid, sdpMLineIndex: message.sdpMLineIndex };
        if (!cp.candidate) return Promise.resolve();
        var candidate = new RTCIceCandidate(cp);
        if (!peerConnection || !peerConnection.remoteDescription) {
          pendingRemoteCandidates.push(candidate);
          return Promise.resolve();
        }
        return peerConnection.addIceCandidate(candidate).catch(function(e) { console.warn("ICE add", e); });
      }

      return Promise.resolve();
    }

    function startWebRtcReceiver(host, port) {
      if (peerConnection) { try { peerConnection.close(); } catch (_) {} }
      pendingRemoteCandidates = [];
      signalId = "kingz-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
      peerConnection = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      peerConnection.onicecandidate = function(e) {
        if (e.candidate) sendTelemetrySignal({ type: "webrtc-candidate", candidate: e.candidate.toJSON() });
      };
      peerConnection.ondatachannel = function(e) { bindPcmDataChannel(e.channel); };
      peerConnection.onconnectionstatechange = function() {
        document.getElementById("telemetry-status").textContent = "WebRTC " + peerConnection.connectionState;
      };
      bindPcmDataChannel(peerConnection.createDataChannel("kingz-pcm", { ordered: false, maxRetransmits: 0 }));
      return peerConnection.createOffer()
        .then(function(offer) {
          return peerConnection.setLocalDescription(offer).then(function() { return offer; });
        })
        .then(function(offer) {
          sendTelemetrySignal({ type: "webrtc-offer", sdp: offer.sdp, descriptionType: offer.type, offerGeneration: Date.now() });
        });
    }

    function openTelemetrySocket(host, port) {
      var url = "ws://" + host + ":" + port + "/";
      if (telemetrySocket && telemetrySocket.readyState === WebSocket.OPEN) {
        startWebRtcReceiver(host, port).catch(console.error);
        return;
      }
      if (telemetrySocket) { try { telemetrySocket.close(); } catch (_) {} }
      document.getElementById("telemetry-status").textContent = "Connecting…";
      telemetrySocket = new WebSocket(url);
      telemetrySocket.onopen = function() {
        sendTelemetrySignal({ type: "receiver.hello" });
        startWebRtcReceiver(host, port).catch(function(e) {
          document.getElementById("telemetry-status").textContent = "WebRTC offer failed";
          console.error(e);
        });
      };
      telemetrySocket.onmessage = function(e) {
        var msg = tryParseJson(e.data, null);
        if (!msg) return;
        handleTelemetrySignal(msg).catch(console.error);
        if (msg.type === "telemetry.report") { applyTelemetryReport(msg); }
        else { applyTelemetry(msg); }
      };
      telemetrySocket.onclose = function() {
        document.getElementById("telemetry-status").textContent = "Disconnected";
      };
      telemetrySocket.onerror = function() {
        document.getElementById("telemetry-status").textContent = "Connection error";
      };
    }

    // ── JUCE native bridge (Logic Pro only, gracefully absent elsewhere) ──────
    function hasNativeBridge() {
      var j = window.__JUCE__;
      return !!(j && j.backend && j.backend.emitEvent
        && j.initialisationData && Array.isArray(j.initialisationData.__juce__functions)
        && j.initialisationData.__juce__functions.indexOf("juceLink") !== -1);
    }

    function waitForNativeBridge(timeoutMs) {
      if (hasNativeBridge()) return Promise.resolve();
      var start = Date.now();
      return new Promise(function(resolve, reject) {
        (function poll() {
          if (hasNativeBridge()) return resolve();
          if (Date.now() - start >= (timeoutMs || 2000)) return reject(new Error("JUCE bridge unavailable"));
          setTimeout(poll, 50);
        })();
      });
    }

    function invokeNativeFunction(name, payload) {
      return new Promise(function(resolve, reject) {
        var backend = window.__JUCE__ && window.__JUCE__.backend;
        if (!backend || !backend.emitEvent) { reject(new Error("JUCE backend unavailable")); return; }
        var resultId = nativePromiseId++;
        nativePromises[resultId] = { resolve: resolve, reject: reject };
        backend.emitEvent("__juce__invoke", { name: name, params: [payload], resultId: resultId });
        setTimeout(function() {
          if (nativePromises[resultId]) { delete nativePromises[resultId]; reject(new Error("JUCE timed out")); }
        }, 3000);
      });
    }

    function sendToNative(payload) {
      return waitForNativeBridge().then(function() { return invokeNativeFunction("juceLink", payload); });
    }

    function registerBackendListeners() {
      if (!window.__JUCE__ || !window.__JUCE__.backend) { setTimeout(registerBackendListeners, 50); return; }
      var b = window.__JUCE__.backend;
      b.addEventListener("kingzConnectionState", applyConnectionState);
      b.addEventListener("kingzTelemetry",       applyTelemetry);
      b.addEventListener("kingzTelemetryReport", applyTelemetryReport);
      b.addEventListener("kingzConnectionAttempt", function(p) {
        document.getElementById("telemetry-status").textContent = "Opening " + (p && p.url ? p.url : "socket");
      });
      b.addEventListener("__juce__complete", function(p) {
        var c = nativePromises[p.promiseId];
        if (!c) return;
        delete nativePromises[p.promiseId];
        c.resolve(p.result);
      });
    }

    // ── init ──────────────────────────────────────────────────────────────────
    registerBackendListeners();

    // Auto-connect when opened in a browser (not inside Logic's WebView)
    if (window.location.protocol === "http:" && window.location.hostname) {
      var _h = window.location.hostname;
      var _p = window.location.port || "8082";
      setTimeout(function() { openTelemetrySocket(_h, _p); }, 400);
    }

    // ── button handlers ───────────────────────────────────────────────────────
    document.getElementById("toggle").addEventListener("click", function() {
      sendToNative({ action: "toggleMonitoringMode", source: "web-ui" }).catch(console.error);
    });

    document.getElementById("connect").addEventListener("click", function() {
      var host = studioIpInput.value.trim();
      var port = parseInt(studioPortInput.value, 10) || 8082;
      document.getElementById("telemetry-status").textContent = "Connecting…";
      sendToNative({ action: "connectTelemetry", source: "web-ui", host: host, port: port })
        .then(function() { openTelemetrySocket(host || "127.0.0.1", port); })
        .catch(function() { openTelemetrySocket(host || "127.0.0.1", port); });
    });

    // ── broadcast-quality (transport) toggle ───────────────────────────────────
    // Engineer control; the plugin (NetworkTransmitter.transportMode) is the source of truth and
    // the telemetry report re-syncs this UI. Listeners auto-follow via the transport.mode broadcast.
    var currentTransport = "pcm";
    function reflectTransport(mode) {
      currentTransport = (mode === "opus") ? "opus" : "pcm";
      var pcmBtn  = document.getElementById("transport-pcm");
      var opusBtn = document.getElementById("transport-opus");
      if (pcmBtn)  pcmBtn.classList.toggle("active",  currentTransport === "pcm");
      if (opusBtn) opusBtn.classList.toggle("active", currentTransport === "opus");
    }
    function setTransport(mode) {
      reflectTransport(mode);  // optimistic; telemetry report confirms
      sendToNative({ action: "setStreamTransport", source: "web-ui", transport: currentTransport }).catch(console.error);
    }
    document.getElementById("transport-pcm").addEventListener("click",  function() { setTransport("pcm"); });
    document.getElementById("transport-opus").addEventListener("click", function() { setTransport("opus"); });

    // ── stream name (engineer-editable broadcast name) ─────────────────────────
    // Source of truth is the plugin; the telemetry report re-syncs this field (without clobbering
    // while the engineer is typing). Committing broadcasts to all receivers (app + web).
    function reflectStreamName(name) {
      if (document.activeElement === streamNameInput) return;
      if (streamNameInput.value !== name) streamNameInput.value = name;
    }
    function commitStreamName() {
      var v = (streamNameInput.value || "").trim();
      sendToNative({ action: "setStreamName", source: "web-ui", name: v }).catch(console.error);
    }
    streamNameInput.addEventListener("change", commitStreamName);
    streamNameInput.addEventListener("keydown", function(e) { if (e.key === "Enter") streamNameInput.blur(); });
  </script>
</body>
</html>)HTML";
}

}

KingzListenAudioProcessorEditor::KingzListenAudioProcessorEditor (KingzListenAudioProcessor& audioProcessor)
    : juce::AudioProcessorEditor (audioProcessor),
      processorRef (audioProcessor),
      webView (createWebViewOptions (*this))
{
    addAndMakeVisible (webView);
    setSize (400, 650);
    webView.goToURL ("juce://ui/index.html");

    juce::Component::SafePointer<KingzListenAudioProcessorEditor> safeThis { this };
    processorRef.getWebSocketManager().addListener (this);
    startTimerHz (30);

    juce::Timer::callAfterDelay (500, [safeThis]
    {
        if (safeThis != nullptr)
            safeThis->emitConnectionStateToWebView();
    });
    juce::Timer::callAfterDelay (1500, [safeThis]
    {
        if (safeThis != nullptr)
            safeThis->emitConnectionStateToWebView();
    });
}

KingzListenAudioProcessorEditor::~KingzListenAudioProcessorEditor()
{
    stopTimer();
    processorRef.getWebSocketManager().removeListener (this);
}

juce::WebBrowserComponent::Options KingzListenAudioProcessorEditor::createWebViewOptions (
    KingzListenAudioProcessorEditor& editor)
{
    auto options = juce::WebBrowserComponent::Options {}
        .withNativeIntegrationEnabled()
        .withKeepPageLoadedWhenBrowserIsHidden()
        .withNativeFunction (
            juce::Identifier { "juceLink" },
            [&editor] (const juce::Array<juce::var>& arguments,
                       juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                const auto payload = arguments.isEmpty() ? juce::var {} : arguments.getFirst();
                editor.handleUiCall (payload, std::move (completion));
            })
        .withResourceProvider (
            [&editor] (const juce::String& url)
            {
                return editor.getUIResource (url);
            },
            juce::String { "juce://ui" });

   #if JUCE_WINDOWS
    options = options
        .withBackend (juce::WebBrowserComponent::Options::Backend::webview2)
        .withWinWebView2Options (
            juce::WebBrowserComponent::Options::WinWebView2 {}
                .withUserDataFolder (
                    juce::File::getSpecialLocation (juce::File::tempDirectory)
                        .getChildFile ("KingzListenWebView2")));
   #endif

    return options;
}

void KingzListenAudioProcessorEditor::resized()
{
    webView.setBounds (getLocalBounds());
}

void KingzListenAudioProcessorEditor::timerCallback()
{
    const auto nowMs = juce::Time::currentTimeMillis();
    if (nowMs - lastTelemetryReportMs < 100)
        return;

    lastTelemetryReportMs = nowMs;
    const auto report = processorRef.getTelemetryReport();

    webView.emitEventIfBrowserIsVisible (juce::Identifier { "kingzTelemetryReport" },
                                         juce::var { report });
}

void KingzListenAudioProcessorEditor::emitTelemetryToWebView (const juce::String& telemetryJson)
{
    webView.emitEventIfBrowserIsVisible (juce::Identifier { "kingzTelemetry" },
                                         juce::var { telemetryJson });
}

void KingzListenAudioProcessorEditor::emitConnectionAttemptToWebView (const juce::String& url)
{
    auto payload = std::make_unique<juce::DynamicObject>();
    payload->setProperty ("url", url);

    webView.emitEventIfBrowserIsVisible (juce::Identifier { "kingzConnectionAttempt" },
                                         juce::var { payload.release() });
}

void KingzListenAudioProcessorEditor::onWebSocketMessageReceived (const std::string& message)
{
    juce::Component::SafePointer<KingzListenAudioProcessorEditor> safeThis { this };
    const auto telemetryJson = juce::String::fromUTF8 (message.c_str());

    juce::MessageManager::callAsync ([safeThis, telemetryJson]
    {
        if (safeThis != nullptr)
            safeThis->emitTelemetryToWebView (telemetryJson);
    });
}

void KingzListenAudioProcessorEditor::handleUiCall (
    const juce::var& object,
    juce::WebBrowserComponent::NativeFunctionCompletion completion)
{
    DBG ("KingzListenAudioProcessorEditor::handleUiCall: " << juce::JSON::toString (object));

    if (auto* dynamicObject = object.getDynamicObject())
    {
        if (dynamicObject->getProperty ("action").toString() == "connectTelemetry")
        {
            const auto host = dynamicObject->getProperty ("host").toString();
            const auto port = static_cast<int> (dynamicObject->getProperty ("port"));
            const auto cleanHost = host.isNotEmpty() ? host : juce::String { "127.0.0.1" };
            DBG ("KingzListenAudioProcessorEditor::handleUiCall connectTelemetry host="
                 << host << " port=" << port);
            emitConnectionAttemptToWebView ("ws://" + cleanHost + ":" + juce::String (port > 0 ? port : 8082));
        }
    }

    processorRef.handleUiAction (object);

    auto response = std::make_unique<juce::DynamicObject>();
    response->setProperty ("ok", true);

    if (auto* dynamicObject = object.getDynamicObject())
        response->setProperty ("action", dynamicObject->getProperty ("action"));

    completion (juce::var { response.release() });
}

void KingzListenAudioProcessorEditor::emitConnectionStateToWebView()
{
    auto state = std::make_unique<juce::DynamicObject>();
    state->setProperty ("localIp", processorRef.getLocalLanIpAddress());
    state->setProperty ("port", 8082);
    state->setProperty ("transport", "webrtc-datachannel-pcm");
    state->setProperty ("sampleRate", AudioFifoWorker::targetSampleRate);
    state->setProperty ("channels", AudioFifoWorker::inputChannels);
    state->setProperty ("bitDepth", 16);
    state->setProperty ("targetChunkMs", processorRef.getTargetChunkMs());
    state->setProperty ("chunkBytes", static_cast<int> (AudioFifoWorker::bytesForChunkMs (processorRef.getTargetChunkMs())));
    state->setProperty ("adaptiveChunkSizing", true);
    state->setProperty ("minChunkMs", AudioFifoWorker::minChunkDurationMs);
    state->setProperty ("maxChunkMs", AudioFifoWorker::maxChunkDurationMs);
    state->setProperty ("bitrate", AudioFifoWorker::telemetryBitrateBitsPerSecond);

    auto payload = juce::var { state.release() };
    webView.emitEventIfBrowserIsVisible (juce::Identifier { "kingzConnectionState" }, payload);
}

std::optional<juce::WebBrowserComponent::Resource>
KingzListenAudioProcessorEditor::getUIResource (const juce::String& url)
{
    const auto normalisedUrl = url.upToFirstOccurrenceOf ("?", false, false);

    if (normalisedUrl == "juce://ui/"
        || normalisedUrl == "juce://ui"
        || normalisedUrl.endsWithIgnoreCase ("/index.html"))
    {
        return juce::WebBrowserComponent::Resource {
            stringToBytes (getPlaceholderHtml()),
            "text/html"
        };
    }

    return juce::WebBrowserComponent::Resource {
        stringToBytes ({ }),
        getMimeTypeForUrl (normalisedUrl)
    };
}
