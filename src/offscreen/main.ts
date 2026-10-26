import { AppError, toTaskError } from '../shared/errors';
import { isOffscreenRequest } from '../shared/messaging';
import type {
  DownloadProgress,
  MediaCandidate,
  MediaTrack,
  OffscreenRequest,
  OffscreenResponse,
  SizeSource,
  TaskAnalysis,
  VideoSnapshot,
} from '../shared/types';
import { LARGE_FILE_WARNING_BYTES } from '../shared/types';
import { asBlobPart } from './bytes';
import { convertToMp4 } from './convert';
import type { TrackMaterial } from './convert';
import { resolveDashPlan, downloadDashPlan } from './dash';
import type { DashPlan } from '../shared/dash';
import { estimateDashSizeBytes } from '../shared/dash';
import { downloadUrlToStore, probeMediaSize } from './fetch-utils';
import { downloadHlsPlan, resolveHlsPlan } from './hls';
import type { HlsPlan } from './hls';
import { cleanupOldTempData, TempStore } from './temp-store';

interface ActiveJob {
  controller: AbortController;
}

interface CachedPlan {
  kind: 'hls';
  plan: HlsPlan;
}

interface CachedDashPlan {
  kind: 'dash';
  plan: DashPlan;
}

const activeJobs = new Map<string, ActiveJob>();
const readyBlobs = new Map<string, { url: string; size: number }>();
const planCache = new Map<string, CachedPlan | CachedDashPlan>();

void cleanupOldTempData();

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse: (response: OffscreenResponse) => void) => {
    if (!isOffscreenRequest(message)) return false;
    if (message.type === 'VVA_OFFSCREEN_PING') {
      sendResponse({ ok: true });
      return false;
    }
    void handleMessage(message)
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({ ok: false, error: toTaskError(error) });
      });
    return true;
  },
);

async function handleMessage(message: OffscreenRequest): Promise<OffscreenResponse> {
  switch (message.type) {
    case 'VVA_OFFSCREEN_PREFLIGHT':
      await preflight(message.taskId, message.candidate);
      return { ok: true, preflight: { ok: true } };
    case 'VVA_OFFSCREEN_ANALYZE': {
      const analysis = await analyze(
        message.taskId,
        message.snapshot,
        message.candidate,
      );
      return { ok: true, analysis };
    }
    case 'VVA_OFFSCREEN_START':
      startJob(message.taskId, message.snapshot, message.analysis);
      return { ok: true };
    case 'VVA_OFFSCREEN_CANCEL':
      await cancelJob(message.taskId);
      return { ok: true };
    case 'VVA_OFFSCREEN_REVOKE':
      revokeBlob(message.taskId);
      return { ok: true };
    case 'VVA_OFFSCREEN_CLEANUP':
      await cleanupTask(message.taskId);
      return { ok: true };
    default:
      return { ok: false, error: toTaskError(new AppError('INTERNAL_ERROR', '未知 offscreen 指令')) };
  }
}

async function preflight(taskId: string, candidate: MediaCandidate): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    if (candidate.format === 'hls') {
      if (!candidate.url) throw new AppError('INVALID_URL');
      const plan = await resolveHlsPlan(candidate.url, controller.signal);
      planCache.set(taskId, { kind: 'hls', plan });
    } else if (candidate.format === 'dash') {
      if (!candidate.url) throw new AppError('INVALID_URL');
      const plan = await resolveDashPlan(candidate.url, controller.signal);
      planCache.set(taskId, { kind: 'dash', plan });
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new AppError('TIMEOUT', '预解析超时');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function findCandidate(snapshot: VideoSnapshot, candidateId: string): MediaCandidate {
  const candidate = snapshot.candidates.find((item) => item.id === candidateId);
  if (!candidate) throw new AppError('PARSE_FAILED', '任务中的媒体候选已失效');
  return candidate;
}

function resolveDownloadUrl(candidate: MediaCandidate): string {
  if (candidate.url) return candidate.url;
  const video = candidate.tracks.find((track) => track.role === 'video');
  if (video) return video.url;
  throw new AppError('UNSUPPORTED_FORMAT');
}

async function analyze(
  taskId: string,
  snapshot: VideoSnapshot,
  candidate: MediaCandidate,
): Promise<TaskAnalysis> {
  if (candidate.format === 'mp4') {
    const url = resolveDownloadUrl(candidate);
    const probe = await probeMediaSize(url);
    return {
      candidateId: candidate.id,
      format: 'mp4',
      width: snapshot.width,
      height: snapshot.height,
      duration: snapshot.duration,
      sizeBytes: probe.sizeBytes,
      sizeApprox: false,
      sizeSource: probe.source,
      ...(probe.sizeBytes === null
        ? { sizeNote: probe.reason ? `无法读取大小：${probe.reason}` : '服务器未提供文件大小。' }
        : {}),
      downloadMode: 'direct',
      preview: { mode: 'direct', url },
      warnings: [
        ...(probe.sizeBytes === null ? ['无法获取准确文件大小，下载前会再次提示。'] : []),
        ...(probe.sizeBytes && probe.sizeBytes > LARGE_FILE_WARNING_BYTES
          ? ['文件超过 500 MB，下载时会占用较多磁盘空间。']
          : []),
      ],
      analyzedAt: Date.now(),
    };
  }

  if (candidate.format === 'webm') {
    const url = resolveDownloadUrl(candidate);
    const probe = await probeMediaSize(url);
    return {
      candidateId: candidate.id,
      format: 'webm',
      width: snapshot.width,
      height: snapshot.height,
      duration: snapshot.duration,
      sizeBytes: probe.sizeBytes,
      sizeApprox: false,
      sizeSource: probe.source,
      ...(probe.sizeBytes === null ? { sizeNote: '无法读取 WebM 文件大小。' } : {}),
      downloadMode: 'convert',
      preview: { mode: 'direct', url, note: 'WebM 预览；下载时会重新封装为 MP4。' },
      warnings: [
        'WebM 将重新封装为 MP4；如编码不兼容，只会转码必要轨道，可能耗时。',
        ...(probe.sizeBytes === null ? ['文件大小未知。'] : []),
      ],
      analyzedAt: Date.now(),
    };
  }

  if (candidate.format === 'dash-tracks') {
    const videoTrack = candidate.tracks.find((track) => track.role === 'video');
    const audioTrack = candidate.tracks.find((track) => track.role === 'audio');
    if (!videoTrack) throw new AppError('UNSUPPORTED_FORMAT', 'DASH 分轨缺少视频轨');
    if (!audioTrack) {
      throw new AppError(
        'UNSUPPORTED_FORMAT',
        'DASH 分轨缺少音频轨',
        '未找到音频轨道，为避免生成无声视频已停止。',
      );
    }
    const [videoProbe, audioProbe] = await Promise.all([
      probeMediaSize(videoTrack.url),
      probeMediaSize(audioTrack.url),
    ]);
    const exact =
      videoProbe.sizeBytes !== null && audioProbe.sizeBytes !== null
        ? videoProbe.sizeBytes + audioProbe.sizeBytes
        : null;
    const width = videoTrack.width ?? snapshot.width;
    const height = videoTrack.height ?? snapshot.height;
    return {
      candidateId: candidate.id,
      format: 'dash-tracks',
      width,
      height,
      duration: snapshot.duration,
      sizeBytes: exact,
      sizeApprox: false,
      sizeSource: exact !== null ? 'track-sum' : 'unknown',
      ...(exact === null
        ? {
            sizeNote: [videoProbe.reason, audioProbe.reason]
              .filter(Boolean)
              .join('；') || '音视频分轨大小未知。',
          }
        : {}),
      downloadMode: 'convert',
      preview: {
        mode: 'direct',
        url: videoTrack.url,
        note: '预览为分离的视频轨，默认无声；下载时会自动合并音频轨。',
      },
      warnings: [
        '音视频分离，将下载两条轨道并在本机合并为 MP4。',
        ...(exact === null ? ['文件大小未知。'] : []),
      ],
      analyzedAt: Date.now(),
    };
  }

  if (candidate.format === 'hls') {
    if (!candidate.url) throw new AppError('INVALID_URL');
    const cached = planCache.get(taskId);
    const plan =
      cached?.kind === 'hls'
        ? cached.plan
        : await resolveHlsPlan(candidate.url, new AbortController().signal);
    const sizeBytes = plan.sizeEstimate;
    const sizeApprox = sizeBytes !== null;
    return {
      candidateId: candidate.id,
      format: 'hls',
      width: plan.width ?? snapshot.width,
      height: plan.height ?? snapshot.height,
      duration: plan.duration || snapshot.duration,
      sizeBytes,
      sizeApprox,
      sizeSource: sizeApprox ? 'manifest-estimate' : 'unknown',
      ...(sizeApprox
        ? { sizeNote: '根据 HLS 清单码率与时长估算，实际文件大小可能略有差异。' }
        : { sizeNote: 'HLS 清单未提供可用码率，无法估算大小。' }),
      downloadMode: 'convert',
      preview: { mode: 'hls', url: candidate.url },
      warnings: [
        'HLS 分片将重新封装为 MP4。',
        ...(plan.externalAudio ? ['检测到独立音频轨，下载时会合并。'] : []),
        ...(sizeBytes === null ? ['文件大小未知。'] : []),
      ],
      analyzedAt: Date.now(),
    };
  }

  if (candidate.format === 'dash') {
    if (!candidate.url) throw new AppError('INVALID_URL');
    const cached = planCache.get(taskId);
    const plan =
      cached?.kind === 'dash'
        ? cached.plan
        : await resolveDashPlan(candidate.url, new AbortController().signal);
    let sizeBytes: number | null = estimateDashSizeBytes(plan);
    let source: SizeSource = sizeBytes !== null ? 'manifest-estimate' : 'unknown';
    let approx = true;
    let sizeNote =
      sizeBytes !== null
        ? '根据 DASH 清单码率与时长估算，实际大小可能不同。'
        : 'DASH 清单未提供可用码率。';
    const allTracksSingleFile =
      plan.video.singleFile && (!plan.audio || plan.audio.singleFile);
    if (allTracksSingleFile && plan.video.segments.length === 1) {
      const videoProbe = await probeMediaSize(plan.video.segments[0]!.url);
      if (videoProbe.sizeBytes !== null) {
        let total = videoProbe.sizeBytes;
        let exact = true;
        if (plan.audio?.singleFile && plan.audio.segments[0]) {
          const audioProbe = await probeMediaSize(plan.audio.segments[0].url);
          if (audioProbe.sizeBytes !== null) {
            total += audioProbe.sizeBytes;
          } else {
            exact = false;
            sizeNote = '视频轨大小已知，音频轨大小未知，暂按码率估算。';
          }
        }
        if (exact) {
          sizeBytes = total;
          source = 'content-length';
          approx = false;
        }
      }
    }
    return {
      candidateId: candidate.id,
      format: 'dash',
      width: plan.video.width ?? snapshot.width,
      height: plan.video.height ?? snapshot.height,
      duration: plan.durationSeconds || snapshot.duration,
      sizeBytes,
      sizeApprox: approx,
      sizeSource: source,
      sizeNote,
      downloadMode: 'convert',
      preview: {
        mode: 'none',
        note: 'DASH 清单暂不支持浏览器内预览；下载时会合并音视频为 MP4。',
      },
      warnings: [
        'DASH 音视频轨将在本机合并为 MP4。',
        ...(sizeBytes === null ? ['文件大小未知。'] : []),
      ],
      analyzedAt: Date.now(),
    };
  }

  throw new AppError('UNSUPPORTED_FORMAT');
}

function startJob(taskId: string, snapshot: VideoSnapshot, analysis: TaskAnalysis): void {
  if (activeJobs.has(taskId)) {
    throw new AppError('TASK_BUSY');
  }
  const candidate = findCandidate(snapshot, analysis.candidateId);
  const controller = new AbortController();
  activeJobs.set(taskId, { controller });
  void runJob(taskId, snapshot, candidate, analysis, controller)
    .catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const taskError = toTaskError(error, 'CONVERT_FAILED');
      void notify({ type: 'VVA_OFFSCREEN_FAILED', taskId, error: taskError });
    })
    .finally(async () => {
      activeJobs.delete(taskId);
      if (controller.signal.aborted) {
        await safeClear(taskId);
      }
    });
}

async function runJob(
  taskId: string,
  snapshot: VideoSnapshot,
  candidate: MediaCandidate,
  analysis: TaskAnalysis,
  controller: AbortController,
): Promise<void> {
  const store = new TempStore(taskId);
  try {
    await notify({ type: 'VVA_OFFSCREEN_STATUS', taskId, status: 'downloading' });
    const progress = makeProgressReporter(taskId);
    let material:
      | { video: TrackMaterial; audio?: TrackMaterial; separateAudio: boolean; expectedAudio: boolean; sourceFormat: 'hls' | 'dash' | 'split' | 'webm' }
      | null = null;

    if (candidate.format === 'hls' && candidate.url) {
      const plan = await resolveHlsPlan(candidate.url, controller.signal);
      progress({
        stage: 'downloading',
        message: '正在下载 HLS 分片…',
      });
      const result = await downloadHlsPlan(plan, store, controller.signal, (update) => {
        progress({
          stage: 'downloading',
          message: `已获取 ${update.done} / ${update.total} 个分片`,
          segmentsDone: update.done,
          segmentsTotal: update.total,
        });
      });
      if (!result.bytes) throw new AppError('UNSUPPORTED_FORMAT', 'HLS 分片为空');
      const videoChunks = await store.list('video');
      const audioChunks = plan.audio ? await store.list('audio') : [];
      material = {
        video: {
          chunks: videoChunks,
          transport: plan.video.fmp4 ? 'file' : 'concat-ts',
          extension: plan.video.fmp4 ? 'mp4' : 'ts',
        },
        ...(plan.audio
          ? {
              audio: {
                chunks: audioChunks,
                transport: plan.audio.fmp4 ? 'file' : 'concat-ts',
                extension: plan.audio.fmp4 ? 'mp4' : 'ts',
              } satisfies TrackMaterial,
            }
          : {}),
        separateAudio: Boolean(plan.audio),
        expectedAudio: Boolean(plan.audio) || snapshot.hasAudio !== false,
        sourceFormat: 'hls',
      };
    } else if (candidate.format === 'dash' && candidate.url) {
      const plan = await resolveDashPlan(candidate.url, controller.signal);
      progress({ stage: 'downloading', message: '正在下载 DASH 分片…' });
      const result = await downloadDashPlan(plan, store, controller.signal, (update) => {
        progress({
          stage: 'downloading',
          message: `已获取 ${update.done} / ${update.total} 个分片`,
          segmentsDone: update.done,
          segmentsTotal: update.total,
        });
      });
      if (!result.bytes) throw new AppError('UNSUPPORTED_FORMAT', 'DASH 分片为空');
      material = {
        video: {
          chunks: await store.list('video'),
          transport: 'file',
          extension: 'mp4',
        },
        ...(plan.audio
          ? {
              audio: {
                chunks: await store.list('audio'),
                transport: 'file' as const,
                extension: 'mp4' as const,
              } satisfies TrackMaterial,
            }
          : {}),
        separateAudio: Boolean(plan.audio),
        expectedAudio: Boolean(plan.audio) || plan.muxedAudio || snapshot.hasAudio !== false,
        sourceFormat: 'dash',
      };
    } else if (candidate.format === 'dash-tracks') {
      const videoTrack = candidate.tracks.find((track) => track.role === 'video');
      const audioTrack = candidate.tracks.find((track) => track.role === 'audio');
      if (!videoTrack || !audioTrack) {
        throw new AppError(
          'UNSUPPORTED_FORMAT',
          'DASH 分轨缺少轨道',
          '未找到完整音视频轨道，无法生成带声音的 MP4。',
        );
      }
      await downloadTrackToStore(videoTrack, 'video', store, controller.signal, progress, '视频');
      await downloadTrackToStore(audioTrack, 'audio', store, controller.signal, progress, '音频');
      material = {
        video: { chunks: await store.list('video'), transport: 'file', extension: 'mp4' },
        audio: { chunks: await store.list('audio'), transport: 'file', extension: 'mp4' },
        separateAudio: true,
        expectedAudio: true,
        sourceFormat: 'split',
      };
    } else if (candidate.format === 'webm') {
      await downloadTrackToStore(
        { url: resolveDownloadUrl(candidate), role: 'muxed' },
        'video',
        store,
        controller.signal,
        progress,
        '视频',
      );
      material = {
        video: { chunks: await store.list('video'), transport: 'file', extension: 'webm' },
        separateAudio: false,
        expectedAudio: snapshot.hasAudio !== false,
        sourceFormat: 'webm',
      };
    }

    if (!material) throw new AppError('UNSUPPORTED_FORMAT', '无法开始下载该媒体格式');
    const bytes = await store.totalBytes();
    if (bytes > 1200 * 1024 * 1024) {
      throw new AppError('FILE_TOO_LARGE', `临时数据 ${bytes} 超过转封装上限`);
    }
    const converted = await convertToMp4({
      taskId,
      ...material,
      signal: controller.signal,
      onStage: (stage, message) => {
        progress({ stage, message });
        void notify({ type: 'VVA_OFFSCREEN_STATUS', taskId, status: stage });
      },
    });
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!converted.bytes.byteLength) throw new AppError('CONVERT_FAILED', '输出 MP4 为空');
    const blob = new Blob([asBlobPart(converted.bytes)], { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(blob);
    readyBlobs.set(taskId, { url: blobUrl, size: blob.size });
    progress({ stage: 'saving', message: 'MP4 生成完成，准备保存…' });
    await notify({
      type: 'VVA_OFFSCREEN_READY',
      taskId,
      blobUrl,
      sizeBytes: blob.size,
      filenameHint: analysis.format,
    });
  } catch (error) {
    await safeClear(taskId);
    if (controller.signal.aborted) {
      await notify({ type: 'VVA_OFFSCREEN_CANCELLED', taskId });
      return;
    }
    throw error;
  } finally {
    await safeClear(taskId);
  }
}

async function downloadTrackToStore(
  track: MediaTrack,
  storeTrack: 'video' | 'audio',
  store: TempStore,
  signal: AbortSignal,
  progress: (progress: DownloadProgress) => void,
  label: string,
): Promise<void> {
  await downloadUrlToStore(track.url, store, storeTrack, signal, (_index, received) => {
    progress({
      stage: 'downloading',
      message: `正在下载${label}轨…（已接收 ${Math.round(received / 1024 / 1024)} MB）`,
    });
  });
}

function makeProgressReporter(taskId: string): (progress: DownloadProgress) => void {
  let lastSent = 0;
  let lastMessage = '';
  return (progress) => {
    const now = Date.now();
    if (progress.message === lastMessage && now - lastSent < 1000) return;
    if (now - lastSent < 280) return;
    lastSent = now;
    lastMessage = progress.message;
    void notify({ type: 'VVA_OFFSCREEN_PROGRESS', taskId, progress });
  };
}

async function cancelJob(taskId: string): Promise<void> {
  const job = activeJobs.get(taskId);
  if (job) {
    job.controller.abort();
    activeJobs.delete(taskId);
  }
  revokeBlob(taskId);
  await safeClear(taskId);
  planCache.delete(taskId);
  await notify({ type: 'VVA_OFFSCREEN_CANCELLED', taskId });
}

async function cleanupTask(taskId: string): Promise<void> {
  const job = activeJobs.get(taskId);
  job?.controller.abort();
  activeJobs.delete(taskId);
  revokeBlob(taskId);
  await safeClear(taskId);
  planCache.delete(taskId);
}

function revokeBlob(taskId: string): void {
  const blob = readyBlobs.get(taskId);
  if (!blob) return;
  try {
    URL.revokeObjectURL(blob.url);
  } catch {
    // 对象 URL 可能已被回收。
  }
  readyBlobs.delete(taskId);
}

async function safeClear(taskId: string): Promise<void> {
  try {
    await new TempStore(taskId).clear();
  } catch {
    // IndexedDB 可能正在关闭。
  }
}

async function notify(request: OffscreenRequest): Promise<void> {
  try {
    await chrome.runtime.sendMessage(request);
  } catch {
    // Service Worker 可能正在重启；最终状态仍会写入 storage 并由页面轮询。
  }
}


