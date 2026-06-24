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

test('getReviewComments construit le bon chemin', async () => {
  const runner = fakeRunner([['/pulls/42/comments', JSON.stringify([{ id: 1 }])]]);
  const gh = makeGh(runner);
  const out = await gh.getReviewComments('o/r', 42);
  assert.equal(out[0].id, 1);
  assert.ok(runner.calls[0].join(' ').includes('repos/o/r/pulls/42/comments'));
});

test('searchAuthored interroge author:@me', async () => {
  const runner = fakeRunner([['search/issues', JSON.stringify({ items: [{ number: 7 }] })]]);
  const gh = makeGh(runner);
  const out = await gh.searchAuthored();
  assert.equal(out[0].number, 7);
  assert.ok(runner.calls[0].join(' ').includes('author:@me'));
});

test('getPullDetails appelle `gh pr view` avec les bons champs', async () => {
  const runner = fakeRunner([['pr view 42', JSON.stringify({ number: 42, author: { login: 'alice' }, additions: 10, deletions: 2 })]]);
  const gh = makeGh(runner);
  const out = await gh.getPullDetails('o/r', 42);
  assert.equal(out.number, 42);
  assert.equal(out.author.login, 'alice');
  const args = runner.calls[0].join(' ');
  assert.ok(args.includes('pr view 42'));
  assert.ok(args.includes('--repo o/r'));
  assert.ok(args.includes('statusCheckRollup'));
});
