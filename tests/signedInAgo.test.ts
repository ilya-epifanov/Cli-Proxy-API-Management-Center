import { describe, expect, test } from 'bun:test';
import { formatSignedInAgo } from '../src/features/authFiles/signedInAgo';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

describe('formatSignedInAgo', () => {
  test('says today for less than a day and for future times', () => {
    expect(formatSignedInAgo(NOW - 3 * 60 * 60 * 1000, NOW, 'en')).toBe('today');
    expect(formatSignedInAgo(NOW + DAY, NOW, 'en')).toBe('today');
  });

  test('counts whole days ago in the given language', () => {
    expect(formatSignedInAgo(NOW - 2 * DAY - 1000, NOW, 'en')).toBe('2 days ago');
    expect(formatSignedInAgo(NOW - 30 * DAY, NOW, 'en')).toBe('30 days ago');
    expect(formatSignedInAgo(NOW - 2 * DAY, NOW, 'ru')).not.toBe('2 days ago');
  });
});
