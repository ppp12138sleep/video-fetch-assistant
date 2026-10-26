import { AppError } from './errors';
import { resolveHttpUrl } from './url';

export interface HlsByteRange {
  length: number;
  offset: number;
}

export interface HlsKey {
  method: string;
  uri?: string;
  iv?: Uint8Array;
  keyFormat?: string;
}

export interface HlsInitMap {
  uri: string;
  byterange?: HlsByteRange;
}

export interface HlsSegment {
  uri: string;
  duration: number;
  sequence: number;
  discontinuity: boolean;
  byterange?: HlsByteRange;
  key?: HlsKey;
  initMap?: HlsInitMap;
  title?: string;
}

export interface HlsVariant {
  uri: string;
  bandwidth: number;
  averageBandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
  audioGroup?: string;
  frameRate?: number;
}

export interface HlsAudioRendition {
  groupId: string;
  name: string;
  uri?: string;
  isDefault: boolean;
  autoSelect: boolean;
  language?: string;
}

export interface HlsMasterPlaylist {
  type: 'master';
  url: string;
  variants: HlsVariant[];
  audioRenditions: HlsAudioRendition[];
  independentSegments: boolean;
  drmDetected: boolean;
}

export interface HlsMediaPlaylist {
  type: 'media';
  url: string;
  targetDuration: number;
  totalDuration: number;
  segments: HlsSegment[];
  endList: boolean;
  isLive: boolean;
  mediaSequence: number;
  playlistType: string;
  encrypted: boolean;
  drmDetected: boolean;
  averageBitrate?: number;
}

export type HlsParsedPlaylist = HlsMasterPlaylist | HlsMediaPlaylist;

export function parseAttributeList(input: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let index = 0;
  while (index < input.length) {
    while (index < input.length && (input[index] === ',' || input[index] === ' ')) index += 1;
    const equals = input.indexOf('=', index);
    if (equals < 0) break;
    const name = input.slice(index, equals).trim().toUpperCase();
    let value = '';
    let cursor = equals + 1;
    if (input[cursor] === '"') {
      cursor += 1;
      const start = cursor;
      while (cursor < input.length && input[cursor] !== '"') cursor += 1;
      value = input.slice(start, cursor);
      cursor += 1;
      while (cursor < input.length && input[cursor] !== ',') cursor += 1;
    } else {
      const comma = input.indexOf(',', cursor);
      const end = comma < 0 ? input.length : comma;
      value = input.slice(cursor, end).trim();
      cursor = end;
    }
    if (name) attributes[name] = value;
    index = cursor + 1;
  }
  return attributes;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseByteRange(value: string | undefined, previousEnd = 0): HlsByteRange | undefined {
  if (!value) return undefined;
  const [lengthText, offsetText] = value.split('@');
  const length = parseNumber(lengthText);
  if (!length || length <= 0) return undefined;
  const offset = parseNumber(offsetText) ?? previousEnd;
  return { length, offset };
}

function parseIv(value: string | undefined): Uint8Array | undefined {
  if (!value) return undefined;
  const hex = value.replace(/^0x/i, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) return undefined;
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function parseResolution(value: string | undefined): { width?: number; height?: number } {
  if (!value) return {};
  const match = /^(\d+)x(\d+)$/i.exec(value.trim());
  if (!match?.[1] || !match[2]) return {};
  return { width: Number(match[1]), height: Number(match[2]) };
}

function isDrmKey(method: string, keyFormat?: string): boolean {
  const normalized = method.toUpperCase();
  if (normalized === 'NONE' || normalized === 'AES-128') {
    return Boolean(keyFormat && keyFormat.toLowerCase() !== 'identity');
  }
  return true;
}

export function parseHlsPlaylist(text: string, playlistUrl: string): HlsParsedPlaylist {
  const clean = text.replace(/^\uFEFF/, '').trim();
  if (!clean.startsWith('#EXTM3U')) {
    throw new AppError('PARSE_FAILED', 'HLS 清单缺少 #EXTM3U 标记');
  }
  const lines = clean.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const isMaster = lines.some(
    (line) => line.startsWith('#EXT-X-STREAM-INF:') || line.startsWith('#EXT-X-MEDIA:'),
  );
  const hasSegments = lines.some((line) => line.startsWith('#EXTINF:'));
  if (isMaster && !hasSegments) {
    return parseMasterPlaylist(lines, playlistUrl);
  }
  return parseMediaPlaylist(lines, playlistUrl);
}

function parseMasterPlaylist(lines: string[], playlistUrl: string): HlsMasterPlaylist {
  const variants: HlsVariant[] = [];
  const audioRenditions: HlsAudioRendition[] = [];
  let independentSegments = false;
  let drmDetected = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    if (line === '#EXT-X-INDEPENDENT-SEGMENTS') {
      independentSegments = true;
      continue;
    }
    if (line.startsWith('#EXT-X-SESSION-KEY:')) {
      const attrs = parseAttributeList(line.slice('#EXT-X-SESSION-KEY:'.length));
      if (isDrmKey(attrs.METHOD ?? '', attrs.KEYFORMAT)) drmDetected = true;
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttributeList(line.slice('#EXT-X-MEDIA:'.length));
      if ((attrs.TYPE ?? '').toUpperCase() !== 'AUDIO') continue;
      const uri = attrs.URI ? resolveHttpUrl(attrs.URI, playlistUrl) ?? undefined : undefined;
      audioRenditions.push({
        groupId: attrs['GROUP-ID'] ?? '',
        name: attrs.NAME ?? '默认音轨',
        uri,
        isDefault: (attrs.DEFAULT ?? '').toUpperCase() === 'YES',
        autoSelect: (attrs.AUTOSELECT ?? '').toUpperCase() === 'YES',
        ...(attrs.LANGUAGE ? { language: attrs.LANGUAGE } : {}),
      });
      continue;
    }
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseAttributeList(line.slice('#EXT-X-STREAM-INF:'.length));
      let uriLine: string | undefined;
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const candidate = lines[cursor];
        if (!candidate || candidate.startsWith('#')) continue;
        uriLine = candidate;
        index = cursor;
        break;
      }
      if (!uriLine) continue;
      const uri = resolveHttpUrl(uriLine, playlistUrl);
      if (!uri) continue;
      const resolution = parseResolution(attrs.RESOLUTION);
      variants.push({
        uri,
        bandwidth: parseNumber(attrs.BANDWIDTH) ?? 0,
        ...(parseNumber(attrs['AVERAGE-BANDWIDTH']) !== undefined
          ? { averageBandwidth: parseNumber(attrs['AVERAGE-BANDWIDTH']) }
          : {}),
        ...(resolution.width ? { width: resolution.width } : {}),
        ...(resolution.height ? { height: resolution.height } : {}),
        ...(attrs.CODECS ? { codecs: attrs.CODECS } : {}),
        ...(attrs.AUDIO ? { audioGroup: attrs.AUDIO } : {}),
        ...(parseNumber(attrs['FRAME-RATE']) !== undefined
          ? { frameRate: parseNumber(attrs['FRAME-RATE']) }
          : {}),
      });
      continue;
    }
  }

  if (!variants.length) {
    throw new AppError('PARSE_FAILED', 'HLS 主清单中没有可用的码率变体');
  }

  return {
    type: 'master',
    url: playlistUrl,
    variants,
    audioRenditions,
    independentSegments,
    drmDetected,
  };
}

function parseMediaPlaylist(lines: string[], playlistUrl: string): HlsMediaPlaylist {
  const segments: HlsSegment[] = [];
  let targetDuration = 0;
  let mediaSequence = 0;
  let endList = false;
  let playlistType = '';
  let currentDuration: number | undefined;
  let currentTitle: string | undefined;
  let currentByteRange: string | undefined;
  let currentDiscontinuity = false;
  let currentKey: HlsKey | undefined;
  let currentMap: HlsInitMap | undefined;
  let drmDetected = false;
  let lastByteRangeEnd = 0;
  let sequence = 0;
  let sequenceInitialized = false;
  let averageBitrate: number | undefined;

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseNumber(line.slice('#EXT-X-TARGETDURATION:'.length)) ?? targetDuration;
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseNumber(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length)) ?? 0;
      if (!sequenceInitialized) {
        sequence = mediaSequence;
        sequenceInitialized = true;
      }
      continue;
    }
    if (line === '#EXT-X-ENDLIST') {
      endList = true;
      continue;
    }
    if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      playlistType = line.slice('#EXT-X-PLAYLIST-TYPE:'.length).trim().toUpperCase();
      continue;
    }
    if (line.startsWith('#EXT-X-BITRATE:')) {
      const kbps = parseNumber(line.slice('#EXT-X-BITRATE:'.length));
      if (kbps && kbps > 0) averageBitrate = kbps * 1000;
      continue;
    }
    if (line === '#EXT-X-DISCONTINUITY') {
      currentDiscontinuity = true;
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      currentByteRange = line.slice('#EXT-X-BYTERANGE:'.length).trim();
      continue;
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributeList(line.slice('#EXT-X-KEY:'.length));
      const method = (attrs.METHOD ?? 'NONE').toUpperCase();
      if (method === 'NONE') {
        currentKey = undefined;
      } else {
        const keyFormat = attrs.KEYFORMAT;
        if (isDrmKey(method, keyFormat)) drmDetected = true;
        currentKey = {
          method,
          ...(attrs.URI ? { uri: resolveHttpUrl(attrs.URI, playlistUrl) ?? undefined } : {}),
          ...(parseIv(attrs.IV) ? { iv: parseIv(attrs.IV) } : {}),
          ...(keyFormat ? { keyFormat } : {}),
        };
      }
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributeList(line.slice('#EXT-X-MAP:'.length));
      const uri = attrs.URI ? resolveHttpUrl(attrs.URI, playlistUrl) : null;
      currentMap = uri
        ? {
            uri,
            ...(attrs.BYTERANGE ? { byterange: parseByteRange(attrs.BYTERANGE) } : {}),
          }
        : undefined;
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      const payload = line.slice('#EXTINF:'.length);
      const comma = payload.indexOf(',');
      const durationText = comma >= 0 ? payload.slice(0, comma) : payload;
      currentDuration = parseNumber(durationText);
      currentTitle = comma >= 0 ? payload.slice(comma + 1).trim() : undefined;
      continue;
    }
    if (line.startsWith('#')) continue;

    if (currentDuration === undefined) continue;
    const uri = resolveHttpUrl(line, playlistUrl);
    if (!uri) continue;
    const byterange = parseByteRange(currentByteRange, lastByteRangeEnd);
    if (byterange) lastByteRangeEnd = byterange.offset + byterange.length;
    segments.push({
      uri,
      duration: currentDuration,
      sequence,
      discontinuity: currentDiscontinuity,
      ...(byterange ? { byterange } : {}),
      ...(currentKey ? { key: currentKey } : {}),
      ...(currentMap ? { initMap: { ...currentMap } } : {}),
      ...(currentTitle ? { title: currentTitle } : {}),
    });
    sequence += 1;
    currentDuration = undefined;
    currentTitle = undefined;
    currentByteRange = undefined;
    currentDiscontinuity = false;
  }

  const totalDuration = segments.reduce((sum, segment) => sum + segment.duration, 0);
  const isLive = !endList && playlistType !== 'VOD';
  const encrypted = segments.some((segment) => segment.key?.method === 'AES-128');

  return {
    type: 'media',
    url: playlistUrl,
    targetDuration,
    totalDuration,
    segments,
    endList,
    isLive,
    mediaSequence,
    playlistType,
    encrypted,
    drmDetected,
    ...(averageBitrate ? { averageBitrate } : {}),
  };
}

export function selectHlsVariant(
  master: HlsMasterPlaylist,
  maxHeight = 1080,
): HlsVariant {
  const sorted = [...master.variants].sort((left, right) => {
    const leftPixels = (left.width ?? 0) * (left.height ?? 0);
    const rightPixels = (right.width ?? 0) * (right.height ?? 0);
    if (rightPixels !== leftPixels) return rightPixels - leftPixels;
    return right.bandwidth - left.bandwidth;
  });
  const withinLimit = sorted.find((variant) => !variant.height || variant.height <= maxHeight);
  return withinLimit ?? sorted[sorted.length - 1] ?? master.variants[0]!;
}

export function selectAudioRendition(
  master: HlsMasterPlaylist,
  groupId?: string,
): HlsAudioRendition | null {
  const candidates = master.audioRenditions.filter(
    (rendition) => (!groupId || rendition.groupId === groupId) && rendition.uri,
  );
  if (!candidates.length) return null;
  return (
    candidates.find((rendition) => rendition.isDefault) ??
    candidates.find((rendition) => rendition.autoSelect) ??
    candidates[0] ??
    null
  );
}

export function estimateHlsSizeBytes(
  bandwidth: number | undefined,
  durationSeconds: number,
  extraAudioBandwidth = 0,
): number | null {
  if (!bandwidth || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  return Math.round(((bandwidth + extraAudioBandwidth) * durationSeconds) / 8);
}

export function hlsVariantLabel(variant: HlsVariant): string {
  const resolution =
    variant.width && variant.height ? `${variant.width}×${variant.height}` : '分辨率未知';
  const mbps = variant.bandwidth ? `${(variant.bandwidth / 1_000_000).toFixed(1)} Mbps` : '';
  return [resolution, mbps].filter(Boolean).join(' · ');
}
