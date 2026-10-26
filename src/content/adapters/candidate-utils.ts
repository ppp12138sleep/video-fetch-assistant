import { MEDIA_CONTENT_TYPE_PATTERN } from '../../shared/constants';
import type {
  CandidateSource,
  MediaCandidate,
  MediaFormat,
  MediaTrack,
  NetworkMediaRecord,
} from '../../shared/types';
import { extensionHint, isMediaUrl, parseHttpUrl } from '../../shared/url';

let candidateCounter = 0;

export function resetCandidateCounter(): void {
  candidateCounter = 0;
}

export function makeCandidate(input: {
  url?: string;
  tracks?: MediaTrack[];
  format: MediaFormat;
  contentType?: string;
  width?: number | null;
  height?: number | null;
  label?: string;
  source: CandidateSource;
  requiresReferer?: boolean;
}): MediaCandidate {
  candidateCounter += 1;
  const tracks = input.tracks ?? (input.url ? [{ url: input.url, role: 'muxed' as const }] : []);
  return {
    id: `c${candidateCounter}`,
    format: input.format,
    ...(input.url ? { url: input.url } : {}),
    tracks,
    ...(input.contentType ? { contentType: input.contentType } : {}),
    ...(input.width ? { width: input.width } : {}),
    ...(input.height ? { height: input.height } : {}),
    ...(input.label ? { label: input.label } : {}),
    source: input.source,
    ...(input.requiresReferer ? { requiresReferer: true } : {}),
  };
}

export function inferFormat(record: NetworkMediaRecord): MediaFormat {
  const hint = extensionHint(record.url);
  const contentType = record.contentType?.toLowerCase() ?? '';
  if (hint === 'm3u8' || contentType.includes('mpegurl')) return 'hls';
  if (hint === 'mpd' || contentType.includes('dash+xml')) return 'dash';
  if (hint === 'webm' || contentType.includes('webm')) return 'webm';
  if (hint === 'mp4' || hint === 'm4v' || contentType.includes('video/mp4')) return 'mp4';
  if (hint === 'm4s') return 'unknown';
  if (hint === 'ts') return 'unknown';
  if (contentType.startsWith('video/')) return 'mp4';
  return 'unknown';
}

export function candidateFromRecord(
  record: NetworkMediaRecord,
  width: number | null,
  height: number | null,
  requiresReferer = false,
): MediaCandidate | null {
  const mediaType =
    Boolean(record.contentType && MEDIA_CONTENT_TYPE_PATTERN.test(record.contentType)) ||
    Boolean(record.contentType?.startsWith('video/'));
  if (!isMediaUrl(record.url) && !mediaType) return null;
  const format = inferFormat(record);
  if (format === 'unknown' || format === 'webm' || format === 'mp4') {
    if (format === 'unknown') return null;
    return makeCandidate({
      url: record.url,
      format,
      contentType: record.contentType,
      width,
      height,
      source: record.source === 'performance' ? 'performance' : 'network',
      requiresReferer,
    });
  }
  if (format === 'hls' || format === 'dash') {
    return makeCandidate({
      url: record.url,
      format,
      contentType: record.contentType,
      source: record.source === 'performance' ? 'performance' : 'network',
      requiresReferer,
    });
  }
  return null;
}

export function directCandidate(
  url: string,
  options: {
    format?: MediaFormat;
    width?: number | null;
    height?: number | null;
    contentType?: string;
    source?: CandidateSource;
    requiresReferer?: boolean;
    label?: string;
  } = {},
): MediaCandidate | null {
  const parsed = parseHttpUrl(url);
  if (!parsed) return null;
  const hint = extensionHint(parsed.href);
  let format = options.format;
  if (!format) {
    if (hint === 'm3u8') format = 'hls';
    else if (hint === 'mpd') format = 'dash';
    else if (hint === 'webm') format = 'webm';
    else format = 'mp4';
  }
  return makeCandidate({
    url: parsed.href,
    format,
    ...(options.width ? { width: options.width } : {}),
    ...(options.height ? { height: options.height } : {}),
    ...(options.contentType ? { contentType: options.contentType } : {}),
    source: options.source ?? 'video-src',
    ...(options.requiresReferer ? { requiresReferer: true } : {}),
    ...(options.label ? { label: options.label } : {}),
  });
}

export function splitDashRecords(
  records: NetworkMediaRecord[],
): { video: NetworkMediaRecord[]; audio: NetworkMediaRecord[] } {
  const videos: NetworkMediaRecord[] = [];
  const audios: NetworkMediaRecord[] = [];
  for (const record of records) {
    if (!isMediaUrl(record.url)) continue;
    const hint = extensionHint(record.url);
    if (hint !== 'm4s') continue;
    let path = '';
    try {
      path = new URL(record.url).pathname.toLowerCase();
    } catch {
      continue;
    }
    // B 站 DASH 的音频文件常返回 application/octet-stream，且路径不含 audio。
    // 30216/30232/30280 等是页面播放器公开的音频清晰度编号，用于区分音轨。
    const bilibiliAudioCode = /[-_/](30216|30232|30280|30250|30251|30255)\.m4s$/i.test(path);
    if (
      bilibiliAudioCode ||
      /\/audio(?:\.m4s)?$/.test(path) ||
      path.includes('audio') ||
      record.contentType?.startsWith('audio/')
    ) {
      audios.push(record);
    } else if (
      /\/video(?:\.m4s)?$/.test(path) ||
      path.includes('video') ||
      record.contentType?.startsWith('video/')
    ) {
      videos.push(record);
    }
  }
  return { video: videos, audio: audios };
}

const FORMAT_RANK: Record<MediaFormat, number> = {
  'dash-tracks': 60,
  mp4: 50,
  hls: 40,
  dash: 30,
  webm: 20,
  unknown: 0,
};

export interface PickCandidateOptions {
  /** blob/MSE 播放时，优先当前清单流，避免误选页面早先预加载的 MP4。 */
  preferStreaming?: boolean;
}

export function pickBestCandidate(
  candidates: MediaCandidate[],
  options: PickCandidateOptions = {},
): MediaCandidate | null {
  const available = candidates.filter((candidate) => {
    if (!candidate.tracks.length) return false;
    if (candidate.format === 'dash-tracks') {
      return candidate.tracks.some((track) => track.role === 'video');
    }
    return Boolean(candidate.url);
  });
  if (!available.length) return null;
  const streaming = available.filter(
    (candidate) => candidate.format === 'hls' || candidate.format === 'dash' || candidate.format === 'dash-tracks',
  );
  const pool = options.preferStreaming && streaming.length ? streaming : available;
  return [...pool].sort((left, right) => {
    const rankDelta = FORMAT_RANK[right.format] - FORMAT_RANK[left.format];
    if (rankDelta !== 0) return rankDelta;
    const rightPixels = (right.width ?? 0) * (right.height ?? 0);
    const leftPixels = (left.width ?? 0) * (left.height ?? 0);
    if (rightPixels !== leftPixels) return rightPixels - leftPixels;
    return 0;
  })[0]!;
}

export function dedupeCandidates(candidates: MediaCandidate[]): MediaCandidate[] {
  const seen = new Set<string>();
  const result: MediaCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = candidate.tracks.map((track) => `${track.role}:${track.url}`).join('|') || candidate.id;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}
