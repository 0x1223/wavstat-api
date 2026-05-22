# KINGZ LISTEN

Stable browser-mode LAN listener baseline for local Wi-Fi studio audio streaming.

## Scope

- Mobile-first Flutter UI
- Dark premium studio interface
- Local LAN WebSocket connection to `ws://SERVER_IP:PORT`
- `web_socket_channel` included for connection control
- Web Audio PCM playback bridge for Flutter web on iPhone Safari/Chrome

## Not Included Yet

- Accounts or login
- Cloud storage
- Payments
- Comments
- Waveforms
- DAW plugin
- JUCE/C++
- Admin dashboard

## Stable Browser-Mode LAN Runbook

Start the Node audio server first:

```sh
cd ~/wavstat/services/local_audio_server
npm start
```

The server prints the detected LAN IP. Use that IP on the iPhone.

Start the Flutter web listener on the LAN:

```sh
cd ~/wavstat/services/listener_app
flutter pub get
flutter run -d web-server --web-hostname 0.0.0.0 --web-port 55444
```

Open this URL on the iPhone while it is on the same Wi-Fi network:

```text
http://SERVER_LAN_IP:55444
```

In the app connection fields, use:

```text
Server IP: SERVER_LAN_IP
Port: 8080
```

Tap Connect, then Play.

If platform folders are not present yet, run:

```sh
flutter create .
```

from this directory, then rerun `flutter pub get`.

## Known Browser Limitation

iOS Safari/Chrome can suspend browser audio when the tab backgrounds, the
screen locks, or iOS interrupts media. The listener automatically attempts to
resume audio on foreground return. If iOS still requires a fresh user gesture,
the app shows `Tap to Resume Audio` without requiring Stop/Play.

## Baseline Status

This is the stable browser-mode baseline: LAN PCM transport, iPhone Web Audio
playback, controlled playback buffer, foreground recovery, and clean transport
telemetry are working. Keep this baseline intact before adding the next major
feature.
