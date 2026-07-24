import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRateLimitError, nextBackoffSeconds } from '../src/ratelimit.js';

test('isRateLimitError: detects GitHub rate-limit messages', () => {
  assert.equal(isRateLimitError('API rate limit exceeded for user'), true);
  assert.equal(isRateLimitError('You have exceeded a secondary rate limit'), true);
  assert.equal(isRateLimitError('HTTP 403: Forbidden'), true);
  assert.equal(isRateLimitError('gh: HTTP 429 Too Many Requests'), true);
  assert.equal(isRateLimitError('triggered an abuse detection mechanism'), true);
  assert.equal(isRateLimitError('RATE LIMIT'), true); // case-insensitive
});

test('isRateLimitError: false for other errors', () => {
  assert.equal(isRateLimitError('fatal: not a git repository'), false);
  assert.equal(isRateLimitError('HTTP 404: Not Found'), false);
  assert.equal(isRateLimitError(''), false);
  assert.equal(isRateLimitError(null), false);
  assert.equal(isRateLimitError(undefined), false);
});

test('nextBackoffSeconds: 0 → base, otherwise double, capped', () => {
  assert.equal(nextBackoffSeconds(0, 60, 600), 60);
  assert.equal(nextBackoffSeconds(60, 60, 600), 120);
  assert.equal(nextBackoffSeconds(120, 60, 600), 240);
  assert.equal(nextBackoffSeconds(400, 60, 600), 600); // capped
  assert.equal(nextBackoffSeconds(600, 60, 600), 600); // stays at the cap
});
