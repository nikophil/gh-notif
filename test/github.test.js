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
