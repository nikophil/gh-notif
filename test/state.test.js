import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdtempSync } from 'node:fs';
import { loadState, saveState, isNew, markSeen, statePath } from '../src/state.js';

test('statePath respecte XDG_STATE_HOME', () => {
  const prev = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = '/xdg';
  assert.equal(statePath(), '/xdg/gh-notif/seen.json');
  if (prev === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prev;
});

test('loadState renvoie {} si fichier absent', () => {
  assert.deepEqual(loadState('/nope/nope/seen.json'), {});
});

test('save puis load round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghnotif-'));
  const p = join(dir, 'sub', 'seen.json');
  saveState(p, { t1: '2026-06-24T10:00:00Z' });
  assert.deepEqual(loadState(p), { t1: '2026-06-24T10:00:00Z' });
  rmSync(dir, { recursive: true, force: true });
});

test('isNew: clé absente → true', () => {
  assert.equal(isNew({}, { threadId: 't1', updatedAt: '2026-06-24T10:00:00Z' }), true);
});

test('isNew: updatedAt plus récent → true, identique → false', () => {
  const state = { t1: '2026-06-24T10:00:00Z' };
  assert.equal(isNew(state, { threadId: 't1', updatedAt: '2026-06-24T11:00:00Z' }), true);
  assert.equal(isNew(state, { threadId: 't1', updatedAt: '2026-06-24T10:00:00Z' }), false);
});

test('markSeen écrit la valeur', () => {
  const state = {};
  markSeen(state, { threadId: 't1', updatedAt: '2026-06-24T10:00:00Z' });
  assert.equal(state.t1, '2026-06-24T10:00:00Z');
});
