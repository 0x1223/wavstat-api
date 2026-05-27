#pragma once

#include <atomic>
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

    void startConnection (const std::string& url)
    {
        DBG ("WebSocketManager::startConnection requested: " << url);

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
        socket = std::make_shared<rtc::WebSocket>();

        socket->onOpen ([]
        {
            DBG ("WebSocketManager::onOpen: connected");
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

        DBG ("WebSocketManager::startConnection before socket->open");
        socket->open (url);
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

private:
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

    std::shared_ptr<rtc::WebSocket> socket;
    juce::CriticalSection listenerLock;
    juce::Array<Listener*> listeners;
    std::atomic<bool> shouldRun { false };
};
