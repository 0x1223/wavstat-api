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
    h1 { margin: 0 0 12px; font-size: 28px; letter-spacing: 0; }
    p { margin: 0 0 24px; color: #aab2c0; line-height: 1.45; }
    dl { margin: 0 0 24px; display: grid; grid-template-columns: auto 1fr; gap: 8px 12px; text-align: left; }
    dt { color: #6f7a89; }
    dd { margin: 0; color: #ffffff; font-variant-numeric: tabular-nums; }
    input { width: 100%; box-sizing: border-box; border: 1px solid #2a303b; border-radius: 8px; padding: 8px 10px; background: #151922; color: #ffffff; font: inherit; font-variant-numeric: tabular-nums; }
    button { width: 100%; border: 0; border-radius: 8px; padding: 14px 16px; background: #ffffff; color: #0c0e12; font-weight: 700; }
    .meter { margin: -8px 0 20px; text-align: left; }
    .meter-label { display: flex; justify-content: space-between; margin-bottom: 8px; color: #aab2c0; font-size: 12px; }
    .bar { height: 8px; overflow: hidden; border-radius: 8px; background: #202633; }
    .bar span { display: block; width: 100%; height: 100%; transform-origin: left center; transform: scaleX(1); background: #52d273; transition: transform 120ms linear, background 120ms linear; }
    .latency-good { color: #52d273; }
    .latency-warn { color: #f1c84b; }
    .latency-bad { color: #ff6b6b; }
    pre { display: none; margin: 18px 0 0; padding: 12px; border-radius: 8px; background: #151922; color: #d7dce5; text-align: left; white-space: pre-wrap; word-break: break-word; font-size: 12px; }
  </style>
</head>
<body>
  <main>
    <h1>Kingz Listen</h1>
    <p id="mount-status">LAN monitoring bridge ready. The full telemetry interface will mount here.</p>
    <dl>
      <dt>Studio IP</dt><dd><input id="studio-ip" inputmode="decimal"></dd>
      <dt>Port</dt><dd><input id="studio-port" inputmode="numeric"></dd>
      <dt>Telemetry</dt><dd id="telemetry-status">Waiting</dd>
      <dt>Latency</dt><dd id="latency-value" class="latency-good">-- ms</dd>
    </dl>
    <div class="meter" aria-label="Buffer health">
      <div class="meter-label"><span>Buffer Health</span><span id="buffer-health-label">100%</span></div>
      <div class="bar"><span id="buffer-health-bar"></span></div>
    </div>
    <button id="connect">Connect Telemetry</button>
    <button id="toggle">Toggle Monitoring</button>
    <pre id="telemetry-preview"></pre>
  </main>
  <script>
    const studioIpInput = document.getElementById("studio-ip");
    const studioPortInput = document.getElementById("studio-port");
    let connectionFieldsEdited = false;
    let nativePromiseId = 1;
    const nativePromises = new Map();

    function markConnectionFieldsEdited() {
      connectionFieldsEdited = true;
    }

    studioIpInput.addEventListener("focus", markConnectionFieldsEdited);
    studioIpInput.addEventListener("input", markConnectionFieldsEdited);
    studioPortInput.addEventListener("focus", markConnectionFieldsEdited);
    studioPortInput.addEventListener("input", markConnectionFieldsEdited);

    function applyConnectionState(payload) {
      if (!payload) return;
      window.__KINGZ_LISTEN_CONNECTION__ = payload;

      if (!connectionFieldsEdited) {
        studioIpInput.value = payload.localIp || studioIpInput.value || "127.0.0.1";
        studioPortInput.value = String(payload.port || studioPortInput.value || 8081);
      }
    }

    function applyTelemetry(payload) {
      let parsed = payload;
      if (typeof payload === "string") {
        try { parsed = JSON.parse(payload); } catch (_) { parsed = { raw: payload }; }
      }

      window.__KINGZ_LISTEN_TELEMETRY__ = parsed;
      document.getElementById("mount-status").textContent = "Telemetry interface mounted.";
      document.getElementById("telemetry-status").textContent = "Live";

      const preview = document.getElementById("telemetry-preview");
      preview.style.display = "block";
      preview.textContent = JSON.stringify(parsed, null, 2);
    }

    function latencyClass(latencyMs) {
      if (latencyMs <= 12) return "latency-good";
      if (latencyMs <= 30) return "latency-warn";
      return "latency-bad";
    }

    function applyTelemetryReport(payload) {
      let report = payload;
      if (typeof payload === "string") {
        try { report = JSON.parse(payload); } catch (_) { return; }
      }
      if (!report) return;

      const health = Math.max(0, Math.min(1, Number(report.bufferHealth ?? 1)));
      const latency = Number(report.latencyMs ?? 0);
      const latencyNode = document.getElementById("latency-value");
      const bar = document.getElementById("buffer-health-bar");
      const healthLabel = document.getElementById("buffer-health-label");
      const clientCount = Number(report.activeClientCount ?? 0);

      document.getElementById("telemetry-status").textContent = report.isConnected
        ? "Live (" + clientCount + " client" + (clientCount === 1 ? "" : "s") + ")"
        : "Waiting";

      latencyNode.textContent = latency > 0 ? latency.toFixed(1) + " ms" : "-- ms";
      latencyNode.className = latencyClass(latency);
      bar.style.transform = "scaleX(" + health.toFixed(3) + ")";
      bar.style.background = health >= 0.75 ? "#52d273" : (health >= 0.4 ? "#f1c84b" : "#ff6b6b");
      healthLabel.textContent = Math.round(health * 100) + "%";
      window.__KINGZ_LISTEN_TELEMETRY_REPORT__ = report;
    }

    function hasNativeBridge() {
      const juce = window.__JUCE__;
      const backend = juce && juce.backend;
      const functions = juce && juce.initialisationData && juce.initialisationData.__juce__functions;
      return !!(backend && backend.emitEvent && Array.isArray(functions) && functions.includes("juceLink"));
    }

    function waitForNativeBridge(timeoutMs = 2000) {
      if (hasNativeBridge()) return Promise.resolve();

      const started = Date.now();
      return new Promise((resolve, reject) => {
        const poll = () => {
          if (hasNativeBridge()) {
            resolve();
            return;
          }

          if (Date.now() - started >= timeoutMs) {
            reject(new Error("JUCE native bridge unavailable"));
            return;
          }

          window.setTimeout(poll, 50);
        };

        poll();
      });
    }

    function invokeNativeFunction(name, payload) {
      return new Promise((resolve, reject) => {
        const backend = window.__JUCE__ && window.__JUCE__.backend;
        if (!backend || !backend.emitEvent) {
          reject(new Error("JUCE backend unavailable"));
          return;
        }

        const resultId = nativePromiseId++;
        nativePromises.set(resultId, { resolve, reject });
        backend.emitEvent("__juce__invoke", {
          name,
          params: [payload],
          resultId
        });

        window.setTimeout(() => {
          if (nativePromises.has(resultId)) {
            nativePromises.delete(resultId);
            reject(new Error("JUCE native bridge timed out"));
          }
        }, 3000);
      });
    }

    async function sendToNative(payload) {
      await waitForNativeBridge();
      return await invokeNativeFunction("juceLink", payload);
    }

    function registerBackendListeners() {
      if (!window.__JUCE__ || !window.__JUCE__.backend) {
        window.setTimeout(registerBackendListeners, 50);
        return;
      }

      window.__JUCE__.backend.addEventListener("kingzConnectionState", applyConnectionState);
      window.__JUCE__.backend.addEventListener("kingzTelemetry", applyTelemetry);
      window.__JUCE__.backend.addEventListener("kingzConnectionAttempt", (payload) => {
        document.getElementById("telemetry-status").textContent = "Opening " + (payload && payload.url ? payload.url : "socket");
      });
      window.__JUCE__.backend.addEventListener("kingzTelemetryReport", applyTelemetryReport);
      window.__JUCE__.backend.addEventListener("__juce__complete", ({ promiseId, result }) => {
        const completion = nativePromises.get(promiseId);
        if (!completion) return;

        nativePromises.delete(promiseId);
        completion.resolve(result);
      });
    }

    registerBackendListeners();

    document.getElementById("toggle").addEventListener("click", () => {
      sendToNative({ action: "toggleMonitoringMode", source: "placeholder-ui" })
        .catch((error) => console.error(error));
    });

    document.getElementById("connect").addEventListener("click", () => {
      const host = studioIpInput.value.trim();
      const port = Number.parseInt(studioPortInput.value, 10) || 8081;
      document.getElementById("telemetry-status").textContent = "Connecting";
      sendToNative({ action: "connectTelemetry", source: "placeholder-ui", host, port })
        .catch((error) => {
          document.getElementById("telemetry-status").textContent = "Bridge unavailable";
          console.error(error);
        });
    });
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
            emitConnectionAttemptToWebView ("ws://" + cleanHost + ":" + juce::String (port > 0 ? port : 8081));
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
    state->setProperty ("port", 8081);
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
