#pragma once

#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>

#include <juce_audio_basics/juce_audio_basics.h>

class AudioFifoWorker final
{
public:
    static constexpr int inputChannels = 2;
    static constexpr int targetSampleRate = 48000;
    static constexpr int minChunkDurationMs = 5;
    static constexpr int maxChunkDurationMs = 20;
    static constexpr int chunkDurationStepMs = 5;
    static constexpr int chunkDurationMs = minChunkDurationMs;
    static constexpr int framesPerChunk = targetSampleRate * chunkDurationMs / 1000;
    static constexpr int maxFramesPerChunk = targetSampleRate * maxChunkDurationMs / 1000;
    static constexpr int samplesPerChunk = framesPerChunk * inputChannels;
    static constexpr int maxSamplesPerChunk = maxFramesPerChunk * inputChannels;
    static constexpr int bytesPerChunk = samplesPerChunk * static_cast<int> (sizeof (std::int16_t));
    static constexpr int maxBytesPerChunk = maxSamplesPerChunk * static_cast<int> (sizeof (std::int16_t));
    static constexpr int telemetryBitrateBitsPerSecond =
        targetSampleRate * inputChannels * static_cast<int> (sizeof (std::int16_t)) * 8;
    using PcmChunk = std::array<std::byte, bytesPerChunk>;

    struct DynamicPcmChunk final
    {
        std::array<std::byte, maxBytesPerChunk> bytes {};
        std::size_t byteCount = 0;
        int chunkMs = chunkDurationMs;
    };

    AudioFifoWorker() = default;

    void reset() noexcept
    {
        fifo.reset();
        droppedSamples.store (0, std::memory_order_relaxed);
        totalSamplesWritten.store (0, std::memory_order_relaxed);
    }

    void writeAudioFrame (const juce::AudioBuffer<float>& buffer) noexcept
    {
        const auto frameCount = buffer.getNumSamples();
        if (frameCount <= 0)
            return;

        const auto requestedSamples = frameCount * inputChannels;
        int start1 = 0;
        int size1 = 0;
        int start2 = 0;
        int size2 = 0;

        fifo.prepareToWrite (requestedSamples, start1, size1, start2, size2);

        if (size1 > 0)
            writeInterleavedSamples (buffer, start1, size1, 0);

        if (size2 > 0)
            writeInterleavedSamples (buffer, start2, size2, size1);

        const auto written = size1 + size2;
        fifo.finishedWrite (written);
        totalSamplesWritten.fetch_add (static_cast<std::uint64_t> (written), std::memory_order_relaxed);

        if (written < requestedSamples)
            droppedSamples.fetch_add (static_cast<std::uint64_t> (requestedSamples - written),
                                      std::memory_order_relaxed);
    }

    int getReadySampleCount() const noexcept
    {
        return fifo.getNumReady();
    }

    int getReadyChunkCount() const noexcept
    {
        return getReadySampleCount() / samplesPerChunk;
    }

    bool readPcmChunk (DynamicPcmChunk& destination, int requestedChunkMs) noexcept
    {
        const auto chunkMs = normaliseChunkMs (requestedChunkMs);
        const auto requestedSamples = samplesForChunkMs (chunkMs);
        int start1 = 0;
        int size1 = 0;
        int start2 = 0;
        int size2 = 0;

        fifo.prepareToRead (requestedSamples, start1, size1, start2, size2);

        if (size1 + size2 < requestedSamples)
        {
            fifo.finishedRead (0);
            return false;
        }

        copyPcmSamplesToBytes (destination, start1, size1, 0);
        copyPcmSamplesToBytes (destination, start2, size2, size1);
        fifo.finishedRead (requestedSamples);
        destination.byteCount = bytesForChunkMs (chunkMs);
        destination.chunkMs = chunkMs;
        return true;
    }

    bool readPcmChunk (DynamicPcmChunk& destination,
                       const std::atomic<int>& requestedChunkMs) noexcept
    {
        return readPcmChunk (destination, requestedChunkMs.load (std::memory_order_acquire));
    }

    static int normaliseChunkMs (int requestedChunkMs) noexcept
    {
        const auto clamped = juce::jlimit (minChunkDurationMs, maxChunkDurationMs, requestedChunkMs);
        return ((clamped + chunkDurationStepMs - 1) / chunkDurationStepMs) * chunkDurationStepMs;
    }

    static int framesForChunkMs (int chunkMs) noexcept
    {
        return targetSampleRate * normaliseChunkMs (chunkMs) / 1000;
    }

    static int samplesForChunkMs (int chunkMs) noexcept
    {
        return framesForChunkMs (chunkMs) * inputChannels;
    }

    static std::size_t bytesForChunkMs (int chunkMs) noexcept
    {
        return static_cast<std::size_t> (samplesForChunkMs (chunkMs))
            * sizeof (std::int16_t);
    }

    std::uint64_t getDroppedSampleCount() const noexcept
    {
        return droppedSamples.load (std::memory_order_relaxed);
    }

    std::uint64_t getTotalSamplesWritten() const noexcept
    {
        return totalSamplesWritten.load (std::memory_order_relaxed);
    }

private:
    static constexpr int capacitySeconds = 8;
    static constexpr int capacityFrames = targetSampleRate * capacitySeconds;
    static constexpr int capacitySamples = capacityFrames * inputChannels;

    static std::int16_t floatToPcm16 (float sample) noexcept
    {
        const auto clipped = juce::jlimit (-1.0f, 1.0f, sample);
        return static_cast<std::int16_t> (std::lround (clipped * 32767.0f));
    }

    void writeInterleavedSamples (const juce::AudioBuffer<float>& buffer,
                                  int ringStart,
                                  int sampleCount,
                                  int sourceSampleOffset) noexcept
    {
        const auto numInputChannels = buffer.getNumChannels();
        const auto* left = numInputChannels > 0 ? buffer.getReadPointer (0) : nullptr;
        const auto* right = numInputChannels > 1 ? buffer.getReadPointer (1) : left;

        for (int i = 0; i < sampleCount; ++i)
        {
            const auto absoluteSample = sourceSampleOffset + i;
            const auto sourceFrame = absoluteSample / inputChannels;
            const auto isRight = (absoluteSample & 1) != 0;
            const auto* source = isRight ? right : left;
            ringBuffer[static_cast<std::size_t> (ringStart + i)] =
                source != nullptr ? floatToPcm16 (source[sourceFrame]) : 0;
        }
    }

    void copyPcmSamplesToBytes (DynamicPcmChunk& destination,
                                int ringStart,
                                int sampleCount,
                                int destinationSampleOffset) const noexcept
    {
        for (int i = 0; i < sampleCount; ++i)
        {
            const auto sample = ringBuffer[static_cast<std::size_t> (ringStart + i)];
            const auto byteOffset = static_cast<std::size_t> ((destinationSampleOffset + i) * 2);
            const auto unsignedSample = static_cast<std::uint16_t> (sample);
            destination.bytes[byteOffset] = static_cast<std::byte> (unsignedSample & 0xffu);
            destination.bytes[byteOffset + 1] = static_cast<std::byte> ((unsignedSample >> 8u) & 0xffu);
        }
    }

    juce::AbstractFifo fifo { capacitySamples };
    std::array<std::int16_t, capacitySamples> ringBuffer {};
    std::atomic<std::uint64_t> droppedSamples { 0 };
    std::atomic<std::uint64_t> totalSamplesWritten { 0 };
};
