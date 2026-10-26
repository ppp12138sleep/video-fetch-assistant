import type { TaskError } from './types';

export type ErrorCode =
  | 'NO_VIDEO'
  | 'AD_VIDEO'
  | 'BLOB_UNRESOLVED'
  | 'DRM_PROTECTED'
  | 'LIVE_STREAM'
  | 'LOGIN_REQUIRED'
  | 'HTTP_UNAUTHORIZED'
  | 'HTTP_FORBIDDEN'
  | 'HTTP_ERROR'
  | 'NETWORK_ERROR'
  | 'CORS_OR_NETWORK'
  | 'TIMEOUT'
  | 'SIZE_UNKNOWN'
  | 'FILE_TOO_LARGE'
  | 'CONVERT_FAILED'
  | 'ENCODE_INCOMPATIBLE'
  | 'UNSUPPORTED_FORMAT'
  | 'INVALID_URL'
  | 'PARSE_FAILED'
  | 'TASK_NOT_FOUND'
  | 'TASK_EXPIRED'
  | 'TASK_BUSY'
  | 'CONFIRM_REQUIRED'
  | 'CANCELLED'
  | 'OFFSCREEN_UNAVAILABLE'
  | 'PREVIEW_UNSUPPORTED'
  | 'INTERNAL_ERROR';

const MESSAGES: Record<ErrorCode, string> = {
  NO_VIDEO: '当前页面没有检测到可获取的视频。',
  AD_VIDEO: '检测到的视频看起来是广告或背景视频，暂不可获取。',
  BLOB_UNRESOLVED: '该视频使用 MSE/blob 播放，但未能回溯到真实媒体地址。请刷新页面并重新播放后再试。',
  DRM_PROTECTED: '该视频受版权保护（DRM），暂不支持下载。',
  LIVE_STREAM: '该视频为直播流，暂不支持下载。',
  LOGIN_REQUIRED: '平台要求登录或会员权限后播放，扩展不会获取你的登录凭证。',
  HTTP_UNAUTHORIZED: '服务器要求登录或授权（HTTP 401），无法读取媒体。',
  HTTP_FORBIDDEN: '媒体服务器拒绝了请求（HTTP 403），可能是防盗链限制。',
  HTTP_ERROR: '媒体服务器返回异常状态，暂时无法获取该视频。',
  NETWORK_ERROR: '网络请求失败，请检查网络后重试。',
  CORS_OR_NETWORK: '跨域读取媒体失败，可能缺少媒体域名权限或受防盗链限制。',
  TIMEOUT: '解析超时，请检查网络后重试。',
  SIZE_UNKNOWN: '无法获取准确的文件大小。',
  FILE_TOO_LARGE: '该视频体积过大，超出本机转封装的安全上限。',
  CONVERT_FAILED: 'MP4 转封装失败，未生成下载文件。',
  ENCODE_INCOMPATIBLE: '视频编码与 MP4 不兼容，且自动转码失败。',
  UNSUPPORTED_FORMAT: '未找到可下载的媒体地址或暂不支持该格式。',
  INVALID_URL: '媒体地址无效或协议不受支持。',
  PARSE_FAILED: '平台页面结构发生变化，未能解析当前视频。',
  TASK_NOT_FOUND: '任务不存在，可能已被清理。',
  TASK_EXPIRED: '任务已过期。为避免占用空间，临时数据已被清理。',
  TASK_BUSY: '任务正在处理中，请稍候。',
  CONFIRM_REQUIRED: '文件较大或大小未知，请确认后再开始下载。',
  CANCELLED: '下载已取消。',
  OFFSCREEN_UNAVAILABLE: '本机转封装组件不可用，请重新加载扩展后重试。',
  PREVIEW_UNSUPPORTED: '该媒体格式暂不支持浏览器内预览，仍可尝试下载。',
  INTERNAL_ERROR: '发生内部错误，请重试。',
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly userMessage: string;
  readonly detail?: string;

  constructor(code: ErrorCode, detail?: string, message?: string) {
    super(message ?? MESSAGES[code]);
    this.name = 'AppError';
    this.code = code;
    this.userMessage = message ?? MESSAGES[code];
    this.detail = detail;
  }

  toTaskError(): TaskError {
    return {
      code: this.code,
      message: this.userMessage,
      ...(this.detail ? { detail: this.detail } : {}),
    };
  }
}

export function messageForCode(code: ErrorCode): string {
  return MESSAGES[code];
}

export function toTaskError(error: unknown, fallback: ErrorCode = 'INTERNAL_ERROR'): TaskError {
  if (error instanceof AppError) return error.toTaskError();
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { code: 'CANCELLED', message: MESSAGES.CANCELLED };
  }
  const detail = safeErrorDetail(error);
  return {
    code: fallback,
    message: MESSAGES[fallback],
    ...(detail ? { detail } : {}),
  };
}

export function toAppError(error: unknown, fallback: ErrorCode = 'INTERNAL_ERROR'): AppError {
  if (error instanceof AppError) return error;
  return new AppError(fallback, safeErrorDetail(error));
}

export function httpStatusError(status: number): AppError {
  if (status === 401) return new AppError('HTTP_UNAUTHORIZED', 'HTTP 401');
  if (status === 403) return new AppError('HTTP_FORBIDDEN', 'HTTP 403');
  return new AppError('HTTP_ERROR', `HTTP ${status}`);
}

export function safeErrorDetail(error: unknown): string | undefined {
  if (error instanceof AppError) return error.detail;
  if (error instanceof DOMException) {
    return `${error.name}${error.message ? `: ${error.message}` : ''}`.slice(0, 300);
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`.slice(0, 300);
  }
  if (typeof error === 'string') return error.slice(0, 300);
  return undefined;
}
