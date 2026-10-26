import { OFFSCREEN_JUSTIFICATION, OFFSCREEN_PATH } from '../shared/constants';
import { AppError } from '../shared/errors';
import type { OffscreenRequest, OffscreenResponse } from '../shared/types';

let creating: Promise<void> | null = null;

export function offscreenUrl(): string {
  return chrome.runtime.getURL(OFFSCREEN_PATH);
}

export async function hasOffscreenDocument(): Promise<boolean> {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl()],
    });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

export async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  if (creating) {
    await creating;
    return;
  }
  creating = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['BLOBS', 'DOM_PARSER', 'WORKERS'],
        justification: OFFSCREEN_JUSTIFICATION,
      });
    } catch (error) {
      if (!(await hasOffscreenDocument())) {
        throw new AppError('OFFSCREEN_UNAVAILABLE', String(error));
      }
    }
  })();
  try {
    await creating;
  } finally {
    creating = null;
  }
}

export async function sendToOffscreen(request: OffscreenRequest): Promise<OffscreenResponse> {
  await ensureOffscreenDocument();
  try {
    const response = (await chrome.runtime.sendMessage(request)) as OffscreenResponse | undefined;
    if (!response) {
      throw new AppError('OFFSCREEN_UNAVAILABLE', 'offscreen 文档未返回结果');
    }
    return response;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('OFFSCREEN_UNAVAILABLE', String(error));
  }
}

export async function closeOffscreenDocument(): Promise<void> {
  try {
    if (await hasOffscreenDocument()) {
      await chrome.offscreen.closeDocument();
    }
  } catch {
    // 文档可能已经被浏览器关闭。
  }
}
