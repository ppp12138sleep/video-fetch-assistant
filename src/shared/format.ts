import type { MediaFormat } from './types';

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export interface FormatBytesOptions {
  approximate?: boolean;
  unknownText?: string;
}

export function formatBytes(
  bytes: number | null | undefined,
  options: FormatBytesOptions = {},
): string {
  const unknownText = options.unknownText ?? '大小未知';
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return unknownText;
  }
  if (bytes === 0) return options.approximate ? '约 0 B' : '0 B';

  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < SIZE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const unit = SIZE_UNITS[unitIndex] ?? 'B';
  const digits = unitIndex === 0 ? 0 : unitIndex >= 3 ? 2 : 1;
  const text = `${value.toFixed(digits)} ${unit}`;
  return options.approximate ? `约 ${text}` : text;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '时长未知';
  }
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

export function formatShortDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '未知';
  }
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (minutes < 60) return secs ? `${minutes} 分 ${secs} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

export function formatResolution(
  width: number | null | undefined,
  height: number | null | undefined,
): string {
  if (!width || !height || width <= 0 || height <= 0) return '分辨率未知';
  return `${Math.round(width)}×${Math.round(height)}`;
}

export function formatFrameRate(height: number | null | undefined): string {
  if (!height) return '';
  if (height >= 2160) return '4K';
  if (height >= 1440) return '2K';
  if (height >= 1080) return '1080P';
  if (height >= 720) return '720P';
  if (height >= 480) return '480P';
  return `${Math.round(height)}P`;
}

export function formatMediaFormat(format: MediaFormat): string {
  switch (format) {
    case 'mp4':
      return 'MP4';
    case 'webm':
      return 'WebM → MP4';
    case 'hls':
      return 'HLS → MP4';
    case 'dash':
      return 'DASH → MP4';
    case 'dash-tracks':
      return 'DASH 分轨 → MP4';
    default:
      return '格式未知';
  }
}

export function formatProgressPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return `${Math.min(100, Math.max(0, Math.round(value)))}%`;
}

export function formatDateForFilename(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function pluralSegments(done: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return `已处理 ${done} 个分片`;
  return `已处理 ${done} / ${total} 个分片`;
}
