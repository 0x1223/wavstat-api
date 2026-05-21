import { useEffect, useMemo, useRef, useState } from "react";

const bands = [
  { label: "Low", from: 20, to: 250 },
  { label: "Mid", from: 250, to: 4000 },
  { label: "High", from: 4000, to: 20000 }
];

export function SpectrumAnalyzer({ mediaElement, isPlaying }) {
  const canvasRef = useRef(null);
  const [levels, setLevels] = useState({ High: 0, Low: 0, Mid: 0 });
  const isPlayingRef = useRef(isPlaying);
  const frequencyLabels = useMemo(() => ["20", "50", "100", "250", "500", "1k", "2k", "5k", "10k", "20k"], []);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !mediaElement) {
      return undefined;
    }

    let animationFrame = 0;
    let context;
    let source;
    let analyser;
    let disposed = false;
    let resumeContext;
    let displayData = null;
    let renderBuf = null;

    async function setupAnalyzer() {
      const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextConstructor) {
        drawIdle(canvas);
        return;
      }

      context = new AudioContextConstructor();
      analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.84;
      displayData = new Float32Array(analyser.frequencyBinCount);
      renderBuf = new Uint8Array(analyser.frequencyBinCount);
      resumeContext = () => context?.resume?.();
      mediaElement.addEventListener("play", resumeContext);

      if (mediaElement.captureStream) {
        source = context.createMediaStreamSource(mediaElement.captureStream());
        source.connect(analyser);
      } else {
        source = context.createMediaElementSource(mediaElement);
        source.connect(analyser);
        analyser.connect(context.destination);
      }

      draw();
    }

    function draw() {
      if (disposed || !analyser || !displayData) {
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));

      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawGrid(ctx, canvas);

      if (isPlayingRef.current) {
        analyser.getByteFrequencyData(renderBuf);
        for (let i = 0; i < renderBuf.length; i++) displayData[i] = renderBuf[i];
        drawSpectrum(ctx, canvas, renderBuf, context.sampleRate);
        updateBandLevels(renderBuf, context.sampleRate);
      } else {
        let anyActive = false;
        for (let i = 0; i < displayData.length; i++) {
          displayData[i] *= 0.82;
          if (displayData[i] > 0.5) anyActive = true;
          renderBuf[i] = (displayData[i] + 0.5) | 0;
        }
        if (anyActive) {
          drawSpectrum(ctx, canvas, renderBuf, context.sampleRate);
          updateBandLevels(renderBuf, context.sampleRate);
        } else {
          setLevels({ High: 0, Low: 0, Mid: 0 });
        }
      }

      animationFrame = requestAnimationFrame(draw);
    }

    function updateBandLevels(data, sampleRate) {
      const nextLevels = {};
      bands.forEach((band) => {
        const fromIndex = frequencyToIndex(band.from, sampleRate, data.length);
        const toIndex = frequencyToIndex(band.to, sampleRate, data.length);
        const values = data.slice(fromIndex, Math.max(fromIndex + 1, toIndex));
        nextLevels[band.label] = Math.round(
          values.reduce((total, value) => total + value, 0) / values.length,
        );
      });
      setLevels(nextLevels);
    }

    setupAnalyzer().catch(() => {
      drawIdle(canvas);
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      if (resumeContext) {
        mediaElement.removeEventListener("play", resumeContext);
      }
      source?.disconnect?.();
      analyser?.disconnect?.();
      context?.close?.();
    };
  }, [mediaElement]);

  return (
    <section className="spectrum-panel" aria-label="Frequency analyzer">
      <div className="spectrum-header">
        <div>
          <p className="eyebrow">Spectrum</p>
          <h2>Mastering analyzer</h2>
        </div>
        <div className="band-meter">
          {bands.map((band) => (
            <span key={band.label}>
              {band.label}
              <i style={{ inlineSize: `${Math.max(8, (levels[band.label] / 255) * 100)}%` }} />
            </span>
          ))}
        </div>
      </div>
      <div className="spectrum-canvas-wrap">
        <canvas ref={canvasRef} />
        <div className="frequency-labels">
          {frequencyLabels.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
      </div>
    </section>
  );
}

function drawGrid(ctx, canvas) {
  ctx.strokeStyle = "rgba(255, 255, 255, 0.07)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i += 1) {
    const y = (canvas.height / 5) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }
}

function drawSpectrum(ctx, canvas, data, sampleRate) {
  const points = 84;
  const W = canvas.width;
  const H = canvas.height;
  const slotW = W / points;
  const barW = Math.max(1, Math.round(slotW * 0.68));
  const r = Math.min(barW / 2, 3);

  const amps = new Float32Array(points);
  for (let i = 0; i < points; i++) {
    const freq = 20 * (1000 ** (i / (points - 1)));
    amps[i] = data[frequencyToIndex(freq, sampleRate, data.length)] / 255;
  }

  // Bloom pass
  ctx.save();
  ctx.globalAlpha = 0.16;
  for (let i = 0; i < points; i++) {
    if (amps[i] < 0.02) continue;
    const cx = (i / (points - 1)) * W;
    const barH = amps[i] * H * 0.9;
    const hue = Math.round(150 - (i / (points - 1)) * 100);
    ctx.shadowColor = `hsl(${hue},100%,68%)`;
    ctx.shadowBlur = 18;
    ctx.fillStyle = `hsl(${hue},90%,60%)`;
    ctx.fillRect(cx - barW, H - barH, barW * 2, barH);
  }
  ctx.restore();

  // Bars with vertical gradient and rounded tops
  ctx.save();
  for (let i = 0; i < points; i++) {
    const v = amps[i];
    if (v < 0.005) continue;
    const cx = (i / (points - 1)) * W;
    const x = cx - barW / 2;
    const barH = Math.max(2, v * H * 0.9);
    const y = H - barH;
    const hue = Math.round(150 - (i / (points - 1)) * 100);
    const grad = ctx.createLinearGradient(0, y, 0, H);
    grad.addColorStop(0, `hsl(${hue},96%,75%)`);
    grad.addColorStop(0.45, `hsl(${hue},88%,54%)`);
    grad.addColorStop(1, `hsl(${hue},78%,22%)`);
    ctx.shadowColor = `hsl(${hue},95%,65%)`;
    ctx.shadowBlur = 6;
    ctx.fillStyle = grad;
    fillRoundedTop(ctx, x, y, barW, barH, r);
    ctx.fill();
  }
  ctx.restore();
}

function fillRoundedTop(ctx, x, y, w, h, r) {
  const rx = Math.min(r, w / 2, h);
  if (!rx) { ctx.beginPath(); ctx.rect(x, y, w, h); return; }
  ctx.beginPath();
  ctx.moveTo(x + rx, y);
  ctx.lineTo(x + w - rx, y);
  ctx.arcTo(x + w, y, x + w, y + rx, rx);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + rx);
  ctx.arcTo(x, y, x + rx, y, rx);
  ctx.closePath();
}

function drawIdle(canvas) {
  if (!canvas) {
    return;
  }
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGrid(ctx, canvas);
}

function frequencyToIndex(frequency, sampleRate, length) {
  const nyquist = sampleRate / 2;
  return Math.min(length - 1, Math.max(0, Math.round((frequency / nyquist) * length)));
}
