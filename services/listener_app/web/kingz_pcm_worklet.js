class KingzPcmRenderer extends AudioWorkletProcessor {
  constructor() {
    super();
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

    this.port.onmessage = (event) => {
      const message = event.data;
      if (!message || typeof message.type !== "string") return;
      if (message.type === "stop") {
        this.active = false;
        this.bufferedFrames = 0;
        this.readFrame = 0;
        this.writeFrame = 0;
        return;
      }
      if (message.type === "pcm") {
        this._pushPcm(message);
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

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] || output[0];
    const framesNeeded = left.length;

    if (!this.active || this.bufferedFrames <= 0) {
      this._writeSilence(left, right);
      this._reportUnderrun();
      return true;
    }

    for (let frame = 0; frame < framesNeeded; frame += 1) {
      if (this.bufferedFrames <= 0) {
        left[frame] = 0;
        right[frame] = 0;
        this._reportUnderrun();
        continue;
      }

      const readIndex = this.readFrame * this.channelCount;
      left[frame] = this.buffer[readIndex];
      right[frame] = this.buffer[readIndex + 1];
      this.readFrame = (this.readFrame + 1) % this.capacityFrames;
      this.bufferedFrames -= 1;
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
    });
  }
}

registerProcessor("kingz-pcm-renderer", KingzPcmRenderer);
