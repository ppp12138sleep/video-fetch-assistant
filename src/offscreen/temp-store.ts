const DB_NAME = 'vva-media-cache';
const DB_VERSION = 1;
const STORE = 'chunks';
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

export interface TempChunk {
  key: string;
  taskId: string;
  track: string;
  index: number;
  size: number;
  data: Blob;
  createdAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('taskId', 'taskId', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 打开失败'));
  });
  return dbPromise;
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB 事务失败'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 事务被中止'));
  });
}

export class TempStore {
  private readonly taskId: string;

  constructor(taskId: string) {
    this.taskId = taskId;
  }

  async put(track: string, index: number, data: Blob): Promise<void> {
    const db = await openDatabase();
    const transaction = db.transaction(STORE, 'readwrite');
    const key = `${this.taskId}:${track}:${String(index).padStart(8, '0')}`;
    transaction.objectStore(STORE).put({
      key,
      taskId: this.taskId,
      track,
      index,
      size: data.size,
      data,
      createdAt: Date.now(),
    } satisfies TempChunk);
    await transactionDone(transaction);
  }

  async list(track: string): Promise<TempChunk[]> {
    const db = await openDatabase();
    const transaction = db.transaction(STORE, 'readonly');
    const request = transaction.objectStore(STORE).index('taskId').getAll(this.taskId);
    const records = await new Promise<TempChunk[]>((resolve, reject) => {
      request.onsuccess = () => resolve((request.result as TempChunk[]).filter((item) => item.track === track));
      request.onerror = () => reject(request.error ?? new Error('读取临时分片失败'));
    });
    await transactionDone(transaction);
    return records.sort((left, right) => left.index - right.index);
  }

  async totalBytes(): Promise<number> {
    const db = await openDatabase();
    const transaction = db.transaction(STORE, 'readonly');
    const request = transaction.objectStore(STORE).index('taskId').getAll(this.taskId);
    const total = await new Promise<number>((resolve, reject) => {
      request.onsuccess = () =>
        resolve(
          (request.result as TempChunk[]).reduce((sum, item) => sum + (item.size || 0), 0),
        );
      request.onerror = () => reject(request.error ?? new Error('统计临时分片失败'));
    });
    await transactionDone(transaction);
    return total;
  }

  async clear(): Promise<void> {
    const db = await openDatabase();
    const transaction = db.transaction(STORE, 'readwrite');
    const request = transaction.objectStore(STORE).index('taskId').getAllKeys(this.taskId);
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('读取临时分片索引失败'));
    });
    for (const key of keys) transaction.objectStore(STORE).delete(key);
    await transactionDone(transaction);
  }
}

export async function cleanupOldTempData(): Promise<void> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction(STORE, 'readwrite');
    const index = transaction.objectStore(STORE).index('createdAt');
    const boundary = Date.now() - MAX_AGE_MS;
    const request = index.openCursor(IDBKeyRange.upperBound(boundary));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    await transactionDone(transaction);
  } catch {
    // 临时缓存清理失败不应阻断当前任务。
  }
}

export async function clearAllTempData(): Promise<void> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).clear();
    await transactionDone(transaction);
  } catch {
    // 忽略。
  }
}

export function blobFromChunks(chunks: TempChunk[], type = 'application/octet-stream'): Blob {
  return new Blob(
    chunks.map((chunk) => chunk.data),
    { type },
  );
}

export async function blobToBytes(blob: Blob, signal?: AbortSignal): Promise<Uint8Array> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return new Uint8Array(await blob.arrayBuffer());
}

export async function storedBytes(chunks: TempChunk[]): Promise<Uint8Array> {
  const blob = blobFromChunks(chunks);
  return new Uint8Array(await blob.arrayBuffer());
}
