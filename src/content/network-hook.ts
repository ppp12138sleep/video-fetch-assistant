import { MAX_NETWORK_RECORDS, MEDIA_CONTENT_TYPE_PATTERN, NETWORK_HOOK_GUARD } from '../shared/constants';
import type { NetworkMediaRecord, PageHints } from '../shared/types';
import { isMediaUrl, parseHttpUrl } from '../shared/url';

declare global {
  interface Window {
    [NETWORK_HOOK_GUARD]?: boolean;
    __playinfo__?: unknown;
    __INITIAL_STATE__?: unknown;
  }
}

export {};

if (window[NETWORK_HOOK_GUARD]) {
  // 已由静态内容脚本或工具栏注入过，避免重复包装页面 API。
} else {
  window[NETWORK_HOOK_GUARD] = true;
  installNetworkHook();
}

function installNetworkHook(): void {
  const records: NetworkMediaRecord[] = [];
  let routeEpoch = 0;
  let routeStartedAt = 0;
  let routeStartedPerf = 0;

  const bumpRoute = (): void => {
    routeEpoch += 1;
    routeStartedAt = Date.now();
    routeStartedPerf = performance.now();
    records.length = 0;
    dispatch('vva-route-change', { at: routeStartedAt, epoch: routeEpoch });
    queuePerformanceScan();
  };

  const dispatch = (name: string, payload: unknown): void => {
    try {
      document.dispatchEvent(
        new CustomEvent(name, { detail: JSON.stringify(payload) }),
      );
    } catch {
      // 某些页面会改写 CustomEvent；静默失败不影响页面。
    }
  };

  const addRecord = (record: NetworkMediaRecord): void => {
    if (!record.url || !parseHttpUrl(record.url)) return;
    if (record.at < routeStartedAt) return;
    const existing = records.find((item) => item.url === record.url);
    if (existing) {
      if (record.contentLength && !existing.contentLength) existing.contentLength = record.contentLength;
      if (record.contentType && !existing.contentType) existing.contentType = record.contentType;
      return;
    }
    records.unshift(record);
    if (records.length > MAX_NETWORK_RECORDS) records.length = MAX_NETWORK_RECORDS;
    dispatch('vva-net-media', record);
  };

  const recordFromUrl = (
    rawUrl: string,
    source: NetworkMediaRecord['source'],
    contentType?: string | null,
    contentLength?: string | null,
  ): void => {
    const url = parseHttpUrl(rawUrl)?.href;
    if (!url) return;
    const type = contentType ?? undefined;
    if (!isMediaUrl(url) && !(type && MEDIA_CONTENT_TYPE_PATTERN.test(type))) {
      return;
    }
    const length = contentLength ? Number(contentLength) : undefined;
    addRecord({
      url,
      ...(type ? { contentType: type } : {}),
      ...(length && Number.isFinite(length) && length > 0 ? { contentLength: length } : {}),
      source,
      at: Date.now(),
    });
  };

  const queuePerformanceScan = (): void => {
    setTimeout(scanPerformance, 300);
  };

  const scanPerformance = (): void => {
    try {
      const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      for (const entry of entries) {
        if (entry.startTime < routeStartedPerf) continue;
        if (!isMediaUrl(entry.name)) continue;
        recordFromUrl(entry.name, 'performance');
      }
    } catch {
      // performance 条目在部分隐私模式不可用。
    }
  };

  // 只读包装 fetch：不修改请求、不阻塞响应、不读取响应正文。
  if (typeof window.fetch === 'function') {
    const originalFetch = window.fetch;
    window.fetch = function patchedFetch(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      let url = '';
      try {
        if (typeof input === 'string') url = input;
        else if (input instanceof URL) url = input.href;
        else if (input instanceof Request) url = input.url;
      } catch {
        // 忽略异常输入，保持原生行为。
      }
      const startedAt = Date.now();
      const epochAtStart = routeEpoch;
      const result = Reflect.apply(originalFetch, this, [input, init]) as Promise<Response>;
      result
        .then((response) => {
          if (!url || epochAtStart !== routeEpoch || startedAt < routeStartedAt) return;
          try {
            const contentType = response.headers.get('content-type');
            const contentLength = response.headers.get('content-length');
            recordFromUrl(url, 'fetch', contentType, contentLength);
          } catch {
            // 不透明响应没有可读 header。
          }
        })
        .catch(() => undefined);
      return result;
    };
  }

  // 只读 XHR 监听：包装 open/send 但完全保留原始调用和返回。
  if (window.XMLHttpRequest?.prototype) {
    const xhrProto = window.XMLHttpRequest.prototype;
    const originalOpen = xhrProto.open;
    const originalSend = xhrProto.send;
    const xhrUrls = new WeakMap<XMLHttpRequest, string>();
    xhrProto.open = function patchedOpen(
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ): void {
      try {
        xhrUrls.set(this, typeof url === 'string' ? url : url.href);
      } catch {
        // 忽略。
      }
      return Reflect.apply(originalOpen, this, [method, url, async ?? true, username ?? null, password ?? null]);
    };
    xhrProto.send = function patchedSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
      const startedAt = Date.now();
      const epochAtStart = routeEpoch;
      this.addEventListener('loadend', () => {
        const url = xhrUrls.get(this);
        if (!url || epochAtStart !== routeEpoch || startedAt < routeStartedAt) return;
        try {
          const contentType = this.getResponseHeader('content-type');
          const contentLength = this.getResponseHeader('content-length');
          recordFromUrl(url, 'xhr', contentType, contentLength);
        } catch {
          // 跨域 XHR 的响应头可能不可读。
        }
      });
      return Reflect.apply(originalSend, this, [body]);
    };
  }

  // SPA 路由钩子只广播事件，不改变原有导航行为。
  try {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function patchedPushState(
      this: History,
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ): void {
      const result = Reflect.apply(originalPushState, this, [data, unused, url]);
      bumpRoute();
      return result;
    };
    history.replaceState = function patchedReplaceState(
      this: History,
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ): void {
      const result = Reflect.apply(originalReplaceState, this, [data, unused, url]);
      bumpRoute();
      return result;
    };
  } catch {
    // 页面可能冻结 history，内容脚本仍有基于 location 的兜底。
  }

  window.addEventListener('popstate', bumpRoute, { passive: true });
  window.addEventListener('hashchange', bumpRoute, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) queuePerformanceScan();
  });

  document.addEventListener('vva-net-query', (event) => {
    const requestId = readRequestId(event);
    if (!requestId) return;
    scanPerformance();
    dispatch('vva-net-cache', { requestId, records });
  });

  document.addEventListener('vva-hints-query', (event) => {
    const requestId = readRequestId(event);
    if (!requestId) return;
    const hints = collectPageHints();
    dispatch('vva-hints-response', { requestId, hints });
  });

  const interval = window.setInterval(scanPerformance, 4_000);
  window.addEventListener(
    'pagehide',
    () => {
      window.clearInterval(interval);
    },
    { once: true },
  );
  queuePerformanceScan();
}

function readRequestId(event: Event): string | null {
  try {
    const detail = (event as CustomEvent<string>).detail;
    const parsed = typeof detail === 'string' ? (JSON.parse(detail) as { requestId?: unknown }) : null;
    return typeof parsed?.requestId === 'string' ? parsed.requestId : null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function collectPageHints(): PageHints {
  const hints: PageHints = {};
  if (!/(^|\.)bilibili\.com$/i.test(location.hostname)) return hints;
  try {
    const playinfoRaw = window.__playinfo__;
    const playinfo =
      typeof playinfoRaw === 'string'
        ? asRecord(JSON.parse(playinfoRaw))
        : asRecord(playinfoRaw);
    const playData = asRecord(playinfo?.data);
    const dash = asRecord(playData?.dash);
    const state = asRecord(window.__INITIAL_STATE__);
    const videoData = asRecord(state?.videoData) ?? asRecord(state?.videoInfo);

    const videos: NonNullable<PageHints['bilibili']>['videos'] = [];
    const audios: NonNullable<PageHints['bilibili']>['audios'] = [];
    const videoList = Array.isArray(dash?.video) ? dash.video : [];
    const audioList = Array.isArray(dash?.audio) ? dash.audio : [];
    for (const raw of videoList.slice(0, 16)) {
      const item = asRecord(raw);
      const baseUrl = asString(item?.baseUrl) ?? asString(item?.base_url);
      if (!baseUrl) continue;
      const backupUrl = asString(item?.backupUrl) ?? asString(item?.backup_url);
      videos.push({
        baseUrl,
        ...(backupUrl ? { backupUrl } : {}),
        ...(asNumber(item?.width) ? { width: asNumber(item?.width)! } : {}),
        ...(asNumber(item?.height) ? { height: asNumber(item?.height)! } : {}),
        ...(asNumber(item?.bandwidth) ? { bandwidth: asNumber(item?.bandwidth)! } : {}),
        ...(asString(item?.codecs) ? { codecs: asString(item?.codecs)! } : {}),
        ...(asString(item?.mimeType) ? { mimeType: asString(item?.mimeType)! } : {}),
      });
    }
    for (const raw of audioList.slice(0, 8)) {
      const item = asRecord(raw);
      const baseUrl = asString(item?.baseUrl) ?? asString(item?.base_url);
      if (!baseUrl) continue;
      const backupUrl = asString(item?.backupUrl) ?? asString(item?.backup_url);
      audios.push({
        baseUrl,
        ...(backupUrl ? { backupUrl } : {}),
        ...(asNumber(item?.bandwidth) ? { bandwidth: asNumber(item?.bandwidth)! } : {}),
        ...(asString(item?.codecs) ? { codecs: asString(item?.codecs)! } : {}),
        ...(asString(item?.mimeType) ? { mimeType: asString(item?.mimeType)! } : {}),
      });
    }

    const durl: NonNullable<PageHints['bilibili']>['durl'] = [];
    const durlList = Array.isArray(playData?.durl) ? playData.durl : [];
    for (const raw of durlList.slice(0, 8)) {
      const item = asRecord(raw);
      const url = asString(item?.url);
      if (!url) continue;
      const backupUrl = asString(item?.backup_url) ?? asString(item?.backupUrl);
      durl.push({
        url,
        ...(backupUrl ? { backupUrl } : {}),
        ...(asNumber(item?.size) ? { size: asNumber(item?.size)! } : {}),
      });
    }

    const title =
      asString(videoData?.title) ??
      asString(asRecord(state?.videoData)?.title) ??
      undefined;
    const coverUrl =
      asString(videoData?.pic) ??
      asString(videoData?.cover) ??
      asString(state?.pic) ??
      undefined;
    const duration =
      asNumber(videoData?.duration) ??
      asNumber(playData?.timelength ? Number(playData.timelength) / 1000 : undefined) ??
      asNumber(dash?.duration);

    hints.bilibili = {
      ...(title ? { title } : {}),
      ...(coverUrl ? { coverUrl } : {}),
      ...(duration ? { duration } : {}),
      ...(location.pathname.startsWith('/live/') || Boolean(state?.liveRoom)
        ? { isLive: true }
        : {}),
      videos,
      audios,
      ...(durl.length ? { durl } : {}),
    };
  } catch {
    // 页面全局数据可能被冻结，忽略并使用通用探测。
  }
  return hints;
}
