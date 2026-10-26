import { CONTENT_SCRIPT_GUARD } from '../shared/constants';
import { AppError, toAppError, toTaskError } from '../shared/errors';
import type { ErrorCode } from '../shared/errors';
import { logWarn } from '../shared/logger';
import { sendRuntime } from '../shared/messaging';
import type {
  CreateTaskResult,
  MediaCandidate,
  RuntimeRequest,
  VideoSnapshot,
} from '../shared/types';
import { SNAPSHOT_VERSION } from '../shared/types';
import { parseHttpUrl } from '../shared/url';
import { selectAdapter } from './adapters';
import type { AdapterResult } from './adapters';
import { FetchButton } from './fetch-button';
import { showTransientToast } from './feedback-toast';
import { PageBridge } from './page-bridge';
import { findPrimaryVideo, getModalState, getOverlayParent } from './video-probe';

declare global {
  interface Window {
    [CONTENT_SCRIPT_GUARD]?: boolean;
  }
}

const shouldStart = !window[CONTENT_SCRIPT_GUARD];
if (shouldStart) {
  // 静态注册与 activeTab 注入可能同时发生，只允许一个控制器。
  window[CONTENT_SCRIPT_GUARD] = true;
}

class ContentController {
  private button: FetchButton | null = null;
  private bridge: PageBridge | null = null;
  private observer: MutationObserver | null = null;
  private scanTimer = 0;
  private routeTimer = 0;
  private pollTimer = 0;
  private parseInFlight = false;
  private currentKey = '';
  private lastUrl = '';
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.lastUrl = location.href;
    this.bridge = new PageBridge();

    chrome.runtime.onMessage.addListener((message: RuntimeRequest, _sender, sendResponse) => {
      if (message.type === 'VVA_PING') {
        sendResponse({ ok: true, data: { platform: this.detectPlatform() } });
        return false;
      }
      if (message.type === 'VVA_RESCAN') {
        this.scheduleScan(0);
        sendResponse({ ok: true, data: null });
        return false;
      }
      if (message.type === 'VVA_SHOW_HINT') {
        this.showActionHint();
        sendResponse({ ok: true, data: null });
        return false;
      }
      return false;
    });

    window.addEventListener('popstate', this.onRouteEvent, { passive: true });
    window.addEventListener('hashchange', this.onRouteEvent, { passive: true });
    document.addEventListener('vva-route-change', this.onRouteEvent);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', this.onFullscreenChange as EventListener);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.scheduleScan(200);
    });

    const target = document.documentElement;
    this.observer = new MutationObserver(() => {
      this.scheduleScan(300);
    });
    this.observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'class', 'style', 'hidden', 'aria-hidden'],
    });

    this.pollTimer = window.setInterval(() => {
      if (location.href !== this.lastUrl) this.handleRouteChange();
    }, 750);

    this.scheduleScan(0);
    window.setTimeout(() => this.scheduleScan(0), 300);
    window.setTimeout(() => this.scheduleScan(0), 1000);
  }

  private detectPlatform(): string {
    return selectAdapter(location.href).id;
  }

  private readonly onRouteEvent = (): void => {
    this.handleRouteChange();
  };

  private handleRouteChange(): void {
    if (location.href === this.lastUrl) return;
    this.lastUrl = location.href;
    this.bridge?.clearForRoute();
    this.currentKey = '';
    this.button?.setState('idle');
    window.clearTimeout(this.routeTimer);
    this.routeTimer = window.setTimeout(() => this.scheduleScan(0), 300);
    this.scheduleScan(300);
  }

  private readonly onFullscreenChange = (): void => {
    if (!this.button) return;
    if (!document.fullscreenElement && !(document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement) {
      this.button.mount(document.body);
      return;
    }
    this.button.mount(getOverlayParent());
    this.scheduleScan(0);
  };

  private scheduleScan(delay: number): void {
    window.clearTimeout(this.scanTimer);
    this.scanTimer = window.setTimeout(() => this.scan(), delay);
  }

  private scan(): void {
    if (!document.body) return;
    if (location.href !== this.lastUrl) {
      this.handleRouteChange();
      return;
    }

    for (const stale of Array.from(document.querySelectorAll<HTMLElement>('[data-vva-ui="true"]'))) {
      if (stale !== this.button?.element) stale.remove();
    }

    const primary = findPrimaryVideo();
    if (!primary) {
      if (!this.parseInFlight) this.destroyButton();
      return;
    }

    // 视频详情页/直播播放器本身也可能是一个 dialog。只要 dialog 包含当前视频，
    // 就不能把它当成登录/支付弹窗而隐藏按钮；仅把按钮上移避开底部关闭按钮。
    const modal = getModalState(primary.element);
    if (modal.blocking) {
      this.button?.setHidden(true);
      return;
    }

    const key = [
      this.lastUrl,
      primary.source,
      Math.round(primary.width),
      Math.round(primary.height),
    ].join('|');
    if (key !== this.currentKey) {
      this.currentKey = key;
      this.button?.setState('idle');
      this.button?.setHidden(false);
    }

    if (!this.button) {
      this.button = new FetchButton(() => {
        void this.handleFetch();
      });
    }
    this.button.mount(getOverlayParent());
    this.button.setRaised(modal.videoModal);
    this.button.setHidden(false);
  }

  private showActionHint(): void {
    this.scheduleScan(0);
    window.setTimeout(() => {
      this.scan();
      const primary = findPrimaryVideo();
      if (!primary) {
        showTransientToast('当前页面没有检测到可获取的 HTML5 视频。');
        return;
      }
      if (!this.button) {
        showTransientToast('已检测到视频，但按钮尚未就绪，请刷新页面后重试。');
        return;
      }
      if (this.button.isHidden) {
        showTransientToast('检测到平台登录/支付弹窗，按钮暂时隐藏；关闭弹窗后会自动恢复。');
        return;
      }
      this.button.showToast('已检测到视频，请点击右下角「获取视频」。', 'info', 3200);
    }, 420);
  }

  private destroyButton(): void {
    this.button?.destroy();
    this.button = null;
    this.currentKey = '';
  }

  private async handleFetch(): Promise<void> {
    if (this.parseInFlight) return;
    this.parseInFlight = true;
    const button = this.button;
    button?.setState('parsing');
    try {
      const primary = findPrimaryVideo();
      if (!primary) throw new AppError('NO_VIDEO');
      const adapter = selectAdapter(location.href);
      const pageUrl = location.href;
      const [records, hints] = await Promise.all([
        this.bridge?.queryRecords(800) ?? Promise.resolve([]),
        this.bridge?.queryHints(600) ?? Promise.resolve(null),
      ]);
      if (location.href !== pageUrl) {
        throw new AppError('PARSE_FAILED', '解析过程中页面已切换，请重新点击获取视频');
      }
      const result = await adapter.collect({
        document,
        video: primary.element,
        pageUrl,
        records,
        hints,
        pageTitle: document.title,
      });
      const snapshot = this.buildSnapshot(result, pageUrl);
      this.validateSnapshot(snapshot);
      const response = await sendRuntime<CreateTaskResult>({
        type: 'VVA_CREATE_TASK',
        snapshot,
      });
      if (!response.ok) {
        throw new AppError(
          response.error.code as ErrorCode,
          response.error.detail,
          response.error.message,
        );
      }
      this.button?.setState('success');
      this.button?.showToast('已在新标签页打开视频预览。', 'info', 2600);
    } catch (error) {
      const appError = toAppError(error, 'PARSE_FAILED');
      const taskError = toTaskError(appError, 'PARSE_FAILED');
      logWarn('content', taskError.code, appError);
      this.button?.setState('error');
      this.button?.showToast(taskError.message, 'error', 5600);
    } finally {
      this.parseInFlight = false;
      window.setTimeout(() => {
        if (this.button && !this.parseInFlight) this.button.setState('idle');
      }, 1600);
    }
  }

  private buildSnapshot(result: AdapterResult, pageUrl: string): VideoSnapshot {
    const validCandidates: MediaCandidate[] = [];
    for (const candidate of result.candidates.slice(0, 12)) {
      const candidateUrl = candidate.url ? parseHttpUrl(candidate.url)?.href : undefined;
      const tracks = candidate.tracks
        .map((track) => {
          const url = parseHttpUrl(track.url)?.href;
          return url ? { ...track, url } : null;
        })
        .filter((track): track is NonNullable<typeof track> => Boolean(track));
      if (!tracks.length) continue;
      if (candidate.format !== 'dash-tracks' && !candidateUrl) continue;
      validCandidates.push({
        ...candidate,
        ...(candidateUrl ? { url: candidateUrl } : {}),
        tracks,
      });
    }
    if (!validCandidates.length) {
      throw new AppError('UNSUPPORTED_FORMAT');
    }
    const cover = result.coverUrl ? parseHttpUrl(result.coverUrl, pageUrl)?.href : undefined;
    return {
      schemaVersion: SNAPSHOT_VERSION,
      pageUrl,
      pageTitle: document.title || result.title,
      platformId: result.platformId,
      platformName: result.platformName,
      title: result.title || '未命名视频',
      ...(cover ? { coverUrl: cover } : {}),
      duration: normalizeNumber(result.duration, 0, 86400 * 24),
      width: normalizeNumber(result.width, 1, 16384),
      height: normalizeNumber(result.height, 1, 16384),
      isLive: result.isLive,
      drmDetected: result.drmDetected,
      hasAudio: result.hasAudio,
      videoSrcKind: result.videoSrcKind,
      candidates: validCandidates,
      capturedAt: Date.now(),
    };
  }

  private validateSnapshot(snapshot: VideoSnapshot): void {
    if (!parseHttpUrl(snapshot.pageUrl)) throw new AppError('INVALID_URL', '页面地址不是 HTTP(S)');
    if (snapshot.isLive) throw new AppError('LIVE_STREAM');
    if (snapshot.drmDetected) throw new AppError('DRM_PROTECTED');
    if (!snapshot.candidates.length) throw new AppError('UNSUPPORTED_FORMAT');
    for (const candidate of snapshot.candidates) {
      if (candidate.url && !parseHttpUrl(candidate.url)) throw new AppError('INVALID_URL');
      for (const track of candidate.tracks) {
        if (!parseHttpUrl(track.url)) throw new AppError('INVALID_URL');
      }
    }
  }

  private unmount(): void {
    window.clearTimeout(this.scanTimer);
    window.clearTimeout(this.routeTimer);
    window.clearInterval(this.pollTimer);
    this.observer?.disconnect();
    this.bridge?.dispose();
    this.destroyButton();
  }

  // 保留卸载入口，扩展被重新加载时由浏览器直接销毁内容脚本上下文。
  destroy(): void {
    this.unmount();
  }
}

function normalizeNumber(
  value: number | null,
  min: number,
  max: number,
): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

if (shouldStart) {
  const controller = new ContentController();
  controller.start();
}
