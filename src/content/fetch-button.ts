import { BUTTON_TEXT } from '../shared/constants';

export type FetchButtonState = 'idle' | 'parsing' | 'success' | 'error';

const ICONS = {
  idle: `<svg class="vva-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4.2-4.2M12 14 7.8 9.8M5 16.5v2.2c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2v-2.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  spinner: `<svg class="vva-icon vva-spinner" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="2.4"/><path d="M20.5 12A8.5 8.5 0 0 0 12 3.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`,
  success: `<svg class="vva-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.2 4.2L19.2 6.7" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  error: `<svg class="vva-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7.5v6m0 3.2v.1" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/><circle cx="12" cy="12" r="8.8" fill="none" stroke="currentColor" stroke-width="1.7" opacity=".7"/></svg>`,
};

const CSS = `
:host {
  all: initial;
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
  color-scheme: dark;
}
* { box-sizing: border-box; }
.layer {
  position: fixed;
  inset: 0;
  pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
.anchor {
  position: absolute;
  right: 24px;
  bottom: 88px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  pointer-events: none;
  transition: bottom 180ms ease;
}
.anchor--raised { bottom: 148px; }
.button {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 44px;
  min-width: 116px;
  padding: 0 17px 0 14px;
  border: 1px solid rgba(255, 255, 255, .14);
  border-radius: 999px;
  background: rgba(17, 24, 39, .88);
  color: #fff;
  font: 600 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  letter-spacing: .01em;
  cursor: pointer;
  box-shadow: 0 8px 24px rgba(0, 0, 0, .3), 0 1px 2px rgba(0, 0, 0, .2);
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  transition: transform 170ms ease, background-color 170ms ease, border-color 170ms ease, box-shadow 170ms ease;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.button:hover:not(:disabled) {
  transform: translateY(-1px);
  background: rgba(28, 38, 58, .94);
  border-color: rgba(255, 255, 255, .24);
  box-shadow: 0 12px 28px rgba(0, 0, 0, .36);
}
.button:active:not(:disabled) { transform: scale(.975); }
.button:focus-visible {
  outline: 2px solid #FF8A5C;
  outline-offset: 3px;
}
.button:disabled { cursor: progress; opacity: .92; }
.button[data-state="success"] .vva-icon { color: #5BE2A6; }
.button[data-state="error"] .vva-icon { color: #FF8C7A; }
.vva-icon {
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  color: #FF7A45;
  display: block;
}
.vva-spinner { animation: vva-spin 850ms linear infinite; }
.label { white-space: nowrap; }
.toast {
  pointer-events: none;
  max-width: min(320px, calc(100vw - 32px));
  padding: 10px 13px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, .13);
  background: rgba(12, 18, 30, .96);
  color: #E8EDF7;
  font: 500 12.5px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  box-shadow: 0 10px 30px rgba(0, 0, 0, .35);
  opacity: 0;
  transform: translateY(5px);
  transition: opacity 180ms ease, transform 180ms ease;
  text-align: left;
  overflow-wrap: anywhere;
}
.toast[data-visible="true"] { opacity: 1; transform: translateY(0); }
.toast[data-kind="error"] { border-color: rgba(255, 122, 69, .35); }
@media (max-width: 720px) {
  .anchor { right: 16px; bottom: 88px; }
  .anchor--raised { bottom: 148px; }
  .button { height: 44px; min-width: 108px; padding: 0 15px 0 13px; font-size: 13.5px; }
}
@media (prefers-reduced-motion: reduce) {
  .button, .toast, .anchor { transition: none; }
  .button:hover:not(:disabled) { transform: none; }
  .button:active:not(:disabled) { transform: none; }
  .vva-spinner { animation-duration: 1.6s; }
}
`;

export class FetchButton {
  readonly host: HTMLDivElement;
  private readonly shadow: ShadowRoot;
  private readonly button: HTMLButtonElement;
  private readonly iconSlot: HTMLSpanElement;
  private readonly toast: HTMLDivElement;
  private readonly anchor: HTMLDivElement;
  private state: FetchButtonState = 'idle';
  private toastTimer = 0;
  private resetTimer = 0;
  private hidden = false;
  private readonly clickHandler: (event: MouseEvent) => void;

  constructor(onFetch: () => void) {
    this.host = document.createElement('div');
    this.host.dataset.vvaUi = 'true';
    this.host.id = 'vva-fetch-root';
    this.host.style.all = 'initial';
    this.shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;

    const layer = document.createElement('div');
    layer.className = 'layer';
    const anchor = document.createElement('div');
    anchor.className = 'anchor';
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.dataset.visible = 'false';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button';
    button.dataset.state = 'idle';
    button.setAttribute('aria-label', `${BUTTON_TEXT}，解析当前播放的视频`);
    const iconSlot = document.createElement('span');
    iconSlot.className = 'icon-slot';
    iconSlot.innerHTML = ICONS.idle;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = BUTTON_TEXT;
    button.append(iconSlot, label);
    anchor.append(toast, button);
    layer.append(anchor);
    this.shadow.append(style, layer);

    this.button = button;
    this.iconSlot = iconSlot;
    this.toast = toast;
    this.anchor = anchor;
    this.clickHandler = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.state === 'parsing') return;
      onFetch();
    };
    button.addEventListener('click', this.clickHandler);
  }

  get element(): HTMLDivElement {
    return this.host;
  }

  get isMounted(): boolean {
    return this.host.isConnected;
  }

  get isHidden(): boolean {
    return this.hidden;
  }

  setRaised(raised: boolean): void {
    this.anchor.classList.toggle('anchor--raised', raised);
  }

  mount(parent: Element): void {
    if (!this.host.isConnected || this.host.parentElement !== parent) {
      parent.append(this.host);
    }
    this.host.style.display = this.hidden ? 'none' : '';
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.host.style.display = hidden ? 'none' : '';
  }

  setState(state: FetchButtonState): void {
    this.state = state;
    this.button.dataset.state = state;
    this.button.disabled = state === 'parsing';
    this.button.setAttribute('aria-busy', state === 'parsing' ? 'true' : 'false');
    this.iconSlot.innerHTML = ICONS[state === 'parsing' ? 'spinner' : state];
    window.clearTimeout(this.resetTimer);
    if (state === 'success' || state === 'error') {
      this.resetTimer = window.setTimeout(() => {
        if (this.state === state) this.setState('idle');
      }, 1400);
    }
  }

  showToast(message: string, kind: 'error' | 'info' = 'error', durationMs = 5200): void {
    window.clearTimeout(this.toastTimer);
    this.toast.textContent = message;
    this.toast.dataset.kind = kind;
    this.toast.dataset.visible = 'true';
    this.toastTimer = window.setTimeout(() => {
      this.toast.dataset.visible = 'false';
    }, durationMs);
  }

  destroy(): void {
    window.clearTimeout(this.toastTimer);
    window.clearTimeout(this.resetTimer);
    this.button.removeEventListener('click', this.clickHandler);
    this.host.remove();
  }
}
