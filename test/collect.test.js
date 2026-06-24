import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectNotifications, collectPending, collectPRs, ciRollup, scopeMatches, scopeQualifier } from '../src/collect.js';

const ME = 'nikophil';

function fakeGh(over = {}) {
  return {
    async getCurrentUser() { return ME; },
    async listNotifications() { return over.notifications ?? []; },
    async getComment() { return over.comment ?? null; },
    async getReviewComments() { return over.reviewComments ?? []; },
    async searchReviewRequested() { return over.search ?? []; },
    async searchAuthored() { return over.authored ?? []; },
    async getPullDetails(repo, number) { return over.details?.(repo, number) ?? null; },
  };
}

const reviewReqThread = {
  id: 't1', reason: 'review_requested', updated_at: '2026-06-24T12:00:00Z',
  subject: { title: 'PR A', url: 'https://api.github.com/repos/o/r/pulls/42', latest_comment_url: null, type: 'PullRequest' },
  repository: { full_name: 'o/r' },
};

test('collectNotifications garde une review demandée', async () => {
  const items = await collectNotifications(fakeGh({ notifications: [reviewReqThread] }), ME, {});
  assert.equal(items.length, 1);
  assert.equal(items[0].category, 'review_request');
});

test('collectNotifications drop un thread non-PR', async () => {
  const issue = { ...reviewReqThread, subject: { ...reviewReqThread.subject, type: 'Issue' } };
  const items = await collectNotifications(fakeGh({ notifications: [issue] }), ME, {});
  assert.equal(items.length, 0);
});

test('collectPending mappe les items de recherche', async () => {
  const search = [{
    number: 98, title: 'PR à review',
    html_url: 'https://github.com/o/r/pull/98',
    updated_at: '2026-06-20T09:00:00Z',
    repository_url: 'https://api.github.com/repos/o/r',
  }];
  const pending = await collectPending(fakeGh({ search }));
  assert.deepEqual(pending[0], {
    repo: 'o/r', number: 98, title: 'PR à review',
    url: 'https://github.com/o/r/pull/98', updatedAt: '2026-06-20T09:00:00Z',
  });
});

// ── scope ──────────────────────────────────────────────────────────────────
test('scopeMatches: null=tout, org=préfixe, repo=exact', () => {
  assert.equal(scopeMatches(null, 'mapado/ticketing'), true);
  assert.equal(scopeMatches({ type: 'org', value: 'mapado' }, 'mapado/ticketing'), true);
  assert.equal(scopeMatches({ type: 'org', value: 'mapado' }, 'other/repo'), false);
  assert.equal(scopeMatches({ type: 'org', value: 'map' }, 'mapado/x'), false); // pas un simple startsWith de chaîne
  assert.equal(scopeMatches({ type: 'repo', value: 'mapado/ticketing' }, 'mapado/ticketing'), true);
  assert.equal(scopeMatches({ type: 'repo', value: 'mapado/ticketing' }, 'mapado/web'), false);
});

test('scopeQualifier', () => {
  assert.equal(scopeQualifier(null), '');
  assert.equal(scopeQualifier({ type: 'org', value: 'mapado' }), ' org:mapado');
  assert.equal(scopeQualifier({ type: 'repo', value: 'mapado/web' }), ' repo:mapado/web');
});

test('collectNotifications filtre par scope avant inspection', async () => {
  const inScope = reviewReqThread; // o/r
  const outScope = { ...reviewReqThread, id: 't9', repository: { full_name: 'x/y' }, subject: { ...reviewReqThread.subject, url: 'https://api.github.com/repos/x/y/pulls/1' } };
  const items = await collectNotifications(fakeGh({ notifications: [inScope, outScope] }), ME, { scope: { type: 'org', value: 'o' } });
  assert.equal(items.length, 1);
  assert.equal(items[0].repo, 'o/r');
});

// ── ciRollup ─────────────────────────────────────────────────────────────
test('ciRollup: vide → none, échec → fail, en cours → pending, ok → pass', () => {
  assert.equal(ciRollup(undefined), 'none');
  assert.equal(ciRollup([]), 'none');
  assert.equal(ciRollup([{ conclusion: 'SUCCESS', status: 'COMPLETED' }, { conclusion: 'FAILURE', status: 'COMPLETED' }]), 'fail');
  assert.equal(ciRollup([{ state: 'FAILURE' }]), 'fail');
  assert.equal(ciRollup([{ status: 'IN_PROGRESS' }, { conclusion: 'SUCCESS', status: 'COMPLETED' }]), 'pending');
  assert.equal(ciRollup([{ state: 'PENDING' }]), 'pending');
  assert.equal(ciRollup([{ conclusion: 'SUCCESS', status: 'COMPLETED' }, { state: 'SUCCESS' }]), 'pass');
});

// ── collectPRs ─────────────────────────────────────────────────────────────
const reviewReqThread2 = {
  id: 't2', reason: 'mention', updated_at: '2026-06-24T12:00:00Z',
  subject: { title: 'PR A', url: 'https://api.github.com/repos/o/r/pulls/42', latest_comment_url: null, type: 'PullRequest' },
  repository: { full_name: 'o/r' },
};

test('collectPRs: agrège les triggers d’une même PR et sépare mine/others', async () => {
  // o/r#42 a deux notifs (review_requested + mention) ; détails: auteur = autre.
  // o/x#7 est une de mes PR (auteur = ME).
  const myThread = {
    id: 't3', reason: 'author', updated_at: '2026-06-24T12:00:00Z',
    subject: { title: 'Ma PR', url: 'https://api.github.com/repos/o/x/pulls/7', latest_comment_url: 'https://api.github.com/repos/o/x/issues/comments/9', type: 'PullRequest' },
    repository: { full_name: 'o/x' },
  };
  const gh = fakeGh({
    notifications: [reviewReqThread, reviewReqThread2, myThread],
    comment: { user: { login: 'bob' }, html_url: 'h' }, // pour le thread author
    // o/r#42 est aussi en attente de review → le trigger « review » vient de la
    // recherche (source fiable), pas de la notif review_requested collante.
    search: [{ number: 42, title: 'PR A', html_url: 'https://github.com/o/r/pull/42', updated_at: '2026-06-24T12:00:00Z', repository_url: 'https://api.github.com/repos/o/r' }],
    details: (repo, number) => {
      if (repo === 'o/r' && number === 42) return { number: 42, title: 'PR A', author: { login: 'alice' }, createdAt: '2026-06-21T12:00:00Z', additions: 10, deletions: 2, statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }] };
      if (repo === 'o/x' && number === 7) return { number: 7, title: 'Ma PR', author: { login: ME }, createdAt: '2026-06-23T12:00:00Z', additions: 1, deletions: 0, statusCheckRollup: [] };
      return null;
    },
  });
  const { mine, others } = await collectPRs(gh, ME, {});

  assert.equal(others.length, 1);
  assert.equal(others[0].repo, 'o/r');
  assert.deepEqual([...others[0].triggers].sort(), ['mention', 'review']);
  assert.equal(others[0].author, 'alice');
  assert.equal(others[0].ci, 'pass');
  assert.equal(others[0].additions, 10);

  assert.equal(mine.length, 1);
  assert.equal(mine[0].repo, 'o/x');
  assert.deepEqual(mine[0].triggers, ['comment']);
  assert.equal(mine[0].ci, 'none');
});

test('collectPRs: une PR ouverte que j’ai écrite (sans activité) apparaît dans mine, triggers vides', async () => {
  const gh = fakeGh({
    notifications: [],
    authored: [{ number: 20, title: 'Ma PR sans activité', html_url: 'https://github.com/o/x/pull/20', repository_url: 'https://api.github.com/repos/o/x' }],
    details: () => ({ number: 20, title: 'Ma PR sans activité', author: { login: ME }, createdAt: '2026-06-22T12:00:00Z', additions: 5, deletions: 1, statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }] }),
  });
  const { mine, others } = await collectPRs(gh, ME, {});
  assert.equal(others.length, 0);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].repo, 'o/x');
  assert.deepEqual(mine[0].triggers, []);
  assert.equal(mine[0].ci, 'pass');
});

test('collectPRs: notif review_requested collante mais déjà review (absente du search, sans réponse) → ignorée', async () => {
  // Régression #7036 : la notif garde reason=review_requested à vie. Comme la PR
  // n'est plus dans review-requested:@me (déjà review) et qu'aucune réponse ne vise
  // mon fil, elle ne doit produire AUCUNE ligne (ni « review », ni autre).
  const gh = fakeGh({
    notifications: [reviewReqThread], // o/r#42, reason review_requested
    search: [],                        // plus en attente
    reviewComments: [],                // aucune réponse à mon fil
    details: () => ({ number: 42, title: 'PR A', author: { login: 'alice' }, createdAt: '2026-06-21T12:00:00Z', additions: 1, deletions: 0, statusCheckRollup: [] }),
  });
  const { mine, others } = await collectPRs(gh, ME, {});
  assert.equal(mine.length, 0);
  assert.equal(others.length, 0);
});

test('collectPRs: notif review_requested collante AVEC réponse à mon fil → ligne « reply » (pas « review »)', async () => {
  const gh = fakeGh({
    notifications: [reviewReqThread], // o/r#42, reason review_requested
    search: [],                        // plus en attente
    reviewComments: [
      { id: 1, user: { login: ME }, created_at: '2026-06-24T10:00:00Z', html_url: 'mine' },
      { id: 2, in_reply_to_id: 1, user: { login: 'alice' }, created_at: '2026-06-24T11:00:00Z', html_url: 'https://github.com/o/r/pull/42#discussion_r2' },
    ],
    details: () => ({ number: 42, title: 'PR A', author: { login: 'alice' }, createdAt: '2026-06-21T12:00:00Z', additions: 1, deletions: 0, statusCheckRollup: [] }),
  });
  const { others } = await collectPRs(gh, ME, {});
  assert.equal(others.length, 1);
  assert.deepEqual(others[0].triggers, ['reply']);
});

test('collectPRs: une review en attente non vue ajoute une PR « autres » avec trigger review', async () => {
  const gh = fakeGh({
    notifications: [],
    search: [{ number: 98, title: 'À review', html_url: 'https://github.com/o/r/pull/98', updated_at: '2026-06-20T09:00:00Z', repository_url: 'https://api.github.com/repos/o/r' }],
    details: () => ({ number: 98, title: 'À review', author: { login: 'carol' }, createdAt: '2026-06-19T09:00:00Z', additions: 3, deletions: 3, statusCheckRollup: [{ status: 'IN_PROGRESS' }] }),
  });
  const { mine, others } = await collectPRs(gh, ME, {});
  assert.equal(mine.length, 0);
  assert.equal(others.length, 1);
  assert.deepEqual(others[0].triggers, ['review']);
  assert.equal(others[0].ci, 'pending');
});
