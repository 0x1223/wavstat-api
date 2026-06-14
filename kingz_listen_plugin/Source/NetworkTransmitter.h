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
    static constexpr std::size_t maxBufferedPcmBytesPerClient = AudioFifoWorker::bytesPerChunk * 2;

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

    void streamReadyPcmChunks();
    void broadcastPcmChunk (const AudioFifoWorker::DynamicPcmChunk& chunk);
    bool trySendPcmChunk (ClientConnection& client, const AudioFifoWorker::DynamicPcmChunk& chunk) noexcept;
    void maybeBroadcastTransportState();
    void maybeBroadcastTransportSync (int chunkFrames);
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
};
