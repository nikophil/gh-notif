// Détection des approbations sur mes PR (logique pure, sans I/O). Les `reviews`
// sont déjà récupérées par GraphQL (cf. github.js) → coût nul en requêtes.

// Seuil à partir duquel une PR est « prête à merger » (badge 🎉 + suffixe notif).
export const READY_THRESHOLD = 2;

export function isReady(count) {
  return (count || 0) >= READY_THRESHOLD;
}

// Reviewers dont la DERNIÈRE review est APPROVED (comme l'UI GitHub) : on garde
// `{login, submittedAt}` de cette dernière review. Une approbation annulée par une
// review ultérieure (CHANGES_REQUESTED…) du même user ne compte plus. Mirroir de
// countApprovals (collect.js), qui devient approvalsOf(reviews).length.
export function approvalsOf(reviews) {
  if (!Array.isArray(reviews)) return [];
  const latestByUser = new Map();
  for (const r of reviews) {
    const login = r.author?.login;
    if (!login) continue;
    const prev = latestByUser.get(login);
    if (!prev || (r.submittedAt || '') >= (prev.submittedAt || '')) latestByUser.set(login, r);
  }
  const out = [];
  for (const r of latestByUser.values()) {
    if ((r.state || '').toUpperCase() === 'APPROVED') out.push({ login: r.author.login, submittedAt: r.submittedAt });
  }
  return out;
}

// Clé de dédup d'une approbation (pas d'id de review en GraphQL → login+date).
export function approvalKey(repo, number, login, submittedAt) {
  return `${repo}#${number}:${login}:${submittedAt}`;
}

// Évènements d'approbation absents de `seen` (Set de clés). Ne mute PAS `seen` :
// le caller décide d'amorcer silencieusement (1er poll) ou de notifier + marquer.
export function newApprovals(events, seen) {
  return events.filter((e) => !seen.has(approvalKey(e.repo, e.number, e.actor, e.submittedAt)));
}

// Traite les approbations d'un poll. Au 1er poll (`primed` faux) : amorçage
// SILENCIEUX — on mémorise tout dans `seen`, rien n'est renvoyé (pas de rafale de
// notifs au démarrage, cf. approche A / spec). Aux polls suivants : renvoie les
// évènements nouveaux (à notifier) et les mémorise. Mute `seen`.
export function diffApprovals({ events = [], seen, primed }) {
  const fresh = primed ? newApprovals(events, seen) : [];
  for (const e of events) seen.add(approvalKey(e.repo, e.number, e.actor, e.submittedAt));
  return fresh;
}
