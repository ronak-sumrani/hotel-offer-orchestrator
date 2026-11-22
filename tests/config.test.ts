import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('applies defaults when nothing is set', () => {
    expect(loadConfig({})).toEqual({
      port: 3000,
      redisUrl: 'redis://localhost:6379',
      temporalAddress: 'localhost:7233',
      temporalNamespace: 'default',
      temporalTaskQueue: 'hotel-offers',
      supplierBaseUrl: 'http://localhost:3000',
      cacheTtlSeconds: 300,
      partialCacheTtlSeconds: 30,
      logLevel: 'info',
      supplierADown: false,
      supplierBDown: false,
    });
  });

  it('treats empty strings as unset', () => {
    const cfg = loadConfig({ PORT: '', REDIS_URL: '', CACHE_TTL_SECONDS: '  ', LOG_LEVEL: '' });
    expect(cfg.port).toBe(3000);
    expect(cfg.redisUrl).toBe('redis://localhost:6379');
    expect(cfg.cacheTtlSeconds).toBe(300);
    expect(cfg.logLevel).toBe('info');
  });

  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
    ['yes', false],
    ['TRUE', false],
  ])('SUPPLIER_X_DOWN=%s → %s', (value, expected) => {
    const cfg = loadConfig({ SUPPLIER_A_DOWN: value, SUPPLIER_B_DOWN: value });
    expect(cfg.supplierADown).toBe(expected);
    expect(cfg.supplierBDown).toBe(expected);
  });

  it.each(['abc', '0', '70000', '3000.5', '-1'])('rejects invalid PORT=%s', (port) => {
    expect(() => loadConfig({ PORT: port })).toThrow(/PORT/);
  });

  it('rejects PARTIAL_CACHE_TTL_SECONDS > CACHE_TTL_SECONDS', () => {
    expect(() =>
      loadConfig({ CACHE_TTL_SECONDS: '60', PARTIAL_CACHE_TTL_SECONDS: '120' }),
    ).toThrow(/PARTIAL_CACHE_TTL_SECONDS/);
  });
});
