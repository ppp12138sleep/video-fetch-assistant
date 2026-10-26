import { TASK_TTL_MS } from '../shared/types';
import type { TaskRecord, VideoSnapshot } from '../shared/types';

const PREFIX = 'vva:task:';
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isTaskId(value: unknown): value is string {
  return typeof value === 'string' && TASK_ID_PATTERN.test(value);
}

function taskKey(taskId: string): string {
  return `${PREFIX}${taskId}`;
}

export function createTaskRecord(id: string, snapshot: VideoSnapshot): TaskRecord {
  const now = Date.now();
  return {
    id,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + TASK_TTL_MS,
    status: 'ready',
    snapshot,
  };
}

export async function saveTask(task: TaskRecord): Promise<void> {
  task.updatedAt = Date.now();
  await chrome.storage.session.set({ [taskKey(task.id)]: task });
}

export interface LoadedTask {
  task: TaskRecord | null;
  expired: boolean;
}

export async function loadTask(taskId: string): Promise<LoadedTask> {
  if (!isTaskId(taskId)) return { task: null, expired: false };
  const result = await chrome.storage.session.get(taskKey(taskId));
  const task = result[taskKey(taskId)] as TaskRecord | undefined;
  if (!task) return { task: null, expired: false };
  if (Date.now() > task.expiresAt) {
    return { task, expired: true };
  }
  return { task, expired: false };
}

export async function deleteTask(taskId: string): Promise<void> {
  await chrome.storage.session.remove(taskKey(taskId));
}

export async function listTasks(): Promise<TaskRecord[]> {
  const all = await chrome.storage.session.get(null);
  return Object.entries(all)
    .filter(([key]) => key.startsWith(PREFIX))
    .map(([, value]) => value as TaskRecord)
    .filter((task) => task && typeof task.id === 'string');
}

export async function findTaskByDownloadId(downloadId: number): Promise<TaskRecord | null> {
  const tasks = await listTasks();
  return tasks.find((task) => task.downloadId === downloadId) ?? null;
}

export async function cleanupExpiredTasks(): Promise<number> {
  const now = Date.now();
  const tasks = await listTasks();
  const expired = tasks.filter((task) => now > task.expiresAt);
  if (!expired.length) return 0;
  await chrome.storage.session.remove(expired.map((task) => taskKey(task.id)));
  return expired.length;
}

export function extendTaskForCompleted(task: TaskRecord, ttlMs: number): void {
  task.expiresAt = Date.now() + ttlMs;
}
