// CasiWorks Pro - Save a file from the browser

/** Trigger a browser download of `data` as `filename`. */
export function downloadBlob(data: Blob | string, filename: string, mimeType = 'application/octet-stream'): void {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the download has been handed to the browser
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
