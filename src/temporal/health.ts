/**
 * Temporal probes for GET /health. Keeps Temporal SDK / proto details out of
 * the API layer (same reason runner.ts exists).
 */
import { config } from '../config';
import { getTemporalClient } from './client';

// Values of temporal.api.enums.v1.TaskQueueKind / TaskQueueType.
const TASK_QUEUE_KIND_NORMAL = 1;
const TASK_QUEUE_TYPE_WORKFLOW = 1;
const TASK_QUEUE_TYPE_ACTIVITY = 2;

/**
 * The server keeps listing a poller for minutes after it stopped polling, so
 * only pollers seen this recently count. An idle worker re-polls at least every
 * ~60s (long-poll timeout), so 90s never drops a live worker.
 */
export const POLLER_FRESHNESS_MS = 90_000;

type TimestampLike = { seconds?: number | { toNumber(): number } | null; nanos?: number | null } | null | undefined;

function timestampToMs(ts: TimestampLike): number | undefined {
  if (!ts || ts.seconds == null) return undefined;
  const seconds = typeof ts.seconds === 'number' ? ts.seconds : ts.seconds.toNumber();
  return seconds * 1000 + Math.floor((ts.nanos ?? 0) / 1e6);
}

/** Resolves if the Temporal frontend answers DescribeNamespace for the configured namespace. */
export async function pingTemporal(signal: AbortSignal): Promise<void> {
  const client = await getTemporalClient();
  await client.withAbortSignal(signal, () =>
    client.workflowService.describeNamespace({ namespace: config.temporalNamespace }),
  );
}

export interface WorkerPollers {
  workflow: number;
  activity: number;
}

/** Counts pollers on TEMPORAL_TASK_QUEUE seen within POLLER_FRESHNESS_MS, per task-queue type. */
export async function countWorkerPollers(signal: AbortSignal, now: number = Date.now()): Promise<WorkerPollers> {
  const client = await getTemporalClient();
  const describe = async (taskQueueType: number): Promise<number> => {
    const res = await client.withAbortSignal(signal, () =>
      client.workflowService.describeTaskQueue({
        namespace: config.temporalNamespace,
        taskQueue: { name: config.temporalTaskQueue, kind: TASK_QUEUE_KIND_NORMAL },
        taskQueueType,
      }),
    );
    return (res.pollers ?? []).filter((p) => {
      const last = timestampToMs(p.lastAccessTime);
      return last !== undefined && now - last <= POLLER_FRESHNESS_MS;
    }).length;
  };
  const [workflow, activity] = await Promise.all([
    describe(TASK_QUEUE_TYPE_WORKFLOW),
    describe(TASK_QUEUE_TYPE_ACTIVITY),
  ]);
  return { workflow, activity };
}
