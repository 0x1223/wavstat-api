#pragma once

#include <optional>

#include <juce_gui_extra/juce_gui_extra.h>

#include "PluginProcessor.h"

class KingzListenAudioProcessorEditor final : public juce::AudioProcessorEditor,
                                             public WebSocketManager::Listener
{
public:
    explicit KingzListenAudioProcessorEditor (KingzListenAudioProcessor& audioProcessor);
    ~KingzListenAudioProcessorEditor() override;

    void resized() override;
    void emitTelemetryToWebView (const juce::String& telemetryJson);
    void emitConnectionAttemptToWebView (const juce::String& url);
    void onWebSocketMessageReceived (const std::string& message) override;

private:
    static juce::WebBrowserComponent::Options createWebViewOptions (
        KingzListenAudioProcessorEditor& editor);

    void handleUiCall (const juce::var& object,
                       juce::WebBrowserComponent::NativeFunctionCompletion completion);

    std::optional<juce::WebBrowserComponent::Resource> getUIResource (const juce::String& url);
    void emitConnectionStateToWebView();

    KingzListenAudioProcessor& processorRef;
    juce::WebBrowserComponent webView;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (KingzListenAudioProcessorEditor)
};
