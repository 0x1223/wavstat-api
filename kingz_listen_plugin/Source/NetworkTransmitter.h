#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <vector>

#include <juce_core/juce_core.h>

#include "AudioFifoWorker.h"

#if JUCE_WINDOWS
 #ifndef NOMINMAX
  #define NOMINMAX 1
 #endif
 #include <winsock2.h>
 #include <ws2tcpip.h>
#else
 #include <netinet/in.h>
 #include <sys/socket.h>
#endif

class NetworkTransmitter final : private juce::Thread
{
public:
    explicit NetworkTransmitter (AudioFifoWorker& fifoToRead);
    ~NetworkTransmitter() override;;

    bool start (int portToUse = 8082);
    void stop();

    int getPort() const noexcept;
    int getConnectedClientCount() const noexcept;
    juce::String getLocalLanIpAddress() const;
    void setStreamSampleRate (double sampleRate) noexcept;
    void setTransportMode (int mode);  // 0 = PCM, 1 = Opus; stores + broadcasts to clients
    void setStreamName (const juce::String& name);  // editable display name; stores + broadcasts
    juce::String getStreamName() const;
    void updateTransportSnapshot (bool isPlaying,
                                  juce::int64 hostSamplePosition,
                                  juce::int64 streamWritePosition,
                                  double bpm,
                                  double ppqPosition) noexcept;
    void setExternalSignalingSender (std::function<void (const juce::String&)> sender);
    void handleExternalSignalingMessage (const juce::var& message);

    std::atomic<bool> isConnected { false };
    std::atomic<int> activeClientCount { 0 };
    std::atomic<float> bufferHealth { 1.0f };
    std::atomic<int> targetChunkMs { AudioFifoWorker::chunkDurationMs };
    std::atomic<bool> chunkSizeTransitionPending { false };
    std::atomic<int> droppedPacketCount { 0 };
    std::atomic<int> bufferHealthAlert { 0 };
    std::atomic<int> streamSampleRate { AudioFifoWorker::targetSampleRate };
    // Broadcast stream transport the listeners must follow (LISTENTO parity: the engineer
    // controls the codec on the plugin, all receivers auto-follow). 0 = raw PCM (data channel),
    // 1 = Opus (WebRTC audio track). The plugin's WebRTC answer stays reactive to the offer's
    // m-lines; this value is the source of truth announced to clients so they offer the right mode.
    std::atomic<int> transportMode { 0 };
    std::atomic<bool> hostTransportPlaying { false };
    std::atomic<juce::int64> hostTransportSamplePosition { 0 };
    std::atomic<juce::int64> streamWriteSamplePosition { 0 };
    std::atomic<int> hostTempoBpmX100 { 12000 };
    std::atomic<juce::int64> hostPpqPositionX1000 { 0 };

private:
   #if JUCE_WINDOWS
    using NativeSocket = SOCKET;
    static constexpr NativeSocket invalidSocket = INVALID_SOCKET;
   #else
    using NativeSocket = int;
    static constexpr NativeSocket invalidSocket = -1;
   #endif

    struct ClientConnection;

   #if JUCE_WINDOWS
    struct WsaSession final
    {
        WsaSession();
        ~WsaSession();

        bool ready = false;
    };
   #endif

    static constexpr juce::int64 heartbeatMs = 10000;
    static constexpr juce::int64 graceHoldMs = 30 * 1000;  // 30 seconds grace for local clients only
    static constexpr std::size_t maxTextFrameBytes = 64 * 1024;
    static constexpr int pcmChunkMs = AudioFifoWorker::chunkDurationMs;
    static constexpr int pcmFramesPerChunk = AudioFifoWorker::framesPerChunk;
    static constexpr int pcmChunkBytes = AudioFifoWorker::bytesPerChunk;
    static constexpr int pcmTelemetryBitrateBitsPerSecond = AudioFifoWorker::telemetryBitrateBitsPerSecond;
    static constexpr int lanOptimisedWebRtcMtuBytes = 1200;
    static constexpr int pcmMaxPacketLifetimeMs = AudioFifoWorker::chunkDurationMs;
    // Drop a PCM chunk only when the data-channel send buffer exceeds this much queued audio.
    // The old ceiling was 10ms (bytesPerChunk*2), which dropped on every minor link stall and
    // punched holes in the stream — the receiver hears those gaps as the periodic click. The
    // receiver now has an adaptive jitter buffer + drift catch-up that ABSORBS this latency; it
    // cannot recover dropped samples. 250ms is well above normal jitter and caps memory/latency
    // below a runaway, so it doubles as the last-resort safety valve.
    static constexpr int pcmDropCeilingMs = 250;

    void run() override;

    NativeSocket createListenerSocket (int portToBind);
    void acceptPendingClient();
    void pumpClients();
    void readFromClient (ClientConnection& client);
    void handleHttpRequest (ClientConnection& client);
    void upgradeToWebSocket (ClientConnection& client, const juce::String& request);
    void parseWebSocketFrames (ClientConnection& client);
    void handleTextFrame (ClientConnection& client, const juce::String& text);
    std::shared_ptr<ClientConnection> findClient (ClientConnection& client);
    void handleWebRtcOffer (const std::shared_ptr<ClientConnection>& client, const juce::DynamicObject& object);
    void handleRemoteIceCandidate (const std::shared_ptr<ClientConnection>& client, const juce::DynamicObject& object);

    void createPeerConnection (const std::shared_ptr<ClientConnection>& client,
                               const juce::String& sdp,
                               int offerGeneration);
    void closePeerConnection (ClientConnection& client);
    void processWebRtcQueue();  // Process queued WebRTC tasks (non-blocking)
    void adaptPacketSize();
    static bool isClientReadyForPcm (const ClientConnection& client) noexcept;

    void pumpPcmOnce();
    void broadcastPcmChunk (const AudioFifoWorker::DynamicPcmChunk& chunk);
    bool trySendPcmChunk (ClientConnection& client, const AudioFifoWorker::DynamicPcmChunk& chunk) noexcept;
    void maybeBroadcastTransportState();
    void maybeBroadcastTransportSync (int chunkFrames);
    void broadcastTransportMode();  // push current transportMode to every websocket client
    void broadcastStreamName();     // push current streamName to every websocket client
    void sendJson (ClientConnection& client, const juce::String& json);
    void sendJson (const std::shared_ptr<ClientConnection>& client, const juce::String& json);
    void sendHttpResponse (ClientConnection& client,
                           const juce::String& contentType,
                           const juce::String& body);
    void sendWebSocketFrame (ClientConnection& client,
                             const std::vector<std::uint8_t>& payload,
                             std::uint8_t opcode);

    static juce::String getHeaderValue (const juce::String& request, const juce::String& header);
    static void setNonBlocking (NativeSocket socketHandle);
    static void closeSocket (NativeSocket& socketHandle);
    static void sendRaw (NativeSocket socketHandle, const void* data, std::size_t byteCount);
    static juce::String createWebSocketAcceptKey (const juce::String& key);
    static juce::String sha1Base64 (const juce::String& input);
    static juce::String jsonString (const juce::var& value);

    void closeAllClients();

    AudioFifoWorker& fifo;
    std::vector<std::shared_ptr<ClientConnection>> clients;
    std::shared_ptr<ClientConnection> externalSignalingClient;
    juce::CriticalSection clientLock;
    juce::CriticalSection externalSignalingLock;
    juce::String streamName { "Kingz Listen" };  // editable broadcast display name (LISTENTO parity)
    mutable juce::CriticalSection streamNameLock;
    std::function<void (const juce::String&)> externalSignalingSender;
    NativeSocket listener = invalidSocket;
    std::atomic<bool> shouldListen { false };
    std::atomic<int> connectedClients { 0 };
    juce::int64 lastPacketAdaptationMs = 0;
    juce::int64 lastTransportSyncMs = 0;
    juce::int64 lastTransportStateBroadcastMs = 0;
    bool lastBroadcastHostPlaying = false;
    std::atomic<juce::int64> streamTransmitSamplePosition { 0 };
    std::atomic<juce::int64> transportSyncSequence { 0 };
    std::atomic<juce::int64> transportStateSequence { 0 };
    int port = 8082;

    // CRITICAL: WebRTC task queue to prevent blocking HTTP server
    struct WebRtcSignalingTask {
        std::shared_ptr<ClientConnection> client;
        juce::String sdp;
        int offerGeneration = 0;
    };
    std::vector<WebRtcSignalingTask> webRtcQueue;
    juce::CriticalSection webRtcQueueLock;

    // Dedicated, higher-priority PCM sender so audio delivery is decoupled from the
    // HTTP/WebSocket/WebRTC-signaling/JSON work on the main network thread. It drains the
    // (lock-free SPSC) FIFO one chunk per ~1ms wake → even cadence, no burst-drain. The
    // main thread no longer calls readPcmChunk, so the SPSC invariant holds (single consumer).
    struct PcmSenderThread final : juce::Thread
    {
        explicit PcmSenderThread (NetworkTransmitter& ownerToUse)
            : juce::Thread ("KingzPcmSender"), owner (ownerToUse) {}
        void run() override;
        NetworkTransmitter& owner;
    };
    std::unique_ptr<PcmSenderThread> pcmSenderThread;

    // Opus audio-track transport (low-latency mode): encode/resample state, lazily created while
    // >=1 client has an open send-only Opus track. Defined out-of-line in the .cpp; touched only on
    // the PcmSenderThread. (NetworkTransmitter's ctor/dtor are out-of-line, so the incomplete type
    // is fine for this member here.)
    struct OpusEncodeState;
    std::unique_ptr<OpusEncodeState> opusEncode;
};
