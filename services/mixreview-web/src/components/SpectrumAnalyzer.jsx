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
  ctx.beginPath();
  for (let i = 0; i < points; i += 1) {
    const percent = i / (points - 1);
    const frequency = 20 * (1000 ** percent);
    const index = frequencyToIndex(frequency, sampleRate, data.length);
    const value = data[index] / 255;
    const x = percent * canvas.width;
    const y = canvas.height - value * canvas.height * 0.9;
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }

  const gradient = ctx.createLinearGradient(0, 0, canvas.width, 0);
  gradient.addColorStop(0, "#8ec78f");
  gradient.addColorStop(0.45, "#f1c15e");
  gradient.addColorStop(1, "#ffe0a3");
  ctx.strokeStyle = gradient;
  ctx.lineWidth = 2;
  ctx.shadowColor = "rgba(241, 193, 94, 0.38)";
  ctx.shadowBlur = 16;
  ctx.stroke();
  ctx.shadowBlur = 0;
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
