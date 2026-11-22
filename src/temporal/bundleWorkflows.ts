/**
 * Build-time script: pre-bundles the workflow code so the worker does not run
 * webpack at every startup. Run via `npm run build` (after tsc):
 *   node dist/temporal/bundleWorkflows.js
 * Writes dist/temporal/workflow-bundle.js, which worker.ts loads when present.
 *
 * Deliberately imports neither config nor the logger: no .env loading, no side effects.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bundleWorkflowCode } from '@temporalio/worker';

export const WORKFLOW_BUNDLE_FILENAME = 'workflow-bundle.js';

async function main(): Promise<void> {
  const startedAt = Date.now();
  const { code } = await bundleWorkflowCode({
    workflowsPath: require.resolve('./workflows'),
  });
  const outPath = path.join(__dirname, WORKFLOW_BUNDLE_FILENAME);
  await writeFile(outPath, code);
  const kb = (Buffer.byteLength(code) / 1024).toFixed(0);
  console.log(`workflow bundle written to ${outPath} (${kb} KiB, ${Date.now() - startedAt} ms)`);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('failed to bundle workflow code', err);
    process.exitCode = 1;
  });
}
