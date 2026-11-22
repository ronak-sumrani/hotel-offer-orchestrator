import {
  ApplicationFailure,
  ServiceError,
  TimeoutFailure,
  WorkflowFailedError,
} from '@temporalio/client';
import { RetryState, TimeoutType } from '@temporalio/common';
import { describe, expect, it } from 'vitest';
import {
  AllSuppliersFailedError,
  classifyTemporalError,
  createTemporalRunner,
  TemporalUnavailableError,
  WorkflowTimeoutError,
} from '../src/temporal/runner';

/** Minimal stand-in for a @grpc/grpc-js ServiceError. */
function grpcError(code: number): Error {
  return Object.assign(new Error(`grpc ${code}`), { code, details: 'x', metadata: {} });
}

describe('classifyTemporalError', () => {
  it('AllSuppliersFailed ApplicationFailure → AllSuppliersFailedError', () => {
    const err = new WorkflowFailedError(
      'Workflow execution failed',
      ApplicationFailure.create({ type: 'AllSuppliersFailed', message: 'all failed', nonRetryable: true }),
      RetryState.NON_RETRYABLE_FAILURE,
    );
    expect(classifyTemporalError(err)).toBeInstanceOf(AllSuppliersFailedError);
  });

  it('TimeoutFailure → WorkflowTimeoutError', () => {
    const err = new WorkflowFailedError(
      'Workflow execution timed out',
      new TimeoutFailure('Workflow execution timed out', undefined, TimeoutType.START_TO_CLOSE),
      RetryState.TIMEOUT,
    );
    expect(classifyTemporalError(err)).toBeInstanceOf(WorkflowTimeoutError);
  });

  it('ServiceError caused by gRPC UNAVAILABLE → TemporalUnavailableError', () => {
    const err = new ServiceError('Failed to start Workflow', { cause: grpcError(14) });
    expect(classifyTemporalError(err)).toBeInstanceOf(TemporalUnavailableError);
  });

  it('other failures are returned unchanged', () => {
    const other = new WorkflowFailedError(
      'Workflow execution failed',
      ApplicationFailure.create({ type: 'SomethingElse', message: 'nope' }),
      RetryState.NON_RETRYABLE_FAILURE,
    );
    expect(classifyTemporalError(other)).toBe(other);

    const invalidArg = new ServiceError('bad request', { cause: grpcError(3) });
    expect(classifyTemporalError(invalidArg)).toBe(invalidArg);
  });
});

describe('createTemporalRunner', () => {
  it('connection failure → TemporalUnavailableError', async () => {
    const run = createTemporalRunner(() => Promise.reject(new Error('Failed to connect before the deadline')));
    await expect(run({ city: 'delhi' }, { workflowId: 'w' })).rejects.toBeInstanceOf(TemporalUnavailableError);
  });
});
