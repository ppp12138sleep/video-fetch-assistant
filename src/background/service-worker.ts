import { PLATFORM_NAMES, PREVIEW_PATH } from '../shared/constants';
import { AppError, toTaskError } from '../shared/errors';
import type { ErrorCode } from '../shared/errors';
import { buildDownloadFilename } from '../shared/filename';
import { logWarn, sanitizeLogText } from '../shared/logger';
import { isOffscreenRequest } from '../shared/messaging';
import type {
  ApiResponse,
  CreateTaskResult,
  MediaCandidate,
  MediaFormat,
  MediaRole,
  OffscreenRequest,
  PlatformId,
  RuntimeRequest,
  TaskError,
  TaskRecord,
  VideoSnapshot,
} from '../shared/types';
import {
  COMPLETED_TASK_TTL_MS,
  LARGE_FILE_WARNING_BYTES,
  MAX_CONVERSION_BYTES,
  TASK_TTL_MS,
} from '../shared/types';
import { parseHttpUrl } from '../shared/url';
import { applyTaskRules, removeAllTaskRules, removeTaskRules } from './dnr';
import {
  closeOffscreenDocument,
  ensureOffscreenDocument,
  hasOffscreenDocument,
  offscreenUrl,
  sendToOffscreen,
} from './offscreen';
import {
  deleteTask,
  findTaskByDownloadId,
  isTaskId,
  listTasks,
  loadTask,
  saveTask,
} from './task-store';

const ALARM_NAME = 'vva-maintenance';
const ACTIVE_STATUSES = new Set(['preparing', 'downloading', 'converting', 'saving']);
const downloadTaskCache = new Map<number, string>();
const prepareJobs = new Map<string, Promise<TaskRecord>>();
const startLocks = new Set<string>();
let initialized = false;

chrome.runtime.onInstalled.addListener((details) => {
  void initialize(true, details.reason);
});

chrome.runtime.onStartup.addListener(() => {
  void initialize(true, 'startup');
});

chrome.action.onClicked.addListener((tab) => {
  void handleActionClick(tab);
});

chrome.runtime.onMessage.addListener(
  (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => {
    if (!message || typeof message !== 'object') return false;
    const request = message as RuntimeRequest | OffscreenRequest;
    if (isOffscreenRequest(request)) {
      if (!isOffscreenSender(sender)) return false;
      void handleOffscreenMessage(request)
        .then(() => sendResponse({ ok: true }))
        .catch((error: unknown) => {
          logWarn('background', 'OFFSCREEN_MESSAGE_FAILED', error);
          sendResponse({ ok: false, error: toTaskError(error) });
        });
      return true;
    }
    if (!('type' in request) || typeof request.type !== 'string') return false;
    if (request.type === 'VVA_TASK_UPDATED') return false;
    void handleRuntimeRequest(request, sender)
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse(failure(error));
      });
    return true;
  },
);

chrome.downloads.onChanged.addListener((delta) => {
  void handleDownloadChanged(delta);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    void cleanupExpiredTasks();
  }
});

chrome.permissions.onRemoved.addListener(() => {
  void chrome.scripting
    .unregisterContentScripts({ ids: ['vva-generic-hook', 'vva-generic-content'] })
    .catch(() => undefined);
});

void initialize(false, 'worker-start');

async function initialize(clearDnr: boolean, reason: string): Promise<void> {
  if (initialized && reason === 'worker-start') return;
  initialized = true;
  try {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 5 });
  } catch {
    // 旧版浏览器若拒绝闹钟，仍会在任务读取时惰性清理。
  }
  if (clearDnr) {
    try {
      await removeAllTaskRules();
    } catch (error) {
      logWarn('background', 'DNR_RESET_FAILED', error);
    }
  }
  await cleanupExpiredTasks();
}

async function handleRuntimeRequest(
  request: RuntimeRequest,
  sender: chrome.runtime.MessageSender,
): Promise<ApiResponse<unknown>> {
  if (sender.id !== chrome.runtime.id) return failure(new AppError('INTERNAL_ERROR', '消息来源无效'));
  switch (request.type) {
    case 'VVA_CREATE_TASK':
      if (!isContentSender(sender)) return failure(new AppError('INTERNAL_ERROR', '只能从网页创建任务'));
      return success(await createTask(request.snapshot, sender));
    case 'VVA_GET_TASK':
      if (!isPreviewSender(sender)) return failure(new AppError('INTERNAL_ERROR', '预览页来源无效'));
      return success(await getTask(request.taskId, sender));
    case 'VVA_PREPARE_TASK':
      if (!isPreviewSender(sender)) return failure(new AppError('INTERNAL_ERROR', '预览页来源无效'));
      return success(await prepareTask(request.taskId));
    case 'VVA_START_DOWNLOAD':
      if (!isPreviewSender(sender)) return failure(new AppError('INTERNAL_ERROR', '预览页来源无效'));
      return success(await startDownload(request.taskId, request.options));
    case 'VVA_CANCEL_TASK':
      if (!isPreviewSender(sender)) return failure(new AppError('INTERNAL_ERROR', '预览页来源无效'));
      return success(await cancelTask(request.taskId));
    case 'VVA_RETRY_TASK':
      if (!isPreviewSender(sender)) return failure(new AppError('INTERNAL_ERROR', '预览页来源无效'));
      return success(await retryTask(request.taskId));
    case 'VVA_CLOSE_TASK':
      if (!isPreviewSender(sender)) return failure(new AppError('INTERNAL_ERROR', '预览页来源无效'));
      return success(await closeTask(request.taskId));
    default:
      return failure(new AppError('INTERNAL_ERROR', '未知请求'));
  }
}

function success<T>(data: T): ApiResponse<T> {
  return { ok: true, data };
}

function failure(error: unknown): ApiResponse<never> {
  return { ok: false, error: toTaskError(error) };
}

function isContentSender(sender: chrome.runtime.MessageSender): boolean {
  return Boolean(
    sender.tab?.id !== undefined &&
      sender.url &&
      parseHttpUrl(sender.url) &&
      sender.origin !== `chrome-extension://${chrome.runtime.id}`,
  );
}

function isPreviewSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined) return false;
  return Boolean(sender.url?.startsWith(chrome.runtime.getURL('preview/')));
}

function isOffscreenSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.url === offscreenUrl();
}

async function createTask(
  rawSnapshot: VideoSnapshot,
  sender: chrome.runtime.MessageSender,
): Promise<CreateTaskResult> {
  const snapshot = sanitizeSnapshot(rawSnapshot, sender.url);
  if (snapshot.isLive) throw new AppError('LIVE_STREAM');
  if (snapshot.drmDetected) throw new AppError('DRM_PROTECTED');
  const taskId = crypto.randomUUID();
  const task: TaskRecord = {
    id: taskId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    expiresAt: Date.now() + TASK_TTL_MS,
    status: 'ready',
    snapshot,
  };

  await applyTaskRules(task);
  try {
    const candidate = snapshot.candidates[0]!;
    if (candidate.format === 'hls' || candidate.format === 'dash') {
      await ensureOffscreenDocument();
      const preflight = await sendToOffscreen({
        type: 'VVA_OFFSCREEN_PREFLIGHT',
        taskId,
        snapshot,
        candidate,
      });
      if (!preflight.ok) {
        throw new AppError(
          preflight.error.code as ErrorCode,
          preflight.error.detail,
          preflight.error.message,
        );
      }
    }
    await saveTask(task);
    const previewUrl = `${chrome.runtime.getURL(PREVIEW_PATH)}?task=${encodeURIComponent(taskId)}`;
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.create({ url: previewUrl, active: true });
    } catch (error) {
      throw new AppError('INTERNAL_ERROR', `无法打开预览页：${String(error)}`);
    }
    if (tab.id !== undefined) {
      task.previewTabId = tab.id;
      await saveTask(task);
    }
    return { taskId, previewUrl };
  } catch (error) {
    await removeTaskRules(task);
    await deleteTask(taskId);
    throw error;
  }
}

async function getTask(taskId: string, sender: chrome.runtime.MessageSender): Promise<TaskRecord> {
  const task = await requireTask(taskId);
  let changed = false;
  if (sender.tab?.id !== undefined && task.previewTabId !== sender.tab.id) {
    task.previewTabId = sender.tab.id;
    changed = true;
  }
  const refreshed = await refreshDownloadProgress(task);
  if (changed || refreshed) await saveTask(task);
  return publicTask(task);
}

async function prepareTask(taskId: string): Promise<TaskRecord> {
  const existing = prepareJobs.get(taskId);
  if (existing) return publicTask(await existing);
  const promise = prepareTaskInner(taskId);
  prepareJobs.set(taskId, promise);
  try {
    return publicTask(await promise);
  } finally {
    prepareJobs.delete(taskId);
  }
}

async function prepareTaskInner(taskId: string): Promise<TaskRecord> {
  const task = await requireTask(taskId);
  if (task.analysis && task.status !== 'failed') return task;
  if (task.status === 'downloading' || task.status === 'converting' || task.status === 'saving') {
    throw new AppError('TASK_BUSY');
  }
  const candidate = task.snapshot.candidates[0];
  if (!candidate) throw new AppError('UNSUPPORTED_FORMAT');
  task.status = 'preparing';
  task.error = undefined;
  task.progress = {
    stage: 'preparing',
    message: '正在分析媒体信息与文件大小…',
  };
  await saveTask(task);
  await notifyPreview(task);
  try {
    const response = await sendToOffscreen({
      type: 'VVA_OFFSCREEN_ANALYZE',
      taskId,
      snapshot: task.snapshot,
      candidate,
    });
    if (!response.ok || !response.analysis) {
      const error = response.ok
        ? new AppError('INTERNAL_ERROR', 'offscreen 未返回分析结果')
        : new AppError(response.error.code as ErrorCode, response.error.detail, response.error.message);
      throw error;
    }
    const latest = await loadTask(taskId);
    if (!latest.task || latest.task.status === 'cancelled') {
      return latest.task ?? task;
    }
    latest.task.analysis = response.analysis;
    latest.task.status = 'ready';
    latest.task.progress = undefined;
    latest.task.error = undefined;
    latest.task.expiresAt = Date.now() + TASK_TTL_MS;
    await saveTask(latest.task);
    await notifyPreview(latest.task);
    return latest.task;
  } catch (error) {
    const latest = await loadTask(taskId);
    if (latest.task && latest.task.status !== 'cancelled') {
      latest.task.status = 'failed';
      latest.task.progress = undefined;
      latest.task.error = toTaskError(error, 'PARSE_FAILED');
      await saveTask(latest.task);
      await notifyPreview(latest.task);
    }
    throw error;
  }
}

async function startDownload(
  taskId: string,
  options: { confirmLarge: boolean },
): Promise<TaskRecord> {
  if (startLocks.has(taskId)) throw new AppError('TASK_BUSY');
  startLocks.add(taskId);
  try {
    let task = await requireTask(taskId);
    if (!task.analysis) {
      task = await prepareTaskInner(taskId);
    }
    if (!task.analysis) throw new AppError('PARSE_FAILED', '没有分析结果');
    if (task.downloadId !== undefined || ['downloading', 'converting', 'saving'].includes(task.status)) {
      throw new AppError('TASK_BUSY');
    }
    if (task.analysis.downloadMode === 'convert' && task.analysis.sizeBytes !== null && task.analysis.sizeBytes > MAX_CONVERSION_BYTES) {
      throw new AppError(
        'FILE_TOO_LARGE',
        `预计 ${task.analysis.sizeBytes} 字节，超过转封装上限`,
        '该视频体积过大，超出本机转封装的安全上限，无法下载。',
      );
    }
    const needsConfirm =
      task.analysis.sizeBytes === null || task.analysis.sizeBytes > LARGE_FILE_WARNING_BYTES;
    if (needsConfirm && !options?.confirmLarge) {
      throw new AppError('CONFIRM_REQUIRED');
    }
    if (!task.dnrRuleIds?.length) await applyTaskRules(task);
    task.status = 'downloading';
    task.startedAt = Date.now();
    task.expiresAt = Date.now() + 6 * 60 * 60 * 1000;
    task.error = undefined;
    task.downloadFilename = buildDownloadFilename({
      platformName: PLATFORM_NAMES[task.snapshot.platformId],
      title: task.snapshot.title,
      width: task.analysis.width ?? task.snapshot.width,
      height: task.analysis.height ?? task.snapshot.height,
    });
    task.progress = { stage: 'preparing', message: '正在准备下载…' };
    await saveTask(task);
    await notifyPreview(task);

    const candidate = task.snapshot.candidates.find(
      (item) => item.id === task.analysis?.candidateId,
    ) ?? task.snapshot.candidates[0];
    if (!candidate) throw new AppError('UNSUPPORTED_FORMAT');

    if (task.analysis.downloadMode === 'direct' && candidate.format === 'mp4') {
      const url = candidate.url ?? candidate.tracks[0]?.url;
      if (!url) throw new AppError('INVALID_URL');
      const downloadId = await chrome.downloads.download({
        url,
        filename: task.downloadFilename,
        conflictAction: 'uniquify',
        saveAs: false,
      });
      task.downloadId = downloadId;
      downloadTaskCache.set(downloadId, task.id);
      task.status = 'downloading';
      task.progress = {
        stage: 'downloading',
        message: '正在下载 MP4…',
        ...(task.analysis.sizeBytes ? { totalBytes: task.analysis.sizeBytes, percent: 0 } : {}),
      };
      await saveTask(task);
      await notifyPreview(task);
      return publicTask(task);
    }

    await ensureOffscreenDocument();
    const response = await sendToOffscreen({
      type: 'VVA_OFFSCREEN_START',
      taskId,
      snapshot: task.snapshot,
      analysis: task.analysis,
    });
    if (!response.ok) {
      throw new AppError(response.error.code as ErrorCode, response.error.detail, response.error.message);
    }
    task.status = 'downloading';
    task.progress = { stage: 'downloading', message: '正在获取媒体分片…' };
    await saveTask(task);
    await notifyPreview(task);
    return publicTask(task);
  } catch (error) {
    const appError = error instanceof AppError ? error : new AppError('CONVERT_FAILED', String(error));
    if (appError.code !== 'CONFIRM_REQUIRED' && appError.code !== 'TASK_BUSY') {
      const current = await loadTask(taskId);
      if (current.task && !current.task.downloadId && !['completed', 'cancelled'].includes(current.task.status)) {
        current.task.status = 'failed';
        current.task.progress = undefined;
        current.task.error = toTaskError(appError, 'CONVERT_FAILED');
        await removeTaskRules(current.task);
        await saveTask(current.task);
        await notifyPreview(current.task);
        void maybeCloseOffscreen();
      }
    }
    throw error;
  } finally {
    startLocks.delete(taskId);
  }
}

async function cancelTask(taskId: string): Promise<TaskRecord> {
  const task = await requireTask(taskId);
  if (task.status === 'completed') return publicTask(task);
  if (task.downloadId !== undefined) {
    await cancelBrowserDownload(task.downloadId);
    downloadTaskCache.delete(task.downloadId);
  }
  if (await hasOffscreenDocument()) {
    try {
      await chrome.runtime.sendMessage({ type: 'VVA_OFFSCREEN_CANCEL', taskId } satisfies OffscreenRequest);
    } catch {
      // offscreen 可能已关闭。
    }
  }
  await removeTaskRules(task);
  task.status = 'cancelled';
  task.progress = undefined;
  task.error = undefined;
  task.downloadId = undefined;
  task.expiresAt = Date.now() + TASK_TTL_MS;
  await saveTask(task);
  await notifyPreview(task);
  void maybeCloseOffscreen();
  return publicTask(task);
}

async function retryTask(taskId: string): Promise<TaskRecord> {
  const task = await requireTask(taskId);
  if (!['failed', 'cancelled'].includes(task.status)) {
    throw new AppError('TASK_BUSY');
  }
  task.status = 'ready';
  task.error = undefined;
  task.progress = undefined;
  task.downloadId = undefined;
  task.downloadFilename = undefined;
  task.startedAt = undefined;
  task.completedAt = undefined;
  task.expiresAt = Date.now() + TASK_TTL_MS;
  await saveTask(task);
  await notifyPreview(task);
  return publicTask(task);
}

async function closeTask(taskId: string): Promise<{ closed: boolean }> {
  const task = await requireTask(taskId);
  if (ACTIVE_STATUSES.has(task.status)) {
    return { closed: false };
  }
  await removeTaskRules(task);
  if (await hasOffscreenDocument()) {
    try {
      await chrome.runtime.sendMessage({ type: 'VVA_OFFSCREEN_CLEANUP', taskId } satisfies OffscreenRequest);
    } catch {
      // 忽略。
    }
  }
  await deleteTask(taskId);
  void maybeCloseOffscreen();
  return { closed: true };
}

async function requireTask(taskId: string): Promise<TaskRecord> {
  if (!isTaskId(taskId)) throw new AppError('TASK_NOT_FOUND');
  const loaded = await loadTask(taskId);
  if (loaded.expired && loaded.task) {
    if (ACTIVE_STATUSES.has(loaded.task.status)) {
      loaded.task.expiresAt = Date.now() + TASK_TTL_MS;
      await saveTask(loaded.task);
      return loaded.task;
    }
    await expireTask(loaded.task);
    throw new AppError('TASK_EXPIRED');
  }
  if (!loaded.task) throw new AppError('TASK_NOT_FOUND');
  return loaded.task;
}

async function expireTask(task: TaskRecord): Promise<void> {
  await removeTaskRules(task);
  if (await hasOffscreenDocument()) {
    try {
      await chrome.runtime.sendMessage({ type: 'VVA_OFFSCREEN_CLEANUP', taskId: task.id } satisfies OffscreenRequest);
    } catch {
      // 忽略。
    }
  }
  await deleteTask(task.id);
  void maybeCloseOffscreen();
}

function publicTask(task: TaskRecord): TaskRecord {
  const copy = structuredClone(task);
  delete copy.dnrRuleIds;
  delete copy.previewTabId;
  return copy;
}

async function notifyPreview(task: TaskRecord): Promise<void> {
  if (task.previewTabId === undefined || !isTaskId(task.id)) return;
  try {
    await chrome.tabs.sendMessage(task.previewTabId, {
      type: 'VVA_TASK_UPDATED',
      task: publicTask(task),
    } satisfies RuntimeRequest);
  } catch {
    // 预览页已关闭；下载继续进行。
  }
}

async function refreshDownloadProgress(task: TaskRecord): Promise<boolean> {
  if (task.downloadId === undefined) return false;
  if (!['downloading', 'saving'].includes(task.status)) return false;
  try {
    const [item] = await chrome.downloads.search({ id: task.downloadId });
    if (!item) return false;
    const total = item.totalBytes > 0 ? item.totalBytes : task.progress?.totalBytes;
    const percent =
      total && total > 0
        ? Math.min(99, Math.max(0, Math.floor((item.bytesReceived / total) * 100)))
        : undefined;
    const previous = task.progress?.percent;
    if (percent === previous && item.state === 'in_progress') return false;
    task.progress = {
      stage: task.status === 'saving' ? 'saving' : 'downloading',
      message: task.status === 'saving' ? '正在保存 MP4…' : '正在下载 MP4…',
      ...(percent !== undefined ? { percent } : {}),
      ...(item.bytesReceived ? { receivedBytes: item.bytesReceived } : {}),
      ...(total ? { totalBytes: total } : {}),
    };
    return true;
  } catch {
    return false;
  }
}

async function handleOffscreenMessage(message: OffscreenRequest): Promise<void> {
  if (message.type === 'VVA_OFFSCREEN_PING') return;
  if (!('taskId' in message) || !isTaskId(message.taskId)) return;
  const loaded = await loadTask(message.taskId);
  const task = loaded.task;
  if (!task) return;
  switch (message.type) {
    case 'VVA_OFFSCREEN_PROGRESS':
      if (['completed', 'cancelled', 'failed'].includes(task.status)) return;
      task.progress = message.progress;
      task.status =
        message.progress.stage === 'converting'
          ? 'converting'
          : message.progress.stage === 'saving'
            ? 'saving'
            : 'downloading';
      await saveTask(task);
      await notifyPreview(task);
      return;
    case 'VVA_OFFSCREEN_STATUS':
      if (['completed', 'cancelled', 'failed'].includes(task.status)) return;
      task.status = message.status;
      await saveTask(task);
      await notifyPreview(task);
      return;
    case 'VVA_OFFSCREEN_CANCELLED':
      if (task.status === 'completed' || task.status === 'cancelled') return;
      task.status = 'cancelled';
      task.progress = undefined;
      task.error = undefined;
      await saveTask(task);
      await notifyPreview(task);
      return;
    case 'VVA_OFFSCREEN_FAILED':
      if (task.status === 'completed' || task.status === 'cancelled') return;
      task.status = 'failed';
      task.progress = undefined;
      task.error = message.error;
      await saveTask(task);
      await removeTaskRules(task);
      await notifyPreview(task);
      void maybeCloseOffscreen();
      return;
    case 'VVA_OFFSCREEN_READY':
      await handleConvertedReady(task, message);
      return;
    default:
      return;
  }
}

async function handleConvertedReady(
  task: TaskRecord,
  message: Extract<OffscreenRequest, { type: 'VVA_OFFSCREEN_READY' }>,
): Promise<void> {
  if (!['downloading', 'converting', 'saving'].includes(task.status)) {
    // 任务已失败/取消/过期时，offscreen 迟到的 READY 不能重新唤起下载。
    await revokeOffscreen(task.id);
    return;
  }
  if (task.downloadId !== undefined) return;
  const expectedPrefix = `blob:chrome-extension://${chrome.runtime.id}/`;
  if (!message.blobUrl.startsWith(expectedPrefix)) {
    task.status = 'failed';
    task.error = { code: 'INTERNAL_ERROR', message: '转换结果地址无效，已停止下载。' };
    await saveTask(task);
    await removeTaskRules(task);
    await notifyPreview(task);
    return;
  }
  if (!task.downloadFilename) {
    task.downloadFilename = buildDownloadFilename({
      platformName: PLATFORM_NAMES[task.snapshot.platformId],
      title: task.snapshot.title,
      width: task.analysis?.width ?? task.snapshot.width,
      height: task.analysis?.height ?? task.snapshot.height,
    });
  }
  task.status = 'saving';
  task.progress = {
    stage: 'saving',
    message: '正在保存 MP4…',
    percent: 0,
    totalBytes: message.sizeBytes,
    receivedBytes: 0,
  };
  await saveTask(task);
  await notifyPreview(task);
  try {
    const downloadId = await chrome.downloads.download({
      url: message.blobUrl,
      filename: task.downloadFilename,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    task.downloadId = downloadId;
    downloadTaskCache.set(downloadId, task.id);
    await saveTask(task);
    await notifyPreview(task);
  } catch (error) {
    task.status = 'failed';
    task.error = {
      code: 'INTERNAL_ERROR',
      message: '无法创建浏览器下载，请检查下载目录权限。',
      detail: sanitizeLogText(String(error)).slice(0, 250),
    };
    task.progress = undefined;
    await saveTask(task);
    await removeTaskRules(task);
    await revokeOffscreen(task.id);
    await notifyPreview(task);
    throw error;
  }
}

async function handleDownloadChanged(delta: chrome.downloads.DownloadDelta): Promise<void> {
  let taskId = downloadTaskCache.get(delta.id);
  if (!taskId) {
    const found = await findTaskByDownloadId(delta.id);
    if (!found) return;
    taskId = found.id;
    downloadTaskCache.set(delta.id, taskId);
  }
  const loaded = await loadTask(taskId);
  const task = loaded.task;
  if (!task || task.downloadId !== delta.id) return;
  if (delta.state?.current === 'complete') {
    await onDownloadComplete(task);
    return;
  }
  if (delta.state?.current === 'interrupted') {
    await onDownloadInterrupted(task, delta.error?.current);
    return;
  }
  if (delta.state?.current === 'in_progress' || delta.totalBytes || delta.fileSize) {
    if (await refreshDownloadProgress(task)) {
      await saveTask(task);
      await notifyPreview(task);
    }
  }
}

async function onDownloadComplete(task: TaskRecord): Promise<void> {
  if (task.status === 'completed') return;
  downloadTaskCache.delete(task.downloadId ?? -1);
  task.status = 'completed';
  task.completedAt = Date.now();
  task.expiresAt = Date.now() + COMPLETED_TASK_TTL_MS;
  task.progress = {
    stage: 'saving',
    message: '已保存到下载目录。',
    percent: 100,
    ...(task.analysis?.sizeBytes ? { totalBytes: task.analysis.sizeBytes } : {}),
    ...(task.analysis?.sizeBytes ? { receivedBytes: task.analysis.sizeBytes } : {}),
  };
  // 完成后不再需要签名媒体地址；仅保留标题/大小等结果摘要。
  task.snapshot.candidates = [];
  task.snapshot.pageUrl = '';
  task.snapshot.videoSrcKind = 'unknown';
  if (task.analysis) {
    task.analysis.preview = {
      mode: 'none',
      note: '下载已完成，媒体预览地址已清理。',
    };
  }
  await removeTaskRules(task);
  await saveTask(task);
  await notifyPreview(task);
  await revokeOffscreen(task.id);
  void maybeCloseOffscreen();
}

async function onDownloadInterrupted(task: TaskRecord, errorCode?: string): Promise<void> {
  if (task.status === 'cancelled' || task.status === 'completed') return;
  downloadTaskCache.delete(task.downloadId ?? -1);
  if (task.downloadId !== undefined) {
    await chrome.downloads.removeFile(task.downloadId).catch(() => undefined);
    await chrome.downloads.erase({ id: task.downloadId }).catch(() => undefined);
  }
  if (errorCode === 'USER_CANCELED') {
    task.status = 'cancelled';
    task.error = undefined;
  } else {
    task.status = 'failed';
    task.error = mapDownloadError(errorCode);
  }
  task.progress = undefined;
  task.expiresAt = Date.now() + TASK_TTL_MS;
  await removeTaskRules(task);
  await saveTask(task);
  await notifyPreview(task);
  await revokeOffscreen(task.id);
  void maybeCloseOffscreen();
}

function mapDownloadError(code?: string): TaskError {
  if (!code) return { code: 'HTTP_ERROR', message: '下载被浏览器中断，请重试。' };
  if (code === 'SERVER_FORBIDDEN') {
    return { code: 'HTTP_FORBIDDEN', message: '媒体服务器拒绝下载（HTTP 403），可能是防盗链限制。' };
  }
  if (code === 'SERVER_UNAUTHORIZED') {
    return { code: 'HTTP_UNAUTHORIZED', message: '服务器要求登录或授权（HTTP 401）。' };
  }
  if (code.startsWith('NETWORK_') || code === 'SERVER_FAILED' || code === 'SERVER_BAD_CONTENT') {
    return { code: 'NETWORK_ERROR', message: '网络中断或服务器不可用，下载失败。', detail: code };
  }
  if (code.startsWith('FILE_')) {
    return { code: 'INTERNAL_ERROR', message: '无法写入下载目录，请检查磁盘空间与权限。', detail: code };
  }
  return { code: 'HTTP_ERROR', message: `下载失败（${code}）。`, detail: code };
}

async function cancelBrowserDownload(downloadId: number): Promise<void> {
  await chrome.downloads.cancel(downloadId).catch(() => undefined);
  await chrome.downloads.removeFile(downloadId).catch(() => undefined);
  await chrome.downloads.erase({ id: downloadId }).catch(() => undefined);
}

async function revokeOffscreen(taskId: string): Promise<void> {
  if (!(await hasOffscreenDocument())) return;
  try {
    await chrome.runtime.sendMessage({ type: 'VVA_OFFSCREEN_REVOKE', taskId } satisfies OffscreenRequest);
  } catch {
    // 忽略。
  }
}

async function maybeCloseOffscreen(): Promise<void> {
  const tasks = await listTasks();
  if (tasks.some((task) => ACTIVE_STATUSES.has(task.status))) return;
  await closeOffscreenDocument();
}

async function cleanupExpiredTasks(): Promise<void> {
  const tasks = await listTasks();
  const now = Date.now();
  for (const task of tasks) {
    if (now <= task.expiresAt) continue;
    if (ACTIVE_STATUSES.has(task.status)) {
      task.expiresAt = now + TASK_TTL_MS;
      await saveTask(task);
      continue;
    }
    await expireTask(task);
  }
  if (await hasOffscreenDocument()) {
    // 清理崩溃后残留的 IndexedDB 分片。
    try {
      const active = (await listTasks()).filter((task) => ACTIVE_STATUSES.has(task.status));
      if (!active.length) await closeOffscreenDocument();
    } catch {
      // 忽略。
    }
  }
}

async function handleActionClick(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) return;
  if (!tab.url || !/^https?:\/\//i.test(tab.url)) return;
  try {
    const pong = (await chrome.tabs.sendMessage(tab.id, { type: 'VVA_PING' } satisfies RuntimeRequest)) as
      | ApiResponse<unknown>
      | undefined;
    if (pong?.ok) {
      await chrome.tabs.sendMessage(tab.id, { type: 'VVA_SHOW_HINT' } satisfies RuntimeRequest);
      return;
    }
  } catch {
    // 该页还没有内容脚本。
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['network-hook.js'],
      world: 'MAIN',
      injectImmediately: true,
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content-script.js'],
      world: 'ISOLATED',
      injectImmediately: true,
    });
    await chrome.tabs.sendMessage(tab.id, { type: 'VVA_SHOW_HINT' } satisfies RuntimeRequest);
  } catch (error) {
    logWarn('background', 'ACTIVE_TAB_INJECT_FAILED', error);
  }
}

function sanitizeSnapshot(raw: VideoSnapshot, senderUrl?: string): VideoSnapshot {
  if (!raw || typeof raw !== 'object') throw new AppError('PARSE_FAILED');
  const fallbackPageUrl = typeof raw.pageUrl === 'string' ? raw.pageUrl : '';
  const pageUrl = parseHttpUrl(senderUrl)?.href ?? parseHttpUrl(fallbackPageUrl)?.href;
  if (!pageUrl) throw new AppError('INVALID_URL', '页面地址无效');
  const platformId = isPlatformId(raw.platformId) ? raw.platformId : 'generic';
  const candidates = sanitizeCandidates(raw.candidates);
  if (!candidates.length) throw new AppError('UNSUPPORTED_FORMAT');
  const duration =
    typeof raw.duration === 'number' && Number.isFinite(raw.duration) && raw.duration > 0
      ? Math.min(raw.duration, 86400 * 7)
      : null;
  const width =
    typeof raw.width === 'number' && Number.isFinite(raw.width) && raw.width > 0
      ? Math.min(Math.round(raw.width), 16384)
      : null;
  const height =
    typeof raw.height === 'number' && Number.isFinite(raw.height) && raw.height > 0
      ? Math.min(Math.round(raw.height), 16384)
      : null;
  const coverUrl = parseHttpUrl(raw.coverUrl)?.href;
  return {
    schemaVersion: 1,
    pageUrl,
    pageTitle: safeText(raw.pageTitle, 300),
    platformId,
    platformName: PLATFORM_NAMES[platformId],
    title: safeText(raw.title, 300) || '未命名视频',
    ...(coverUrl ? { coverUrl } : {}),
    duration,
    width,
    height,
    isLive: Boolean(raw.isLive),
    drmDetected: Boolean(raw.drmDetected),
    hasAudio: typeof raw.hasAudio === 'boolean' ? raw.hasAudio : null,
    videoSrcKind:
      raw.videoSrcKind === 'direct' || raw.videoSrcKind === 'blob' ? raw.videoSrcKind : 'unknown',
    candidates,
    capturedAt: Date.now(),
  };
}

function safeText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function isPlatformId(value: unknown): value is PlatformId {
  return value === 'douyin' || value === 'kuaishou' || value === 'bilibili' || value === 'generic';
}

const FORMATS = new Set<MediaFormat>(['mp4', 'webm', 'hls', 'dash', 'dash-tracks', 'unknown']);
const ROLES = new Set<MediaRole>(['muxed', 'video', 'audio']);

function sanitizeCandidates(raw: unknown): MediaCandidate[] {
  if (!Array.isArray(raw)) return [];
  const candidates: MediaCandidate[] = [];
  for (const item of raw.slice(0, 12)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Partial<MediaCandidate>;
    if (typeof record.id !== 'string' || !record.id.trim()) continue;
    if (!FORMATS.has(record.format as MediaFormat) || record.format === 'unknown') continue;
    const format = record.format as MediaFormat;
    const url = record.url ? normalizeMediaUrl(record.url) : undefined;
    if (format === 'hls' || format === 'dash') {
      if (!url) continue;
    }
    const tracks = Array.isArray(record.tracks)
      ? record.tracks
          .slice(0, 4)
          .map((track) => {
            if (!track || typeof track !== 'object') return null;
            const role = track.role as MediaRole;
            if (!ROLES.has(role)) return null;
            const trackUrl = normalizeMediaUrl(track.url);
            if (!trackUrl) return null;
            return {
              url: trackUrl,
              role,
              ...(typeof track.mimeType === 'string' ? { mimeType: safeText(track.mimeType, 100) } : {}),
              ...(typeof track.codecs === 'string' ? { codecs: safeText(track.codecs, 100) } : {}),
              ...(positiveNumber(track.width) ? { width: Math.round(track.width!) } : {}),
              ...(positiveNumber(track.height) ? { height: Math.round(track.height!) } : {}),
              ...(positiveNumber(track.bandwidth) ? { bandwidth: Math.round(track.bandwidth!) } : {}),
            };
          })
          .filter((track): track is NonNullable<typeof track> => Boolean(track))
      : [];
    if (!tracks.length && !url) continue;
    if (format === 'dash-tracks' && !tracks.some((track) => track.role === 'video')) continue;
    candidates.push({
      id: record.id.slice(0, 60),
      format,
      ...(url ? { url } : {}),
      tracks: tracks.length ? tracks : url ? [{ url, role: 'muxed' }] : [],
      ...(positiveNumber(record.width) ? { width: Math.round(record.width!) } : {}),
      ...(positiveNumber(record.height) ? { height: Math.round(record.height!) } : {}),
      ...(typeof record.contentType === 'string' ? { contentType: safeText(record.contentType, 120) } : {}),
      ...(typeof record.label === 'string' ? { label: safeText(record.label, 120) } : {}),
      source:
        record.source === 'network' ||
        record.source === 'performance' ||
        record.source === 'page-data' ||
        record.source === 'video-src'
          ? record.source
          : 'video-src',
      ...(record.requiresReferer ? { requiresReferer: true } : {}),
    });
  }
  return candidates;
}

function normalizeMediaUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const url = parseHttpUrl(value);
  if (!url) return undefined;
  if (url.username || url.password) return undefined;
  url.hash = '';
  return url.href;
}

function positiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
