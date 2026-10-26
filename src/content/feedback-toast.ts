const FEEDBACK_ATTR = 'data-vva-feedback';

const CSS = `
:host {
  all: initial;
  position: fixed;
  inset: 0;
  z-index: 2147483001;
  pointer-events: none;
  color-scheme: dark;
}
.toast {
  position: fixed;
  right: 24px;
  bottom: 88px;
  max-width: min(340px, calc(100vw - 32px));
  padding: 11px 14px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 12px;
  background: rgba(12, 18, 30, 0.97);
  color: #e8edf7;
  font: 500 12.5px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.38);
  opacity: 0;
  transform: translateY(5px);
  transition: opacity 180ms ease, transform 180ms ease;
  text-align: left;
  overflow-wrap: anywhere;
}
.toast[data-visible="true"] {
  opacity: 1;
  transform: translateY(0);
}
@media (max-width: 720px) {
  .toast { right: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .toast { transition: none; transform: none; }
}
`;

export function showTransientToast(message: string, durationMs = 4600): void {
  document.querySelectorAll<HTMLElement>(`[${FEEDBACK_ATTR}]`).forEach((node) => node.remove());
  const host = document.createElement('div');
  host.setAttribute(FEEDBACK_ATTR, 'true');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.textContent = message;
  shadow.append(style, toast);
  const parent = document.fullscreenElement instanceof Element ? document.fullscreenElement : document.body;
  parent.append(host);
  window.requestAnimationFrame(() => {
    toast.dataset.visible = 'true';
  });
  window.setTimeout(() => {
    toast.dataset.visible = 'false';
    window.setTimeout(() => host.remove(), 220);
  }, durationMs);
}
