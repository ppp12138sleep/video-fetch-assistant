import { useCallback, useEffect, useRef, useState } from 'react';
import {
  formatBytes,
  formatDuration,
  formatMediaFormat,
  formatResolution,
  formatShortDuration,
} from '../shared/format';
import { sendRuntime } from '../shared/messaging';
import type { TaskAnalysis, TaskRecord } from '../shared/types';
import { LARGE_FILE_WARNING_BYTES } from '../shared/types';
import { ConfirmLargeDialog } from './components/ConfirmLargeDialog';
import { DownloadPanel } from './components/DownloadPanel';
import { VideoPlayer } from './components/VideoPlayer';
import { useTask } from './useTask';

const ACTIVE = new Set(['preparing', 'downloading', 'converting', 'saving']);

function needsLargeConfirm(analysis: TaskAnalysis): boolean {
  return analysis.sizeBytes === null || analysis.sizeBytes > LARGE_FILE_WARNING_BYTES;
}

export function App() {
  const { taskId, task, fatal, loading, reload, setTask } = useTask();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const prepareRequested = useRef(false);
  const analysis = task?.analysis;

  const refreshTask = useCallback(async (): Promise<TaskRecord | null> => {
    const response = await sendRuntime<TaskRecord>({ type: 'VVA_GET_TASK', taskId });
    if (response.ok) {
      setTask(response.data);
      return response.data;
    }
    return null;
  }, [taskId, setTask]);

  useEffect(() => {
    if (!task) {
      document.title = '视频预览 · 视频获取助手';
      return;
    }
    document.title = `${task.snapshot.title} · 视频获取助手`;
    return () => {
      document.title = '视频预览 · 视频获取助手';
    };
  }, [task]);

  useEffect(() => {
    if (!task || analysis || prepareRequested.current) return;
    if (task.status !== 'ready') return;
    prepareRequested.current = true;
    let alive = true;
    setBusy(true);
    void (async () => {
      const response = await sendRuntime<TaskRecord>({ type: 'VVA_PREPARE_TASK', taskId });
      if (!alive) return;
      if (response.ok) {
        setTask(response.data);
        setActionError(undefined);
      } else {
        setActionError(response.error.message);
        await refreshTask();
      }
    })().finally(() => {
      setBusy(false);
    });
    return () => {
      alive = false;
    };
  }, [analysis, refreshTask, setTask, task, taskId]);

  useEffect(() => {
    if (task && ACTIVE.has(task.status) && confirmOpen) setConfirmOpen(false);
  }, [confirmOpen, task]);

  const closePage = useCallback(async () => {
    try {
      const tab = await chrome.tabs.getCurrent();
      if (tab?.id !== undefined) {
        await chrome.tabs.remove(tab.id);
      } else {
        window.close();
      }
    } catch {
      window.close();
    }
  }, []);

  const handleClose = useCallback(async () => {
    if (!task) {
      await closePage();
      return;
    }
    setBusy(true);
    try {
      await sendRuntime<{ closed: boolean }>({ type: 'VVA_CLOSE_TASK', taskId });
    } finally {
      setBusy(false);
      await closePage();
    }
  }, [closePage, task, taskId]);

  const startDownload = useCallback(
    async (confirmLarge: boolean) => {
      setBusy(true);
      setActionError(undefined);
      try {
        const response = await sendRuntime<TaskRecord>({
          type: 'VVA_START_DOWNLOAD',
          taskId,
          options: { confirmLarge },
        });
        if (response.ok) {
          setTask(response.data);
          setConfirmOpen(false);
        } else if (response.error.code === 'CONFIRM_REQUIRED') {
          setConfirmOpen(true);
        } else {
          setActionError(response.error.message);
          await refreshTask();
        }
      } finally {
        setBusy(false);
      }
    },
    [refreshTask, setTask, taskId],
  );

  const requestStart = useCallback(
    async (current: TaskRecord) => {
      const currentAnalysis = current.analysis;
      if (!currentAnalysis) {
        setActionError('媒体信息尚未分析完成，请稍候。');
        return;
      }
      if (needsLargeConfirm(currentAnalysis)) {
        setConfirmOpen(true);
        return;
      }
      await startDownload(false);
    },
    [startDownload],
  );

  const handlePrimary = useCallback(async () => {
    if (!task || busy) return;
    setActionError(undefined);
    if (task.status === 'failed' || task.status === 'cancelled') {
      setBusy(true);
      const retry = await sendRuntime<TaskRecord>({ type: 'VVA_RETRY_TASK', taskId });
      if (!retry.ok) {
        setBusy(false);
        setActionError(retry.error.message);
        return;
      }
      setBusy(false);
      if (!retry.data.analysis) {
        prepareRequested.current = false;
        setTask(retry.data);
        return;
      }
      setTask(retry.data);
      await requestStart(retry.data);
      return;
    }
    await requestStart(task);
  }, [busy, requestStart, setTask, task, taskId]);

  const handleCancel = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setActionError(undefined);
    try {
      const response = await sendRuntime<TaskRecord>({ type: 'VVA_CANCEL_TASK', taskId });
      if (response.ok) {
        setTask(response.data);
      } else {
        setActionError(response.error.message);
      }
    } finally {
      setBusy(false);
    }
  }, [busy, setTask, taskId]);

  const handleRetryPrepare = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setActionError(undefined);
    prepareRequested.current = true;
    try {
      const response = await sendRuntime<TaskRecord>({ type: 'VVA_PREPARE_TASK', taskId });
      if (response.ok) {
        setTask(response.data);
      } else {
        setActionError(response.error.message);
        await refreshTask();
      }
    } finally {
      setBusy(false);
    }
  }, [busy, refreshTask, setTask, taskId]);

  const confirm = useCallback(async () => {
    setConfirmOpen(false);
    await startDownload(true);
  }, [startDownload]);

  const cancelConfirm = useCallback(() => {
    if (!busy) setConfirmOpen(false);
  }, [busy]);

  return (
    <div className="app">
      <div className="ambient ambient--one" aria-hidden="true" />
      <div className="ambient ambient--two" aria-hidden="true" />
      <header className="topbar">
        <div className="brand">
          <LogoMark />
          <div className="brand__text">
            <span className="brand__name">视频获取助手</span>
            <span className="brand__sub">本机解析 · 不上传视频</span>
          </div>
        </div>
        <div className="topbar__actions">
          <span className="privacy-badge">
            <ShieldIcon />
            隐私优先
          </span>
          <button
            type="button"
            className="icon-button"
            onClick={handleClose}
            aria-label="关闭预览页"
            title="关闭预览页"
          >
            <CloseIcon />
          </button>
        </div>
      </header>

      <main className="shell">
        {loading && !task ? <LoadingView /> : null}
        {!loading && fatal ? (
          <FatalView message={fatal.message} code={fatal.code} onRetry={reload} onClose={closePage} />
        ) : task ? (
          <section className="task-card" aria-label="视频任务详情">
            <div className="task-card__media">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">当前视频</p>
                  <h1 className="video-title" title={task.snapshot.title}>
                    {task.snapshot.title}
                  </h1>
                </div>
                <span className="platform-chip">{task.snapshot.platformName}</span>
              </div>
              <VideoPlayer
                analysis={analysis}
                coverUrl={task.snapshot.coverUrl}
                title={task.snapshot.title}
                loading={!analysis && (loading || task.status === 'preparing')}
              />
              <div className="meta-row" aria-label="视频信息">
                <MetaChip label="平台" value={task.snapshot.platformName} />
                <MetaChip
                  label="时长"
                  value={formatDuration(analysis?.duration ?? task.snapshot.duration)}
                />
                <MetaChip
                  label="分辨率"
                  value={formatResolution(
                    analysis?.width ?? task.snapshot.width,
                    analysis?.height ?? task.snapshot.height,
                  )}
                />
                <MetaChip
                  label="格式"
                  value={formatMediaFormat(analysis?.format ?? task.snapshot.candidates[0]?.format ?? 'unknown')}
                />
              </div>
              <div className="media-note">
                <LockIcon />
                <span>封面与预览来自原站点，下载和转封装在浏览器本机完成。</span>
              </div>
            </div>

            <aside className="task-card__side">
              <div className="size-block">
                <span className="size-block__label">预计文件大小</span>
                {analysis ? (
                  <>
                    <strong className="size-block__value">
                      {analysis.sizeBytes === null
                        ? '大小未知'
                        : formatBytes(analysis.sizeBytes, { approximate: analysis.sizeApprox })}
                    </strong>
                    <p className="size-block__note">
                      {analysis.sizeNote ??
                        (analysis.sizeBytes === null
                          ? '服务器未提供大小，下载前会再次确认。'
                          : '大小取自媒体服务器或清单元数据。')}
                    </p>
                  </>
                ) : (
                  <div className="size-block__skeleton" aria-label="正在读取文件大小">
                    <span className="skeleton skeleton--value" />
                    <span className="skeleton skeleton--line" />
                  </div>
                )}
              </div>

              <div className="divider" />

              <dl className="detail-list">
                <DetailItem label="时长" value={formatShortDuration(analysis?.duration ?? task.snapshot.duration)} />
                <DetailItem
                  label="分辨率"
                  value={formatResolution(
                    analysis?.width ?? task.snapshot.width,
                    analysis?.height ?? task.snapshot.height,
                  )}
                />
                <DetailItem label="输出容器" value="MP4" />
                <DetailItem
                  label="处理方式"
                  value={analysis?.downloadMode === 'direct' ? '浏览器直链下载' : analysis ? '本机重新封装' : '分析中'}
                />
              </dl>

              {analysis?.warnings.length ? (
                <div className="warning-box">
                  <span className="warning-box__title">请注意</span>
                  <ul>
                    {analysis.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <DownloadPanel
                task={task}
                analysis={analysis}
                busy={busy}
                actionError={actionError}
                onPrimary={() => void handlePrimary()}
                onCancel={() => void handleCancel()}
                onClose={() => void handleClose()}
                onRetryPrepare={() => void handleRetryPrepare()}
              />
            </aside>
          </section>
        ) : null}

        {!loading && !fatal && !task ? (
          <FatalView
            message="没有找到任务数据。请回到视频页面重新点击「获取视频」。"
            code="TASK_NOT_FOUND"
            onRetry={reload}
            onClose={closePage}
          />
        ) : null}
      </main>

      <footer className="footer">
        <span>仅用于下载你有权保存的内容，请遵守平台服务条款与著作权法律。</span>
        <span>视频获取助手 v1.0</span>
      </footer>

      {analysis ? (
        <ConfirmLargeDialog
          open={confirmOpen}
          analysis={analysis}
          busy={busy}
          onConfirm={() => void confirm()}
          onCancel={cancelConfirm}
        />
      ) : null}
    </div>
  );
}

function LogoMark() {
  return (
    <span className="logo-mark" aria-hidden="true">
      <svg viewBox="0 0 40 40">
        <rect width="40" height="40" rx="12" fill="url(#vva-logo-gradient)" />
        <path d="M20 9.5v14m0 0 5.2-5.2M20 23.5l-5.2-5.2" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M13 27.8h14" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" opacity=".9" />
        <defs>
          <linearGradient id="vva-logo-gradient" x1="4" y1="2" x2="36" y2="38" gradientUnits="userSpaceOnUse">
            <stop stopColor="#FF7A45" />
            <stop offset="1" stopColor="#F04424" />
          </linearGradient>
        </defs>
      </svg>
    </span>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.2 19 6v5.1c0 4.3-2.8 7.7-7 9.7-4.2-2-7-5.4-7-9.7V6l7-2.8Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="m9 12 2 2 4-4.3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="10.2" width="14" height="10" rx="2.3" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8.4 10.2V8a3.6 3.6 0 0 1 7.2 0v2.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6.5 6.5 11 11m0-11-11 11" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

function MetaChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="meta-chip">
      <span className="meta-chip__label">{label}</span>
      <span className="meta-chip__value">{value}</span>
    </span>
  );
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-item">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function LoadingView() {
  return (
    <section className="task-card task-card--loading" aria-label="正在加载任务">
      <div className="task-card__media">
        <div className="skeleton skeleton--heading" />
        <div className="skeleton skeleton--player" />
        <div className="skeleton-row">
          <span className="skeleton skeleton--chip" />
          <span className="skeleton skeleton--chip" />
          <span className="skeleton skeleton--chip" />
        </div>
      </div>
      <aside className="task-card__side">
        <span className="skeleton skeleton--value" />
        <span className="skeleton skeleton--line" />
        <span className="skeleton skeleton--line" />
        <div className="skeleton skeleton--panel" />
      </aside>
      <span className="loading-label">
        <span className="spinner" aria-hidden="true" />
        正在读取任务…
      </span>
    </section>
  );
}

function FatalView({
  message,
  code,
  onRetry,
  onClose,
}: {
  message: string;
  code: string;
  onRetry: () => void;
  onClose: () => void;
}) {
  const expired = code === 'TASK_EXPIRED';
  const title = expired ? '任务已过期' : code === 'TASK_NOT_FOUND' ? '任务不存在' : '预览暂时不可用';
  return (
    <section className="fatal-card">
      <div className="fatal-card__icon" aria-hidden="true">
        <svg viewBox="0 0 48 48">
          <rect x="7" y="10" width="34" height="26" rx="5" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M17 41h14M24 36v5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M20 22h8M24 18v8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity=".55" />
        </svg>
      </div>
      <p className="eyebrow">任务无法继续</p>
      <h1>{title}</h1>
      <p className="fatal-card__message">{message}</p>
      <p className="fatal-card__hint">
        {expired
          ? '为保护隐私并释放空间，任务与临时媒体数据会在过期后自动清理。'
          : '如问题持续，请关闭此页面后回到视频页面重新点击「获取视频」。'}
      </p>
      <div className="fatal-card__actions">
        {!expired && code !== 'TASK_NOT_FOUND' ? (
          <button type="button" className="button button--secondary" onClick={onRetry}>
            重试连接
          </button>
        ) : null}
        <button type="button" className="button button--primary" onClick={onClose}>
          关闭页面
        </button>
      </div>
    </section>
  );
}
