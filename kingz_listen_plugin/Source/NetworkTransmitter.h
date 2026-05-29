#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
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
    ~NetworkTransmitter() override;

    bool start (int portToUse = 8082);
    void stop();

    int getPort() const noexcept;
    int getConnectedClientCount() const noexcept;
    juce::String getLocalLanIpAddress() const;

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
    static constexpr juce::int64 graceHoldMs = 10 * 60 * 1000;
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

    void streamReadyPcmChunks();
    void broadcastPcmChunk (const AudioFifoWorker::PcmChunk& chunk);
    bool trySendPcmChunk (ClientConnection& client, const AudioFifoWorker::PcmChunk& chunk) noexcept;
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
    NativeSocket listener = invalidSocket;
    std::atomic<bool> shouldListen { false };
    std::atomic<int> connectedClients { 0 };
    int port = 8082;
};
