import type {
  MediaCandidate,
  NetworkMediaRecord,
  PageHints,
  PlatformId,
  VideoSnapshot,
} from '../../shared/types';

export interface AdapterContext {
  document: Document;
  video: HTMLVideoElement;
  pageUrl: string;
  records: NetworkMediaRecord[];
  hints: PageHints | null;
  pageTitle: string;
}

export interface AdapterResult {
  platformId: PlatformId;
  platformName: string;
  title: string;
  coverUrl?: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  isLive: boolean;
  drmDetected: boolean;
  hasAudio: boolean | null;
  videoSrcKind: VideoSnapshot['videoSrcKind'];
  candidates: MediaCandidate[];
}

export interface PlatformAdapter {
  readonly id: PlatformId;
  readonly name: string;
  matches(url: string): boolean;
  collect(context: AdapterContext): Promise<AdapterResult>;
  getRequestHeaders?(context: AdapterContext): Record<string, string>;
}
