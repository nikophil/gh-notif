// GitHub rate-limit detection and backoff computation. Pure functions (the
// error message comes from `gh` via child_process), tested on fixtures.

const RATE_LIMIT_PATTERNS = [
  'rate limit',
  'secondary rate',
  'abuse',
  '403',
  '429',
];

// True if the `gh` error message looks like a quota overrun (primary or
// secondary / abuse) or a 403/429. Case-insensitive.
export function isRateLimitError(message) {
  if (!message) return false;
  const m = String(message).toLowerCase();
  return RATE_LIMIT_PATTERNS.some((p) => m.includes(p));
}

// Next backoff (in seconds): 0 → `baseInterval`, otherwise double, capped at
// `cap`. Used to push back the next poll when we are rate-limited.
export function nextBackoffSeconds(currentBackoff, baseInterval, cap) {
  if (!currentBackoff) return baseInterval;
  return Math.min(currentBackoff * 2, cap);
}
