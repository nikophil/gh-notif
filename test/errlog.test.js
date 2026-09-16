import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERRORS_MAX, errorLine, recordError, loadErrors, saveErrors, openErrorLog } from '../src/errlog.js';

const ghError = (code, stderr) => Object.assign(new Error(`Command failed: gh api x\n${stderr}`), { ghCode: code, stderr });

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
  assert.deepEqual(entries[0], { at: 3000, code: 'GH-GRAPHQL', message: 'HTTP 502', command: 'gh api graphql', count: 1 });
  assert.deepEqual(entries[1], { at: 2000, code: 'GH-SEARCH', message: 'HTTP 403: rate limited', command: 'gh api search/issues -f q=is:pr', count: 2 });
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
