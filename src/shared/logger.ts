import { safeErrorDetail } from './errors';

export function sanitizeLogText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[已脱敏链接]')
    .replace(/blob:[^\s"'<>]+/gi, '[blob 地址]')
    .replace(/[?&](token|sign|signature|key|auth|expires|deadline)=[^&\s]+/gi, '$1=[已脱敏]')
    .slice(0, 500);
}

export function logWarn(scope: string, code: string, error?: unknown): void {
  const detail = error === undefined ? '' : safeErrorDetail(error);
  if (detail) {
    console.warn(`[视频获取助手:${scope}] ${code} — ${sanitizeLogText(detail)}`);
  } else {
    console.warn(`[视频获取助手:${scope}] ${code}`);
  }
}

export function logInfo(scope: string, message: string): void {
  console.info(`[视频获取助手:${scope}] ${sanitizeLogText(message)}`);
}
