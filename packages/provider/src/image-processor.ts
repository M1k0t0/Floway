// Image-recompression service used by provider-side interceptors that resize
// images before forwarding (Copilot's vision targets). The interface is here
// so provider packages depend only on @floway-dev/provider; the api wires the
// concrete impl (Cloudflare Images binding in production, in-memory stub in
// tests) via `initImageProcessor`.

export interface ImageDimensions {
  width: number;
  height: number;
}

// Maps a source image's pixel dimensions to the dimensions the compressor
// should fit the output within. Returned dimensions are an upper bound — the
// compressor scales down to fit but never enlarges past the source. This is
// the one intentional knob the egress passes in: per-model tile budgets plug
// in here (see `fitWithin`) without the processor learning any model specifics.
export type ImageSizeCalculator = (source: ImageDimensions) => ImageDimensions;

// A global image-recompression service, structured like the data Repo: one
// abstract surface with a per-platform implementation chosen at the entry
// point (Cloudflare Images binding in production, an in-memory stub in tests).
// Callers reach it through getImageProcessor(); they never pass the
// compression strategy itself around — only the size calculator above.
export interface ImageProcessor {
  // Re-encodes arbitrary raster image bytes to WebP at a fixed internal
  // quality, scaled to fit the calculator's target box. Throws if the bytes
  // cannot be decoded as an image; that failure is surfaced, not masked.
  compressToWebp(input: Uint8Array, targetSize: ImageSizeCalculator): Promise<Uint8Array>;
}

let _imageProcessor: ImageProcessor | null = null;

export const initImageProcessor = (processor: ImageProcessor): void => {
  _imageProcessor = processor;
};

export const getImageProcessor = (): ImageProcessor => {
  if (!_imageProcessor) throw new Error('Image processor not initialized — call initImageProcessor() first');
  return _imageProcessor;
};

export interface SizeCaps {
  maxLongEdge?: number;
  maxShortEdge?: number;
  maxArea?: number;
}

// Scales `source` DOWN (never up) to satisfy every present cap while preserving
// aspect ratio. This mirrors the server-side downscale each provider applies to
// images, so we never ship pixels the model would discard. With no caps the
// source passes through unchanged.
export const fitWithin = ({ width, height }: ImageDimensions, caps: SizeCaps): ImageDimensions => {
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const factors = [1];
  if (caps.maxLongEdge !== undefined) factors.push(caps.maxLongEdge / longEdge);
  if (caps.maxShortEdge !== undefined) factors.push(caps.maxShortEdge / shortEdge);
  if (caps.maxArea !== undefined) factors.push(Math.sqrt(caps.maxArea / (width * height)));
  const scale = Math.min(...factors);
  if (scale >= 1) return { width, height };
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
};

const BASE64_CHUNK = 0x8000;

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
  }
  return btoa(binary);
};

// Recompresses a raw base64 image payload (no data: prefix) to a base64 WebP
// payload via the global image processor.
export const compressBase64ImageToWebp = async (base64: string, targetSize: ImageSizeCalculator): Promise<string> => {
  const webp = await getImageProcessor().compressToWebp(base64ToBytes(base64), targetSize);
  return bytesToBase64(webp);
};

const BASE64_DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

export const isBase64ImageDataUrl = (url: string): boolean => BASE64_DATA_URL.exec(url)?.[1].startsWith('image/') ?? false;

// Recompresses a `data:image/*;base64,...` URL to a WebP data URL. Returns the
// original URL unchanged when it is not a base64 image data URL (e.g. a remote
// https image reference, which the egress forwards as-is).
export const compressImageDataUrlToWebp = async (url: string, targetSize: ImageSizeCalculator): Promise<string> => {
  const match = BASE64_DATA_URL.exec(url);
  if (!match?.[1].startsWith('image/')) return url;
  const webp = await compressBase64ImageToWebp(match[2], targetSize);
  return `data:image/webp;base64,${webp}`;
};
