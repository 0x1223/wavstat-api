/**
 * Shared mobile audio tap singleton.
 *
 * MobileSpectrumAnalyzer calls registerAudioSource() once after it creates
 * the AudioContext + MediaElementSource. Any other module (e.g. loudness
 * meter) can then call createAnalyserNode() to hook a new AnalyserNode into
 * the SAME source — without triggering a second createMediaElementSource()
 * call (which the Web Audio API forbids).
 */

let _audioCtx = null;
let _source = null;
let _version = 0; // incremented each time the source changes

/** Called by MobileSpectrumAnalyzer after audio graph is built. */
export function registerAudioSource(audioCtx, sourceNode) {
  _audioCtx = audioCtx;
  _source = sourceNode;
  _version++;
}

/** Called by MobileSpectrumAnalyzer cleanup when the component unmounts. */
export function releaseAudioSource() {
  _audioCtx = null;
  _source = null;
}

/**
 * Create and return a new AnalyserNode connected to the registered source.
 * Returns null if the source hasn't been registered yet.
 */
export function createAnalyserNode(fftSize = 2048, smoothing = 0.0) {
  if (!_audioCtx || !_source) return null;
  try {
    const analyser = _audioCtx.createAnalyser();
    analyser.fftSize = fftSize;
    analyser.smoothingTimeConstant = smoothing;
    _source.connect(analyser);
    return analyser;
  } catch (_) {
    return null;
  }
}

/**
 * Returns a version counter that increments whenever the source is
 * re-registered. Consumers can detect source changes by watching this value.
 */
export function getAudioTapVersion() {
  return _version;
}
