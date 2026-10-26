import { sanitizeLogText, logWarn } from '../shared/logger';
import type { MediaCandidate, TaskRecord } from '../shared/types';
import { getHostname, pageReferer } from '../shared/url';

function hashTaskId(taskId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < taskId.length; index += 1) {
    hash ^= taskId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 1_000_000;
}

function ruleIdsForTask(taskId: string, count: number): number[] {
  const base = 10_000 + hashTaskId(taskId) * 10;
  return Array.from({ length: Math.min(count, 10) }, (_, index) => base + index);
}

function mediaHosts(candidates: MediaCandidate[]): string[] {
  const hosts = new Set<string>();
  for (const candidate of candidates) {
    const urls = [candidate.url, ...candidate.tracks.map((track) => track.url)];
    for (const url of urls) {
      if (!url) continue;
      const host = getHostname(url);
      if (host) hosts.add(host);
    }
  }
  return [...hosts].slice(0, 10);
}

export async function applyTaskRules(task: TaskRecord): Promise<number[]> {
  if (task.dnrRuleIds?.length) {
    await removeTaskRules(task);
  }
  const hosts = mediaHosts(task.snapshot.candidates);
  if (!hosts.length) return [];
  const referer = pageReferer(task.snapshot.pageUrl);
  if (!referer) return [];
  const ruleIds = ruleIdsForTask(task.id, hosts.length);
  const rules: chrome.declarativeNetRequest.Rule[] = hosts.map((host, index) => ({
    id: ruleIds[index]!,
    priority: 1,
    action: {
      type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [
        {
          header: 'Referer',
          operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
          value: referer,
        },
      ],
    },
    condition: {
      requestDomains: [host],
      resourceTypes: [
        'media',
        'xmlhttprequest',
        'other',
      ] as chrome.declarativeNetRequest.ResourceType[],
    },
  }));
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: ruleIds,
      addRules: rules,
    });
    task.dnrRuleIds = ruleIds;
    return ruleIds;
  } catch (error) {
    logWarn('dnr', 'APPLY_FAILED', new Error(sanitizeLogText(String(error))));
    return [];
  }
}

export async function removeTaskRules(task: TaskRecord): Promise<void> {
  const ids = task.dnrRuleIds;
  if (!ids?.length) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
  } catch (error) {
    logWarn('dnr', 'REMOVE_FAILED', new Error(sanitizeLogText(String(error))));
  }
  task.dnrRuleIds = [];
}

export async function removeAllTaskRules(): Promise<void> {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const ids = rules.map((rule) => rule.id);
  if (ids.length) {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
  }
}
