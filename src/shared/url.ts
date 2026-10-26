const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

export function parseHttpUrl(value: unknown, base?: string): URL | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = base ? new URL(value, base) : new URL(value);
    if (!HTTP_PROTOCOLS.has(url.protocol)) return null;
    if (!url.hostname) return null;
    return url;
  } catch {
    return null;
  }
}

export function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && parseHttpUrl(value) !== null;
}

export function resolveHttpUrl(value: unknown, base: string): string | null {
  return parseHttpUrl(value, base)?.href ?? null;
}

export function getOrigin(value: string): string | null {
  const url = parseHttpUrl(value);
  return url ? url.origin : null;
}

export function getHostname(value: string): string | null {
  const url = parseHttpUrl(value);
  return url ? url.hostname : null;
}

export function pageReferer(value: string): string {
  const url = parseHttpUrl(value);
  if (!url) return '';
  return `${url.origin}/`;
}

export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'chrome-extension:') {
      return `${url.protocol}//${url.host}${url.pathname}`;
    }
    if (!HTTP_PROTOCOLS.has(url.protocol)) return '[非 HTTP 地址]';
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[无效地址]';
  }
}

export function extensionHint(value: string): string {
  const url = parseHttpUrl(value);
  if (!url) return '';
  const match = /\.([a-z0-9]{2,5})$/i.exec(url.pathname);
  return match?.[1]?.toLowerCase() ?? '';
}

const MEDIA_EXTENSIONS = /\.(mp4|m4v|webm|m3u8|mpd|ts|m4s|flv)$/i;

/**
 * 只根据 URL pathname 判断媒体后缀。不能检查完整 URL：
 * 统计分析地址可能在 query 中嵌入了媒体 URL，误判会记录无关请求。
 */
export function isMediaUrl(value: string): boolean {
  const url = parseHttpUrl(value);
  return Boolean(url && MEDIA_EXTENSIONS.test(url.pathname));
}

export function stripHash(value: string): string {
  const url = parseHttpUrl(value);
  if (!url) return value;
  url.hash = '';
  return url.href;
}
