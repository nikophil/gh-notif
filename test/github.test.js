// test/github.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGh } from '../src/github.js';

function fakeRunner(map) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const key = args.join(' ');
    for (const [match, out] of map) if (key.includes(match)) return out;
    throw new Error('no stub for ' + key);
  };
  run.calls = calls;
  return run;
}

test('getCurrentUser returns the login', async () => {
  const gh = makeGh(fakeRunner([['api user', JSON.stringify({ login: 'nikophil' })]]));
  assert.equal(await gh.getCurrentUser(), 'nikophil');
});

test('listNotifications parses the array and passes all=true', async () => {
  const runner = fakeRunner([['/notifications', JSON.stringify([{ id: '1' }])]]);
  const gh = makeGh(runner);
  const out = await gh.listNotifications({ all: true });
  assert.equal(out[0].id, '1');
  assert.ok(runner.calls[0].join(' ').includes('all=true'));
});

test('markThreadRead PATCHes the notification thread', async () => {
  const runner = fakeRunner([['notifications/threads/t42', '']]);
  const gh = makeGh(runner);
  await gh.markThreadRead('t42');
  const call = runner.calls[0];
  assert.ok(call.includes('-X') && call.includes('PATCH'), 'uses PATCH');
  assert.ok(call.join(' ').includes('notifications/threads/t42'));
});

test('markReadBefore PUTs /notifications with last_read_at', async () => {
  const runner = fakeRunner([['/notifications', '']]);
  const gh = makeGh(runner);
  await gh.markReadBefore('2026-08-10T12:00:00.000Z');
  const call = runner.calls[0];
  assert.ok(call.includes('-X') && call.includes('PUT'), 'uses PUT');
  assert.ok(call.join(' ').includes('last_read_at=2026-08-10T12:00:00.000Z'));
});

test('getComment returns null on empty stdout', async () => {
  const gh = makeGh(fakeRunner([['repos/o/r', '']]));
  assert.equal(await gh.getComment('https://api.github.com/repos/o/r/issues/comments/1'), null);
});

test('getReviewComments builds the correct path (per_page, without since)', async () => {
  const runner = fakeRunner([['/pulls/42/comments', JSON.stringify([{ id: 1 }])]]);
  const gh = makeGh(runner);
  const out = await gh.getReviewComments('o/r', 42);
  assert.equal(out[0].id, 1);
  const q = runner.calls[0].join(' ');
  assert.ok(q.includes('repos/o/r/pulls/42/comments?per_page=100'));
  assert.ok(!q.includes('since='));
});

test('getReviewComments incremental: since + sort=updated&direction=asc', async () => {
  const runner = fakeRunner([['/pulls/42/comments', JSON.stringify([])]]);
  const gh = makeGh(runner);
  await gh.getReviewComments('o/r', 42, { since: '2026-06-26T00:00:00Z' });
  const q = runner.calls[0].join(' ');
  assert.ok(q.includes('since='), 'contains the since param');
  assert.ok(q.includes('sort=updated'));
  assert.ok(q.includes('direction=asc'));
});

test('searchAuthored queries author:@me and accepts a qualifier', async () => {
  const runner = fakeRunner([['search/issues', JSON.stringify({ items: [{ number: 7 }] })]]);
  const gh = makeGh(runner);
  const out = await gh.searchAuthored(' org:symfony');
  assert.equal(out[0].number, 7);
  const q = runner.calls[0].join(' ');
  assert.ok(q.includes('author:@me'));
  assert.ok(q.includes('org:symfony'));
  assert.ok(q.includes('per_page=100'), 'never relies on the default page size (30)');
});

// Regression (issue #1): a perimeter of more than 30 open PRs was silently
// truncated at every poll → the missing PRs got pruned from hidden-v1.json by
// `reconcile` and reappeared visible.
function pagedRunner(pages) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const page = Number(args.join(' ').match(/ page=(\d+)/)[1]);
    return JSON.stringify({ total_count: 999, items: pages[page - 1] ?? [] });
  };
  run.calls = calls;
  return run;
}

test('search: paginates per_page=100 until a non-full page', async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ number: i + 1 }));
  const rest = [{ number: 101 }, { number: 102 }];
  const runner = pagedRunner([full, rest]);
  const out = await makeGh(runner).searchReviewRequested(' org:acme');

  assert.equal(out.length, 102, 'collects the surplus beyond the first page');
  assert.equal(out[101].number, 102);
  assert.equal(runner.calls.length, 2, 'stops as soon as a page is not full');
  assert.ok(runner.calls[0].join(' ').includes('page=1'));
  assert.ok(runner.calls[1].join(' ').includes('page=2'));
  assert.ok(runner.calls[0].join(' ').includes('review-requested:@me org:acme'));
});

test('search: stops at 10 pages (search API caps at 1000 results)', async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ number: i + 1 }));
  const runner = pagedRunner(Array.from({ length: 20 }, () => full));
  const out = await makeGh(runner).searchAuthored();

  assert.equal(runner.calls.length, 10);
  assert.equal(out.length, 1000);
});

test('search: an empty first page returns [] without a second call', async () => {
  const runner = pagedRunner([[]]);
  const out = await makeGh(runner).searchAuthored();
  assert.deepEqual(out, []);
  assert.equal(runner.calls.length, 1);
});

test('currentRepo returns nameWithOwner, null if outside a repo', async () => {
  const gh = makeGh(fakeRunner([['repo view', JSON.stringify({ nameWithOwner: 'symfony/ticketing' })]]));
  assert.equal(await gh.currentRepo(), 'symfony/ticketing');
  const ghErr = makeGh(async () => { throw new Error('not a git repo'); });
  assert.equal(await ghErr.currentRepo(), null);
});

// §35: every failed gh call is tagged with the call site and reported to onError.
test('a failed gh call carries ghCode (call site) and reaches onError before being thrown', async () => {
  const seen = [];
  const runner = async (args) => { const e = new Error('Command failed\nHTTP 403: rate limited'); e.stderr = 'HTTP 403: rate limited'; throw e; };
  const gh = makeGh(runner, { onError: (err, args) => seen.push([err.ghCode, args[0]]) });
  await assert.rejects(gh.listNotifications(), (e) => e.ghCode === 'GH-NOTIFS' && e.stderr === 'HTTP 403: rate limited');
  await assert.rejects(gh.searchAuthored(), (e) => e.ghCode === 'GH-SEARCH');
  await assert.rejects(gh.getComment('https://api.github.com/x'), (e) => e.ghCode === 'GH-COMMENT');
  assert.deepEqual(seen, [['GH-NOTIFS', 'api'], ['GH-SEARCH', 'api'], ['GH-COMMENT', 'api']]);
});

test('a failure the caller swallows (degraded GraphQL chunk, scopeExists null) is still reported', async () => {
  const seen = [];
  const gh = makeGh(async () => { throw new Error('HTTP 502'); }, { onError: (err) => seen.push(err.ghCode) });
  assert.deepEqual(await gh.getPullDetailsBatch([{ repo: 'o/r', number: 1 }]), [null], 'degraded, not thrown');
  assert.equal(await gh.scopeExists({ type: 'repo', value: 'o/r' }), null);
  assert.deepEqual(seen, ['GH-GRAPHQL', 'GH-SCOPE_EXISTS']);
});

test('makeGh without onError: failures still throw, tagged', async () => {
  const gh = makeGh(async () => { throw new Error('nope'); });
  await assert.rejects(gh.getCurrentUser(), (e) => e.ghCode === 'GH-USER');
});

test('getPullDetailsBatch: one GraphQL request, alias per PR, normalized shape', async () => {
  const gqlResponse = JSON.stringify({ data: {
    p0: { pullRequest: {
      number: 42, title: 'A', author: { login: 'alice' }, createdAt: 'd1', additions: 10, deletions: 2,
      isDraft: false, state: 'OPEN', mergeable: 'CONFLICTING', headRefName: 'feat/login', headRepository: { nameWithOwner: 'fork/r' },
      latestOpinionatedReviews: { nodes: [{ author: { login: 'bob' }, state: 'APPROVED', submittedAt: 's1' }] },
      timelineItems: { nodes: [{ createdAt: 'ready1' }] },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    } },
    p1: { pullRequest: null }, // PR not found → null
  } });
  const runner = fakeRunner([['api graphql', gqlResponse]]);
  const gh = makeGh(runner);
  const out = await gh.getPullDetailsBatch([{ repo: 'o/r', number: 42 }, { repo: 'o/r', number: 99 }]);

  assert.equal(out.length, 2);
  assert.equal(out[0].number, 42);
  assert.equal(out[0].author.login, 'alice');
  assert.equal(out[0].state, 'OPEN');
  assert.equal(out[0].branch, 'feat/login');
  assert.equal(out[0].branchRepo, 'fork/r');
  assert.equal(out[0].statusCheckRollupState, 'SUCCESS');
  assert.equal(out[0].mergeable, 'CONFLICTING');
  assert.equal(out[0].readyAt, 'ready1'); // draft → ready date (easter-egg gate)
  assert.deepEqual(out[0].reviews, [{ author: { login: 'bob' }, state: 'APPROVED', submittedAt: 's1' }]);
  assert.equal(out[1], null);

  // a single request, contains the aliases and the repo
  assert.equal(runner.calls.length, 1);
  const q = runner.calls[0].join(' ');
  assert.ok(q.includes('p0: repository(owner: "o", name: "r")'));
  assert.ok(q.includes('pullRequest(number: 42)'));
  assert.ok(q.includes('pullRequest(number: 99)'));
  assert.ok(q.includes('headRefName'));
  assert.ok(q.includes('headRepository'));
  assert.ok(q.includes('mergeable'));
});

test('getPullDetailsBatch: mergeable absent from the response → null (never CONFLICTING by default)', async () => {
  const gqlResponse = JSON.stringify({ data: { p0: { pullRequest: {
    number: 42, title: 'A', author: { login: 'alice' }, createdAt: 'd1', additions: 1, deletions: 0,
    isDraft: false, state: 'OPEN', latestOpinionatedReviews: { nodes: [] },
  } } } });
  const out = await makeGh(fakeRunner([['api graphql', gqlResponse]])).getPullDetailsBatch([{ repo: 'o/r', number: 42 }]);
  assert.equal(out[0].mergeable, null);
  assert.equal(out[0].readyAt, null);
});

test('getPullDetailsBatch: exposes the base branch and the default branch (stacked PRs)', async () => {
  const gqlResponse = JSON.stringify({ data: { p0: { pullRequest: {
    number: 42, title: 'A', author: { login: 'alice' }, createdAt: 'd1', additions: 1, deletions: 0,
    isDraft: false, state: 'OPEN', latestOpinionatedReviews: { nodes: [] },
    baseRefName: 'feat/parent', baseRepository: { defaultBranchRef: { name: 'main' } },
  } } } });
  const runner = fakeRunner([['api graphql', gqlResponse]]);
  const out = await makeGh(runner).getPullDetailsBatch([{ repo: 'o/r', number: 42 }]);
  assert.equal(out[0].base, 'feat/parent');
  assert.equal(out[0].defaultBranch, 'main');
  const q = runner.calls[0].join(' ');
  assert.ok(q.includes('baseRefName'));
  assert.ok(q.includes('defaultBranchRef'));
});

test('getPullDetailsBatch: base/default branch absent from the response → null', async () => {
  const gqlResponse = JSON.stringify({ data: { p0: { pullRequest: {
    number: 42, title: 'A', author: { login: 'alice' }, createdAt: 'd1', additions: 1, deletions: 0,
    isDraft: false, state: 'OPEN', latestOpinionatedReviews: { nodes: [] },
  } } } });
  const out = await makeGh(fakeRunner([['api graphql', gqlResponse]])).getPullDetailsBatch([{ repo: 'o/r', number: 42 }]);
  assert.equal(out[0].base, null);
  assert.equal(out[0].defaultBranch, null);
});

test('getPullDetailsBatch: exposes the labels ({name, color}), skips nameless nodes', async () => {
  const gqlResponse = JSON.stringify({ data: { p0: { pullRequest: {
    number: 42, title: 'A', author: { login: 'alice' }, createdAt: 'd1', additions: 1, deletions: 0,
    isDraft: false, state: 'OPEN', latestOpinionatedReviews: { nodes: [] },
    labels: { nodes: [{ name: 'bug', color: 'd73a4a' }, { name: 'no color' }, null, { color: 'ffffff' }] },
  } } } });
  const runner = fakeRunner([['api graphql', gqlResponse]]);
  const out = await makeGh(runner).getPullDetailsBatch([{ repo: 'o/r', number: 42 }]);
  assert.deepEqual(out[0].labels, [{ name: 'bug', color: 'd73a4a' }, { name: 'no color', color: null }]);
  assert.ok(runner.calls[0].join(' ').includes('labels(first: 20)'));
});

test('getPullDetailsBatch: labels absent from the response → []', async () => {
  const gqlResponse = JSON.stringify({ data: { p0: { pullRequest: {
    number: 42, title: 'A', author: { login: 'alice' }, createdAt: 'd1', additions: 1, deletions: 0,
    isDraft: false, state: 'OPEN', latestOpinionatedReviews: { nodes: [] },
  } } } });
  const out = await makeGh(fakeRunner([['api graphql', gqlResponse]])).getPullDetailsBatch([{ repo: 'o/r', number: 42 }]);
  assert.deepEqual(out[0].labels, []);
});

test('getPullDetailsBatch: normalizes the checks (CheckRun + StatusContext) to {name,state}', async () => {
  const gqlResponse = JSON.stringify({ data: {
    p0: { pullRequest: {
      number: 42, title: 'A', author: { login: 'alice' }, createdAt: 'd1', additions: 1, deletions: 0,
      isDraft: false, state: 'OPEN',
      latestOpinionatedReviews: { nodes: [] },
      commits: { nodes: [{ commit: { statusCheckRollup: {
        state: 'FAILURE',
        contexts: { nodes: [
          { __typename: 'CheckRun', name: 'Check Pull Requests label for merge block', conclusion: 'FAILURE', status: 'COMPLETED', detailsUrl: 'https://github.com/o/r/runs/1' },
          { __typename: 'StatusContext', context: 'continuous-integration/jenkins/branch', state: 'SUCCESS', targetUrl: 'https://ci.example.com/job/42' },
          { __typename: 'CheckRun', name: 'build', conclusion: null, status: 'IN_PROGRESS', detailsUrl: 'https://github.com/o/r/runs/2' },
          { __typename: 'CheckRun', name: 'lint', conclusion: 'SKIPPED', status: 'COMPLETED', detailsUrl: null },
          { __typename: 'StatusContext', context: 'deploy', state: 'PENDING' },
        ] },
      } } }] },
    } },
  } });
  const runner = fakeRunner([['api graphql', gqlResponse]]);
  const gh = makeGh(runner);
  const [pr] = await gh.getPullDetailsBatch([{ repo: 'o/r', number: 42 }]);

  assert.deepEqual(pr.checks, [
    { name: 'Check Pull Requests label for merge block', state: 'fail', url: 'https://github.com/o/r/runs/1' },
    { name: 'continuous-integration/jenkins/branch', state: 'pass', url: 'https://ci.example.com/job/42' },
    { name: 'build', state: 'pending', url: 'https://github.com/o/r/runs/2' },   // conclusion null + running
    { name: 'lint', state: 'pass', url: null },        // SKIPPED = non-blocking, no URL
    { name: 'deploy', state: 'pending', url: null },   // StatusContext PENDING, targetUrl absent
  ]);
  // the request does ask for the contexts AND the run URLs (same request, zero cost)
  const q = runner.calls[0].join(' ');
  assert.ok(q.includes('contexts'));
  assert.ok(q.includes('StatusContext'));
  assert.ok(q.includes('detailsUrl'));
  assert.ok(q.includes('targetUrl'));
});

test('getPullDetailsBatch: rollup without contexts → empty checks', async () => {
  const gqlResponse = JSON.stringify({ data: { p0: { pullRequest: {
    number: 1, title: 'A', author: { login: 'a' }, createdAt: 'd', additions: 0, deletions: 0,
    isDraft: false, state: 'OPEN', latestOpinionatedReviews: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
  } } } });
  const gh = makeGh(fakeRunner([['api graphql', gqlResponse]]));
  const [pr] = await gh.getPullDetailsBatch([{ repo: 'o/r', number: 1 }]);
  assert.deepEqual(pr.checks, []);
  assert.equal(pr.statusCheckRollupState, null);
});

test('getPullDetailsBatch: empty list → no request', async () => {
  const runner = fakeRunner([]);
  const gh = makeGh(runner);
  assert.deepEqual(await gh.getPullDetailsBatch([]), []);
  assert.equal(runner.calls.length, 0);
});

test('scopeExists: org/user → GET users/…, repo → GET repos/…', async () => {
  const runner = fakeRunner([['api users/symfony', '{"id":1}'], ['api repos/o/r', '{"id":2}']]);
  const gh = makeGh(runner);
  assert.equal(await gh.scopeExists({ type: 'org', value: 'symfony' }), true);
  assert.equal(await gh.scopeExists({ type: 'repo', value: 'o/r' }), true);
  assert.ok(runner.calls[0].join(' ').startsWith('api users/symfony'));
  assert.ok(runner.calls[1].join(' ').startsWith('api repos/o/r'));
});

test('scopeExists: 404 → false, other failure (network…) → null (undetermined)', async () => {
  const gh404 = makeGh(async () => { const e = new Error('gh: Not Found (HTTP 404)'); throw e; });
  assert.equal(await gh404.scopeExists({ type: 'org', value: 'nope' }), false);
  const ghStderr = makeGh(async () => { const e = new Error('exit 1'); e.stderr = 'gh: Not Found (HTTP 404)'; throw e; });
  assert.equal(await ghStderr.scopeExists({ type: 'repo', value: 'o/nope' }), false);
  const ghDown = makeGh(async () => { throw new Error('connect ETIMEDOUT'); });
  assert.equal(await ghDown.scopeExists({ type: 'org', value: 'symfony' }), null);
  assert.equal(await ghDown.scopeExists(null), null); // invalid scope: undetermined
});

test('setRepoSubscription watches the repo (PUT subscription), best-effort', async () => {
  const runner = fakeRunner([['repos/zenstruck/foundry/subscription', '']]);
  const gh = makeGh(runner);
  assert.equal(await gh.setRepoSubscription('zenstruck/foundry'), true);
  const call = runner.calls[0];
  assert.ok(call.includes('PUT'));
  assert.ok(call.join(' ').includes('repos/zenstruck/foundry/subscription'));
  assert.ok(call.join(' ').includes('subscribed=true'));
  // failure (network, 404…) → null, never throws
  assert.equal(await makeGh(fakeRunner([])).setRepoSubscription('o/r'), null);
});

test('getPullDetailsBatch: exposes the changed files (path/additions/deletions) and moreFiles', async () => {
  const gqlResponse = JSON.stringify({ data: { p0: { pullRequest: {
    number: 42, title: 'A', author: { login: 'alice' }, createdAt: 'd1', additions: 3, deletions: 1,
    isDraft: false, state: 'OPEN', latestOpinionatedReviews: { nodes: [] },
    files: { totalCount: 102, pageInfo: { hasNextPage: true }, nodes: [{ path: 'src/A.php', additions: 3, deletions: 1 }] },
  } } } });
  const runner = fakeRunner([['api graphql', gqlResponse]]);
  const out = await makeGh(runner).getPullDetailsBatch([{ repo: 'o/r', number: 42 }]);
  assert.deepEqual(out[0].files, [{ path: 'src/A.php', additions: 3, deletions: 1 }]);
  assert.equal(out[0].moreFiles, 101); // totalCount − fetched page
  const q = runner.calls[0].join(' ');
  assert.ok(q.includes('files(first: 100)'));
});

test('getPullDetailsBatch: files absent from the response → [] and moreFiles 0 (compat)', async () => {
  const gqlResponse = JSON.stringify({ data: { p0: { pullRequest: {
    number: 42, title: 'A', author: { login: 'alice' }, createdAt: 'd1', additions: 1, deletions: 0,
    isDraft: false, state: 'OPEN', latestOpinionatedReviews: { nodes: [] },
  } } } });
  const out = await makeGh(fakeRunner([['api graphql', gqlResponse]])).getPullDetailsBatch([{ repo: 'o/r', number: 42 }]);
  assert.deepEqual(out[0].files, []);
  assert.equal(out[0].moreFiles, 0);
});

test('getPullDetailsBatch: exposes changedFiles (GraphQL PR field), null when absent', async () => {
  const pr = (extra) => JSON.stringify({ data: { p0: { pullRequest: {
    number: 42, title: 'A', author: { login: 'alice' }, createdAt: 'd1', additions: 1, deletions: 0,
    isDraft: false, state: 'OPEN', latestOpinionatedReviews: { nodes: [] }, ...extra,
  } } } });
  const runner = fakeRunner([['api graphql', pr({ changedFiles: 7 })]]);
  const out = await makeGh(runner).getPullDetailsBatch([{ repo: 'o/r', number: 42 }]);
  assert.equal(out[0].changedFiles, 7);
  assert.ok(runner.calls[0].join(' ').includes('changedFiles'), 'the field is requested');
  const old = await makeGh(fakeRunner([['api graphql', pr({})]])).getPullDetailsBatch([{ repo: 'o/r', number: 42 }]);
  assert.equal(old[0].changedFiles, null);
});

// ── Search page (§29) ───────────────────────────────────────────────────────
test('searchPRs: sort=updated desc, stops at `max` (2 full pages of 100), returns total_count', async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ number: i + 1 }));
  const calls = [];
  const runner = async (args) => { calls.push(args.join(' ')); return JSON.stringify({ total_count: 1234, items: full }); };
  const out = await makeGh(runner).searchPRs('is:pr author:alice', { max: 200 });
  assert.equal(calls.length, 2, 'never a 3rd page: max reached');
  assert.ok(calls[0].includes('q=is:pr author:alice'));
  assert.ok(calls[0].includes('sort=updated') && calls[0].includes('order=desc') && calls[0].includes('per_page=100'));
  assert.equal(out.items.length, 200);
  assert.equal(out.total, 1234);
});

test('searchPRs: a non-full page ends the loop; a full last page is sliced to max', async () => {
  const thirty = await makeGh(async () => JSON.stringify({ total_count: 30, items: Array.from({ length: 30 }, (_, i) => ({ number: i })) })).searchPRs('q');
  assert.equal(thirty.items.length, 30);
  assert.equal(thirty.total, 30);
  const sliced = await makeGh(async () => JSON.stringify({ total_count: 500, items: Array.from({ length: 100 }, (_, i) => ({ number: i })) })).searchPRs('q', { max: 50 });
  assert.equal(sliced.items.length, 50);
  assert.equal(sliced.total, 500);
});

// ── draft ⇄ ready (dashboard toggle on my PRs) ──────────────────────────────
// Timeline stub: the reviewers removed at the last draft conversion are the
// ReviewRequestRemovedEvent items after the last ConvertToDraftEvent.
const timeline = (nodes) => JSON.stringify({ data: { p0: { pullRequest: { timelineItems: { nodes } } } } });
const draftEvent = (createdAt) => ({ __typename: 'ConvertToDraftEvent', createdAt });
const removed = (createdAt, requestedReviewer) => ({ __typename: 'ReviewRequestRemovedEvent', createdAt, requestedReviewer });

test('markReady: gh pr ready <n> --repo, then re-requests the reviewers removed at the last draft conversion (users + teams, deduplicated)', async () => {
  const runner = fakeRunner([
    ['pr ready', '✓ Pull request #42 is marked as "ready for review"'],
    ['graphql', timeline([
      removed('2026-09-01T00:00:00Z', { login: 'old' }), // an earlier draft round → ignored
      draftEvent('2026-09-01T10:00:00Z'),
      removed('2026-09-10T00:00:00Z', { login: 'alice' }),
      draftEvent('2026-09-14T10:00:00Z'),
      removed('2026-09-14T10:00:01Z', { login: 'alice' }),
      removed('2026-09-14T10:00:01Z', { login: 'bob' }),
      removed('2026-09-14T10:00:01Z', { slug: 'core' }),
      removed('2026-09-14T10:00:02Z', { login: 'alice' }),
      removed('2026-09-14T10:00:03Z', {}), // deleted account: no login, no slug
    ])],
    ['requested_reviewers', '{}'],
  ]);
  await makeGh(runner).markReady('o/r', 42);
  assert.deepEqual(runner.calls[0], ['pr', 'ready', '42', '--repo', 'o/r']);
  assert.equal(runner.calls[1][1], 'graphql');
  assert.match(runner.calls[1][3], /CONVERT_TO_DRAFT_EVENT, REVIEW_REQUEST_REMOVED_EVENT/);
  assert.deepEqual(runner.calls[2], ['api', '-X', 'POST', 'repos/o/r/pulls/42/requested_reviewers',
    '-f', 'reviewers[]=alice', '-f', 'reviewers[]=bob', '-f', 'team_reviewers[]=core']);
  assert.equal(runner.calls.length, 3);
});

test('markReady: nothing removed since the last draft conversion → no POST', async () => {
  const runner = fakeRunner([
    ['pr ready', ''],
    ['graphql', timeline([removed('2026-09-01T00:00:00Z', { login: 'old' }), draftEvent('2026-09-14T10:00:00Z')])],
  ]);
  await makeGh(runner).markReady('o/r', 42);
  assert.equal(runner.calls.length, 2);
});

test('markReady: never converted to draft (no ConvertToDraftEvent) → no POST', async () => {
  const runner = fakeRunner([['pr ready', ''], ['graphql', timeline([removed('2026-09-01T00:00:00Z', { login: 'old' })])]]);
  await makeGh(runner).markReady('o/r', 42);
  assert.equal(runner.calls.length, 2);
});

test('markReady: a failing gh pr ready throws (nothing else is attempted)', async () => {
  const runner = fakeRunner([]);
  await assert.rejects(() => makeGh(runner).markReady('o/r', 42));
  assert.equal(runner.calls.length, 1);
});

test('convertToDraft: gh pr ready --undo, then removes the requested reviewers (users + teams)', async () => {
  const runner = fakeRunner([
    ['pr ready --undo', '✓ Pull request #42 is marked as "draft"'],
    ['requested_reviewers', JSON.stringify({ users: [{ login: 'alice' }, { login: 'bob' }], teams: [{ slug: 'core' }] })],
  ]);
  await makeGh(runner).convertToDraft('o/r', 42);
  assert.deepEqual(runner.calls, [
    ['pr', 'ready', '--undo', '42', '--repo', 'o/r'],
    ['api', 'repos/o/r/pulls/42/requested_reviewers'],
    ['api', '-X', 'DELETE', 'repos/o/r/pulls/42/requested_reviewers',
      '-f', 'reviewers[]=alice', '-f', 'reviewers[]=bob', '-f', 'team_reviewers[]=core'],
  ]);
});

test('convertToDraft: no requested reviewer → no DELETE', async () => {
  const runner = fakeRunner([
    ['pr ready --undo', ''],
    ['requested_reviewers', JSON.stringify({ users: [], teams: [] })],
  ]);
  await makeGh(runner).convertToDraft('o/r', 42);
  assert.equal(runner.calls.length, 2);
});

test('convertToDraft: a failing gh pr ready --undo throws (nothing else is attempted)', async () => {
  const runner = fakeRunner([]);
  await assert.rejects(() => makeGh(runner).convertToDraft('o/r', 42));
  assert.equal(runner.calls.length, 1);
});

// Real bug: GitHub's search times out internally on a wide multi-org query and
// answers a PARTIAL item list with `incomplete_results: true` (measured: 6 items
// of a total_count of 26) — no HTTP error. Consumed as is, the missing PRs
// vanished from the dashboard for a poll. The flag alone is unreliable (true
// even when every item is there), so truncation = flag AND items < total_count.
test('search: incomplete_results with fewer items than total_count throws err.incomplete (partial items attached)', async () => {
  const runner = fakeRunner([['search/issues', JSON.stringify({ total_count: 26, incomplete_results: true, items: [{ number: 1 }, { number: 2 }] })]]);
  await assert.rejects(makeGh(runner).searchAuthored(), (err) => {
    assert.equal(err.incomplete, true);
    assert.match(err.message, /2\/26/);
    assert.deepEqual(err.items.map((i) => i.number), [1, 2]);
    return true;
  });
});

test('search: incomplete_results with every item present is not a truncation', async () => {
  const runner = fakeRunner([['search/issues', JSON.stringify({ total_count: 2, incomplete_results: true, items: [{ number: 1 }, { number: 2 }] })]]);
  const out = await makeGh(runner).searchAuthored();
  assert.equal(out.length, 2);
});

// ── getStaleSignals (stale stacks, §31) ──────────────────────────────────

test('getStaleSignals: one GraphQL request, alias per PR, commits + parent force-push old heads', async () => {
  const gqlResponse = JSON.stringify({ data: {
    p0: { pullRequest: {
      history: { nodes: [
        { commit: { oid: 'a1old', associatedPullRequests: { nodes: [{ number: 7, state: 'OPEN' }, { number: 8, state: 'OPEN' }] } } },
        { commit: { oid: 'b1', associatedPullRequests: { nodes: [{ number: 7, state: 'OPEN' }] } } },
      ] },
      baseRef: { associatedPullRequests: { nodes: [{
        timelineItems: { nodes: [{ beforeCommit: { oid: 'a1old' } }, { beforeCommit: null }, {}] },
      }] } },
    } },
    p1: { pullRequest: { history: { nodes: [] }, baseRef: null } }, // base branch deleted
    p2: { pullRequest: null }, // PR not found
  } });
  const runner = fakeRunner([['api graphql', gqlResponse]]);
  const out = await makeGh(runner).getStaleSignals([{ repo: 'o/r', number: 7 }, { repo: 'o/r', number: 9 }, { repo: 'o/r', number: 10 }]);

  assert.equal(runner.calls.length, 1);
  const query = runner.calls[0].join(' ');
  assert.ok(query.includes('HEAD_REF_FORCE_PUSHED_EVENT'));
  assert.ok(query.includes('pullRequest(number: 7)'));
  assert.deepEqual(out, [
    {
      commits: [
        { oid: 'a1old', prs: [{ number: 7, state: 'OPEN' }, { number: 8, state: 'OPEN' }] },
        { oid: 'b1', prs: [{ number: 7, state: 'OPEN' }] },
      ],
      parentForcePushed: ['a1old'],
    },
    { commits: [], parentForcePushed: [] },
    null,
  ]);
});

test('getStaleSignals: empty input → no request; a failed request → nulls (never throws)', async () => {
  const runner = fakeRunner([]);
  assert.deepEqual(await makeGh(runner).getStaleSignals([]), []);
  assert.equal(runner.calls.length, 0);
  const failing = makeGh(async () => { throw new Error('boom'); });
  assert.deepEqual(await failing.getStaleSignals([{ repo: 'o/r', number: 7 }]), [null]);
});
