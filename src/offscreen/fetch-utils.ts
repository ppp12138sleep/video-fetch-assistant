import { AppError, httpStatusError } from '../shared/errors';
import type { SizeSource } from '../shared/types';
import { parseHttpUrl } from '../shared/url';
import { asBlobPart } from './bytes';
import type { TempStore } from './temp-store';

const DEFAULT_TIMEOUT_MS = 30_000;
const MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
export const MAX_TEMP_BYTES = 1200 * 1024 * 1024;

export interface ProbeResult {
  sizeBytes: number | null;
  source: SizeSource;
  contentType?: string;
  reason?: string;
}

function validateUrl(url: string): URL {
  const parsed = parseHttpUrl(url);
  if (!parsed) throw new AppError('INVALID_URL');
  return parsed;
}

function combineSignals(external: AbortSignal | undefined, controller: AbortController): () => void {
  if (!external) return () => undefined;
  if (external.aborted) controller.abort();
  const listener = () => controller.abort();
  external.addEventListener('abort', listener, { once: true });
  return () => external.removeEventListener('abort', listener);
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  validateUrl(url);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const controller = new AbortController();
  const detach = combineSignals(signal, controller);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      credentials: 'include',
      redirect: 'follow',
    });
    if (!response.ok && response.status !== 206) {
      throw httpStatusError(response.status);
    }
    return response;
  } catch (error) {
    if (timedOut) throw new AppError('TIMEOUT');
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (error instanceof AppError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new DOMException('Aborted', 'AbortError');
    }
    if (error instanceof TypeError) {
      throw new AppError('CORS_OR_NETWORK', error.message);
    }
    throw new AppError('NETWORK_ERROR', error instanceof Error ? error.message : undefined);
  } finally {
    clearTimeout(timer);
    detach();
  }
}

export async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetchWithTimeout(
    url,
    { method: 'GET', headers: { Accept: 'application/vnd.apple.mpegurl, application/dash+xml, application/xml, text/plain, */*' } },
    signal,
    20_000,
  );
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > MANIFEST_MAX_BYTES) {
    throw new AppError('PARSE_FAILED', '清单文件异常过大');
  }
  const text = await response.text();
  if (text.length > MANIFEST_MAX_BYTES) {
    throw new AppError('PARSE_FAILED', '清单文件异常过大');
  }
  if (/^\s*<!doctype html/i.test(text) || /^\s*<html/i.test(text)) {
    throw new AppError('UNSUPPORTED_FORMAT', '服务器返回 HTML 页面而不是媒体清单');
  }
  return text;
}

export async function fetchBytes(
  url: string,
  signal?: AbortSignal,
  range?: { start: number; end: number },
): Promise<Uint8Array> {
  const headers: Record<string, string> = {};
  if (range) headers.Range = `bytes=${range.start}-${range.end}`;
  const response = await fetchWithTimeout(url, { method: 'GET', headers }, signal);
  const buffer = await response.arrayBuffer();
  if (range && response.status === 200 && buffer.byteLength > range.end - range.start + 1) {
    return new Uint8Array(buffer.slice(range.start, range.end + 1));
  }
  return new Uint8Array(buffer);
}

export async function checkReachable(url: string, signal?: AbortSignal): Promise<number> {
  try {
    const response = await fetchWithTimeout(url, { method: 'HEAD' }, signal, 15_000);
    return response.status;
  } catch (error) {
    if (error instanceof AppError && error.code.startsWith('HTTP_')) {
      return Number(error.detail?.replace(/\D/g, '')) || 0;
    }
    throw error;
  }
}

function validLength(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function htmlContentType(contentType: string | null): boolean {
  return Boolean(contentType && /text\/html|application\/xhtml/i.test(contentType));
}

export async function probeMediaSize(url: string, signal?: AbortSignal): Promise<ProbeResult> {
  let headReason = '';
  try {
    const response = await fetchWithTimeout(
      url,
      { method: 'HEAD', headers: { Accept: 'video/*,audio/*,application/octet-stream,*/*' } },
      signal,
      15_000,
    );
    const contentType = response.headers.get('content-type') ?? undefined;
    if (htmlContentType(contentType ?? null)) {
      throw new AppError('UNSUPPORTED_FORMAT', '服务器返回 HTML 页面而不是媒体文件');
    }
    const length = validLength(response.headers.get('content-length'));
    if (length) {
      return {
        sizeBytes: length,
        source: 'content-length',
        ...(contentType ? { contentType } : {}),
      };
    }
    headReason = '响应未提供 Content-Length';
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (error instanceof AppError && error.code === 'UNSUPPORTED_FORMAT') throw error;
    headReason = error instanceof Error ? error.message : 'HEAD 请求失败';
  }

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        headers: {
          Range: 'bytes=0-0',
          Accept: 'video/*,audio/*,application/octet-stream,*/*',
        },
      },
      signal,
      20_000,
    );
    const contentType = response.headers.get('content-type') ?? undefined;
    if (htmlContentType(contentType ?? null)) {
      await response.body?.cancel().catch(() => undefined);
      throw new AppError('UNSUPPORTED_FORMAT', '服务器返回 HTML 页面而不是媒体文件');
    }
    const contentRange = response.headers.get('content-range');
    const total = contentRange ? /\/(\d+)\s*$/.exec(contentRange)?.[1] : undefined;
    if (total) {
      await response.body?.cancel().catch(() => undefined);
      return {
        sizeBytes: Number(total),
        source: 'content-range',
        ...(contentType ? { contentType } : {}),
      };
    }
    const length = validLength(response.headers.get('content-length'));
    await response.body?.cancel().catch(() => undefined);
    if (length) {
      return {
        sizeBytes: length,
        source: response.status === 206 ? 'content-range' : 'content-length',
        ...(contentType ? { contentType } : {}),
      };
    }
    return {
      sizeBytes: null,
      source: 'unknown',
      ...(contentType ? { contentType } : {}),
      reason: '服务器未返回可用于计算大小的响应头',
    };
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (error instanceof AppError && error.code === 'UNSUPPORTED_FORMAT') throw error;
    return {
      sizeBytes: null,
      source: 'unknown',
      reason: [headReason, error instanceof Error ? error.message : 'Range 请求失败']
        .filter(Boolean)
        .join('；')
        .slice(0, 250),
    };
  }
}

export interface DownloadStreamOptions {
  signal: AbortSignal;
  store: TempStore;
  track: string;
  startIndex?: number;
  expectedBytes?: number | null;
  onChunk?: (index: number, received: number) => void;
}

export async function downloadStreamToStore(
  url: string,
  options: DownloadStreamOptions,
): Promise<{ chunks: number; bytes: number }> {
  const response = await fetchWithTimeout(url, { method: 'GET' }, options.signal, 60_000);
  const contentLength = validLength(response.headers.get('content-length'));
  if (contentLength && contentLength > MAX_TEMP_BYTES) {
    throw new AppError('FILE_TOO_LARGE', `响应 Content-Length 超过上限：${contentLength}`);
  }
  if (!response.body) {
    const blob = await response.blob();
    if (blob.size > MAX_TEMP_BYTES) throw new AppError('FILE_TOO_LARGE');
    await options.store.put(options.track, options.startIndex ?? 0, blob);
    options.onChunk?.(1, blob.size);
    return { chunks: 1, bytes: blob.size };
  }
  const reader = response.body.getReader();
  let index = options.startIndex ?? 0;
  let bytes = 0;
  let pending: BlobPart[] = [];
  let pendingSize = 0;
  let chunks = 0;
  const flush = async (): Promise<void> => {
    if (!pendingSize) return;
    const blob = new Blob(pending);
    pending = [];
    pendingSize = 0;
    await options.store.put(options.track, index, blob);
    index += 1;
    chunks += 1;
    options.onChunk?.(index, bytes);
  };
  try {
    while (true) {
      if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > MAX_TEMP_BYTES) {
        throw new AppError('FILE_TOO_LARGE');
      }
      pending.push(asBlobPart(value));
      pendingSize += value.byteLength;
      if (pendingSize >= 4 * 1024 * 1024) await flush();
    }
    await flush();
  } finally {
    reader.releaseLock();
  }
  return { chunks, bytes };
}

export async function downloadUrlToStore(
  url: string,
  store: TempStore,
  track: string,
  signal: AbortSignal,
  onChunk?: (index: number, received: number) => void,
): Promise<{ chunks: number; bytes: number }> {
  return downloadStreamToStore(url, { store, track, signal, onChunk });
}
