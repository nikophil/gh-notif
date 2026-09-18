import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERRORS_MAX, errorLine, isServerError, errorDetails, recordError, loadErrors, saveErrors, openErrorLog } from '../src/errlog.js';

const ghError = (code, stderr, body = null) => Object.assign(new Error(`Command failed: gh api x\n${stderr}`), { ghCode: code, stderr, body });

const GQL_500 = 'gh: Something went wrong while executing your query on 2026-09-16T14:02:42Z. Please include `54E2:3F3F47:BD0BD5A` when reporting this issue.';
const GQL_ARGS = ['api', 'graphql', '-f', 'query=query {\np0: repository(owner: "mapado", name: "ticketing") { pullRequest(number: 7458) { ...stale } }\np1: repository(owner: "zenstruck", name: "foundry") { pullRequest(number: 892) { ...stale } }\n}\nfragment stale on PullRequest { number }'];

test('isServerError: 5xx and the GraphQL internal error are GitHub-side; the rest is not', () => {
  assert.equal(isServerError('gh: Bad Gateway (HTTP 502)'), true);
  assert.equal(isServerError('gh: HTTP 502'), true, 'GraphQL form, seen on the stale batch');
  assert.equal(isServerError(GQL_500), true);
  assert.equal(isServerError('HTTP 403: rate limited'), false);
  assert.equal(isServerError('gh: Not Found (HTTP 404)'), false);
  assert.equal(isServerError("gh: Could not resolve to a Repository with the name 'o/r'."), false);
});

test('errorDetails: GraphQL errors → type + the PR behind the alias + batch size; nothing for REST', () => {
  const body = { data: { p0: null, p1: { pullRequest: { number: 892 } } }, errors: [{ path: ['p0'], message: 'Something went wrong' }, { type: 'NOT_FOUND', path: ['p1', 'pullRequest'], message: 'x' }] };
  assert.equal(errorDetails(ghError('GH-GRAPHQL', GQL_500, body), GQL_ARGS), 'ERROR mapado/ticketing#7458, NOT_FOUND zenstruck/foundry#892 — batch of 2 PRs');
  assert.equal(errorDetails(ghError('GH-SEARCH', 'HTTP 403', { message: 'rate limited' }), ['api', 'search/issues']), '');
  assert.equal(errorDetails(ghError('GH-SEARCH', 'HTTP 403'), []), '');
  const many = { errors: Array.from({ length: 7 }, (_, i) => ({ type: 'T', path: [`p${i}`] })) };
  assert.equal(errorDetails(ghError('GH-GRAPHQL', 'e', many), ['api', 'graphql']), 'T p0, T p1, T p2, T p3, T p4 … +2');
});

test('errorLine: last non-empty stderr line, else the message\'s last line', () => {
  assert.equal(errorLine(ghError('GH-SEARCH', 'gh: API rate limit exceeded\n\nHTTP 403: forbidden\n')), 'HTTP 403: forbidden');
  assert.equal(errorLine(new Error('plain')), 'plain');
  assert.equal(errorLine('string error'), 'string error');
});

test('recordError: newest first, code + last line + command, count of repeats', () => {
  const entries = [];
  recordError(entries, ghError('GH-SEARCH', 'HTTP 403: rate limited'), ['api', 'search/issues', '-f', 'q=is:pr'], 1000);
  recordError(entries, ghError('GH-SEARCH', 'HTTP 403: rate limited'), ['api', 'search/issues', '-f', 'q=is:pr'], 2000);
  recordError(entries, ghError('GH-GRAPHQL', 'HTTP 502'), ['api', 'graphql'], 3000);
  assert.equal(entries.length, 2, 'the repeat was folded');
  assert.deepEqual(entries[0], { at: 3000, code: 'GH-GRAPHQL', message: 'HTTP 502', command: 'gh api graphql', count: 1, server: true, details: '' });
  assert.deepEqual(entries[1], { at: 2000, code: 'GH-SEARCH', message: 'HTTP 403: rate limited', command: 'gh api search/issues -f q=is:pr', count: 2, server: false, details: '' });
});

test('recordError: a GitHub-side error is flagged, the GraphQL details are kept', () => {
  const entries = [];
  const body = { data: { p0: null, p1: { pullRequest: { number: 892 } } }, errors: [{ path: ['p0'], message: 'Something went wrong' }] };
  recordError(entries, ghError('GH-GRAPHQL', GQL_500, body), GQL_ARGS, 1000);
  assert.equal(entries[0].server, true);
  assert.equal(entries[0].details, 'ERROR mapado/ticketing#7458 — batch of 2 PRs');
  recordError(entries, ghError('GH-NOTIFS', 'gh: Bad Gateway (HTTP 502)'), ['api', '/notifications'], 2000);
  assert.equal(entries[0].server, true);
  assert.equal(entries[0].details, '');
});

test('recordError: untagged error → GH-?, bounded to ERRORS_MAX', () => {
  const entries = [];
  for (let i = 0; i < ERRORS_MAX + 10; i++) recordError(entries, new Error(`e${i}`), [], i);
  assert.equal(entries.length, ERRORS_MAX);
  assert.equal(entries[0].code, 'GH-?');
  assert.equal(entries[0].message, `e${ERRORS_MAX + 9}`, 'the oldest entries were dropped');
});

test('loadErrors / saveErrors round-trip; missing or corrupt file → []', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghn-errlog-'));
  try {
    const path = join(dir, 'sub', 'errors.json');
    assert.deepEqual(loadErrors(path), []);
    saveErrors(path, [{ at: 1, code: 'GH-USER', message: 'm', command: 'gh api user', count: 1 }]);
    assert.equal(loadErrors(path)[0].code, 'GH-USER');
    saveErrors(path, { not: 'an array' });
    assert.deepEqual(loadErrors(path), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openErrorLog: onError records AND persists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghn-errlog-'));
  try {
    const path = join(dir, 'errors.json');
    const log = openErrorLog(path);
    log.onError(ghError('GH-NOTIFS', 'HTTP 401: bad credentials'), ['api', '/notifications']);
    assert.equal(log.entries[0].code, 'GH-NOTIFS');
    assert.equal(loadErrors(path)[0].message, 'HTTP 401: bad credentials');
    assert.equal(openErrorLog(path).entries.length, 1, 'reloaded on the next start');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
