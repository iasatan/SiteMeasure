import { createId, type ProjectPhoto } from '../domain/models';

export interface PhotoProcessingOptions {
  maxDimension?: number;
  quality?: number;
  mimeType?: 'image/jpeg' | 'image/webp';
}

const MAX_SOURCE_BYTES = 30 * 1024 * 1024;

export function resizedDimensions(width: number, height: number, maxDimension: number): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('The selected image has invalid dimensions.');
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function processPhoto(file: File, options: PhotoProcessingOptions = {}): Promise<{ photo: ProjectPhoto; blob: Blob }> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
  if (file.size > MAX_SOURCE_BYTES) throw new Error('The selected photo is larger than the 30 MB processing limit.');

  const maxDimension = options.maxDimension ?? 1600;
  const quality = options.quality ?? 0.78;
  const mimeType = options.mimeType ?? 'image/jpeg';
  const bitmap = await decodeImage(file);
  try {
    const dimensions = resizedDimensions(bitmap.width, bitmap.height, maxDimension);
    const canvas = document.createElement('canvas');
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Photo processing is unavailable in this browser.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, dimensions.width, dimensions.height);
    context.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height);
    const blob = await canvasBlob(canvas, mimeType, quality);
    const photo: ProjectPhoto = {
      id: createId(),
      title: file.name.replace(/\.[^.]+$/, '') || 'Site photo',
      notes: '',
      storageId: createId(),
      mimeType: blob.type === 'image/webp' ? 'image/webp' : 'image/jpeg',
      width: dimensions.width,
      height: dimensions.height,
      sizeBytes: blob.size,
      capturedAt: new Date().toISOString(),
      annotations: [],
    };
    return { photo, blob };
  } finally {
    bitmap.close();
  }
}

async function decodeImage(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (cause) {
    throw new Error('The selected image could not be decoded.', { cause });
  }
}

function canvasBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('The photo could not be compressed.')), mimeType, quality);
  });
}
