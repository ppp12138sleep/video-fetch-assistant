import type { PlatformId } from './types';

export const EXTENSION_NAME = '视频获取助手';
export const BUTTON_TEXT = '获取视频';

export const PLATFORM_NAMES: Record<PlatformId, string> = {
  douyin: '抖音',
  kuaishou: '快手',
  bilibili: '哔哩哔哩',
  generic: '通用网站',
};

export const PLATFORM_ORIGINS: Record<Exclude<PlatformId, 'generic'>, string[]> = {
  douyin: ['https://www.douyin.com', 'https://v.douyin.com'],
  kuaishou: ['https://www.kuaishou.com', 'https://v.kuaishou.com'],
  bilibili: ['https://www.bilibili.com', 'https://m.bilibili.com'],
};

export const SUPPORTED_PAGE_PATTERNS = [
  '*://*.douyin.com/*',
  '*://*.iesdouyin.com/*',
  '*://*.kuaishou.com/*',
  '*://*.bilibili.com/*',
];

export const TEST_PAGE_PATTERNS = ['http://localhost/*', 'http://127.0.0.1/*'];

export const DEFAULT_HOST_PERMISSIONS = [
  ...SUPPORTED_PAGE_PATTERNS,
  ...TEST_PAGE_PATTERNS,
  '*://*.douyinvod.com/*',
  '*://*.douyinpic.com/*',
  '*://*.byteimg.com/*',
  '*://*.kwaicdn.com/*',
  '*://*.kwimgs.com/*',
  '*://*.bilivideo.com/*',
  '*://*.hdslb.com/*',
  '*://*.akamaized.net/*',
];

export const MEDIA_CONTENT_TYPE_PATTERN =
  /^(video\/|audio\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|octet-stream))/i;

export const ALLOWED_MEDIA_PROTOCOLS = new Set(['http:', 'https:']);
export const ALLOWED_PAGE_PROTOCOLS = new Set(['http:', 'https:']);

export const MAX_NETWORK_RECORDS = 60;

export const DOWNLOAD_FILENAME_MAX_BYTES = 170;
export const TITLE_FILENAME_MAX_CHARS = 80;

export const OFFSCREEN_PATH = 'offscreen/index.html';
export const PREVIEW_PATH = 'preview/index.html';
export const OPTIONS_PATH = 'options/index.html';

export const FFMPEG_CORE_PATH = 'vendor/ffmpeg/ffmpeg-core.js';
export const FFMPEG_WASM_PATH = 'vendor/ffmpeg/ffmpeg-core.wasm';

export const OFFSCREEN_JUSTIFICATION =
  '使用 DOM/Worker 与本机 ffmpeg.wasm 对 HLS、DASH、WebM 媒体进行分片下载、转封装，并创建临时 Blob 下载地址；Service Worker 无 DOM 且可能被回收。';

export const BILIBILI_REFERER = 'https://www.bilibili.com/';
export const CONTENT_SCRIPT_GUARD = '__VVA_CONTENT_SCRIPT_V1__';
export const NETWORK_HOOK_GUARD = '__VVA_NETWORK_HOOK_V1__';
