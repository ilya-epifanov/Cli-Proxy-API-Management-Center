import { isRecord } from '@/utils/helpers';

/**
 * A Management API response that does not match the contract the panel was built against.
 * Parsers throw it instead of guessing, so a backend change surfaces as a visible error.
 */
export class ResponseShapeError extends Error {
  constructor(
    readonly endpoint: string,
    readonly path: string,
    readonly expected: string
  ) {
    super(`Unexpected response from ${endpoint}: ${path} should be ${expected}`);
    this.name = 'ResponseShapeError';
  }
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Field readers bound to one endpoint, so every error names where it came from. */
export class ShapeReader {
  constructor(readonly endpoint: string) {}

  fail(path: string, expected: string): never {
    throw new ResponseShapeError(this.endpoint, path, expected);
  }

  record(value: unknown, path: string): Record<string, unknown> {
    return isRecord(value) ? value : this.fail(path, 'an object');
  }

  array(value: unknown, path: string): unknown[] {
    return Array.isArray(value) ? value : this.fail(path, 'an array');
  }

  string(value: unknown, path: string): string {
    return typeof value === 'string' ? value : this.fail(path, 'a string');
  }

  boolean(value: unknown, path: string): boolean {
    return typeof value === 'boolean' ? value : this.fail(path, 'a boolean');
  }

  /** A non-negative safe integer, as every counter in the Management API is. */
  count(value: unknown, path: string): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? value
      : this.fail(path, 'a non-negative integer');
  }

  /** An RFC 3339 timestamp, returned as epoch milliseconds. */
  instant(value: unknown, path: string): number {
    const text = this.string(value, path);
    const ms = RFC3339.test(text) ? Date.parse(text) : Number.NaN;
    return Number.isFinite(ms) ? ms : this.fail(path, 'an RFC 3339 timestamp');
  }

  oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
    return typeof value === 'string' && (allowed as readonly string[]).includes(value)
      ? (value as T)
      : this.fail(path, `one of ${allowed.join(', ')}`);
  }
}
