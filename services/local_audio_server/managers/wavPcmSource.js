const fs = require('node:fs');

class WavPcmSource {
  constructor(audioFile, chunkDurationMs = 20) {
    this.audioFile = audioFile;
    this.chunkDurationMs = chunkDurationMs;
    this.buffer = Buffer.alloc(0);
    this.dataOffset = 44;
    this.dataSize = 0;
    this.format = {
      sampleRate: 48000,
      bitDepth: 16,
      channels: 2,
      chunkDurationMs,
      encoding: 'pcm16le',
    };
  }

  load() {
    this.buffer = fs.readFileSync(this.audioFile);
    this.parseHeader();
    return this;
  }

  chunkBytes() {
    const bytesPerFrame = this.format.channels * (this.format.bitDepth / 8);
    const frames = Math.round(
      (this.format.sampleRate * this.chunkDurationMs) / 1000,
    );
    return frames * bytesPerFrame;
  }

  slice(offset) {
    const dataEnd = this.dataOffset + this.dataSize;
    const end = Math.min(offset + this.chunkBytes(), dataEnd);
    return {
      chunk: this.buffer.subarray(offset, end),
      end,
      dataEnd,
    };
  }

  parseHeader() {
    if (this.buffer.toString('ascii', 0, 4) !== 'RIFF' ||
        this.buffer.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('unsupported_wav_file');
    }

    let cursor = 12;
    while (cursor + 8 <= this.buffer.length) {
      const chunkId = this.buffer.toString('ascii', cursor, cursor + 4);
      const size = this.buffer.readUInt32LE(cursor + 4);
      const body = cursor + 8;

      if (chunkId === 'fmt ') {
        this.format = {
          sampleRate: this.buffer.readUInt32LE(body + 4),
          bitDepth: this.buffer.readUInt16LE(body + 14),
          channels: this.buffer.readUInt16LE(body + 2),
          chunkDurationMs: this.chunkDurationMs,
          encoding: 'pcm16le',
        };
      }

      if (chunkId === 'data') {
        this.dataOffset = body;
        this.dataSize = size;
        return;
      }

      cursor = body + size + (size % 2);
    }

    throw new Error('wav_data_chunk_missing');
  }
}

module.exports = { WavPcmSource };
