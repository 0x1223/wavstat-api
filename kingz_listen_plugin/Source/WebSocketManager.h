#pragma once

#include <atomic>
#include <chrono>
#include <functional>
#include <memory>
#include <string>
#include <variant>

#include <juce_core/juce_core.h>
#include <rtc/websocket.hpp>

class WebSocketManager final : private juce::Thread
{
public:
    class Listener
    {
    public:
        virtual ~Listener() = default;
        virtual void onWebSocketMessageReceived (const std::string& message) = 0;
    };

    WebSocketManager()
        : juce::Thread ("Kingz Listen WebSocket")
    {
    }

    ~WebSocketManager() override
    {
        disconnect();
    }

    void addListener (Listener* listener)
    {
        const juce::ScopedLock lock { listenerLock };
        listeners.addIfNotAlreadyThere (listener);
    }

    void removeListener (Listener* listener)
    {
        const juce::ScopedLock lock { listenerLock };
        listeners.removeFirstMatchingValue (listener);
    }

    void setSignalingHandler (std::function<void (const juce::var&)> handler)
    {
        const juce::ScopedLock lock { signalingLock };
        signalingHandler = std::move (handler);
    }

    void sendJson (const juce::String& json)
    {
        if (socket == nullptr || ! socket->isOpen())
        {
            DBG ("WebSocketManager::sendJson ignored: socket not open");
            return;
        }

        socket->send (json.toStdString());
    }

    void startConnection (const std::string& url)
    {
        DBG ("WebSocketManager::startConnection ENTER rawUrl=" << url);
        const auto normalisedUrl = normaliseWebSocketUrl (url);
        DBG ("WebSocketManager::startConnection requested: " << normalisedUrl);

        if (socket != nullptr && socket->isOpen())
        {
            DBG ("WebSocketManager::startConnection ignored: socket already open");
            return;
        }

        if (socket != nullptr && socket->readyState() == rtc::WebSocket::State::Connecting)
        {
            DBG ("WebSocketManager::startConnection ignored: socket already connecting");
            return;
        }

        shouldRun.store (true, std::memory_order_release);

        auto config = rtc::WebSocket::Configuration {};
        config.connectionTimeout = std::chrono::milliseconds { 5000 };
        config.pingInterval = std::chrono::milliseconds { 10000 };
        config.maxOutstandingPings = 3;

        socket = std::make_shared<rtc::WebSocket> (config);

        socket->onOpen ([this]
        {
            DBG ("WebSocketManager::onOpen: connected");
            onConnectionOpen();
        });

        socket->onClosed ([]
        {
            DBG ("WebSocketManager::onClosed: disconnected");
        });

        socket->onError ([] (std::string error)
        {
            juce::ignoreUnused (error);
            DBG ("WebSocketManager::onError: " << error);
        });

        socket->onMessage ([this] (rtc::message_variant message)
        {
            std::string msgStr;

            if (std::holds_alternative<std::string> (message))
            {
                msgStr = std::get<std::string> (message);
            }
            else
            {
                const auto& bytes = std::get<rtc::binary> (message);
                msgStr.assign (reinterpret_cast<const char*> (bytes.data()), bytes.size());
            }

            handleIncomingMessage (msgStr);
            DBG ("WebSocketManager::onMessage dispatching to listeners");

            {
                const juce::ScopedLock lock { listenerLock };

                for (auto* listener : listeners)
                {
                    if (listener != nullptr)
                        listener->onWebSocketMessageReceived (msgStr);
                }
            }
        });

        DBG ("WebSocketManager::startConnection using libdatachannel WebSocket client");
        DBG ("WebSocketManager::startConnection expected HTTP upgrade headers: "
             "Connection: Upgrade, Upgrade: websocket, Sec-WebSocket-Version: 13, Sec-WebSocket-Key");
        DBG ("WebSocketManager::startConnection before socket->open");
        socket->open (normalisedUrl);
        DBG ("WebSocketManager::startConnection after socket->open");

        if (! isThreadRunning())
            startThread();
    }

    void disconnect()
    {
        shouldRun.store (false, std::memory_order_release);
        stopThread (2000);

        if (socket != nullptr)
        {
            socket->resetCallbacks();
            socket->close();
            socket.reset();
        }
    }

    void handleIncomingMessage (const std::string& message)
    {
        const auto parsed = juce::JSON::parse (juce::String::fromUTF8 (message.c_str()));

        if (parsed.isVoid())
        {
            DBG ("WebSocketManager::handleIncomingMessage JSON parse failed: " << message);
            return;
        }

        auto* object = parsed.getDynamicObject();
        if (object == nullptr)
            return;

        const auto type = object->getProperty ("type").toString();
        if (type == "server.confirm")
        {
            const auto confirmation = object->getProperty ("message").toString();
            DBG ("WebSocketManager::handleIncomingMessage confirmation received from server: "
                 << confirmation);
        }
        else if (type == "webrtc-offer" || type == "webrtc-candidate")
        {
            std::function<void (const juce::var&)> handler;
            {
                const juce::ScopedLock lock { signalingLock };
                handler = signalingHandler;
            }

            if (handler != nullptr)
                handler (parsed);
            else
                DBG ("WebSocketManager::handleIncomingMessage no signaling handler for " << type);
        }
    }

private:
    void onConnectionOpen()
    {
        if (socket == nullptr || ! socket->isOpen())
            return;

        static constexpr auto registration =
            R"json({"type":"registration","source_id":"KINGZ_LISTEN_PLUGIN"})json";
        socket->send (std::string { registration });
        DBG ("WebSocketManager::onConnectionOpen: sent registration");
    }

    void run() override
    {
        auto lastDebugMs = juce::int64 { 0 };

        while (! threadShouldExit() && shouldRun.load (std::memory_order_acquire))
        {
            const auto nowMs = juce::Time::currentTimeMillis();

            if (nowMs - lastDebugMs >= 2000)
            {
                DBG ("WebSocketManager::run alive; socketOpen="
                     << (socket != nullptr && socket->isOpen() ? "true" : "false"));
                lastDebugMs = nowMs;
            }

            wait (100);
        }

        DBG ("WebSocketManager::run exiting");
    }

    static std::string normaliseWebSocketUrl (const std::string& rawUrl)
    {
        auto url = juce::String::fromUTF8 (rawUrl.c_str()).trim();

        if (! url.startsWithIgnoreCase ("ws://") && ! url.startsWithIgnoreCase ("wss://"))
            url = "ws://" + url;

        const auto schemeSeparator = url.indexOf ("://");
        const auto authorityStart = schemeSeparator >= 0 ? schemeSeparator + 3 : 0;
        const auto pathStart = url.indexOfChar (authorityStart, '/');

        if (pathStart < 0)
            url << "/";

        return url.toStdString();
    }

    std::shared_ptr<rtc::WebSocket> socket;
    juce::CriticalSection listenerLock;
    juce::Array<Listener*> listeners;
    juce::CriticalSection signalingLock;
    std::function<void (const juce::var&)> signalingHandler;
    std::atomic<bool> shouldRun { false };
};
