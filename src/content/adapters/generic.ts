import { pageReferer } from '../../shared/url';
import { finalizeResult } from './common';
import type { AdapterContext, AdapterResult, PlatformAdapter } from './types';

export const genericAdapter: PlatformAdapter = {
  id: 'generic',
  name: '通用网站',
  matches(): boolean {
    return true;
  },
  async collect(context: AdapterContext): Promise<AdapterResult> {
    return finalizeResult(context, {
      platformId: 'generic',
      platformName: '通用网站',
      requiresReferer: true,
    });
  },
  getRequestHeaders(context: AdapterContext): Record<string, string> {
    return { Referer: pageReferer(context.pageUrl) };
  },
};
