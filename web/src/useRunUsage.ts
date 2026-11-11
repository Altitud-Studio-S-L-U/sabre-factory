import { useEffect, useState } from 'react';
import type { Api, RunUsageSnapshot, WorkOrder } from './api';

export interface RunUsageState {
  snapshot: RunUsageSnapshot | null;
  loading: boolean;
  stale: boolean;
  error: string;
  canRetry: boolean;
  retry: () => void;
}

export default function useRunUsage(
  api: Api,
  workId: string,
  status: WorkOrder['status'],
  connected: boolean,
): RunUsageState {
  const [saved, setSaved] = useState<RunUsageSnapshot | null>(null);
  const [failure, setFailure] = useState<{ workId: string; message: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!connected) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const poll = async () => {
      controller = new AbortController();
      setPending(workId);
      try {
        const value = await api.usage(workId, controller.signal);
        if (stopped) return;
        if (value.work_id !== workId) throw new Error('Usage belongs to a different run');
        setSaved(value);
        setFailure(null);
        if (status === 'queued' || status === 'running') timer = setTimeout(poll, 2000);
      } catch {
        if (!stopped) setFailure({ workId, message: 'Live usage could not be refreshed.' });
      } finally {
        if (!stopped) setPending(null);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [api, workId, status, connected, revision]);
  return {
    snapshot: saved?.work_id === workId ? saved : null,
    loading: connected && pending === workId,
    stale: !connected || failure?.workId === workId,
    error: !connected ? 'Disconnected.' : failure?.workId === workId ? failure.message : '',
    canRetry: connected && pending !== workId,
    retry: () => {
      if (connected && pending !== workId) setRevision((value) => value + 1);
    },
  };
}
