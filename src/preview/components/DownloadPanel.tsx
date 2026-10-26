import type { DownloadProgress, TaskAnalysis, TaskRecord } from '../../shared/types';
import { formatProgressPercent } from '../../shared/format';

interface DownloadPanelProps {
  task: TaskRecord;
  analysis?: TaskAnalysis;
  busy: boolean;
  actionError?: string;
  onPrimary: () => void;
  onCancel: () => void;
  onClose: () => void;
  onRetryPrepare: () => void;
}

const ACTIVE = new Set(['preparing', 'downloading', 'converting', 'saving']);

const STATUS_LABEL: Record<TaskRecord['status'], string> = {
  ready: '待下载',
  preparing: '准备中',
  downloading: '下载中',
  converting: '转换中',
  saving: '保存中',
  completed: '已完成',
  cancelled: '已取消',
  failed: '未完成',
};

function stageLabel(progress: DownloadProgress | undefined): string {
  if (!progress) return '';
  switch (progress.stage) {
    case 'preparing':
      return '正在准备';
    case 'downloading':
      return '正在下载';
    case 'converting':
      return '正在转换为 MP4';
    case 'saving':
      return '正在保存文件';
    default:
      return '';
  }
}

function primaryLabel(task: TaskRecord, analysis?: TaskAnalysis): string {
  switch (task.status) {
    case 'ready':
      return '下载 MP4';
    case 'preparing':
      return '正在准备…';
    case 'downloading':
      return '下载中…';
    case 'converting':
      return '转换中…';
    case 'saving':
      return '保存中…';
    case 'completed':
      return '已保存 MP4';
    case 'cancelled':
      return '重新下载';
    case 'failed':
      return analysis ? '重试下载' : '重新解析';
    default:
      return '下载 MP4';
  }
}

export function DownloadPanel({
  task,
  analysis,
  busy,
  actionError,
  onPrimary,
  onCancel,
  onClose,
  onRetryPrepare,
}: DownloadPanelProps) {
  const active = ACTIVE.has(task.status);
  const progress = task.progress;
  const determinate = progress?.percent !== undefined && progress.percent !== null;
  const percent = progress?.percent ?? 0;
  const errorMessage =
    actionError ||
    (task.status === 'failed' ? task.error?.message ?? '任务未完成，请重试。' : undefined);
  const canPrimary =
    !busy &&
    (task.status === 'ready' ||
      task.status === 'cancelled' ||
      (task.status === 'failed' && Boolean(analysis)) ||
      (task.status === 'failed' && !analysis));
  const primaryAction = task.status === 'failed' && !analysis ? onRetryPrepare : onPrimary;

  return (
    <section className="download-panel" aria-labelledby="download-status-heading">
      <div className="download-panel__top">
        <div>
          <p className="eyebrow">输出文件</p>
          <h2 id="download-status-heading">MP4 · 本机处理</h2>
        </div>
        <span className={`status-pill status-pill--${task.status}`}>
          <span className="status-pill__dot" aria-hidden="true" />
          {STATUS_LABEL[task.status]}
        </span>
      </div>

      {active ? (
        <div className="progress" aria-live="polite">
          <div className="progress__head">
            <span>{stageLabel(progress) || '正在处理'}</span>
            {determinate ? <strong>{formatProgressPercent(percent)}</strong> : <span className="progress__unknown">进度不确定</span>}
          </div>
          <div
            className={`progress__track ${determinate ? '' : 'progress__track--indeterminate'}`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            {...(determinate ? { 'aria-valuenow': Math.round(percent) } : {})}
            aria-label={stageLabel(progress) || '处理进度'}
          >
            <span
              className="progress__fill"
              style={determinate ? { width: `${percent}%` } : undefined}
            />
          </div>
          <p className="progress__detail">
            {progress?.segmentsTotal
              ? `已处理 ${progress.segmentsDone ?? 0} / ${progress.segmentsTotal} 个分片`
              : progress?.message ?? '请保持页面打开或关闭后等待后台完成。'}
          </p>
        </div>
      ) : null}

      {task.status === 'completed' ? (
        <div className="complete-box" role="status">
          <span className="complete-box__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="m5 12.5 4.2 4.2L19.2 6.7" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <div>
            <strong>文件已保存到默认下载目录</strong>
            <p>如果下载栏未自动打开，可在浏览器下载记录中查看。</p>
          </div>
        </div>
      ) : null}

      {task.status === 'cancelled' ? (
        <p className="inline-note inline-note--muted">下载已取消，临时分片已清理。可以重新开始。</p>
      ) : null}

      {errorMessage ? (
        <div className="inline-alert" role="alert">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="8.7" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M12 7.6v5.2m0 3.1v.1" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
          <span>{errorMessage}</span>
        </div>
      ) : null}

      {task.status === 'failed' && !analysis ? (
        <p className="inline-note">
          解析阶段未完成，未生成任何文件。可重新解析，或返回视频页面确认视频可正常播放。
        </p>
      ) : null}

      <div className="download-panel__actions">
        <button
          type="button"
          className="button button--primary"
          onClick={primaryAction}
          disabled={!canPrimary}
        >
          {active && busy ? (
            <span className="spinner spinner--small" aria-hidden="true" />
          ) : null}
          {primaryLabel(task, analysis)}
        </button>
        {active ? (
          <button type="button" className="button button--secondary" onClick={onCancel} disabled={busy}>
            取消下载
          </button>
        ) : (
          <button type="button" className="button button--secondary" onClick={onClose} disabled={busy}>
            关闭
          </button>
        )}
      </div>

      {active ? (
        <p className="download-panel__footnote">
          {task.status === 'preparing'
            ? '媒体分析会在扩展后台继续；关闭此页面不会创建下载。'
            : '下载会继续在扩展后台执行，关闭此页面不会中断。转换期间请勿卸载扩展。'}
        </p>
      ) : (
        <p className="download-panel__footnote">
          文件只在本机处理。若文件较大或大小未知，开始前会再次确认。
        </p>
      )}
    </section>
  );
}
