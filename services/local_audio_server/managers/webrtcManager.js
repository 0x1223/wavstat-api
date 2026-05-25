const wrtc = require('@roamhq/wrtc');

class WebRtcManager {
  constructor({ clientManager, streamManager }) {
    this.clientManager = clientManager;
    this.streamManager = streamManager;
    this.sessions = new Map();
  }

  async handleOffer(client, message) {
    if (!message.sdp) {
      this.clientManager.send(client, {
        type: 'webrtc.error',
        message: 'missing_offer_sdp',
      });
      return;
    }

    await this.closeClient(client.id);

    const peer = new wrtc.RTCPeerConnection({
      iceServers: [],
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });
    const source = new wrtc.nonstandard.RTCAudioSource();
    const track = source.createTrack();
    const mediaStream = new wrtc.MediaStream([track]);
    const sinkId = `webrtc-${client.id}`;

    peer.addTrack(track, mediaStream);
    peer.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }

      this.clientManager.send(client, {
        type: 'webrtc.ice-candidate',
        candidate: event.candidate.toJSON(),
      });
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') {
        this.clientManager.send(client, { type: 'webrtc.connected' });
      }
      if (
        peer.connectionState === 'failed' ||
        peer.connectionState === 'closed' ||
        peer.connectionState === 'disconnected'
      ) {
        this.closeClient(client.id);
      }
    };

    const session = {
      clientId: client.id,
      peer,
      source,
      track,
      sinkId,
    };
    this.sessions.set(client.id, session);

    this.streamManager.addPcmSink(sinkId, (chunk) => {
      this.writePcmChunk(source, chunk);
    });
    this.streamManager.ensureRunning();

    await peer.setRemoteDescription({
      type: 'offer',
      sdp: message.sdp,
    });
    const answer = await peer.createAnswer();
    answer.sdp = this.preferProAudioSdp(answer.sdp);
    await peer.setLocalDescription(answer);

    this.clientManager.send(client, {
      type: 'webrtc.answer',
      sdp: peer.localDescription.sdp,
    });
  }

  async handleIceCandidate(client, message) {
    const session = this.sessions.get(client.id);
    if (!session || !message.candidate) {
      return;
    }

    try {
      await session.peer.addIceCandidate(new wrtc.RTCIceCandidate(message.candidate));
    } catch (error) {
      this.clientManager.send(client, {
        type: 'webrtc.error',
        message: 'ice_candidate_failed',
        detail: error.message,
      });
    }
  }

  async closeClient(clientId) {
    const session = this.sessions.get(clientId);
    if (!session) {
      return;
    }

    this.sessions.delete(clientId);
    this.streamManager.removePcmSink(session.sinkId);
    try {
      session.track.stop();
    } catch {}
    try {
      session.peer.close();
    } catch {}
  }

  writePcmChunk(source, chunk) {
    const channels = this.streamManager.source.format.channels;
    const sampleRate = this.streamManager.source.format.sampleRate;
    const bitsPerSample = this.streamManager.source.format.bitDepth;
    const framesPerPacket = 480;
    const bytesPerFrame = channels * (bitsPerSample / 8);
    const packetBytes = framesPerPacket * bytesPerFrame;

    if (channels !== 2 || sampleRate !== 48000 || bitsPerSample !== 16) {
      return;
    }

    for (let offset = 0; offset + packetBytes <= chunk.length; offset += packetBytes) {
      const samples = new Int16Array(framesPerPacket * channels);
      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = chunk.readInt16LE(offset + index * 2);
      }
      source.onData({
        samples,
        sampleRate,
        bitsPerSample,
        channelCount: channels,
        numberOfFrames: framesPerPacket,
      });
    }
  }

  preferProAudioSdp(sdp) {
    const lines = sdp.split('\r\n');
    const opusRtpMap = lines.find((line) =>
      /^a=rtpmap:\d+ opus\/48000\/2$/i.test(line),
    );
    if (!opusRtpMap) {
      return sdp;
    }

    const payloadType = opusRtpMap.split(/[ :]/)[1];
    const fmtpIndex = lines.findIndex((line) =>
      line.startsWith(`a=fmtp:${payloadType} `),
    );
    const fmtp =
      `a=fmtp:${payloadType} ` +
      'minptime=10;ptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=510000';

    if (fmtpIndex >= 0) {
      lines[fmtpIndex] = fmtp;
    } else {
      const rtpMapIndex = lines.indexOf(opusRtpMap);
      lines.splice(rtpMapIndex + 1, 0, fmtp);
    }

    const audioMidIndex = lines.findIndex((line) => line.startsWith('m=audio '));
    if (audioMidIndex >= 0) {
      const nextMediaIndex = lines.findIndex(
        (line, index) => index > audioMidIndex && line.startsWith('m='),
      );
      const audioEnd = nextMediaIndex >= 0 ? nextMediaIndex : lines.length;
      const bandwidthIndex = lines.findIndex(
        (line, index) =>
          index > audioMidIndex && index < audioEnd && line.startsWith('b=AS:'),
      );
      if (bandwidthIndex >= 0) {
        lines[bandwidthIndex] = 'b=AS:510';
      } else {
        const connectionIndex = lines.findIndex(
          (line, index) =>
            index > audioMidIndex && index < audioEnd && line.startsWith('c='),
        );
        lines.splice(connectionIndex >= 0 ? connectionIndex + 1 : audioMidIndex + 1, 0, 'b=AS:510');
      }
    }

    return lines.join('\r\n');
  }
}

module.exports = { WebRtcManager };
