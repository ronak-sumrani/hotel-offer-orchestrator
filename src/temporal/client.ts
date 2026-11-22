import { Client, Connection } from '@temporalio/client';
import { config } from '../config';

const CONNECT_TIMEOUT = '3s';

let clientPromise: Promise<Client> | undefined;

async function connect(): Promise<Client> {
  // 3s (default 10s) so a request fails fast with 503 when Temporal is down.
  const connection = await Connection.connect({
    address: config.temporalAddress,
    connectTimeout: CONNECT_TIMEOUT,
  });
  return new Client({ connection, namespace: config.temporalNamespace });
}

/**
 * Lazily connects once and returns the shared Temporal client.
 * A failed connection attempt is not cached, so the next call retries.
 */
export function getTemporalClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = connect().catch((err: unknown) => {
      clientPromise = undefined;
      throw err;
    });
  }
  return clientPromise;
}

/** Closes the shared connection (no-op if never connected). */
export async function closeTemporalClient(): Promise<void> {
  const pending = clientPromise;
  clientPromise = undefined;
  if (!pending) return;
  try {
    const client = await pending;
    await client.connection.close();
  } catch {
    // Connection never succeeded; nothing to close.
  }
}
