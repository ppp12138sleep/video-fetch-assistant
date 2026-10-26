import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatDateForFilename,
  formatDuration,
  formatMediaFormat,
  formatProgressPercent,
  formatResolution,
  formatShortDuration,
} from '../src/shared/format';

describe('formatBytes', () => {
  it('formats common sizes with one decimal for MB', () => {
    expect(formatBytes(86.4 * 1024 * 1024)).toBe('86.4 MB');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.50 GB');
  });

  it('supports approximate prefix and unknown fallback', () => {
    expect(formatBytes(86.4 * 1024 * 1024, { approximate: true })).toBe('约 86.4 MB');
    expect(formatBytes(null)).toBe('大小未知');
    expect(formatBytes(Number.NaN)).toBe('大小未知');
    expect(formatBytes(-1)).toBe('大小未知');
  });
});

describe('time and resolution formatters', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(12)).toBe('0:12');
    expect(formatDuration(61)).toBe('1:01');
    expect(formatDuration(3661)).toBe('1:01:01');
    expect(formatDuration(null)).toBe('时长未知');
  });

  it('uses a human short duration for chips', () => {
    expect(formatShortDuration(12)).toBe('12 秒');
    expect(formatShortDuration(125)).toBe('2 分 5 秒');
    expect(formatShortDuration(3600)).toBe('1 小时');
    expect(formatShortDuration(undefined)).toBe('未知');
  });

  it('formats resolution and formats', () => {
    expect(formatResolution(1920, 1080)).toBe('1920×1080');
    expect(formatResolution(null, 1080)).toBe('分辨率未知');
    expect(formatMediaFormat('hls')).toBe('HLS → MP4');
    expect(formatMediaFormat('dash-tracks')).toBe('DASH 分轨 → MP4');
  });

  it('clamps progress percentages', () => {
    expect(formatProgressPercent(42.4)).toBe('42%');
    expect(formatProgressPercent(120)).toBe('100%');
    expect(formatProgressPercent(-3)).toBe('0%');
    expect(formatProgressPercent(undefined)).toBe('');
  });

  it('formats a local filename date', () => {
    expect(formatDateForFilename(new Date(2026, 9, 26))).toBe('2026-10-26');
  });
});
