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

test('getCurrentUser renvoie le login', async () => {
  const gh = makeGh(fakeRunner([['api user', JSON.stringify({ login: 'nikophil' })]]));
  assert.equal(await gh.getCurrentUser(), 'nikophil');
});

test('listNotifications parse le tableau et passe all=true', async () => {
  const runner = fakeRunner([['/notifications', JSON.stringify([{ id: '1' }])]]);
  const gh = makeGh(runner);
  const out = await gh.listNotifications({ all: true });
  assert.equal(out[0].id, '1');
  assert.ok(runner.calls[0].join(' ').includes('all=true'));
});

test('getComment renvoie null sur stdout vide', async () => {
  const gh = makeGh(fakeRunner([['repos/o/r', '']]));
  assert.equal(await gh.getComment('https://api.github.com/repos/o/r/issues/comments/1'), null);
});

test('getReviewComments construit le bon chemin (per_page, sans since)', async () => {
  const runner = fakeRunner([['/pulls/42/comments', JSON.stringify([{ id: 1 }])]]);
  const gh = makeGh(runner);
  const out = await gh.getReviewComments('o/r', 42);
  assert.equal(out[0].id, 1);
  const q = runner.calls[0].join(' ');
  assert.ok(q.includes('repos/o/r/pulls/42/comments?per_page=100'));
  assert.ok(!q.includes('since='));
});

test('getReviewComments incrémental : since + sort=updated&direction=asc', async () => {
  const runner = fakeRunner([['/pulls/42/comments', JSON.stringify([])]]);
  const gh = makeGh(runner);
  await gh.getReviewComments('o/r', 42, { since: '2026-06-26T00:00:00Z' });
  const q = runner.calls[0].join(' ');
  assert.ok(q.includes('since='), 'contient le param since');
  assert.ok(q.includes('sort=updated'));
  assert.ok(q.includes('direction=asc'));
});

test('searchAuthored interroge author:@me et accepte un qualifier', async () => {
  const runner = fakeRunner([['search/issues', JSON.stringify({ items: [{ number: 7 }] })]]);
  const gh = makeGh(runner);
  const out = await gh.searchAuthored(' org:mapado');
  assert.equal(out[0].number, 7);
  const q = runner.calls[0].join(' ');
  assert.ok(q.includes('author:@me'));
  assert.ok(q.includes('org:mapado'));
});

test('currentRepo renvoie nameWithOwner, null si hors dépôt', async () => {
  const gh = makeGh(fakeRunner([['repo view', JSON.stringify({ nameWithOwner: 'mapado/ticketing' })]]));
  assert.equal(await gh.currentRepo(), 'mapado/ticketing');
  const ghErr = makeGh(async () => { throw new Error('not a git repo'); });
  assert.equal(await ghErr.currentRepo(), null);
});

test('getPullDetailsBatch : une requête GraphQL, alias par PR, forme normalisée', async () => {
  const gqlResponse = JSON.stringify({ data: {
    p0: { pullRequest: {
      number: 42, title: 'A', author: { login: 'alice' }, createdAt: 'd1', additions: 10, deletions: 2,
      isDraft: false, state: 'OPEN',
      latestOpinionatedReviews: { nodes: [{ author: { login: 'bob' }, state: 'APPROVED', submittedAt: 's1' }] },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    } },
    p1: { pullRequest: null }, // PR introuvable → null
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

  // une seule requête, contient les alias et le repo
  assert.equal(runner.calls.length, 1);
  const q = runner.calls[0].join(' ');
  assert.ok(q.includes('p0: repository(owner: "o", name: "r")'));
  assert.ok(q.includes('pullRequest(number: 42)'));
  assert.ok(q.includes('pullRequest(number: 99)'));
});

test('getPullDetailsBatch : liste vide → aucune requête', async () => {
  const runner = fakeRunner([]);
  const gh = makeGh(runner);
  assert.deepEqual(await gh.getPullDetailsBatch([]), []);
  assert.equal(runner.calls.length, 0);
});
