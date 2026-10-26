export interface VideoDescriptorLike {
  width: number;
  height: number;
  visibleArea: number;
  viewportRatio?: number;
  paused?: boolean;
  readyState?: number;
  isAd?: boolean;
  isConnected?: boolean;
  opacity?: number;
  display?: string;
  visibility?: string;
  hasAudioTrack?: boolean;
  duration?: number;
}

const MIN_WIDTH = 120;
const MIN_HEIGHT = 68;

export function isEligibleVideo(video: VideoDescriptorLike): boolean {
  if (video.isConnected === false) return false;
  if (video.isAd) return false;
  if (video.display === 'none') return false;
  if (video.visibility === 'hidden' || video.visibility === 'collapse') return false;
  if (video.opacity !== undefined && video.opacity <= 0.01) return false;
  if (video.width < MIN_WIDTH || video.height < MIN_HEIGHT) return false;
  if (video.visibleArea <= 0) return false;
  return true;
}

export function scoreVideo(video: VideoDescriptorLike): number {
  if (!isEligibleVideo(video)) return Number.NEGATIVE_INFINITY;
  const areaScore = Math.min(video.visibleArea, 8_000_000) / 1000;
  const viewportScore = Math.max(0, Math.min(1, video.viewportRatio ?? 0)) * 10_000;
  const playingScore = video.paused === false ? 1_000_000_000 : 0;
  const readyScore = Math.max(0, Math.min(4, video.readyState ?? 0)) * 100;
  const audioScore = video.hasAudioTrack ? 50 : 0;
  return playingScore + areaScore + viewportScore + readyScore + audioScore;
}

export function pickPrimaryVideo<T extends VideoDescriptorLike>(videos: readonly T[]): T | null {
  let best: T | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const video of videos) {
    const score = scoreVideo(video);
    if (score > bestScore) {
      best = video;
      bestScore = score;
    }
  }
  return best;
}

const AD_TOKEN = /(^|[-_\s])(ad|ads|advert|advertisement|sponsor|promo)([-_\s]|$)/i;

export function isProbablyAdContainer(
  element: { id?: string | null; className?: string | null; getAttribute?: (name: string) => string | null },
): boolean {
  const id = element.id ?? '';
  const className =
    typeof element.className === 'string'
      ? element.className
      : element.getAttribute?.('class') ?? '';
  if (AD_TOKEN.test(id) || AD_TOKEN.test(className)) return true;
  const adAttr = element.getAttribute?.('data-ad');
  if (adAttr === '' || adAttr === 'true' || adAttr === '1') return true;
  const ariaLabel = element.getAttribute?.('aria-label') ?? '';
  return /广告|advertisement|sponsored/i.test(ariaLabel);
}
