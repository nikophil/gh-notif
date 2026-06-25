import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectNotifications, collectPending, collectPRs, ciFromState, prState, countApprovals, scopeMatches, scopeQualifier } from '../src/collect.js';

const ME = 'nikophil';

function fakeGh(over = {}) {
  return {
    async getCurrentUser() { return ME; },
    async listNotifications() { return over.notifications ?? []; },
    async getComment() { return over.comment ?? null; },
    async getReviewComments() { return over.reviewComments ?? []; },
    async searchReviewRequested() { return over.search ?? []; },
    async searchAuthored() { return over.authored ?? []; },
    async getPullDetailsBatch(prs) { return prs.map(({ repo, number }) => over.details?.(repo, number) ?? null); },
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
test('ciFromState: SUCCESS→pass, FAILURE/ERROR→fail, PENDING/EXPECTED→pending, null→none', () => {
  assert.equal(ciFromState(null), 'none');
  assert.equal(ciFromState(undefined), 'none');
  assert.equal(ciFromState('SUCCESS'), 'pass');
  assert.equal(ciFromState('FAILURE'), 'fail');
  assert.equal(ciFromState('ERROR'), 'fail');
  assert.equal(ciFromState('PENDING'), 'pending');
  assert.equal(ciFromState('EXPECTED'), 'pending');
});

test('countApprovals : users distincts dont la dernière review est APPROVED', () => {
  assert.equal(countApprovals(undefined), 0);
  assert.equal(countApprovals([]), 0);
  // alice approuve, bob commente → 1 approbation
  assert.equal(countApprovals([
    { author: { login: 'alice' }, state: 'APPROVED', submittedAt: '2026-06-20T10:00:00Z' },
    { author: { login: 'bob' }, state: 'COMMENTED', submittedAt: '2026-06-20T11:00:00Z' },
  ]), 1);
  // alice approuve puis redemande des changements → ne compte plus
  assert.equal(countApprovals([
    { author: { login: 'alice' }, state: 'APPROVED', submittedAt: '2026-06-20T10:00:00Z' },
    { author: { login: 'alice' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-06-21T10:00:00Z' },
  ]), 0);
  // deux approbations du même user → comptées une fois
  assert.equal(countApprovals([
    { author: { login: 'alice' }, state: 'APPROVED', submittedAt: '2026-06-20T10:00:00Z' },
    { author: { login: 'alice' }, state: 'APPROVED', submittedAt: '2026-06-21T10:00:00Z' },
    { author: { login: 'bob' }, state: 'APPROVED', submittedAt: '2026-06-21T12:00:00Z' },
  ]), 2);
});

test('prState : draft > merged > closed > open', () => {
  assert.equal(prState({ isDraft: true, state: 'OPEN' }), 'draft');
  assert.equal(prState({ state: 'MERGED' }), 'merged');
  assert.equal(prState({ state: 'CLOSED' }), 'closed');
  assert.equal(prState({ state: 'OPEN' }), 'open');
  assert.equal(prState(null), 'open');
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
      if (repo === 'o/r' && number === 42) return { number: 42, title: 'PR A', author: { login: 'alice' }, createdAt: '2026-06-21T12:00:00Z', additions: 10, deletions: 2, statusCheckRollupState: 'SUCCESS' };
      if (repo === 'o/x' && number === 7) return { number: 7, title: 'Ma PR', author: { login: ME }, createdAt: '2026-06-23T12:00:00Z', additions: 1, deletions: 0, statusCheckRollupState: null };
      return null;
    },
  });
  const { mine, others, notifications } = await collectPRs(gh, ME, {});

  // notifications : items de notification classifiés, exposés pour --watch.
  assert.ok(Array.isArray(notifications));
  assert.equal(notifications.length, 3); // review_request + mention (o/r#42) + author (o/x#7)

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
  assert.equal(mine[0].url, 'h'); // « commentaire sur ma PR » → lien vers le commentaire
});

test('collectPRs: le lien d’une réponse en thread pointe sur le commentaire', async () => {
  const thread = {
    id: 't1', reason: 'subscribed', updated_at: '2026-06-24T12:00:00Z',
    subject: { title: 'PR R', url: 'https://api.github.com/repos/o/r/pulls/50', latest_comment_url: null, type: 'PullRequest' },
    repository: { full_name: 'o/r' },
  };
  const gh = fakeGh({
    notifications: [thread],
    reviewComments: [
      { id: 1, user: { login: ME }, created_at: '2026-06-24T10:00:00Z', html_url: 'mine' },
      { id: 2, in_reply_to_id: 1, user: { login: 'bob' }, created_at: '2026-06-24T11:00:00Z', html_url: 'https://github.com/o/r/pull/50#discussion_r2' },
    ],
    details: () => ({ number: 50, title: 'PR R', author: { login: 'bob' }, createdAt: '2026-06-20T12:00:00Z', additions: 1, deletions: 1, statusCheckRollupState: 'SUCCESS' }),
  });
  const { others } = await collectPRs(gh, ME, {});
  assert.equal(others.length, 1);
  assert.deepEqual(others[0].triggers, ['reply']);
  assert.equal(others[0].url, 'https://github.com/o/r/pull/50#discussion_r2');
});

test('collectPRs: une review en attente (sans commentaire) garde le lien vers la PR', async () => {
  const gh = fakeGh({
    search: [{ number: 60, title: 'À review', html_url: 'https://github.com/o/r/pull/60', updated_at: '2026-06-20T09:00:00Z', repository_url: 'https://api.github.com/repos/o/r' }],
    details: () => ({ number: 60, title: 'À review', author: { login: 'carol' }, createdAt: '2026-06-19T09:00:00Z', additions: 1, deletions: 1, statusCheckRollupState: 'SUCCESS' }),
  });
  const { others } = await collectPRs(gh, ME, {});
  assert.equal(others[0].url, 'https://github.com/o/r/pull/60'); // lien PR (pas de commentaire)
});

test('collectPRs: une PR ouverte que j’ai écrite (sans activité) apparaît dans mine, triggers vides', async () => {
  const gh = fakeGh({
    notifications: [],
    authored: [{ number: 20, title: 'Ma PR sans activité', html_url: 'https://github.com/o/x/pull/20', repository_url: 'https://api.github.com/repos/o/x' }],
    details: () => ({ number: 20, title: 'Ma PR sans activité', author: { login: ME }, createdAt: '2026-06-22T12:00:00Z', additions: 5, deletions: 1, statusCheckRollupState: 'SUCCESS' }),
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
    details: () => ({ number: 42, title: 'PR A', author: { login: 'alice' }, createdAt: '2026-06-21T12:00:00Z', additions: 1, deletions: 0, statusCheckRollupState: null }),
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
    details: () => ({ number: 42, title: 'PR A', author: { login: 'alice' }, createdAt: '2026-06-21T12:00:00Z', additions: 1, deletions: 0, statusCheckRollupState: null }),
  });
  const { others } = await collectPRs(gh, ME, {});
  assert.equal(others.length, 1);
  assert.deepEqual(others[0].triggers, ['reply']);
});

test('collectPRs: PR mergée, review demandée, AUCUNE réponse à mon fil → ignorée', async () => {
  // Règle : review demandée + pas de réponse à mon fil + PR mergée ⇒ rien.
  // (#7027 réel : mergée, j'avais commenté mais personne ne m'a répondu.)
  // L'état mergé n'a pas à être interrogé : pas en attente (search vide) +
  // item review_requested ignoré ⇒ aucune ligne.
  const gh = fakeGh({
    notifications: [reviewReqThread], // o/r#42, reason review_requested collant
    search: [],                        // mergée donc absente de review-requested:@me (is:open)
    reviewComments: [
      { id: 1, user: { login: 'bjulien' }, created_at: '2026-06-23T09:00:00Z', html_url: 'root' },
      { id: 2, in_reply_to_id: 1, user: { login: ME }, created_at: '2026-06-23T12:00:00Z', html_url: 'mine' },
    ], // j'ai répondu à bjulien, mais personne après moi
    details: () => ({ number: 42, title: 'PR A', author: { login: 'alice' }, createdAt: '2026-06-21T12:00:00Z', additions: 1, deletions: 0, statusCheckRollupState: null }),
  });
  const { mine, others } = await collectPRs(gh, ME, {});
  assert.equal(mine.length, 0);
  assert.equal(others.length, 0);
});

test('collectPRs: PR mergée mais réponse à mon fil → reste visible (trigger reply)', async () => {
  // Règle : si on m'a répondu, la notif reste visible même PR mergée.
  // getPullDetails ne renvoie pas l'état merged → l'état mergé est invisible
  // pour la logique : seule la présence d'une réponse compte.
  const gh = fakeGh({
    notifications: [reviewReqThread], // o/r#42
    search: [],                        // mergée
    reviewComments: [
      { id: 1, user: { login: ME }, created_at: '2026-06-23T09:00:00Z', html_url: 'mine' },
      { id: 2, in_reply_to_id: 1, user: { login: 'alice' }, created_at: '2026-06-23T12:00:00Z', html_url: 'https://github.com/o/r/pull/42#discussion_rX' },
    ], // alice m'a répondu après mon commentaire
    details: () => ({ number: 42, title: 'PR A', author: { login: 'alice' }, createdAt: '2026-06-21T12:00:00Z', additions: 1, deletions: 0, statusCheckRollupState: null }),
  });
  const { others } = await collectPRs(gh, ME, {});
  assert.equal(others.length, 1);
  assert.deepEqual(others[0].triggers, ['reply']);
});

test('collectPRs: une review en attente non vue ajoute une PR « autres » avec trigger review', async () => {
  const gh = fakeGh({
    notifications: [],
    search: [{ number: 98, title: 'À review', html_url: 'https://github.com/o/r/pull/98', updated_at: '2026-06-20T09:00:00Z', repository_url: 'https://api.github.com/repos/o/r' }],
    details: () => ({ number: 98, title: 'À review', author: { login: 'carol' }, createdAt: '2026-06-19T09:00:00Z', additions: 3, deletions: 3, statusCheckRollupState: 'PENDING', state: 'OPEN', isDraft: false, reviews: [
      { author: { login: 'dan' }, state: 'APPROVED', submittedAt: '2026-06-20T10:00:00Z' },
      { author: { login: 'eve' }, state: 'COMMENTED', submittedAt: '2026-06-20T11:00:00Z' },
    ] }),
  });
  const { mine, others } = await collectPRs(gh, ME, {});
  assert.equal(mine.length, 0);
  assert.equal(others.length, 1);
  assert.deepEqual(others[0].triggers, ['review']);
  assert.equal(others[0].ci, 'pending');
  assert.equal(others[0].state, 'open');
  assert.equal(others[0].approvals, 1);
});
