import { describe, expect, it } from 'vitest';
import {
  isEligibleVideo,
  pickPrimaryVideo,
  scoreVideo,
} from '../src/shared/video-select';
import type { VideoDescriptorLike } from '../src/shared/video-select';

function video(overrides: Partial<VideoDescriptorLike> = {}): VideoDescriptorLike {
  return {
    width: 1280,
    height: 720,
    visibleArea: 1280 * 720,
    viewportRatio: 0.2,
    paused: false,
    readyState: 4,
    isAd: false,
    isConnected: true,
    duration: 60,
    ...overrides,
  };
}

describe('video selection', () => {
  it('ignores ads, hidden and tiny videos', () => {
    expect(isEligibleVideo(video({ isAd: true }))).toBe(false);
    expect(isEligibleVideo(video({ display: 'none' }))).toBe(false);
    expect(isEligibleVideo(video({ visibility: 'hidden' }))).toBe(false);
    expect(isEligibleVideo(video({ opacity: 0 }))).toBe(false);
    expect(isEligibleVideo(video({ width: 80, height: 45 }))).toBe(false);
    expect(isEligibleVideo(video({ visibleArea: 0 }))).toBe(false);
  });

  it('prefers the playing video over a larger paused background video', () => {
    const playing = video({ width: 640, height: 360, visibleArea: 640 * 360, paused: false });
    const largePaused = video({ width: 1920, height: 1080, visibleArea: 1920 * 1080, paused: true });
    expect(pickPrimaryVideo([largePaused, playing])).toBe(playing);
  });

  it('falls back to the largest visible video when none are playing', () => {
    const smaller = video({ width: 640, height: 360, visibleArea: 640 * 360, paused: true });
    const larger = video({ width: 1600, height: 900, visibleArea: 1600 * 900, paused: true });
    expect(pickPrimaryVideo([smaller, larger])).toBe(larger);
  });

  it('returns null when every video is ineligible', () => {
    expect(pickPrimaryVideo([video({ isAd: true }), video({ visibleArea: 0 })])).toBeNull();
  });

  it('scores playing videos above paused decorations', () => {
    expect(scoreVideo(video({ paused: false }))).toBeGreaterThan(scoreVideo(video({ paused: true })));
  });
});
