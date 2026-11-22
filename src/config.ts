import { existsSync } from 'node:fs';
import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** "true" or "1" → true; anything else (including unset) → false. */
const booleanFlag = z
  .string()
  .optional()
  .transform((value) => value === 'true' || value === '1');

const positiveInt = z.coerce.number().int().positive();

const envSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    REDIS_URL: z.url().default('redis://localhost:6379'),
    TEMPORAL_ADDRESS: z.string().min(1).default('localhost:7233'),
    TEMPORAL_NAMESPACE: z.string().min(1).default('default'),
    TEMPORAL_TASK_QUEUE: z.string().min(1).default('hotel-offers'),
    SUPPLIER_BASE_URL: z
      .url()
      .default('http://localhost:3000')
      .transform((url) => url.replace(/\/+$/, '')),
    CACHE_TTL_SECONDS: positiveInt.default(300),
    PARTIAL_CACHE_TTL_SECONDS: positiveInt.default(30),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    SUPPLIER_A_DOWN: booleanFlag,
    SUPPLIER_B_DOWN: booleanFlag,
  })
  .superRefine((env, ctx) => {
    if (env.PARTIAL_CACHE_TTL_SECONDS > env.CACHE_TTL_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        path: ['PARTIAL_CACHE_TTL_SECONDS'],
        message: 'PARTIAL_CACHE_TTL_SECONDS must be <= CACHE_TTL_SECONDS',
      });
    }
  });

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  port: number;
  redisUrl: string;
  temporalAddress: string;
  temporalNamespace: string;
  temporalTaskQueue: string;
  supplierBaseUrl: string;
  cacheTtlSeconds: number;
  partialCacheTtlSeconds: number;
  logLevel: LogLevel;
  supplierADown: boolean;
  supplierBDown: boolean;
}

/**
 * Parses and validates an environment object. Pure: does not read process.env
 * or the filesystem. Empty-string values are treated as unset so defaults apply.
 * Throws an Error listing every problem when validation fails.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Readonly<Config> {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ''),
  );

  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }

  const e = result.data;
  return Object.freeze({
    port: e.PORT,
    redisUrl: e.REDIS_URL,
    temporalAddress: e.TEMPORAL_ADDRESS,
    temporalNamespace: e.TEMPORAL_NAMESPACE,
    temporalTaskQueue: e.TEMPORAL_TASK_QUEUE,
    supplierBaseUrl: e.SUPPLIER_BASE_URL,
    cacheTtlSeconds: e.CACHE_TTL_SECONDS,
    partialCacheTtlSeconds: e.PARTIAL_CACHE_TTL_SECONDS,
    logLevel: e.LOG_LEVEL,
    supplierADown: e.SUPPLIER_A_DOWN,
    supplierBDown: e.SUPPLIER_B_DOWN,
  });
}

// Load a local .env if present. Variables already set in the environment win.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export const config = loadConfig(process.env);
