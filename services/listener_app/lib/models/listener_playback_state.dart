class ListenerPlaybackState {
  const ListenerPlaybackState({
    this.engineState = 'reset',
    this.streamMode = 'Balanced',
    this.sampleRate = 48000,
    this.bitDepth = 16,
    this.channels = 2,
    this.chunkDurationMs = 20,
  });

  final String engineState;
  final String streamMode;
  final int sampleRate;
  final int bitDepth;
  final int channels;
  final int chunkDurationMs;

  ListenerPlaybackState copyWith({
    String? engineState,
    String? streamMode,
    int? sampleRate,
    int? bitDepth,
    int? channels,
    int? chunkDurationMs,
  }) {
    return ListenerPlaybackState(
      engineState: engineState ?? this.engineState,
      streamMode: streamMode ?? this.streamMode,
      sampleRate: sampleRate ?? this.sampleRate,
      bitDepth: bitDepth ?? this.bitDepth,
      channels: channels ?? this.channels,
      chunkDurationMs: chunkDurationMs ?? this.chunkDurationMs,
    );
  }
}
