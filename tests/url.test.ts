import { describe, expect, it } from 'vitest';
import {
  parseHttpUrl,
  redactUrl,
  resolveHttpUrl,
  pageReferer,
  extensionHint,
  isMediaUrl,
} from '../src/shared/url';
import { parseIsoDuration } from '../src/shared/dash';
import { cleanVideoTitle } from '../src/content/metadata';

describe('URL validation', () => {
  it('allows only http/https', () => {
    expect(parseHttpUrl('https://example.com/video.mp4')?.href).toBe(
      'https://example.com/video.mp4',
    );
    expect(parseHttpUrl('javascript:alert(1)')).toBeNull();
    expect(parseHttpUrl('data:text/html,hello')).toBeNull();
    expect(parseHttpUrl('file:///tmp/video.mp4')).toBeNull();
    expect(parseHttpUrl('blob:https://example.com/uuid')).toBeNull();
  });

  it('resolves relative media URLs', () => {
    expect(resolveHttpUrl('../seg.ts', 'https://cdn.example.com/a/b/master.m3u8')).toBe(
      'https://cdn.example.com/a/seg.ts',
    );
  });

  it('redacts query strings and hashes in logs', () => {
    expect(redactUrl('https://cdn.example.com/a/video.mp4?token=secret#time')).toBe(
      'https://cdn.example.com/a/video.mp4',
    );
    expect(redactUrl('javascript:alert(1)')).toBe('[非 HTTP 地址]');
  });

  it('builds a page Referer and media extension hint', () => {
    expect(pageReferer('https://www.bilibili.com/video/BV1xx?p=2')).toBe(
      'https://www.bilibili.com/',
    );
    expect(extensionHint('https://cdn.example.com/a/video.M3U8?x=1')).toBe('m3u8');
  });

  it('detects media only from the URL pathname, not embedded query URLs', () => {
    expect(isMediaUrl('https://cdn.example.com/a/video.mp4?token=1')).toBe(true);
    expect(isMediaUrl('https://cdn.example.com/a/master.m3u8')).toBe(true);
    expect(
      isMediaUrl('https://data.example.com/log?embedded=https%3A%2F%2Fcdn%2Fvideo.m4s'),
    ).toBe(false);
    expect(isMediaUrl('https://data.example.com/log/web?url=/video.mp4')).toBe(false);
  });
});

describe('metadata helpers', () => {
  it('parses ISO 8601 durations', () => {
    expect(parseIsoDuration('PT1H2M3S')).toBe(3723);
    expect(parseIsoDuration('PT45S')).toBe(45);
    expect(parseIsoDuration('P1D')).toBe(86400);
    expect(parseIsoDuration('bad')).toBeNull();
  });

  it('cleans platform suffixes from page titles', () => {
    expect(cleanVideoTitle('一个测试视频_哔哩哔哩_bilibili')).toBe('一个测试视频');
    expect(cleanVideoTitle('一个测试视频 - 抖音')).toBe('一个测试视频');
    expect(cleanVideoTitle('一个测试视频 - 本地测试页', '本地测试页')).toBe('一个测试视频');
  });
});
