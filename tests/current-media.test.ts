import { describe, expect, it } from 'vitest';
import { metadataMatchScore } from '../src/content/current-media';

describe('current feed media metadata matching', () => {
  const current = { duration: 12, width: 640, height: 360 };

  it('accepts the candidate with the same duration and aspect ratio', () => {
    const score = metadataMatchScore(current, { duration: 12.1, width: 640, height: 360 });
    expect(score).not.toBeNull();
    expect(score!).toBeLessThan(0.2);
  });

  it('rejects preloaded videos with a different duration', () => {
    expect(metadataMatchScore(current, { duration: 20, width: 480, height: 270 })).toBeNull();
    expect(metadataMatchScore(current, { duration: 8, width: 480, height: 270 })).toBeNull();
  });

  it('rejects a different aspect ratio even when duration matches', () => {
    expect(metadataMatchScore(current, { duration: 12, width: 360, height: 640 })).toBeNull();
  });

  it('prefers closer resolution when duration and aspect both match', () => {
    const exact = metadataMatchScore(current, { duration: 12, width: 640, height: 360 });
    const scaled = metadataMatchScore(current, { duration: 12, width: 480, height: 270 });
    expect(exact).not.toBeNull();
    expect(scaled).not.toBeNull();
    expect(exact!).toBeLessThan(scaled!);
  });

  it('returns null without usable durations', () => {
    expect(metadataMatchScore({ ...current, duration: null }, current)).toBeNull();
    expect(metadataMatchScore(current, { ...current, duration: null })).toBeNull();
  });
});
