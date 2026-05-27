#include "PluginProcessor.h"
#include "PluginEditor.h"

KingzListenAudioProcessor::KingzListenAudioProcessor()
    : juce::AudioProcessor (
        BusesProperties()
            .withInput ("Input", juce::AudioChannelSet::stereo(), true)
            .withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
      networkTransmitter (fifoWorker)
{
}

void KingzListenAudioProcessor::prepareToPlay (double sampleRate, int samplesPerBlock)
{
    juce::ignoreUnused (sampleRate, samplesPerBlock);
    fifoWorker.reset();
    networkTransmitter.start (8082);
}

void KingzListenAudioProcessor::releaseResources()
{
    networkTransmitter.stop();
    fifoWorker.reset();
}

bool KingzListenAudioProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    const auto& mainInput = layouts.getMainInputChannelSet();
    const auto& mainOutput = layouts.getMainOutputChannelSet();

    if (mainInput != juce::AudioChannelSet::stereo())
        return false;

    return mainOutput == juce::AudioChannelSet::stereo();
}

void KingzListenAudioProcessor::processBlock (juce::AudioBuffer<float>& buffer,
                                              juce::MidiBuffer& midiMessages)
{
    juce::ignoreUnused (midiMessages);

    for (auto channel = getTotalNumInputChannels(); channel < getTotalNumOutputChannels(); ++channel)
        buffer.clear (channel, 0, buffer.getNumSamples());

    fifoWorker.writeAudioFrame (buffer);
}

juce::AudioProcessorEditor* KingzListenAudioProcessor::createEditor()
{
    return new KingzListenAudioProcessorEditor (*this);
}

bool KingzListenAudioProcessor::hasEditor() const
{
    return true;
}

const juce::String KingzListenAudioProcessor::getName() const
{
    return JucePlugin_Name;
}

bool KingzListenAudioProcessor::acceptsMidi() const
{
    return false;
}

bool KingzListenAudioProcessor::producesMidi() const
{
    return false;
}

bool KingzListenAudioProcessor::isMidiEffect() const
{
    return false;
}

double KingzListenAudioProcessor::getTailLengthSeconds() const
{
    return 0.0;
}

int KingzListenAudioProcessor::getNumPrograms()
{
    return 1;
}

int KingzListenAudioProcessor::getCurrentProgram()
{
    return 0;
}

void KingzListenAudioProcessor::setCurrentProgram (int index)
{
    juce::ignoreUnused (index);
}

const juce::String KingzListenAudioProcessor::getProgramName (int index)
{
    juce::ignoreUnused (index);
    return {};
}

void KingzListenAudioProcessor::changeProgramName (int index, const juce::String& newName)
{
    juce::ignoreUnused (index, newName);
}

void KingzListenAudioProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    destData.reset();
}

void KingzListenAudioProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    juce::ignoreUnused (data, sizeInBytes);
}

void KingzListenAudioProcessor::handleUiAction (const juce::var& object)
{
    if (auto* dynamicObject = object.getDynamicObject())
    {
        const auto action = dynamicObject->getProperty ("action").toString();

        {
            const juce::ScopedLock lock { uiStateLock };
            lastUiAction = action;
        }

        if (action == "toggleMonitoringMode")
            monitoringRequested.store (! monitoringRequested.load (std::memory_order_relaxed),
                                       std::memory_order_relaxed);
        else if (action == "setMonitoringEnabled")
            monitoringRequested.store (static_cast<bool> (dynamicObject->getProperty ("enabled")),
                                       std::memory_order_relaxed);
        else if (action == "connectTelemetry")
        {
            const auto host = dynamicObject->getProperty ("host").toString();
            const auto port = static_cast<int> (dynamicObject->getProperty ("port"));
            startTelemetryConnection (host, port > 0 ? port : 8081);
        }
        else if (action == "regenerateLocalIpToken")
            monitoringRequested.store (monitoringRequested.load (std::memory_order_relaxed),
                                       std::memory_order_relaxed);
    }
}

void KingzListenAudioProcessor::startTelemetryConnection (const juce::String& host, int port)
{
    const auto cleanHost = host.isNotEmpty() ? host : juce::String { "127.0.0.1" };
    const auto url = "ws://" + cleanHost + ":" + juce::String (port);
    wsManager.startConnection (url.toStdString());
}

WebSocketManager& KingzListenAudioProcessor::getWebSocketManager() noexcept
{
    return wsManager;
}

juce::String KingzListenAudioProcessor::getLocalLanIpAddress() const
{
    return networkTransmitter.getLocalLanIpAddress();
}

int KingzListenAudioProcessor::getNetworkPort() const noexcept
{
    return networkTransmitter.getPort();
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new KingzListenAudioProcessor();
}
