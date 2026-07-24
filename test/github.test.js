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
  const out = await gh.searchAuthored(' org:mapado');
  assert.equal(out[0].number, 7);
  const q = runner.calls[0].join(' ');
  assert.ok(q.includes('author:@me'));
  assert.ok(q.includes('org:mapado'));
});

test('currentRepo returns nameWithOwner, null if outside a repo', async () => {
  const gh = makeGh(fakeRunner([['repo view', JSON.stringify({ nameWithOwner: 'mapado/ticketing' })]]));
  assert.equal(await gh.currentRepo(), 'mapado/ticketing');
  const ghErr = makeGh(async () => { throw new Error('not a git repo'); });
  assert.equal(await ghErr.currentRepo(), null);
});

test('getPullDetailsBatch: one GraphQL request, alias per PR, normalized shape', async () => {
  const gqlResponse = JSON.stringify({ data: {
    p0: { pullRequest: {
      number: 42, title: 'A', author: { login: 'alice' }, createdAt: 'd1', additions: 10, deletions: 2,
      isDraft: false, state: 'OPEN',
      latestOpinionatedReviews: { nodes: [{ author: { login: 'bob' }, state: 'APPROVED', submittedAt: 's1' }] },
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
  assert.equal(out[0].statusCheckRollupState, 'SUCCESS');
  assert.deepEqual(out[0].reviews, [{ author: { login: 'bob' }, state: 'APPROVED', submittedAt: 's1' }]);
  assert.equal(out[1], null);

  // a single request, contains the aliases and the repo
  assert.equal(runner.calls.length, 1);
  const q = runner.calls[0].join(' ');
  assert.ok(q.includes('p0: repository(owner: "o", name: "r")'));
  assert.ok(q.includes('pullRequest(number: 42)'));
  assert.ok(q.includes('pullRequest(number: 99)'));
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
          { __typename: 'CheckRun', name: 'Check Pull Requests label for merge block', conclusion: 'FAILURE', status: 'COMPLETED' },
          { __typename: 'StatusContext', context: 'continuous-integration/jenkins/branch', state: 'SUCCESS' },
          { __typename: 'CheckRun', name: 'build', conclusion: null, status: 'IN_PROGRESS' },
          { __typename: 'CheckRun', name: 'lint', conclusion: 'SKIPPED', status: 'COMPLETED' },
          { __typename: 'StatusContext', context: 'deploy', state: 'PENDING' },
        ] },
      } } }] },
    } },
  } });
  const runner = fakeRunner([['api graphql', gqlResponse]]);
  const gh = makeGh(runner);
  const [pr] = await gh.getPullDetailsBatch([{ repo: 'o/r', number: 42 }]);

  assert.deepEqual(pr.checks, [
    { name: 'Check Pull Requests label for merge block', state: 'fail' },
    { name: 'continuous-integration/jenkins/branch', state: 'pass' },
    { name: 'build', state: 'pending' },   // conclusion null + running
    { name: 'lint', state: 'pass' },        // SKIPPED = non-blocking
    { name: 'deploy', state: 'pending' },   // StatusContext PENDING
  ]);
  // the request does ask for the contexts
  const q = runner.calls[0].join(' ');
  assert.ok(q.includes('contexts'));
  assert.ok(q.includes('StatusContext'));
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
  const runner = fakeRunner([['api users/mapado', '{"id":1}'], ['api repos/o/r', '{"id":2}']]);
  const gh = makeGh(runner);
  assert.equal(await gh.scopeExists({ type: 'org', value: 'mapado' }), true);
  assert.equal(await gh.scopeExists({ type: 'repo', value: 'o/r' }), true);
  assert.ok(runner.calls[0].join(' ').startsWith('api users/mapado'));
  assert.ok(runner.calls[1].join(' ').startsWith('api repos/o/r'));
});

test('scopeExists: 404 → false, other failure (network…) → null (undetermined)', async () => {
  const gh404 = makeGh(async () => { const e = new Error('gh: Not Found (HTTP 404)'); throw e; });
  assert.equal(await gh404.scopeExists({ type: 'org', value: 'nope' }), false);
  const ghStderr = makeGh(async () => { const e = new Error('exit 1'); e.stderr = 'gh: Not Found (HTTP 404)'; throw e; });
  assert.equal(await ghStderr.scopeExists({ type: 'repo', value: 'o/nope' }), false);
  const ghDown = makeGh(async () => { throw new Error('connect ETIMEDOUT'); });
  assert.equal(await ghDown.scopeExists({ type: 'org', value: 'mapado' }), null);
  assert.equal(await ghDown.scopeExists(null), null); // invalid scope: undetermined
});
