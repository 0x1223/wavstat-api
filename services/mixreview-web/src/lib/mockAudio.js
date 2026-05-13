export function createMockAudioUrl() {
  const sampleRate = 44100;
  const durationSeconds = 48;
  const samples = sampleRate * durationSeconds;
  const channels = 1;
  const bytesPerSample = 2;
  const dataSize = samples * channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < samples; i += 1) {
    const t = i / sampleRate;
    const sectionPulse = Math.sin(2 * Math.PI * 0.5 * t) > 0 ? 1 : 0.56;
    const kick = Math.max(0, 1 - ((t * 2) % 1) * 8) * 0.28;
    const tone =
      Math.sin(2 * Math.PI * 110 * t) * 0.18 +
      Math.sin(2 * Math.PI * 220 * t) * 0.08 +
      Math.sin(2 * Math.PI * 440 * t) * 0.05;
    const fadeIn = Math.min(1, t / 2);
    const sample = Math.max(-1, Math.min(1, (tone * sectionPulse + kick) * fadeIn));
    view.setInt16(44 + i * bytesPerSample, sample * 0x7fff, true);
  }

  return URL.createObjectURL(new Blob([view], { type: "audio/wav" }));
}

function writeString(view, offset, value) {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}
