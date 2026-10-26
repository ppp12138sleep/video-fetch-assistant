import { AppError } from '../../shared/errors';
import type { MediaCandidate, MediaFormat, PlatformId } from '../../shared/types';
import { extensionHint, parseHttpUrl } from '../../shared/url';
import { extractCommonMetadata } from '../metadata';
import {
  candidateFromRecord,
  dedupeCandidates,
  directCandidate,
  makeCandidate,
  pickBestCandidate,
} from './candidate-utils';
import type { AdapterContext, AdapterResult } from './types';

export interface VideoSourceInfo {
  url: string | null;
  kind: 'direct' | 'blob' | 'unknown';
}

export function getVideoSource(video: HTMLVideoElement): VideoSourceInfo {
  const current = video.currentSrc || video.src;
  if (!current) {
    const source = video.querySelector<HTMLSourceElement>('source[src]');
    const sourceUrl = source?.src || source?.getAttribute('src') || '';
    if (!sourceUrl) return { url: null, kind: 'unknown' };
    if (sourceUrl.startsWith('blob:')) return { url: null, kind: 'blob' };
    return parseHttpUrl(sourceUrl) ? { url: sourceUrl, kind: 'direct' } : { url: null, kind: 'unknown' };
  }
  if (current.startsWith('blob:')) return { url: null, kind: 'blob' };
  return parseHttpUrl(current) ? { url: current, kind: 'direct' } : { url: null, kind: 'unknown' };
}

export function sourceCandidate(
  source: VideoSourceInfo,
  width: number | null,
  height: number | null,
  requiresReferer: boolean,
): MediaCandidate | null {
  if (source.kind !== 'direct' || !source.url) return null;
  return directCandidate(source.url, {
    width,
    height,
    source: 'video-src',
    requiresReferer,
  });
}

export function candidatesFromRecords(
  records: AdapterContext['records'],
  width: number | null,
  height: number | null,
  requiresReferer: boolean,
): MediaCandidate[] {
  const candidates: MediaCandidate[] = [];
  for (const record of records) {
    const hint = extensionHint(record.url);
    if (hint === 'ts' || hint === 'm4s') continue;
    const candidate = candidateFromRecord(record, width, height, requiresReferer);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

export function isLikelyLoginWall(document: Document): boolean {
  const selectors = [
    '.login-panel-popover',
    '.bili-login-card',
    '[class*="login-modal"]',
    '[class*="login-dialog"]',
    '[data-e2e="login-guide"]',
  ];
  for (const selector of selectors) {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) continue;
    const style = getComputedStyle(element);
    if (style.display !== 'none' && style.visibility !== 'hidden' && element.offsetWidth > 0) {
      return true;
    }
  }
  return false;
}

export function finalizeResult(
  context: AdapterContext,
  options: {
    platformId: PlatformId;
    platformName: string;
    requiresReferer: boolean;
    extraCandidates?: MediaCandidate[];
    titleOverride?: string;
    coverOverride?: string;
    durationOverride?: number;
    isLiveOverride?: boolean;
    hasAudioOverride?: boolean | null;
  },
): AdapterResult {
  const metadata = extractCommonMetadata(
    context.document,
    context.video,
    options.platformId,
    context.pageUrl,
  );
  if (metadata.drmDetected) {
    throw new AppError('DRM_PROTECTED', 'video.mediaKeys 已启用');
  }
  const isLive = options.isLiveOverride ?? metadata.isLive;
  if (isLive) throw new AppError('LIVE_STREAM');

  const source = getVideoSource(context.video);
  const requiresReferer = options.requiresReferer;
  const candidates: MediaCandidate[] = [];
  const sourceItem = sourceCandidate(source, metadata.width, metadata.height, requiresReferer);
  if (sourceItem) candidates.push(sourceItem);
  candidates.push(
    ...candidatesFromRecords(context.records, metadata.width, metadata.height, requiresReferer),
  );
  if (options.extraCandidates?.length) candidates.push(...options.extraCandidates);
  const deduped = dedupeCandidates(
    candidates.filter((candidate) => {
      if (candidate.format === 'dash-tracks') {
        return candidate.tracks.some((track) => track.role === 'video');
      }
      return Boolean(candidate.url);
    }),
  );
  // 当前播放器的直链就是用户正在看的视频，优先于页面历史/preload 请求；
  // blob/MSE 场景没有直链，才按清单流优先排序。
  const best =
    source.kind === 'direct' && sourceItem
      ? sourceItem
      : pickBestCandidate(deduped, {
          preferStreaming: source.kind === 'blob',
        });
  if (!best) {
    if (isLikelyLoginWall(context.document)) throw new AppError('LOGIN_REQUIRED');
    if (source.kind === 'blob') {
      throw new AppError('BLOB_UNRESOLVED', 'MSE/blob 视频未捕获到可下载媒体地址');
    }
    throw new AppError('UNSUPPORTED_FORMAT', '适配器未找到可下载媒体地址');
  }

  const hasAudio =
    options.hasAudioOverride ??
    metadata.hasAudio ??
    (best.format === 'dash-tracks'
      ? best.tracks.some((track) => track.role === 'audio')
      : null);

  return {
    platformId: options.platformId,
    platformName: options.platformName,
    title: options.titleOverride?.trim() || metadata.title,
    ...(options.coverOverride || metadata.coverUrl
      ? { coverUrl: options.coverOverride || metadata.coverUrl }
      : {}),
    duration:
      options.durationOverride && options.durationOverride > 0
        ? options.durationOverride
        : metadata.duration,
    width: metadata.width ?? best.width ?? null,
    height: metadata.height ?? best.height ?? null,
    isLive,
    drmDetected: false,
    hasAudio,
    videoSrcKind: source.kind,
    candidates: [best],
  };
}

export function splitTrackCandidate(
  video: { url: string; width?: number; height?: number; bandwidth?: number; mimeType?: string; codecs?: string },
  audio: { url: string; bandwidth?: number; mimeType?: string; codecs?: string } | null,
  options: {
    label: string;
    requiresReferer: boolean;
    format?: MediaFormat;
    source?: 'network' | 'page-data';
  },
): MediaCandidate {
  return makeCandidate({
    format: options.format ?? 'dash-tracks',
    tracks: [
      {
        url: video.url,
        role: 'video',
        ...(video.width ? { width: video.width } : {}),
        ...(video.height ? { height: video.height } : {}),
        ...(video.bandwidth ? { bandwidth: video.bandwidth } : {}),
        ...(video.mimeType ? { mimeType: video.mimeType } : {}),
        ...(video.codecs ? { codecs: video.codecs } : {}),
      },
      ...(audio
        ? [
            {
              url: audio.url,
              role: 'audio' as const,
              ...(audio.bandwidth ? { bandwidth: audio.bandwidth } : {}),
              ...(audio.mimeType ? { mimeType: audio.mimeType } : {}),
              ...(audio.codecs ? { codecs: audio.codecs } : {}),
            },
          ]
        : []),
    ],
    width: video.width ?? null,
    height: video.height ?? null,
    label: options.label,
    source: options.source ?? 'page-data',
    requiresReferer: options.requiresReferer,
  });
}
