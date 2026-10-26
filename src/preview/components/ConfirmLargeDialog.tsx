import { useEffect, useRef } from 'react';
import type { TaskAnalysis } from '../../shared/types';
import { formatBytes } from '../../shared/format';

interface ConfirmLargeDialogProps {
  open: boolean;
  analysis: TaskAnalysis;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmLargeDialog({
  open,
  analysis,
  busy,
  onConfirm,
  onCancel,
}: ConfirmLargeDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement;
    const timer = window.setTimeout(() => confirmRef.current?.focus(), 40);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.body.classList.add('modal-open');
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown);
      document.body.classList.remove('modal-open');
      if (previousFocus.current instanceof HTMLElement) previousFocus.current.focus();
    };
  }, [open, onCancel]);

  if (!open) return null;

  const unknown = analysis.sizeBytes === null;
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <div className="modal__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M12 3.6 21 20H3L12 3.6Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
            <path d="M12 9v5m0 2.6v.1" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
        </div>
        <h2 id="confirm-title">{unknown ? '文件大小未知' : '文件较大，确认下载？'}</h2>
        <div className="modal__body">
          {unknown ? (
            <p>服务器未提供可靠的文件大小，无法预估本次下载或转封装占用的磁盘空间。</p>
          ) : (
            <p>
              预估文件大小为 <strong>{formatBytes(analysis.sizeBytes, { approximate: analysis.sizeApprox })}</strong>，
              超过 500 MB 提示阈值。
            </p>
          )}
          {analysis.downloadMode === 'convert' ? (
            <p>该视频需要在本机重新封装为 MP4，处理期间会占用额外内存和磁盘空间，耗时取决于文件大小。</p>
          ) : (
            <p>文件将直接保存到浏览器默认下载目录，请确认磁盘空间充足。</p>
          )}
          <p className="modal__hint">视频不会上传到任何服务器。</p>
        </div>
        <div className="modal__actions">
          <button type="button" className="button button--secondary" onClick={onCancel} disabled={busy}>
            返回
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="button button--primary"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <span className="spinner spinner--small" aria-hidden="true" /> : null}
            继续下载
          </button>
        </div>
      </div>
    </div>
  );
}
