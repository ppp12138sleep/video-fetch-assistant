import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sendRuntime } from '../shared/messaging';
import type { RuntimeRequest, TaskError, TaskRecord } from '../shared/types';

const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_STATUSES = new Set(['preparing', 'downloading', 'converting', 'saving']);

export interface TaskState {
  taskId: string;
  task: TaskRecord | null;
  fatal: TaskError | null;
  loading: boolean;
  reload: () => void;
  setTask: (task: TaskRecord) => void;
}

export function useTask(): TaskState {
  const taskId = useMemo(() => new URLSearchParams(window.location.search).get('task') ?? '', []);
  const [task, setTask] = useState<TaskRecord | null>(null);
  const [fatal, setFatal] = useState<TaskError | null>(null);
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState(0);
  const pollingRef = useRef(false);

  const reload = useCallback(() => {
    setLoading(true);
    setFatal(null);
    setGeneration((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!TASK_ID_PATTERN.test(taskId)) {
      setFatal({
        code: 'TASK_NOT_FOUND',
        message: '预览链接缺少有效的任务编号。请回到视频页面重新点击「获取视频」。',
      });
      setLoading(false);
      return;
    }
    let alive = true;
    void (async () => {
      const response = await sendRuntime<TaskRecord>({ type: 'VVA_GET_TASK', taskId });
      if (!alive) return;
      if (!response.ok) {
        setFatal(response.error);
        setLoading(false);
        return;
      }
      setTask(response.data);
      setFatal(null);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [taskId, generation]);

  useEffect(() => {
    if (!TASK_ID_PATTERN.test(taskId)) return;
    const listener = (message: unknown): void => {
      if (!message || typeof message !== 'object') return;
      const request = message as RuntimeRequest;
      if (request.type !== 'VVA_TASK_UPDATED' || request.task.id !== taskId) return;
      setTask(request.task);
      setFatal(null);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [taskId]);

  useEffect(() => {
    if (!task || !ACTIVE_STATUSES.has(task.status)) return;
    const timer = window.setInterval(() => {
      if (pollingRef.current || document.hidden) return;
      pollingRef.current = true;
      void sendRuntime<TaskRecord>({ type: 'VVA_GET_TASK', taskId })
        .then((response) => {
          if (response.ok) {
            setTask(response.data);
          } else if (response.error.code === 'TASK_EXPIRED' || response.error.code === 'TASK_NOT_FOUND') {
            setFatal(response.error);
          }
        })
        .finally(() => {
          pollingRef.current = false;
        });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [task, taskId]);

  return { taskId, task, fatal, loading, reload, setTask };
}
