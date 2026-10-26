import { AppError } from '../../shared/errors';
import type { MediaCandidate } from '../../shared/types';
import { pageReferer, parseHttpUrl } from '../../shared/url';
import {
  splitDashRecords,
  directCandidate,
} from './candidate-utils';
import { finalizeResult, splitTrackCandidate } from './common';
import type { AdapterContext, AdapterResult, PlatformAdapter } from './types';

const MAX_AUTO_HEIGHT = 1080;

function usableUrls(...urls: Array<string | undefined>): string | null {
  for (const value of urls) {
    const parsed = parseHttpUrl(value);
    if (parsed) return parsed.href;
  }
  return null;
}

function bestDashCandidate(context: AdapterContext): MediaCandidate | null {
  const bili = context.hints?.bilibili;
  const hintVideos = (bili?.videos ?? [])
    .map((video) => {
      const url = usableUrls(video.baseUrl, video.backupUrl);
      return url ? { ...video, url } : null;
    })
    .filter(
      (item): item is NonNullable<typeof item> => Boolean(item),
    )
    .sort((left, right) => {
      const leftPixels = (left.width ?? 0) * (left.height ?? 0);
      const rightPixels = (right.width ?? 0) * (right.height ?? 0);
      if (rightPixels !== leftPixels) return rightPixels - leftPixels;
      return (right.bandwidth ?? 0) - (left.bandwidth ?? 0);
    });
  const withinCap = hintVideos.find(
    (video) => !video.height || video.height <= MAX_AUTO_HEIGHT,
  );
  const chosenVideo = withinCap ?? hintVideos[hintVideos.length - 1];

  const networkSplit = splitDashRecords(context.records);
  const networkVideo = networkSplit.video[0];
  const networkAudio = networkSplit.audio[0];
  const hintAudio = [...(bili?.audios ?? [])]
    .map((audio) => {
      const url = usableUrls(audio.baseUrl, audio.backupUrl);
      return url ? { ...audio, url } : null;
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => (right.bandwidth ?? 0) - (left.bandwidth ?? 0))[0];

  const videoTrack = chosenVideo
    ? {
        url: chosenVideo.url,
        ...(chosenVideo.width ? { width: chosenVideo.width } : {}),
        ...(chosenVideo.height ? { height: chosenVideo.height } : {}),
        ...(chosenVideo.bandwidth ? { bandwidth: chosenVideo.bandwidth } : {}),
        ...(chosenVideo.mimeType ? { mimeType: chosenVideo.mimeType } : {}),
        ...(chosenVideo.codecs ? { codecs: chosenVideo.codecs } : {}),
      }
    : networkVideo
      ? { url: networkVideo.url }
      : null;

  const audioTrack = hintAudio
    ? {
        url: hintAudio.url,
        ...(hintAudio.bandwidth ? { bandwidth: hintAudio.bandwidth } : {}),
        ...(hintAudio.mimeType ? { mimeType: hintAudio.mimeType } : {}),
        ...(hintAudio.codecs ? { codecs: hintAudio.codecs } : {}),
      }
    : networkAudio
      ? { url: networkAudio.url }
      : null;

  if (!videoTrack) return null;
  if (!audioTrack) {
    throw new AppError(
      'UNSUPPORTED_FORMAT',
      'B 站 DASH 视频未找到音频轨，可能受登录、会员或版权限制',
      '未找到可合并的音频轨道，可能需要登录或会员权限。扩展不会获取你的登录凭证。',
    );
  }
  return splitTrackCandidate(videoTrack, audioTrack, {
    label: `${videoTrack.height ?? '?'}P · DASH 音视频合并`,
    requiresReferer: true,
    source: chosenVideo ? 'page-data' : 'network',
  });
}

export const bilibiliAdapter: PlatformAdapter = {
  id: 'bilibili',
  name: '哔哩哔哩',
  matches(url: string): boolean {
    try {
      const host = new URL(url).hostname;
      return host === 'bilibili.com' || host.endsWith('.bilibili.com');
    } catch {
      return false;
    }
  },
  async collect(context: AdapterContext): Promise<AdapterResult> {
    const bili = context.hints?.bilibili;
    const extras: MediaCandidate[] = [];
    const durl = bili?.durl ?? [];
    if (durl.length === 1) {
      const directUrl = usableUrls(durl[0]?.url, durl[0]?.backupUrl);
      if (directUrl) {
        const candidate = directCandidate(directUrl, {
          format: 'mp4',
          source: 'page-data',
          requiresReferer: true,
          label: 'B 站直链 MP4',
        });
        if (candidate) extras.push(candidate);
      }
    }
    if ((bili?.videos.length ?? 0) > 0 || splitDashRecords(context.records).video.length > 0) {
      try {
        const dash = bestDashCandidate(context);
        if (dash) extras.push(dash);
      } catch (error) {
        // 有直链兜底时，DASH 音轨缺失不应阻断可播放的直链方案。
        if (extras.length === 0) throw error;
      }
    }

    const coverOverride = parseHttpUrl(bili?.coverUrl, context.pageUrl)?.href;
    return finalizeResult(context, {
      platformId: 'bilibili',
      platformName: '哔哩哔哩',
      requiresReferer: true,
      extraCandidates: extras,
      ...(bili?.title ? { titleOverride: bili.title } : {}),
      ...(coverOverride ? { coverOverride } : {}),
      ...(bili?.duration && bili.duration > 0 ? { durationOverride: bili.duration } : {}),
      ...(bili?.isLive ? { isLiveOverride: true } : {}),
      hasAudioOverride:
        extras.some((candidate) => candidate.tracks.some((track) => track.role === 'audio')) || null,
    });
  },
  getRequestHeaders(context: AdapterContext): Record<string, string> {
    return { Referer: pageReferer(context.pageUrl) };
  },
};
