export const SNAPSHOT_VERSION = 1;
export const TASK_TTL_MS = 60 * 60 * 1000;
export const COMPLETED_TASK_TTL_MS = 15 * 60 * 1000;
export const LARGE_FILE_WARNING_BYTES = 500 * 1024 * 1024;
export const MAX_CONVERSION_BYTES = 1200 * 1024 * 1024;

export type PlatformId = 'douyin' | 'kuaishou' | 'bilibili' | 'generic';

export type MediaFormat = 'mp4' | 'webm' | 'hls' | 'dash' | 'dash-tracks' | 'unknown';

export type MediaRole = 'muxed' | 'video' | 'audio';

export type CandidateSource = 'video-src' | 'network' | 'performance' | 'page-data';

export interface MediaTrack {
  url: string;
  role: MediaRole;
  mimeType?: string;
  codecs?: string;
  width?: number;
  height?: number;
  bandwidth?: number;
}

export interface MediaCandidate {
  id: string;
  format: MediaFormat;
  /** HLS 主清单、DASH MPD 或单文件直链。分轨候选可以没有该字段。 */
  url?: string;
  tracks: MediaTrack[];
  contentType?: string;
  width?: number;
  height?: number;
  label?: string;
  source: CandidateSource;
  requiresReferer?: boolean;
}

export interface VideoSnapshot {
  schemaVersion: typeof SNAPSHOT_VERSION;
  pageUrl: string;
  pageTitle: string;
  platformId: PlatformId;
  platformName: string;
  title: string;
  coverUrl?: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  isLive: boolean;
  drmDetected: boolean;
  hasAudio: boolean | null;
  videoSrcKind: 'direct' | 'blob' | 'unknown';
  candidates: MediaCandidate[];
  capturedAt: number;
}

export type TaskStatus =
  | 'ready'
  | 'preparing'
  | 'downloading'
  | 'converting'
  | 'saving'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type SizeSource =
  | 'content-length'
  | 'content-range'
  | 'manifest-estimate'
  | 'track-sum'
  | 'unknown';

export interface PreviewInfo {
  mode: 'direct' | 'hls' | 'none';
  url?: string;
  note?: string;
}

export interface TaskAnalysis {
  candidateId: string;
  format: MediaFormat;
  width: number | null;
  height: number | null;
  duration: number | null;
  sizeBytes: number | null;
  sizeApprox: boolean;
  sizeSource: SizeSource;
  sizeNote?: string;
  downloadMode: 'direct' | 'convert';
  preview: PreviewInfo;
  warnings: string[];
  analyzedAt: number;
}

export interface TaskError {
  code: string;
  message: string;
  detail?: string;
}

export type ProgressStage = 'preparing' | 'downloading' | 'converting' | 'saving';

export interface DownloadProgress {
  stage: ProgressStage;
  /** 仅在总大小确切且来自浏览器下载器或服务端字节数时提供。 */
  percent?: number;
  receivedBytes?: number;
  totalBytes?: number;
  segmentsDone?: number;
  segmentsTotal?: number;
  message: string;
}

export interface TaskRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  status: TaskStatus;
  snapshot: VideoSnapshot;
  analysis?: TaskAnalysis;
  progress?: DownloadProgress;
  error?: TaskError;
  previewTabId?: number;
  downloadId?: number;
  downloadFilename?: string;
  dnrRuleIds?: number[];
  startedAt?: number;
  completedAt?: number;
}

export interface CreateTaskResult {
  taskId: string;
  previewUrl: string;
}

export interface StartDownloadOptions {
  confirmLarge: boolean;
}

export type RuntimeRequest =
  | { type: 'VVA_CREATE_TASK'; snapshot: VideoSnapshot }
  | { type: 'VVA_GET_TASK'; taskId: string }
  | { type: 'VVA_PREPARE_TASK'; taskId: string }
  | { type: 'VVA_START_DOWNLOAD'; taskId: string; options: StartDownloadOptions }
  | { type: 'VVA_CANCEL_TASK'; taskId: string }
  | { type: 'VVA_RETRY_TASK'; taskId: string }
  | { type: 'VVA_CLOSE_TASK'; taskId: string }
  | { type: 'VVA_PING' }
  | { type: 'VVA_RESCAN' }
  | { type: 'VVA_SHOW_HINT' }
  | { type: 'VVA_TASK_UPDATED'; task: TaskRecord };

export type OffscreenRequest =
  | { type: 'VVA_OFFSCREEN_PING' }
  | {
      type: 'VVA_OFFSCREEN_PREFLIGHT';
      taskId: string;
      snapshot: VideoSnapshot;
      candidate: MediaCandidate;
    }
  | { type: 'VVA_OFFSCREEN_ANALYZE'; taskId: string; snapshot: VideoSnapshot; candidate: MediaCandidate }
  | { type: 'VVA_OFFSCREEN_START'; taskId: string; snapshot: VideoSnapshot; analysis: TaskAnalysis }
  | { type: 'VVA_OFFSCREEN_CANCEL'; taskId: string }
  | { type: 'VVA_OFFSCREEN_REVOKE'; taskId: string }
  | { type: 'VVA_OFFSCREEN_CLEANUP'; taskId: string }
  | {
      type: 'VVA_OFFSCREEN_PROGRESS';
      taskId: string;
      progress: DownloadProgress;
    }
  | {
      type: 'VVA_OFFSCREEN_STATUS';
      taskId: string;
      status: 'downloading' | 'converting' | 'saving';
    }
  | {
      type: 'VVA_OFFSCREEN_READY';
      taskId: string;
      blobUrl: string;
      sizeBytes: number;
      filenameHint: string;
    }
  | { type: 'VVA_OFFSCREEN_FAILED'; taskId: string; error: TaskError }
  | { type: 'VVA_OFFSCREEN_CANCELLED'; taskId: string };

export type OffscreenResponse =
  | { ok: true; preflight?: { ok: true }; analysis?: TaskAnalysis }
  | { ok: false; error: TaskError };

export type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: TaskError };

export interface PageHints {
  bilibili?: {
    title?: string;
    coverUrl?: string;
    duration?: number;
    isLive?: boolean;
    videos: Array<{
      baseUrl: string;
      backupUrl?: string;
      width?: number;
      height?: number;
      bandwidth?: number;
      codecs?: string;
      mimeType?: string;
    }>;
    audios: Array<{
      baseUrl: string;
      backupUrl?: string;
      bandwidth?: number;
      codecs?: string;
      mimeType?: string;
    }>;
    durl?: Array<{
      url: string;
      backupUrl?: string;
      size?: number;
    }>;
  };
}

export interface NetworkMediaRecord {
  url: string;
  contentType?: string;
  contentLength?: number;
  source: 'fetch' | 'xhr' | 'performance';
  at: number;
}
