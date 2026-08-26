import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectNotifications, collectPending, collectPRs, diffByType, ciFromState, ciFromChecks, ciOf, recomputeCi, prState, countApprovals, scopeMatches, scopeQualifier, toScopeList, matchesAnyScope, scopesQualifier, mergeReviewComments, watermarkOf } from '../src/collect.js';

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

test('collectNotifications keeps a requested review', async () => {
  const items = await collectNotifications(fakeGh({ notifications: [reviewReqThread] }), ME, {});
  assert.equal(items.length, 1);
  assert.equal(items[0].category, 'review_request');
});

test('collectNotifications drops a non-PR thread', async () => {
  const issue = { ...reviewReqThread, subject: { ...reviewReqThread.subject, type: 'Issue' } };
  const items = await collectNotifications(fakeGh({ notifications: [issue] }), ME, {});
  assert.equal(items.length, 0);
});

// ── Auto-purge (mark noise threads as read on GitHub) ─────────────────────

// A `reason: comment` thread with no comment at all → classifyVerdict drops it
// (« no reply to your thread → noise »).
const noiseThread = {
  ...reviewReqThread,
  id: 'tn', reason: 'comment',
  subject: { ...reviewReqThread.subject, latest_comment_url: null },
};

function purgingGh(over = {}) {
  const purged = [];
  const gh = { ...fakeGh(over), async markThreadRead(id) { purged.push(id); } };
  return { gh, purged };
}

test('auto-purge: a noise verdict marks the thread as read', async () => {
  const { gh, purged } = purgingGh({ notifications: [noiseThread] });
  const items = await collectNotifications(gh, ME, {});
  assert.equal(items.length, 0);
  assert.deepEqual(purged, ['tn']);
});

test('auto-purge: a kept item is never marked as read', async () => {
  const { gh, purged } = purgingGh({ notifications: [reviewReqThread] });
  const items = await collectNotifications(gh, ME, {});
  assert.equal(items.length, 1);
  assert.deepEqual(purged, []);
});

test('auto-purge: a failed inspection is not noise → no purge', async () => {
  const { gh, purged } = purgingGh({ notifications: [noiseThread] });
  gh.getReviewComments = async () => { throw new Error('network'); };
  await collectNotifications(gh, ME, {});
  assert.deepEqual(purged, []);
});

test('auto-purge: threads filtered before classification are not purged', async () => {
  const issue = { ...noiseThread, id: 'ti', subject: { ...noiseThread.subject, type: 'Issue' } };
  const { gh, purged } = purgingGh({ notifications: [issue] });
  await collectNotifications(gh, ME, {});
  assert.deepEqual(purged, []);
});

test('auto-purge: a failing PATCH does not break the collection', async () => {
  const gh = {
    ...fakeGh({ notifications: [noiseThread, reviewReqThread] }),
    async markThreadRead() { throw new Error('rate limit'); },
  };
  const items = await collectNotifications(gh, ME, {});
  assert.equal(items.length, 1);
});

test('auto-purge: a gh stub without markThreadRead still works', async () => {
  const items = await collectNotifications(fakeGh({ notifications: [noiseThread] }), ME, {});
  assert.equal(items.length, 0);
});

// ── Age purge (mark everything older than PURGE_AGE_DAYS as read) ─────────

const NOW = Date.parse('2026-08-24T12:00:00Z');
const CUTOFF_ISO = '2026-08-10T12:00:00.000Z'; // NOW − 14 days

function agePurgingGh(over = {}) {
  const puts = [];
  const gh = { ...fakeGh(over), async markReadBefore(iso) { puts.push(iso); } };
  return { gh, puts };
}

test('age purge: a thread older than 14 days triggers one PUT with the cutoff', async () => {
  const old = { ...reviewReqThread, updated_at: '2026-07-01T00:00:00Z' };
  const fresh = { ...reviewReqThread, id: 't2', updated_at: '2026-08-23T00:00:00Z' };
  const { gh, puts } = agePurgingGh({ notifications: [old, fresh] });
  await collectNotifications(gh, ME, { now: NOW });
  assert.deepEqual(puts, [CUTOFF_ISO]);
});

test('age purge: only fresh threads → no PUT', async () => {
  const fresh = { ...reviewReqThread, updated_at: '2026-08-23T00:00:00Z' };
  const { gh, puts } = agePurgingGh({ notifications: [fresh] });
  await collectNotifications(gh, ME, { now: NOW });
  assert.deepEqual(puts, []);
});

test('age purge: a failing PUT does not break the collection', async () => {
  const old = { ...reviewReqThread, updated_at: '2026-07-01T00:00:00Z' };
  const gh = {
    ...fakeGh({ notifications: [old] }),
    async markReadBefore() { throw new Error('rate limit'); },
  };
  const items = await collectNotifications(gh, ME, { now: NOW });
  assert.equal(items.length, 1);
});

test('age purge: a gh stub without markReadBefore still works', async () => {
  const old = { ...reviewReqThread, updated_at: '2026-07-01T00:00:00Z' };
  const items = await collectNotifications(fakeGh({ notifications: [old] }), ME, { now: NOW });
  assert.equal(items.length, 1);
});

test('collectPending maps the search items', async () => {
  const search = [{
    number: 98, title: 'PR to review',
    html_url: 'https://github.com/o/r/pull/98',
    updated_at: '2026-06-20T09:00:00Z',
    repository_url: 'https://api.github.com/repos/o/r',
  }];
  const pending = await collectPending(fakeGh({ search }));
  assert.deepEqual(pending[0], {
    repo: 'o/r', number: 98, title: 'PR to review',
    url: 'https://github.com/o/r/pull/98', updatedAt: '2026-06-20T09:00:00Z',
  });
});

// ── scope ──────────────────────────────────────────────────────────────────
test('scopeMatches: null=everything, org=prefix, repo=exact', () => {
  assert.equal(scopeMatches(null, 'symfony/ticketing'), true);
  assert.equal(scopeMatches({ type: 'org', value: 'symfony' }, 'symfony/ticketing'), true);
  assert.equal(scopeMatches({ type: 'org', value: 'symfony' }, 'other/repo'), false);
  assert.equal(scopeMatches({ type: 'org', value: 'map' }, 'symfony/x'), false); // not a plain string startsWith
  assert.equal(scopeMatches({ type: 'repo', value: 'symfony/ticketing' }, 'symfony/ticketing'), true);
  assert.equal(scopeMatches({ type: 'repo', value: 'symfony/ticketing' }, 'symfony/web'), false);
});

test('scopeQualifier', () => {
  assert.equal(scopeQualifier(null), '');
  assert.equal(scopeQualifier({ type: 'org', value: 'symfony' }), ' org:symfony');
  assert.equal(scopeQualifier({ type: 'repo', value: 'symfony/web' }), ' repo:symfony/web');
});

// ── Multiple scopes (union of favorites) ─────────────────────────────────

test('toScopeList: null/object/array → null or non-empty array', () => {
  const org = { type: 'org', value: 'symfony' };
  assert.equal(toScopeList(null), null);
  assert.equal(toScopeList([]), null);       // empty array = no filter
  assert.equal(toScopeList([null]), null);   // null entries pruned
  assert.deepEqual(toScopeList(org), [org]); // single scope = special case
  assert.deepEqual(toScopeList([org]), [org]);
});

test('matchesAnyScope: union of org + repo, null → everything passes', () => {
  const scopes = [{ type: 'org', value: 'symfony' }, { type: 'repo', value: 'noctud/collection' }];
  assert.equal(matchesAnyScope(scopes, 'symfony/api'), true);
  assert.equal(matchesAnyScope(scopes, 'noctud/collection'), true);
  assert.equal(matchesAnyScope(scopes, 'noctud/other'), false); // repo ≠ org
  assert.equal(matchesAnyScope(scopes, 'zenstruck/foundry'), false);
  assert.equal(matchesAnyScope(null, 'anything/whatever'), true);
  assert.equal(matchesAnyScope([], 'anything/whatever'), true);
  // backward-compat: a single scope behaves as before
  assert.equal(matchesAnyScope({ type: 'org', value: 'symfony' }, 'symfony/api'), true);
});

test('scopesQualifier: union OR-ed by GitHub in a single search', () => {
  assert.equal(scopesQualifier(null), '');
  assert.equal(scopesQualifier([]), '');
  assert.equal(
    scopesQualifier([{ type: 'org', value: 'symfony' }, { type: 'repo', value: 'noctud/collection' }]),
    ' org:symfony repo:noctud/collection',
  );
});

test('scopesQualifier: the real use case stays well under 256 characters', () => {
  // Beyond 256 characters, GitHub rejects the search — that's what
  // MAX_QUALIFIER_LENGTH (favorites.js) protects against on add.
  const scopes = [
    { type: 'org', value: 'symfony' },
    { type: 'repo', value: 'noctud/collection' },
    { type: 'org', value: 'zenstruck' },
  ];
  assert.equal(scopesQualifier(scopes), ' org:symfony repo:noctud/collection org:zenstruck');
  const q = `is:open is:pr review-requested:@me${scopesQualifier(scopes)}`;
  assert.ok(q.length < 256, `query of ${q.length} characters`);
});

test('collectNotifications filters on the union of scopes (favorites)', async () => {
  const symfony = { ...reviewReqThread, id: 'tm', repository: { full_name: 'symfony/api' }, subject: { ...reviewReqThread.subject, url: 'https://api.github.com/repos/symfony/api/pulls/1' } };
  const zen = { ...reviewReqThread, id: 'tz', repository: { full_name: 'zenstruck/foundry' }, subject: { ...reviewReqThread.subject, url: 'https://api.github.com/repos/zenstruck/foundry/pulls/2' } };
  const outside = { ...reviewReqThread, id: 'tx', repository: { full_name: 'other/repo' }, subject: { ...reviewReqThread.subject, url: 'https://api.github.com/repos/other/repo/pulls/3' } };
  const debug = [];
  await collectNotifications(fakeGh({ notifications: [symfony, zen, outside] }), ME, {
    scope: [{ type: 'org', value: 'symfony' }, { type: 'org', value: 'zenstruck' }],
    debug,
  });
  assert.deepEqual(debug.map((d) => d.repo), ['symfony/api', 'zenstruck/foundry']);
});

test('collectPRs passes the union qualifier to both searches', async () => {
  const seen = [];
  const gh = {
    ...fakeGh(),
    async searchReviewRequested(q) { seen.push(['pending', q]); return []; },
    async searchAuthored(q) { seen.push(['authored', q]); return []; },
  };
  await collectPRs(gh, ME, { scope: [{ type: 'org', value: 'symfony' }, { type: 'repo', value: 'noctud/collection' }] });
  assert.deepEqual(seen, [
    ['pending', ' org:symfony repo:noctud/collection'],
    ['authored', ' org:symfony repo:noctud/collection'],
  ]);
});

test('collectNotifications filters by scope before inspection', async () => {
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

test('ciFromChecks: aggregates the remaining checks (a fail dominates, otherwise pending, otherwise pass, otherwise none)', () => {
  // null/undefined/empty → none
  assert.equal(ciFromChecks(null, []), 'none');
  assert.equal(ciFromChecks(undefined, []), 'none');
  assert.equal(ciFromChecks([], []), 'none');
  // a fail dominates
  assert.equal(ciFromChecks([{ name: 'a', state: 'pass' }, { name: 'b', state: 'fail' }], []), 'fail');
  // no fail, one pending → pending
  assert.equal(ciFromChecks([{ name: 'a', state: 'pass' }, { name: 'b', state: 'pending' }], []), 'pending');
  // only passes → pass
  assert.equal(ciFromChecks([{ name: 'a', state: 'pass' }], []), 'pass');
});

test('ciFromChecks: removes the ignored jobs (exact match, trimmed) before aggregating', () => {
  const checks = [
    { name: 'continuous-integration/jenkins/branch', state: 'pass' },
    { name: 'Check Pull Requests label for merge block', state: 'fail' },
  ];
  // without ignoring: the red label job makes it fail
  assert.equal(ciFromChecks(checks, []), 'fail');
  // ignoring the label job: jenkins green → pass
  assert.equal(ciFromChecks(checks, ['Check Pull Requests label for merge block']), 'pass');
  // trim tolerated on the config side
  assert.equal(ciFromChecks(checks, ['  Check Pull Requests label for merge block  ']), 'pass');
  // everything ignored → none (no relevant check left)
  assert.equal(ciFromChecks(checks, ['continuous-integration/jenkins/branch', 'Check Pull Requests label for merge block']), 'none');
  // case-sensitive: a miscapitalized name ignores nothing
  assert.equal(ciFromChecks(checks, ['check pull requests label for merge block']), 'fail');
});

test('ciOf: recomputes via ciFromChecks if blocklist, otherwise falls back to ciFromState (compat)', () => {
  const detail = { checks: [{ name: 'behat', state: 'fail' }], statusCheckRollupState: 'FAILURE' };
  // without ignored jobs → ciFromState (the rollup rules, byte-identical compat)
  assert.equal(ciOf(detail, []), 'fail');
  // ignoring behat → recompute on the remaining checks (none) → none
  assert.equal(ciOf(detail, ['behat']), 'none');
  // rollup SUCCESS without blocklist → pass, even if checks empty
  assert.equal(ciOf({ checks: [], statusCheckRollupState: 'SUCCESS' }, []), 'pass');
});

test('recomputeCi: recomputes the ci of mine/others/hidden from row.checks, 0 refetch', () => {
  const mk = (repo, ci, checks) => ({ repo, number: 1, ci, checks, statusCheckRollupState: 'FAILURE' });
  const data = {
    mine: [mk('symfony/ticketing', 'fail', [{ name: 'jenkins', state: 'fail' }, { name: 'behat', state: 'pass' }])],
    others: [mk('o/r', 'fail', [{ name: 'x', state: 'fail' }])],
    hidden: [mk('symfony/ticketing', 'fail', [{ name: 'jenkins', state: 'fail' }])],
  };
  recomputeCi(data, { 'symfony/ticketing': ['jenkins'] });
  assert.equal(data.mine[0].ci, 'pass');   // jenkins ignored → behat remains (pass)
  assert.equal(data.hidden[0].ci, 'none');  // jenkins ignored → nothing left
  assert.equal(data.others[0].ci, 'fail');  // repo without blocklist → ciFromState(FAILURE)
});

test('countApprovals: distinct users whose latest review is APPROVED', () => {
  assert.equal(countApprovals(undefined), 0);
  assert.equal(countApprovals([]), 0);
  // alice approves, bob comments → 1 approval
  assert.equal(countApprovals([
    { author: { login: 'alice' }, state: 'APPROVED', submittedAt: '2026-06-20T10:00:00Z' },
    { author: { login: 'bob' }, state: 'COMMENTED', submittedAt: '2026-06-20T11:00:00Z' },
  ]), 1);
  // alice approves then requests changes → no longer counts
  assert.equal(countApprovals([
    { author: { login: 'alice' }, state: 'APPROVED', submittedAt: '2026-06-20T10:00:00Z' },
    { author: { login: 'alice' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-06-21T10:00:00Z' },
  ]), 0);
  // two approvals from the same user → counted once
  assert.equal(countApprovals([
    { author: { login: 'alice' }, state: 'APPROVED', submittedAt: '2026-06-20T10:00:00Z' },
    { author: { login: 'alice' }, state: 'APPROVED', submittedAt: '2026-06-21T10:00:00Z' },
    { author: { login: 'bob' }, state: 'APPROVED', submittedAt: '2026-06-21T12:00:00Z' },
  ]), 2);
});

test('prState: draft > merged > closed > open', () => {
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

test('collectPRs: aggregates the triggers of the same PR and splits mine/others', async () => {
  // o/r#42 has two notifs (review_requested + mention); details: author = someone else.
  // o/x#7 is one of my PRs (author = ME).
  const myThread = {
    id: 't3', reason: 'author', updated_at: '2026-06-24T12:00:00Z',
    subject: { title: 'My PR', url: 'https://api.github.com/repos/o/x/pulls/7', latest_comment_url: 'https://api.github.com/repos/o/x/issues/comments/9', type: 'PullRequest' },
    repository: { full_name: 'o/x' },
  };
  const gh = fakeGh({
    notifications: [reviewReqThread, reviewReqThread2, myThread],
    comment: { user: { login: 'bob' }, html_url: 'h' }, // for the author thread
    // o/r#42 is also pending review → the « review » trigger comes from the
    // search (reliable source), not from the sticky review_requested notif.
    search: [{ number: 42, title: 'PR A', html_url: 'https://github.com/o/r/pull/42', updated_at: '2026-06-24T12:00:00Z', repository_url: 'https://api.github.com/repos/o/r' }],
    details: (repo, number) => {
      if (repo === 'o/r' && number === 42) return { number: 42, title: 'PR A', author: { login: 'alice' }, createdAt: '2026-06-21T12:00:00Z', additions: 10, deletions: 2, branch: 'feat/a', branchRepo: 'o/r', base: 'feat/parent', defaultBranch: 'main', labels: [{ name: 'bug', color: 'd73a4a' }], statusCheckRollupState: 'SUCCESS' };
      if (repo === 'o/x' && number === 7) return { number: 7, title: 'My PR', author: { login: ME }, createdAt: '2026-06-23T12:00:00Z', additions: 1, deletions: 0, statusCheckRollupState: null };
      return null;
    },
  });
  const { mine, others, notifications } = await collectPRs(gh, ME, {});

  // notifications: classified notification items, exposed for --watch.
  assert.ok(Array.isArray(notifications));
  assert.equal(notifications.length, 3); // review_request + mention (o/r#42) + author (o/x#7)

  assert.equal(others.length, 1);
  assert.equal(others[0].repo, 'o/r');
  assert.deepEqual([...others[0].triggers].sort(), ['mention', 'review']);
  assert.equal(others[0].author, 'alice');
  assert.equal(others[0].ci, 'pass');
  assert.equal(others[0].additions, 10);
  assert.equal(others[0].branch, 'feat/a');
  assert.equal(others[0].branchRepo, 'o/r');
  assert.equal(others[0].base, 'feat/parent');
  assert.equal(others[0].defaultBranch, 'main');
  assert.deepEqual(others[0].labels, [{ name: 'bug', color: 'd73a4a' }]);

  assert.equal(mine.length, 1);
  assert.equal(mine[0].repo, 'o/x');
  assert.deepEqual(mine[0].triggers, ['comment']);
  assert.equal(mine[0].ci, 'none');
  assert.equal(mine[0].branch, null); // detail without headRefName → null (compat)
  assert.equal(mine[0].base, null); // detail without baseRefName → null (compat)
  assert.equal(mine[0].defaultBranch, null);
  assert.deepEqual(mine[0].labels, []); // detail without labels → [] (compat)
  assert.equal(mine[0].url, 'h'); // « comment on my PR » → link to the comment
});

test('collectPRs: the link of a thread reply points at the comment', async () => {
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

test('collectPRs: the per-repo blocklist recomputes the CI (red ignored job → pass) and exposes row.checks', async () => {
  const checks = [
    { name: 'continuous-integration/jenkins/branch', state: 'pass' },
    { name: 'Check Pull Requests label for merge block', state: 'fail' },
  ];
  const gh = fakeGh({
    search: [{ number: 60, title: 'To review', html_url: 'https://github.com/symfony/ticketing/pull/60', updated_at: '2026-06-20T09:00:00Z', repository_url: 'https://api.github.com/repos/symfony/ticketing' }],
    // GitHub rollup = FAILURE (the red label job), but the real job is green
    details: () => ({ number: 60, title: 'To review', author: { login: 'carol' }, createdAt: '2026-06-19T09:00:00Z', additions: 1, deletions: 1, statusCheckRollupState: 'FAILURE', checks }),
  });
  const opts = { ignoredChecks: { 'symfony/ticketing': ['Check Pull Requests label for merge block'] } };
  const { others } = await collectPRs(gh, ME, opts);
  assert.equal(others[0].ci, 'pass');                 // recomputed without the ignored job
  assert.deepEqual(others[0].checks, checks);         // raw list exposed (debug view)
});

test('collectPRs: without a blocklist for the repo, the CI stays the GitHub rollup (byte-identical compat)', async () => {
  const checks = [{ name: 'continuous-integration/jenkins/branch', state: 'pass' }];
  const gh = fakeGh({
    search: [{ number: 61, title: 'PR', html_url: 'https://github.com/o/r/pull/61', updated_at: '2026-06-20T09:00:00Z', repository_url: 'https://api.github.com/repos/o/r' }],
    // rollup FAILURE while the known checks are green: without config we do NOT recompute
    details: () => ({ number: 61, title: 'PR', author: { login: 'carol' }, createdAt: '2026-06-19T09:00:00Z', additions: 1, deletions: 1, statusCheckRollupState: 'FAILURE', checks }),
  });
  // blocklist present but for ANOTHER repo → does not affect o/r
  const { others } = await collectPRs(gh, ME, { ignoredChecks: { 'other/repo': ['x'] } });
  assert.equal(others[0].ci, 'fail'); // ciFromState(FAILURE), not the recompute
});

test('collectPRs: a pending review (without a comment) keeps the link to the PR', async () => {
  const gh = fakeGh({
    search: [{ number: 60, title: 'To review', html_url: 'https://github.com/o/r/pull/60', updated_at: '2026-06-20T09:00:00Z', repository_url: 'https://api.github.com/repos/o/r' }],
    details: () => ({ number: 60, title: 'To review', author: { login: 'carol' }, createdAt: '2026-06-19T09:00:00Z', additions: 1, deletions: 1, statusCheckRollupState: 'SUCCESS' }),
  });
  const { others } = await collectPRs(gh, ME, {});
  assert.equal(others[0].url, 'https://github.com/o/r/pull/60'); // PR link (no comment)
});

test('collectPRs: an open PR I authored (without activity) appears in mine, empty triggers', async () => {
  const gh = fakeGh({
    notifications: [],
    authored: [{ number: 20, title: 'My PR without activity', html_url: 'https://github.com/o/x/pull/20', repository_url: 'https://api.github.com/repos/o/x' }],
    details: () => ({ number: 20, title: 'My PR without activity', author: { login: ME }, createdAt: '2026-06-22T12:00:00Z', additions: 5, deletions: 1, statusCheckRollupState: 'SUCCESS' }),
  });
  const { mine, others } = await collectPRs(gh, ME, {});
  assert.equal(others.length, 0);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].repo, 'o/x');
  assert.deepEqual(mine[0].triggers, []);
  assert.equal(mine[0].ci, 'pass');
});

test('collectPRs: sticky review_requested notif but already reviewed (absent from search, no reply) → ignored', async () => {
  // Regression #7036: the notif keeps reason=review_requested forever. Since the PR
  // is no longer in review-requested:@me (already reviewed) and no reply targets
  // my thread, it must produce NO row (neither « review » nor anything else).
  const gh = fakeGh({
    notifications: [reviewReqThread], // o/r#42, reason review_requested
    search: [],                        // no longer pending
    reviewComments: [],                // no reply to my thread
    details: () => ({ number: 42, title: 'PR A', author: { login: 'alice' }, createdAt: '2026-06-21T12:00:00Z', additions: 1, deletions: 0, statusCheckRollupState: null }),
  });
  const { mine, others } = await collectPRs(gh, ME, {});
  assert.equal(mine.length, 0);
  assert.equal(others.length, 0);
});

test('collectPRs: sticky review_requested notif WITH a reply to my thread → « reply » row (not « review »)', async () => {
  const gh = fakeGh({
    notifications: [reviewReqThread], // o/r#42, reason review_requested
    search: [],                        // no longer pending
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

test('collectPRs: merged PR, review requested, NO reply to my thread → ignored', async () => {
  // Rule: review requested + no reply to my thread + merged PR ⇒ nothing.
  // (real #7027: merged, I had commented but no one replied to me.)
  // The merged state need not be queried: not pending (empty search) +
  // review_requested item ignored ⇒ no row.
  const gh = fakeGh({
    notifications: [reviewReqThread], // o/r#42, sticky reason review_requested
    search: [],                        // merged so absent from review-requested:@me (is:open)
    reviewComments: [
      { id: 1, user: { login: 'bjulien' }, created_at: '2026-06-23T09:00:00Z', html_url: 'root' },
      { id: 2, in_reply_to_id: 1, user: { login: ME }, created_at: '2026-06-23T12:00:00Z', html_url: 'mine' },
    ], // I replied to bjulien, but no one after me
    details: () => ({ number: 42, title: 'PR A', author: { login: 'alice' }, createdAt: '2026-06-21T12:00:00Z', additions: 1, deletions: 0, statusCheckRollupState: null }),
  });
  const { mine, others } = await collectPRs(gh, ME, {});
  assert.equal(mine.length, 0);
  assert.equal(others.length, 0);
});

test('collectPRs: merged PR but reply to my thread → stays visible (trigger reply)', async () => {
  // Rule: if someone replied to me, the notif stays visible even for a merged PR.
  // getPullDetails does not return the merged state → the merged state is invisible
  // to the logic: only the presence of a reply matters.
  const gh = fakeGh({
    notifications: [reviewReqThread], // o/r#42
    search: [],                        // merged
    reviewComments: [
      { id: 1, user: { login: ME }, created_at: '2026-06-23T09:00:00Z', html_url: 'mine' },
      { id: 2, in_reply_to_id: 1, user: { login: 'alice' }, created_at: '2026-06-23T12:00:00Z', html_url: 'https://github.com/o/r/pull/42#discussion_rX' },
    ], // alice replied to me after my comment
    details: () => ({ number: 42, title: 'PR A', author: { login: 'alice' }, createdAt: '2026-06-21T12:00:00Z', additions: 1, deletions: 0, statusCheckRollupState: null }),
  });
  const { others } = await collectPRs(gh, ME, {});
  assert.equal(others.length, 1);
  assert.deepEqual(others[0].triggers, ['reply']);
});

test('collectPRs: others\' draft PRs are hidden, my drafts stay', async () => {
  const gh = fakeGh({
    // a review requested on someone else's draft PR + one of my draft PRs
    search: [{ number: 80, title: 'Other draft', html_url: 'https://github.com/o/r/pull/80', updated_at: '2026-06-20T09:00:00Z', repository_url: 'https://api.github.com/repos/o/r' }],
    authored: [{ number: 81, title: 'My draft', html_url: 'https://github.com/o/x/pull/81', repository_url: 'https://api.github.com/repos/o/x' }],
    details: (repo, number) => {
      if (number === 80) return { number: 80, title: 'Other draft', author: { login: 'alice' }, createdAt: '2026-06-19T09:00:00Z', additions: 1, deletions: 1, isDraft: true, state: 'OPEN', statusCheckRollupState: 'SUCCESS' };
      if (number === 81) return { number: 81, title: 'My draft', author: { login: ME }, createdAt: '2026-06-19T09:00:00Z', additions: 1, deletions: 1, isDraft: true, state: 'OPEN', statusCheckRollupState: 'SUCCESS' };
      return null;
    },
  });
  const { mine, others } = await collectPRs(gh, ME, {});
  assert.equal(others.length, 0);              // someone else's draft PR → hidden
  assert.equal(mine.length, 1);                // my draft → kept
  assert.equal(mine[0].state, 'draft');
});

test('collectPRs: an unseen pending review adds an « others » PR with a review trigger', async () => {
  const gh = fakeGh({
    notifications: [],
    search: [{ number: 98, title: 'To review', html_url: 'https://github.com/o/r/pull/98', updated_at: '2026-06-20T09:00:00Z', repository_url: 'https://api.github.com/repos/o/r' }],
    details: () => ({ number: 98, title: 'To review', author: { login: 'carol' }, createdAt: '2026-06-19T09:00:00Z', additions: 3, deletions: 3, statusCheckRollupState: 'PENDING', state: 'OPEN', isDraft: false, reviews: [
      { author: { login: 'dan' }, state: 'APPROVED', submittedAt: '2026-06-20T10:00:00Z' },
      { author: { login: 'eve' }, state: 'COMMENTED', submittedAt: '2026-06-20T11:00:00Z' },
      { author: { login: 'frank' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-06-20T12:00:00Z' },
    ] }),
  });
  const { mine, others } = await collectPRs(gh, ME, {});
  assert.equal(mine.length, 0);
  assert.equal(others.length, 1);
  assert.deepEqual(others[0].triggers, ['review']);
  assert.equal(others[0].ci, 'pending');
  assert.equal(others[0].state, 'open');
  assert.equal(others[0].approvals, 1);
  assert.equal(others[0].changesRequested, 1); // frank requested changes
});

test('collectPRs: mergeable CONFLICTING → row.conflicting true (anything else → false)', async () => {
  const gh = fakeGh({
    search: [{ number: 98, title: 'Conflicted', html_url: 'https://github.com/o/r/pull/98', updated_at: '2026-06-20T09:00:00Z', repository_url: 'https://api.github.com/repos/o/r' }],
    authored: [{ number: 81, title: 'Mine', html_url: 'https://github.com/o/x/pull/81', repository_url: 'https://api.github.com/repos/o/x' }],
    details: (repo, number) => (number === 98
      ? { number: 98, title: 'Conflicted', author: { login: 'carol' }, createdAt: '2026-06-19T09:00:00Z', additions: 1, deletions: 1, state: 'OPEN', isDraft: false, mergeable: 'CONFLICTING', statusCheckRollupState: 'SUCCESS' }
      : { number: 81, title: 'Mine', author: { login: ME }, createdAt: '2026-06-19T09:00:00Z', additions: 1, deletions: 1, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollupState: 'SUCCESS' }),
  });
  const { mine, others } = await collectPRs(gh, ME, {});
  assert.equal(others[0].conflicting, true);
  assert.equal(mine[0].conflicting, false);
});

test('collectPRs: mergeable UNKNOWN (not yet computed by GitHub) → conflicting false', async () => {
  const gh = fakeGh({
    authored: [{ number: 81, title: 'Mine', html_url: 'https://github.com/o/x/pull/81', repository_url: 'https://api.github.com/repos/o/x' }],
    details: () => ({ number: 81, title: 'Mine', author: { login: ME }, createdAt: '2026-06-19T09:00:00Z', additions: 1, deletions: 1, state: 'OPEN', isDraft: false, mergeable: 'UNKNOWN', statusCheckRollupState: 'SUCCESS' }),
  });
  const { mine } = await collectPRs(gh, ME, {});
  assert.equal(mine[0].conflicting, false);
});

// ── approvals (data.approvalEvents) ───────────────────────────────────────────
test('collectPRs: data.approvalEvents — one event per approval on MY open PRs', async () => {
  const gh = fakeGh({
    authored: [{ number: 81, title: 'My PR', html_url: 'https://github.com/o/x/pull/81', repository_url: 'https://api.github.com/repos/o/x' }],
    details: () => ({ number: 81, title: 'My PR', author: { login: ME }, createdAt: '2026-06-19T09:00:00Z', additions: 1, deletions: 1, state: 'OPEN', isDraft: false, statusCheckRollupState: 'SUCCESS', reviews: [
      { author: { login: 'alice' }, state: 'APPROVED', submittedAt: '2026-06-20T10:00:00Z' },
      { author: { login: 'bob' }, state: 'APPROVED', submittedAt: '2026-06-21T12:00:00Z' },
      { author: { login: 'carol' }, state: 'COMMENTED', submittedAt: '2026-06-21T13:00:00Z' },
    ] }),
  });
  const { mine, approvalEvents } = await collectPRs(gh, ME, {});
  assert.equal(mine[0].approvals, 2);
  assert.equal(approvalEvents.length, 2);
  assert.deepEqual(approvalEvents.map((e) => e.actor).sort(), ['alice', 'bob']);
  const a = approvalEvents.find((e) => e.actor === 'alice');
  assert.equal(a.repo, 'o/x');
  assert.equal(a.number, 81);
  assert.equal(a.title, 'My PR');
  assert.equal(a.count, 2); // total number of approvals of the PR
  assert.equal(a.submittedAt, '2026-06-20T10:00:00Z');
  assert.equal(a.url, 'https://github.com/o/x/pull/81');
});

test('collectPRs: approvalEvents excludes draft/merged PRs and others\' PRs', async () => {
  const gh = fakeGh({
    // someone else's PR, approved → must NOT produce an approvalEvent
    search: [{ number: 98, title: 'Other PR', html_url: 'https://github.com/o/r/pull/98', updated_at: '2026-06-20T09:00:00Z', repository_url: 'https://api.github.com/repos/o/r' }],
    // my PRs: one draft, one merged — both approved but excluded
    authored: [
      { number: 81, title: 'My draft', html_url: 'https://github.com/o/x/pull/81', repository_url: 'https://api.github.com/repos/o/x' },
      { number: 82, title: 'My merged', html_url: 'https://github.com/o/x/pull/82', repository_url: 'https://api.github.com/repos/o/x' },
    ],
    details: (repo, number) => {
      const reviews = [{ author: { login: 'alice' }, state: 'APPROVED', submittedAt: '2026-06-20T10:00:00Z' }];
      if (number === 98) return { number: 98, title: 'Other PR', author: { login: 'carol' }, createdAt: '2026-06-19T09:00:00Z', additions: 1, deletions: 1, state: 'OPEN', isDraft: false, statusCheckRollupState: 'SUCCESS', reviews };
      if (number === 81) return { number: 81, title: 'My draft', author: { login: ME }, createdAt: '2026-06-19T09:00:00Z', additions: 1, deletions: 1, state: 'OPEN', isDraft: true, statusCheckRollupState: 'SUCCESS', reviews };
      if (number === 82) return { number: 82, title: 'My merged', author: { login: ME }, createdAt: '2026-06-19T09:00:00Z', additions: 1, deletions: 1, state: 'MERGED', isDraft: false, statusCheckRollupState: 'SUCCESS', reviews };
      return null;
    },
  });
  const { approvalEvents } = await collectPRs(gh, ME, {});
  assert.deepEqual(approvalEvents, []);
});

// ── hiding (hidden) ────────────────────────────────────────────────────────
test('collectPRs: a hidden « others » PR leaves others and moves into hidden', async () => {
  const gh = fakeGh({
    search: [{ number: 60, title: 'To review', html_url: 'https://github.com/o/r/pull/60', updated_at: '2026-06-20T09:00:00Z', repository_url: 'https://api.github.com/repos/o/r' }],
    details: () => ({ number: 60, title: 'To review', author: { login: 'carol' }, createdAt: '2026-06-19T09:00:00Z', additions: 1, deletions: 1, statusCheckRollupState: 'SUCCESS' }),
  });
  const hidden = { 'o/r#60': { at: 'x', seen: [] } };
  const { others, hidden: hiddenRows, hiddenCount } = await collectPRs(gh, ME, { hidden });
  assert.equal(others.length, 0);
  assert.equal(hiddenCount, 1);
  assert.equal(hiddenRows[0].number, 60);
});

test('collectPRs: a hidden PR of mine leaves mine and moves into hiddenMine', async () => {
  const gh = fakeGh({
    authored: [{ number: 81, title: 'My PR', html_url: 'https://github.com/o/x/pull/81', repository_url: 'https://api.github.com/repos/o/x' }],
    details: () => ({ number: 81, title: 'My PR', author: { login: ME }, createdAt: '2026-06-19T09:00:00Z', additions: 1, deletions: 1, statusCheckRollupState: 'SUCCESS' }),
  });
  const hidden = { 'o/x#81': { at: 'x', seen: [] } };
  const { mine, hiddenMine, hiddenMineCount, hiddenCount, hiddenChanged } = await collectPRs(gh, ME, { hidden });
  assert.equal(mine.length, 0);           // no longer in the visible section
  assert.equal(hiddenMineCount, 1);
  assert.equal(hiddenMine[0].number, 81);
  assert.equal(hiddenCount, 0);           // the « others » counter is unaffected
  assert.equal(hiddenChanged, false);     // the key must NOT be pruned (PR still present)
  assert.ok('o/x#81' in hidden);
});

test('collectPRs: un-hiding of one of MY PRs on a new trigger (reconcile)', async () => {
  const thread = {
    id: 't1', reason: 'author', updated_at: '2026-06-24T12:00:00Z',
    subject: { title: 'My PR', url: 'https://api.github.com/repos/o/x/pulls/81', latest_comment_url: null, type: 'PullRequest' },
    repository: { full_name: 'o/x' },
  };
  const gh = fakeGh({
    notifications: [thread],
    authored: [{ number: 81, title: 'My PR', html_url: 'https://github.com/o/x/pull/81', repository_url: 'https://api.github.com/repos/o/x' }],
    reviewComments: [
      { id: 1, user: { login: ME }, created_at: '2026-06-24T10:00:00Z', html_url: 'mine' },
      { id: 2, in_reply_to_id: 1, user: { login: 'bob' }, created_at: '2026-06-24T11:00:00Z', html_url: 'https://github.com/o/x/pull/81#discussion_r2' },
    ],
    details: () => ({ number: 81, title: 'My PR', author: { login: ME }, createdAt: '2026-06-20T12:00:00Z', additions: 1, deletions: 1, statusCheckRollupState: 'SUCCESS' }),
  });
  // hidden with an empty snapshot → the #discussion_r2 event is « new »
  const hidden = { 'o/x#81': { at: 'x', seen: [] } };
  const { mine, hiddenMineCount, hiddenChanged } = await collectPRs(gh, ME, { hidden });
  assert.equal(mine.length, 1);      // reappeared
  assert.equal(hiddenMineCount, 0);
  assert.equal(hiddenChanged, true); // reconcile modified the map
  assert.equal('o/x#81' in hidden, false);
});

test('collectPRs: a hidden PR of mine still emits its approvalEvents', async () => {
  const gh = fakeGh({
    authored: [{ number: 81, title: 'My PR', html_url: 'https://github.com/o/x/pull/81', repository_url: 'https://api.github.com/repos/o/x' }],
    details: () => ({ number: 81, title: 'My PR', author: { login: ME }, createdAt: '2026-06-19T09:00:00Z', additions: 1, deletions: 1, state: 'OPEN', isDraft: false, statusCheckRollupState: 'SUCCESS', reviews: [
      { author: { login: 'alice' }, state: 'APPROVED', submittedAt: '2026-06-20T10:00:00Z' },
    ] }),
  });
  const hidden = { 'o/x#81': { at: 'x', seen: [] } };
  const { hiddenMineCount, approvalEvents } = await collectPRs(gh, ME, { hidden });
  assert.equal(hiddenMineCount, 1);
  assert.equal(approvalEvents.length, 1); // desktop notifs keep seeing everything (cf. §14)
  assert.equal(approvalEvents[0].actor, 'alice');
});

test('collectPRs: un-hiding on a new trigger (reconcile) + hiddenChanged', async () => {
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
  // hidden with an empty snapshot → the #discussion_r2 event is « new »
  const hidden = { 'o/r#50': { at: 'x', seen: [] } };
  const { others, hiddenCount, hiddenChanged } = await collectPRs(gh, ME, { hidden });
  assert.equal(others.length, 1);    // reappeared
  assert.equal(hiddenCount, 0);
  assert.equal(hiddenChanged, true); // reconcile modified the map
  assert.equal('o/r#50' in hidden, false);
});

// Regression (issue #1, second trigger): others' drafts are excluded from the
// displayed rows, but they ARE collected. reconcile must receive `entries`, not
// the displayable rows — otherwise a hidden PR turned draft counts as absent and
// starts its purge countdown for a reason that has nothing to do with being dead.
test('collectPRs: a hidden PR of others turned draft is neither un-hidden nor dated absent', async () => {
  const gh = fakeGh({
    // still in review-requested:@me (the « review » trigger carries no signature)
    search: [{
      number: 51, title: 'PR D',
      html_url: 'https://github.com/o/r/pull/51',
      repository_url: 'https://api.github.com/repos/o/r',
      updated_at: '2026-06-24T12:00:00Z',
    }],
    details: () => ({ number: 51, title: 'PR D', author: { login: 'bob' }, isDraft: true, createdAt: '2026-06-20T12:00:00Z', additions: 1, deletions: 1 }),
  });
  const hidden = { 'o/r#51': { at: 'x', seen: [] } };
  const { others, hiddenCount, hiddenChanged } = await collectPRs(gh, ME, { hidden });

  assert.equal(others.length, 0);   // draft: not displayed, as before
  assert.equal(hiddenCount, 0);     // and not in the hidden table either
  assert.equal(hiddenChanged, false, 'the key is untouched: the PR WAS seen this poll');
  assert.equal('o/r#51' in hidden, true, 'still hidden');
  assert.equal(hidden['o/r#51'].missingSince, undefined, 'no purge countdown started');
});

// A PR genuinely gone from the poll is dated, not deleted: the signature survives.
test('collectPRs: a hidden PR absent from the poll keeps its signature (dated only)', async () => {
  const hidden = { 'o/r#77': { at: 'x', seen: [] } };
  const { hiddenChanged } = await collectPRs(fakeGh(), ME, { hidden });

  assert.equal(hiddenChanged, true, 'the absence was recorded');
  assert.equal('o/r#77' in hidden, true, 'NOT deleted');
  assert.ok(hidden['o/r#77'].missingSince, 'countdown started');
  assert.deepEqual(hidden['o/r#77'].seen, [], 'signature intact');
});

// ── inspection cache + incremental comments ─────────────────────────────────
test('mergeReviewComments: merge by id (fresh wins), created_at order', () => {
  const merged = mergeReviewComments(
    [{ id: 1, created_at: 'a', x: 'old' }, { id: 3, created_at: 'c' }],
    [{ id: 1, created_at: 'a', x: 'new' }, { id: 2, created_at: 'b' }],
  );
  assert.deepEqual(merged.map((c) => c.id), [1, 2, 3]);
  assert.equal(merged.find((c) => c.id === 1).x, 'new'); // fresh overwrites
});

test('watermarkOf: max updated_at (fallback created_at), null if empty', () => {
  assert.equal(watermarkOf([{ updated_at: '2026-06-01' }, { updated_at: '2026-06-03' }]), '2026-06-03');
  assert.equal(watermarkOf([{ created_at: '2026-06-02' }]), '2026-06-02');
  assert.equal(watermarkOf([]), null);
});

// gh stub counting getReviewComments calls + capturing `since`.
function countingGh(thread, comments) {
  const calls = [];
  return {
    gh: {
      async getCurrentUser() { return ME; },
      async listNotifications() { return [thread]; },
      async getComment() { return null; },
      async getReviewComments(repo, number, opts = {}) { calls.push(opts.since ?? null); return comments; },
      async searchReviewRequested() { return []; },
      async searchAuthored() { return []; },
      async getPullDetailsBatch(prs) { return prs.map(() => null); },
    },
    calls,
  };
}

test('collectNotifications: cache → unchanged thread = 0 getReviewComments request', async () => {
  const thread = {
    id: 't1', reason: 'review_requested', updated_at: '2026-06-24T12:00:00Z',
    subject: { title: 'PR', url: 'https://api.github.com/repos/o/r/pulls/42', latest_comment_url: null, type: 'PullRequest' },
    repository: { full_name: 'o/r' },
  };
  const { gh, calls } = countingGh(thread, [{ id: 1, created_at: '2026-06-24T10:00:00Z', updated_at: '2026-06-24T10:00:00Z' }]);
  const cache = new Map();
  await collectNotifications(gh, ME, { cache });   // 1st poll: inspects
  assert.equal(calls.length, 1);
  assert.equal(calls[0], null);                     // 1st time: no since
  await collectNotifications(gh, ME, { cache });   // 2nd poll, same updated_at
  assert.equal(calls.length, 1, 'no new call: cache hit');
});

test('collectNotifications: modified thread → re-inspection with since = watermark', async () => {
  const base = {
    id: 't1', reason: 'review_requested',
    subject: { title: 'PR', url: 'https://api.github.com/repos/o/r/pulls/42', latest_comment_url: null, type: 'PullRequest' },
    repository: { full_name: 'o/r' },
  };
  const { gh, calls } = countingGh(
    { ...base, updated_at: '2026-06-24T12:00:00Z' },
    [{ id: 1, created_at: '2026-06-24T10:00:00Z', updated_at: '2026-06-24T11:00:00Z' }],
  );
  const cache = new Map();
  await collectNotifications(gh, ME, { cache });   // inspects, watermark = 11:00
  // bumped thread: new updated_at → incremental re-inspection
  gh.listNotifications = async () => [{ ...base, updated_at: '2026-06-24T13:00:00Z' }];
  await collectNotifications(gh, ME, { cache });
  assert.equal(calls.length, 2);
  assert.equal(calls[1], '2026-06-24T11:00:00Z', 'since = previous watermark');
});

test('collectNotifications: cache pruned when the thread disappears', async () => {
  const thread = {
    id: 't1', reason: 'review_requested', updated_at: '2026-06-24T12:00:00Z',
    subject: { title: 'PR', url: 'https://api.github.com/repos/o/r/pulls/42', latest_comment_url: null, type: 'PullRequest' },
    repository: { full_name: 'o/r' },
  };
  const { gh } = countingGh(thread, []);
  const cache = new Map();
  await collectNotifications(gh, ME, { cache });
  assert.equal(cache.has('t1'), true);
  gh.listNotifications = async () => []; // thread gone
  await collectNotifications(gh, ME, { cache });
  assert.equal(cache.has('t1'), false, 'entry pruned');
});

test('collectNotifications: without cache, unchanged behavior (always re-inspect)', async () => {
  const thread = {
    id: 't1', reason: 'review_requested', updated_at: '2026-06-24T12:00:00Z',
    subject: { title: 'PR', url: 'https://api.github.com/repos/o/r/pulls/42', latest_comment_url: null, type: 'PullRequest' },
    repository: { full_name: 'o/r' },
  };
  const { gh, calls } = countingGh(thread, []);
  await collectNotifications(gh, ME, {});
  await collectNotifications(gh, ME, {});
  assert.equal(calls.length, 2, 'without cache: re-inspection every time');
});

// ── debug: pipeline verdict (data.debug) ───────────────────────────────────
test('collectPRs: data.debug exposes the verdict (kept/dropped + reason) per thread', async () => {
  const reviewThread = {
    id: 't1', reason: 'review_requested', updated_at: '2026-06-24T12:00:00Z',
    subject: { title: 'PR A', url: 'https://api.github.com/repos/o/r/pulls/42', latest_comment_url: null, type: 'PullRequest' },
    repository: { full_name: 'o/r' },
  };
  const authorThread = {
    id: 't2', reason: 'author', updated_at: '2026-06-24T12:00:00Z',
    subject: { title: 'My PR', url: 'https://api.github.com/repos/o/x/pulls/7', latest_comment_url: null, type: 'PullRequest' },
    repository: { full_name: 'o/x' },
  };
  const gh = fakeGh({ notifications: [reviewThread, authorThread], reviewComments: [] });
  const { debug } = await collectPRs(gh, ME, {});
  assert.ok(Array.isArray(debug));
  assert.equal(debug.length, 2);

  const a = debug.find((d) => d.number === 42);
  assert.equal(a.verdict.kept, true);
  assert.equal(a.verdict.category, 'review_request');
  assert.match(a.verdict.reason, /notification only/);
  assert.equal(a.ghReason, 'review_requested');

  const b = debug.find((d) => d.number === 7);
  assert.equal(b.verdict.kept, false);            // my own PR without activity from anyone else → dropped
  assert.equal(b.verdict.category, null);
  assert.match(b.verdict.reason, /your own action/);
  assert.equal(b.ghReason, 'author');
  assert.equal(b.repo, 'o/x');
});

// ── « All » mode (watched favorites): issues + third-party PRs ────────────

const watchedIssueThread = {
  id: 'w1', reason: 'subscribed', updated_at: '2026-08-01T12:00:00Z', last_read_at: null,
  subject: {
    title: 'Bug report',
    url: 'https://api.github.com/repos/zenstruck/foundry/issues/900',
    latest_comment_url: 'https://api.github.com/repos/zenstruck/foundry/issues/900',
    type: 'Issue',
  },
  repository: { full_name: 'zenstruck/foundry' },
};

const watchedPrThread = {
  id: 'w2', reason: 'subscribed', updated_at: '2026-08-01T13:00:00Z', last_read_at: null,
  subject: {
    title: 'A new PR',
    url: 'https://api.github.com/repos/zenstruck/foundry/pulls/901',
    latest_comment_url: 'https://api.github.com/repos/zenstruck/foundry/pulls/901',
    type: 'PullRequest',
  },
  repository: { full_name: 'zenstruck/foundry' },
};

const inFoundry = (repo) => repo === 'zenstruck/foundry';

test('collectNotifications: Issue thread kept only for a watchAll repo', async () => {
  const gh = fakeGh({
    notifications: [watchedIssueThread],
    comment: { user: { login: 'alice' }, created_at: '2026-08-01T12:00:00Z', html_url: 'https://github.com/zenstruck/foundry/issues/900' },
  });
  const kept = await collectNotifications(gh, ME, { watchAll: inFoundry });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].category, 'new_issue');
  // without watchAll: dropped as before (compat)
  assert.equal((await collectNotifications(gh, ME, {})).length, 0);
});

test('collectNotifications: an Issue thread does not fetch review-comments (pulls/N/comments would 404)', async () => {
  let reviewCalls = 0;
  const gh = fakeGh({
    notifications: [watchedIssueThread],
    comment: { user: { login: 'alice' }, created_at: '2026-08-01T12:00:00Z', html_url: 'i900' },
  });
  gh.getReviewComments = async () => { reviewCalls += 1; return []; };
  await collectNotifications(gh, ME, { watchAll: inFoundry });
  assert.equal(reviewCalls, 0);
});

test('collectPRs: watched issue → data.issues row, absent from the PR tables', async () => {
  const gh = fakeGh({
    notifications: [watchedIssueThread],
    comment: { user: { login: 'alice' }, created_at: '2026-08-01T12:00:00Z', html_url: 'https://github.com/zenstruck/foundry/issues/900' },
  });
  const { issues, others, mine, notifications } = await collectPRs(gh, ME, { watchAll: inFoundry });
  assert.deepEqual(issues, [{
    repo: 'zenstruck/foundry', number: 900, title: 'Bug report',
    url: 'https://github.com/zenstruck/foundry/issues/900',
    actor: 'alice', createdAt: '2026-08-01T12:00:00Z', updatedAt: '2026-08-01T12:00:00Z',
    triggers: ['new'],
  }]);
  assert.equal(others.length, 0);
  assert.equal(mine.length, 0);
  // the poll loop sees the issue item (desktop notif)
  assert.equal(notifications.filter((i) => i.category === 'new_issue').length, 1);
});

test('collectPRs: watched third-party PR → « others » row with the new trigger', async () => {
  const gh = fakeGh({
    notifications: [watchedPrThread],
    comment: { user: { login: 'alice' }, created_at: '2026-08-01T13:00:00Z', html_url: 'https://github.com/zenstruck/foundry/pull/901' },
    details: (repo, number) => (number === 901 ? { author: { login: 'alice' }, title: 'A new PR', state: 'OPEN' } : null),
  });
  const { issues, others } = await collectPRs(gh, ME, { watchAll: inFoundry });
  assert.equal(issues.length, 0);
  assert.equal(others.length, 1);
  assert.deepEqual(others[0].triggers, ['new']);
  assert.equal(others[0].author, 'alice');
});

test('collectPRs: without watchAll, issues stays empty and nothing changes (compat)', async () => {
  const gh = fakeGh({ notifications: [watchedIssueThread, watchedPrThread] });
  const { issues, others, notifications } = await collectPRs(gh, ME, {});
  assert.deepEqual(issues, []);
  assert.equal(others.length, 0);
  assert.equal(notifications.length, 0);
});

test('diffByType: aggregates by extension, heaviest volume (adds+dels) first', () => {
  const files = [
    { path: 'src/Foo.php', additions: 10, deletions: 2 },
    { path: 'features/bar.feature', additions: 9, deletions: 1 },
    { path: 'src/Sub/Baz.php', additions: 5, deletions: 3 },
  ];
  assert.deepEqual(diffByType(files), [
    { ext: '.php', additions: 15, deletions: 5 },
    { ext: '.feature', additions: 9, deletions: 1 },
  ]);
});

test('diffByType: equal volume → alphabetical tie-break', () => {
  const files = [
    { path: 'a.php', additions: 2, deletions: 0 },
    { path: 'b.md', additions: 1, deletions: 1 },
  ];
  assert.deepEqual(diffByType(files), [
    { ext: '.md', additions: 1, deletions: 1 },
    { ext: '.php', additions: 2, deletions: 0 },
  ]);
});

test('diffByType: merges .yml into .yaml, case-insensitive extension', () => {
  const files = [
    { path: 'a.YML', additions: 1, deletions: 0 },
    { path: 'config/b.yaml', additions: 2, deletions: 1 },
  ];
  assert.deepEqual(diffByType(files), [{ ext: '.yaml', additions: 3, deletions: 1 }]);
});

test('diffByType: extensionless file → its lowercased name; a dotfile keeps its dot', () => {
  const files = [
    { path: 'Makefile', additions: 4, deletions: 0 },
    { path: '.gitignore', additions: 1, deletions: 1 },
  ];
  assert.deepEqual(diffByType(files), [
    { ext: 'makefile', additions: 4, deletions: 0 },
    { ext: '.gitignore', additions: 1, deletions: 1 },
  ]);
});

test('diffByType: null/absent/empty → []', () => {
  assert.deepEqual(diffByType(null), []);
  assert.deepEqual(diffByType(undefined), []);
  assert.deepEqual(diffByType([]), []);
});

test('collectPRs: rows carry diffTypes (aggregated) and moreFiles', async () => {
  const gh = fakeGh({
    search: [{ number: 42, title: 'PR A', html_url: 'https://github.com/o/r/pull/42', updated_at: '2026-06-24T12:00:00Z', repository_url: 'https://api.github.com/repos/o/r' }],
    details: () => ({
      number: 42, title: 'PR A', author: { login: 'alice' }, additions: 10, deletions: 2,
      files: [
        { path: 'src/A.php', additions: 8, deletions: 2 },
        { path: 'README.md', additions: 2, deletions: 0 },
      ],
      moreFiles: 3,
    }),
  });
  const { others } = await collectPRs(gh, ME, {});
  assert.deepEqual(others[0].diffTypes, [
    { ext: '.php', additions: 8, deletions: 2 },
    { ext: '.md', additions: 2, deletions: 0 },
  ]);
  assert.equal(others[0].moreFiles, 3);
});

test('collectPRs: detail without files → diffTypes [] and moreFiles 0 (compat)', async () => {
  const gh = fakeGh({
    search: [{ number: 42, title: 'PR A', html_url: 'https://github.com/o/r/pull/42', updated_at: '2026-06-24T12:00:00Z', repository_url: 'https://api.github.com/repos/o/r' }],
    details: () => ({ number: 42, title: 'PR A', author: { login: 'alice' }, additions: 1, deletions: 0 }),
  });
  const { others } = await collectPRs(gh, ME, {});
  assert.deepEqual(others[0].diffTypes, []);
  assert.equal(others[0].moreFiles, 0);
});
