import { DOWNLOAD_FILENAME_MAX_BYTES, TITLE_FILENAME_MAX_CHARS } from './constants';
import { formatDateForFilename } from './format';

const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

const encoder = new TextEncoder();

function truncateToBytes(value: string, maxBytes: number): string {
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let result = '';
  for (const char of value) {
    if (encoder.encode(result + char).byteLength > maxBytes) break;
    result += char;
  }
  return result;
}

export function sanitizeFilenamePart(value: string, maxChars = TITLE_FILENAME_MAX_CHARS): string {
  let result = value
    .normalize('NFKC')
    .replace(ILLEGAL_CHARS, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();

  if (!result) result = '未命名视频';
  if (RESERVED_NAMES.test(result)) result = `_${result}`;
  result = truncateToBytes(result, Math.max(12, maxChars * 4));
  if (result.length > maxChars) {
    result = Array.from(result).slice(0, maxChars).join('').trim();
  }
  return result || '未命名视频';
}

export interface BuildFilenameOptions {
  platformName: string;
  title: string;
  width?: number | null;
  height?: number | null;
  date?: Date;
  extension?: string;
}

export function buildDownloadFilename(options: BuildFilenameOptions): string {
  const extension = (options.extension ?? 'mp4').replace(/^\./, '').replace(/[^a-z0-9]/gi, '') || 'mp4';
  const platform = sanitizeFilenamePart(options.platformName || '视频', 16);
  const title = sanitizeFilenamePart(options.title || '未命名视频');
  const resolution =
    options.width && options.height
      ? `${Math.round(options.width)}x${Math.round(options.height)}`
      : '';
  const parts = [platform, title, resolution, formatDateForFilename(options.date)].filter(Boolean);
  let base = parts.join('-').replace(/^[.\s]+|[.\s]+$/g, '');

  const suffix = `.${extension}`;
  const maxBaseBytes = Math.max(60, DOWNLOAD_FILENAME_MAX_BYTES - encoder.encode(suffix).byteLength);
  base = truncateToBytes(base, maxBaseBytes).replace(/[.\s]+$/g, '');
  if (!base) base = `视频-${formatDateForFilename(options.date).replace(/-/g, '')}`;
  return `${base}${suffix}`;
}
