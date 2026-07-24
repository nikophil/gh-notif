// Detection of approvals on my PRs (pure logic, no I/O). The `reviews` are
// already fetched by GraphQL (cf. github.js) → zero cost in requests.

// Threshold from which a PR is « ready to merge » (🎉 badge + notif suffix).
export const READY_THRESHOLD = 2;

export function isReady(count) {
  return (count || 0) >= READY_THRESHOLD;
}

// Reviewers whose LATEST review is APPROVED (like the GitHub UI): we keep
// `{login, submittedAt}` of that latest review. An approval cancelled by a later
// review (CHANGES_REQUESTED…) from the same user no longer counts. Mirror of
// countApprovals (collect.js), which becomes approvalsOf(reviews).length.
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

// Reviewers whose LATEST review is CHANGES_REQUESTED (mirror of approvalsOf).
// A user who requested changes then later approved no longer counts (only the
// latest review of each user is decisive, like the GitHub UI). Consumed by the
// « changes requested » indicator of the ✅ column (html.js), zero cost.
export function changesRequestedOf(reviews) {
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
    if ((r.state || '').toUpperCase() === 'CHANGES_REQUESTED') out.push({ login: r.author.login, submittedAt: r.submittedAt });
  }
  return out;
}

// Dedup key of an approval (no review id in GraphQL → login+date).
export function approvalKey(repo, number, login, submittedAt) {
  return `${repo}#${number}:${login}:${submittedAt}`;
}

// Approval events absent from `seen` (Set of keys). Does NOT mutate `seen`:
// the caller decides whether to prime silently (1st poll) or to notify + mark.
export function newApprovals(events, seen) {
  return events.filter((e) => !seen.has(approvalKey(e.repo, e.number, e.actor, e.submittedAt)));
}

// Processes the approvals of a poll. On the 1st poll (`primed` false): SILENT
// priming — we memorize everything in `seen`, nothing is returned (no burst of
// notifs at startup, cf. approach A / spec). On subsequent polls: returns the
// new events (to notify) and memorizes them. Mutates `seen`.
export function diffApprovals({ events = [], seen, primed }) {
  const fresh = primed ? newApprovals(events, seen) : [];
  for (const e of events) seen.add(approvalKey(e.repo, e.number, e.actor, e.submittedAt));
  return fresh;
}
