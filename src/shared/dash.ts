import { AppError } from './errors';
import { resolveHttpUrl } from './url';

export interface DashByteRange {
  start: number;
  end: number;
}

export interface DashResource {
  url: string;
  range?: DashByteRange;
}

export interface DashTrackPlan {
  role: 'video' | 'audio';
  mimeType: string;
  codecs: string;
  bandwidth: number;
  width?: number;
  height?: number;
  init?: DashResource;
  segments: DashResource[];
  durationSeconds: number;
  /** 若为单文件且没有分片，下载器可以直接取完整文件。 */
  singleFile: boolean;
}

export interface DashPlan {
  manifestUrl: string;
  durationSeconds: number;
  video: DashTrackPlan;
  audio?: DashTrackPlan;
  muxedAudio: boolean;
  drmDetected: boolean;
  live: boolean;
}

const MAX_SEGMENTS = 20_000;

function childrenByName(parent: Element, name: string): Element[] {
  return Array.from(parent.children).filter((child) => child.localName === name);
}

function firstChild(parent: Element, name: string): Element | null {
  return Array.from(parent.children).find((child) => child.localName === name) ?? null;
}

function descendants(parent: Element | Document, name: string): Element[] {
  return Array.from(parent.getElementsByTagName('*')).filter(
    (element) => element.localName === name,
  );
}

function textOf(parent: Element | null, name: string): string {
  if (!parent) return '';
  return firstChild(parent, name)?.textContent?.trim() ?? '';
}

function resolveBase(parentBase: string, node: Element): string {
  const baseText = textOf(node, 'BaseURL');
  if (!baseText) return parentBase;
  return resolveHttpUrl(baseText, parentBase) ?? parentBase;
}

export function parseIsoDuration(value: string | null | undefined): number | null {
  if (!value) return null;
  const match =
    /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      value,
    );
  if (!match) return null;
  const years = Number(match[1] ?? 0) * 365 * 86400;
  const months = Number(match[2] ?? 0) * 30 * 86400;
  const days = Number(match[3] ?? 0) * 86400;
  const hours = Number(match[4] ?? 0) * 3600;
  const minutes = Number(match[5] ?? 0) * 60;
  const seconds = Number(match[6] ?? 0);
  const total = years + months + days + hours + minutes + seconds;
  return Number.isFinite(total) && total > 0 ? total : null;
}

function parseBandwidth(value: string | null): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseRange(value: string | null): DashByteRange | undefined {
  if (!value) return undefined;
  const match = /^(\d+)-(\d+)$/.exec(value.trim());
  if (!match?.[1] || !match[2]) return undefined;
  return { start: Number(match[1]), end: Number(match[2]) };
}

function formatTemplate(
  template: string,
  values: { representationId: string; bandwidth: number; number: number; time: number },
): string {
  return template.replace(/\$(\w+)(?:%0?(\d+)d)?\$/g, (raw, name: string, width?: string) => {
    let value = '';
    switch (name) {
      case 'RepresentationID':
        value = values.representationId;
        break;
      case 'Bandwidth':
        value = String(values.bandwidth);
        break;
      case 'Number':
        value = String(values.number);
        break;
      case 'Time':
        value = String(values.time);
        break;
      default:
        return raw;
    }
    return width ? value.padStart(Number(width), '0') : value;
  });
}

function makeResource(
  urlTemplate: string,
  baseUrl: string,
  values: { representationId: string; bandwidth: number; number: number; time: number },
  range?: DashByteRange,
): DashResource {
  const expanded = formatTemplate(urlTemplate, values);
  const url = resolveHttpUrl(expanded, baseUrl);
  if (!url) throw new AppError('PARSE_FAILED', 'DASH 分片地址无效');
  return { url, ...(range ? { range } : {}) };
}

function mergeTemplate(representation: Element, adaptation: Element): Map<string, string> {
  const merged = new Map<string, string>();
  for (const node of [adaptation, representation]) {
    const template = firstChild(node, 'SegmentTemplate');
    if (!template) continue;
    for (const attribute of Array.from(template.attributes)) {
      merged.set(attribute.name, attribute.value);
    }
  }
  return merged;
}

function resolveRepresentation(
  representation: Element,
  adaptation: Element,
  adaptationBase: string,
  periodDuration: number,
  role: 'video' | 'audio',
): DashTrackPlan {
  const baseUrl = resolveBase(adaptationBase, representation);
  const bandwidth = parseBandwidth(representation.getAttribute('bandwidth'));
  const mimeType = representation.getAttribute('mimeType') ?? adaptation.getAttribute('mimeType') ?? '';
  const codecs = representation.getAttribute('codecs') ?? adaptation.getAttribute('codecs') ?? '';
  const widthValue = Number(representation.getAttribute('width') ?? adaptation.getAttribute('width'));
  const heightValue = Number(
    representation.getAttribute('height') ?? adaptation.getAttribute('height'),
  );
  const width = Number.isFinite(widthValue) && widthValue > 0 ? widthValue : undefined;
  const height = Number.isFinite(heightValue) && heightValue > 0 ? heightValue : undefined;
  const durationFromRep = parseIsoDuration(representation.getAttribute('duration'));
  const durationSeconds = durationFromRep ?? periodDuration;

  const segmentTemplate = mergeTemplate(representation, adaptation);
  const segmentList = firstChild(representation, 'SegmentList') ?? firstChild(adaptation, 'SegmentList');
  const hasSegmentBase =
    Boolean(firstChild(representation, 'SegmentBase')) || Boolean(firstChild(adaptation, 'SegmentBase'));

  const baseTrack = {
    role,
    mimeType,
    codecs,
    bandwidth,
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    durationSeconds,
  };

  if (segmentTemplate.size > 0) {
    const values = {
      representationId: representation.getAttribute('id') ?? '',
      bandwidth,
      number: 1,
      time: 0,
    };
    const initTemplate = segmentTemplate.get('initialization');
    const mediaTemplate = segmentTemplate.get('media');
    if (!mediaTemplate) {
      throw new AppError('PARSE_FAILED', 'DASH SegmentTemplate 缺少 media 模板');
    }
    const init = initTemplate ? makeResource(initTemplate, baseUrl, values) : undefined;
    const timescale = Number(segmentTemplate.get('timescale') ?? 1) || 1;
    const startNumber = Number(segmentTemplate.get('startNumber') ?? 1) || 1;
    const presentationTimeOffset =
      Number(segmentTemplate.get('presentationTimeOffset') ?? 0) || 0;
    const segmentDuration = Number(segmentTemplate.get('duration') ?? 0) || 0;
    const segments: DashResource[] = [];
    const timeline = (() => {
      const represented = firstChild(representation, 'SegmentTemplate');
      const adapted = firstChild(adaptation, 'SegmentTemplate');
      return (
        (represented ? firstChild(represented, 'SegmentTimeline') : null) ??
        (adapted ? firstChild(adapted, 'SegmentTimeline') : null)
      );
    })();
    if (timeline) {
      let number = startNumber;
      let time = presentationTimeOffset;
      for (const s of childrenByName(timeline, 'S')) {
        const d = Number(s.getAttribute('d') ?? 0);
        if (!Number.isFinite(d) || d <= 0) continue;
        const t = s.getAttribute('t');
        if (t !== null && Number.isFinite(Number(t))) time = Number(t) - presentationTimeOffset;
        const repeatAttr = s.getAttribute('r');
        let repeat = repeatAttr === null ? 0 : Number(repeatAttr);
        if (!Number.isFinite(repeat) || repeat < -1) repeat = 0;
        if (repeat === -1) {
          repeat = durationSeconds > 0 ? Math.ceil((durationSeconds * timescale - time) / d) - 1 : 0;
        }
        for (let index = 0; index <= repeat; index += 1) {
          segments.push(makeResource(mediaTemplate, baseUrl, { ...values, number, time }));
          number += 1;
          time += d;
          if (segments.length > MAX_SEGMENTS) {
            throw new AppError('PARSE_FAILED', 'DASH 分片数量超出安全上限');
          }
          if (durationSeconds > 0 && time / timescale > durationSeconds + 1) break;
        }
      }
    } else if (segmentDuration > 0) {
      const count = Math.max(1, Math.ceil((durationSeconds * timescale) / segmentDuration));
      for (let index = 0; index < count && index < MAX_SEGMENTS; index += 1) {
        segments.push(
          makeResource(mediaTemplate, baseUrl, {
            ...values,
            number: startNumber + index,
            time: index * segmentDuration,
          }),
        );
      }
    }
    if (!segments.length) {
      throw new AppError('PARSE_FAILED', 'DASH 清单未生成有效分片');
    }
    return { ...baseTrack, ...(init ? { init } : {}), segments, singleFile: false };
  }

  if (segmentList) {
    const initNode = firstChild(segmentList, 'Initialization');
    const initUrl = initNode?.getAttribute('sourceURL');
    const init =
      initUrl && resolveHttpUrl(initUrl, baseUrl)
        ? {
            url: resolveHttpUrl(initUrl, baseUrl)!,
            ...(parseRange(initNode?.getAttribute('range') ?? null)
              ? { range: parseRange(initNode?.getAttribute('range') ?? null)! }
              : {}),
          }
        : undefined;
    const segments = childrenByName(segmentList, 'SegmentURL')
      .map((segment) => {
        const media = segment.getAttribute('media');
        if (!media) return null;
        const url = resolveHttpUrl(media, baseUrl);
        if (!url) return null;
        const range = parseRange(segment.getAttribute('mediaRange'));
        return { url, ...(range ? { range } : {}) };
      })
      .filter((item): item is DashResource => item !== null);
    if (!segments.length) {
      throw new AppError('PARSE_FAILED', 'DASH SegmentList 为空');
    }
    return { ...baseTrack, ...(init ? { init } : {}), segments, singleFile: false };
  }

  if (hasSegmentBase || baseUrl) {
    return {
      ...baseTrack,
      segments: [{ url: baseUrl }],
      singleFile: true,
    };
  }

  throw new AppError('PARSE_FAILED', '无法识别 DASH 分片组织方式');
}

function selectRepresentation(
  adaptation: Element,
  role: 'video' | 'audio',
): Element {
  const representations = childrenByName(adaptation, 'Representation');
  if (!representations.length) {
    throw new AppError('PARSE_FAILED', 'DASH 轨道没有 Representation');
  }
  const sorted = [...representations].sort((left, right) => {
    if (role === 'video') {
      const leftPixels =
        Number(left.getAttribute('width') ?? 0) * Number(left.getAttribute('height') ?? 0);
      const rightPixels =
        Number(right.getAttribute('width') ?? 0) * Number(right.getAttribute('height') ?? 0);
      if (rightPixels !== leftPixels) return rightPixels - leftPixels;
    }
    return parseBandwidth(right.getAttribute('bandwidth')) - parseBandwidth(left.getAttribute('bandwidth'));
  });
  if (role === 'video') {
    const capped = sorted.find((item) => {
      const height = Number(item.getAttribute('height') ?? adaptation.getAttribute('height') ?? 0);
      return !height || height <= 1080;
    });
    if (capped) return capped;
  }
  return sorted[0]!;
}

function adaptationRole(adaptation: Element): 'video' | 'audio' | 'other' {
  const contentType = (adaptation.getAttribute('contentType') ?? '').toLowerCase();
  if (contentType === 'video' || contentType === 'audio') return contentType;
  const mime = (adaptation.getAttribute('mimeType') ?? '').toLowerCase();
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'other';
}

export function parseDashManifest(xmlText: string, manifestUrl: string): DashPlan {
  const document = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (document.getElementsByTagName('parsererror').length > 0) {
    throw new AppError('PARSE_FAILED', 'DASH MPD 不是有效 XML');
  }
  const mpd = document.documentElement;
  if (!mpd || mpd.localName !== 'MPD') {
    throw new AppError('PARSE_FAILED', 'DASH MPD 根节点无效');
  }
  if ((mpd.getAttribute('type') ?? 'static') === 'dynamic') {
    throw new AppError('LIVE_STREAM', 'DASH 清单为 dynamic 直播流');
  }
  const drmDetected =
    descendants(document, 'ContentProtection').length > 0 ||
    /widevine|playready|clearkey|fairplay/i.test(xmlText.slice(0, 300_000));
  if (drmDetected) {
    throw new AppError('DRM_PROTECTED', 'DASH 清单包含 ContentProtection');
  }

  const durationSeconds = parseIsoDuration(mpd.getAttribute('mediaPresentationDuration'));
  if (!durationSeconds) {
    throw new AppError('PARSE_FAILED', 'DASH 清单缺少可用的视频时长');
  }
  const periods = childrenByName(mpd, 'Period');
  if (periods.length !== 1) {
    throw new AppError(
      'PARSE_FAILED',
      periods.length > 1 ? '多 Period DASH 暂不支持' : 'DASH 清单缺少 Period',
    );
  }
  const period = periods[0]!;
  const periodDuration =
    parseIsoDuration(period.getAttribute('duration')) ?? durationSeconds;
  const mpdBase = resolveBase(manifestUrl, mpd);
  const periodBase = resolveBase(mpdBase, period);
  const adaptations = childrenByName(period, 'AdaptationSet');
  const videoAdaptation = adaptations.find((item) => adaptationRole(item) === 'video');
  const audioAdaptation = adaptations.find((item) => adaptationRole(item) === 'audio');
  if (!videoAdaptation) {
    throw new AppError('UNSUPPORTED_FORMAT', 'DASH 清单中没有视频轨道');
  }
  const adaptationBase = resolveBase(periodBase, videoAdaptation);
  const videoRep = selectRepresentation(videoAdaptation, 'video');
  const video = resolveRepresentation(videoRep, videoAdaptation, adaptationBase, periodDuration, 'video');

  let audio: DashTrackPlan | undefined;
  if (audioAdaptation) {
    const audioBase = resolveBase(periodBase, audioAdaptation);
    const audioRep = selectRepresentation(audioAdaptation, 'audio');
    audio = resolveRepresentation(audioRep, audioAdaptation, audioBase, periodDuration, 'audio');
  }
  const codecText = `${video.codecs} ${video.mimeType}`.toLowerCase();
  const muxedAudio = !audio && /(mp4a|opus|aac|vorbis|ac-3|ec-3)/.test(codecText);

  return {
    manifestUrl,
    durationSeconds: periodDuration,
    video,
    ...(audio ? { audio } : {}),
    muxedAudio,
    drmDetected: false,
    live: false,
  };
}

export function estimateDashSizeBytes(plan: DashPlan): number | null {
  const videoBandwidth = plan.video.bandwidth;
  const audioBandwidth = plan.audio?.bandwidth ?? 0;
  if (!videoBandwidth || !plan.durationSeconds) return null;
  return Math.round(((videoBandwidth + audioBandwidth) * plan.durationSeconds) / 8);
}
