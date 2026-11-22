/**
 * Starts hotelOffersWorkflow from the CLI and prints the result.
 *   npm run workflow:run -- delhi
 * Requires Temporal (compose), the API (mock suppliers) and the worker running.
 */
import { randomUUID } from 'node:crypto';
import { ApplicationFailure, WorkflowFailedError } from '@temporalio/client';
import { config } from '../src/config';
import { closeTemporalClient, getTemporalClient } from '../src/temporal/client';
import type { hotelOffersWorkflow } from '../src/temporal/workflows';

async function main(): Promise<number> {
  const city = (process.argv[2] ?? '').trim().toLowerCase();
  if (city === '') {
    console.error('Usage: npm run workflow:run -- <city>');
    return 2;
  }

  const client = await getTemporalClient();
  const workflowId = `hotel-offers-${city}-${randomUUID()}`;
  console.log(`workflowId: ${workflowId}`);

  try {
    const result = await client.workflow.execute<typeof hotelOffersWorkflow>('hotelOffersWorkflow', {
      taskQueue: config.temporalTaskQueue,
      workflowId,
      args: [{ city }],
      workflowExecutionTimeout: '30s',
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (err) {
    if (err instanceof WorkflowFailedError) {
      const cause = err.cause;
      const type = cause instanceof ApplicationFailure ? cause.type : cause?.name;
      console.error(`Workflow failed: ${type ?? 'unknown'}: ${cause?.message ?? err.message}`);
      if (cause instanceof ApplicationFailure && cause.details?.length) {
        console.error(`details: ${JSON.stringify(cause.details[0])}`);
      }
      return 1;
    }
    throw err;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeTemporalClient());
