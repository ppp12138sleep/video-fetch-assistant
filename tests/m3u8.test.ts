import { describe, expect, it } from 'vitest';
import {
  parseAttributeList,
  parseHlsPlaylist,
  selectAudioRendition,
  selectHlsVariant,
} from '../src/shared/m3u8';

const MASTER = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="中文",DEFAULT=YES,AUTOSELECT=YES,URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=8000000,AVERAGE-BANDWIDTH=7000000,RESOLUTION=3840x2160,CODECS="hvc1.1.6.L153.B0,mp4a.40.2",AUDIO="aud"
4k/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1200000,AVERAGE-BANDWIDTH=1000000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud"
720/index.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:12
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0000000000000000000000000000000a
#EXTINF:6.0,first
seg-12.m4s
#EXTINF:5.5,second
#EXT-X-BYTERANGE:100@20
seg-13.m4s
#EXT-X-ENDLIST
`;

const LIVE = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:55
#EXTINF:4,
live-55.ts
#EXTINF:4,
live-56.ts
`;

describe('parseAttributeList', () => {
  it('handles quoted commas', () => {
    expect(
      parseAttributeList('BANDWIDTH=900000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1920x1080'),
    ).toEqual({
      BANDWIDTH: '900000',
      CODECS: 'avc1.4d401f,mp4a.40.2',
      RESOLUTION: '1920x1080',
    });
  });
});

describe('HLS master playlist', () => {
  it('parses variants, relative URLs and audio renditions', () => {
    const parsed = parseHlsPlaylist(MASTER, 'https://cdn.example.com/hls/master.m3u8');
    expect(parsed.type).toBe('master');
    if (parsed.type !== 'master') return;
    expect(parsed.variants).toHaveLength(2);
    expect(parsed.variants[0]?.uri).toBe('https://cdn.example.com/hls/4k/index.m3u8');
    expect(parsed.audioRenditions[0]?.uri).toBe('https://cdn.example.com/hls/audio/index.m3u8');
    expect(parsed.audioRenditions[0]?.isDefault).toBe(true);
  });

  it('selects the highest variant at or below 1080p', () => {
    const parsed = parseHlsPlaylist(MASTER, 'https://cdn.example.com/hls/master.m3u8');
    if (parsed.type !== 'master') throw new Error('expected master');
    expect(selectHlsVariant(parsed).height).toBe(720);
    expect(selectHlsVariant(parsed, 2160).height).toBe(2160);
  });

  it('selects the default external audio track', () => {
    const parsed = parseHlsPlaylist(MASTER, 'https://cdn.example.com/hls/master.m3u8');
    if (parsed.type !== 'master') throw new Error('expected master');
    expect(selectAudioRendition(parsed, 'aud')?.name).toBe('中文');
  });
});

describe('HLS media playlist', () => {
  it('parses segments, maps, sequence, byte ranges and AES keys', () => {
    const parsed = parseHlsPlaylist(MEDIA, 'https://cdn.example.com/hls/media/index.m3u8');
    expect(parsed.type).toBe('media');
    if (parsed.type !== 'media') return;
    expect(parsed.mediaSequence).toBe(12);
    expect(parsed.totalDuration).toBe(11.5);
    expect(parsed.endList).toBe(true);
    expect(parsed.isLive).toBe(false);
    expect(parsed.encrypted).toBe(true);
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[0]?.sequence).toBe(12);
    expect(parsed.segments[0]?.initMap?.uri).toBe('https://cdn.example.com/hls/media/init.mp4');
    expect(parsed.segments[0]?.key?.uri).toBe('https://cdn.example.com/hls/media/key.bin');
    expect(parsed.segments[0]?.key?.iv?.[15]).toBe(10);
    expect(parsed.segments[1]?.byterange).toEqual({ length: 100, offset: 20 });
    expect(parsed.segments[1]?.uri).toBe('https://cdn.example.com/hls/media/seg-13.m4s');
  });

  it('marks missing ENDLIST as live', () => {
    const parsed = parseHlsPlaylist(LIVE, 'https://cdn.example.com/live/index.m3u8');
    if (parsed.type !== 'media') throw new Error('expected media');
    expect(parsed.isLive).toBe(true);
    expect(parsed.mediaSequence).toBe(55);
    expect(parsed.segments[0]?.sequence).toBe(55);
  });

  it('marks SAMPLE-AES as DRM', () => {
    const sampleAes = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://key",KEYFORMAT="com.apple.streamingkeydelivery"
#EXTINF:6,
segment.ts
#EXT-X-ENDLIST
`;
    const parsed = parseHlsPlaylist(sampleAes, 'https://cdn.example.com/drm/index.m3u8');
    if (parsed.type !== 'media') throw new Error('expected media');
    expect(parsed.drmDetected).toBe(true);
  });
});
