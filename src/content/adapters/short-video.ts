import type { PlatformId } from '../../shared/types';
import { pageReferer } from '../../shared/url';
import { finalizeResult } from './common';
import type { AdapterContext, AdapterResult, PlatformAdapter } from './types';

export function createShortVideoAdapter(
  id: Extract<PlatformId, 'douyin' | 'kuaishou'>,
  name: string,
  hostSuffixes: string[],
): PlatformAdapter {
  return {
    id,
    name,
    matches(url: string): boolean {
      try {
        const host = new URL(url).hostname;
        return hostSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
      } catch {
        return false;
      }
    },
    async collect(context: AdapterContext): Promise<AdapterResult> {
      return finalizeResult(context, {
        platformId: id,
        platformName: name,
        requiresReferer: true,
      });
    },
    getRequestHeaders(context: AdapterContext): Record<string, string> {
      return { Referer: pageReferer(context.pageUrl) };
    },
  };
}
