import { AppError, toTaskError } from './errors';
import type { ApiResponse, OffscreenRequest, OffscreenResponse, RuntimeRequest } from './types';

export async function sendRuntime<T>(request: RuntimeRequest): Promise<ApiResponse<T>> {
  try {
    const response = (await chrome.runtime.sendMessage(request)) as ApiResponse<T> | undefined;
    if (!response) {
      return {
        ok: false,
        error: new AppError('INTERNAL_ERROR', '扩展后台没有返回结果').toTaskError(),
      };
    }
    return response;
  } catch (error) {
    return { ok: false, error: toTaskError(error) };
  }
}

export async function sendOffscreen(request: OffscreenRequest): Promise<OffscreenResponse> {
  try {
    const response = (await chrome.runtime.sendMessage(request)) as OffscreenResponse | undefined;
    if (!response) {
      return {
        ok: false,
        error: new AppError('OFFSCREEN_UNAVAILABLE', 'offscreen 文档没有响应').toTaskError(),
      };
    }
    return response;
  } catch (error) {
    return { ok: false, error: toTaskError(error, 'OFFSCREEN_UNAVAILABLE') };
  }
}

export async function sendTabMessage<T>(
  tabId: number,
  request: RuntimeRequest,
): Promise<ApiResponse<T> | null> {
  try {
    const response = (await chrome.tabs.sendMessage(tabId, request)) as ApiResponse<T> | undefined;
    return response ?? null;
  } catch {
    return null;
  }
}

export function isRuntimeRequest(value: unknown): value is RuntimeRequest {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as { type?: unknown }).type === 'string' &&
      (value as { type: string }).type.startsWith('VVA_'),
  );
}

export function isOffscreenRequest(value: unknown): value is OffscreenRequest {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as { type?: unknown }).type === 'string' &&
      (value as { type: string }).type.startsWith('VVA_OFFSCREEN_'),
  );
}
