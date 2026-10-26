import { MAX_NETWORK_RECORDS } from '../shared/constants';
import type { NetworkMediaRecord, PageHints } from '../shared/types';
import { parseHttpUrl } from '../shared/url';

interface Waiter<T> {
  resolve: (value: T) => void;
  timer: number;
}

function parseDetail<T>(event: Event): T | null {
  try {
    const raw = (event as CustomEvent<string>).detail;
    if (typeof raw !== 'string') return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export class PageBridge {
  private records: NetworkMediaRecord[] = [];
  private hints: PageHints | null = null;
  private readonly netWaiters = new Map<string, Waiter<NetworkMediaRecord[]>>();
  private readonly hintWaiters = new Map<string, Waiter<PageHints>>();
  private counter = 0;
  private routeStamp = 0;
  private readonly onMedia = (event: Event): void => {
    const record = parseDetail<NetworkMediaRecord>(event);
    if (!record || !parseHttpUrl(record.url)) return;
    this.mergeRecord(record);
  };
  private readonly onNetCache = (event: Event): void => {
    const detail = parseDetail<{ requestId?: string; records?: NetworkMediaRecord[] }>(event);
    if (!detail?.requestId || !Array.isArray(detail.records)) return;
    for (const record of detail.records) {
      if (record && parseHttpUrl(record.url)) this.mergeRecord(record);
    }
    const waiter = this.netWaiters.get(detail.requestId);
    if (!waiter) return;
    window.clearTimeout(waiter.timer);
    this.netWaiters.delete(detail.requestId);
    waiter.resolve([...this.records]);
  };
  private readonly onHints = (event: Event): void => {
    const detail = parseDetail<{ requestId?: string; hints?: PageHints }>(event);
    if (!detail?.requestId || !detail.hints) return;
    this.hints = detail.hints;
    const waiter = this.hintWaiters.get(detail.requestId);
    if (!waiter) return;
    window.clearTimeout(waiter.timer);
    this.hintWaiters.delete(detail.requestId);
    waiter.resolve(this.hints);
  };
  private readonly onRoute = (): void => {
    this.routeStamp = Date.now();
    this.records = [];
    this.hints = null;
  };

  constructor() {
    document.addEventListener('vva-net-media', this.onMedia);
    document.addEventListener('vva-net-cache', this.onNetCache);
    document.addEventListener('vva-hints-response', this.onHints);
    document.addEventListener('vva-route-change', this.onRoute);
  }

  dispose(): void {
    document.removeEventListener('vva-net-media', this.onMedia);
    document.removeEventListener('vva-net-cache', this.onNetCache);
    document.removeEventListener('vva-hints-response', this.onHints);
    document.removeEventListener('vva-route-change', this.onRoute);
    for (const waiter of this.netWaiters.values()) window.clearTimeout(waiter.timer);
    for (const waiter of this.hintWaiters.values()) window.clearTimeout(waiter.timer);
    this.netWaiters.clear();
    this.hintWaiters.clear();
  }

  get routeTime(): number {
    return this.routeStamp;
  }

  clearForRoute(): void {
    this.onRoute();
  }

  async queryRecords(timeoutMs = 450): Promise<NetworkMediaRecord[]> {
    const requestId = `n${++this.counter}`;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.netWaiters.delete(requestId);
        resolve([...this.records]);
      }, timeoutMs);
      this.netWaiters.set(requestId, { resolve, timer });
      this.dispatchQuery('vva-net-query', requestId);
    });
  }

  async queryHints(timeoutMs = 450): Promise<PageHints | null> {
    const requestId = `h${++this.counter}`;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.hintWaiters.delete(requestId);
        resolve(this.hints);
      }, timeoutMs);
      this.hintWaiters.set(requestId, { resolve, timer });
      this.dispatchQuery('vva-hints-query', requestId);
    });
  }

  private dispatchQuery(name: string, requestId: string): void {
    try {
      document.dispatchEvent(
        new CustomEvent(name, { detail: JSON.stringify({ requestId }) }),
      );
    } catch {
      // 页面改写 CustomEvent 时由超时兜底。
    }
  }

  private mergeRecord(record: NetworkMediaRecord): void {
    if (record.at < this.routeStamp && this.routeStamp > 0) return;
    const existing = this.records.find((item) => item.url === record.url);
    if (existing) {
      if (record.contentLength && !existing.contentLength) existing.contentLength = record.contentLength;
      if (record.contentType && !existing.contentType) existing.contentType = record.contentType;
      return;
    }
    this.records.unshift(record);
    if (this.records.length > MAX_NETWORK_RECORDS) this.records.length = MAX_NETWORK_RECORDS;
  }
}
