import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ApplicationFailure, WorkflowFailedError } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Runtime, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupplierHotel } from '../src/domain/types';
import type { HotelActivities } from '../src/temporal/activities';
import type { HotelOffersResult } from '../src/temporal/workflows';

// Explicit .ts path: vitest's require.resolve does not resolve .ts extensions.
const workflowsPath = path.join(__dirname, '../src/temporal/workflows.ts');

const A: SupplierHotel[] = [
  { hotelId: 'a1', name: 'Holtin', price: 6000, city: 'delhi', commissionPct: 10 },
  { hotelId: 'a2', name: 'Lemon Tree', price: 3200, city: 'delhi', commissionPct: 8 },
];
const B: SupplierHotel[] = [
  { hotelId: 'b1', name: ' holtin ', price: 5340, city: 'delhi', commissionPct: 20 },
  { hotelId: 'b2', name: 'ITC Maurya', price: 8800, city: 'delhi', commissionPct: 15 },
];

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  // Keep test output quiet (SDK logs WARN for each failed activity attempt).
  // Core is filtered to ERROR: the time-skipping test server triggers a harmless
  // "heartbeat capability" WARN on every worker start.
  Runtime.install({
    logger: { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    telemetryOptions: { logging: { filter: { core: 'ERROR', other: 'ERROR' } } },
  });
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

async function run(activities: HotelActivities): Promise<HotelOffersResult> {
  const taskQueue = `test-${randomUUID()}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath,
    activities,
  });
  return worker.runUntil(
    env.client.workflow.execute('hotelOffersWorkflow', {
      taskQueue,
      workflowId: `test-${randomUUID()}`,
      args: [{ city: 'delhi' }],
      workflowExecutionTimeout: '30s',
    }),
  );
}

describe('hotelOffersWorkflow', () => {
  it('both suppliers succeed → merged, deduped, sorted; no failures', async () => {
    const result = await run({
      fetchSupplierA: async () => A,
      fetchSupplierB: async () => B,
    });
    expect(result).toEqual({
      offers: [
        { name: 'Lemon Tree', price: 3200, supplier: 'Supplier A', commissionPct: 8 },
        { name: 'holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
        { name: 'ITC Maurya', price: 8800, supplier: 'Supplier B', commissionPct: 15 },
      ],
      failedSuppliers: [],
    });
  }, 60_000);

  it('Supplier A fails after 3 attempts → only B offers, failedSuppliers ["Supplier A"]', async () => {
    let attemptsA = 0;
    const result = await run({
      fetchSupplierA: async () => {
        attemptsA += 1;
        throw new Error('Supplier A responded with HTTP 500');
      },
      fetchSupplierB: async () => B,
    });
    expect(attemptsA).toBe(3);
    expect(result).toEqual({
      offers: [
        { name: 'holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
        { name: 'ITC Maurya', price: 8800, supplier: 'Supplier B', commissionPct: 15 },
      ],
      failedSuppliers: ['Supplier A'],
    });
  }, 60_000);

  it('both suppliers fail → workflow fails with AllSuppliersFailed', async () => {
    const fail = async (): Promise<SupplierHotel[]> => {
      throw new Error('HTTP 500');
    };
    const err = await run({ fetchSupplierA: fail, fetchSupplierB: fail }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowFailedError);
    const cause = (err as WorkflowFailedError).cause;
    expect(cause).toBeInstanceOf(ApplicationFailure);
    expect((cause as ApplicationFailure).type).toBe('AllSuppliersFailed');
    expect((cause as ApplicationFailure).nonRetryable).toBe(true);
  }, 60_000);
});
