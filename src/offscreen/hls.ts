import { AppError } from '../shared/errors';
import {
  estimateHlsSizeBytes,
  parseHlsPlaylist,
  selectAudioRendition,
  selectHlsVariant,
} from '../shared/m3u8';
import type {
  HlsKey,
  HlsMasterPlaylist,
  HlsMediaPlaylist,
  HlsSegment,
  HlsVariant,
} from '../shared/m3u8';
import { extensionHint } from '../shared/url';
import { asBlobPart, toArrayBuffer } from './bytes';
import { downloadStreamToStore, fetchBytes, fetchText, fetchWithTimeout, MAX_TEMP_BYTES } from './fetch-utils';
import type { TempStore } from './temp-store';

export interface HlsTrackPlan {
  playlist: HlsMediaPlaylist;
  fmp4: boolean;
  role: 'video' | 'audio';
}

export interface HlsPlan {
  masterUrl: string;
  sourceUrl: string;
  video: HlsTrackPlan;
  audio?: HlsTrackPlan;
  duration: number;
  width?: number;
  height?: number;
  variant?: HlsVariant;
  sizeEstimate: number | null;
  externalAudio: boolean;
}

export interface HlsProgress {
  done: number;
  total: number;
  bytes: number;
}

function isFmp4Playlist(playlist: HlsMediaPlaylist): boolean {
  return playlist.segments.some((segment) => {
    if (segment.initMap) return true;
    const hint = extensionHint(segment.uri);
    return hint === 'm4s' || hint === 'mp4' || hint === 'm4v';
  });
}

function isDrmPlaylist(playlist: HlsMediaPlaylist): boolean {
  return (
    playlist.drmDetected ||
    playlist.segments.some((segment) => {
      const method = segment.key?.method?.toUpperCase();
      return Boolean(method && method !== 'AES-128');
    })
  );
}

async function loadPlaylist(url: string, signal: AbortSignal) {
  try {
    const text = await fetchText(url, signal);
    return parseHlsPlaylist(text, url);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('PARSE_FAILED', error instanceof Error ? error.message : undefined);
  }
}

function ensureVodPlaylist(playlist: HlsMediaPlaylist): void {
  if (playlist.isLive) throw new AppError('LIVE_STREAM', 'HLS 媒体清单没有 #EXT-X-ENDLIST');
  if (!playlist.segments.length) throw new AppError('PARSE_FAILED', 'HLS 媒体清单没有分片');
  if (isDrmPlaylist(playlist)) throw new AppError('DRM_PROTECTED', 'HLS 使用了 SAMPLE-AES 或未知密钥体系');
}

export async function resolveHlsPlan(
  manifestUrl: string,
  signal: AbortSignal,
  maxHeight = 1080,
): Promise<HlsPlan> {
  const parsed = await loadPlaylist(manifestUrl, signal);
  if (parsed.type === 'media') {
    ensureVodPlaylist(parsed);
    const bandwidth = parsed.averageBitrate;
    return {
      masterUrl: manifestUrl,
      sourceUrl: manifestUrl,
      video: { playlist: parsed, fmp4: isFmp4Playlist(parsed), role: 'video' },
      duration: parsed.totalDuration,
      ...(bandwidth
        ? { sizeEstimate: estimateHlsSizeBytes(bandwidth, parsed.totalDuration) }
        : { sizeEstimate: null }),
      externalAudio: false,
    };
  }
  return resolveMaster(parsed, signal, maxHeight);
}

async function resolveMaster(
  master: HlsMasterPlaylist,
  signal: AbortSignal,
  maxHeight: number,
): Promise<HlsPlan> {
  if (master.drmDetected) throw new AppError('DRM_PROTECTED', 'HLS 主清单包含受保护的 SESSION-KEY');
  const variant = selectHlsVariant(master, maxHeight);
  const videoParsed = await loadPlaylist(variant.uri, signal);
  if (videoParsed.type !== 'media') {
    throw new AppError('PARSE_FAILED', 'HLS 码率变体指向了另一个主清单');
  }
  ensureVodPlaylist(videoParsed);

  let audio: HlsTrackPlan | undefined;
  let audioBandwidth = 0;
  if (variant.audioGroup) {
    const rendition = selectAudioRendition(master, variant.audioGroup);
    if (rendition?.uri) {
      const audioParsed = await loadPlaylist(rendition.uri, signal);
      if (audioParsed.type !== 'media') {
        throw new AppError('PARSE_FAILED', 'HLS 音轨清单无效');
      }
      ensureVodPlaylist(audioParsed);
      audio = { playlist: audioParsed, fmp4: isFmp4Playlist(audioParsed), role: 'audio' };
      audioBandwidth = 128_000;
    }
  }
  const bandwidth =
    videoParsed.averageBitrate ?? variant.averageBandwidth ?? variant.bandwidth ?? 0;
  const sizeEstimate = estimateHlsSizeBytes(
    bandwidth,
    videoParsed.totalDuration,
    audioBandwidth,
  );
  return {
    masterUrl: master.url,
    sourceUrl: variant.uri,
    video: { playlist: videoParsed, fmp4: isFmp4Playlist(videoParsed), role: 'video' },
    ...(audio ? { audio } : {}),
    duration: videoParsed.totalDuration,
    ...(variant.width ? { width: variant.width } : {}),
    ...(variant.height ? { height: variant.height } : {}),
    variant,
    sizeEstimate,
    externalAudio: Boolean(audio),
  };
}

function defaultIv(sequence: number): Uint8Array {
  const iv = new Uint8Array(16);
  let value = sequence;
  for (let index = 15; index >= 0; index -= 1) {
    iv[index] = value & 0xff;
    value = Math.floor(value / 256);
  }
  return iv;
}

async function fetchKey(
  key: HlsKey,
  signal: AbortSignal,
  cache: Map<string, CryptoKey>,
): Promise<CryptoKey> {
  if (!key.uri) throw new AppError('UNSUPPORTED_FORMAT', 'HLS AES-128 密钥缺少 URI');
  const cached = cache.get(key.uri);
  if (cached) return cached;
  const bytes = await fetchBytes(key.uri, signal);
  if (bytes.byteLength !== 16) throw new AppError('CONVERT_FAILED', 'HLS AES-128 密钥长度异常');
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(bytes),
    { name: 'AES-CBC' },
    false,
    ['decrypt'],
  );
  cache.set(key.uri, cryptoKey);
  return cryptoKey;
}

async function decryptSegment(
  data: Uint8Array,
  segment: HlsSegment,
  signal: AbortSignal,
  cache: Map<string, CryptoKey>,
): Promise<Uint8Array> {
  if (!segment.key || segment.key.method === 'NONE') return data;
  if (segment.key.method.toUpperCase() !== 'AES-128') {
    throw new AppError('DRM_PROTECTED', `不支持的 HLS 加密方式：${segment.key.method}`);
  }
  const key = await fetchKey(segment.key, signal, cache);
  const iv = segment.key.iv ?? defaultIv(segment.sequence);
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(data),
    );
    return new Uint8Array(decrypted);
  } catch (error) {
    throw new AppError('CONVERT_FAILED', `HLS 分片解密失败：${String(error).slice(0, 120)}`);
  }
}

async function fetchSegmentBytes(segment: HlsSegment, signal: AbortSignal): Promise<Uint8Array> {
  if (!segment.byterange) return fetchBytes(segment.uri, signal);
  const response = await fetchWithTimeout(
    segment.uri,
    {
      method: 'GET',
      headers: {
        Range: `bytes=${segment.byterange.offset}-${segment.byterange.offset + segment.byterange.length - 1}`,
      },
    },
    signal,
    60_000,
  );
  const buffer = await response.arrayBuffer();
  if (response.status === 200 && buffer.byteLength > segment.byterange.length) {
    return new Uint8Array(buffer.slice(segment.byterange.offset, segment.byterange.offset + segment.byterange.length));
  }
  return new Uint8Array(buffer);
}

export async function downloadHlsPlan(
  plan: HlsPlan,
  store: TempStore,
  signal: AbortSignal,
  onProgress: (progress: HlsProgress) => void,
): Promise<{ videoChunks: number; audioChunks: number; bytes: number }> {
  const tracks = [plan.video, ...(plan.audio ? [plan.audio] : [])];
  const totalSegments = tracks.reduce((sum, track) => sum + track.playlist.segments.length, 0);
  let done = 0;
  let bytes = 0;
  const keyCache = new Map<string, CryptoKey>();
  let videoChunks = 0;
  let audioChunks = 0;

  const downloadTrack = async (track: HlsTrackPlan): Promise<number> => {
    let index = 0;
    let lastMap = '';
    let chunkCount = 0;
    for (const segment of track.playlist.segments) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (segment.initMap && segment.initMap.uri !== lastMap) {
        const initData = segment.initMap.byterange
          ? await fetchBytes(segment.initMap.uri, signal, {
              start: segment.initMap.byterange.offset,
              end:
                segment.initMap.byterange.offset +
                segment.initMap.byterange.length -
                1,
            })
          : await fetchBytes(segment.initMap.uri, signal);
        await store.put(track.role, index, new Blob([asBlobPart(initData)]));
        index += 1;
        chunkCount += 1;
        bytes += initData.byteLength;
        lastMap = segment.initMap.uri;
      }
      const encrypted = await fetchSegmentBytes(segment, signal);
      const data = await decryptSegment(encrypted, segment, signal, keyCache);
      if (bytes + data.byteLength > MAX_TEMP_BYTES) throw new AppError('FILE_TOO_LARGE');
      await store.put(track.role, index, new Blob([asBlobPart(data)]));
      index += 1;
      chunkCount += 1;
      bytes += data.byteLength;
      done += 1;
      onProgress({ done, total: totalSegments, bytes });
    }
    return chunkCount;
  };

  videoChunks = await downloadTrack(plan.video);
  if (plan.audio) audioChunks = await downloadTrack(plan.audio);
  return { videoChunks, audioChunks, bytes };
}

export async function downloadHlsAsSingleTrack(
  url: string,
  track: string,
  store: TempStore,
  signal: AbortSignal,
  onProgress: (progress: HlsProgress) => void,
): Promise<void> {
  await downloadStreamToStore(url, {
    store,
    track,
    signal,
    onChunk: (index, bytes) => onProgress({ done: index, total: 0, bytes }),
  });
}
