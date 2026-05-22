# KINGZ Local Audio Server

Stable browser-mode LAN audio server baseline for KINGZ LISTEN.

## Run

```sh
npm install
npm start
```

The server listens on port `8080`.

Startup logs include:

- local bind address
- localhost URL
- detected LAN IP
- LAN HTTP URL
- LAN WebSocket URL

Use the detected LAN IP in the Flutter listener app on iPhone.

## Endpoints

- `ws://localhost:8080` WebSocket listener connection
- `http://localhost:8080/health` HTTP health check
- `http://localhost:8080/metadata` stream metadata and playback URLs
- `http://localhost:8080/audio/test.wav` direct local WAV file
- `http://localhost:8080/stream` byte-range audio stream for listener playback

## Protocol

The WebSocket server sends lightweight JSON messages:

- `connection.status`
- `stream.status`
- `stream.telemetry`
- `server.ping`
- `realtime.audio.chunk`

Realtime chunks include stream session id, server clock, sequence number, and
rolling timing diagnostics for send interval, jitter, drift, and pacing.
Engine snapshots include PCM format placeholders, stream lifecycle, and
monitoring mode config for low latency, balanced, and safe buffer operation.
The default WebSocket stream sends real PCM-style chunks from `audio/test.wav`
as `realtime.pcm.chunk` messages while keeping HTTP WAV playback available as
a fallback.
PCM simulation adds sample frame metadata, packet delay, packet loss,
underrun markers, and periodic transport diagnostics logging when a stress
mode is explicitly enabled.
Stress simulation can be switched with `simulation.set` using `baseline`,
`stress`, or `recovery` modes for latency spikes, packet bursts, temporary
disconnects, recovery timing, and adaptive buffer switching rehearsal.

The Flutter app can send:

- `client.ping`
- `listen.start`
- `listen.stop`

## iPhone LAN Setup

Start this server:

```sh
cd ~/wavstat/services/local_audio_server
npm start
```

Start the Flutter web listener from the listener app directory:

```sh
flutter run -d web-server --web-hostname 0.0.0.0 --web-port 55444
```

On iPhone, open:

```text
http://SERVER_LAN_IP:55444
```

Use these listener settings:

```text
Server IP: SERVER_LAN_IP
Port: 8080
```

## Stable Browser-Mode Baseline

This baseline supports LAN PCM streaming from the desktop Node server to the
Flutter web listener on iPhone. Audio playback uses the browser Web Audio API.
iOS may suspend browser audio during backgrounding, screen lock, or media
interruptions; the listener attempts automatic recovery and can request a tap
to resume audio if iOS requires a user gesture.

This is intentionally a local browser-mode path only: Mac to local server to
listener app.
