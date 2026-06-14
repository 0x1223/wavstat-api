class KingzPcmRenderer extends AudioWorkletProcessor {
  constructor() {
    super();
    try {
      this.channelCount = 2;
      this.capacityFrames = sampleRate * 4;
      this.buffer = new Float32Array(this.capacityFrames * this.channelCount);
      this.readFrame = 0;
      this.writeFrame = 0;
      this.bufferedFrames = 0;
      this.underruns = 0;
      this.droppedFrames = 0;
      this.lastUnderrunReportFrame = -sampleRate;
      this.lastStatusFrame = 0;
      this.active = true;
      this.playing = false;
      this.targetBufferFrames = Math.round(sampleRate * 0.08);
      this.resumeBufferFrames = Math.round(sampleRate * 0.12);
      this.currentGain = 0;
      this.fadeFrames = Math.max(16, Math.round(sampleRate * 0.005));
      this.port.postMessage({ type: "ready", sampleRate: sampleRate, capacityFrames: this.capacityFrames });
    } catch (e) {
      this.active = false;
      try { this.port.postMessage({ type: "error", phase: "constructor", message: String(e) }); } catch (_) {}
      throw e;
    }

    this.port.onmessage = (event) => {
      const message = event.data;
      if (!message || typeof message.type !== "string") return;
      if (message.type === "stop") {
        this.active = false;
        this.playing = false;
        this.currentGain = 0;
        this.bufferedFrames = 0;
        this.readFrame = 0;
        this.writeFrame = 0;
        return;
      }
      if (message.type === "flush") {
        this.playing = false;
        this.currentGain = 0;
        this.bufferedFrames = 0;
        this.readFrame = 0;
        this.writeFrame = 0;
        return;
      }
      if (message.type === "configure") {
        const targetMs = Math.max(70, Math.min(500, message.targetBufferMs || 80));
        const safeMs = Math.max(targetMs, Math.max(90, Math.min(750, message.safeBufferMs || targetMs)));
        this.targetBufferFrames = Math.max(1, Math.round(sampleRate * targetMs / 1000));
        this.resumeBufferFrames = Math.max(this.targetBufferFrames, Math.round(sampleRate * safeMs / 1000));
        this.port.postMessage({
          type: "configured",
          targetBufferFrames: this.targetBufferFrames,
          resumeBufferFrames: this.resumeBufferFrames,
        });
        return;
      }
      if (message.type === "pcm") {
        this._pushPcm(message);
      }
      if (message.type === "pcm-bytes") {
        this._pushPcmBytes(message);
      }
    };
  }

  _pushPcm(message) {
    const input = message.frames;
    const inputChannels = Math.max(1, Math.min(2, message.channels || 2));
    const frameCount = Math.max(0, message.frameCount || 0);
    if (!input || frameCount <= 0) return;

    const overflowFrames = Math.max(
      0,
      this.bufferedFrames + frameCount - this.capacityFrames,
    );
    if (overflowFrames > 0) {
      this.readFrame = (this.readFrame + overflowFrames) % this.capacityFrames;
      this.bufferedFrames -= overflowFrames;
      this.droppedFrames += overflowFrames;
    }

    for (let frame = 0; frame < frameCount; frame += 1) {
      const inputIndex = frame * inputChannels;
      const left = input[inputIndex] || 0;
      const right = inputChannels > 1 ? input[inputIndex + 1] || 0 : left;
      const writeIndex = this.writeFrame * this.channelCount;
      this.buffer[writeIndex] = left;
      this.buffer[writeIndex + 1] = right;
      this.writeFrame = (this.writeFrame + 1) % this.capacityFrames;
    }
    this.bufferedFrames = Math.min(
      this.capacityFrames,
      this.bufferedFrames + frameCount,
    );
  }

  _pushPcmBytes(message) {
    try {
      const rawBytes = message.bytes;
      const bytes =
        rawBytes instanceof Uint8Array
          ? rawBytes
          : rawBytes instanceof ArrayBuffer
            ? new Uint8Array(rawBytes)
            : new Uint8Array(rawBytes);
      const inputChannels = Math.max(1, Math.min(2, message.channels || 2));
      const srcRate = message.sampleRate > 0 ? message.sampleRate : sampleRate;
      const dstRate = sampleRate;
      const srcFrameCount = Math.max(
        0,
        message.frameCount || Math.floor(bytes.byteLength / (inputChannels * 2)),
      );
      if (!bytes || srcFrameCount <= 0) return;

      // Resample from plugin rate (e.g. 48000) to AudioContext rate (e.g. 44100).
      // When rates match this is a zero-overhead fast path.
      const dstFrameCount = (srcRate === dstRate)
        ? srcFrameCount
        : Math.round(srcFrameCount * dstRate / srcRate);

      const overflowFrames = Math.max(
        0,
        this.bufferedFrames + dstFrameCount - this.capacityFrames,
      );
      if (overflowFrames > 0) {
        this.readFrame = (this.readFrame + overflowFrames) % this.capacityFrames;
        this.bufferedFrames -= overflowFrames;
        this.droppedFrames += overflowFrames;
      }

      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

      if (srcRate === dstRate) {
        // Fast path — no interpolation needed.
        for (let frame = 0; frame < dstFrameCount; frame += 1) {
          const inputIndex = frame * inputChannels;
          const left = view.getInt16(inputIndex * 2, true) / 32768;
          const right =
            inputChannels > 1 ? view.getInt16((inputIndex + 1) * 2, true) / 32768 : left;
          const writeIndex = this.writeFrame * this.channelCount;
          this.buffer[writeIndex] = Math.max(-1, Math.min(1, left));
          this.buffer[writeIndex + 1] = Math.max(-1, Math.min(1, right));
          this.writeFrame = (this.writeFrame + 1) % this.capacityFrames;
        }
      } else {
        // Resampling path — linear interpolation between adjacent source frames.
        const ratio = srcRate / dstRate;
        for (let i = 0; i < dstFrameCount; i += 1) {
          const srcPos = i * ratio;
          const idx = srcPos | 0;
          const frac = srcPos - idx;
          const nxt = (idx + 1 < srcFrameCount) ? idx + 1 : idx;
          const off0L = idx * inputChannels * 2;
          const off1L = nxt * inputChannels * 2;
          const s0L = view.getInt16(off0L, true) / 32768;
          const s1L = view.getInt16(off1L, true) / 32768;
          const left = s0L + frac * (s1L - s0L);
          let right = left;
          if (inputChannels > 1) {
            const s0R = view.getInt16(off0L + 2, true) / 32768;
            const s1R = view.getInt16(off1L + 2, true) / 32768;
            right = s0R + frac * (s1R - s0R);
          }
          const writeIndex = this.writeFrame * this.channelCount;
          this.buffer[writeIndex] = Math.max(-1, Math.min(1, left));
          this.buffer[writeIndex + 1] = Math.max(-1, Math.min(1, right));
          this.writeFrame = (this.writeFrame + 1) % this.capacityFrames;
        }
      }

      this.bufferedFrames = Math.min(
        this.capacityFrames,
        this.bufferedFrames + dstFrameCount,
      );
    } catch (e) {
      this.port.postMessage({
        type: "error",
        phase: "pushPcmBytes",
        message: String(e),
        bytesType: message.bytes == null ? "null" : Object.prototype.toString.call(message.bytes),
        byteLength: message.bytes && message.bytes.byteLength,
        channels: message.channels,
        frameCount: message.frameCount,
        sampleRate: message.sampleRate,
      });
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] || output[0];
    const framesNeeded = left.length;

    if (!this.active) {
      this._writeSilence(left, right);
      this._reportStatus();
      return true;
    }

    if (!this.playing && this.bufferedFrames < this.targetBufferFrames) {
      this._writeSilence(left, right);
      this.currentGain = 0;
      this._reportStatus();
      return true;
    }

    if (!this.playing) {
      this.playing = true;
      this.currentGain = 0;
      this.port.postMessage({
        type: "started",
        bufferedFrames: this.bufferedFrames,
        targetBufferFrames: this.targetBufferFrames,
      });
    }

    for (let frame = 0; frame < framesNeeded; frame += 1) {
      if (this.bufferedFrames <= 0) {
        left[frame] = 0;
        right[frame] = 0;
        this.playing = false;
        this.currentGain = 0;
        this._reportUnderrun();
        continue;
      }

      const readIndex = this.readFrame * this.channelCount;
      if (this.currentGain < 1) {
        this.currentGain = Math.min(1, this.currentGain + 1 / this.fadeFrames);
      }
      left[frame] = this.buffer[readIndex] * this.currentGain;
      right[frame] = this.buffer[readIndex + 1] * this.currentGain;
      this.readFrame = (this.readFrame + 1) % this.capacityFrames;
      this.bufferedFrames -= 1;

      if (this.bufferedFrames === 0 && frame + 1 < framesNeeded) {
        this.playing = false;
        this.currentGain = 0;
      }
    }

    this._reportStatus();
    return true;
  }

  _writeSilence(left, right) {
    left.fill(0);
    if (right !== left) right.fill(0);
  }

  _reportUnderrun() {
    this.underruns += 1;
    if (currentFrame - this.lastUnderrunReportFrame < sampleRate / 4) {
      return;
    }
    this.lastUnderrunReportFrame = currentFrame;
    this.port.postMessage({
      type: "underrun",
      underruns: this.underruns,
      bufferedFrames: this.bufferedFrames,
      droppedFrames: this.droppedFrames,
      targetBufferFrames: this.targetBufferFrames,
    });
  }

  _reportStatus() {
    if (currentFrame - this.lastStatusFrame < sampleRate / 2) {
      return;
    }
    this.lastStatusFrame = currentFrame;
    this.port.postMessage({
      type: "status",
      bufferedFrames: this.bufferedFrames,
      droppedFrames: this.droppedFrames,
      underruns: this.underruns,
      targetBufferFrames: this.targetBufferFrames,
      playing: this.playing,
    });
  }
}

registerProcessor("kingz-pcm-renderer", KingzPcmRenderer);
