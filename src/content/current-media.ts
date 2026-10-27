import type { MediaCandidate, NetworkMediaRecord } from '../shared/types';
import { candidateFromRecord } from './adapters/candidate-utils';

const MAX_PROBES = 8;
const PROBE_TIMEOUT_MS = 3_200;
const DURATION_TOLERANCE = 0.8;
const ASPECT_TOLERANCE = 0.08;

interface ProbedMedia {
  record: NetworkMediaRecord;
  duration: number | null;
  width: number | null;
  height: number | null;
}

interface MetadataMatch {
  record: NetworkMediaRecord;
  score: number;
}

export interface MediaMetadata {
  duration: number | null;
  width: number | null;
  height: number | null;
}

export function metadataMatchScore(
  current: MediaMetadata,
  candidate: MediaMetadata,
): number | null {
  if (!current.duration || current.duration <= 0) return null;
  if (!candidate.duration || candidate.duration <= 0) return null;
  const durationDelta = Math.abs(candidate.duration - current.duration);
  if (durationDelta > DURATION_TOLERANCE) return null;

  let aspectDelta = 0;
  let resolutionDelta = 0;
  if (current.width && current.height && candidate.width && candidate.height) {
    const currentAspect = current.width / current.height;
    const candidateAspect = candidate.width / candidate.height;
    aspectDelta = Math.abs(candidateAspect - currentAspect);
    if (aspectDelta > ASPECT_TOLERANCE) return null;
    resolutionDelta =
      Math.abs(candidate.width - current.width) / current.width +
      Math.abs(candidate.height - current.height) / current.height;
  }
  return durationDelta + aspectDelta * 10 + resolutionDelta;
}

export type CurrentVideoFilterResult =
  | { status: 'skipped' }
  | { status: 'matched'; records: NetworkMediaRecord[] }
  | { status: 'ambiguous' };

/**
 * 抖音/快手 feed 会预加载后面多条视频，网络缓存本身无法判断哪条属于当前播放器。
 * 对 blob/MSE 场景，使用播放器自身的时长、画面比例逐个探测候选，只保留匹配项。
 */
export async function filterRecordsForCurrentVideo(
  video: HTMLVideoElement,
  records: NetworkMediaRecord[],
): Promise<CurrentVideoFilterResult> {
  const source = video.currentSrc || video.src || '';
  if (!source.startsWith('blob:')) return { status: 'skipped' };
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
  if (!duration) return { status: 'skipped' };

  const seen = new Set<string>();
  const candidates: Array<{ record: NetworkMediaRecord; candidate: MediaCandidate }> = [];
  for (const record of records) {
    if (seen.has(record.url)) continue;
    const candidate = candidateFromRecord(
      record,
      video.videoWidth || null,
      video.videoHeight || null,
      true,
    );
    if (!candidate) continue;
    if (candidate.format !== 'mp4' && candidate.format !== 'webm') continue;
    seen.add(record.url);
    candidates.push({ record, candidate });
    if (candidates.length >= MAX_PROBES) break;
  }
  if (candidates.length < 2) return { status: 'skipped' };

  let probed: ProbedMedia[] = [];
  try {
    probed = (
      await Promise.all(candidates.map(({ record }) => probeOne(record)))
    ).filter((item): item is ProbedMedia => Boolean(item));
  } catch {
    return { status: 'ambiguous' };
  }

  const currentMetadata: MediaMetadata = {
    duration,
    width: video.videoWidth || null,
    height: video.videoHeight || null,
  };

  const matches: MetadataMatch[] = [];
  for (const item of probed) {
    const score = metadataMatchScore(currentMetadata, {
      duration: item.duration,
      width: item.width,
      height: item.height,
    });
    if (score === null) continue;
    matches.push({ record: item.record, score });
  }
  if (!matches.length) return { status: 'ambiguous' };

  matches.sort((left, right) => left.score - right.score);
  const best = matches[0];
  const second = matches[1];
  if (!best) return { status: 'ambiguous' };
  // 两个候选的时长/画幅/分辨率完全一致时无法可靠区分，宁可提示失败也不下载错误视频。
  if (second && Math.abs(second.score - best.score) <= 0.05) {
    return { status: 'ambiguous' };
  }
  return { status: 'matched', records: [best.record] };
}

function probeOne(record: NetworkMediaRecord): Promise<ProbedMedia | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    let settled = false;
    let timer = 0;
    const finish = (result: ProbedMedia | null): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        // 清理即可。
      }
      video.remove();
      resolve(result);
    };
    const onLoaded = (): void => {
      finish({
        record,
        duration:
          Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null,
        width: video.videoWidth > 0 ? video.videoWidth : null,
        height: video.videoHeight > 0 ? video.videoHeight : null,
      });
    };
    const onError = (): void => finish(null);

    try {
      video.muted = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.dataset.vvaProbe = 'true';
      video.setAttribute('aria-hidden', 'true');
      video.style.cssText =
        'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
      video.addEventListener('loadedmetadata', onLoaded, { once: true });
      video.addEventListener('error', onError, { once: true });
      timer = window.setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
      video.src = record.url;
      document.body.append(video);
      video.load();
    } catch {
      finish(null);
    }
  });
}
