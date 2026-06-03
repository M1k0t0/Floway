import { imageSize } from 'image-size';

import type { ImageDimensions, ImageProcessor, ImageSizeCalculator } from '@floway-dev/provider';

// Fixed WebP quality for every recompressed inline image. 82 sits above the
// cwebp / photographic default of 75 so screenshots and text-heavy UI images —
// the bulk of Copilot traffic — survive our lossy pass before the upstream
// provider applies its own downscale and re-encode, while keeping the bandwidth
// win. Confirmed on real traffic: the production Cloudflare Images encoder at
// q82 matches local cwebp within <0.1 dB PSNR. References:
// - https://developers.google.com/speed/webp/docs/cwebp (default quality 75)
// - https://platform.claude.com/docs/en/build-with-claude/vision (multi-pass
//   compression warning)
// - https://getwebp.com/blog/screenshots-webp-settings-text-ui
const WEBP_QUALITY = 82;

const CACHE_KEY_PREFIX = 'imgwebp';

// Compressed results are content-addressed (keyed by source hash + transform),
// so they never go stale; the TTL exists only to bound storage. The cache pays
// off across a single conversation's lifetime — the same inline image resent
// each turn — so 30 days comfortably covers long sessions while letting
// one-off images age out.
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

// Minimal shapes of the Cloudflare bindings we depend on, hand-typed (like
// D1Database) so the runtime contract does not pull in the full
// @cloudflare/workers-types surface. We use only the transform/output path of
// the Images binding; `info()` is intentionally not modelled because it is
// billed per call — we read dimensions locally via image-size instead.
// Reference: https://developers.cloudflare.com/images/transform-images/bindings/
export interface ImagesBinding {
  input(stream: ReadableStream): ImageTransformer;
}

interface ImageTransformer {
  transform(options: ImageTransformOptions): ImageTransformer;
  output(options: ImageOutputOptions): Promise<ImageTransformationResult>;
}

interface ImageTransformOptions {
  width?: number;
  height?: number;
  fit?: 'scale-down' | 'contain' | 'cover' | 'crop' | 'pad';
}

interface ImageOutputOptions {
  format: string;
  quality?: number;
}

interface ImageTransformationResult {
  image(): ReadableStream;
}

// Subset of the KV namespace binding used to memoise compressed results. The
// Images binding does not deduplicate or cache transformations, so the same
// inline image resent across conversation turns would otherwise be re-billed
// every time; this cache makes a repeat a single KV read instead. `put`
// requires an explicit TTL so no caller can accidentally write an entry that
// never expires.
export interface ImageCacheKv {
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
  put(key: string, value: ArrayBuffer | ArrayBufferView, expirationTtl: number): Promise<void>;
}

const streamFrom = (bytes: Uint8Array): ReadableStream =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  // Copy into a fresh ArrayBuffer-backed view so the digest argument is a
  // concrete BufferSource regardless of the input's ArrayBufferLike type param.
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

class CloudflareImageProcessor implements ImageProcessor {
  constructor(
    private readonly images: ImagesBinding,
    private readonly cache: ImageCacheKv,
  ) {}

  async compressToWebp(input: Uint8Array, targetSize: ImageSizeCalculator): Promise<Uint8Array> {
    // Resize only when the source dimensions are readable; bytes image-size
    // cannot decode are re-encoded to WebP without a resize. Dimensions are
    // read locally (not via the billed Images `info()` binding).
    let target: ImageDimensions | null = null;
    try {
      const { width, height } = imageSize(input);
      if (width !== undefined && height !== undefined) target = targetSize({ width, height });
    } catch {
      target = null;
    }

    // Key on the original bytes plus the exact transform we will request, so
    // every distinct (source, target size, encoder params) combination is a
    // separate entry and a changed quality or per-model size never serves a
    // stale result.
    const targetKey = target ? `${target.width}x${target.height}` : 'orig';
    const key = `${CACHE_KEY_PREFIX}:${await sha256Hex(input)}:${targetKey}:webp:q${WEBP_QUALITY}`;

    const cached = await this.cache.get(key, 'arrayBuffer');
    if (cached) return new Uint8Array(cached);

    let transformer = this.images.input(streamFrom(input));
    if (target) transformer = transformer.transform({ width: target.width, height: target.height, fit: 'scale-down' });
    const result = await transformer.output({ format: 'image/webp', quality: WEBP_QUALITY });
    const output = new Uint8Array(await new Response(result.image()).arrayBuffer());

    await this.cache.put(key, output, CACHE_TTL_SECONDS);
    return output;
  }
}

export const createCloudflareImageProcessor = (images: ImagesBinding, cache: ImageCacheKv): ImageProcessor => new CloudflareImageProcessor(images, cache);
