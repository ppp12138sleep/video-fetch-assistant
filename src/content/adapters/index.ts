import { bilibiliAdapter } from './bilibili';
import { douyinAdapter } from './douyin';
import { genericAdapter } from './generic';
import { kuaishouAdapter } from './kuaishou';
import type { PlatformAdapter } from './types';

export const PLATFORM_ADAPTERS: readonly PlatformAdapter[] = [
  douyinAdapter,
  kuaishouAdapter,
  bilibiliAdapter,
];

export function selectAdapter(url: string): PlatformAdapter {
  return PLATFORM_ADAPTERS.find((adapter) => adapter.matches(url)) ?? genericAdapter;
}

export { genericAdapter };
export type { AdapterContext, AdapterResult, PlatformAdapter } from './types';
