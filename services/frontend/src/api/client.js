const BASE = (import.meta.env.VITE_API_URL || '') + '/digitizer';

export async function getHealth() {
  const r = await fetch(`${BASE}/health`);
  return r.json();
}

export async function getFormats() {
  const r = await fetch(`${BASE}/formats`);
  return r.json();
}

export async function digitizeImage(file, opts = {}) {
  const form = new FormData();
  form.append('image', file);
  if (opts.widthMm)         form.append('widthMm', opts.widthMm);
  if (opts.heightMm)        form.append('heightMm', opts.heightMm);
  if (opts.stitchesPerMm)   form.append('stitchesPerMm', opts.stitchesPerMm);
  if (opts.fillSpacingMm)   form.append('fillSpacingMm', opts.fillSpacingMm);
  if (opts.stitchLengthMm)  form.append('stitchLengthMm', opts.stitchLengthMm);
  if (opts.threshold)       form.append('threshold', opts.threshold);
  if (opts.colors)          form.append('colors', JSON.stringify(opts.colors));

  const r = await fetch(`${BASE}/digitize`, { method: 'POST', body: form });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(err.error || 'Digitize failed');
  }
  return r.json();
}

export async function exportStitches(format, stitches, opts = {}) {
  const r = await fetch(`${BASE}/export/${format}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stitches, ...opts }),
  });
  if (!r.ok) throw new Error(`Export failed: ${r.statusText}`);
  const blob = await r.blob();
  const cd = r.headers.get('Content-Disposition') || '';
  const match = cd.match(/filename="([^"]+)"/);
  return { blob, filename: match ? match[1] : `design.${format}` };
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
