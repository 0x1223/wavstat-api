#include "NetworkTransmitter.h"

#include <algorithm>
#include <array>
#include <cstring>
#include <mutex>
#include <string>

#include <rtc/rtc.hpp>

#if JUCE_WINDOWS
 #include <winsock2.h>
 #include <ws2tcpip.h>
 #include <iphlpapi.h>
#else
 #include <arpa/inet.h>
 #include <fcntl.h>
 #include <ifaddrs.h>
 #include <net/if.h>
 #include <unistd.h>
#endif

static_assert (AudioFifoWorker::targetSampleRate == 48000,
               "Kingz Listen native transmitter must stream 48 kHz PCM without resampling.");
static_assert (AudioFifoWorker::inputChannels == 2,
               "Kingz Listen native transmitter must stream stereo PCM.");
static_assert (AudioFifoWorker::bytesPerChunk == 960,
               "Kingz Listen native transmitter must stream 5 ms chunks of 16-bit stereo PCM.");
static_assert (AudioFifoWorker::maxBytesPerChunk == 3840,
               "Kingz Listen adaptive transmitter supports up to 20 ms PCM chunks.");
static_assert (AudioFifoWorker::telemetryBitrateBitsPerSecond == 1536000,
               "Kingz Listen native transmitter must preserve the 1536 kbps Linear PCM baseline.");

namespace
{
constexpr auto websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
constexpr auto KINGZ_LISTEN_PLUGIN = "KINGZ_LISTEN_PLUGIN";

juce::String base64Encode (const std::array<std::uint8_t, 20>& input)
{
    static constexpr char alphabet[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    juce::String output;

    for (std::size_t i = 0; i < input.size(); i += 3)
    {
        const auto remaining = input.size() - i;
        const auto octetA = input[i];
        const auto octetB = remaining > 1 ? input[i + 1] : 0;
        const auto octetC = remaining > 2 ? input[i + 2] : 0;
        const auto triple = (static_cast<std::uint32_t> (octetA) << 16u)
                          | (static_cast<std::uint32_t> (octetB) << 8u)
                          | static_cast<std::uint32_t> (octetC);

        output << alphabet[(triple >> 18u) & 0x3fu]
               << alphabet[(triple >> 12u) & 0x3fu]
               << (remaining > 1 ? alphabet[(triple >> 6u) & 0x3fu] : '=')
               << (remaining > 2 ? alphabet[triple & 0x3fu] : '=');
    }

    return output;
}

std::array<std::uint8_t, 20> sha1Digest (const juce::String& input)
{
    auto bytes = input.toRawUTF8();
    auto byteCount = static_cast<std::size_t> (input.getNumBytesAsUTF8());

    std::vector<std::uint8_t> data (bytes, bytes + byteCount);
    const auto bitLength = static_cast<std::uint64_t> (data.size()) * 8u;
    data.push_back (0x80);

    while ((data.size() % 64u) != 56u)
        data.push_back (0);

    for (auto shift = 56; shift >= 0; shift -= 8)
        data.push_back (static_cast<std::uint8_t> ((bitLength >> static_cast<unsigned> (shift)) & 0xffu));

    std::uint32_t h0 = 0x67452301u;
    std::uint32_t h1 = 0xefcdab89u;
    std::uint32_t h2 = 0x98badcfeu;
    std::uint32_t h3 = 0x10325476u;
    std::uint32_t h4 = 0xc3d2e1f0u;

    auto rotateLeft = [] (std::uint32_t value, int bits)
    {
        return (value << bits) | (value >> (32 - bits));
    };

    for (std::size_t chunk = 0; chunk < data.size(); chunk += 64)
    {
        std::array<std::uint32_t, 80> w {};

        for (auto i = 0; i < 16; ++i)
        {
            const auto offset = chunk + static_cast<std::size_t> (i * 4);
            w[static_cast<std::size_t> (i)] =
                (static_cast<std::uint32_t> (data[offset]) << 24u)
              | (static_cast<std::uint32_t> (data[offset + 1]) << 16u)
              | (static_cast<std::uint32_t> (data[offset + 2]) << 8u)
              | static_cast<std::uint32_t> (data[offset + 3]);
        }

        for (auto i = 16; i < 80; ++i)
            w[static_cast<std::size_t> (i)] = rotateLeft (w[static_cast<std::size_t> (i - 3)]
                                                        ^ w[static_cast<std::size_t> (i - 8)]
                                                        ^ w[static_cast<std::size_t> (i - 14)]
                                                        ^ w[static_cast<std::size_t> (i - 16)],
                                                        1);

        auto a = h0;
        auto b = h1;
        auto c = h2;
        auto d = h3;
        auto e = h4;

        for (auto i = 0; i < 80; ++i)
        {
            std::uint32_t f = 0;
            std::uint32_t k = 0;

            if (i < 20)
            {
                f = (b & c) | (~b & d);
                k = 0x5a827999u;
            }
            else if (i < 40)
            {
                f = b ^ c ^ d;
                k = 0x6ed9eba1u;
            }
            else if (i < 60)
            {
                f = (b & c) | (b & d) | (c & d);
                k = 0x8f1bbcdcu;
            }
            else
            {
                f = b ^ c ^ d;
                k = 0xca62c1d6u;
            }

            const auto temp = rotateLeft (a, 5) + f + e + k + w[static_cast<std::size_t> (i)];
            e = d;
            d = c;
            c = rotateLeft (b, 30);
            b = a;
            a = temp;
        }

        h0 += a;
        h1 += b;
        h2 += c;
        h3 += d;
        h4 += e;
    }

    std::array<std::uint8_t, 20> digest {};
    const std::array<std::uint32_t, 5> words { h0, h1, h2, h3, h4 };
    for (std::size_t i = 0; i < words.size(); ++i)
    {
        digest[i * 4] = static_cast<std::uint8_t> ((words[i] >> 24u) & 0xffu);
        digest[i * 4 + 1] = static_cast<std::uint8_t> ((words[i] >> 16u) & 0xffu);
        digest[i * 4 + 2] = static_cast<std::uint8_t> ((words[i] >> 8u) & 0xffu);
        digest[i * 4 + 3] = static_cast<std::uint8_t> (words[i] & 0xffu);
    }

    return digest;
}

bool isPrivateLanAddress (const juce::String& address)
{
    return address.startsWith ("10.")
        || address.startsWith ("192.168.")
        || address.startsWith ("172.16.")
        || address.startsWith ("172.17.")
        || address.startsWith ("172.18.")
        || address.startsWith ("172.19.")
        || address.startsWith ("172.20.")
        || address.startsWith ("172.21.")
        || address.startsWith ("172.22.")
        || address.startsWith ("172.23.")
        || address.startsWith ("172.24.")
        || address.startsWith ("172.25.")
        || address.startsWith ("172.26.")
        || address.startsWith ("172.27.")
        || address.startsWith ("172.28.")
        || address.startsWith ("172.29.")
        || address.startsWith ("172.30.")
        || address.startsWith ("172.31.");
}

bool isUsableIpv4Address (const juce::String& address)
{
    return address.isNotEmpty()
        && ! address.startsWith ("127.")
        && ! address.startsWith ("169.254.");
}

std::vector<std::uint8_t> toExactUtf8Bytes (const juce::String& text)
{
    const auto* utf8 = text.toRawUTF8();
    const auto byteCount = std::strlen (utf8);
    return { reinterpret_cast<const std::uint8_t*> (utf8),
             reinterpret_cast<const std::uint8_t*> (utf8) + byteCount };
}

std::size_t exactUtf8ByteCount (const juce::String& text)
{
    return std::strlen (text.toRawUTF8());
}

juce::String withKingzListenSourceId (const juce::String& json)
{
    auto parsed = juce::JSON::parse (json);
    if (auto* object = parsed.getDynamicObject())
    {
        object->setProperty ("source_id", KINGZ_LISTEN_PLUGIN);
        return juce::JSON::toString (parsed, true);
    }

    auto* wrapper = new juce::DynamicObject();
    wrapper->setProperty ("source_id", KINGZ_LISTEN_PLUGIN);
    wrapper->setProperty ("payload", json);
    return juce::JSON::toString (juce::var (wrapper), true);
}
} // namespace

struct NetworkTransmitter::ClientConnection final
{
    explicit ClientConnection (NativeSocket socketIn)
        : socket (socketIn)
    {
    }

    NativeSocket socket = invalidSocket;
    bool websocket = false;
    bool externalSignaling = false;
    std::atomic<bool> closeRequested { false };
    juce::String textBuffer;
    std::vector<std::uint8_t> binaryBuffer;
    juce::int64 lastSeenMs = juce::Time::currentTimeMillis();
    juce::int64 lastPingSentMs = 0;
    juce::int64 graceStartedMs = 0;
    int offerGeneration = 0;
    juce::String signalId;
    std::mutex sendMutex;
    std::shared_ptr<rtc::PeerConnection> peerConnection;
    std::shared_ptr<rtc::DataChannel> pcmChannel;
};

#if JUCE_WINDOWS
NetworkTransmitter::WsaSession::WsaSession()
{
    WSADATA data {};
    ready = WSAStartup (MAKEWORD (2, 2), &data) == 0;
}

NetworkTransmitter::WsaSession::~WsaSession()
{
    if (ready)
        WSACleanup();
}
#endif

NetworkTransmitter::NetworkTransmitter (AudioFifoWorker& fifoToRead)
    : juce::Thread ("Kingz Listen Network Transmitter"),
      fifo (fifoToRead)
{
}

NetworkTransmitter::~NetworkTransmitter()
{
    stop();
}

bool NetworkTransmitter::start (int portToUse)
{
    stop();
    port = portToUse;
    isConnected.store (false, std::memory_order_release);
    activeClientCount.store (0, std::memory_order_release);
    bufferHealth.store (1.0f, std::memory_order_release);
    targetChunkMs.store (AudioFifoWorker::chunkDurationMs, std::memory_order_release);
    chunkSizeTransitionPending.store (false, std::memory_order_release);
    lastPacketAdaptationMs = 0;
    shouldListen.store (true, std::memory_order_release);

    // CRITICAL DEBUGGING
    std::cout << "[KINGZ] NetworkTransmitter::start() - portToUse=" << portToUse << std::endl;

    startThread();

    std::cout << "[KINGZ] NetworkTransmitter::start() - thread started" << std::endl;
    return true;
}

void NetworkTransmitter::stop()
{
    shouldListen.store (false, std::memory_order_release);
    isConnected.store (false, std::memory_order_release);
    activeClientCount.store (0, std::memory_order_release);
    bufferHealth.store (1.0f, std::memory_order_release);
    targetChunkMs.store (AudioFifoWorker::chunkDurationMs, std::memory_order_release);
    chunkSizeTransitionPending.store (false, std::memory_order_release);
    lastPacketAdaptationMs = 0;
    signalThreadShouldExit();
    closeSocket (listener);
    stopThread (2000);
    closeAllClients();
}

int NetworkTransmitter::getPort() const noexcept
{
    return port;
}

int NetworkTransmitter::getConnectedClientCount() const noexcept
{
    return connectedClients.load (std::memory_order_acquire);
}

void NetworkTransmitter::setExternalSignalingSender (std::function<void (const juce::String&)> sender)
{
    const juce::ScopedLock lock { externalSignalingLock };
    externalSignalingSender = std::move (sender);
}

void NetworkTransmitter::handleExternalSignalingMessage (const juce::var& message)
{
    const auto* object = message.getDynamicObject();
    if (object == nullptr)
        return;

    const auto type = object->getProperty ("type").toString();

    std::shared_ptr<ClientConnection> client;
    {
        const juce::ScopedLock lock { clientLock };

        if (externalSignalingClient == nullptr
            || externalSignalingClient->closeRequested.load (std::memory_order_acquire))
        {
            externalSignalingClient = std::make_shared<ClientConnection> (invalidSocket);
            externalSignalingClient->websocket = true;
            externalSignalingClient->externalSignaling = true;
            clients.push_back (externalSignalingClient);
        }

        client = externalSignalingClient;
        client->lastSeenMs = juce::Time::currentTimeMillis();
        client->graceStartedMs = 0;
    }

    if (type == "webrtc-offer")
    {
        handleWebRtcOffer (client, *object);
        return;
    }

    if (type == "webrtc-candidate")
        handleRemoteIceCandidate (client, *object);
}

juce::String NetworkTransmitter::getLocalLanIpAddress() const
{
   #if JUCE_WINDOWS
    ULONG bufferLength = 15 * 1024;
    std::vector<std::uint8_t> buffer (bufferLength);
    auto* addresses = reinterpret_cast<IP_ADAPTER_ADDRESSES*> (buffer.data());

    const auto result = GetAdaptersAddresses (AF_INET,
                                              GAA_FLAG_SKIP_ANYCAST
                                                  | GAA_FLAG_SKIP_MULTICAST
                                                  | GAA_FLAG_SKIP_DNS_SERVER,
                                              nullptr,
                                              addresses,
                                              &bufferLength);
    if (result != NO_ERROR)
        return "127.0.0.1";

    juce::String fallback;
    for (auto* adapter = addresses; adapter != nullptr; adapter = adapter->Next)
    {
        if (adapter->OperStatus != IfOperStatusUp)
            continue;

        for (auto* unicast = adapter->FirstUnicastAddress; unicast != nullptr; unicast = unicast->Next)
        {
            if (unicast->Address.lpSockaddr == nullptr
                || unicast->Address.lpSockaddr->sa_family != AF_INET)
                continue;

            char addressBuffer[INET_ADDRSTRLEN] {};
            const auto* sockaddr = reinterpret_cast<sockaddr_in*> (unicast->Address.lpSockaddr);
            if (inet_ntop (AF_INET, &sockaddr->sin_addr, addressBuffer, sizeof (addressBuffer)) == nullptr)
                continue;

            const juce::String address { addressBuffer };
            if (! isUsableIpv4Address (address))
                continue;

            if (isPrivateLanAddress (address))
                return address;

            if (fallback.isEmpty())
                fallback = address;
        }
    }

    return fallback.isNotEmpty() ? fallback : juce::String { "127.0.0.1" };
   #else
    ifaddrs* interfaces = nullptr;
    if (getifaddrs (&interfaces) != 0 || interfaces == nullptr)
        return "127.0.0.1";

    juce::String fallback;
    for (auto* item = interfaces; item != nullptr; item = item->ifa_next)
    {
        if (item->ifa_addr == nullptr || item->ifa_addr->sa_family != AF_INET)
            continue;

        const auto flags = item->ifa_flags;
        if ((flags & IFF_UP) == 0 || (flags & IFF_LOOPBACK) != 0)
            continue;

        char addressBuffer[INET_ADDRSTRLEN] {};
        const auto* sockaddr = reinterpret_cast<sockaddr_in*> (item->ifa_addr);
        if (inet_ntop (AF_INET, &sockaddr->sin_addr, addressBuffer, sizeof (addressBuffer)) == nullptr)
            continue;

        const juce::String address { addressBuffer };
        if (! isUsableIpv4Address (address))
            continue;

        if (isPrivateLanAddress (address))
        {
            freeifaddrs (interfaces);
            return address;
        }

        if (fallback.isEmpty())
            fallback = address;
    }

    freeifaddrs (interfaces);
    return fallback.isNotEmpty() ? fallback : juce::String { "127.0.0.1" };
   #endif
}

void NetworkTransmitter::run()
{
   #if JUCE_WINDOWS
    WsaSession wsa;
    if (! wsa.ready)
        return;
   #endif

    // CRITICAL DEBUGGING
    std::cout << "[KINGZ] NetworkTransmitter::run() STARTED - port=" << port << std::endl;

    listener = port > 0 ? createListenerSocket (port) : invalidSocket;

    std::cout << "[KINGZ] NetworkTransmitter::run() - createListenerSocket returned: " << (listener != invalidSocket ? "SUCCESS" : "FAILED") << std::endl;

    if (port > 0 && listener == invalidSocket)
        DBG ("NetworkTransmitter::run continuing without local signaling listener");
    else if (port <= 0)
        DBG ("NetworkTransmitter::run using external WebSocket signaling only");

    while (! threadShouldExit() && shouldListen.load (std::memory_order_acquire))
    {
        acceptPendingClient();
        pumpClients();
        streamReadyPcmChunks();
        wait (2);
    }

    closeSocket (listener);
    closeAllClients();
}

NetworkTransmitter::NativeSocket NetworkTransmitter::createListenerSocket (int portToBind)
{
    auto socketHandle = ::socket (AF_INET, SOCK_STREAM, 0);
    if (socketHandle == invalidSocket)
        return invalidSocket;

    const int reuse = 1;
   #if JUCE_WINDOWS
    setsockopt (socketHandle, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*> (&reuse), sizeof (reuse));
   #else
    setsockopt (socketHandle, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof (reuse));
   #endif

    sockaddr_in address {};
    address.sin_family = AF_INET;
    address.sin_port = htons (static_cast<std::uint16_t> (portToBind));
    address.sin_addr.s_addr = htonl (INADDR_ANY);

    if (::bind (socketHandle, reinterpret_cast<sockaddr*> (&address), sizeof (address)) != 0
        || ::listen (socketHandle, 8) != 0)
    {
        closeSocket (socketHandle);
        return invalidSocket;
    }

    setNonBlocking (socketHandle);
    return socketHandle;
}

void NetworkTransmitter::acceptPendingClient()
{
    if (listener == invalidSocket)
        return;

    for (;;)
    {
        sockaddr_in clientAddress {};
       #if JUCE_WINDOWS
        int addressLength = sizeof (clientAddress);
       #else
        socklen_t addressLength = sizeof (clientAddress);
       #endif
        auto socketHandle = ::accept (listener,
                                      reinterpret_cast<sockaddr*> (&clientAddress),
                                      &addressLength);

        if (socketHandle == invalidSocket)
            return;

        setNonBlocking (socketHandle);
        const juce::ScopedLock lock { clientLock };
        clients.push_back (std::make_shared<ClientConnection> (socketHandle));
        connectedClients.store (static_cast<int> (clients.size()), std::memory_order_release);
        // Do NOT increment activeClientCount here - wait until RTCDataChannel is open
    }
}

void NetworkTransmitter::pumpClients()
{
    const auto now = juce::Time::currentTimeMillis();
    const juce::ScopedLock lock { clientLock };

    for (auto& client : clients)
    {
        if (! client->externalSignaling)
            readFromClient (*client);

        if (client->websocket && ! client->externalSignaling && now - client->lastPingSentMs >= heartbeatMs)
        {
            sendWebSocketFrame (*client, {}, 0x9);
            client->lastPingSentMs = now;
        }

        // Start grace period for LOCAL clients if no heartbeat (external clients exempt - they negotiate async)
        if (client->websocket
            && ! client->externalSignaling  // External clients don't send continuous messages during negotiation
            && now - client->lastSeenMs > heartbeatMs
            && client->graceStartedMs == 0)
            client->graceStartedMs = now;

        // Close client if grace period exceeded
        if (client->graceStartedMs > 0 && now - client->graceStartedMs > graceHoldMs)
            client->closeRequested.store (true, std::memory_order_release);
    }

    clients.erase (std::remove_if (clients.begin(),
                                   clients.end(),
                                   [this] (const std::shared_ptr<ClientConnection>& client)
                                   {
                                       if (! client->closeRequested.load (std::memory_order_acquire))
                                           return false;

                                       closePeerConnection (*client);
                                       closeSocket (client->socket);
                                       if (client == externalSignalingClient)
                                           externalSignalingClient.reset();
                                       return true;
                                   }),
                   clients.end());
    connectedClients.store (static_cast<int> (clients.size()), std::memory_order_release);

    // Only count clients with open PCM channels as active (not still negotiating)
    const auto activeCount = static_cast<int> (std::count_if (clients.begin(),
                                                             clients.end(),
                                                             [] (const std::shared_ptr<ClientConnection>& client)
                                                             {
                                                                 return isClientReadyForPcm (*client);
                                                             }));
    activeClientCount.store (activeCount, std::memory_order_release);
    isConnected.store (activeCount > 0, std::memory_order_release);
    adaptPacketSize();
}

void NetworkTransmitter::readFromClient (ClientConnection& client)
{
    std::array<char, 4096> scratch {};

    for (;;)
    {
       #if JUCE_WINDOWS
        const auto bytesRead = ::recv (client.socket, scratch.data(), static_cast<int> (scratch.size()), 0);
       #else
        const auto bytesRead = ::recv (client.socket, scratch.data(), scratch.size(), 0);
       #endif

        if (bytesRead == 0)
        {
            client.closeRequested.store (true, std::memory_order_release);
            return;
        }

        if (bytesRead < 0)
            return;

        client.lastSeenMs = juce::Time::currentTimeMillis();
        client.graceStartedMs = 0;

        if (client.websocket)
        {
            client.binaryBuffer.insert (client.binaryBuffer.end(),
                                        scratch.begin(),
                                        scratch.begin() + bytesRead);
            parseWebSocketFrames (client);
        }
        else
        {
            client.textBuffer += juce::String::fromUTF8 (scratch.data(), static_cast<int> (bytesRead));
            if (client.textBuffer.contains ("\r\n\r\n"))
                handleHttpRequest (client);
        }
    }
}

void NetworkTransmitter::handleHttpRequest (ClientConnection& client)
{
    const auto request = client.textBuffer;

    if (request.containsIgnoreCase ("upgrade: websocket"))
    {
        upgradeToWebSocket (client, request);
        return;
    }

    if (request.startsWithIgnoreCase ("GET /health "))
    {
        sendHttpResponse (client, "application/json", R"JSON({"ok":true,"service":"KINGZ_LISTEN_PLUGIN"})JSON");
        client.closeRequested.store (true, std::memory_order_release);
        return;
    }

    if (request.startsWithIgnoreCase ("GET /metadata "))
    {
        const auto currentChunkMs = targetChunkMs.load (std::memory_order_acquire);
        auto* realtime = new juce::DynamicObject();
        realtime->setProperty ("transport", "native-plugin-libdatachannel-pcm");
        realtime->setProperty ("chunkMs", currentChunkMs);
        realtime->setProperty ("framesPerChunk", AudioFifoWorker::framesForChunkMs (currentChunkMs));
        realtime->setProperty ("sampleRate", AudioFifoWorker::targetSampleRate);
        realtime->setProperty ("channels", AudioFifoWorker::inputChannels);
        realtime->setProperty ("bitDepth", 16);
        realtime->setProperty ("bytesPerChunk", static_cast<int> (AudioFifoWorker::bytesForChunkMs (currentChunkMs)));
        realtime->setProperty ("bitrate", pcmTelemetryBitrateBitsPerSecond);
        realtime->setProperty ("ordered", false);
        realtime->setProperty ("maxRetransmits", juce::var());
        realtime->setProperty ("maxPacketLifeTimeMs", pcmMaxPacketLifetimeMs);
        realtime->setProperty ("dropWhenBufferedBytesExceed",
                               static_cast<int> (AudioFifoWorker::bytesForChunkMs (currentChunkMs) * 2));
        realtime->setProperty ("adaptiveChunkSizing", true);
        realtime->setProperty ("minChunkMs", AudioFifoWorker::minChunkDurationMs);
        realtime->setProperty ("maxChunkMs", AudioFifoWorker::maxChunkDurationMs);
        realtime->setProperty ("udpOnly", true);
        realtime->setProperty ("jitterBuffer", "bypassed-data-channel");
        realtime->setProperty ("signalProcessing", "disabled-raw-pcm");
        realtime->setProperty ("webrtcMtuBytes", lanOptimisedWebRtcMtuBytes);

        auto* metadata = new juce::DynamicObject();
        metadata->setProperty ("source_id", KINGZ_LISTEN_PLUGIN);
        metadata->setProperty ("realtime", juce::var (realtime));
        sendHttpResponse (client, "application/json", jsonString (juce::var (metadata)));
        client.closeRequested.store (true, std::memory_order_release);
        return;
    }

    sendHttpResponse (client, "text/plain", "Kingz Listen native transmitter");
    client.closeRequested.store (true, std::memory_order_release);
}

void NetworkTransmitter::upgradeToWebSocket (ClientConnection& client, const juce::String& request)
{
    const auto key = getHeaderValue (request, "Sec-WebSocket-Key");
    if (key.isEmpty())
    {
        client.closeRequested.store (true, std::memory_order_release);
        return;
    }

    const auto accept = createWebSocketAcceptKey (key);
    const auto response =
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";

    sendRaw (client.socket, response.toRawUTF8(), exactUtf8ByteCount (response));
    client.websocket = true;
    client.textBuffer.clear();
}

juce::String NetworkTransmitter::getHeaderValue (const juce::String& request, const juce::String& header)
{
    juce::StringArray lines;
    lines.addLines (request);

    for (auto line : lines)
    {
        if (line.startsWithIgnoreCase (header + ":"))
            return line.fromFirstOccurrenceOf (":", false, false).trim();
    }

    return {};
}

void NetworkTransmitter::parseWebSocketFrames (ClientConnection& client)
{
    for (;;)
    {
        if (client.binaryBuffer.size() < 2)
            return;

        const auto first = client.binaryBuffer[0];
        const auto second = client.binaryBuffer[1];
        const auto opcode = first & 0x0fu;
        const auto masked = (second & 0x80u) != 0;
        std::uint64_t payloadLength = second & 0x7fu;
        std::size_t headerSize = 2;

        if (payloadLength == 126)
        {
            if (client.binaryBuffer.size() < 4)
                return;

            payloadLength = (static_cast<std::uint64_t> (client.binaryBuffer[2]) << 8u)
                          | static_cast<std::uint64_t> (client.binaryBuffer[3]);
            headerSize = 4;
        }
        else if (payloadLength == 127)
        {
            client.closeRequested.store (true, std::memory_order_release);
            return;
        }

        if (masked)
            headerSize += 4;

        if (payloadLength > maxTextFrameBytes
            || client.binaryBuffer.size() < headerSize + static_cast<std::size_t> (payloadLength))
            return;

        std::array<std::uint8_t, 4> mask {};
        if (masked)
            std::memcpy (mask.data(), client.binaryBuffer.data() + headerSize - 4, mask.size());

        std::vector<std::uint8_t> payload (static_cast<std::size_t> (payloadLength));
        for (std::size_t i = 0; i < payload.size(); ++i)
        {
            auto byte = client.binaryBuffer[headerSize + i];
            if (masked)
                byte ^= mask[i % 4];
            payload[i] = byte;
        }

        client.binaryBuffer.erase (client.binaryBuffer.begin(),
                                   client.binaryBuffer.begin()
                                       + static_cast<std::ptrdiff_t> (headerSize + payload.size()));

        if (opcode == 0x1)
            handleTextFrame (client, juce::String::fromUTF8 (reinterpret_cast<const char*> (payload.data()),
                                                             static_cast<int> (payload.size())));
        else if (opcode == 0x8)
            client.closeRequested.store (true, std::memory_order_release);
        else if (opcode == 0x9)
            sendWebSocketFrame (client, payload, 0xau);
        else if (opcode == 0xau)
            client.lastSeenMs = juce::Time::currentTimeMillis();
    }
}

void NetworkTransmitter::handleTextFrame (ClientConnection& client, const juce::String& text)
{
    const auto parsed = juce::JSON::parse (text);
    const auto* object = parsed.getDynamicObject();
    if (object == nullptr)
        return;

    const auto type = object->getProperty ("type").toString();
    if (type == "client.ping")
    {
        sendJson (client, R"JSON({"type":"pong"})JSON");
        return;
    }

    if (type == "webrtc.pong")
    {
        client.lastSeenMs = juce::Time::currentTimeMillis();
        client.graceStartedMs = 0;
        return;
    }

    if (type == "webrtc.offer")
    {
        if (auto clientPtr = findClient (client))
            handleWebRtcOffer (clientPtr, *object);
        return;
    }

    if (type == "webrtc.ice-candidate")
    {
        if (auto clientPtr = findClient (client))
            handleRemoteIceCandidate (clientPtr, *object);
        return;
    }

    if (type == "webrtc.stop")
    {
        closePeerConnection (client);
        client.closeRequested.store (true, std::memory_order_release);
    }
}

std::shared_ptr<NetworkTransmitter::ClientConnection> NetworkTransmitter::findClient (ClientConnection& client)
{
    const juce::ScopedLock lock { clientLock };
    const auto iter = std::find_if (clients.begin(),
                                    clients.end(),
                                    [&client] (const std::shared_ptr<ClientConnection>& candidate)
                                    {
                                        return candidate.get() == &client;
                                    });

    return iter != clients.end() ? *iter : nullptr;
}

void NetworkTransmitter::handleWebRtcOffer (const std::shared_ptr<ClientConnection>& client,
                                            const juce::DynamicObject& object)
{
    const auto offerGeneration = static_cast<int> (object.getProperty ("offerGeneration"));
    client->signalId = object.getProperty ("signal_id").toString();
    auto sdp = object.getProperty ("sdp").toString();

    if (sdp.isEmpty())
    {
        const auto description = object.getProperty ("description");
        if (const auto* descriptionObject = description.getDynamicObject())
            sdp = descriptionObject->getProperty ("sdp").toString();
    }

    if (sdp.isEmpty())
    {
        auto* response = new juce::DynamicObject();
        response->setProperty ("type", "webrtc.error");
        response->setProperty ("message", "missing_remote_sdp");
        response->setProperty ("offerGeneration", offerGeneration);
        sendJson (client, jsonString (juce::var (response)));
        return;
    }

    createPeerConnection (client, sdp, offerGeneration);
}

void NetworkTransmitter::handleRemoteIceCandidate (const std::shared_ptr<ClientConnection>& client,
                                                   const juce::DynamicObject& object)
{
    if (client == nullptr || client->peerConnection == nullptr)
        return;

    if (! object.getProperty ("offerGeneration").isVoid())
    {
        const auto generation = static_cast<int> (object.getProperty ("offerGeneration"));
        if (generation != client->offerGeneration)
            return;
    }

    const auto signalId = object.getProperty ("signal_id").toString();
    if (signalId.isNotEmpty())
        client->signalId = signalId;

    auto candidateValue = object.getProperty ("candidate");
    juce::String candidate;
    juce::String mid;

    if (const auto* candidateObject = candidateValue.getDynamicObject())
    {
        candidate = candidateObject->getProperty ("candidate").toString();
        mid = candidateObject->getProperty ("sdpMid").toString();
    }
    else
    {
        candidate = candidateValue.toString();
        mid = object.getProperty ("sdpMid").toString();
    }

    if (candidate.isEmpty())
        return;

    try
    {
        client->peerConnection->addRemoteCandidate (rtc::Candidate (candidate.toStdString(), mid.toStdString()));
    }
    catch (const std::exception& error)
    {
        auto* response = new juce::DynamicObject();
        response->setProperty ("type", "webrtc.error");
        response->setProperty ("message", "remote_ice_rejected");
        response->setProperty ("detail", error.what());
        response->setProperty ("offerGeneration", client->offerGeneration);
        sendJson (client, jsonString (juce::var (response)));
    }
}

void NetworkTransmitter::createPeerConnection (const std::shared_ptr<ClientConnection>& client,
                                               const juce::String& sdp,
                                               int offerGeneration)
{
    if (client == nullptr)
        return;

    closePeerConnection (*client);
    client->offerGeneration = offerGeneration;

    rtc::Configuration configuration;
    configuration.enableIceTcp = false;
    configuration.disableAutoNegotiation = false;
    configuration.disableAutoGathering = false;
    configuration.mtu = static_cast<std::size_t> (lanOptimisedWebRtcMtuBytes);

    auto peer = std::make_shared<rtc::PeerConnection> (configuration);
    const auto weakClient = std::weak_ptr<ClientConnection> (client);

    peer->onLocalDescription ([this, weakClient, offerGeneration] (rtc::Description description)
    {
        if (auto lockedClient = weakClient.lock())
        {
            // CRITICAL DEBUGGING: Log answer SDP to diagnose m-line mismatch
            const auto answerSdp = std::string (description);
            const auto answerStr = juce::String (answerSdp);
            const auto answerLines = juce::StringArray::fromLines (answerStr);
            int mLineCount = 0;
            juce::String mLineTypes;
            for (const auto& line : answerLines)
            {
                if (line.startsWith ("m="))
                {
                    mLineCount++;
                    const auto tokens = juce::StringArray::fromTokens (line, " ", "");
                    if (tokens.size() > 0)
                        mLineTypes += (mLineCount > 1 ? "," : "") + tokens[0].substring (2);
                }
            }
            DBG ("[KINGZ] === JUCE ANSWER SDP ===");
            DBG ("[KINGZ] M-line count: " + juce::String (mLineCount) + ", types: " + mLineTypes);
            for (const auto& line : answerLines)
            {
                if (line.startsWith ("m=") || line.startsWith ("a=setup"))
                    DBG ("[KINGZ] ANSWER: " + line);
            }
            DBG ("[KINGZ] === END ANSWER SDP ===");

            auto* response = new juce::DynamicObject();
            response->setProperty ("type", lockedClient->externalSignaling ? "webrtc-answer" : "webrtc.answer");
            response->setProperty ("sdp", juce::String (answerSdp));
            response->setProperty ("descriptionType", juce::String (description.typeString()));
            response->setProperty ("offerGeneration", offerGeneration);
            if (lockedClient->signalId.isNotEmpty())
                response->setProperty ("signal_id", lockedClient->signalId);
            sendJson (lockedClient, jsonString (juce::var (response)));
        }
    });

    peer->onLocalCandidate ([this, weakClient, offerGeneration] (rtc::Candidate candidate)
    {
        if (auto lockedClient = weakClient.lock())
        {
            auto* candidateObject = new juce::DynamicObject();
            candidateObject->setProperty ("candidate", juce::String (std::string (candidate)));
            candidateObject->setProperty ("sdpMid", juce::String (candidate.mid()));

            auto* response = new juce::DynamicObject();
            response->setProperty ("type", lockedClient->externalSignaling ? "webrtc-candidate" : "webrtc.ice-candidate");
            response->setProperty ("candidate", juce::var (candidateObject));
            response->setProperty ("offerGeneration", offerGeneration);
            if (lockedClient->signalId.isNotEmpty())
                response->setProperty ("signal_id", lockedClient->signalId);
            sendJson (lockedClient, jsonString (juce::var (response)));
        }
    });

    peer->onStateChange ([this, weakClient] (rtc::PeerConnection::State state)
    {
        if (auto lockedClient = weakClient.lock())
        {
            auto* response = new juce::DynamicObject();
            response->setProperty ("type", "webrtc.state");
            response->setProperty ("state", static_cast<int> (state));
            response->setProperty ("offerGeneration", lockedClient->offerGeneration);
            sendJson (lockedClient, jsonString (juce::var (response)));
        }
    });

    client->peerConnection = peer;

    try
    {
        // CRITICAL DEBUGGING: Log incoming offer SDP to diagnose m-line mismatch
        const auto offerLines = juce::StringArray::fromLines (sdp);
        int offerMLineCount = 0;
        juce::String offerMLineTypes;
        for (const auto& line : offerLines)
        {
            if (line.startsWith ("m="))
            {
                offerMLineCount++;
                const auto tokens = juce::StringArray::fromTokens (line, " ", "");
                if (tokens.size() > 0)
                    offerMLineTypes += (offerMLineCount > 1 ? "," : "") + tokens[0].substring (2);
            }
        }
        DBG ("[KINGZ] === RECEIVED OFFER SDP ===");
        DBG ("[KINGZ] M-line count: " + juce::String (offerMLineCount) + ", types: " + offerMLineTypes);
        for (const auto& line : offerLines)
        {
            if (line.startsWith ("m=") || line.startsWith ("a=setup"))
                DBG ("[KINGZ] OFFER: " + line);
        }
        DBG ("[KINGZ] === END OFFER SDP ===");

        peer->setRemoteDescription (rtc::Description (sdp.toStdString(), "offer"));

        // CRITICAL: Create data channel AFTER setRemoteDescription so answer m-lines
        // match the offer's m-line order. If the offer is audio-only (Flutter native),
        // the answer must also be audio-only. Only create data channel if both sides
        // support it via the negotiation.
        rtc::DataChannelInit pcmChannelConfig;
        pcmChannelConfig.reliability.unordered = true;
        pcmChannelConfig.reliability.maxPacketLifeTime = std::chrono::milliseconds { pcmMaxPacketLifetimeMs };
        pcmChannelConfig.protocol = "audio/L16;rate=48000;channels=2;ptime=5-20;processing=off;adaptive=true";

        auto dataChannel = peer->createDataChannel ("kingz-pcm", pcmChannelConfig);
        dataChannel->setBufferedAmountLowThreshold (pcmChunkBytes);
        dataChannel->onOpen ([this, weakClient]
        {
            if (auto lockedClient = weakClient.lock())
            {
                const auto currentChunkMs = targetChunkMs.load (std::memory_order_acquire);
                auto* response = new juce::DynamicObject();
                response->setProperty ("type", "webrtc.data-channel-open");
                response->setProperty ("label", "kingz-pcm");
                response->setProperty ("format", "pcm_s16le");
                response->setProperty ("sampleRate", AudioFifoWorker::targetSampleRate);
                response->setProperty ("channels", AudioFifoWorker::inputChannels);
                response->setProperty ("chunkMs", currentChunkMs);
                response->setProperty ("framesPerChunk", AudioFifoWorker::framesForChunkMs (currentChunkMs));
                response->setProperty ("bytesPerChunk", static_cast<int> (AudioFifoWorker::bytesForChunkMs (currentChunkMs)));
                response->setProperty ("bitrate", pcmTelemetryBitrateBitsPerSecond);
                response->setProperty ("ordered", false);
                response->setProperty ("maxRetransmits", juce::var());
                response->setProperty ("maxPacketLifeTimeMs", pcmMaxPacketLifetimeMs);
                response->setProperty ("dropWhenBufferedBytesExceed",
                                      static_cast<int> (AudioFifoWorker::bytesForChunkMs (currentChunkMs) * 2));
                response->setProperty ("adaptiveChunkSizing", true);
                response->setProperty ("minChunkMs", AudioFifoWorker::minChunkDurationMs);
                response->setProperty ("maxChunkMs", AudioFifoWorker::maxChunkDurationMs);
                response->setProperty ("udpOnly", true);
                response->setProperty ("jitterBuffer", "bypassed-data-channel");
                response->setProperty ("signalProcessing", "disabled-raw-pcm");
                response->setProperty ("webrtcMtuBytes", lanOptimisedWebRtcMtuBytes);
                sendJson (lockedClient, jsonString (juce::var (response)));
            }
        });

        client->pcmChannel = dataChannel;

        peer->setLocalDescription();
    }
    catch (const std::exception& error)
    {
        auto* response = new juce::DynamicObject();
        response->setProperty ("type", "webrtc.error");
        response->setProperty ("message", "peer_connection_offer_failed");
        response->setProperty ("detail", error.what());
        response->setProperty ("offerGeneration", offerGeneration);
        sendJson (client, jsonString (juce::var (response)));
        closePeerConnection (*client);
    }
}

void NetworkTransmitter::closePeerConnection (ClientConnection& client)
{
    if (client.pcmChannel != nullptr)
    {
        try
        {
            client.pcmChannel->close();
        }
        catch (const std::exception&)
        {
        }

        client.pcmChannel.reset();
    }

    if (client.peerConnection != nullptr)
    {
        try
        {
            client.peerConnection->close();
        }
        catch (const std::exception&)
        {
        }

        client.peerConnection.reset();
    }
}

void NetworkTransmitter::adaptPacketSize()
{
    const auto nowMs = juce::Time::currentTimeMillis();
    if (nowMs - lastPacketAdaptationMs < 500)
        return;

    lastPacketAdaptationMs = nowMs;

    if (! isConnected.load (std::memory_order_acquire))
        return;

    const auto health = bufferHealth.load (std::memory_order_acquire);
    const auto currentChunkMs = AudioFifoWorker::normaliseChunkMs (
        targetChunkMs.load (std::memory_order_acquire));

    const auto bufferedRatio = juce::jlimit (0.0f, 1.0f, 1.0f - health);
    const auto estimatedLatencyMs = static_cast<float> (currentChunkMs)
        + bufferedRatio * static_cast<float> (currentChunkMs * 2);

    auto nextChunkMs = currentChunkMs;

    if (estimatedLatencyMs > 15.0f || health < 0.7f)
        nextChunkMs = juce::jmin (AudioFifoWorker::maxChunkDurationMs,
                                  currentChunkMs + AudioFifoWorker::chunkDurationStepMs);
    else if (estimatedLatencyMs < 10.0f && health > 0.9f)
        nextChunkMs = juce::jmax (AudioFifoWorker::minChunkDurationMs,
                                  currentChunkMs - AudioFifoWorker::chunkDurationStepMs);

    if (nextChunkMs != currentChunkMs)
    {
        targetChunkMs.store (nextChunkMs, std::memory_order_release);
        chunkSizeTransitionPending.store (true, std::memory_order_release);
    }
}

void NetworkTransmitter::streamReadyPcmChunks()
{
    AudioFifoWorker::DynamicPcmChunk chunk {};
    while (fifo.readPcmChunk (chunk, targetChunkMs))
        broadcastPcmChunk (chunk);
}

void NetworkTransmitter::broadcastPcmChunk (const AudioFifoWorker::DynamicPcmChunk& chunk)
{
    const juce::ScopedLock lock { clientLock };

    auto openPcmClientCount = 0;
    auto worstBufferedBytes = std::size_t { 0 };
    auto criticalClientsCount = 0;

    for (auto& client : clients)
    {
        if (client == nullptr)
            continue;

        // Only include clients with open channels in health calculation (exclude still-negotiating clients)
        if (auto channel = client->pcmChannel; channel != nullptr && channel->isOpen())
        {
            ++openPcmClientCount;
            const auto clientBuffered = channel->bufferedAmount();
            worstBufferedBytes = std::max (worstBufferedBytes, clientBuffered);

            // Count clients in critical state (>10ms buffered)
            if (clientBuffered > chunk.byteCount * 2)
                ++criticalClientsCount;
        }

        trySendPcmChunk (*client, chunk);
    }

    // If no clients have open PCM channels yet, health is perfect
    if (openPcmClientCount == 0)
    {
        bufferHealth.store (1.0f, std::memory_order_release);
        return;
    }

    // Health = 1.0 - (ratio of buffer used on worst client)
    // This excludes clients still in WebRTC negotiation
    const auto maxBufferedBytes = chunk.byteCount * 2;
    const auto ratio = static_cast<float> (worstBufferedBytes)
        / static_cast<float> (maxBufferedBytes);

    const auto health = juce::jlimit (0.0f, 1.0f, 1.0f - ratio);
    bufferHealth.store (health, std::memory_order_release);

    // Log when health degrades below 80% (critical threshold)
    if (health < 0.8f && health > 0.0f)
    {
        static auto lastLogTimeMs = juce::Time::getCurrentTime().toMilliseconds();
        const auto nowMs = juce::Time::getCurrentTime().toMilliseconds();

        // Rate-limit logging to once per second to avoid spam
        if (nowMs - lastLogTimeMs > 1000)
        {
            lastLogTimeMs = nowMs;
            const auto healthPercent = static_cast<int> (health * 100.0f);
            juce::Logger::writeToLog (
                juce::String ("BUFFER_HEALTH_WARN: health=") + juce::String (healthPercent) + "%"
                + " worstClient=" + juce::String (static_cast<int> (worstBufferedBytes)) + "B"
                + " clients=" + juce::String (openPcmClientCount)
                + " critical=" + juce::String (criticalClientsCount)
                + " dropped=" + juce::String (droppedPacketCount.load (std::memory_order_acquire))
            );
        }
    }

    chunkSizeTransitionPending.store (false, std::memory_order_release);
}

bool NetworkTransmitter::trySendPcmChunk (ClientConnection& client,
                                          const AudioFifoWorker::DynamicPcmChunk& chunk) noexcept
{
    if (! client.websocket || client.closeRequested.load (std::memory_order_acquire))
        return false;

    auto channel = client.pcmChannel;
    if (channel == nullptr || ! channel->isOpen())
        return false;

    const auto bufferedAmount = channel->bufferedAmount();
    const auto targetLatencyBytes = chunk.byteCount;      // 1 chunk = 5ms
    const auto maxQueueBytes = chunk.byteCount * 2;       // 10ms ceiling
    const auto criticalThresholdBytes = chunk.byteCount * 3;  // 15ms = alert

    // AGGRESSIVE DROP LOGIC: if buffer exceeds 10ms ceiling, we've hit TCP backpressure
    if (bufferedAmount > maxQueueBytes)
    {
        // TCP is backed up — prefer a click over accumulated latency
        // This signals to the client that network jitter is causing dropout
        // Log to JUCE console for debugging
        if (bufferHealthAlert.load (std::memory_order_acquire) == 0)
        {
            juce::Logger::writeToLog (
                juce::String ("TCP_BACKPRESSURE: buffered=") + juce::String (bufferedAmount)
                + " bytes maxQueue=" + juce::String (maxQueueBytes)
                + " chunk=" + juce::String (chunk.byteCount)
                + " dropCount=" + juce::String (droppedPacketCount.load (std::memory_order_acquire))
            );
            bufferHealthAlert.store (1, std::memory_order_release);
        }
        droppedPacketCount.fetch_add (1, std::memory_order_relaxed);
        return false;  // Skip this packet — client will resync to live edge
    }

    // Clear alert if buffer is now healthy
    if (bufferedAmount < targetLatencyBytes && bufferHealthAlert.load (std::memory_order_acquire) != 0)
    {
        juce::Logger::writeToLog (
            juce::String ("TCP_BACKPRESSURE_RECOVERED: buffered=") + juce::String (bufferedAmount)
            + " bytes normalcy restored"
        );
        bufferHealthAlert.store (0, std::memory_order_release);
    }

    // Critical alert if approaching 15ms — network is under stress
    if (bufferedAmount > criticalThresholdBytes)
    {
        juce::Logger::writeToLog (
            juce::String ("TCP_ALERT_CRITICAL: buffered=") + juce::String (bufferedAmount)
            + " bytes (15ms+) dropCount=" + juce::String (droppedPacketCount.load (std::memory_order_acquire))
        );
    }

    // Standard backpressure: don't queue if we're already at 10ms
    if (bufferedAmount > chunk.byteCount * 2)
        return false;

    try
    {
        return channel->send (reinterpret_cast<const rtc::byte*> (chunk.bytes.data()), chunk.byteCount);
    }
    catch (const std::exception&)
    {
        return false;
    }
}

bool NetworkTransmitter::isClientReadyForPcm (const ClientConnection& client) noexcept
{
    // Client is ready for PCM if:
    // 1. Not closed
    // 2. Has an open PCM data channel
    if (client.closeRequested.load (std::memory_order_acquire))
        return false;

    auto channel = client.pcmChannel;
    return channel != nullptr && channel->isOpen();
}

void NetworkTransmitter::sendJson (ClientConnection& client, const juce::String& json)
{
    const auto payload = toExactUtf8Bytes (withKingzListenSourceId (json));

    if (client.externalSignaling)
    {
        std::function<void (const juce::String&)> sender;
        {
            const juce::ScopedLock lock { externalSignalingLock };
            sender = externalSignalingSender;
        }

        if (sender != nullptr)
            sender (juce::String::fromUTF8 (reinterpret_cast<const char*> (payload.data()),
                                            static_cast<int> (payload.size())));
        return;
    }

    sendWebSocketFrame (client, payload, 0x1);
}

void NetworkTransmitter::sendJson (const std::shared_ptr<ClientConnection>& client, const juce::String& json)
{
    if (client != nullptr && client->websocket && ! client->closeRequested.load (std::memory_order_acquire))
        sendJson (*client, json);
}

void NetworkTransmitter::sendHttpResponse (ClientConnection& client,
                                           const juce::String& contentType,
                                           const juce::String& body)
{
    const auto response = "HTTP/1.1 200 OK\r\nContent-Type: " + contentType
        + "\r\nContent-Length: " + juce::String (exactUtf8ByteCount (body))
        + "\r\nConnection: close\r\n\r\n" + body;
    sendRaw (client.socket, response.toRawUTF8(), exactUtf8ByteCount (response));
}

void NetworkTransmitter::sendWebSocketFrame (ClientConnection& client,
                                             const std::vector<std::uint8_t>& payload,
                                             std::uint8_t opcode)
{
    std::vector<std::uint8_t> frame;
    frame.reserve (payload.size() + 10);
    frame.push_back (static_cast<std::uint8_t> (0x80u | opcode));

    if (payload.size() < 126)
    {
        frame.push_back (static_cast<std::uint8_t> (payload.size()));
    }
    else
    {
        frame.push_back (126);
        frame.push_back (static_cast<std::uint8_t> ((payload.size() >> 8u) & 0xffu));
        frame.push_back (static_cast<std::uint8_t> (payload.size() & 0xffu));
    }

    frame.insert (frame.end(), payload.begin(), payload.end());

    const std::scoped_lock lock { client.sendMutex };
    sendRaw (client.socket, frame.data(), frame.size());
}

void NetworkTransmitter::setNonBlocking (NativeSocket socketHandle)
{
   #if JUCE_WINDOWS
    u_long mode = 1;
    ioctlsocket (socketHandle, FIONBIO, &mode);
   #else
    const auto flags = fcntl (socketHandle, F_GETFL, 0);
    if (flags >= 0)
        fcntl (socketHandle, F_SETFL, flags | O_NONBLOCK);
   #endif
}

void NetworkTransmitter::closeSocket (NativeSocket& socketHandle)
{
    if (socketHandle == invalidSocket)
        return;

   #if JUCE_WINDOWS
    closesocket (socketHandle);
   #else
    ::close (socketHandle);
   #endif
    socketHandle = invalidSocket;
}

void NetworkTransmitter::sendRaw (NativeSocket socketHandle, const void* data, std::size_t byteCount)
{
    const auto* bytes = static_cast<const char*> (data);
    std::size_t sent = 0;

    while (sent < byteCount)
    {
       #if JUCE_WINDOWS
        const auto result = ::send (socketHandle,
                                    bytes + sent,
                                    static_cast<int> (byteCount - sent),
                                    0);
       #else
        const auto result = ::send (socketHandle, bytes + sent, byteCount - sent, 0);
       #endif
        if (result <= 0)
            return;

        sent += static_cast<std::size_t> (result);
    }
}

juce::String NetworkTransmitter::createWebSocketAcceptKey (const juce::String& key)
{
    return sha1Base64 (key + websocketGuid);
}

juce::String NetworkTransmitter::sha1Base64 (const juce::String& input)
{
    return base64Encode (sha1Digest (input));
}

juce::String NetworkTransmitter::jsonString (const juce::var& value)
{
    return juce::JSON::toString (value, true);
}

void NetworkTransmitter::closeAllClients()
{
    const juce::ScopedLock lock { clientLock };

    for (auto& client : clients)
    {
        closePeerConnection (*client);
        closeSocket (client->socket);
    }

    clients.clear();
    externalSignalingClient.reset();
    connectedClients.store (0, std::memory_order_release);
    activeClientCount.store (0, std::memory_order_release);
    isConnected.store (false, std::memory_order_release);
    bufferHealth.store (1.0f, std::memory_order_release);
    targetChunkMs.store (AudioFifoWorker::chunkDurationMs, std::memory_order_release);
    chunkSizeTransitionPending.store (false, std::memory_order_release);
}
