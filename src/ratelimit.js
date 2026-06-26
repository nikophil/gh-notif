// Détection du rate-limit GitHub et calcul du backoff. Fonctions pures (le
// message d'erreur vient de `gh` via child_process), testées sur fixtures.

const RATE_LIMIT_PATTERNS = [
  'rate limit',
  'secondary rate',
  'abuse',
  '403',
  '429',
];

// Vrai si le message d'erreur `gh` ressemble à un dépassement de quota (primaire
// ou secondaire / abuse) ou à un 403/429. Insensible à la casse.
export function isRateLimitError(message) {
  if (!message) return false;
  const m = String(message).toLowerCase();
  return RATE_LIMIT_PATTERNS.some((p) => m.includes(p));
}

// Prochain backoff (en secondes) : 0 → `baseInterval`, sinon double, plafonné à
// `cap`. Sert à reculer le prochain poll quand on est rate-limité.
export function nextBackoffSeconds(currentBackoff, baseInterval, cap) {
  if (!currentBackoff) return baseInterval;
  return Math.min(currentBackoff * 2, cap);
}
