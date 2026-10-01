/**
 * Post images on Cloudflare R2.
 *
 * Every upload is normalized before it leaves the process: EXIF rotation
 * applied, width capped at 1440px (no upscale), re-encoded as JPEG q85 with
 * metadata stripped. Aspect ratio must already fit Instagram (4:5 .. 1.91:1);
 * we refuse instead of cropping so nobody gets a silently mangled image.
 * Size (<= 40 MP) and ratio are checked from the header before decoding.
 */

import { randomUUID } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import sharp, { type Metadata } from 'sharp';
import { ErrorCode, MCPError } from '../../types/errors.js';
import { createServiceLogger } from '../../utils/logger.js';

const log = createServiceLogger('r2-media');

export interface StoredMedia { url: string; key: string; width: number; height: number; bytes: number }

export const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_WIDTH = 1440;
const MIN_RATIO = 0.8;
const MAX_RATIO = 1.91;
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface R2Config { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; publicBase: string }

function readConfig(): R2Config {
  const env = (k: string) => process.env[k]?.trim() ?? '';
  const config = {
    accountId: env('R2_ACCOUNT_ID'),
    accessKeyId: env('R2_ACCESS_KEY_ID'),
    secretAccessKey: env('R2_SECRET_ACCESS_KEY'),
    bucket: env('R2_BUCKET'),
    publicBase: env('R2_PUBLIC_BASE_URL').replace(/\/+$/, ''),
  };
  if (Object.values(config).some(v => !v)) {
    throw MCPError.authError(
      'El almacenamiento de imágenes (Cloudflare R2) no está configurado. Complete las credenciales de R2 en Configuración.',
      ErrorCode.AUTH_NOT_CONFIGURED,
    );
  }
  return config;
}

function scrub(text: string, secret: string): string {
  return secret ? text.split(secret).join('***') : text;
}

async function normalize(input: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  if (input.length > MAX_INPUT_BYTES) throw MCPError.validationError('La imagen supera el máximo de 8 MB.');
  let meta: Metadata;
  try {
    // Header read only; the pixel limit is checked below to give a specific message.
    meta = await sharp(input, { limitInputPixels: false }).metadata();
  } catch {
    throw MCPError.validationError('No se pudo leer la imagen; el archivo está dañado o no es una imagen.');
  }
  if (!meta.format || !ACCEPTED_FORMATS.has(meta.format)) throw MCPError.validationError('Formato no admitido: use JPEG, PNG o WebP.');
  // Header-only checks, before any pixel is decoded.
  if (!meta.width || !meta.height) throw MCPError.validationError('No se pudo leer la imagen; el archivo está dañado o no es una imagen.');
  if (meta.width * meta.height > MAX_INPUT_PIXELS) {
    throw MCPError.validationError('La imagen supera el máximo de 40 megapíxeles; redúzcala antes de subirla.');
  }
  // EXIF orientations 5-8 are rotated 90°, so the displayed width is the stored height.
  const swapped = (meta.orientation ?? 1) >= 5;
  const [w, h] = swapped ? [meta.height, meta.width] : [meta.width, meta.height];
  const ratio = w / h;
  if (ratio < MIN_RATIO || ratio > MAX_RATIO) {
    throw MCPError.validationError(
      `La proporción de la imagen (${w}x${h}) no es válida para Instagram: debe estar entre 4:5 vertical y 1.91:1 horizontal. Recórtela antes de subirla.`,
    );
  }
  const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 85 })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

export async function storePostImage(siteId: string, input: Buffer): Promise<StoredMedia> {
  if (!UUID_RE.test(siteId)) throw MCPError.validationError('El identificador del sitio no es válido.');
  const config = readConfig();
  const { data, width, height } = await normalize(input);

  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const key = `sites/${siteId}/${now.getUTCFullYear()}/${month}/${randomUUID()}.jpg`;
  const client = new AwsClient({
    accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, service: 's3', region: 'auto', retries: 0,
  });
  let status: number;
  try {
    const res = await client.fetch(`https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}/${key}`, {
      method: 'PUT', body: data, headers: { 'Content-Type': 'image/jpeg' },
    });
    status = res.status;
  } catch (err) {
    const msg = scrub(err instanceof Error ? err.message : String(err), config.secretAccessKey);
    log.error('R2 upload failed', { siteId, error: new Error(msg) });
    throw MCPError.externalServiceError('Cloudflare R2', 'No se pudo subir la imagen; intente de nuevo.');
  }
  if (status < 200 || status >= 300) {
    // The response body is never echoed back: it may carry request details.
    log.error('R2 upload rejected', { siteId, status });
    throw MCPError.externalServiceError('Cloudflare R2', `La subida de la imagen fue rechazada (HTTP ${status}).`, status >= 500);
  }
  log.info('Post image stored', { siteId, key, bytes: data.length });
  return { url: `${config.publicBase}/${key}`, key, width, height, bytes: data.length };
}
