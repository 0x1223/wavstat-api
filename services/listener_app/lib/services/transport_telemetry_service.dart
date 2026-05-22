import '../models/realtime_stream_metrics.dart';
import '../models/stream_telemetry.dart';

class TransportTelemetryService {
  StreamTelemetry updateFromJson(
    Map<String, dynamic> json,
    StreamTelemetry fallback,
  ) {
    return StreamTelemetry.fromJson(json, fallback);
  }

  StreamTelemetry updateFromRealtime(
    RealtimeStreamMetrics metrics,
    StreamTelemetry fallback,
  ) {
    return fallback.copyWith(
      droppedPackets: metrics.droppedPackets.toString(),
      latency: '${metrics.smoothedLatencyMs} ms',
      bufferStatus: metrics.bufferTarget,
      networkStatus: metrics.qualityState,
    );
  }
}
