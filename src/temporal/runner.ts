/**
 * Runs hotelOffersWorkflow from the API process and translates Temporal SDK
 * errors into a small set of typed errors, so the HTTP layer (and its tests)
 * never depend on Temporal SDK classes.
 */
import {
  ApplicationFailure,
  isGrpcServiceError,
  TimeoutFailure,
  WorkflowFailedError,
  type Client,
} from '@temporalio/client';
import { config } from '../config';
import { getTemporalClient } from './client';
import {
  ALL_SUPPLIERS_FAILED,
  HOTEL_OFFERS_WORKFLOW,
  type HotelOffersInput,
  type HotelOffersResult,
} from './shared';
import type { hotelOffersWorkflow } from './workflows';

const WORKFLOW_EXECUTION_TIMEOUT = '30s';
/** Max time to get the workflow started (incl. SDK gRPC retries) before reporting Temporal down. */
const START_DEADLINE_MS = 3_000;

/** gRPC status codes that mean "Temporal is not reachable right now". */
const GRPC_UNAVAILABLE = 14;
const GRPC_DEADLINE_EXCEEDED = 4;

export type RunHotelOffers = (
  input: HotelOffersInput,
  opts: { workflowId: string },
) => Promise<HotelOffersResult>;

/** The workflow failed with ApplicationFailure type "AllSuppliersFailed". */
export class AllSuppliersFailedError extends Error {
  constructor(message = 'All suppliers failed', options?: ErrorOptions) {
    super(message, options);
    this.name = 'AllSuppliersFailedError';
  }
}

/** Temporal could not be reached (connect failure or gRPC UNAVAILABLE). */
export class TemporalUnavailableError extends Error {
  constructor(message = 'Temporal is unavailable', options?: ErrorOptions) {
    super(message, options);
    this.name = 'TemporalUnavailableError';
  }
}

/** The workflow hit its execution timeout (e.g. no worker polling the task queue). */
export class WorkflowTimeoutError extends Error {
  constructor(message = 'Workflow execution timed out', options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkflowTimeoutError';
  }
}

/** True if err, or anything in its `cause` chain, is a gRPC error with one of the codes. */
function hasGrpcCode(err: unknown, codes: readonly number[]): boolean {
  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth < 10; depth++) {
    if (isGrpcServiceError(current) && codes.includes(current.code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Maps a Temporal SDK error to AllSuppliersFailedError / WorkflowTimeoutError /
 * TemporalUnavailableError. Anything unrecognised is returned unchanged.
 */
export function classifyTemporalError(err: unknown): unknown {
  if (err instanceof WorkflowFailedError) {
    const { cause } = err;
    if (cause instanceof ApplicationFailure && cause.type === ALL_SUPPLIERS_FAILED) {
      return new AllSuppliersFailedError(cause.message, { cause: err });
    }
    if (cause instanceof TimeoutFailure) {
      return new WorkflowTimeoutError(cause.message || err.message, { cause: err });
    }
    return err;
  }
  if (hasGrpcCode(err, [GRPC_UNAVAILABLE, GRPC_DEADLINE_EXCEEDED])) {
    return new TemporalUnavailableError('Temporal is unavailable', { cause: err });
  }
  return err;
}

/** Default runner: executes the workflow on the shared Temporal client. */
export function createTemporalRunner(
  getClient: () => Promise<Client> = getTemporalClient,
): RunHotelOffers {
  return async (input, { workflowId }) => {
    let client: Client;
    try {
      client = await getClient();
    } catch (err) {
      // Nothing but connectivity can fail at this stage.
      throw new TemporalUnavailableError('Could not connect to Temporal', { cause: err });
    }

    try {
      // start + result instead of execute(): an already-connected client retries
      // UNAVAILABLE for ~20s by default, so bound the start RPC with a deadline
      // to fail fast when Temporal goes away. result() is not bounded here; the
      // 30s workflowExecutionTimeout caps it.
      const handle = await client.withDeadline(Date.now() + START_DEADLINE_MS, () =>
        client.workflow.start<typeof hotelOffersWorkflow>(HOTEL_OFFERS_WORKFLOW, {
          taskQueue: config.temporalTaskQueue,
          workflowId,
          args: [input],
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        }),
      );
      return await handle.result();
    } catch (err) {
      throw classifyTemporalError(err);
    }
  };
}
