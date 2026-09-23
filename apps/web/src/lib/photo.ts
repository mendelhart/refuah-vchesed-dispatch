/**
 * Shrinks a picture from the phone's camera or gallery to a small square-ish
 * JPEG for the ID card (longest side 480px), so uploads stay around 30-60 KB.
 */
export async function photoFileToDataUrl(file: File, maxSide = 480): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose a picture (JPEG or PNG).');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('That picture could not be opened. Try a JPEG or PNG.'));
      el.src = url;
    });
    const max = maxSide;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot resize pictures.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}
