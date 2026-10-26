import { describe, expect, it } from 'vitest';
import {
  buildDownloadFilename,
  sanitizeFilenamePart,
} from '../src/shared/filename';

describe('sanitizeFilenamePart', () => {
  it('removes characters illegal on Windows', () => {
    expect(sanitizeFilenamePart('a\\b/c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
  });

  it('removes control characters and trims dots', () => {
    expect(sanitizeFilenamePart('  ..标题\u0000\n测试..  ')).toBe('标题 测试');
  });

  it('guards reserved Windows names', () => {
    expect(sanitizeFilenamePart('CON')).toBe('_CON');
    expect(sanitizeFilenamePart('LPT1')).toBe('_LPT1');
  });

  it('falls back for empty values and truncates long titles', () => {
    expect(sanitizeFilenamePart('   ')).toBe('未命名视频');
    expect(sanitizeFilenamePart('长'.repeat(200), 20)).toHaveLength(20);
  });
});

describe('buildDownloadFilename', () => {
  it('builds platform-title-resolution-date.mp4', () => {
    const filename = buildDownloadFilename({
      platformName: '哔哩哔哩',
      title: '测试 / 视频',
      width: 1920,
      height: 1080,
      date: new Date(2026, 9, 26),
    });
    expect(filename).toBe('哔哩哔哩-测试 视频-1920x1080-2026-10-26.mp4');
    expect(filename).not.toMatch(/[\\/:*?"<>|]/);
  });

  it('uses a fallback title and sanitizes extension', () => {
    const filename = buildDownloadFilename({
      platformName: '通用网站',
      title: '  ',
      date: new Date(2026, 0, 2),
      extension: '.m.p4',
    });
    expect(filename).toContain('未命名视频');
    expect(filename.endsWith('.mp4')).toBe(true);
  });

  it('limits total filename bytes for very long titles', () => {
    const filename = buildDownloadFilename({
      platformName: '平台',
      title: '很长的标题'.repeat(80),
      width: 3840,
      height: 2160,
      date: new Date(2026, 9, 26),
    });
    expect(new TextEncoder().encode(filename).byteLength).toBeLessThanOrEqual(170);
    expect(filename.endsWith('.mp4')).toBe(true);
  });
});
