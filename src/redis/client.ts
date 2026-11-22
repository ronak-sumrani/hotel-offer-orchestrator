/**
 * ioredis clients, configured to fail fast: when Redis is down, commands
 * reject immediately instead of queueing, so HTTP requests never hang on it.
 * The client keeps reconnecting in the background and recovers on its own.
 */
import { Redis } from 'ioredis';
import { config } from '../config';
import { createLogger, type Logger } from '../logger';

const QUIT_TIMEOUT_MS = 1_000;

export interface RedisClientOptions {
  /** Connection name (CLIENT SETNAME) and logger tag, e.g. "api" or "worker". */
  name: string;
  /** Per-command timeout. */
  commandTimeoutMs: number;
  /** Default: config.redisUrl. */
  url?: string;
  /** Default: a child logger tagged with the name. */
  log?: Logger;
}

export function createRedisClient(opts: RedisClientOptions): Redis {
  const log = opts.log ?? createLogger(opts.name).child({ component: 'redis' });

  const client = new Redis(opts.url ?? config.redisUrl, {
    connectionName: opts.name,
    // ioredis v6 defaults to RESP3 (HELLO 3), which fails to connect to Redis < 6
    // and gains us nothing. RESP2 keeps reply shapes identical to ioredis v5.
    protocol: 2,
    // Reject commands while disconnected instead of queueing them (no hanging requests).
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: opts.commandTimeoutMs,
    // Keep reconnecting forever, at most every 2s.
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });

  // Log the first error of an outage at warn, then stay quiet until the next "ready".
  let outageLogged = false;
  client.on('ready', () => {
    outageLogged = false;
    log.info('redis ready');
  });
  client.on('error', (err: Error) => {
    if (outageLogged) {
      log.debug({ err: err.message }, 'redis error');
      return;
    }
    outageLogged = true;
    log.warn({ err: err.message }, 'redis error');
  });
  client.on('reconnecting', (delayMs: number) => log.debug({ delayMs }, 'redis reconnecting'));
  client.on('end', () => log.debug('redis connection ended'));

  return client;
}

/** QUIT (waits for pending replies), falling back to a hard disconnect. */
export async function closeRedisClient(client: Redis): Promise<void> {
  if (client.status === 'end') return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.quit(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('quit timed out')), QUIT_TIMEOUT_MS);
      }),
    ]);
  } catch {
    client.disconnect();
  } finally {
    clearTimeout(timer);
  }
}

function lazySingleton(options: RedisClientOptions) {
  let client: Redis | undefined;
  return {
    get(): Redis {
      client ??= createRedisClient(options);
      return client;
    },
    async close(): Promise<void> {
      const current = client;
      client = undefined;
      if (current) await closeRedisClient(current);
    },
  };
}

const apiRedis = lazySingleton({ name: 'api', commandTimeoutMs: 500 });
const workerRedis = lazySingleton({ name: 'worker', commandTimeoutMs: 1_000 });

/** Shared client for the API process. Created (and connected) on first use. */
export const getApiRedis = (): Redis => apiRedis.get();
export const closeApiRedis = (): Promise<void> => apiRedis.close();

/** Shared client for the worker's activities. Created (and connected) on first use. */
export const getWorkerRedis = (): Redis => workerRedis.get();
export const closeWorkerRedis = (): Promise<void> => workerRedis.close();
