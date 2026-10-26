import { parseDashManifest } from '../shared/dash';
import type { DashPlan, DashResource, DashTrackPlan } from '../shared/dash';
import { AppError } from '../shared/errors';
import { asBlobPart } from './bytes';
import { fetchText, fetchWithTimeout, MAX_TEMP_BYTES } from './fetch-utils';
import type { TempStore } from './temp-store';

export interface DashDownloadProgress {
  done: number;
  total: number;
  bytes: number;
  track: 'video' | 'audio';
}

export async function resolveDashPlan(
  manifestUrl: string,
  signal: AbortSignal,
): Promise<DashPlan> {
  const text = await fetchText(manifestUrl, signal);
  try {
    return parseDashManifest(text, manifestUrl);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('PARSE_FAILED', error instanceof Error ? error.message : undefined);
  }
}

async function fetchResource(resource: DashResource, signal: AbortSignal): Promise<Uint8Array> {
  const headers: Record<string, string> = {};
  if (resource.range) headers.Range = `bytes=${resource.range.start}-${resource.range.end}`;
  const response = await fetchWithTimeout(resource.url, { method: 'GET', headers }, signal, 60_000);
  const buffer = await response.arrayBuffer();
  if (resource.range && response.status === 200 && buffer.byteLength > resource.range.end - resource.range.start + 1) {
    return new Uint8Array(buffer.slice(resource.range.start, resource.range.end + 1));
  }
  return new Uint8Array(buffer);
}

async function downloadTrack(
  track: DashTrackPlan,
  trackName: 'video' | 'audio',
  store: TempStore,
  signal: AbortSignal,
  onProgress: (progress: DashDownloadProgress) => void,
  counters: { done: number; total: number; bytes: number },
): Promise<number> {
  let index = 0;
  let chunks = 0;
  if (track.init) {
    const data = await fetchResource(track.init, signal);
    await store.put(trackName, index, new Blob([asBlobPart(data)]));
    index += 1;
    chunks += 1;
    counters.bytes += data.byteLength;
    if (counters.bytes > MAX_TEMP_BYTES) throw new AppError('FILE_TOO_LARGE');
  }
  for (const resource of track.segments) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const data = await fetchResource(resource, signal);
    await store.put(trackName, index, new Blob([asBlobPart(data)]));
    index += 1;
    chunks += 1;
    counters.bytes += data.byteLength;
    counters.done += 1;
    if (counters.bytes > MAX_TEMP_BYTES) throw new AppError('FILE_TOO_LARGE');
    onProgress({
      done: counters.done,
      total: counters.total,
      bytes: counters.bytes,
      track: trackName,
    });
  }
  return chunks;
}

export async function downloadDashPlan(
  plan: DashPlan,
  store: TempStore,
  signal: AbortSignal,
  onProgress: (progress: DashDownloadProgress) => void,
): Promise<{ videoChunks: number; audioChunks: number; bytes: number }> {
  if (!plan.audio && !plan.muxedAudio) {
    throw new AppError(
      'UNSUPPORTED_FORMAT',
      'DASH 清单没有独立音频轨，视频轨也未声明包含音频',
      '未找到音频轨道，为避免生成无声视频已停止。',
    );
  }
  const counters = {
    done: 0,
    total: plan.video.segments.length + (plan.audio?.segments.length ?? 0),
    bytes: 0,
  };
  const videoChunks = await downloadTrack(
    plan.video,
    'video',
    store,
    signal,
    onProgress,
    counters,
  );
  const audioChunks = plan.audio
    ? await downloadTrack(plan.audio, 'audio', store, signal, onProgress, counters)
    : 0;
  return { videoChunks, audioChunks, bytes: counters.bytes };
}
