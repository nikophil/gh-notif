import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectNotifications, collectPending, collectPRs, ciRollup } from '../src/collect.js';

const ME = 'nikophil';

function fakeGh(over = {}) {
  return {
    async getCurrentUser() { return ME; },
    async listNotifications() { return over.notifications ?? []; },
    async getComment() { return over.comment ?? null; },
    async getReviewComments() { return over.reviewComments ?? []; },
    async searchReviewRequested() { return over.search ?? []; },
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
