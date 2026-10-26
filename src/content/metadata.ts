import type { PlatformId } from '../shared/types';
import { parseHttpUrl } from '../shared/url';

export interface CommonMetadata {
  title: string;
  coverUrl?: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  isLive: boolean;
  drmDetected: boolean;
  hasAudio: boolean | null;
}

const SITE_SUFFIXES = [
  '哔哩哔哩',
  'bilibili',
  '抖音',
  'douyin',
  '快手',
  'kuaishou',
  'YouTube',
  '西瓜视频',
];

function metaContent(document: Document, selector: string): string | undefined {
  const element = document.querySelector<HTMLMetaElement>(selector);
  return element?.content?.trim() || undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => Boolean(value?.trim()));
}

function textOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function findJsonLdVideo(document: Document): Record<string, unknown> | null {
  const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'));
  const queue: unknown[] = [];
  for (const script of scripts) {
    const text = script.textContent?.trim();
    if (!text || text.length > 500_000) continue;
    try {
      queue.push(JSON.parse(text));
    } catch {
      // 页面可能包含非标准 JSON-LD，跳过。
    }
  }
  while (queue.length) {
    const value = queue.shift();
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const type = record['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.some((item) => typeof item === 'string' && /VideoObject|Video/i.test(item))) {
      return record;
    }
    if (record['@graph']) queue.push(record['@graph']);
  }
  return null;
}

export function parseLooseIsoDuration(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match =
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(value.trim());
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  const total = days * 86400 + hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(total) && total > 0 ? total : null;
}

export function cleanVideoTitle(rawTitle: string, siteName?: string): string {
  let title = rawTitle.replace(/\s+/g, ' ').trim();
  title = title.replace(/[_|]\s*哔哩哔哩\s*[_|]?\s*bilibili\s*$/i, '').trim();
  const suffixes = [...SITE_SUFFIXES, siteName].filter(
    (item): item is string => Boolean(item?.trim()),
  );
  for (const suffix of suffixes) {
    const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    title = title.replace(new RegExp(`\\s*[-–—|_]\\s*${escaped}\\s*$`, 'i'), '').trim();
  }
  title = title.replace(/\s*[-–—|_]\s*$/, '').trim();
  return title || rawTitle.trim() || '未命名视频';
}

export function detectPageIsLive(platformId: PlatformId, pageUrl: string, duration: number | null): boolean {
  if (duration === Number.POSITIVE_INFINITY) return true;
  let path = '';
  try {
    path = new URL(pageUrl).pathname.toLowerCase();
  } catch {
    path = '';
  }
  if (platformId === 'douyin') return path.startsWith('/live/') || path.includes('/live');
  if (platformId === 'kuaishou') return path.includes('/live/');
  if (platformId === 'bilibili') return path.startsWith('/live/') || path.startsWith('/blanc/');
  return false;
}

export function detectDrm(video: HTMLVideoElement): boolean {
  const candidate = video as HTMLVideoElement & {
    mediaKeys?: unknown;
    webkitKeys?: unknown;
  };
  if (candidate.mediaKeys || candidate.webkitKeys) return true;
  return false;
}

export function detectHasAudio(video: HTMLVideoElement): boolean | null {
  const candidate = video as HTMLVideoElement & {
    mozHasAudio?: boolean;
    webkitAudioDecodedByteCount?: number;
    audioTracks?: { length?: number };
  };
  if (typeof candidate.mozHasAudio === 'boolean') return candidate.mozHasAudio;
  if (typeof candidate.audioTracks?.length === 'number') return candidate.audioTracks.length > 0;
  if (typeof candidate.webkitAudioDecodedByteCount === 'number' && candidate.webkitAudioDecodedByteCount > 0) {
    return true;
  }
  return null;
}

function validCover(value: string | undefined, pageUrl: string): string | undefined {
  if (!value) return undefined;
  const parsed = parseHttpUrl(value, pageUrl);
  return parsed?.href;
}

export function extractCommonMetadata(
  document: Document,
  video: HTMLVideoElement,
  platformId: PlatformId,
  pageUrl: string,
): CommonMetadata {
  const jsonLd = findJsonLdVideo(document);
  const siteName = metaContent(document, 'meta[property="og:site_name"]');
  const ogTitle = metaContent(document, 'meta[property="og:title"]');
  const twitterTitle = metaContent(document, 'meta[name="twitter:title"]');
  const jsonLdName = textOrUndefined(jsonLd?.name) ?? textOrUndefined(jsonLd?.headline);
  const rawTitle =
    firstNonEmpty(jsonLdName, ogTitle, twitterTitle) ??
    document.title ??
    video.getAttribute('aria-label') ??
    '未命名视频';
  const title = cleanVideoTitle(rawTitle, siteName);

  const ogImage = metaContent(document, 'meta[property="og:image"]');
  const twitterImage = metaContent(document, 'meta[name="twitter:image"]');
  const jsonLdImage = textOrUndefined(jsonLd?.thumbnailUrl) ?? textOrUndefined(jsonLd?.image);
  const coverUrl = validCover(
    firstNonEmpty(ogImage, twitterImage, jsonLdImage, video.poster),
    pageUrl,
  );

  const metaDuration =
    parseLooseIsoDuration(jsonLd?.duration) ??
    (() => {
      const raw = metaContent(document, 'meta[property="video:duration"]');
      const parsed = raw ? Number(raw) : Number.NaN;
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    })();

  const rawDuration = Number.isFinite(video.duration) ? video.duration : null;
  const duration = rawDuration && rawDuration > 0 ? rawDuration : metaDuration;

  const widthFromVideo = video.videoWidth > 0 ? video.videoWidth : null;
  const heightFromVideo = video.videoHeight > 0 ? video.videoHeight : null;
  const widthMeta = Number(metaContent(document, 'meta[property="og:video:width"]'));
  const heightMeta = Number(metaContent(document, 'meta[property="og:video:height"]'));
  const width =
    widthFromVideo ??
    (Number.isFinite(widthMeta) && widthMeta > 0 ? widthMeta : null) ??
    null;
  const height =
    heightFromVideo ??
    (Number.isFinite(heightMeta) && heightMeta > 0 ? heightMeta : null) ??
    null;

  const isLive =
    detectPageIsLive(platformId, pageUrl, rawDuration) ||
    (duration === null && metaContent(document, 'meta[property="og:type"]') === 'video.live');

  return {
    title,
    ...(coverUrl ? { coverUrl } : {}),
    duration: duration ?? null,
    width,
    height,
    isLive,
    drmDetected: detectDrm(video),
    hasAudio: detectHasAudio(video),
  };
}
