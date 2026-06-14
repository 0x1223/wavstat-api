#pragma once

#include <atomic>
#include <juce_audio_processors/juce_audio_processors.h>

#include "AudioFifoWorker.h"
#include "NetworkTransmitter.h"
#include "WebSocketManager.h"

class KingzListenAudioProcessor final : public juce::AudioProcessor
{
public:
    KingzListenAudioProcessor();
    ~KingzListenAudioProcessor() override = default;

    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;

    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;
    void processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midiMessages) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override;

    const juce::String getName() const override;

    bool acceptsMidi() const override;
    bool producesMidi() const override;
    bool isMidiEffect() const override;
    double getTailLengthSeconds() const override;

    int getNumPrograms() override;
    int getCurrentProgram() override;
    void setCurrentProgram (int index) override;
    const juce::String getProgramName (int index) override;
    void changeProgramName (int index, const juce::String& newName) override;

    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    void handleUiAction (const juce::var& object);
    void startTelemetryConnection (const juce::String& host, int port);
    WebSocketManager& getWebSocketManager() noexcept;
    const NetworkTransmitter& getNetworkTransmitter() const noexcept;
    int getTargetChunkMs() const noexcept;
    juce::String getTelemetryReport() const;
    juce::String getLocalLanIpAddress() const;
    int getNetworkPort() const noexcept;

private:
    AudioFifoWorker fifoWorker;
    NetworkTransmitter networkTransmitter;
    WebSocketManager wsManager;
    juce::CriticalSection uiStateLock;
    juce::String lastUiAction;
    std::atomic<bool> monitoringRequested { false };
    std::atomic<int> currentAudioThreadTargetChunkMs { AudioFifoWorker::chunkDurationMs };
    std::atomic<juce::int64> streamWritePositionSamples { 0 };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (KingzListenAudioProcessor)
};
