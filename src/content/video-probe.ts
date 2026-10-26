import type { VideoDescriptorLike } from '../shared/video-select';
import { pickPrimaryVideo, isProbablyAdContainer } from '../shared/video-select';
import { detectHasAudio } from './metadata';

export interface DomVideoDescriptor extends VideoDescriptorLike {
  element: HTMLVideoElement;
  source: string;
}

const MODAL_SELECTORS = [
  '[role="dialog"]',
  '[aria-modal="true"]',
  'dialog[open]',
  '[class*="login-modal"]',
  '[class*="login-panel"]',
  '[class*="pay-modal"]',
  '[class*="payment-modal"]',
  '[data-e2e="login-guide"]',
];

function isVisibleStyle(element: Element): boolean {
  const style = getComputedStyle(element);
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.visibility !== 'collapse' &&
    Number(style.opacity || '1') > 0.01
  );
}

function hasAdAncestor(video: HTMLVideoElement): boolean {
  let current: Element | null = video.parentElement;
  let depth = 0;
  while (current && depth < 8) {
    if (isProbablyAdContainer(current)) return true;
    const adFlag = current.getAttribute('data-ad') ?? current.getAttribute('data-ad-slot');
    if (adFlag === '' || adFlag === 'true' || adFlag === '1') return true;
    current = current.parentElement;
    depth += 1;
  }
  return false;
}

function collectVideosDeep(root: ParentNode, sink: HTMLVideoElement[], depth = 0): void {
  if (depth > 8 || sink.length > 80) return;
  for (const video of Array.from(root.querySelectorAll('video'))) {
    if (!sink.includes(video)) sink.push(video);
  }
  for (const element of Array.from(root.querySelectorAll('*'))) {
    const shadow = (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (shadow) collectVideosDeep(shadow, sink, depth + 1);
  }
}

export function findVideos(): HTMLVideoElement[] {
  const sink: HTMLVideoElement[] = [];
  collectVideosDeep(document, sink);
  return sink;
}

export function describeVideo(video: HTMLVideoElement): DomVideoDescriptor {
  const rect = video.getBoundingClientRect();
  const style = getComputedStyle(video);
  const viewportWidth = Math.max(1, window.innerWidth);
  const viewportHeight = Math.max(1, window.innerHeight);
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(viewportWidth, rect.right);
  const bottom = Math.min(viewportHeight, rect.bottom);
  const visibleWidth = Math.max(0, right - left);
  const visibleHeight = Math.max(0, bottom - top);
  const source = video.currentSrc || video.src || '';
  return {
    element: video,
    source,
    width: rect.width || video.videoWidth,
    height: rect.height || video.videoHeight,
    visibleArea: visibleWidth * visibleHeight,
    viewportRatio: (visibleWidth * visibleHeight) / (viewportWidth * viewportHeight),
    paused: video.paused,
    readyState: video.readyState,
    isAd: hasAdAncestor(video),
    isConnected: video.isConnected,
    opacity: Number(style.opacity || '1'),
    display: style.display,
    visibility: style.visibility,
    hasAudioTrack: detectHasAudio(video) === true,
    duration: Number.isFinite(video.duration) ? video.duration : undefined,
  };
}

export function findPrimaryVideo(): DomVideoDescriptor | null {
  const descriptors = findVideos()
    .filter((video) => video.isConnected)
    .map((video) => describeVideo(video))
    .filter((descriptor) => isVisibleStyle(descriptor.element));
  return pickPrimaryVideo(descriptors);
}

export interface ModalState {
  /** 登录 / 支付等与视频无关的关键弹窗，应暂时隐藏按钮。 */
  blocking: boolean;
  /** 承载当前视频的详情/播放器弹窗：不能隐藏按钮，但需要上移避开底部关闭按钮。 */
  videoModal: boolean;
}

export function getModalState(video: HTMLVideoElement | null): ModalState {
  let blocking = false;
  let videoModal = false;
  for (const selector of MODAL_SELECTORS) {
    for (const element of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      if (!isVisibleStyle(element)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (video && element.contains(video)) {
        videoModal = true;
        continue;
      }
      blocking = true;
    }
  }
  return { blocking, videoModal };
}

export function isBlockingModalOpen(video?: HTMLVideoElement | null): boolean {
  return getModalState(video ?? null).blocking;
}

export function getOverlayParent(): Element {
  const fullscreen = document.fullscreenElement;
  if (fullscreen && fullscreen !== document.documentElement) {
    return fullscreen;
  }
  return document.body || document.documentElement;
}
